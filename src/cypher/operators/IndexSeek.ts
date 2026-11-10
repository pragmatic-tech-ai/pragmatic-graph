import type { Predicate } from '../../predicate/Predicate.js';
import { Binding, EvalContext } from '../Binding.js';
import { ComparisonOp } from '../CypherEnums.js';
import { CypherUnparser } from '../CypherUnparser.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue, ScalarValue, type CypherValue } from '../CypherValue.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import { BooleanExpression, Comparison, PropertyAccess, type Expression } from '../Expression.js';
import { OperatorPrinter } from '../OperatorPrinter.js';
import type { IOperator } from './IOperator.js';

/**
 * Binds the nodes of a label whose member equals a value, through an index. The value expression (a literal or
 * a parameter) is evaluated once per pass, at run time. A null or non-scalar value matches nothing, exactly as
 * the `=` filter would; when the source has no usable index after all, the pass falls back to a label scan
 * filtered by the same equality, so the rows never depend on the index. The deadline is checked up front and per
 * stored entry examined (hidden ones included), on either path. `hint` (FetchHint) goes to the seek and to the fallback
 * scan (ICypherSource.SeekEqual / ScanLabel). Explain lists the External fetches under it.
 */
export class IndexSeek implements IOperator
{
    private static readonly Open = '(';
    private static readonly Close = ')';
    private static readonly Space = ' ';
    private static readonly Dot = '.';
    private static readonly Equals = ' = ';

    constructor(
        private readonly source: ICypherSource,
        private readonly variable: string,
        private readonly label: string,
        private readonly member: string,
        private readonly indexName: string,
        private readonly value: Expression,
        private readonly parameters: ReadonlyMap<string, CypherValue>,
        private readonly cancel?: ICancellation,
        private readonly hint?: Predicate,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        const value = this.value.Evaluate(new EvalContext(new Binding(), this.parameters));
        if (!(value instanceof ScalarValue))
        {
            return;
        }
        const hits = this.source.SeekEqual(this.label, this.member, value.Value, probe, this.hint);
        if (hits !== undefined)
        {
            for await (const node of hits)
            {
                yield new Binding().With(this.variable, new NodeValue(node));
            }
            return;
        }
        const equality = new Comparison(new PropertyAccess(this.variable, this.member), ComparisonOp.Eq, this.value);
        for await (const node of this.source.ScanLabel(this.label, probe, this.hint))
        {
            const row = new Binding().With(this.variable, new NodeValue(node));
            if (BooleanExpression.Truthy(equality.Evaluate(new EvalContext(row, this.parameters))))
            {
                yield row;
            }
        }
    }

    public Describe(): string
    {
        return `IndexSeek${IndexSeek.Open}${this.indexName}${IndexSeek.Close}${IndexSeek.Space}${this.variable}${IndexSeek.Dot}${this.member}${IndexSeek.Equals}${new CypherUnparser().ExpressionText(this.value)}`;
    }

    public Details(): readonly string[]
    {
        return OperatorPrinter.FetchLines(this.source.FetchTargets(this.label));
    }
}
