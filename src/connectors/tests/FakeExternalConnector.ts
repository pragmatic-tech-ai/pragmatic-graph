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
    private steps = 0;

    public constructor(
        public readonly Name: string,
        public Pages: readonly (readonly IFetchedRow[])[],
        public readonly Capabilities: IConnectorCapabilities = { KeyLookup: true, ReverseLookup: true, PushDown: new Set() },
        /** Shared between connectors to observe cross-connector step order; each Apply appends this connector's name. */
        public readonly Order?: string[],
    )
    {
    }

    public Begin(context: ConnectorContext): Promise<IConnectorTransaction>
    {
        this.Contexts.push(context);
        return Promise.resolve(new FakeExternalTransaction(this));
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
        this.owner.UndoCalls++;
        return Promise.resolve();
    }

    public Commit(): Promise<void>
    {
        this.owner.CommitCalls++;
        return Promise.resolve();
    }

    public Revert(): Promise<void>
    {
        this.owner.RevertCalls++;
        return Promise.resolve();
    }
}
