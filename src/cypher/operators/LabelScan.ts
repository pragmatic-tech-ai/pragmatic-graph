import { Binding } from '../Binding.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import type { IOperator } from './IOperator.js';

/**
 * Binds every visible node that is the label (subtypes and aspect carriers included) to the variable; the deadline is
 * checked up front and per stored node examined, hidden ones included.
 */
export class LabelScan implements IOperator
{
    private static readonly Name = 'LabelScan';
    private static readonly Colon = ':';

    constructor(private readonly source: ICypherSource, private readonly variable: string, private readonly label: string, private readonly cancel?: ICancellation)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        for await (const node of this.source.ScanLabel(this.label, probe))
        {
            yield new Binding().With(this.variable, new NodeValue(node));
        }
    }

    public Describe(): string
    {
        return `${LabelScan.Name}(${this.variable}${LabelScan.Colon}${this.label})`;
    }
}
