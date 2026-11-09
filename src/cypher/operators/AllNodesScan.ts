import { Binding } from '../Binding.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import type { IOperator } from './IOperator.js';

/** Binds every visible node to the variable, per concept then slot order; the deadline is checked up front and per node read. */
export class AllNodesScan implements IOperator
{
    private static readonly Name = 'AllNodesScan';

    constructor(private readonly source: ICypherSource, private readonly variable: string, private readonly cancel?: ICancellation)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        for await (const node of this.source.ScanAll())
        {
            probe.Tick();
            yield new Binding().With(this.variable, new NodeValue(node));
        }
    }

    public Describe(): string
    {
        return `${AllNodesScan.Name}(${this.variable})`;
    }
}
