import type { Binding } from '../Binding.js';
import { WriteMode } from '../CypherEnums.js';
import type { SetClause } from '../CypherQueryModel.js';
import type { IOperator } from '../operators/IOperator.js';
import type { ICypherSink } from './CypherSink.js';
import type { SetApplier } from './SetApplier.js';
import { WriteSupport } from './WriteSupport.js';

/**
 * SET: applies every item of the clause, in order, to each input row. PerRow flushes each row's external writes at
 * once; Batched records every row's changes and lets the one closing step (the next clause, or the commit) flush
 * them together (ruling R140 E10).
 */
export class SetOperator implements IOperator
{
    constructor(private readonly child: IOperator, private readonly clause: SetClause, private readonly applier: SetApplier, private readonly sink: ICypherSink, private readonly mode: WriteMode = WriteMode.PerRow)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            let current = row;
            for (const item of this.clause.Items) current = await this.applier.Apply(current, item);
            // Per-row write step (ruling R135 E1): the row's external writes execute before it flows on.
            if (this.mode === WriteMode.PerRow) await this.sink.EndStep();
            yield current;
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }

    public Details(): readonly string[]
    {
        return [WriteSupport.ModeLabel(this.mode)];
    }
}
