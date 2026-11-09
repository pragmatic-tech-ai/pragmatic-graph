import type { Binding } from '../Binding.js';
import { CypherSemanticError } from '../CypherError.js';
import type { MergeClause, SetItem } from '../CypherQueryModel.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeRefValue, NodeValue, NullValue } from '../CypherValue.js';
import type { PatternPath } from '../PatternPath.js';
import type { IOperator } from '../operators/IOperator.js';
import type { IOptionalPlan } from '../operators/OptionalApply.js';
import { PathCreator } from './PathCreator.js';
import type { SetApplier } from './SetApplier.js';
import type { TransactionSink } from './TransactionSink.js';
import { WriteSupport } from './WriteSupport.js';

/**
 * MERGE: matches the whole pattern (bound variables fixed) through the overlay, yielding every match with
 * ON MATCH applied; when nothing matches, writes the whole pattern (every unbound node and every relationship)
 * and applies ON CREATE. The match reads the overlay, so a later row sees what an earlier row merged (TODL's
 * no-overlay fallback bookkeeping is not needed).
 */
export class MergeOperator implements IOperator
{
    private readonly creator: PathCreator;

    constructor(
        private readonly child: IOperator,
        private readonly clause: MergeClause,
        source: ICypherSource,
        private readonly sink: TransactionSink,
        private readonly applier: SetApplier,
        // The MERGE pattern compiled as a match over one input row (its bound variables fixed).
        private readonly matcher: IOptionalPlan,
        bound: ReadonlySet<string>,
    )
    {
        MergeOperator.Validate(clause.Pattern, bound);
        PathCreator.ValidateLabels(source, clause.Pattern, bound);
        this.creator = new PathCreator(source, sink);
    }

    /** Everything that would make the write invalid is rejected before the first row writes anything. */
    private static Validate(pattern: PatternPath, bound: ReadonlySet<string>): void
    {
        if (pattern.Nodes.length === 0) throw new CypherSemanticError(WriteSupport.MergeNeedsNode);
        if (pattern.PathVariable !== undefined) throw new CypherSemanticError(WriteSupport.MergePathVariable);
        PathCreator.ValidateRels(pattern);
        for (const node of pattern.Nodes)
        {
            if (node.Variable !== undefined && bound.has(node.Variable))
            {
                if (node.Label !== undefined || node.Properties.size > 0)
                {
                    throw new CypherSemanticError(`${WriteSupport.MergeBoundConstrained}: "${node.Variable}"`);
                }
            }
            else if (node.Label === undefined)
            {
                throw new CypherSemanticError(WriteSupport.LabelRequired);
            }
        }
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            this.CheckBound(row);
            const matches: Binding[] = [];
            for await (const match of this.matcher.Build(row).Rows()) matches.push(match);
            if (matches.length > 0)
            {
                for (const match of matches) yield await this.ApplyActions(match, this.clause.OnMatch);
                continue;
            }
            const created = await this.creator.Create(row, this.clause.Pattern);
            yield await this.ApplyActions(created, this.clause.OnCreate);
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }

    private CheckBound(row: Binding): void
    {
        for (const node of this.clause.Pattern.Nodes)
        {
            const value = node.Variable === undefined ? undefined : row.Get(node.Variable);
            if (value === undefined) continue;
            if (value instanceof NullValue) throw new CypherSemanticError(`${WriteSupport.MergeBoundNull}: "${node.Variable}"`);
            if (!(value instanceof NodeValue || value instanceof NodeRefValue))
            {
                throw new CypherSemanticError(`${WriteSupport.MergeBoundNotNode}: "${node.Variable}"`);
            }
        }
    }

    private async ApplyActions(row: Binding, items: readonly SetItem[]): Promise<Binding>
    {
        let current = row;
        for (const item of items) current = await this.applier.Apply(current, item);
        return this.sink.View.RefreshRow(current);
    }
}
