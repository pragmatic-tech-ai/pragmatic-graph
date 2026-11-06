import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { Keyspace } from './Keyspace.js';

/** Half-open key range: Start inclusive, End exclusive. */
export interface IKeyRange
{
    readonly Start: Uint8Array;
    readonly End: Uint8Array;
}

export interface IScanOptions
{
    /** At most this many entries (none for 0 or less). */
    readonly Limit?: number;
    /** Descending key order: from just below End down to Start (still Start inclusive, End exclusive). */
    readonly Reverse?: boolean;
}

/** Range helpers shared by the backends. */
export class KeyRanges
{
    private static readonly NoEntries: ReadonlyArray<readonly [Uint8Array, Uint8Array]> = Object.freeze([]);

    /**
     * True when the range holds no key: Start >= End bytewise (an empty End included). Backends
     * short-circuit such ranges in both directions without touching storage (lmdb-js would read an empty
     * end bound as "no bound").
     */
    public static IsEmpty(range: IKeyRange): boolean
    {
        const a = range.Start;
        const b = range.End;
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++)
        {
            if (a[i] !== b[i])
            {
                return (a[i] as number) > (b[i] as number);
            }
        }
        return a.length >= b.length;
    }

    public static get None(): Iterable<readonly [Uint8Array, Uint8Array]>
    {
        return KeyRanges.NoEntries;
    }
}

/**
 * The portable key rules every backend enforces identically: keys are non-empty and at most
 * MaxKeyBytes (511, the smallest common limit of the target stores, e.g. heed's default) long. Scan
 * bounds may be empty but not longer. Violations are GraphErrors (InvalidArgument, KeyTooLong).
 */
export class KeyLimits
{
    public static readonly MaxKeyBytes = 511;
    private static readonly ErrEmptyKey = 'Empty keys are not supported';
    private static readonly ErrTooLong = 'Key exceeds the portable maximum of 511 bytes: ';

    public static RequireKey(key: Uint8Array): void
    {
        if (key.length === 0)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, KeyLimits.ErrEmptyKey);
        }
        KeyLimits.RequireLength(key);
    }

    public static RequireRange(range: IKeyRange): void
    {
        KeyLimits.RequireLength(range.Start);
        KeyLimits.RequireLength(range.End);
    }

    private static RequireLength(key: Uint8Array): void
    {
        if (key.length > KeyLimits.MaxKeyBytes)
        {
            throw new GraphError(GraphErrorCode.KeyTooLong, KeyLimits.ErrTooLong + key.length);
        }
    }
}

/**
 * Sees one immutable snapshot for its whole life. Returned buffers are always copies.
 * Keys follow KeyLimits: an empty or over-long key is rejected (Get and Scan reject, Put/Delete throw).
 * Store disposal releases every still-open transaction; later use throws.
 */
export interface IReadTransaction
{
    Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>;
    /**
     * Entries with Start <= key < End in key order (descending with Reverse), at most Limit. Lazy: stops
     * reading storage once Limit entries were produced. In a write transaction, do not Put or Delete anything in the same
     * keyspace while a Scan of it is open (not finished, broken out of or returned): the scan's next step
     * throws (collect first, then mutate). This covers replacing or deleting an already-staged key and
     * the keyspace's first staged change. Writes to other keyspaces are allowed.
     */
    Scan(space: Keyspace, range: IKeyRange, options?: IScanOptions): AsyncIterable<[Uint8Array, Uint8Array]>;
    dispose(): void;
}

/** Reads see this transaction's own pending writes merged over its snapshot. Empty keys are rejected. */
export interface IWriteTransaction extends IReadTransaction
{
    Put(space: Keyspace, key: Uint8Array, value: Uint8Array): void;
    Delete(space: Keyspace, key: Uint8Array): void;
}

/**
 * Diagnostics a backend may offer: stored entries its Scans have pulled so far (committed entries read
 * plus staged changes visited), across all transactions. Tests use it to prove scans stop early.
 */
export interface IScanProbe
{
    readonly EntriesRead: number;
}

/** Shared counter behind IScanProbe; a store hands one instance to each of its transactions. */
export class ScanCounter
{
    public Count = 0;
}

export interface IKeyValueStore
{
    BeginRead(): Promise<IReadTransaction>;
    /** Runs exclusively; commits atomically when work resolves, rolls back when it rejects. */
    Write<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>;
    dispose(): Promise<void>;
}
