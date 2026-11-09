import { Binding } from '../Binding.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import type { IOperator } from './IOperator.js';

/** Binds every visible node that is the label (subtypes and aspect carriers included) to the variable. */
export class LabelScan implements IOperator
{
    constructor(private readonly source: ICypherSource, private readonly variable: string, private readonly label: string)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const node of this.source.ScanLabel(this.label))
        {
            yield new Binding().With(this.variable, new NodeValue(node));
        }
    }
}
