import type { AccessScope } from './access/AccessScope.js';
import type { CatalogSnapshot } from './catalog/CatalogSnapshot.js';
import { BindingTable } from './connectors/BindingTable.js';
import type { ConnectorError } from './connectors/ConnectorError.js';
import type { IGraphConnector } from './connectors/GraphConnector.js';
import { ConnectorSetup } from './connectors/WriteCoordinator.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import type { GraphReader } from './GraphReader.js';
import { GraphStore } from './GraphStore.js';
import type { GraphTransaction } from './GraphTransaction.js';
import type { ILmdbOptions } from './kv/lmdb/LmdbStore.js';
import type { ISchemaDescription } from './schema/SchemaDescription.js';
import { Committer, type IUpgradeCommit } from './txn/Committer.js';
import type { ICommitApplied } from './txn/LogEntry.js';
import type { ISignal } from './txn/Signal.js';

/** Where a GraphEngine keeps its graph. */
export enum StorageKind
{
    /** In memory only; gone at dispose. */
    Memory = 1,
    /** A durable LMDB environment in the directory IEngineStorage.Path. */
    Lmdb = 2,
}

export interface IEngineStorage
{
    readonly Kind: StorageKind;
    /** Lmdb: the environment's directory (required). Ignored for Memory. */
    readonly Path?: string;
    /** Lmdb: environment options. Ignored for Memory. */
    readonly Lmdb?: ILmdbOptions;
}

export interface IGraphEngineOptions
{
    /** The schema the engine runs: the store is upgraded to it at Open. Its Bindings route writes to Connectors. */
    readonly Description: ISchemaDescription;
    readonly Storage: IEngineStorage;
    /** The connectors bindings name; unique names, none named BindingTable.EngineStorage. Fixed for the engine's life. */
    readonly Connectors?: readonly IGraphConnector[];
    /** Bounds the connector phase of each write-through (default Committer.DefaultPrepareTimeoutMs). */
    readonly PrepareTimeoutMs?: number;
}

/**
 * The single entry point hosts use (spec §4.2, §9): one graph, run from a schema description.
 *
 * Open checks the description's bindings against the connectors (before storage is touched), opens or
 * creates the store, upgrades it to the description (nothing happens, and nothing is raised, when the
 * stored schema version and catalog already match), installs the bindings and is then running. Read with
 * BeginRead, write with Begin (both under an AccessScope), follow commits on CommitApplied / ReadChanges.
 * Upgrade applies a new description while running (a dev recompile); the connectors are those given at
 * Open, so a new description may only bind to them. SchemaVersion and Catalog reflect the latest
 * committed state. dispose() closes the store.
 *
 * GraphStore remains the low-level store underneath; the engine never uses GraphStore.DefineSchema.
 */
export class GraphEngine
{
    private static readonly ErrNoPath = 'LMDB storage needs a Path';
    private static readonly ErrKind = 'Unknown StorageKind: ';

    /** Raised once per applied commit, in commit order, after the commit is durable. Subscribe-only. */
    public readonly CommitApplied: ISignal<ICommitApplied>;
    /**
     * Raised when reverting a connector after a failed write-through could only finish after the caller
     * was answered, and failed (ruling R72): the last place such a failure can be reported.
     */
    public readonly ConnectorRevertFailed: ISignal<ConnectorError>;

    private version: string;
    private catalog: CatalogSnapshot;
    /** Upgrades run one at a time, so bindings are installed in the order their upgrades committed. */
    private upgrading: Promise<unknown> = Promise.resolve();

    private constructor(
        private readonly store: GraphStore,
        private readonly connectors: readonly IGraphConnector[],
        private readonly timeoutMs: number,
        description: ISchemaDescription,
        result: IUpgradeCommit,
    )
    {
        this.CommitApplied = store.CommitApplied;
        this.ConnectorRevertFailed = store.ConnectorRevertFailed;
        this.version = description.Version;
        this.catalog = result.Catalog;
    }

    /**
     * Opens the engine (see the class comment). GraphError InvalidArgument, before storage is touched,
     * for a binding or DefaultConnector naming a connector not given (other than
     * BindingTable.EngineStorage), duplicate or reserved connector names, a bad PrepareTimeoutMs, an
     * unknown StorageKind or LMDB without a Path. A failure opening the store (Locked, Unsupported,
     * Corrupt) is rethrown; an upgrade failure (CatalogError, CommitError) closes the store and is rethrown.
     */
    public static async Open(options: IGraphEngineOptions): Promise<GraphEngine>
    {
        const connectors = [...(options.Connectors ?? [])];
        const timeoutMs = options.PrepareTimeoutMs ?? Committer.DefaultPrepareTimeoutMs;
        const bindings = GraphEngine.Bindings(options.Description, connectors, timeoutMs);
        const store = await GraphEngine.OpenStore(options.Storage);
        try
        {
            const result = await store.Upgrade(options.Description);
            store.SetConnectors(bindings, connectors, timeoutMs);
            return new GraphEngine(store, connectors, timeoutMs, options.Description, result);
        }
        catch (error)
        {
            await store.dispose();
            throw error;
        }
    }

    /** The Version of the description the engine last applied. */
    public get SchemaVersion(): string
    {
        return this.version;
    }

    /** The catalog in force after the latest committed upgrade. */
    public get Catalog(): CatalogSnapshot
    {
        return this.catalog;
    }

    /**
     * Hot upgrade (a dev recompile): upgrades the store to `description` (GraphStore.Upgrade: plan,
     * discard, seed, one commit) and, once that has committed, replaces the bindings with the
     * description's, for commits that start afterwards. GraphError InvalidArgument, before anything is
     * upgraded, when the new bindings name a connector not given at Open. A failed upgrade leaves the
     * schema, SchemaVersion, Catalog and bindings as they were. Concurrent calls run in call order.
     */
    public Upgrade(description: ISchemaDescription): Promise<IUpgradeCommit>
    {
        const run = this.upgrading.then(() => this.RunUpgrade(description));
        this.upgrading = run.catch(() => undefined);
        return run;
    }

    /** A read-only snapshot of the latest commit under `scope` (GraphStore.BeginRead). */
    public BeginRead(scope: AccessScope): Promise<GraphReader>
    {
        return this.store.BeginRead(scope);
    }

    /** A read-write transaction under `scope` (GraphStore.Begin); writes are gated by the scope's write rules. */
    public Begin(scope: AccessScope): Promise<GraphTransaction>
    {
        return this.store.Begin(scope);
    }

    /** Every commit after `afterCommit`, in commit order (GraphStore.ReadChanges). */
    public ReadChanges(afterCommit: bigint): AsyncIterable<ICommitApplied>
    {
        return this.store.ReadChanges(afterCommit);
    }

    /** Closes the store (GraphStore.dispose). Idempotent; later calls reject with GraphError Disposed. */
    public dispose(): Promise<void>
    {
        return this.store.dispose();
    }

    private async RunUpgrade(description: ISchemaDescription): Promise<IUpgradeCommit>
    {
        const bindings = GraphEngine.Bindings(description, this.connectors, this.timeoutMs);
        const result = await this.store.Upgrade(description);
        this.store.SetConnectors(bindings, this.connectors, this.timeoutMs);
        this.version = description.Version;
        this.catalog = result.Catalog;
        return result;
    }

    /** The description's binding table, checked against `connectors` and the timeout (ConnectorSetup) without installing it. */
    private static Bindings(description: ISchemaDescription, connectors: readonly IGraphConnector[], timeoutMs: number): BindingTable
    {
        const bindings = new BindingTable(description.Bindings, description.DefaultConnector);
        new ConnectorSetup(bindings, connectors, timeoutMs);
        return bindings;
    }

    private static OpenStore(storage: IEngineStorage): Promise<GraphStore>
    {
        switch (storage.Kind)
        {
            case StorageKind.Memory:
                return GraphStore.OpenMemory();
            case StorageKind.Lmdb:
                if (storage.Path === undefined || storage.Path.length === 0)
                {
                    return Promise.reject(new GraphError(GraphErrorCode.InvalidArgument, GraphEngine.ErrNoPath));
                }
                return GraphStore.OpenLmdb(storage.Path, storage.Lmdb);
            default:
                return Promise.reject(new GraphError(GraphErrorCode.InvalidArgument, GraphEngine.ErrKind + String(storage.Kind)));
        }
    }
}
