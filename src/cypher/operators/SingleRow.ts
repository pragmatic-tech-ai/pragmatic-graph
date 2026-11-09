import { Binding } from '../Binding.js';
import type { IOperator } from './IOperator.js';

/** One empty row: the input of a query part that reads nothing. */
export class SingleRow implements IOperator
{
    public async *Rows(): AsyncIterable<Binding>
    {
        yield new Binding();
    }
}
