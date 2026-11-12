import type { Signal } from '../txn/Signal.js';
import { BindingTable } from './BindingTable.js';
import { ConnectorOutcome } from './ConnectorApplied.js';
import { ConnectorError, ConnectorPhase } from './ConnectorError.js';
import type { IConnectorTransaction, IGraphConnector } from './GraphConnector.js';
import type { ConnectorSetup } from './WriteCoordinator.js';

/** One external write step executed, in execution order, for the Compensator to undo (ruling R137 E6). */
export interface IExecutedStep
{
    readonly Connector: IGraphConnector;
    readonly Txn: IConnectorTransaction;
    readonly Step: number;
}

/** One connector transaction begun for the write-through (a Mirrored connector), to revert in reverse Begin order. */
export interface IBegunConnector
{
    readonly Connector: IGraphConnector;
    readonly Txn: IConnectorTransaction;
}

/** A connector call still in flight at the failing phase's timeout; its transaction is reverted once the call returns. */
export interface IHungCall
{
    readonly Connector: IGraphConnector;
    readonly Phase: ConnectorPhase;
    /** The call; for Begin it resolves with the transaction to revert. */
    readonly Call: Promise<unknown>;
    /** The transaction that began, for Apply and Commit. */
    readonly Txn: IConnectorTransaction | undefined;
}

/** What a compensation resolved to: the error the caller should throw (E6) and the outcome to report on ConnectorApplied. */
export interface ICompensation
{
    readonly Error: unknown;
    readonly Outcome: ConnectorOutcome;
}

/** How one compensation call ended: undefined when it succeeded, else its error (boxed, so a thrown `undefined` counts). */
type CompensateOutcome = { readonly Error: unknown } | undefined;

/** Where a step's compensation wraps its connector / phase for a failed-compensation ConnectorError. */
interface IWrap
{
    readonly Connector: string;
    readonly Phase: ConnectorPhase;
}

/** One compensation action: Undo of a step, or Revert of a connector transaction, named by its connector. */
interface IAction
{
    readonly Connector: IGraphConnector;
    readonly Txn: IConnectorTransaction;
    readonly Call: () => Promise<void>;
}

/**
 * Compensates one GraphTransaction's executed connector work on an abort, a step failure, a commit failure or a drop
 * (ruling R137 E6). It reverts the Mirrored connectors in reverse Begin order, then walks the external step log in
 * reverse, calling each step's connector transaction's Undo, or (for an External connector with no Undo) its Revert
 * once, at its earliest step, after every later step. Each call is raced against a fresh deadline (the setup's
 * timeout) from the failure; a call still hanging at a prior phase's timeout is reverted on the late path. Every failed
 * compensation is raised on ConnectorRevertFailed (late ones when they settle), and the synchronous ones also fill the
 * AggregateError the caller sees. Run resolves with the error to throw and the outcome (Compensated, else
 * CompensationFailed); it never rejects. Nothing crosses GraphTransactions (ruling E11).
 */
export class Compensator
{
    private static readonly ErrReverts = 'The write-through failed and reverting a connector failed too';
    private static readonly TimedOut: unique symbol = Symbol('TimedOut');

    private expired = false;
    private deadline: Promise<typeof Compensator.TimedOut> = new Promise(() => undefined);
    private timer: ReturnType<typeof setTimeout> | undefined;

    public constructor(private readonly setup: ConnectorSetup, private readonly lateFailures: Signal<ConnectorError>)
    {
    }

    /**
     * Compensates `log` and `mirrored` after `failure` (undefined for a deliberate Abort), reverting a call `hung` at
     * the failing phase on the late path. Resolves with the error to throw and the outcome.
     */
    public async Run(log: readonly IExecutedStep[], mirrored: readonly IBegunConnector[], failure: unknown, hung?: IHungCall): Promise<ICompensation>
    {
        const wrap = Compensator.WrapOf(failure);
        const actions = Compensator.Plan(log, mirrored);
        this.Arm();
        const failed: { readonly Connector: IGraphConnector; readonly Error: unknown }[] = [];
        try
        {
            if (hung !== undefined)
            {
                void this.RevertLate(hung, wrap.Phase);
            }
            for (const action of actions)
            {
                if (hung !== undefined && action.Txn === hung.Txn)
                {
                    continue;
                }
                const outcome = Compensator.Perform(action.Call);
                if (this.expired)
                {
                    this.ReportLate(action.Connector, wrap.Phase, outcome);
                    continue;
                }
                const result = await Promise.race([outcome, this.deadline]);
                if (result === Compensator.TimedOut)
                {
                    this.ReportLate(action.Connector, wrap.Phase, outcome);
                }
                else if (result !== undefined)
                {
                    failed.push({ Connector: action.Connector, Error: result.Error });
                }
            }
        }
        finally
        {
            this.Disarm();
        }
        // Every synchronous compensation failure is also raised on ConnectorRevertFailed, at once (ruling R137 E6).
        for (const f of failed)
        {
            this.Raise(f.Connector, wrap.Phase, f.Error);
        }
        if (failed.length === 0)
        {
            return { Error: failure, Outcome: ConnectorOutcome.Compensated };
        }
        const head = failure === undefined ? [] : [failure instanceof ConnectorError ? failure.cause : failure];
        const aggregate = new AggregateError([...head, ...failed.map(f => f.Error)], Compensator.ErrReverts);
        return { Error: new ConnectorError(wrap.Connector, wrap.Phase, aggregate), Outcome: ConnectorOutcome.CompensationFailed };
    }

    /** The ordered compensation actions: Mirrored in reverse Begin order, then the step log in reverse (ruling R137 E6). */
    private static Plan(log: readonly IExecutedStep[], mirrored: readonly IBegunConnector[]): readonly IAction[]
    {
        const actions: IAction[] = [];
        for (const m of [...mirrored].reverse())
        {
            actions.push({ Connector: m.Connector, Txn: m.Txn, Call: () => m.Txn.Revert() });
        }
        // An External connector with no Undo is reverted once, at its earliest step (so after every later step, E6).
        const earliest = new Map<IConnectorTransaction, number>();
        for (const step of log)
        {
            if (step.Txn.Undo === undefined)
            {
                const at = earliest.get(step.Txn);
                if (at === undefined || step.Step < at)
                {
                    earliest.set(step.Txn, step.Step);
                }
            }
        }
        for (const step of [...log].reverse())
        {
            const undo = step.Txn.Undo;
            if (undo !== undefined)
            {
                actions.push({ Connector: step.Connector, Txn: step.Txn, Call: () => undo.call(step.Txn) });
            }
            else if (earliest.get(step.Txn) === step.Step)
            {
                actions.push({ Connector: step.Connector, Txn: step.Txn, Call: () => step.Txn.Revert() });
            }
        }
        return actions;
    }

    /** The connector and phase a failed compensation's ConnectorError wraps (ruling R137 E6). */
    private static WrapOf(failure: unknown): IWrap
    {
        if (failure instanceof ConnectorError)
        {
            return { Connector: failure.Connector, Phase: failure.Phase };
        }
        if (failure === undefined)
        {
            return { Connector: BindingTable.EngineStorage, Phase: ConnectorPhase.Write };
        }
        return { Connector: BindingTable.EngineStorage, Phase: ConnectorPhase.Prepare };
    }

    /** Arms a fresh deadline (the setup's timeout) for the compensation window. */
    private Arm(): void
    {
        this.expired = false;
        this.deadline = new Promise(resolve =>
        {
            this.timer = setTimeout(() =>
            {
                this.expired = true;
                resolve(Compensator.TimedOut);
            }, this.setup.TimeoutMs);
        });
    }

    private Disarm(): void
    {
        clearTimeout(this.timer);
    }

    /** Waits for the hung call, then reverts its connector transaction on the late path. */
    private async RevertLate(hung: IHungCall, phase: ConnectorPhase): Promise<void>
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
            const reverter = txn;
            this.ReportLate(hung.Connector, hung.Phase, Compensator.Perform(() => reverter.Revert()));
        }
    }

    /** Raises a late compensation's failure on ConnectorRevertFailed once it settles. */
    private ReportLate(connector: IGraphConnector, phase: ConnectorPhase, outcome: Promise<CompensateOutcome>): void
    {
        void outcome.then(result =>
        {
            if (result !== undefined)
            {
                this.Raise(connector, phase, result.Error);
            }
        });
    }

    /** Raises one failed compensation on ConnectorRevertFailed; a throwing subscriber is ignored (detached path). */
    private Raise(connector: IGraphConnector, phase: ConnectorPhase, error: unknown): void
    {
        try
        {
            this.lateFailures.Raise(new ConnectorError(connector.Name, phase, error));
        }
        catch
        {
            // A throwing subscriber has nowhere to report to; Signal already ran (and aggregated) every handler.
        }
    }

    /** Runs one compensation call; never rejects (a throw, synchronous or not, becomes the outcome). */
    private static async Perform(call: () => Promise<void>): Promise<CompensateOutcome>
    {
        try
        {
            await call();
            return undefined;
        }
        catch (error)
        {
            return { Error: error };
        }
    }
}
