import { TupleCodec } from '../../format/TupleCodec.js';
import { IKeyRange, IKeyValueStore, IReadTransaction, IScanProbe, IWriteTransaction, ScanCounter } from '../KeyValue.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { Keyspace } from '../Keyspace.js';
import { type IPendingChange, PendingChanges } from '../PendingChanges.js';

interface IEntry
{
    readonly Key: Uint8Array;
    readonly Value: Uint8Array;
}

/** Committed state: one sorted, never-mutated array per keyspace. A snapshot is a reference to it. */
type Snapshot = ReadonlyMap<Keyspace, readonly IEntry[]>;

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

    /** Overlays sorted changes (null value = delete) on sorted entries in one linear merge (not a scan: uncounted); the result is in key order. */
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
    protected static readonly ErrEmptyKey = 'Empty keys are not supported';
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

    public async *Scan(space: Keyspace, range: IKeyRange, limit?: number): AsyncIterable<[Uint8Array, Uint8Array]>
    {
        this.EnsureLive();
        let produced = 0;
        const max = limit ?? Number.POSITIVE_INFINITY;
        if (max <= 0)
        {
            return;
        }
        for (const [key, value] of this.Entries(space, range))
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
        if (key.length === 0)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, MemoryReadTransaction.ErrEmptyKey);
        }
    }

    /** Raw (uncopied) value lookup. */
    protected Lookup(space: Keyspace, key: Uint8Array): Uint8Array | undefined
    {
        const entries = this.snapshot.get(space) ?? [];
        const hit = entries[Sorted.LowerBound(entries, key)];
        return hit !== undefined && TupleCodec.Compare(hit.Key, key) === 0 ? hit.Value : undefined;
    }

    /** Raw (uncopied) entries in range, in key order, produced lazily from the binary-searched start. */
    protected *Entries(space: Keyspace, range: IKeyRange): Iterable<readonly [Uint8Array, Uint8Array]>
    {
        const entries = this.snapshot.get(space) ?? [];
        for (let i = Sorted.LowerBound(entries, range.Start); i < entries.length; i++)
        {
            const entry = entries[i] as IEntry;
            if (TupleCodec.Compare(entry.Key, range.End) >= 0)
            {
                return;
            }
            yield [entry.Key, entry.Value];
        }
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

    /** Lazy merge of the snapshot with this transaction's staged changes; stops as soon as `limit` entries were produced. */
    public override async *Scan(space: Keyspace, range: IKeyRange, limit?: number): AsyncIterable<[Uint8Array, Uint8Array]>
    {
        this.EnsureLive();
        const version = PendingChanges.VersionOf(this.pending.get(space));
        const staged = this.pending.get(space)?.InRange(range) ?? PendingChanges.None;
        for (const [key, value] of PendingChanges.Merge(this.Entries(space, range), staged, this.counter, limit))
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

    /** Builds the next committed state: untouched keyspaces are shared, touched ones are rebuilt. */
    public BuildCommitted(): Snapshot
    {
        const next = new Map<Keyspace, readonly IEntry[]>(this.snapshot);
        for (const [space, staged] of this.pending)
        {
            next.set(space, [...Sorted.Merge(this.snapshot.get(space) ?? [], staged.Values())]);
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

    public get EntriesRead(): number
    {
        return this.counter.Count;
    }

    /** Diagnostics: keyspaces whose committed array commits have rebuilt so far (untouched ones are shared). */
    public get KeyspacesRebuilt(): number
    {
        return this.rebuilt;
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
            const next = txn.BuildCommitted();
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
