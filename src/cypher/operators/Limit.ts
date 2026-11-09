import type { Binding } from '../Binding.js';
import type { IOperator } from './IOperator.js';

/** Passes at most `count` rows, then stops pulling its input. */
export class Limit implements IOperator
{
    constructor(private readonly child: IOperator, private readonly count: number)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        if (this.count <= 0)
        {
            return;
        }
        let emitted = 0;
        for await (const row of this.child.Rows())
        {
            yield row;
            if (++emitted >= this.count)
            {
                return;
            }
        }
    }
}
