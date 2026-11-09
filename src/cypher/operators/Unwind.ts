import { type Binding, EvalContext } from '../Binding.js';
import { NullValue, type CypherValue } from '../CypherValue.js';
import type { Expression } from '../Expression.js';
import { ListValue } from '../StructuredValues.js';
import type { IOperator } from './IOperator.js';

/** One row per list element bound to the variable; a null yields no row, any other value one row. */
export class Unwind implements IOperator
{
    constructor(
        private readonly child: IOperator,
        private readonly expr: Expression,
        private readonly variable: string,
        private readonly parameters: ReadonlyMap<string, CypherValue>,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            const value = this.expr.Evaluate(new EvalContext(row, this.parameters));
            if (value instanceof NullValue)
            {
                continue;
            }
            if (value instanceof ListValue)
            {
                for (const item of value.Items)
                {
                    yield row.With(this.variable, item);
                }
            }
            else
            {
                yield row.With(this.variable, value);
            }
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
