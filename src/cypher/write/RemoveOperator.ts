import type { Binding } from '../Binding.js';
import type { RemoveClause } from '../CypherQueryModel.js';
import type { IOperator } from '../operators/IOperator.js';
import type { TransactionSink } from './TransactionSink.js';
import { WriteSupport } from './WriteSupport.js';

/** REMOVE n.p: sets the property to null (a relationship member loses its edges) for each input row. */
export class RemoveOperator implements IOperator
{
    constructor(private readonly child: IOperator, private readonly clause: RemoveClause, private readonly sink: TransactionSink)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            for (const item of this.clause.Items)
            {
                const id = WriteSupport.RequiredNodeId(row, item.Variable);
                if (id !== undefined) await this.sink.RemoveProperty(id, item.Property);
            }
            yield row;
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
