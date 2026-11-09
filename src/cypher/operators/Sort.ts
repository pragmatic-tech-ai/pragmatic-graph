import { type Binding, EvalContext } from '../Binding.js';
import { CypherValue } from '../CypherValue.js';
import type { SortItem } from '../CypherQueryModel.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import type { IOperator } from './IOperator.js';
import { SortEntry } from './SortEntry.js';

/** Buffers its input and emits it in sort-key order (CypherValue.Compare); stable, so ties keep input order. */
export class Sort implements IOperator
{
    constructor(
        private readonly child: IOperator,
        private readonly keys: readonly SortItem[],
        private readonly parameters: ReadonlyMap<string, CypherValue>,
        private readonly cancel?: ICancellation,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const buffered: SortEntry[] = [];
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        for await (const row of this.child.Rows())
        {
            probe.Tick();
            const ctx = new EvalContext(row, this.parameters);
            buffered.push(new SortEntry(row, this.keys.map((k) => k.Expr.Evaluate(ctx))));
        }
        buffered.sort((a, b) => this.CompareEntries(a, b));
        for (const entry of buffered)
        {
            yield entry.Row;
        }
    }

    private CompareEntries(a: SortEntry, b: SortEntry): number
    {
        for (let i = 0; i < this.keys.length; i++)
        {
            const c = CypherValue.Compare(a.Keys[i]!, b.Keys[i]!);
            if (c !== 0)
            {
                return this.keys[i]!.Descending ? -c : c;
            }
        }
        return 0;
    }
}
