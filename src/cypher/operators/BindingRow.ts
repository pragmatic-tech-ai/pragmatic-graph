import type { Binding } from '../Binding.js';
import type { IOperator } from './IOperator.js';

/** Exactly the given row (the outer row of an OPTIONAL MATCH inner plan). */
export class BindingRow implements IOperator
{
    constructor(private readonly row: Binding)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        yield this.row;
    }
}
