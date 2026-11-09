import type { Binding } from '../Binding.js';
import type { IOperator } from './IOperator.js';

/** Drops the first `count` rows. */
export class Skip implements IOperator
{
    private readonly count: number;

    constructor(private readonly child: IOperator, count: number)
    {
        // Clamp to a non-negative integer; NaN skips nothing.
        this.count = Number.isNaN(count) ? 0 : Math.max(0, Math.trunc(count));
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        let seen = 0;
        for await (const row of this.child.Rows())
        {
            if (seen++ >= this.count)
            {
                yield row;
            }
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
