import { open, RootDatabase, Database, Transaction, type RootDatabaseOptionsWithPath } from 'lmdb';
import { IKeyRange, IKeyValueStore, IReadTransaction, IScanOptions, IScanProbe, IWriteTransaction, KeyLimits, KeyRanges, ScanCounter } from '../KeyValue.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { Keyspace } from '../Keyspace.js';
import { PendingChanges } from '../PendingChanges.js';
import { LmdbLock } from './LmdbLock.js';
import { TupleCodec } from '../../format/TupleCodec.js';

export interface ILmdbOptions
{
    /** Maximum database size (default 16 GiB). */
    readonly MapSizeBytes?: number;
    /** Maximum concurrent read transactions across processes (default: LMDB's 126). */
    readonly MaxReaders?: number;
}

/**
 * One reference to a native read snapshot. Readers opened while no commit happened share one native
 * transaction (ruling F9); each holds a lease, and the snapshot is released when its last lease ends.
 */
class SnapshotLease
{
    private ended = false;

    public constructor(public readonly Txn: Transaction, private readonly shared: SharedSnapshot)
    {
    }

    public dispose(): void
    {
        if (!this.ended)
        {
            this.ended = true;
            this.Txn.done();
            this.shared.Users--;
        }
    }
}

/** A native read transaction pinned at one commit generation, with the number of live leases on it. */
class SharedSnapshot
{
    public Users = 0;

    public constructor(public readonly Txn: Transaction, public readonly Generation: number)
    {
    }
}

type Databases = ReadonlyMap<Keyspace, Database<Buffer, Buffer>>;

class LmdbErrors
{
    public static readonly StoreDisposed = 'Store has been disposed';
    public static readonly TxnDisposed = 'Transaction has been disposed';
}

class LmdbKeys
{
    public static Require(key: Uint8Array): void
    {
        KeyLimits.RequireKey(key);
    }
}

class LmdbReadTransaction implements IReadTransaction
{
    protected disposed = false;

    protected readonly snapshot: Transaction;

    public constructor(
        protected readonly databases: Databases,
        private readonly lease: SnapshotLease,
        protected readonly counter: ScanCounter,
        private readonly onDispose?: () => void,
    )
    {
        this.snapshot = lease.Txn;
    }

    public async Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>
    {
        this.EnsureLive();
        return this.Lookup(space, key);
    }

    public async *Scan(space: Keyspace, range: IKeyRange, options?: IScanOptions): AsyncIterable<[Uint8Array, Uint8Array]>
    {
        this.EnsureLive();
        KeyLimits.RequireRange(range);
        for (const pair of this.Entries(space, range, options?.Reverse === true, options?.Limit))
        {
            this.counter.Count++;
            this.EnsureLive();
            yield pair;
        }
    }

    public dispose(): void
    {
        if (!this.disposed)
        {
            this.disposed = true;
            this.lease.dispose();
            this.onDispose?.();
        }
    }

    protected EnsureLive(): void
    {
        if (this.disposed)
        {
            throw new GraphError(GraphErrorCode.Disposed, LmdbErrors.TxnDisposed);
        }
    }

    /** Copy of the snapshot value, or undefined. */
    protected Lookup(space: Keyspace, key: Uint8Array): Uint8Array | undefined
    {
        LmdbKeys.Require(key);
        const value = this.Db(space).get(Buffer.from(key), { transaction: this.snapshot });
        return value === undefined ? undefined : Uint8Array.from(value);
    }

    /**
     * Lazily reads copies of the snapshot entries in range, in key order or descending with reverse
     * (getRange is a lazy cursor; closed on early exit).
     */
    protected *Entries(space: Keyspace, range: IKeyRange, reverse: boolean, limit?: number): Iterable<[Uint8Array, Uint8Array]>
    {
        if ((limit !== undefined && limit <= 0) || KeyRanges.IsEmpty(range))
        {
            return;
        }
        if (reverse)
        {
            yield* this.ReverseEntries(space, range, limit);
            return;
        }
        const options: Parameters<Database['getRange']>[0] = {
            end: Buffer.from(range.End),
            transaction: this.snapshot,
            ...(range.Start.length > 0 ? { start: Buffer.from(range.Start) } : {}),
            ...(limit === undefined ? {} : { limit }),
        };
        for (const entry of this.Db(space).getRange(options))
        {
            yield [Uint8Array.from(entry.key), Uint8Array.from(entry.value)];
        }
    }

    /**
     * Descending cursor from End: lmdb-js reverse ranges treat `start` (End here) as inclusive and `end`
     * as exclusive, the opposite of IKeyRange, so the cursor is opened without an end bound, a key equal
     * to End is skipped and the walk stops below Start; the limit is applied here.
     */
    private *ReverseEntries(space: Keyspace, range: IKeyRange, limit?: number): Iterable<[Uint8Array, Uint8Array]>
    {
        const max = limit ?? Number.POSITIVE_INFINITY;
        let produced = 0;
        for (const entry of this.Db(space).getRange({ start: Buffer.from(range.End), reverse: true, transaction: this.snapshot }))
        {
            if (TupleCodec.Compare(entry.key, range.End) >= 0)
            {
                // Read from storage but outside the range: still counted, so IScanProbe reflects cursor work.
                this.counter.Count++;
                continue;
            }
            if (TupleCodec.Compare(entry.key, range.Start) < 0)
            {
                this.counter.Count++;
                return;
            }
            yield [Uint8Array.from(entry.key), Uint8Array.from(entry.value)];
            if (++produced >= max)
            {
                return;
            }
        }
    }

    protected Db(space: Keyspace): Database<Buffer, Buffer>
    {
        return this.databases.get(space) as Database<Buffer, Buffer>;
    }
}

class LmdbWriteTransaction extends LmdbReadTransaction implements IWriteTransaction
{
    /** Pending changes per keyspace, in key order; a null value is a delete. */
    private readonly pending = new Map<Keyspace, PendingChanges>();

    public override async Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>
    {
        this.EnsureLive();
        LmdbKeys.Require(key);
        const staged = this.pending.get(space)?.Get(key);
        if (staged !== undefined)
        {
            return staged.Value === null ? undefined : staged.Value.slice();
        }
        return this.Lookup(space, key);
    }

    /**
     * Lazy merge of the snapshot cursor with this transaction's staged changes (staged deletes hide
     * stored keys, so the cursor is read without a limit); stops as soon as `limit` entries were produced.
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

    /** Applies every staged change; call inside the environment's synchronous write transaction. */
    public Apply(): void
    {
        for (const [space, bucket] of this.pending)
        {
            const db = this.Db(space);
            for (const change of bucket.Values())
            {
                const key = Buffer.from(change.Key);
                if (change.Value === null)
                {
                    db.removeSync(key);
                }
                else
                {
                    db.putSync(key, Buffer.from(change.Value));
                }
            }
        }
    }

    private Stage(space: Keyspace, key: Uint8Array, value: Uint8Array | null): void
    {
        this.EnsureLive();
        LmdbKeys.Require(key);
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

/** Durable ordered key-value store on one LMDB environment (one named database per keyspace). */
export class LmdbStore implements IKeyValueStore, IScanProbe
{
    private static readonly DefaultMapSizeBytes = 16 * 1024 * 1024 * 1024;
    private static readonly BinaryEncoding = 'binary';

    private tail: Promise<unknown> = Promise.resolve();
    private disposed = false;
    private readonly liveReads = new Set<LmdbReadTransaction>();
    private readonly counter = new ScanCounter();
    /** Bumped by every commit; a shared snapshot of an older generation is never reused. */
    private generation = 0;
    private shared: SharedSnapshot | undefined;
    private nativeSnapshots = 0;

    public get EntriesRead(): number
    {
        return this.counter.Count;
    }

    /** Diagnostics: native read snapshots opened so far (readers between two commits share one). */
    public get NativeSnapshotsOpened(): number
    {
        return this.nativeSnapshots;
    }

    /** Diagnostics: the environment's map size and reader limit as LMDB reports them. */
    public get Settings(): { readonly MapSizeBytes: number; readonly MaxReaders: number }
    {
        const stats = this.root.getStats() as { mapSize: number; maxReaders: number };
        return { MapSizeBytes: stats.mapSize, MaxReaders: stats.maxReaders };
    }

    /** Diagnostics: whether the open environment syncs commits asynchronously (always false; see OpenOptions). */
    public get OverlappingSync(): boolean
    {
        return (this.root as unknown as { overlappingSync?: boolean }).overlappingSync === true;
    }

    private constructor(
        private readonly root: RootDatabase,
        private readonly databases: Databases,
        private readonly lock: LmdbLock,
    )
    {
    }

    /**
     * The lmdb-js environment options Open uses. overlappingSync is explicitly off on every platform
     * (lmdb-js turns it on by default outside Windows, which lets transactionSync return before the
     * fsync): a Write resolves only once its data is durable.
     */
    public static OpenOptions(path: string, options?: ILmdbOptions): RootDatabaseOptionsWithPath
    {
        return {
            path,
            mapSize: options?.MapSizeBytes ?? LmdbStore.DefaultMapSizeBytes,
            maxDbs: Object.values(Keyspace).length,
            keyEncoding: LmdbStore.BinaryEncoding,
            encoding: LmdbStore.BinaryEncoding,
            overlappingSync: false,
            ...(options?.MaxReaders === undefined ? {} : { maxReaders: options.MaxReaders }),
        };
    }

    /**
     * Opens (creating when absent) the environment in directory `path`, taking its exclusive writer lock
     * (LmdbLock): a second store on the same directory, in this or another live process, is refused with
     * GraphError Locked until the first is disposed.
     */
    public static async Open(path: string, options?: ILmdbOptions): Promise<LmdbStore>
    {
        const spaces = Object.values(Keyspace);
        const lock = LmdbLock.Acquire(path);
        let root: RootDatabase | undefined;
        try
        {
            root = open(LmdbStore.OpenOptions(path, options));
            const databases = new Map<Keyspace, Database<Buffer, Buffer>>();
            for (const space of spaces)
            {
                databases.set(space, LmdbStore.OpenDatabase(root, space));
            }
            return new LmdbStore(root, databases, lock);
        }
        catch (error)
        {
            // Any failure releases everything taken so far, so the directory can be opened again.
            try
            {
                await root?.close();
            }
            finally
            {
                lock.dispose();
            }
            throw error;
        }
    }

    /** Opens one keyspace's named database (a static seam so tests can inject an open failure). */
    private static OpenDatabase(root: RootDatabase, space: Keyspace): Database<Buffer, Buffer>
    {
        return root.openDB<Buffer, Buffer>(space, {
            keyEncoding: LmdbStore.BinaryEncoding,
            encoding: LmdbStore.BinaryEncoding,
        });
    }

    public async BeginRead(): Promise<IReadTransaction>
    {
        this.EnsureLive();
        const read = new LmdbReadTransaction(this.databases, this.Lease(), this.counter, () => this.liveReads.delete(read));
        this.liveReads.add(read);
        return read;
    }

    public Write<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        if (this.disposed)
        {
            return Promise.reject(new GraphError(GraphErrorCode.Disposed, LmdbErrors.StoreDisposed));
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
        await this.root.close();
        this.lock.dispose();
    }

    /**
     * A lease on the latest committed state; only the single (locked) writer commits, so it is current.
     * While no commit happened since the shared snapshot was opened and it still has live leases, the
     * same native transaction is reused (ruling F9); otherwise a fresh one is pinned.
     */
    private Lease(): SnapshotLease
    {
        const shared = this.shared;
        if (shared !== undefined && shared.Users > 0 && shared.Generation === this.generation)
        {
            // lmdb-js read transactions are reference counted: use() adds one, done() releases one (untyped in its .d.ts).
            (shared.Txn as unknown as { use(): void }).use();
            shared.Users++;
            return new SnapshotLease(shared.Txn, shared);
        }
        this.root.resetReadTxn();
        const fresh = new SharedSnapshot(this.root.useReadTransaction(), this.generation);
        fresh.Users = 1;
        this.nativeSnapshots++;
        this.shared = fresh;
        return new SnapshotLease(fresh.Txn, fresh);
    }

    private async RunExclusive<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        const txn = new LmdbWriteTransaction(this.databases, this.Lease(), this.counter);
        try
        {
            const result = await work(txn);
            this.root.transactionSync(() => txn.Apply());
            this.generation++;
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
            throw new GraphError(GraphErrorCode.Disposed, LmdbErrors.StoreDisposed);
        }
    }
}
