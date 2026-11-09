import { Binding, EvalContext } from '../Binding.js';
import type { CypherValue } from '../CypherValue.js';
import type { ReturnItem } from '../CypherQueryModel.js';
import type { IOperator } from './IOperator.js';

/** Evaluates the projection items of each row into a new row of named columns. */
export class Project implements IOperator
{
    constructor(private readonly child: IOperator, private readonly items: readonly ReturnItem[], private readonly parameters: ReadonlyMap<string, CypherValue>)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            const ctx = new EvalContext(row, this.parameters);
            let projected = new Binding();
            for (const item of this.items)
            {
                projected = projected.With(item.ColumnName(), item.Expr.Evaluate(ctx));
            }
            yield projected;
        }
    }
}
