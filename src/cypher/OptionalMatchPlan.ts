import type { Binding } from './Binding.js';
import type { MatchClause } from './CypherQueryModel.js';
import type { LogicalPlanner } from './LogicalPlanner.js';
import type { IOperator } from './operators/IOperator.js';
import type { IOptionalPlan } from './operators/OptionalApply.js';

/** The inner plan of an OPTIONAL MATCH: the match compiled over one outer row. */
export class OptionalMatchPlan implements IOptionalPlan
{
    constructor(
        private readonly planner: LogicalPlanner,
        private readonly inner: MatchClause,
        private readonly outerBound: ReadonlySet<string>,
    )
    {
    }

    public Build(row: Binding): IOperator
    {
        return this.planner.CompileInner(row, this.inner, this.outerBound);
    }
}
