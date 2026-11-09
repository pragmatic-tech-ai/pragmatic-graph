import type { Binding } from '../Binding.js';
import type { RelDirection } from '../CypherEnums.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import type { IOperator } from './IOperator.js';
import { RelOrientation } from './RelOrientation.js';

/** Binds each node reached over one hop from the bound source (only those that are toLabel, when given). */
export class Expand implements IOperator
{
    constructor(
        private readonly child: IOperator,
        private readonly source: ICypherSource,
        private readonly fromVar: string,
        private readonly toVar: string,
        private readonly relType: string | undefined,
        private readonly direction: RelDirection,
        private readonly toLabel: string | undefined,
        private readonly relVar: string | undefined = undefined,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            const from = row.Get(this.fromVar);
            if (!(from instanceof NodeValue)) continue;
            for await (const step of this.source.Expand(from.Id, this.relType, this.direction))
            {
                if (this.toLabel !== undefined && !this.source.IsA(step.Target, this.toLabel)) continue;
                const next = new NodeValue(step.Target);
                const out = row.With(this.toVar, next);
                yield this.relVar === undefined ? out : out.With(this.relVar, RelOrientation.Oriented(this.direction, step.Relationship, from.Id, next.Id));
            }
        }
    }
}
