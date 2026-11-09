import type { Binding } from '../Binding.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import type { IOperator } from './IOperator.js';

/**
 * Keeps only rows whose bound variable is a node that is the label (CatalogSnapshot.IsA: parent chain and
 * aspects). Used for a label written on a reused variable occurrence, where no scan exists to apply it. The bound
 * node is already fully loaded, so (unlike TODL) the node is not re-read.
 */
export class LabelFilter implements IOperator
{
    constructor(
        private readonly child: IOperator,
        private readonly source: ICypherSource,
        private readonly varName: string,
        private readonly label: string,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            const v = row.Get(this.varName);
            if (v instanceof NodeValue && this.source.IsA(v.Node, this.label)) yield row;
        }
    }
}
