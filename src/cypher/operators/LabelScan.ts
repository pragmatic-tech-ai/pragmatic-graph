import type { Predicate } from '../../predicate/Predicate.js';
import { Binding } from '../Binding.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import { OperatorPrinter } from '../OperatorPrinter.js';
import type { IOperator } from './IOperator.js';

/**
 * Binds every visible node that is the label (subtypes and aspect carriers included) to the variable; the deadline is
 * checked up front and per stored node examined, hidden ones included. `hint` is the anchor's push-down hint
 * (FetchHint), passed to the source's scan; explain lists the scan's External fetches under it.
 */
export class LabelScan implements IOperator
{
    private static readonly Name = 'LabelScan';
    private static readonly Colon = ':';

    constructor(private readonly source: ICypherSource, private readonly variable: string, private readonly label: string, private readonly cancel?: ICancellation, private readonly hint?: Predicate)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        for await (const node of this.source.ScanLabel(this.label, probe, this.hint))
        {
            yield new Binding().With(this.variable, new NodeValue(node));
        }
    }

    public Describe(): string
    {
        return `${LabelScan.Name}(${this.variable}${LabelScan.Colon}${this.label})`;
    }

    public Details(): readonly string[]
    {
        return OperatorPrinter.FetchLines(this.source.FetchTargets(this.label));
    }
}
