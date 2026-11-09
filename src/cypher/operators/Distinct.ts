import type { Binding } from '../Binding.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import type { IOperator } from './IOperator.js';

/** Passes the first row of each distinct tuple of column equivalence keys. */
export class Distinct implements IOperator
{
    private static readonly MissingKey = 'undefined';

    constructor(private readonly child: IOperator, private readonly columns: readonly string[], private readonly cancel?: ICancellation)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const seen = new Set<string>();
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        for await (const row of this.child.Rows())
        {
            probe.Tick();
            // JSON-encode the per-column keys so a key containing any separator cannot merge distinct rows.
            const key = JSON.stringify(this.columns.map((c) => row.Get(c)?.GroupKey() ?? Distinct.MissingKey));
            if (!seen.has(key))
            {
                seen.add(key);
                yield row;
            }
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
