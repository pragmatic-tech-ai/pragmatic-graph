import { Binding } from '../Binding.js';
import type { ICypherSource } from '../CypherSource.js';
import { CypherUnparser } from '../CypherUnparser.js';
import { NodeValue, type CypherValue } from '../CypherValue.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import type { IdSeekTerm } from '../IdSeekTerm.js';
import { OperatorPrinter } from '../OperatorPrinter.js';
import type { IOperator } from './IOperator.js';

/**
 * Binds the visible nodes with the public ids an `elementId(v) = x` or `elementId(v) IN xs` conjunct names (ruling
 * R121 F2), through ICypherSource.NodesById: no scan of the label. The ids are evaluated once per pass, at run time.
 * Scoped like a label scan (an invisible id yields no row). Explain lists the External fetches under it.
 */
export class IdSeek implements IOperator
{
    private static readonly Name = 'IdSeek';
    private static readonly Colon = ':';
    private static readonly Equals = ' = ';
    private static readonly In = ' IN ';

    constructor(
        private readonly source: ICypherSource,
        private readonly variable: string,
        private readonly label: string | undefined,
        private readonly term: IdSeekTerm,
        private readonly parameters: ReadonlyMap<string, CypherValue>,
        private readonly cancel?: ICancellation,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        const ids = this.term.Ids(this.parameters);
        if (ids.length === 0)
        {
            return;
        }
        for await (const node of this.source.NodesById(ids, this.label, probe))
        {
            yield new Binding().With(this.variable, new NodeValue(node));
        }
    }

    public Describe(): string
    {
        const label = this.label === undefined ? '' : `${IdSeek.Colon}${this.label}`;
        const op = this.term.Single ? IdSeek.Equals : IdSeek.In;
        return `${IdSeek.Name}(${this.variable}${label})${op}${new CypherUnparser().ExpressionText(this.term.Operand)}`;
    }

    public Details(): readonly string[]
    {
        return this.label === undefined ? [] : OperatorPrinter.FetchLines(this.source.FetchTargets(this.label));
    }
}
