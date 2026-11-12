import { ConnectorResidency, type IConnectorCapabilities, type IExternalConnector, type IFetchPage, type IFetchRequest, type IFetchedRow, type RowVersion } from '../FetchContract.js';
import type { ConnectorContext } from '../ConnectorContext.js';
import type { ConnectorChangeSet } from '../ConnectorChangeSet.js';
import type { IAssignedCreate, IAssignedOutcome, IConnectorApplyResult, IConnectorTransaction } from '../GraphConnector.js';

/** One external write step the connector executed, as the engine handed it over. */
export interface IExecutedStep
{
    readonly Step: number;
    readonly Changes: ConnectorChangeSet;
}

/**
 * A scripted external connector. `Pages` are served in order through Resume tokens (the token is the next page
 * index); a request with Keys is answered from every scripted row whose id is asked for. `Requests` logs every
 * Fetch; `ThrowAtCall` (1-based) makes that fetch call throw `Failure`.
 *
 * It also takes writes (Wave 2): `Begin` returns a transaction that executes each step immediately. `Executed`
 * logs every applied step (in call order, with its 1-based step number); `Order`, when shared between connectors,
 * records each connector's name as its step applies, so routing order is observable. `ThrowAtStep` (1-based)
 * makes that Apply throw `Failure` before it records. `Versions`, when set, is returned from every Apply as the
 * source's reported versions. `CommitCalls`, `UndoCalls` and `RevertCalls` count the finalize, undo and revert
 * calls; the finalize (Commit) records no new remote effect.
 */
export class FakeExternalConnector implements IExternalConnector
{
    private static readonly Boom = 'fake external write failure';

    public readonly Residency = ConnectorResidency.External as const;
    public readonly Requests: IFetchRequest[] = [];
    public ThrowAtCall: number | undefined;
    public readonly Failure = new Error(FakeExternalConnector.Boom);
    public Override: ((request: IFetchRequest) => IFetchPage) | undefined;

    public readonly Executed: IExecutedStep[] = [];
    public readonly Contexts: ConnectorContext[] = [];
    public ThrowAtStep: number | undefined;
    public Versions: ReadonlyMap<string, RowVersion> | undefined;
    public CommitCalls = 0;
    public UndoCalls = 0;
    public RevertCalls = 0;
    /** When false, the transaction it returns exposes no Undo: compensation uses Revert (ruling R137 E6). */
    public SupportsUndo = true;
    /** Shared between connectors to observe cross-connector compensation order; each Undo appends this connector's name. */
    public UndoOrder: string[] | undefined;
    /** As UndoOrder, for Revert. */
    public RevertOrder: string[] | undefined;
    /** When set, Undo rejects with it. */
    public UndoFailure: unknown;
    /** When set, Revert rejects with it. */
    public RevertFailure: unknown;
    /** When true, Undo waits until ReleaseUndo() (to test the compensation deadline / late reverts). */
    public HoldUndo = false;
    private steps = 0;
    private releaseUndo: () => void = () => undefined;
    private readonly undoHeld: Promise<void>;

    public constructor(
        public readonly Name: string,
        public Pages: readonly (readonly IFetchedRow[])[],
        public readonly Capabilities: IConnectorCapabilities = { KeyLookup: true, ReverseLookup: true, PushDown: new Set() },
        /** Shared between connectors to observe cross-connector step order; each Apply appends this connector's name. */
        public readonly Order?: string[],
    )
    {
        this.undoHeld = new Promise<void>(resolve => { this.releaseUndo = resolve; });
    }

    /** Ends the hold of a HoldUndo Undo (and of any later one). */
    public ReleaseUndo(): void
    {
        this.releaseUndo();
    }

    public Begin(context: ConnectorContext): Promise<IConnectorTransaction>
    {
        this.Contexts.push(context);
        const txn = new FakeExternalTransaction(this);
        if (!this.SupportsUndo)
        {
            (txn as { Undo?: unknown }).Undo = undefined;
        }
        return Promise.resolve(txn);
    }

    /** @internal Runs a scripted Undo: records its order, waits when held, then fails when configured. */
    public async RunUndo(): Promise<void>
    {
        this.UndoCalls++;
        this.UndoOrder?.push(this.Name);
        if (this.HoldUndo)
        {
            await this.undoHeld;
        }
        if (this.UndoFailure !== undefined)
        {
            throw this.UndoFailure;
        }
    }

    /** @internal Runs a scripted Revert: records its order, then fails when configured. */
    public async RunRevert(): Promise<void>
    {
        this.RevertCalls++;
        this.RevertOrder?.push(this.Name);
        if (this.RevertFailure !== undefined)
        {
            throw this.RevertFailure;
        }
    }

    /** @internal Advances and returns the next 1-based step number; records the connector in the shared order. */
    public NextStep(): number
    {
        this.Order?.push(this.Name);
        return ++this.steps;
    }

    public Fetch(request: IFetchRequest): Promise<IFetchPage>
    {
        this.Requests.push(request);
        if (this.ThrowAtCall === this.Requests.length)
        {
            return Promise.reject(this.Failure);
        }
        if (this.Override !== undefined)
        {
            return Promise.resolve(this.Override(request));
        }
        if (request.Keys !== undefined)
        {
            const keys = new Set(request.Keys);
            return Promise.resolve({ Rows: this.Pages.flat().filter(r => keys.has(r.PublicId)) });
        }
        const index = request.Resume === undefined ? 0 : Number(request.Resume);
        const next = index + 1;
        return Promise.resolve(next < this.Pages.length ? { Rows: this.Pages[index]!, Resume: String(next) } : { Rows: this.Pages[index] ?? [] });
    }
}

/** The executing connector transaction a FakeExternalConnector hands back: every step runs at once. */
class FakeExternalTransaction implements IConnectorTransaction
{
    public constructor(private readonly owner: FakeExternalConnector)
    {
    }

    public Apply(changes: ConnectorChangeSet): Promise<IConnectorApplyResult | void>
    {
        const step = this.owner.NextStep();
        if (this.owner.ThrowAtStep === step)
        {
            return Promise.reject(this.owner.Failure);
        }
        this.owner.Executed.push({ Step: step, Changes: changes });
        return Promise.resolve(this.owner.Versions === undefined ? undefined : { Versions: this.owner.Versions });
    }

    public Create(_requests: readonly IAssignedCreate[]): Promise<readonly IAssignedOutcome[]>
    {
        return Promise.reject(this.owner.Failure);
    }

    public Undo(): Promise<void>
    {
        return this.owner.RunUndo();
    }

    public Commit(): Promise<void>
    {
        this.owner.CommitCalls++;
        return Promise.resolve();
    }

    public Revert(): Promise<void>
    {
        return this.owner.RunRevert();
    }
}
