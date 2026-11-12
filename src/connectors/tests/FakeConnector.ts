import type { ConnectorChangeSet } from '../ConnectorChangeSet.js';
import type { ConnectorContext } from '../ConnectorContext.js';
import type { IConnectorTransaction, IGraphConnector } from '../GraphConnector.js';

/** The calls a FakeConnector can be told to fail or hang in. */
export enum FakeStep
{
    Begin = 'Begin',
    Apply = 'Apply',
    Commit = 'Commit',
    Revert = 'Revert',
}

/**
 * A recording test connector. Every call appends `<Name>.<Step>` to the shared log when it starts (and
 * `<Name>.<Step>.End` when a hanging call finishes). `FailAt` makes that call throw `Failure`; `HangAt`
 * makes it wait until Release() first; `OnCommit` runs inside Commit before it returns. `Applied` keeps every
 * change set it received; `Reverted` resolves when Revert was called (whatever its outcome).
 */
export class FakeConnector implements IGraphConnector
{
    private static readonly Separator = '.';
    private static readonly EndSuffix = '.End';
    private static readonly FailurePrefix = 'fake failure: ';

    public readonly Applied: ConnectorChangeSet[] = [];
    /** The context of every Begin, in call order. */
    public readonly Contexts: ConnectorContext[] = [];
    public FailAt: FakeStep | undefined;
    public HangAt: FakeStep | undefined;
    public OnApply: (() => Promise<void>) | undefined;
    public OnCommit: (() => Promise<void>) | undefined;
    public readonly Reverted: Promise<void>;
    public Failure: Error;
    private reverted: () => void = () => undefined;
    private release: () => void = () => undefined;
    private readonly held: Promise<void>;

    public constructor(public readonly Name: string, public readonly Log: string[])
    {
        this.Failure = new Error(FakeConnector.FailurePrefix + Name);
        this.Reverted = new Promise<void>(resolve => { this.reverted = resolve; });
        this.held = new Promise<void>(resolve => { this.release = resolve; });
    }

    /** Ends the hang of the HangAt call (and of any later one). */
    public Release(): void
    {
        this.release();
    }

    public async Begin(context: ConnectorContext): Promise<IConnectorTransaction>
    {
        this.Contexts.push(context);
        await this.Step(FakeStep.Begin);
        return new FakeConnectorTransaction(this);
    }

    /** Logs the step, hangs and fails as configured. */
    public async Step(step: FakeStep): Promise<void>
    {
        const entry = this.Name + FakeConnector.Separator + step;
        this.Log.push(entry);
        try
        {
            if (this.HangAt === step)
            {
                await this.held;
                this.Log.push(entry + FakeConnector.EndSuffix);
            }
            if (this.FailAt === step)
            {
                throw this.Failure;
            }
        }
        finally
        {
            if (step === FakeStep.Revert)
            {
                this.reverted();
            }
        }
    }
}

class FakeConnectorTransaction implements IConnectorTransaction
{
    public constructor(private readonly owner: FakeConnector)
    {
    }

    public async Apply(changes: ConnectorChangeSet): Promise<void>
    {
        this.owner.Applied.push(changes);
        await this.owner.Step(FakeStep.Apply);
        await this.owner.OnApply?.();
    }

    public async Commit(): Promise<void>
    {
        await this.owner.Step(FakeStep.Commit);
        await this.owner.OnCommit?.();
    }

    public Revert(): Promise<void>
    {
        return this.owner.Step(FakeStep.Revert);
    }
}
