import { type Binding, EvalContext } from '../Binding.js';
import type { CypherValue } from '../CypherValue.js';
import { BooleanExpression, type Expression } from '../Expression.js';
import type { IOperator } from './IOperator.js';

/** Keeps the rows on which the predicate is true (null and false drop the row). */
export class Filter implements IOperator
{
    constructor(private readonly child: IOperator, private readonly predicate: Expression, private readonly parameters: ReadonlyMap<string, CypherValue>)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            const ctx = new EvalContext(row, this.parameters);
            if (BooleanExpression.Truthy(this.predicate.Evaluate(ctx))) yield row;
        }
    }
}
