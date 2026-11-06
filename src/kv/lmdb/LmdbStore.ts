import { open, RootDatabase, Database, Transaction, type RootDatabaseOptionsWithPath } from 'lmdb';
import { IKeyRange, IKeyValueStore, IReadTransaction, IScanProbe, IWriteTransaction, ScanCounter } from '../KeyValue.js';
import { Keyspace } from '../Keyspace.js';
import { PendingChanges } from '../PendingChanges.js';

export interface ILmdbOptions
{
    MapSizeBytes?: number;
}

type Databases = ReadonlyMap<Keyspace, Database<Buffer, Buffer>>;

class LmdbErrors
{
    public static readonly StoreDisposed = 'Store has been disposed';
    public static readonly TxnDisposed = 'Transaction has been disposed';
    public static readonly EmptyKey = 'Empty keys are not supported';
}

class LmdbKeys
{
    public static Require(key: Uint8Array): void
    {
        if (key.length === 0)
        {
            throw new Error(LmdbErrors.EmptyKey);
        }
    }
}

class LmdbReadTransaction implements IReadTransaction
{
    protected disposed = false;

    public constructor(
        protected readonly databases: Databases,
        protected readonly snapshot: Transaction,
        protected readonly counter: ScanCounter,
        private readonly onDispose?: () => void,
    )
    {
    }

    public async Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>
    {
        this.EnsureLive();
        return this.Lookup(space, key);
    }

    public async *Scan(space: Keyspace, range: IKeyRange, limit?: number): AsyncIterable<[Uint8Array, Uint8Array]>
    {
        this.EnsureLive();
        for (const pair of this.Entries(space, range, limit))
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
            this.snapshot.done();
            this.onDispose?.();
        }
    }

    protected EnsureLive(): void
    {
        if (this.disposed)
        {
            throw new Error(LmdbErrors.TxnDisposed);
        }
    }

    /** Copy of the snapshot value, or undefined. */
    protected Lookup(space: Keyspace, key: Uint8Array): Uint8Array | undefined
    {
        LmdbKeys.Require(key);
        const value = this.Db(space).get(Buffer.from(key), { transaction: this.snapshot });
        return value === undefined ? undefined : Uint8Array.from(value);
    }

    /** Lazily reads copies of the snapshot entries in range, in key order (getRange is a lazy cursor; closed on early exit). */
    protected *Entries(space: Keyspace, range: IKeyRange, limit?: number): Iterable<[Uint8Array, Uint8Array]>
    {
        if (limit !== undefined && limit <= 0)
        {
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

    public get EntriesRead(): number
    {
        return this.counter.Count;
    }

    /** Diagnostics: whether the open environment syncs commits asynchronously (always false; see OpenOptions). */
    public get OverlappingSync(): boolean
    {
        return (this.root as unknown as { overlappingSync?: boolean }).overlappingSync === true;
    }

    private constructor(
        private readonly root: RootDatabase,
        private readonly databases: Databases,
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
        };
    }

    public static async Open(path: string, options?: ILmdbOptions): Promise<LmdbStore>
    {
        const spaces = Object.values(Keyspace);
        const root = open(LmdbStore.OpenOptions(path, options));
        const databases = new Map<Keyspace, Database<Buffer, Buffer>>();
        for (const space of spaces)
        {
            databases.set(space, root.openDB<Buffer, Buffer>(space, {
                keyEncoding: LmdbStore.BinaryEncoding,
                encoding: LmdbStore.BinaryEncoding,
            }));
        }
        return new LmdbStore(root, databases);
    }

    public async BeginRead(): Promise<IReadTransaction>
    {
        this.EnsureLive();
        const read = new LmdbReadTransaction(this.databases, this.PinSnapshot(), this.counter, () => this.liveReads.delete(read));
        this.liveReads.add(read);
        return read;
    }

    public Write<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        if (this.disposed)
        {
            return Promise.reject(new Error(LmdbErrors.StoreDisposed));
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
    }

    /** Pins the latest committed state; only the single writer commits, so it is current. */
    private PinSnapshot(): Transaction
    {
        this.root.resetReadTxn();
        return this.root.useReadTransaction();
    }

    private async RunExclusive<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        const txn = new LmdbWriteTransaction(this.databases, this.PinSnapshot(), this.counter);
        try
        {
            const result = await work(txn);
            this.root.transactionSync(() => txn.Apply());
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
            throw new Error(LmdbErrors.StoreDisposed);
        }
    }
}
