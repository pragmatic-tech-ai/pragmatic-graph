import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { ConnectorContext } from './ConnectorContext.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { CatalogIndex } from '../txn/CatalogIndex.js';
import type { PreparedCommit } from '../txn/PreparedCommit.js';
import type { Signal } from '../txn/Signal.js';
import { type BatchOp, WriteBatch } from '../txn/WriteBatch.js';
import { BindingTable } from './BindingTable.js';
import type { IConnectorApplied } from './ConnectorApplied.js';
import { type ConnectorChange, ConnectorChangeSet } from './ConnectorChangeSet.js';
import { ConnectorError, ConnectorPhase } from './ConnectorError.js';
import { ConnectorResidency, type IExternalConnector, type RowVersion } from './FetchContract.js';
import type { IConnectorTransaction, IGraphConnector } from './GraphConnector.js';
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

/** One external write step the transaction executed, in execution order, for the Compensator to undo (Task 2.2). */
export interface IExecutedStep
{
    readonly Step: number;
    readonly Connector: string;
    readonly Txn: IConnectorTransaction;
    readonly Changes: ConnectorChangeSet;
}

/** The connector call in flight when the connector phase timed out. */
interface IHungCall
{
    readonly Connector: IGraphConnector;
    readonly Phase: ConnectorPhase;
    /** The call; for Begin it resolves with the transaction to revert. */
    readonly Call: Promise<unknown>;
    /** The transaction that began, for Apply and Commit. */
    readonly Txn: IConnectorTransaction | undefined;
}

/** How a revert ended: undefined when it succeeded, else its error (boxed, so a thrown `undefined` still counts). */
type RevertOutcome = { readonly Error: unknown } | undefined;

/**
 * Write-through of one GraphTransaction (spec §6, rulings R72, R135). With External connectors installed, writes
 * execute in steps: `Step` runs a step's External change sets now (the connector is begun at its first step and kept
 * for the transaction's life, ruling R135 E2), while Mirrored change sets stage. `Run` then commits at the end:
 * Prepare (engine) → each Mirrored connector Begin/Apply/Commit → each begun External connector Commit (finalize,
 * dropping before-images, no remote effect) → Finalize (engine). Calls run one at a time, never inside a store.Write.
 * One deadline (the setup's timeout) bounds each step, and bounds Prepare / every connector call / the reverts of
 * Run, each from its own start. On any failure or the timeout the prepared commit is aborted and every connector that
 * began is reverted, in reverse order of Begin (committed ones too: compensation); the caller then gets a
 * ConnectorError, its phase Write for a failed step. On success ConnectorApplied is raised once, after the engine
 * commit when there is one (a throwing subscriber is ignored). Compensation by connector Undo and the dropped-
 * transaction path consume the step log; that is Task 2.2.
 */
export class WriteCoordinator
{
    private static readonly ErrTimedOut = 'Write-through timed out after ms: ';
    private static readonly ErrReverts = 'The write-through failed and reverting a connector failed too';
    private static readonly TimedOut: unique symbol = Symbol('TimedOut');
    private static readonly NoExternal: ReadonlySet<string> = new Set();

    private began: { readonly Connector: IGraphConnector; readonly Txn: IConnectorTransaction }[] = [];
    /** The External connector transactions begun so far, kept for the transaction's life (ruling R135 E2). */
    private readonly externalTxns = new Map<string, IConnectorTransaction>();
    /** The External steps executed, in order, for Task 2.2's compensation to undo. */
    private readonly log: IExecutedStep[] = [];
    /** Per participating connector, the concepts its changes touched, for ConnectorApplied. */
    private readonly participated = new Map<string, Set<string>>();
    private expired = false;
    private deadline: Promise<typeof WriteCoordinator.TimedOut> = new Promise(() => undefined);
    private timer: ReturnType<typeof setTimeout> | undefined;
    private hung: IHungCall | undefined;
    /** The connector call last started, for wrapping a non-connector error should one ever escape. */
    private current: { readonly Connector: string; readonly Phase: ConnectorPhase } = { Connector: BindingTable.EngineStorage, Phase: ConnectorPhase.Prepare };

    public constructor(private readonly setup: ConnectorSetup, private readonly lateFailures: Signal<ConnectorError>, private readonly applied: Signal<IConnectorApplied>, private readonly context: ConnectorContext)
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

    /** The External steps executed so far, in order (Task 2.2 compensation consumes them). */
    public get Steps(): readonly IExecutedStep[]
    {
        return this.log;
    }

    /** True once at least one connector (External or Mirrored) took part: whether Run raises ConnectorApplied. */
    public get Participated(): boolean
    {
        return this.participated.size > 0;
    }

    /**
     * Executes a step's External change sets now (ruling R135 E2), one connector at a time in name order. A connector
     * is begun at its first step and reused after; each Apply reports what the source assigned (ignored until the
     * version ledger, E5). On any failure or the timeout every begun connector is reverted and a ConnectorError of
     * phase Write is thrown.
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
                    this.began.push({ Connector: connector, Txn: txn });
                }
                const applyTxn = txn;
                await this.Call(connector, ConnectorPhase.Write, applyTxn, () => applyTxn.Apply(changes));
                this.RecordExternal(stepNumber, name, changes, applyTxn);
            }
        }
        catch (error)
        {
            throw await this.Failed(error instanceof ConnectorError ? error : new ConnectorError(this.current.Connector, ConnectorPhase.Write, error));
        }
        finally
        {
            this.Disarm();
        }
    }

    /**
     * Commits the transaction's write-through (its External steps already executed): Prepare the engine batch, run the
     * Mirrored connectors, finalize the External connectors, then finalize engine storage. With `unchanged` (the engine
     * part is empty, controller ruling P13) the prepared commit only guards the engine reads during the connector phase
     * and is released, not finalized; Run resolves with `unchanged`. On success ConnectorApplied is raised once.
     */
    public async Run(prepare: () => Promise<PreparedCommit>, mirrored: ReadonlyMap<string, readonly ConnectorChange[]>, unchanged?: bigint): Promise<bigint>
    {
        this.Arm();
        try
        {
            const commit = await this.Drive(prepare, mirrored, unchanged);
            this.RaiseApplied(unchanged === undefined ? commit : undefined);
            return commit;
        }
        finally
        {
            this.Disarm();
        }
    }

    private async Drive(prepare: () => Promise<PreparedCommit>, mirrored: ReadonlyMap<string, readonly ConnectorChange[]>, unchanged: bigint | undefined): Promise<bigint>
    {
        const prepared = await this.Prepared(prepare);
        try
        {
            const mirroredNames = [...mirrored.keys()].sort();
            const mirroredTxns = new Map<string, IConnectorTransaction>();
            for (const name of mirroredNames)
            {
                const connector = this.setup.Connectors.get(name)!;
                const txn = await this.Call(connector, ConnectorPhase.Begin, undefined, () => connector.Begin(this.context));
                this.began.push({ Connector: connector, Txn: txn });
                mirroredTxns.set(name, txn);
            }
            for (const name of mirroredNames)
            {
                const connector = this.setup.Connectors.get(name)!;
                const txn = mirroredTxns.get(name)!;
                const set = new ConnectorChangeSet(mirrored.get(name)!);
                await this.Call(connector, ConnectorPhase.Apply, txn, () => txn.Apply(set));
                this.AddConcepts(name, set);
            }
            for (const name of mirroredNames)
            {
                const connector = this.setup.Connectors.get(name)!;
                const txn = mirroredTxns.get(name)!;
                await this.Call(connector, ConnectorPhase.Commit, txn, () => txn.Commit());
            }
            // External finalize: drop before-images, no remote effect, in begin order.
            for (const [name, txn] of this.externalTxns)
            {
                const connector = this.setup.Connectors.get(name)!;
                await this.Call(connector, ConnectorPhase.Commit, txn, () => txn.Commit());
            }
        }
        catch (error)
        {
            prepared.Abort();
            throw await this.Failed(error instanceof ConnectorError ? error : new ConnectorError(this.current.Connector, this.current.Phase, error));
        }
        if (unchanged !== undefined)
        {
            // Nothing for engine storage: the reservation guarded the engine reads until the connectors committed, and
            // it must still hold now, as Finalize would require; else every connector is compensated.
            try
            {
                prepared.Release();
            }
            catch (error)
            {
                throw await this.Failed(new ConnectorError(BindingTable.EngineStorage, ConnectorPhase.Finalize, error));
            }
            return unchanged;
        }
        try
        {
            return await prepared.Finalize();
        }
        catch (error)
        {
            throw await this.Failed(new ConnectorError(BindingTable.EngineStorage, ConnectorPhase.Finalize, error));
        }
    }

    /** ConnectorApplied for a successful write-through: per connector (name order), the distinct concepts it touched, sorted. */
    private RaiseApplied(commit: bigint | undefined): void
    {
        if (this.participated.size === 0)
        {
            return;
        }
        const connectors = new Map<string, readonly string[]>();
        for (const name of [...this.participated.keys()].sort())
        {
            connectors.set(name, Object.freeze([...this.participated.get(name)!].sort()));
        }
        const applied: IConnectorApplied = commit === undefined ? { Connectors: connectors } : { Commit: commit, Connectors: connectors };
        try
        {
            this.applied.Raise(Object.freeze(applied));
        }
        catch
        {
            // Subscriber failures cannot undo the connectors' commits; Signal already ran every handler.
        }
    }

    /** Records an executed External step: its concepts (for ConnectorApplied) and the step log (for Task 2.2). */
    private RecordExternal(step: number, name: string, changes: ConnectorChangeSet, txn: IConnectorTransaction): void
    {
        this.AddConcepts(name, changes);
        this.log.push({ Step: step, Connector: name, Txn: txn, Changes: changes });
    }

    private AddConcepts(name: string, changes: ConnectorChangeSet): void
    {
        let concepts = this.participated.get(name);
        if (concepts === undefined)
        {
            concepts = new Set<string>();
            this.participated.set(name, concepts);
        }
        for (const c of changes.Changes)
        {
            concepts.add(c.Concept);
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

    /**
     * Reverts every connector that began, in reverse order (a hung one later, once its call returns),
     * and returns the error to throw: `failure`, its cause wrapped with the revert errors when any.
     * Reverts are awaited only until the deadline; the rest start at once and finish on the late path.
     */
    private async Failed(failure: ConnectorError): Promise<ConnectorError>
    {
        const hung = this.hung;
        if (hung !== undefined)
        {
            void this.RevertLate(hung);
        }
        const errors: unknown[] = [];
        for (const { Connector, Txn } of [...this.began].reverse())
        {
            if (hung !== undefined && hung.Connector === Connector)
            {
                continue;
            }
            const outcome = WriteCoordinator.Revert(Txn);
            if (this.expired)
            {
                this.ReportLate(Connector, failure.Phase, outcome);
                continue;
            }
            const result = await Promise.race([outcome, this.deadline]);
            if (result === WriteCoordinator.TimedOut)
            {
                this.ReportLate(Connector, failure.Phase, outcome);
            }
            else if (result !== undefined)
            {
                errors.push(result.Error);
            }
        }
        if (errors.length === 0)
        {
            return failure;
        }
        return new ConnectorError(failure.Connector, failure.Phase, new AggregateError([failure.cause, ...errors], WriteCoordinator.ErrReverts));
    }

    /** Starts the transaction's Revert; never rejects (a throw, synchronous or not, becomes the outcome). */
    private static async Revert(txn: IConnectorTransaction): Promise<RevertOutcome>
    {
        try
        {
            await txn.Revert();
            return undefined;
        }
        catch (error)
        {
            return { Error: error };
        }
    }

    /** Waits for the hung call, then reverts its connector's transaction on the late path. */
    private async RevertLate(hung: IHungCall): Promise<void>
    {
        let txn = hung.Txn;
        try
        {
            const value = await hung.Call;
            if (hung.Phase === ConnectorPhase.Begin)
            {
                txn = value as IConnectorTransaction;
            }
        }
        catch
        {
            // The call's own failure is moot: the caller already has the timeout. A failed Begin began nothing.
        }
        if (txn !== undefined)
        {
            this.ReportLate(hung.Connector, hung.Phase, WriteCoordinator.Revert(txn));
        }
    }

    /** Raises a late revert's failure on lateFailures once it settles. */
    private ReportLate(connector: IGraphConnector, phase: ConnectorPhase, outcome: Promise<RevertOutcome>): void
    {
        void outcome.then(result =>
        {
            if (result === undefined)
            {
                return;
            }
            try
            {
                this.lateFailures.Raise(new ConnectorError(connector.Name, phase, result.Error));
            }
            catch
            {
                // A throwing subscriber has nowhere to report to on this detached path (Signal aggregates handler
                // errors).
            }
        });
    }
}
