import type { Binding } from '../Binding.js';
import type { SetClause } from '../CypherQueryModel.js';
import type { IOperator } from '../operators/IOperator.js';
import type { ICypherSink } from './CypherSink.js';
import type { SetApplier } from './SetApplier.js';

/** SET: applies every item of the clause, in order, to each input row. */
export class SetOperator implements IOperator
{
    constructor(private readonly child: IOperator, private readonly clause: SetClause, private readonly applier: SetApplier, private readonly sink: ICypherSink)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            let current = row;
            for (const item of this.clause.Items) current = await this.applier.Apply(current, item);
            // Per-row write step (ruling R135 E1): the row's external writes execute before it flows on.
            await this.sink.EndStep();
            yield current;
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
