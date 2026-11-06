import { AccessScope } from './access/AccessScope.js';
import { CatalogModel } from './catalog/CatalogModel.js';
import type { CatalogSnapshot } from './catalog/CatalogSnapshot.js';
import { CatalogStore } from './catalog/CatalogStore.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import { FormatMeta } from './format/FormatMeta.js';
import { GraphContext, type ReadSnapshot } from './GraphContext.js';
import { GraphReader } from './GraphReader.js';
import { GraphTransaction } from './GraphTransaction.js';
import type { IKeyValueStore, IReadTransaction, IWriteTransaction } from './kv/KeyValue.js';
import { Keyspace } from './kv/Keyspace.js';
import { type ILmdbOptions, LmdbStore } from './kv/lmdb/LmdbStore.js';
import { MemoryStore } from './kv/memory/MemoryStore.js';
import { CommitLog } from './txn/CommitLog.js';
import { Committer, type ICommitApplied, type IUpgradeCommit } from './txn/Committer.js';
import type { ISchemaDescription } from './schema/SchemaDescription.js';
import { type ISignal, SignalView } from './txn/Signal.js';

/**
 * The embedding API of the graph engine: one graph over one durable (LMDB) or in-memory store.
 *
 * Define the schema with DefineSchema, read with BeginRead (a snapshot), write with Begin (an
 * optimistic, serializable transaction) and listen to CommitApplied for every applied commit, in order.
 * Both take the AccessScope their reads are enforced under (AccessScope.System sees everything).
 * A commit is durable once its Commit() promise resolves. dispose() waits for a commit already being
 * written, ends open readers and transactions, and closes the store.
 */
export class GraphStore
{
    private static readonly ErrDisposed = 'Graph store has been disposed';
    private static readonly ErrAfterCommit = 'afterCommit must be non-negative: ';
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

    /**
     * Opens (creating when absent) the LMDB environment in directory `path`, with optional MapSizeBytes
     * and MaxReaders. The directory is locked for this store until dispose: opening it again (in this or
     * another live process) fails with GraphError Locked.
     */
    public static async OpenLmdb(path: string, options?: ILmdbOptions): Promise<GraphStore>
    {
        return GraphStore.Open(await LmdbStore.Open(path, options));
    }

    /** A fresh graph that lives only in memory. */
    public static async OpenMemory(): Promise<GraphStore>
    {
        return GraphStore.Open(new MemoryStore());
    }

    /**
     * Extends the stored schema: `define` receives a model holding every existing definition (with its
     * stable ids) and adds new ones. The change is a commit (ruling F4): it runs after every commit
     * submitted before it, gets a commit number, is logged and raised on CommitApplied, and resolves with
     * that number. A failure (CatalogError) leaves the schema unchanged. Transactions begun before the
     * change fail Commit with ConflictError.
     */
    public async DefineSchema(define: (model: CatalogModel) => void): Promise<bigint>
    {
        this.RequireLive();
        const result = await this.context.Committer.SubmitSchema(define);
        this.context.SetCatalog(result.Catalog);
        return result.Commit;
    }

    /**
     * Internal (the schema-description loader is its caller): upgrades the stored schema to `description`.
     * The catalog is planned against the current one (CatalogPlanner); data that no longer fits is
     * discarded in the same commit, which is logged as an Upgrade entry and raised on CommitApplied. The
     * description's seed is then applied in the same write (seed wins for seeded nodes, spec 4.3) and,
     * when it changed anything, logged and raised as the next Batch commit (SeedCommit). An unchanged
     * catalog with a new Version and an unchanged seed only records the version (Changed false, no
     * commit). A planning failure (CatalogError) or seed failure (CommitError) leaves the store
     * unchanged. Transactions begun before a changing upgrade fail Commit with ConflictError.
     */
    public async Upgrade(description: ISchemaDescription): Promise<IUpgradeCommit>
    {
        this.RequireLive();
        const result = await this.context.Committer.SubmitUpgrade(description);
        this.context.SetCatalog(result.Catalog);
        return result;
    }

    /** The Version of the description the last upgrade applied (Meta("schemaVersion")); undefined before any. */
    public async SchemaVersion(): Promise<string | undefined>
    {
        this.RequireLive();
        const txn = await this.context.Store.BeginRead();
        try
        {
            return await FormatMeta.ReadSchemaVersion(txn);
        }
        finally
        {
            txn.dispose();
        }
    }

    /**
     * The changefeed (seam 7, ruling F4): every commit after `afterCommit`, in commit order, read from the
     * log in one snapshot taken when iteration starts. Each entry is self-sufficient for replay: batches
     * carry the catalog version they were applied against and their created internal ids; schema changes
     * carry the complete resulting catalog; upgrades also carry the schema version (their discard follows
     * from the previous and the resulting catalog, ruling R51). Ending the iteration early releases the snapshot.
     */
    public async *ReadChanges(afterCommit: bigint): AsyncIterable<ICommitApplied>
    {
        this.RequireLive();
        if (afterCommit < 0n)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, GraphStore.ErrAfterCommit + afterCommit);
        }
        const txn = await this.context.Store.BeginRead();
        try
        {
            yield* new CommitLog().Scan(txn, afterCommit);
        }
        finally
        {
            txn.dispose();
        }
    }

    /**
     * A read-only snapshot of the latest commit, read under `scope`. GraphError InvalidArgument when the
     * scope names a concept, aspect or hidden member the snapshot's catalog does not have (ruling R63).
     */
    public async BeginRead(scope: AccessScope): Promise<GraphReader>
    {
        this.RequireLive();
        const reader = new GraphReader(this.context, this.Scoped(await this.context.OpenSnapshot(false), scope), scope);
        return this.Handed(reader);
    }

    /**
     * A read-write transaction over a snapshot of the latest commit, reading under `scope` (validated as
     * for BeginRead; writes are not gated by it yet).
     */
    public async Begin(scope: AccessScope): Promise<GraphTransaction>
    {
        this.RequireLive();
        const txn = new GraphTransaction(this.context, this.Scoped(await this.context.OpenSnapshot(true), scope), scope);
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

    /** The snapshot, once `scope` is validated against its catalog (System needs none); released when invalid. */
    private Scoped(snapshot: ReadSnapshot, scope: AccessScope): ReadSnapshot
    {
        if (scope === AccessScope.System)
        {
            return snapshot;
        }
        try
        {
            this.context.ValidateScope(scope, snapshot.Index.Catalog);
        }
        catch (error)
        {
            snapshot.dispose();
            throw error;
        }
        return snapshot;
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
