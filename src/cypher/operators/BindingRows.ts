import type { Binding } from '../Binding.js';
import type { IOperator } from './IOperator.js';

/** The given rows, in order. */
export class BindingRows implements IOperator
{
    constructor(private readonly rows: readonly Binding[])
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        yield* this.rows;
    }
}
