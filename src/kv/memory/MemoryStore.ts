import { TupleCodec } from '../../format/TupleCodec.js';
import { IKeyRange, IKeyValueStore, IReadTransaction, IWriteTransaction } from '../KeyValue.js';
import { Keyspace } from '../Keyspace.js';

interface IEntry
{
    readonly Key: Uint8Array;
    readonly Value: Uint8Array;
}

interface IChange
{
    readonly Key: Uint8Array;
    readonly Value: Uint8Array | null;
}

/** Committed state: one sorted, never-mutated array per keyspace. A snapshot is a reference to it. */
type Snapshot = ReadonlyMap<Keyspace, readonly IEntry[]>;

class Sorted
{
    private static readonly HexEncoding = 'hex';

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

    public static Hex(key: Uint8Array): string
    {
        return Buffer.from(key).toString(Sorted.HexEncoding);
    }

    /** Overlays changes (null value = delete) on entries and returns the result in key order. */
    public static Merge(entries: readonly IEntry[], changes: Iterable<IChange>): IEntry[]
    {
        const merged = new Map<string, IEntry>();
        for (const entry of entries)
        {
            merged.set(Sorted.Hex(entry.Key), entry);
        }
        for (const change of changes)
        {
            const hex = Sorted.Hex(change.Key);
            if (change.Value === null)
            {
                merged.delete(hex);
            }
            else
            {
                merged.set(hex, { Key: change.Key, Value: change.Value });
            }
        }
        return [...merged.values()].sort((a, b) => TupleCodec.Compare(a.Key, b.Key));
    }
}

class MemoryReadTransaction implements IReadTransaction
{
    protected static readonly ErrDisposed = 'Transaction has been disposed';
    protected disposed = false;

    public constructor(protected readonly snapshot: Snapshot)
    {
    }

    public async Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>
    {
        this.EnsureLive();
        const value = this.Lookup(space, key);
        return value === undefined ? undefined : value.slice();
    }

    public async *Scan(space: Keyspace, range: IKeyRange, limit?: number): AsyncIterable<[Uint8Array, Uint8Array]>
    {
        this.EnsureLive();
        const entries = this.Entries(space, range);
        const count = limit === undefined ? entries.length : Math.min(limit, entries.length);
        for (let i = 0; i < count; i++)
        {
            const entry = entries[i] as IEntry;
            yield [entry.Key.slice(), entry.Value.slice()];
        }
    }

    public dispose(): void
    {
        this.disposed = true;
    }

    protected EnsureLive(): void
    {
        if (this.disposed)
        {
            throw new Error(MemoryReadTransaction.ErrDisposed);
        }
    }

    /** Raw (uncopied) value lookup. */
    protected Lookup(space: Keyspace, key: Uint8Array): Uint8Array | undefined
    {
        const entries = this.snapshot.get(space) ?? [];
        const hit = entries[Sorted.LowerBound(entries, key)];
        return hit !== undefined && TupleCodec.Compare(hit.Key, key) === 0 ? hit.Value : undefined;
    }

    /** Raw (uncopied) entries in range, in key order. */
    protected Entries(space: Keyspace, range: IKeyRange): readonly IEntry[]
    {
        const entries = this.snapshot.get(space) ?? [];
        const from = Sorted.LowerBound(entries, range.Start);
        const to = Sorted.LowerBound(entries, range.End);
        return to > from ? entries.slice(from, to) : [];
    }
}

class MemoryWriteTransaction extends MemoryReadTransaction implements IWriteTransaction
{
    /** Pending changes per keyspace, keyed by hex of the key; a null value is a delete. */
    private readonly pending = new Map<Keyspace, Map<string, IChange>>();

    public override async Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>
    {
        this.EnsureLive();
        const staged = this.pending.get(space)?.get(Sorted.Hex(key));
        if (staged !== undefined)
        {
            return staged.Value === null ? undefined : staged.Value.slice();
        }
        return super.Get(space, key);
    }

    public override async *Scan(space: Keyspace, range: IKeyRange, limit?: number): AsyncIterable<[Uint8Array, Uint8Array]>
    {
        this.EnsureLive();
        const inRange: IChange[] = [];
        for (const change of this.pending.get(space)?.values() ?? [])
        {
            if (TupleCodec.Compare(change.Key, range.Start) >= 0 && TupleCodec.Compare(change.Key, range.End) < 0)
            {
                inRange.push(change);
            }
        }
        const merged = Sorted.Merge(this.Entries(space, range), inRange);
        const count = limit === undefined ? merged.length : Math.min(limit, merged.length);
        for (let i = 0; i < count; i++)
        {
            const entry = merged[i] as IEntry;
            yield [entry.Key.slice(), entry.Value.slice()];
        }
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
            next.set(space, Sorted.Merge(this.snapshot.get(space) ?? [], staged.values()));
        }
        return next;
    }

    private Stage(space: Keyspace, key: Uint8Array, value: Uint8Array | null): void
    {
        this.EnsureLive();
        let bucket = this.pending.get(space);
        if (bucket === undefined)
        {
            bucket = new Map();
            this.pending.set(space, bucket);
        }
        const copy = key.slice();
        bucket.set(Sorted.Hex(copy), { Key: copy, Value: value });
    }
}

/** In-memory ordered key-value store. Single writer via a promise-chain mutex; snapshot reads. */
export class MemoryStore implements IKeyValueStore
{
    private static readonly ErrDisposed = 'Store has been disposed';

    private committed: Snapshot = new Map();
    private tail: Promise<unknown> = Promise.resolve();
    private disposed = false;

    public async BeginRead(): Promise<IReadTransaction>
    {
        this.EnsureLive();
        return new MemoryReadTransaction(this.committed);
    }

    public Write<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        this.EnsureLive();
        const run = this.tail.then(() => this.RunExclusive(work));
        this.tail = run.catch(() => undefined);
        return run;
    }

    public async dispose(): Promise<void>
    {
        this.disposed = true;
        await this.tail;
    }

    private async RunExclusive<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        const txn = new MemoryWriteTransaction(this.committed);
        try
        {
            const result = await work(txn);
            this.committed = txn.BuildCommitted();
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
            throw new Error(MemoryStore.ErrDisposed);
        }
    }
}
