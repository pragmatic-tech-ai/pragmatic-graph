import type { Binding } from '../Binding.js';
import type { RelDirection } from '../CypherEnums.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import type { IOperator } from './IOperator.js';
import { RelOrientation } from './RelOrientation.js';

/**
 * Expands from an already-bound source into an already-bound target, constraining the reached node to equal the
 * target rather than rebinding it. Adds no node binding: it yields the row (plus the relationship variable, if
 * any) once when the target is reachable over the relationship, so a reused target variable (converging joins,
 * cycles) is constrained, never clobbered. The deadline is checked up front, per input row and per edge read.
 */
export class ExpandInto implements IOperator
{
    constructor(
        private readonly child: IOperator,
        private readonly source: ICypherSource,
        private readonly fromVar: string,
        private readonly toVar: string,
        private readonly relType: string | undefined,
        private readonly direction: RelDirection,
        private readonly relVar: string | undefined = undefined,
        private readonly cancel?: ICancellation,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        for await (const row of this.child.Rows())
        {
            probe.Tick();
            const from = row.Get(this.fromVar);
            const to = row.Get(this.toVar);
            if (!(from instanceof NodeValue) || !(to instanceof NodeValue)) continue;
            for await (const step of this.source.Expand(from.Id, this.relType, this.direction))
            {
                probe.Tick();
                if (step.Target.PublicId === to.Id)
                {
                    yield this.relVar === undefined ? row : row.With(this.relVar, RelOrientation.Oriented(this.direction, step.Relationship, from.Id, to.Id));
                    break;
                }
            }
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
