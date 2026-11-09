import type { Binding } from '../Binding.js';
import type { DeleteClause } from '../CypherQueryModel.js';
import type { CypherValue } from '../CypherValue.js';
import type { IOperator } from '../operators/IOperator.js';
import type { ICypherSink } from './CypherSink.js';
import { WriteSupport } from './WriteSupport.js';

/** [DETACH] DELETE: deletes every target node of each input row (null targets are skipped). */
export class DeleteOperator implements IOperator
{
    constructor(
        private readonly child: IOperator,
        private readonly clause: DeleteClause,
        private readonly sink: ICypherSink,
        private readonly parameters: ReadonlyMap<string, CypherValue>,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            for (const target of this.clause.Targets)
            {
                const id = WriteSupport.NodeId(WriteSupport.Eval(target, row, this.parameters));
                if (id !== undefined) await this.sink.DeleteNode(id, this.clause.Detach);
            }
            yield row;
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
