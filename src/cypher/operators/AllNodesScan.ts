import { Binding } from '../Binding.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import type { IOperator } from './IOperator.js';

/** Binds every visible node to the variable, per concept then slot order. */
export class AllNodesScan implements IOperator
{
    private static readonly Name = 'AllNodesScan';

    constructor(private readonly source: ICypherSource, private readonly variable: string)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const node of this.source.ScanAll())
        {
            yield new Binding().With(this.variable, new NodeValue(node));
        }
    }

    public Describe(): string
    {
        return `${AllNodesScan.Name}(${this.variable})`;
    }
}
