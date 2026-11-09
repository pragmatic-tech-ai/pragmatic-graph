import { TupleCodec } from '../../format/TupleCodec.js';
import { IKeyRange, IKeyValueStore, IReadTransaction, IScanOptions, IScanProbe, IWriteTransaction, KeyLimits, KeyRanges, ScanCounter } from '../KeyValue.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { Keyspace } from '../Keyspace.js';
import { type IPendingChange, PendingChanges } from '../PendingChanges.js';

interface IEntry
{
    readonly Key: Uint8Array;
    readonly Value: Uint8Array;
}

/** Commit statistics for the diagnostics counters. */
class CommitStats
{
    public EntriesCopied = 0;
}

/**
 * One keyspace's committed entries as an immutable chunked sorted list: never-mutated leaves of at most
 * about LeafCapacity entries, in key order. A commit builds a new list that shares every leaf the
 * transaction did not touch (copy-on-write per leaf, ruling F9): it copies only the touched leaves plus
 * the leaf directory (one reference per leaf), not the whole keyspace.
 */
class LeafList
{
    public static readonly LeafCapacity = 512;
    public static readonly Empty = new LeafList([]);

    private constructor(private readonly leaves: ReadonlyArray<readonly IEntry[]>)
    {
    }

    public get LeafCount(): number
    {
        return this.leaves.length;
    }

    public Get(key: Uint8Array): Uint8Array | undefined
    {
        const leaf = this.leaves[this.LeafFor(key)];
        if (leaf === undefined)
        {
            return undefined;
        }
        const hit = leaf[Sorted.LowerBound(leaf, key)];
        return hit !== undefined && TupleCodec.Compare(hit.Key, key) === 0 ? hit.Value : undefined;
    }

    /** Raw entries in range, ascending, lazily from the binary-searched start. */
    public *Forward(range: IKeyRange): Iterable<readonly [Uint8Array, Uint8Array]>
    {
        const first = this.LeafFor(range.Start);
        for (let li = first; li < this.leaves.length; li++)
        {
            const leaf = this.leaves[li] as readonly IEntry[];
            for (let i = li === first ? Sorted.LowerBound(leaf, range.Start) : 0; i < leaf.length; i++)
            {
                const entry = leaf[i] as IEntry;
                if (TupleCodec.Compare(entry.Key, range.End) >= 0)
                {
                    return;
                }
                yield [entry.Key, entry.Value];
            }
        }
    }

    /** Raw entries in range, descending, lazily from the binary-searched end. */
    public *Reverse(range: IKeyRange): Iterable<readonly [Uint8Array, Uint8Array]>
    {
        const last = this.LeafFor(range.End);
        for (let li = last; li >= 0; li--)
        {
            const leaf = this.leaves[li] as readonly IEntry[] | undefined;
            if (leaf === undefined)
            {
                return;
            }
            for (let i = (li === last ? Sorted.LowerBound(leaf, range.End) : leaf.length) - 1; i >= 0; i--)
            {
                const entry = leaf[i] as IEntry;
                if (TupleCodec.Compare(entry.Key, range.Start) < 0)
                {
                    return;
                }
                yield [entry.Key, entry.Value];
            }
        }
    }

    /**
     * A new list with the sorted changes applied; leaves without changes are shared, touched ones rebuilt (and split
     * when over capacity).
     */
    public Apply(changes: readonly IPendingChange[], stats: CommitStats): LeafList
    {
        if (changes.length === 0)
        {
            return this;
        }
        const next: Array<readonly IEntry[]> = [];
        if (this.leaves.length === 0)
        {
            LeafList.PushSplit(next, [...Sorted.Merge([], changes)], stats);
            return new LeafList(next);
        }
        let j = 0;
        for (let li = 0; li < this.leaves.length; li++)
        {
            const leaf = this.leaves[li] as readonly IEntry[];
            const following = this.leaves[li + 1];
            const bound = following === undefined ? undefined : (following[0] as IEntry).Key;
            const start = j;
            while (j < changes.length && (bound === undefined || TupleCodec.Compare((changes[j] as IPendingChange).Key, bound) < 0))
            {
                j++;
            }
            if (start === j)
            {
                next.push(leaf);
                continue;
            }
            LeafList.PushSplit(next, [...Sorted.Merge(leaf, changes.slice(start, j))], stats);
        }
        return new LeafList(next);
    }

    private static PushSplit(into: Array<readonly IEntry[]>, entries: IEntry[], stats: CommitStats): void
    {
        stats.EntriesCopied += entries.length;
        if (entries.length <= 2 * LeafList.LeafCapacity)
        {
            if (entries.length > 0)
            {
                into.push(entries);
            }
            return;
        }
        for (let i = 0; i < entries.length; i += LeafList.LeafCapacity)
        {
            into.push(entries.slice(i, i + LeafList.LeafCapacity));
        }
    }

    /** Index of the last leaf whose first key is <= key (0 when key precedes every leaf). */
    private LeafFor(key: Uint8Array): number
    {
        let lo = 0;
        let hi = this.leaves.length - 1;
        while (lo < hi)
        {
            const mid = (lo + hi + 1) >> 1;
            if (TupleCodec.Compare(((this.leaves[mid] as readonly IEntry[])[0] as IEntry).Key, key) <= 0)
            {
                lo = mid;
            }
            else
            {
                hi = mid - 1;
            }
        }
        return lo;
    }
}

/** Committed state: one immutable LeafList per keyspace. A snapshot is a reference to it. */
type Snapshot = ReadonlyMap<Keyspace, LeafList>;

class Sorted
{
    /** Index of the first entry whose key is >= key. */
    public static LowerBound(entries: readonly IEntry[], key: Uint8Array): number
    {
        let lo = 0;
        let hi = entries.length;
        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;
            if (TupleCodec.Compare((entries[mid] as IEntry).Key, key) < 0)
            {
                lo = mid + 1;
            }
            else
            {
                hi = mid;
            }
        }
        return lo;
    }

    /**
     * Overlays sorted changes (null value = delete) on sorted entries in one linear merge (not a scan: uncounted); the
     * result is in key order.
     */
    public static *Merge(entries: readonly IEntry[], changes: Iterable<IPendingChange>): Iterable<IEntry>
    {
        for (const [key, value] of PendingChanges.Merge(Sorted.Pairs(entries), changes, new ScanCounter()))
        {
            yield { Key: key, Value: value };
        }
    }

    private static *Pairs(entries: readonly IEntry[]): Iterable<readonly [Uint8Array, Uint8Array]>
    {
        for (const entry of entries)
        {
            yield [entry.Key, entry.Value];
        }
    }
}

class MemoryReadTransaction implements IReadTransaction
{
    protected static readonly ErrDisposed = 'Transaction has been disposed';
    protected disposed = false;

    public constructor(
        protected readonly snapshot: Snapshot,
        protected readonly counter: ScanCounter,
        private readonly onDispose?: () => void,
    )
    {
    }

    public async Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>
    {
        this.EnsureLive();
        MemoryReadTransaction.RequireKey(key);
        const value = this.Lookup(space, key);
        return value === undefined ? undefined : value.slice();
    }

    public async *Scan(space: Keyspace, range: IKeyRange, options?: IScanOptions): AsyncIterable<[Uint8Array, Uint8Array]>
    {
        this.EnsureLive();
        KeyLimits.RequireRange(range);
        let produced = 0;
        const max = options?.Limit ?? Number.POSITIVE_INFINITY;
        if (max <= 0)
        {
            return;
        }
        for (const [key, value] of this.Entries(space, range, options?.Reverse === true))
        {
            this.counter.Count++;
            this.EnsureLive();
            yield [key.slice(), value.slice()];
            if (++produced >= max)
            {
                return;
            }
        }
    }

    public dispose(): void
    {
        this.disposed = true;
        this.onDispose?.();
    }

    protected EnsureLive(): void
    {
        if (this.disposed)
        {
            throw new GraphError(GraphErrorCode.Disposed, MemoryReadTransaction.ErrDisposed);
        }
    }

    protected static RequireKey(key: Uint8Array): void
    {
        KeyLimits.RequireKey(key);
    }

    /** Raw (uncopied) value lookup. */
    protected Lookup(space: Keyspace, key: Uint8Array): Uint8Array | undefined
    {
        return (this.snapshot.get(space) ?? LeafList.Empty).Get(key);
    }

    /**
     * Raw (uncopied) entries in range, in key order (descending with reverse), produced lazily from the binary-searched
     * bound.
     */
    protected Entries(space: Keyspace, range: IKeyRange, reverse: boolean): Iterable<readonly [Uint8Array, Uint8Array]>
    {
        if (KeyRanges.IsEmpty(range))
        {
            return KeyRanges.None;
        }
        const list = this.snapshot.get(space) ?? LeafList.Empty;
        return reverse ? list.Reverse(range) : list.Forward(range);
    }
}

class MemoryWriteTransaction extends MemoryReadTransaction implements IWriteTransaction
{
    /** Pending changes per keyspace, in key order; a null value is a delete. */
    private readonly pending = new Map<Keyspace, PendingChanges>();

    public override async Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>
    {
        this.EnsureLive();
        MemoryReadTransaction.RequireKey(key);
        const staged = this.pending.get(space)?.Get(key);
        if (staged !== undefined)
        {
            return staged.Value === null ? undefined : staged.Value.slice();
        }
        return super.Get(space, key);
    }

    /**
     * Lazy merge of the snapshot with this transaction's staged changes; stops as soon as `limit` entries were
     * produced.
     */
    public override async *Scan(space: Keyspace, range: IKeyRange, options?: IScanOptions): AsyncIterable<[Uint8Array, Uint8Array]>
    {
        this.EnsureLive();
        KeyLimits.RequireRange(range);
        const reverse = options?.Reverse === true;
        const version = PendingChanges.VersionOf(this.pending.get(space));
        const staged = this.pending.get(space)?.Range(range, reverse) ?? PendingChanges.None;
        for (const [key, value] of PendingChanges.Merge(this.Entries(space, range, reverse), staged, this.counter, options?.Limit, reverse))
        {
            this.EnsureLive();
            PendingChanges.RequireVersion(this.pending.get(space), version);
            yield [key.slice(), value.slice()];
        }
        PendingChanges.RequireVersion(this.pending.get(space), version);
    }

    public Put(space: Keyspace, key: Uint8Array, value: Uint8Array): void
    {
        this.Stage(space, key, value.slice());
    }

    public Delete(space: Keyspace, key: Uint8Array): void
    {
        this.Stage(space, key, null);
    }

    /** Builds the next committed state: untouched keyspaces and untouched leaves are shared, touched leaves rebuilt. */
    public BuildCommitted(stats: CommitStats): Snapshot
    {
        const next = new Map<Keyspace, LeafList>(this.snapshot);
        for (const [space, staged] of this.pending)
        {
            next.set(space, (this.snapshot.get(space) ?? LeafList.Empty).Apply([...staged.Values()], stats));
        }
        return next;
    }

    private Stage(space: Keyspace, key: Uint8Array, value: Uint8Array | null): void
    {
        this.EnsureLive();
        MemoryReadTransaction.RequireKey(key);
        this.Bucket(space).Set(key.slice(), value);
    }

    private Bucket(space: Keyspace): PendingChanges
    {
        let bucket = this.pending.get(space);
        if (bucket === undefined)
        {
            bucket = new PendingChanges();
            this.pending.set(space, bucket);
        }
        return bucket;
    }
}

/** In-memory ordered key-value store. Single writer via a promise-chain mutex; snapshot reads. */
export class MemoryStore implements IKeyValueStore, IScanProbe
{
    private static readonly ErrDisposed = 'Store has been disposed';

    private committed: Snapshot = new Map();
    private tail: Promise<unknown> = Promise.resolve();
    private disposed = false;
    private readonly liveReads = new Set<MemoryReadTransaction>();
    private readonly counter = new ScanCounter();
    private rebuilt = 0;
    private readonly stats = new CommitStats();

    public get EntriesRead(): number
    {
        return this.counter.Count;
    }

    /**
     * Diagnostics, not part of IKeyValueStore: keyspaces whose committed leaf list commits have rebuilt so
     * far (untouched keyspaces are shared).
     */
    public get KeyspacesRebuilt(): number
    {
        return this.rebuilt;
    }

    /** Diagnostics, not part of IKeyValueStore: entries commits have copied into rebuilt leaves so far. */
    public get EntriesCopied(): number
    {
        return this.stats.EntriesCopied;
    }

    public async BeginRead(): Promise<IReadTransaction>
    {
        this.EnsureLive();
        const read = new MemoryReadTransaction(this.committed, this.counter, () => this.liveReads.delete(read));
        this.liveReads.add(read);
        return read;
    }

    public Write<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        if (this.disposed)
        {
            return Promise.reject(new GraphError(GraphErrorCode.Disposed, MemoryStore.ErrDisposed));
        }
        const run = this.tail.then(() => this.RunExclusive(work));
        this.tail = run.catch(() => undefined);
        return run;
    }

    public async dispose(): Promise<void>
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        await this.tail;
        for (const read of [...this.liveReads])
        {
            read.dispose();
        }
    }

    private async RunExclusive<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        const txn = new MemoryWriteTransaction(this.committed, this.counter);
        try
        {
            const result = await work(txn);
            const next = txn.BuildCommitted(this.stats);
            for (const [space, entries] of next)
            {
                if (this.committed.get(space) !== entries)
                {
                    this.rebuilt++;
                }
            }
            this.committed = next;
            return result;
        }
        finally
        {
            txn.dispose();
        }
    }

    private EnsureLive(): void
    {
        if (this.disposed)
        {
            throw new GraphError(GraphErrorCode.Disposed, MemoryStore.ErrDisposed);
        }
    }
}
