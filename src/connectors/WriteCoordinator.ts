import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { PreparedCommit } from '../txn/PreparedCommit.js';
import type { Signal } from '../txn/Signal.js';
import { type BatchOp, type WriteBatch, WriteOp } from '../txn/WriteBatch.js';
import { BindingTable } from './BindingTable.js';
import { type ConnectorChange, ConnectorChangeSet } from './ConnectorChangeSet.js';
import { ConnectorError, ConnectorPhase } from './ConnectorError.js';
import type { IConnectorTransaction, IGraphConnector } from './GraphConnector.js';

/** The owner (model, '' for none) and concept a write routes by. */
export interface INodeOrigin
{
    readonly Owner: string;
    readonly Concept: string;
}

/** Where routing looks up nodes the batch does not create: the transaction's snapshot (recorded reads). */
export interface INodeOrigins
{
    Origin(publicId: string): Promise<INodeOrigin | undefined>;
}

/** The connectors installed on a store, by name, with the bindings that route to them (GraphContext.SetConnectors). */
export class ConnectorSetup
{
    private static readonly ErrUnknown = 'A binding names a connector that is not installed: ';
    private static readonly ErrDuplicate = 'Two installed connectors share the name: ';
    private static readonly ErrReserved = 'A connector cannot use the reserved name: ';
    private static readonly ErrTimeout = 'Connector timeout must be a finite positive number of milliseconds: ';

    public readonly Connectors: ReadonlyMap<string, IGraphConnector>;

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
            byName.set(c.Name, c);
        }
        for (const name of Bindings.ConnectorNames())
        {
            if (name !== BindingTable.EngineStorage && !byName.has(name))
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrUnknown + name);
            }
        }
        this.Connectors = byName;
    }
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
 * Write-through of one transaction (spec §6, ruling R72). Route groups the batch's ops by the connector
 * that holds each node's binding; Run then drives: Prepare (engine) → Begin each participant (sorted by
 * name) → Apply each → Commit each → Finalize (engine). Calls run one at a time, never inside a
 * store.Write. One deadline (the setup's timeout, from the start of Prepare) bounds Prepare, every
 * connector call and the reverts. On any failure or the timeout the prepared commit is aborted and every
 * connector that began is reverted, in reverse order of Begin (committed ones too: compensation); the
 * caller then gets a ConnectorError. A timeout during Prepare is ConnectorError (engine, Prepare) and the
 * commit is aborted once Prepare returns. Past the deadline nothing more is awaited: a call still hanging
 * is reverted once it returns, reverts still pending (or not yet started, which then start at once)
 * finish on that late path, and their failures are raised on `lateFailures`. An engine rejection at
 * Prepare is rethrown as-is (no connector began).
 */
export class WriteCoordinator
{
    private static readonly ErrTimedOut = 'Write-through timed out after ms: ';
    private static readonly ErrReverts = 'The write-through failed and reverting a connector failed too';
    private static readonly TimedOut: unique symbol = Symbol('TimedOut');
    /** The owner of a node created without one (as GraphReader.OwnerOf reports it). */
    private static readonly NoOwner = '';

    private began: { readonly Connector: IGraphConnector; readonly Txn: IConnectorTransaction }[] = [];
    private expired = false;
    private deadline: Promise<typeof WriteCoordinator.TimedOut> = new Promise(() => undefined);
    private timer: ReturnType<typeof setTimeout> | undefined;
    private hung: IHungCall | undefined;
    /** The connector call last started, for wrapping a non-connector error should one ever escape. */
    private current: { readonly Connector: string; readonly Phase: ConnectorPhase } = { Connector: BindingTable.EngineStorage, Phase: ConnectorPhase.Prepare };

    public constructor(private readonly setup: ConnectorSetup, private readonly lateFailures: Signal<ConnectorError>)
    {
    }

    /**
     * Per participating connector, its change set (in batch op order), keyed in connector-name order.
     * CreateNode / SetProperty / DeleteNode route by the node's owner and concept, Link / Unlink by the
     * source node's. An op routes by the latest CreateNode of its id earlier in the batch, else by the
     * node in the snapshot (`origins`, each id looked up once). DeleteNode does not change an id's
     * origin: an op on a deleted, not re-created id routes like the deleted node (the engine rejects it at
     * Prepare anyway, before any connector begins); a re-created id routes by its new CreateNode. A node
     * found nowhere routes nowhere (the engine rejects the op at Prepare).
     */
    public static async Route(batch: WriteBatch, table: BindingTable, catalog: CatalogSnapshot, origins: INodeOrigins): Promise<ReadonlyMap<string, ConnectorChangeSet>>
    {
        const known = new Map<string, INodeOrigin | undefined>();
        const grouped = new Map<string, ConnectorChange[]>();
        for (const op of batch.Ops())
        {
            let origin: INodeOrigin | undefined;
            if (op.Op === WriteOp.CreateNode)
            {
                origin = { Owner: op.Owner ?? WriteCoordinator.NoOwner, Concept: op.Concept };
                known.set(op.PublicId, origin);
            }
            else
            {
                const id = WriteCoordinator.RoutedId(op);
                if (!known.has(id))
                {
                    known.set(id, await origins.Origin(id));
                }
                origin = known.get(id);
            }
            if (origin === undefined)
            {
                continue;
            }
            const name = table.Resolve(origin.Owner, origin.Concept, catalog);
            if (BindingTable.IsEngineOnly(name))
            {
                continue;
            }
            let changes = grouped.get(name as string);
            if (changes === undefined)
            {
                changes = [];
                grouped.set(name as string, changes);
            }
            changes.push({ ...op, Owner: origin.Owner, Concept: origin.Concept } as ConnectorChange);
        }
        const sets = new Map<string, ConnectorChangeSet>();
        for (const name of [...grouped.keys()].sort())
        {
            sets.set(name, new ConnectorChangeSet(grouped.get(name)!));
        }
        return sets;
    }

    /** Runs the write-through of `sets` (from Route, non-empty); resolves with the engine's commit number. */
    public async Run(prepare: () => Promise<PreparedCommit>, sets: ReadonlyMap<string, ConnectorChangeSet>): Promise<bigint>
    {
        this.deadline = new Promise(resolve =>
        {
            this.timer = setTimeout(() =>
            {
                this.expired = true;
                resolve(WriteCoordinator.TimedOut);
            }, this.setup.TimeoutMs);
        });
        try
        {
            return await this.Drive(prepare, sets);
        }
        finally
        {
            clearTimeout(this.timer);
        }
    }

    private async Drive(prepare: () => Promise<PreparedCommit>, sets: ReadonlyMap<string, ConnectorChangeSet>): Promise<bigint>
    {
        const prepared = await this.Prepared(prepare);
        try
        {
            const participants = [...sets.keys()].map(name => this.setup.Connectors.get(name)!);
            for (const connector of participants)
            {
                const txn = await this.Call(connector, ConnectorPhase.Begin, undefined, () => connector.Begin());
                this.began.push({ Connector: connector, Txn: txn });
            }
            for (const { Connector, Txn } of this.began)
            {
                await this.Call(Connector, ConnectorPhase.Apply, Txn, () => Txn.Apply(sets.get(Connector.Name)!));
            }
            for (const { Connector, Txn } of this.began)
            {
                await this.Call(Connector, ConnectorPhase.Commit, Txn, () => Txn.Commit());
            }
        }
        catch (error)
        {
            prepared.Abort();
            throw await this.Failed(error instanceof ConnectorError ? error : new ConnectorError(this.current.Connector, this.current.Phase, error));
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

    /** The public id an op other than CreateNode routes by: the written node, or a link's source. */
    private static RoutedId(op: Exclude<BatchOp, { Op: WriteOp.CreateNode }>): string
    {
        return op.Op === WriteOp.Link || op.Op === WriteOp.Unlink ? op.From : op.PublicId;
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
                // A throwing subscriber has nowhere to report to on this detached path (Signal aggregates handler errors).
            }
        });
    }
}
