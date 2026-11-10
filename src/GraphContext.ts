import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import type { AccessScope } from './access/AccessScope.js';
import { ScopeValidator } from './access/ScopeValidator.js';
import { CatalogStore } from './catalog/CatalogStore.js';
import { ColumnStore } from './columns/ColumnStore.js';
import type { IConnectorApplied } from './connectors/ConnectorApplied.js';
import type { BindingTable } from './connectors/BindingTable.js';
import type { ConnectorError } from './connectors/ConnectorError.js';
import type { IGraphConnector } from './connectors/GraphConnector.js';
import { ConnectorSetup } from './connectors/WriteCoordinator.js';
import { EdgeStore } from './edges/EdgeStore.js';
import { PublicIdIndex } from './identity/PublicIdIndex.js';
import { RowIndex } from './identity/RowIndex.js';
import { IndexStore } from './indexes/IndexStore.js';
import type { IKeyValueStore, IReadTransaction } from './kv/KeyValue.js';
import { CatalogIndex } from './txn/CatalogIndex.js';
import { CommitLog } from './txn/CommitLog.js';
import { Committer } from './txn/Committer.js';
import type { ISnapshotHandle } from './txn/ConflictHistory.js';
import { Signal } from './txn/Signal.js';

/** Something the GraphStore must end when it is disposed (open readers and transactions). */
export interface IGraphDisposable
{
    dispose(): void;
}

/**
 * One reader's consistent view: the KV read transaction, the last commit stored in that KV snapshot and
 * the catalog that snapshot holds. A transaction's view also holds a committer snapshot registration,
 * taken before the KV snapshot (rulings R30, F3); a plain reader's view has none, so long-lived readers
 * never pin conflict history. dispose() releases the KV transaction and any registration; idempotent.
 */
export class ReadSnapshot
{
    private disposed = false;

    public constructor(
        public readonly Txn: IReadTransaction,
        public readonly Handle: ISnapshotHandle | undefined,
        public readonly Commit: bigint,
        public readonly Index: CatalogIndex,
    )
    {
    }

    public dispose(): void
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        this.Txn.dispose();
        this.Handle?.dispose();
    }
}

/**
 * Internal state shared by a GraphStore and its readers: the KV store, the committer (which holds the
 * current catalog), read-side building blocks (stateless across transactions; their caches are keyed
 * by transaction) and the set of open readers. Not part of the public API.
 */
export class GraphContext
{
    private static readonly ErrNoContext = 'The store has no internal context';
    /** Each GraphStore's context, for engine code (GraphEngine) only: the internal channel (P12, final review m6). */
    private static readonly Stores = new WeakMap<object, GraphContext>();

    public readonly Columns = new ColumnStore();
    public readonly Edges = new EdgeStore();
    public readonly Rows = new RowIndex();
    public readonly Ids = new PublicIdIndex();
    public readonly Indexes = new IndexStore(this.Columns, this.Ids);
    /**
     * Raised when reverting a connector call that was still hanging at the write-through timeout failed (ruling R72).
     */
    public readonly ConnectorRevertFailed = new Signal<ConnectorError>();
    /** Raised once per successful write-through, after every participating connector committed (ruling R103). */
    public readonly ConnectorApplied = new Signal<IConnectorApplied>();

    private readonly open = new Set<IGraphDisposable>();
    /** Per scope, the catalog version it was last validated against (ruling R63). */
    private readonly validated = new WeakMap<AccessScope, number>();

    public constructor(public readonly Store: IKeyValueStore, public readonly Committer: Committer)
    {
    }

    /** Registers `store`'s context (the GraphStore constructor). */
    public static Register(store: object, context: GraphContext): void
    {
        GraphContext.Stores.set(store, context);
    }

    /** The context `store` registered; GraphError Internal for an object that registered none. */
    public static Of(store: object): GraphContext
    {
        const context = GraphContext.Stores.get(store);
        if (context === undefined)
        {
            throw new GraphError(GraphErrorCode.Internal, GraphContext.ErrNoContext);
        }
        return context;
    }

    /**
     * Version of the current catalog: the committer's (one source of truth), so a transaction begun from
     * a CommitApplied handler of a schema change or an upgrade already sees the new version.
     */
    public get CatalogVersion(): number
    {
        return this.Committer.Catalog.Version;
    }

    /**
     * The installed bindings and connectors (held by the committer); undefined (every write engine-only) until
     * installed.
     */
    public get Connectors(): ConnectorSetup | undefined
    {
        return this.Committer.Connectors;
    }

    /**
     * Installs the bindings and the connectors they name, for commits that start afterwards (ruling R72).
     * `timeoutMs` bounds each write-through's connector phase (default Committer.DefaultPrepareTimeoutMs).
     * GraphError InvalidArgument when a binding or the default names a connector not given (other than
     * BindingTable.EngineStorage), two connectors share a name, a connector uses the reserved name, or
     * the timeout is not a finite positive number, or the setup changes which nodes are stubs (ruling P19,
     * Committer.SetConnectors). Work routed with the previous setup and not yet
     * applied fails with ConflictError (Committer.InstallConnectors, ruling R77).
     */
    public SetConnectors(bindings: BindingTable, connectors: readonly IGraphConnector[], timeoutMs: number = Committer.DefaultPrepareTimeoutMs): void
    {
        this.Committer.SetConnectors(new ConnectorSetup(bindings, connectors, timeoutMs));
    }

    /**
     * Opens a view. `register` (transactions only, ruling F3): register with the committer FIRST, then
     * open the KV snapshot and read its last commit (ruling R30). Readers open the KV snapshot only.
     */
    public async OpenSnapshot(register: boolean): Promise<ReadSnapshot>
    {
        const handle = register ? this.Committer.RegisterSnapshot() : undefined;
        let txn: IReadTransaction | undefined;
        try
        {
            txn = await this.Store.BeginRead();
            const commit = await CommitLog.ReadLastCommit(txn);
            const index = await this.IndexFor(txn);
            return new ReadSnapshot(txn, handle, commit, index);
        }
        catch (error)
        {
            txn?.dispose();
            handle?.dispose();
            throw error;
        }
    }

    /** Validates the scope's names against `index` once per (scope, catalog version); see ScopeValidator. */
    public ValidateScope(scope: AccessScope, index: CatalogIndex): void
    {
        if (this.validated.get(scope) === index.Catalog.Version)
        {
            return;
        }
        ScopeValidator.Validate(scope, index);
        this.validated.set(scope, index.Catalog.Version);
    }

    public Track(reader: IGraphDisposable): void
    {
        this.open.add(reader);
    }

    public Forget(reader: IGraphDisposable): void
    {
        this.open.delete(reader);
    }

    public DisposeReaders(): void
    {
        for (const reader of [...this.open])
        {
            reader.dispose();
        }
    }

    /** The catalog stored in the transaction's snapshot: the current one, or loaded when the snapshot predates it. */
    private async IndexFor(txn: IReadTransaction): Promise<CatalogIndex>
    {
        const current = this.Committer.Index;
        if ((await CatalogStore.StoredVersion(txn)) === current.Catalog.Version)
        {
            return current;
        }
        return new CatalogIndex(await CatalogStore.Load(txn));
    }
}
