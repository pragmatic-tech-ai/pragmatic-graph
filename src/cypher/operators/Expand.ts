import type { Binding } from '../Binding.js';
import type { RelDirection } from '../CypherEnums.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import type { IOperator } from './IOperator.js';
import { RelOrientation } from './RelOrientation.js';

/**
 * Binds each node reached over one hop from the bound source (only those that are toLabel, when given). The
 * deadline is checked up front, per input row and per edge examined (hidden ones included).
 */
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
            if (!(from instanceof NodeValue)) continue;
            for await (const step of this.source.Expand(from.Id, this.relType, this.direction, probe))
            {
                if (this.toLabel !== undefined && !this.source.IsA(step.Target, this.toLabel)) continue;
                const next = new NodeValue(step.Target);
                const out = row.With(this.toVar, next);
                yield this.relVar === undefined ? out : out.With(this.relVar, RelOrientation.Oriented(this.direction, step.Relationship, from.Id, next.Id));
            }
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
