import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { ConnectorContext } from './ConnectorContext.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { CatalogIndex } from '../txn/CatalogIndex.js';
import type { PreparedCommit } from '../txn/PreparedCommit.js';
import type { Signal } from '../txn/Signal.js';
import { type BatchOp, WriteBatch } from '../txn/WriteBatch.js';
import { BindingTable } from './BindingTable.js';
import { Compensator, type IBegunConnector, type ICompensation, type IExecutedStep, type IHungCall } from './Compensator.js';
import { ConnectorOutcome, type IConnectorApplied } from './ConnectorApplied.js';
import { type ConnectorChange, ConnectorChangeSet } from './ConnectorChangeSet.js';
import { ConnectorError, ConnectorPhase } from './ConnectorError.js';
import { VersionLedger } from './FetchSession.js';
import { ConnectorResidency, type IExternalConnector, type RowVersion } from './FetchContract.js';
import type { IAssignedCreate, IAssignedOutcome, IConnectorApplyResult, IConnectorTransaction, IGraphConnector } from './GraphConnector.js';
import { type IRoutedStep, StepRouter } from './StepRouter.js';

/** The owner (model, '' for none) and concept a write routes by. */
export interface INodeOrigin
{
    readonly Owner: string;
    readonly Concept: string;
    /** True when the node is not stored and the origin is that of the row the transaction fetched for it (R103). */
    readonly Fetched?: boolean;
}

/** What WriteCoordinator.Route makes of one batch (the one-shot form of a single step). */
export interface IRoutedBatch
{
    /** Per participating connector, its change set (in batch op order), keyed in connector-name order. */
    readonly Sets: ReadonlyMap<string, ConnectorChangeSet>;
    /** The part of the batch engine storage applies, in batch order: everything but the ops on external nodes (R103). */
    readonly Engine: WriteBatch;
}

/** One stored edge, by the public ids of its source and target. */
export interface IIncidentEdge
{
    readonly From: string;
    readonly Relationship: string;
    readonly To: string;
}

/**
 * Where routing looks up nodes the batch does not create: the transaction's snapshot (recorded reads), else the rows the
 * transaction fetched from External connectors.
 */
export interface INodeOrigins
{
    /** The stored node's origin, else the fetched row's (Fetched set), else undefined. */
    Origin(publicId: string): Promise<INodeOrigin | undefined>;
    /** The version of the row the transaction fetched for the id (R119 V1), else undefined. */
    Version(publicId: string): RowVersion | undefined;
    /**
     * Every edge of the live node, unscoped, outgoing (effective relationships in declaration order) then
     * incoming (IncomingRelationships order), each in stored edge order; none when there is no such node.
     * A self-loop appears in both directions.
     */
    Edges(publicId: string): Promise<readonly IIncidentEdge[]>;
}

/** The connectors installed on a store, by name, with the bindings that route to them (GraphContext.SetConnectors). */
export class ConnectorSetup
{
    private static readonly ErrUnknown = 'A binding names a connector that is not installed: ';
    private static readonly ErrDuplicate = 'Two installed connectors share the name: ';
    private static readonly ErrReserved = 'A connector cannot use the reserved name: ';
    private static readonly ErrExternalDefault = 'An external connector cannot be the DefaultConnector: ';
    private static readonly ErrExternalContract = 'An external connector needs Capabilities and Fetch: ';
    private static readonly ErrTimeout = 'Connector timeout must be a finite positive number of milliseconds: ';

    public readonly Connectors: ReadonlyMap<string, IGraphConnector>;
    /** Names of the installed connectors whose Residency is External (ruling R96). */
    public readonly External: ReadonlySet<string>;

    public constructor(public readonly Bindings: BindingTable, connectors: readonly IGraphConnector[], public readonly TimeoutMs: number)
    {
        if (!Number.isFinite(TimeoutMs) || TimeoutMs <= 0)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrTimeout + TimeoutMs);
        }
        const byName = new Map<string, IGraphConnector>();
        for (const c of connectors)
        {
            if (c.Name === BindingTable.EngineStorage)
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrReserved + c.Name);
            }
            if (byName.has(c.Name))
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrDuplicate + c.Name);
            }
            ConnectorSetup.CheckResidency(c);
            byName.set(c.Name, c);
        }
        if (Bindings.DefaultConnector !== undefined && byName.get(Bindings.DefaultConnector)?.Residency === ConnectorResidency.External)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrExternalDefault + Bindings.DefaultConnector);
        }
        for (const name of Bindings.ConnectorNames())
        {
            if (name !== BindingTable.EngineStorage && !byName.has(name))
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrUnknown + name);
            }
        }
        this.Connectors = byName;
        this.External = new Set([...byName.values()].filter(c => c.Residency === ConnectorResidency.External).map(c => c.Name));
    }

    /**
     * True when a node of `concept` held by `owner` resolves to an installed External connector: it is a stub (ruling
     * R102), its data lives only in the connector. The one "resolves to External" rule (BindingTable.IsStub over External).
     */
    public IsStub(owner: string, concept: string, catalog: CatalogSnapshot): boolean
    {
        return this.External.size > 0 && this.Bindings.IsStub(owner, concept, catalog, this.External);
    }

    /** The installed External connectors by name (ruling R96): what a FetchSession fetches from. */
    public ExternalConnectors(): ReadonlyMap<string, IExternalConnector>
    {
        const out = new Map<string, IExternalConnector>();
        for (const name of this.External)
        {
            out.set(name, this.Connectors.get(name) as IExternalConnector);
        }
        return out;
    }

    /** An External connector must implement the fetch contract (ruling R96). */
    private static CheckResidency(connector: IGraphConnector): void
    {
        if (connector.Residency !== ConnectorResidency.External)
        {
            return;
        }
        const external = connector as Partial<IExternalConnector>;
        if (typeof external.Fetch !== 'function' || typeof external.Capabilities !== 'object' || external.Capabilities === null)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrExternalContract + connector.Name);
        }
    }

    /**
     * True when `other` routes every write exactly as this setup does: the same binding table (bindings
     * and DefaultConnector, BindingTable.SameAs) and, per name, the same connector object. The timeout is
     * not compared: it bounds a write-through but does not route it.
     */
    public RoutesLike(other: ConnectorSetup): boolean
    {
        if (!this.Bindings.SameAs(other.Bindings) || this.Connectors.size !== other.Connectors.size)
        {
            return false;
        }
        for (const [name, connector] of this.Connectors)
        {
            if (other.Connectors.get(name) !== connector)
            {
                return false;
            }
        }
        return true;
    }
}

/**
 * Write-through of one GraphTransaction (spec §6, rulings R72, R135). With External connectors installed, writes
 * execute in steps: `Step` runs a step's External change sets now (the connector is begun at its first step and kept
 * for the transaction's life, ruling R135 E2), while Mirrored change sets stage. `Run` then commits at the end:
 * Prepare (engine) → each Mirrored connector Begin/Apply/Commit → Finalize (engine) → each begun External connector
 * Commit (finalize, dropping before-images, no remote effect). The engine commits BEFORE external finalize so a failed
 * Finalize/Release still leaves the external step log intact for compensation (ruling R137 E6); external finalize, being
 * remote-effect-free, runs last and infallibly. Calls run one at a time, never inside a store.Write.
 * One deadline (the setup's timeout) bounds each step, and bounds Prepare / every connector call / the reverts of
 * Run, each from its own start. On any failure or the timeout the prepared commit is aborted and every connector that
 * began is compensated, in reverse order (Mirrored reverted in reverse Begin order, then the external step log walked
 * in reverse with Undo, ruling R137 E6, via the Compensator); the caller then gets a ConnectorError, its phase Write
 * for a failed step. ConnectorApplied is raised once, at the transaction's end, carrying the outcome (Committed on a
 * successful commit, else Compensated / CompensationFailed; a throwing subscriber is ignored). Compensation is driven
 * by Compensate, called from the GraphTransaction on a failed step, a commit failure, an Abort or a drop.
 */
export class WriteCoordinator
{
    private static readonly ErrTimedOut = 'Write-through timed out after ms: ';
    private static readonly ErrNoCreate = 'The connector does not implement source-keyed creates (Create): ';
    private static readonly TimedOut: unique symbol = Symbol('TimedOut');
    private static readonly NoExternal: ReadonlySet<string> = new Set();

    /** The External connector transactions begun so far, kept for the transaction's life (ruling R135 E2). */
    private readonly externalTxns = new Map<string, IConnectorTransaction>();
    /** The External steps executed, in order, for the Compensator to undo (ruling R137 E6). */
    private readonly log: IExecutedStep[] = [];
    /** The Mirrored connector transactions begun at Commit, in Begin order, for the Compensator to revert. */
    private readonly mirroredBegun: IBegunConnector[] = [];
    /** Per participating connector, the concepts its changes touched, for ConnectorApplied. */
    private readonly participated = new Map<string, Set<string>>();
    /** Set once compensation has run: ConnectorApplied and the connector reverts happen exactly once (ruling R138 E7). */
    private compensated = false;
    private lastOutcome: ConnectorOutcome = ConnectorOutcome.Compensated;
    private appliedRaised = false;
    private expired = false;
    private deadline: Promise<typeof WriteCoordinator.TimedOut> = new Promise(() => undefined);
    private timer: ReturnType<typeof setTimeout> | undefined;
    private hung: IHungCall | undefined;
    /** The connector call last started, for wrapping a non-connector error should one ever escape. */
    private current: { readonly Connector: string; readonly Phase: ConnectorPhase } = { Connector: BindingTable.EngineStorage, Phase: ConnectorPhase.Prepare };

    public constructor(private readonly setup: ConnectorSetup, private readonly lateFailures: Signal<ConnectorError>, private readonly applied: Signal<IConnectorApplied>, private readonly context: ConnectorContext, private readonly ledger: VersionLedger = new VersionLedger())
    {
    }

    /**
     * Per participating connector (External and Mirrored alike), its change set and the engine's part of the batch,
     * routed as one step through a fresh StepRouter (the one-shot form for callers that do not drive steps, e.g. tests).
     * See StepRouter for the routing rules (R89, R103).
     */
    public static async Route(batch: WriteBatch, table: BindingTable, index: CatalogIndex, origins: INodeOrigins, external: ReadonlySet<string> = WriteCoordinator.NoExternal): Promise<IRoutedBatch>
    {
        const step = await new StepRouter(table, index, origins, external).Route(batch.Ops());
        const engine = new WriteBatch();
        for (const op of step.Engine)
        {
            engine.Append(op);
        }
        const sets = new Map<string, ConnectorChangeSet>();
        for (const [name, set] of step.External)
        {
            sets.set(name, set);
        }
        for (const [name, changes] of step.Mirrored)
        {
            sets.set(name, new ConnectorChangeSet(changes));
        }
        const ordered = new Map<string, ConnectorChangeSet>();
        for (const name of [...sets.keys()].sort())
        {
            ordered.set(name, sets.get(name)!);
        }
        return { Sets: ordered, Engine: engine };
    }

    /** The External steps executed so far, in order (the Compensator consumes them; ruling R137 E6). */
    public get Steps(): readonly IExecutedStep[]
    {
        return this.log;
    }

    /** The number of external steps executed: the dropped-transaction error's Steps (ruling R137 E6). */
    public get ExecutedSteps(): number
    {
        return this.log.length;
    }

    /** True once at least one connector (External or Mirrored) took part: whether the end raises ConnectorApplied. */
    public get Participated(): boolean
    {
        return this.participated.size > 0;
    }

    /**
     * Executes a step's External change sets now (ruling R135 E2), one connector at a time in name order. A connector
     * is begun at its first step and reused after; each step is logged (before its Apply, so the connector has recorded
     * for Undo whatever it applies) and each Apply reports what the source assigned (ignored until the version ledger,
     * E5). On any failure or the timeout a ConnectorError of phase Write is thrown; the GraphTransaction then calls
     * Compensate (ruling R137 E6). This method does not compensate or revert on its own.
     */
    public async Step(external: ReadonlyMap<string, ConnectorChangeSet>, stepNumber: number): Promise<void>
    {
        if (external.size === 0)
        {
            return;
        }
        this.Arm();
        try
        {
            for (const [name, changes] of external)
            {
                const connector = this.setup.Connectors.get(name)!;
                let txn = this.externalTxns.get(name);
                if (txn === undefined)
                {
                    txn = await this.Call(connector, ConnectorPhase.Write, undefined, () => connector.Begin(this.context));
                    this.externalTxns.set(name, txn);
                }
                const applyTxn = txn;
                // Logged before Apply: a partial Apply throws after recording its applied ops for Undo (ruling R136 E3).
                this.RecordExternal(stepNumber, connector, changes, applyTxn);
                const result = await this.Call(connector, ConnectorPhase.Write, applyTxn, () => applyTxn.Apply(changes));
                this.Report(result);
            }
        }
        catch (error)
        {
            throw error instanceof ConnectorError ? error : new ConnectorError(this.current.Connector, ConnectorPhase.Write, error);
        }
        finally
        {
            this.Disarm();
        }
    }

    /**
     * Executes one connector's source-keyed creates as a single step (ruling R136 E4), one Create call for `name`.
     * The connector is begun at its first step and reused. The step is logged (before the call, so the connector has
     * recorded its inserts for Undo) and resolves with one outcome per request, index-aligned. A connector that does
     * not implement Create refuses with ConnectorError(name, Write, GraphError Unsupported). On any failure or the
     * timeout a ConnectorError of phase Write is thrown; the GraphTransaction then calls Compensate (ruling R137 E6).
     */
    public async Create(name: string, requests: readonly IAssignedCreate[], stepNumber: number): Promise<readonly IAssignedOutcome[]>
    {
        this.Arm();
        try
        {
            const connector = this.setup.Connectors.get(name)!;
            let txn = this.externalTxns.get(name);
            if (txn === undefined)
            {
                txn = await this.Call(connector, ConnectorPhase.Write, undefined, () => connector.Begin(this.context));
                this.externalTxns.set(name, txn);
            }
            const createTxn = txn;
            if (createTxn.Create === undefined)
            {
                throw new ConnectorError(name, ConnectorPhase.Write, new GraphError(GraphErrorCode.Unsupported, WriteCoordinator.ErrNoCreate + name));
            }
            // Logged before Create: a throw after partial apply still undoes exactly what applied (ruling R136 E4).
            this.RecordCreate(stepNumber, connector, requests, createTxn);
            return await this.Call(connector, ConnectorPhase.Write, createTxn, () => createTxn.Create!(requests));
        }
        catch (error)
        {
            throw error instanceof ConnectorError ? error : new ConnectorError(this.current.Connector, ConnectorPhase.Write, error);
        }
        finally
        {
            this.Disarm();
        }
    }

    /** Feeds an Apply's reported versions into the ledger (ruling R137 E5): the next change to each id is guarded with it. */
    private Report(result: IConnectorApplyResult | void): void
    {
        if (result === undefined || result === null || result.Versions === undefined)
        {
            return;
        }
        for (const [id, version] of result.Versions)
        {
            this.ledger.Reported(id, version);
        }
    }

    /**
     * Compensates the transaction's executed connector work after `failure` (undefined for a deliberate Abort): reverts
     * the Mirrored connectors in reverse Begin order, then walks the external step log in reverse (Undo, else Revert),
     * via the Compensator, bounded by the setup's timeout from the failure (ruling R137 E6). Raises ConnectorApplied
     * once, with the outcome. Idempotent (runs the connector work once). Resolves with the error the caller should
     * throw and the outcome; never rejects.
     */
    public async Compensate(failure: unknown): Promise<ICompensation>
    {
        if (this.compensated)
        {
            return { Error: failure, Outcome: this.lastOutcome };
        }
        this.compensated = true;
        const result = await new Compensator(this.setup, this.lateFailures).Run(this.log, this.mirroredBegun, failure, this.hung);
        this.lastOutcome = result.Outcome;
        this.RaiseApplied(result.Outcome, undefined);
        return result;
    }

    /**
     * Commits the transaction's write-through (its External steps already executed): Prepare the engine batch, run the
     * Mirrored connectors, finalize engine storage, then finalize the External connectors. With `unchanged` (the engine
     * part is empty, controller ruling P13) the prepared commit only guards the engine reads during the connector phase
     * and is released, not finalized; Run resolves with `unchanged`. On success ConnectorApplied is raised once, with
     * Outcome Committed. On a failure Run aborts the prepared commit and throws the failure; the GraphTransaction then
     * calls Compensate (ruling R137 E6). It never compensates on its own.
     */
    public async Run(prepare: () => Promise<PreparedCommit>, mirrored: ReadonlyMap<string, readonly ConnectorChange[]>, unchanged?: bigint): Promise<bigint>
    {
        this.Arm();
        try
        {
            const commit = await this.Drive(prepare, mirrored, unchanged);
            this.RaiseApplied(ConnectorOutcome.Committed, unchanged === undefined ? commit : undefined);
            return commit;
        }
        finally
        {
            this.Disarm();
        }
    }

    private async Drive(prepare: () => Promise<PreparedCommit>, mirrored: ReadonlyMap<string, readonly ConnectorChange[]>, unchanged: bigint | undefined): Promise<bigint>
    {
        // Prepare's own rejection (OCC conflict) propagates: the GraphTransaction compensates the executed steps.
        const prepared = await this.Prepared(prepare);
        try
        {
            const mirroredNames = [...mirrored.keys()].sort();
            const mirroredTxns = new Map<string, IConnectorTransaction>();
            for (const name of mirroredNames)
            {
                const connector = this.setup.Connectors.get(name)!;
                const txn = await this.Call(connector, ConnectorPhase.Begin, undefined, () => connector.Begin(this.context));
                this.mirroredBegun.push({ Connector: connector, Txn: txn });
                mirroredTxns.set(name, txn);
            }
            for (const name of mirroredNames)
            {
                const connector = this.setup.Connectors.get(name)!;
                const txn = mirroredTxns.get(name)!;
                const set = new ConnectorChangeSet(mirrored.get(name)!);
                await this.Call(connector, ConnectorPhase.Apply, txn, () => txn.Apply(set));
                this.AddConcepts(name, set.Changes.map(c => c.Concept));
            }
            for (const name of mirroredNames)
            {
                const connector = this.setup.Connectors.get(name)!;
                const txn = mirroredTxns.get(name)!;
                await this.Call(connector, ConnectorPhase.Commit, txn, () => txn.Commit());
            }
        }
        catch (error)
        {
            prepared.Abort();
            throw error instanceof ConnectorError ? error : new ConnectorError(this.current.Connector, this.current.Phase, error);
        }
        // The engine commits (Finalize) or releases (the unchanged, all-external path) FIRST: either can still fail
        // (storage trouble, disposal, reservation expiry, a schema / binding change since Prepare) and, when it does,
        // the external step log must still be intact so the GraphTransaction's compensation undoes the executed external
        // writes (ruling R137 E6). External finalize only then runs — after a SUCCESSFUL engine commit, so it is never
        // routed into the prepared.Abort() above (the engine is committed and must not be aborted). It drops the
        // connectors' before-images with no remote effect (ruling R136 E3), so it is effectively infallible and safe last.
        if (unchanged !== undefined)
        {
            // Nothing for engine storage: the reservation guarded the engine reads until the connectors committed, and
            // it must still hold now, as Finalize would require; else the GraphTransaction compensates.
            try
            {
                prepared.Release();
            }
            catch (error)
            {
                throw new ConnectorError(BindingTable.EngineStorage, ConnectorPhase.Finalize, error);
            }
            await this.FinalizeExternal();
            return unchanged;
        }
        let commit: bigint;
        try
        {
            commit = await prepared.Finalize();
        }
        catch (error)
        {
            throw new ConnectorError(BindingTable.EngineStorage, ConnectorPhase.Finalize, error);
        }
        await this.FinalizeExternal();
        return commit;
    }

    /**
     * Finalizes every begun External connector in Begin order, after the engine has committed (ruling R136 E3): each
     * Commit drops that connector's before-images with no remote effect. Run only on the success path, so the external
     * step log stays intact for compensation whenever the engine commit itself fails (ruling R137 E6).
     */
    private async FinalizeExternal(): Promise<void>
    {
        for (const [name, txn] of this.externalTxns)
        {
            const connector = this.setup.Connectors.get(name)!;
            await this.Call(connector, ConnectorPhase.Commit, txn, () => txn.Commit());
        }
    }

    /**
     * ConnectorApplied, once per transaction at its end (ruling R138 E7): per connector (name order), the distinct
     * concepts it touched, sorted, and the Outcome. Raised only when a connector took part. A throwing subscriber is
     * ignored.
     */
    private RaiseApplied(outcome: ConnectorOutcome, commit: bigint | undefined): void
    {
        if (this.participated.size === 0 || this.appliedRaised)
        {
            return;
        }
        this.appliedRaised = true;
        const connectors = new Map<string, readonly string[]>();
        for (const name of [...this.participated.keys()].sort())
        {
            connectors.set(name, Object.freeze([...this.participated.get(name)!].sort()));
        }
        const applied: IConnectorApplied = commit === undefined
            ? { Connectors: connectors, Outcome: outcome }
            : { Commit: commit, Connectors: connectors, Outcome: outcome };
        try
        {
            this.applied.Raise(Object.freeze(applied));
        }
        catch
        {
            // Subscriber failures cannot undo the connectors' commits; Signal already ran every handler.
        }
    }

    /** Records an executed External step: its concepts (for ConnectorApplied) and the step log (for the Compensator). */
    private RecordExternal(step: number, connector: IGraphConnector, changes: ConnectorChangeSet, txn: IConnectorTransaction): void
    {
        this.AddConcepts(connector.Name, changes.Changes.map(c => c.Concept));
        this.log.push({ Step: step, Connector: connector, Txn: txn });
    }

    /** Records an executed source-keyed create step (ruling R136 E4): its request concepts and the step log. */
    private RecordCreate(step: number, connector: IGraphConnector, requests: readonly IAssignedCreate[], txn: IConnectorTransaction): void
    {
        this.AddConcepts(connector.Name, requests.map(r => r.Concept));
        this.log.push({ Step: step, Connector: connector, Txn: txn });
    }

    private AddConcepts(name: string, concepts: readonly string[]): void
    {
        let set = this.participated.get(name);
        if (set === undefined)
        {
            set = new Set<string>();
            this.participated.set(name, set);
        }
        for (const c of concepts)
        {
            set.add(c);
        }
    }

    /** Arms a fresh deadline (the setup's timeout) for a step or for Run; resets the per-window state. */
    private Arm(): void
    {
        this.expired = false;
        this.hung = undefined;
        this.deadline = new Promise(resolve =>
        {
            this.timer = setTimeout(() =>
            {
                this.expired = true;
                resolve(WriteCoordinator.TimedOut);
            }, this.setup.TimeoutMs);
        });
    }

    private Disarm(): void
    {
        clearTimeout(this.timer);
    }

    /**
     * Prepare raced against the deadline. Its own rejection is rethrown as-is; at the deadline it is
     * ConnectorError (engine, Prepare), and the commit is aborted whenever Prepare still resolves.
     */
    private async Prepared(prepare: () => Promise<PreparedCommit>): Promise<PreparedCommit>
    {
        const pending = prepare();
        const result = await Promise.race([pending, this.deadline]);
        if (result !== WriteCoordinator.TimedOut)
        {
            return result;
        }
        pending.then(p => p.Abort(), () => undefined);
        throw this.Timeout(BindingTable.EngineStorage, ConnectorPhase.Prepare);
    }

    /**
     * One connector call, raced against the deadline. A throw becomes a ConnectorError of this call; the
     * timeout too, after recording the call as hung. Past the deadline the call is not made.
     */
    private async Call<T>(connector: IGraphConnector, phase: ConnectorPhase, txn: IConnectorTransaction | undefined, call: () => Promise<T>): Promise<T>
    {
        this.current = { Connector: connector.Name, Phase: phase };
        if (this.expired)
        {
            throw this.Timeout(connector.Name, phase);
        }
        let pending: Promise<T>;
        try
        {
            pending = call();
        }
        catch (error)
        {
            throw new ConnectorError(connector.Name, phase, error);
        }
        let result: T | typeof WriteCoordinator.TimedOut;
        try
        {
            result = await Promise.race([pending, this.deadline]);
        }
        catch (error)
        {
            throw new ConnectorError(connector.Name, phase, error);
        }
        if (result === WriteCoordinator.TimedOut)
        {
            this.hung = { Connector: connector, Phase: phase, Call: pending, Txn: txn };
            throw this.Timeout(connector.Name, phase);
        }
        return result;
    }

    private Timeout(connector: string, phase: ConnectorPhase): ConnectorError
    {
        return new ConnectorError(connector, phase, new GraphError(GraphErrorCode.ConnectorFailed, WriteCoordinator.ErrTimedOut + this.setup.TimeoutMs));
    }
}
