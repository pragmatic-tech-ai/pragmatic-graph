import type { Binding } from '../Binding.js';
import type { RemoveClause } from '../CypherQueryModel.js';
import type { IOperator } from '../operators/IOperator.js';
import type { ICypherSink } from './CypherSink.js';
import { WriteSupport } from './WriteSupport.js';

/** REMOVE n.p: sets the property to null (a relationship member loses its edges) for each input row. */
export class RemoveOperator implements IOperator
{
    constructor(private readonly child: IOperator, private readonly clause: RemoveClause, private readonly sink: ICypherSink)
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
            // Per-row write step (ruling R135 E1): the row's external writes execute before it flows on.
            await this.sink.EndStep();
            yield row;
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
