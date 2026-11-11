import { CypherError } from '../CypherError.js';
import type { CypherNode } from '../CypherNode.js';
import type { ICypherSource } from '../CypherSource.js';
import type { ICypherSink } from './CypherSink.js';
import { OverlaySource } from './OverlaySource.js';
import { PendingOverlay } from './PendingOverlay.js';

/**
 * The sink a write query is planned with for Explain: it gives the planner a View (the plan source under an empty
 * overlay) so write clauses compile, and refuses every write. Nothing is ever written and no transaction exists.
 */
export class ExplainSink implements ICypherSink
{
    private static readonly NoWrites = 'an explained plan writes nothing';

    private static readonly NoReadOnly: ReadonlySet<string> = new Set();

    public readonly View: OverlaySource;

    constructor(source: ICypherSource)
    {
        this.View = new OverlaySource(source, new PendingOverlay());
    }

    public ReadOnlyMembers(): ReadonlySet<string>
    {
        return ExplainSink.NoReadOnly;
    }

    public CreateNode(): CypherNode
    {
        throw new CypherError(ExplainSink.NoWrites);
    }

    public SetProperty(): Promise<void>
    {
        return ExplainSink.Refuse();
    }

    public RemoveProperty(): Promise<void>
    {
        return ExplainSink.Refuse();
    }

    public ReplaceRelationship(): Promise<void>
    {
        return ExplainSink.Refuse();
    }

    public CreateRelationship(): Promise<boolean>
    {
        return ExplainSink.Refuse();
    }

    public DeleteRelationship(): Promise<boolean>
    {
        return ExplainSink.Refuse();
    }

    public DeleteNode(): Promise<void>
    {
        return ExplainSink.Refuse();
    }

    private static Refuse<T>(): Promise<T>
    {
        return Promise.reject(new CypherError(ExplainSink.NoWrites));
    }
}
