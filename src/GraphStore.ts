import { CatalogModel } from './catalog/CatalogModel.js';
import type { CatalogSnapshot } from './catalog/CatalogSnapshot.js';
import { CatalogStore } from './catalog/CatalogStore.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import { FormatMeta } from './format/FormatMeta.js';
import { GraphContext } from './GraphContext.js';
import { GraphReader } from './GraphReader.js';
import { GraphTransaction } from './GraphTransaction.js';
import type { IKeyValueStore, IReadTransaction, IWriteTransaction } from './kv/KeyValue.js';
import { Keyspace } from './kv/Keyspace.js';
import { LmdbStore } from './kv/lmdb/LmdbStore.js';
import { MemoryStore } from './kv/memory/MemoryStore.js';
import { Committer, type ICommitApplied } from './txn/Committer.js';
import { type ISignal, SignalView } from './txn/Signal.js';

/**
 * The embedding API of the graph engine: one graph over one durable (LMDB) or in-memory store.
 *
 * Define the schema with DefineSchema, read with BeginRead (a snapshot), write with Begin (an
 * optimistic, serializable transaction) and listen to CommitApplied for every applied commit, in order.
 * A commit is durable once its Commit() promise resolves. dispose() waits for a commit already being
 * written, ends open readers and transactions, and closes the store.
 */
export class GraphStore
{
    private static readonly ErrDisposed = 'Graph store has been disposed';
    /** Covers every tuple-encoded key (type codes are below 0xFF). */
    private static readonly AnyKey = { Start: Uint8Array.of(0x00), End: Uint8Array.of(0xff) };
    private static readonly FirstOnly = { Limit: 1 };

    /** Raised once per applied commit, in commit order, after the commit is durable. Subscribe-only. */
    public readonly CommitApplied: ISignal<ICommitApplied>;

    private disposing: Promise<void> | undefined;

    private constructor(private readonly context: GraphContext)
    {
        this.CommitApplied = new SignalView(context.Committer.CommitApplied);
    }

    /** Opens (creating when absent) the LMDB environment in directory `path`. */
    public static async OpenLmdb(path: string): Promise<GraphStore>
    {
        return GraphStore.Open(await LmdbStore.Open(path));
    }

    /** A fresh graph that lives only in memory. */
    public static async OpenMemory(): Promise<GraphStore>
    {
        return GraphStore.Open(new MemoryStore());
    }

    /**
     * Extends the stored schema: `define` receives a model holding every existing definition (with its
     * stable ids) and adds new ones. Validated and saved atomically; a failure (CatalogError) leaves the
     * schema unchanged. Transactions begun before the change fail Commit with ConflictError.
     */
    public async DefineSchema(define: (model: CatalogModel) => void): Promise<void>
    {
        this.RequireLive();
        const snapshot = await this.context.Store.Write(async txn => GraphStore.Evolve(txn, define));
        this.context.SetCatalog(snapshot);
    }

    /** A read-only snapshot of the latest commit. */
    public async BeginRead(): Promise<GraphReader>
    {
        this.RequireLive();
        const reader = new GraphReader(this.context, await this.context.OpenSnapshot(false));
        return this.Handed(reader);
    }

    /** A read-write transaction over a snapshot of the latest commit. */
    public async Begin(): Promise<GraphTransaction>
    {
        this.RequireLive();
        const txn = new GraphTransaction(this.context, await this.context.OpenSnapshot(true));
        return this.Handed(txn);
    }

    /** Ruling R32: waits for the committer's in-flight group, ends open readers, closes the store. Idempotent. */
    public dispose(): Promise<void>
    {
        this.disposing ??= this.Teardown();
        return this.disposing;
    }

    /** Ruling R32: format check (or initialization of an empty store), catalog load, committer resume. */
    private static async Open(store: IKeyValueStore): Promise<GraphStore>
    {
        try
        {
            await store.Write(txn => GraphStore.CheckFormat(txn));
            const read = await store.BeginRead();
            let catalog: CatalogSnapshot;
            try
            {
                catalog = await CatalogStore.Load(read);
            }
            finally
            {
                read.dispose();
            }
            const committer = await Committer.Open(store, catalog);
            return new GraphStore(new GraphContext(store, committer, catalog));
        }
        catch (error)
        {
            await store.dispose();
            throw error;
        }
    }

    private static async CheckFormat(txn: IWriteTransaction): Promise<void>
    {
        if (await GraphStore.IsEmpty(txn))
        {
            await FormatMeta.Initialize(txn);
            return;
        }
        await FormatMeta.Verify(txn);
    }

    private static async IsEmpty(txn: IReadTransaction): Promise<boolean>
    {
        for (const space of Object.values(Keyspace))
        {
            for await (const _ of txn.Scan(space, GraphStore.AnyKey, GraphStore.FirstOnly))
            {
                return false;
            }
        }
        return true;
    }

    private static async Evolve(txn: IWriteTransaction, define: (model: CatalogModel) => void): Promise<CatalogSnapshot>
    {
        const model = CatalogModel.FromSnapshot(await CatalogStore.Load(txn));
        define(model);
        const sealed = model.Seal();
        await CatalogStore.Save(txn, sealed);
        return sealed;
    }

    /** A reader created while dispose() started is ended at once rather than handed out. */
    private Handed<T extends GraphReader>(reader: T): T
    {
        if (this.disposing !== undefined)
        {
            reader.dispose();
            throw new GraphError(GraphErrorCode.Disposed, GraphStore.ErrDisposed);
        }
        return reader;
    }

    private RequireLive(): void
    {
        if (this.disposing !== undefined)
        {
            throw new GraphError(GraphErrorCode.Disposed, GraphStore.ErrDisposed);
        }
    }

    private async Teardown(): Promise<void>
    {
        await this.context.Committer.dispose();
        this.context.DisposeReaders();
        await this.context.Store.dispose();
    }
}
