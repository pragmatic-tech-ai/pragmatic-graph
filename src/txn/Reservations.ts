import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { Keyspace } from '../kv/Keyspace.js';
import { ConflictError } from './ConflictError.js';
import { ConflictKeys } from './ConflictKeys.js';
import type { ReadSet } from './ReadSet.js';
import type { WriteKeySet } from './WriteKeySet.js';

/** Where a reservation is in its life. Only Held and Finalizing block other commits. */
export enum ReservationState
{
    /** Prepared; Finalize or Abort may follow; expires at its deadline. */
    Held,
    /** Finalize was called before the deadline: it no longer expires; its commit is queued or applying. */
    Finalizing,
    /** The prepared batch committed. */
    Finalized,
    /** Aborted by the caller. */
    Aborted,
    /** The deadline passed before Finalize. */
    Expired,
    /** Finalize was rejected (catalog version, disposal or storage trouble). */
    Failed,
    /** The committer was disposed while the reservation was held. */
    Disposed,
    /** An upgrade wrote keys it reserved without changing the catalog version (its seed commit). */
    Invalidated,
}

/**
 * The logical keys one prepared commit holds until it finalizes, aborts or expires (ruling R71). `Reads`
 * is what no other commit may write: the prepared batch's ReadSet, the dry-run's dependencies and its
 * write keys except the commutative aggregate families (Extent, Column). `Writes` is the dry-run's write
 * set, which no other commit that writes may have read.
 */
export class Reservation
{
    private static readonly ErrExpired = 'The prepared commit expired before Finalize';
    private static readonly ErrReleased = 'The prepared commit was aborted or released';
    private static readonly ErrFinalized = 'Finalize was already called on this prepared commit';
    private static readonly ErrInvalidated = 'An upgrade since Prepare wrote keys the prepared commit reserved';

    private state = ReservationState.Held;
    private invalidated = false;

    public constructor(
        private readonly owner: Reservations,
        public readonly Reads: ReadSet,
        public readonly Writes: WriteKeySet,
        public readonly Deadline: number,
    )
    {
    }

    public get State(): ReservationState
    {
        return this.state;
    }

    /** True while the reservation blocks other commits. */
    public get Blocking(): boolean
    {
        return this.state === ReservationState.Held || this.state === ReservationState.Finalizing;
    }

    /** True once the deadline passed before Finalize (whether or not the release has happened yet). */
    public get Expired(): boolean
    {
        return this.state === ReservationState.Expired || (this.state === ReservationState.Held && Date.now() >= this.Deadline);
    }

    /** True once an upgrade wrote keys it reserved: its Finalize is then a ConflictError. */
    public get Invalidated(): boolean
    {
        return this.invalidated;
    }

    /** The error a finalize of an invalidated reservation rejects with. */
    public static InvalidatedError(): ConflictError
    {
        return new ConflictError(Reservation.ErrInvalidated);
    }

    /**
     * Marks the reservation invalidated by writes that bypassed the reservation checks (an upgrade's
     * commits). A held one is released at once; a finalizing one is rejected when its batch's group runs.
     */
    public Invalidate(): void
    {
        this.invalidated = true;
        if (this.state === ReservationState.Held)
        {
            this.End(ReservationState.Invalidated);
        }
    }

    /** True when `owner` is the container that holds this reservation. */
    public BelongsTo(owner: Reservations): boolean
    {
        return this.owner === owner;
    }

    /**
     * Held and not expired → Finalizing (it no longer expires) and undefined. Otherwise the error Finalize
     * rejects with: ConflictError when aborted, expired or disposed (an expired one is released now),
     * InvalidArgument when Finalize was already called.
     */
    public BeginFinalize(): GraphError | undefined
    {
        if (this.state === ReservationState.Held && Date.now() >= this.Deadline)
        {
            this.End(ReservationState.Expired);
        }
        switch (this.state)
        {
            case ReservationState.Held:
                this.state = ReservationState.Finalizing;
                return undefined;
            case ReservationState.Expired:
                return new ConflictError(Reservation.ErrExpired);
            case ReservationState.Invalidated:
                return Reservation.InvalidatedError();
            case ReservationState.Finalizing:
            case ReservationState.Finalized:
            case ReservationState.Failed:
                return new GraphError(GraphErrorCode.InvalidArgument, Reservation.ErrFinalized);
            default:
                return new ConflictError(Reservation.ErrReleased);
        }
    }

    /** Releases a held reservation; a no-op once Finalize was called or it already ended. */
    public Abort(): void
    {
        if (this.state === ReservationState.Held)
        {
            this.End(ReservationState.Aborted);
        }
    }

    /** Ends a blocking reservation with `state` and releases its keys; a no-op once it ended. */
    public End(state: ReservationState): void
    {
        if (this.Blocking)
        {
            this.state = state;
            this.owner.Remove(this);
        }
    }
}

/**
 * The reservations of a committer's outstanding prepared commits (ruling R71). A group candidate
 * conflicts when its applied write keys intersect a reservation's Reads, or when it writes and its reads
 * intersect a reservation's Writes. Expired reservations are released lazily (Sweep, at each group).
 */
export class Reservations
{
    private static readonly ErrReserved = 'Wrote keys reserved by a prepared commit';
    private static readonly ErrReservedRead = 'Read keys a prepared commit writes';

    /** Write-key families that only aggregate others (concept extent, whole column): writes to them commute. */
    private static readonly Commutative: ReadonlySet<Keyspace> = new Set([ConflictKeys.ExtentSpace, ConflictKeys.ColumnSpace]);

    private readonly held = new Set<Reservation>();

    /** Diagnostics: reservations currently blocking. */
    public get Count(): number
    {
        return this.held.size;
    }

    /** Registers a reservation for a dry-run's outcome: reads ∪ dependencies ∪ non-aggregate write keys. */
    public Reserve(reads: ReadSet, dependencies: ReadSet, writes: WriteKeySet, timeoutMs: number): Reservation
    {
        const reserved = reads.Clone();
        reserved.AddAll(dependencies);
        writes.AddTo(reserved, Reservations.Commutative);
        const reservation = new Reservation(this, reserved, writes, Date.now() + timeoutMs);
        this.held.add(reservation);
        return reservation;
    }

    /** Releases every held reservation whose deadline has passed. */
    public Sweep(): void
    {
        const now = Date.now();
        for (const r of [...this.held])
        {
            if (r.State === ReservationState.Held && now >= r.Deadline)
            {
                r.End(ReservationState.Expired);
            }
        }
    }

    /** The conflict for a writing candidate whose reads intersect a reservation's write keys, or undefined. */
    public ReadConflict(reads: ReadSet, except?: ReadonlySet<Reservation>): ConflictError | undefined
    {
        if (reads.IsEmpty)
        {
            return undefined;
        }
        for (const r of this.held)
        {
            if (except?.has(r) !== true && r.Writes.Intersects(reads))
            {
                return new ConflictError(Reservations.ErrReservedRead);
            }
        }
        return undefined;
    }

    /** The conflict for a candidate whose applied write keys intersect a reservation, or undefined. */
    public WriteConflict(keys: WriteKeySet, except?: ReadonlySet<Reservation>): ConflictError | undefined
    {
        for (const r of this.held)
        {
            if (except?.has(r) !== true && keys.Intersects(r.Reads))
            {
                return new ConflictError(Reservations.ErrReserved);
            }
        }
        return undefined;
    }

    /**
     * Invalidates every blocking reservation whose reserved keys `keys` intersect: an upgrade's commits
     * are not checked against reservations, and a seed commit keeps the catalog version (ruling R71).
     */
    public Invalidate(keys: WriteKeySet): void
    {
        for (const r of [...this.held])
        {
            if (keys.Intersects(r.Reads))
            {
                r.Invalidate();
            }
        }
    }

    /** Releases every reservation that is still only held (disposal); Finalizing ones end with their commit. */
    public Clear(): void
    {
        for (const r of [...this.held])
        {
            if (r.State === ReservationState.Held)
            {
                r.End(ReservationState.Disposed);
            }
        }
    }

    /** @internal Called by Reservation.End. */
    public Remove(reservation: Reservation): void
    {
        this.held.delete(reservation);
    }
}
