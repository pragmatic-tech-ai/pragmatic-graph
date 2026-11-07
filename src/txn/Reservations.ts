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
    /** A schema change or upgrade committed since Prepare: Finalize can only fail. */
    Invalidated,
}

/**
 * The logical keys one prepared commit holds until it finalizes, aborts or expires (ruling R71). Its
 * reserved reads are what no other commit may write: the prepared batch's ReadSet, the dry-run's
 * dependencies and its write keys except the commutative aggregate families (Extent, Column). Its writes
 * are the dry-run's write set, which no other commit that writes, and no other prepare, may have read or
 * depend on.
 *
 * A holder of the PreparedCommit may only Abort it and query it; every other transition takes the owning
 * Reservations as a capability, which only the committer holds.
 */
export class Reservation
{
    private static readonly ErrExpired = 'The prepared commit expired before Finalize';
    private static readonly ErrReleased = 'The prepared commit was aborted or released';
    private static readonly ErrFinalized = 'Finalize was already called on this prepared commit';
    private static readonly ErrInvalidated = 'A schema change or upgrade since Prepare wrote keys the prepared commit reserved';
    private static readonly ErrOwner = 'Reservation transition by a container that does not own it';

    private state = ReservationState.Held;
    private invalidated = false;

    public constructor(
        private readonly owner: Reservations,
        private readonly reads: ReadSet,
        private readonly writes: WriteKeySet,
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

    /** True once a schema change or upgrade invalidated it: its Finalize is then a ConflictError. */
    public get Invalidated(): boolean
    {
        return this.invalidated;
    }

    /** The error a finalize of an invalidated reservation rejects with. */
    public static InvalidatedError(): ConflictError
    {
        return new ConflictError(Reservation.ErrInvalidated);
    }

    /** True when `owner` is the container that holds this reservation. */
    public BelongsTo(owner: Reservations): boolean
    {
        return this.owner === owner;
    }

    /** True when any of the prepared write keys lies in `reads`. */
    public WritesIntersect(reads: ReadSet): boolean
    {
        return this.writes.Intersects(reads);
    }

    /** True when any of `keys` lies in the reserved reads. */
    public ReservesAny(keys: WriteKeySet): boolean
    {
        return keys.Intersects(this.reads);
    }

    /** Releases a held reservation; a no-op once Finalize was called or it already ended. */
    public Abort(): void
    {
        if (this.state === ReservationState.Held)
        {
            this.Transition(ReservationState.Aborted);
        }
    }

    /**
     * Held and not expired → Finalizing (it no longer expires) and undefined. Otherwise the error Finalize
     * rejects with: ConflictError when aborted, expired, invalidated or disposed (an expired one is
     * released now), InvalidArgument when Finalize was already called.
     */
    public BeginFinalize(owner: Reservations): GraphError | undefined
    {
        this.RequireOwner(owner);
        if (this.state === ReservationState.Held && Date.now() >= this.Deadline)
        {
            this.Transition(ReservationState.Expired);
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

    /** Ends a blocking reservation with `state` and releases its keys; a no-op once it ended. */
    public End(owner: Reservations, state: ReservationState): void
    {
        this.RequireOwner(owner);
        this.Transition(state);
    }

    /**
     * Marks it invalidated by writes that bypassed the reservation checks (a schema change or an upgrade).
     * A held one is released at once; a finalizing one is rejected when its batch's group runs.
     */
    public Invalidate(owner: Reservations): void
    {
        this.RequireOwner(owner);
        this.invalidated = true;
        if (this.state === ReservationState.Held)
        {
            this.Transition(ReservationState.Invalidated);
        }
    }

    private Transition(state: ReservationState): void
    {
        if (this.Blocking)
        {
            this.state = state;
            this.owner.Remove(this);
        }
    }

    private RequireOwner(owner: Reservations): void
    {
        if (owner !== this.owner)
        {
            throw new GraphError(GraphErrorCode.Internal, Reservation.ErrOwner);
        }
    }
}

/**
 * The reservations of a committer's outstanding prepared commits (ruling R71). A group candidate
 * conflicts when its applied write keys intersect a reservation's reserved reads, or when it writes and
 * its reads intersect a reservation's writes; a prepare conflicts the same way, with its reads and
 * dependencies as its reads, whether or not it writes. Expired reservations are released lazily (Sweep).
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

    /**
     * The reads a prepare reserves (and is checked with): its ReadSet, its dependencies and its write keys
     * except the commutative aggregate families. A new set.
     */
    public static ReservedReads(reads: ReadSet, dependencies: ReadSet, writes: WriteKeySet): ReadSet
    {
        const reserved = reads.Clone();
        reserved.AddAll(dependencies);
        writes.AddTo(reserved, Reservations.Commutative);
        return reserved;
    }

    /** Registers a reservation over `reserved` (see ReservedReads) and the dry-run's write keys. */
    public Reserve(reserved: ReadSet, writes: WriteKeySet, timeoutMs: number): Reservation
    {
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
                r.End(this, ReservationState.Expired);
            }
        }
    }

    /** The conflict for a candidate whose reads intersect a reservation's write keys, or undefined. */
    public ReadConflict(reads: ReadSet, except?: ReadonlySet<Reservation>): ConflictError | undefined
    {
        if (reads.IsEmpty)
        {
            return undefined;
        }
        for (const r of this.held)
        {
            if (except?.has(r) !== true && r.WritesIntersect(reads))
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
            if (except?.has(r) !== true && r.ReservesAny(keys))
            {
                return new ConflictError(Reservations.ErrReserved);
            }
        }
        return undefined;
    }

    /** Held and not expired → Finalizing; otherwise the error Finalize rejects with (Reservation.BeginFinalize). */
    public BeginFinalize(reservation: Reservation): GraphError | undefined
    {
        return reservation.BeginFinalize(this);
    }

    /** Ends a blocking reservation with `state` (its finalize batch settled). */
    public End(reservation: Reservation, state: ReservationState): void
    {
        reservation.End(this, state);
    }

    /**
     * Invalidates every blocking reservation whose reserved reads `keys` intersect: an upgrade's seed
     * commit is not checked against reservations and keeps the catalog version.
     */
    public Invalidate(keys: WriteKeySet): void
    {
        for (const r of [...this.held])
        {
            if (r.ReservesAny(keys))
            {
                r.Invalidate(this);
            }
        }
    }

    /** Invalidates every blocking reservation: the catalog version changed, so each Finalize can only fail. */
    public InvalidateAll(): void
    {
        for (const r of [...this.held])
        {
            r.Invalidate(this);
        }
    }

    /** Releases every reservation that is still only held (disposal); Finalizing ones end with their commit. */
    public Clear(): void
    {
        for (const r of [...this.held])
        {
            if (r.State === ReservationState.Held)
            {
                r.End(this, ReservationState.Disposed);
            }
        }
    }

    /** @internal Called by Reservation when it stops blocking. */
    public Remove(reservation: Reservation): void
    {
        this.held.delete(reservation);
    }
}
