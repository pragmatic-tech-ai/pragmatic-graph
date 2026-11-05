import { open, RootDatabase, Database, Transaction } from 'lmdb';
import { TupleCodec } from '../../format/TupleCodec.js';
import { IKeyRange, IKeyValueStore, IReadTransaction, IWriteTransaction } from '../KeyValue.js';
import { Keyspace } from '../Keyspace.js';

export interface ILmdbOptions
{
    MapSizeBytes?: number;
}

type Databases = ReadonlyMap<Keyspace, Database<Buffer, Buffer>>;

interface IChange
{
    readonly Key: Uint8Array;
    readonly Value: Uint8Array | null;
}

class LmdbErrors
{
    public static readonly StoreDisposed = 'Store has been disposed';
    public static readonly TxnDisposed = 'Transaction has been disposed';
    public static readonly EmptyKey = 'Empty keys are not supported';
}

class LmdbKeys
{
    private static readonly HexEncoding = 'hex';

    public static Hex(key: Uint8Array): string
    {
        return Buffer.from(key).toString(LmdbKeys.HexEncoding);
    }

    public static Require(key: Uint8Array): void
    {
        if (key.length === 0)
        {
            throw new Error(LmdbErrors.EmptyKey);
        }
    }

    /** Merges pending changes over base entries (both already restricted to one range), in key order. */
    public static Merge(base: [Uint8Array, Uint8Array][], changes: Iterable<IChange>): [Uint8Array, Uint8Array][]
    {
        const merged = new Map<string, [Uint8Array, Uint8Array]>();
        for (const pair of base)
        {
            merged.set(LmdbKeys.Hex(pair[0]), pair);
        }
        for (const change of changes)
        {
            const hex = LmdbKeys.Hex(change.Key);
            if (change.Value === null)
            {
                merged.delete(hex);
            }
            else
            {
                merged.set(hex, [change.Key, change.Value]);
            }
        }
        return [...merged.values()].sort((a, b) => TupleCodec.Compare(a[0], b[0]));
    }
}

class LmdbReadTransaction implements IReadTransaction
{
    protected disposed = false;

    public constructor(
        protected readonly databases: Databases,
        protected readonly snapshot: Transaction,
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
            yield pair;
        }
    }

    public dispose(): void
    {
        if (!this.disposed)
        {
            this.disposed = true;
            this.snapshot.done();
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
        const value = this.Db(space).getBinary(Buffer.from(key), { transaction: this.snapshot });
        return value === undefined ? undefined : Uint8Array.from(value);
    }

    /** Lazily reads copies of the snapshot entries in range, in key order. */
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
    /** Pending changes per keyspace, keyed by hex of the key; a null value is a delete. */
    private readonly pending = new Map<Keyspace, Map<string, IChange>>();

    public override async Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>
    {
        this.EnsureLive();
        LmdbKeys.Require(key);
        const staged = this.pending.get(space)?.get(LmdbKeys.Hex(key));
        if (staged !== undefined)
        {
            return staged.Value === null ? undefined : staged.Value.slice();
        }
        return this.Lookup(space, key);
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
        // A staged delete may hide base entries, so the base is read unlimited before merging.
        const merged = LmdbKeys.Merge([...this.Entries(space, range)], inRange);
        const count = limit === undefined ? merged.length : Math.min(limit, merged.length);
        for (let i = 0; i < count; i++)
        {
            const pair = merged[i] as [Uint8Array, Uint8Array];
            yield [pair[0].slice(), pair[1].slice()];
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

    /** Applies every staged change; call inside the environment's synchronous write transaction. */
    public Apply(): void
    {
        for (const [space, bucket] of this.pending)
        {
            const db = this.Db(space);
            for (const change of bucket.values())
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
        let bucket = this.pending.get(space);
        if (bucket === undefined)
        {
            bucket = new Map();
            this.pending.set(space, bucket);
        }
        const copy = key.slice();
        bucket.set(LmdbKeys.Hex(copy), { Key: copy, Value: value });
    }
}

/** Durable ordered key-value store on one LMDB environment (one named database per keyspace). */
export class LmdbStore implements IKeyValueStore
{
    private static readonly DefaultMapSizeBytes = 16 * 1024 * 1024 * 1024;
    private static readonly BinaryEncoding = 'binary';

    private tail: Promise<unknown> = Promise.resolve();
    private disposed = false;

    private constructor(
        private readonly root: RootDatabase,
        private readonly databases: Databases,
    )
    {
    }

    public static async Open(path: string, options?: ILmdbOptions): Promise<LmdbStore>
    {
        const spaces = Object.values(Keyspace);
        const root = open({
            path,
            mapSize: options?.MapSizeBytes ?? LmdbStore.DefaultMapSizeBytes,
            maxDbs: spaces.length,
            keyEncoding: LmdbStore.BinaryEncoding,
            encoding: LmdbStore.BinaryEncoding,
        });
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
        return new LmdbReadTransaction(this.databases, this.PinSnapshot());
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
        this.disposed = true;
        await this.tail;
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
        const txn = new LmdbWriteTransaction(this.databases, this.PinSnapshot());
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
