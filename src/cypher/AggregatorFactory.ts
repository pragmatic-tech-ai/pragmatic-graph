import { CypherValue, ScalarValue, NullValue } from './CypherValue.js';
import { ListValue } from './StructuredValues.js';
import { CypherSemanticError } from './CypherError.js';
import { ArithmeticOp } from './CypherEnums.js';
import { ScalarSemantics } from './ScalarSemantics.js';

export interface IAggregator
{
    Accept(value: CypherValue): void;
    Result(): CypherValue;
}

export class CountAggregator implements IAggregator
{
    private count = 0n;

    constructor(private readonly countStar: boolean)
    {
    }

    public Accept(value: CypherValue): void
    {
        if (this.countStar || !(value instanceof NullValue))
        {
            this.count++;
        }
    }

    public Result(): CypherValue
    {
        return new ScalarValue(this.count);
    }
}

export class CollectAggregator implements IAggregator
{
    private readonly items: CypherValue[] = [];

    public Accept(value: CypherValue): void
    {
        if (!(value instanceof NullValue))
        {
            this.items.push(value);
        }
    }

    public Result(): CypherValue
    {
        return new ListValue([...this.items]);
    }
}

// Sums numeric values: Int64 while every input is an Int64 (IntegerOverflow outside the range), Float64 once any
// input is; 0 (Int64) over no input.
export class SumAggregator implements IAggregator
{
    private total: bigint | number = 0n;

    public Accept(value: CypherValue): void
    {
        if (value instanceof ScalarValue && ScalarSemantics.IsNumeric(value.Value))
        {
            this.total = ScalarSemantics.Arithmetic(this.total, ArithmeticOp.Add, value.Value) as bigint | number;
        }
    }

    public Result(): CypherValue
    {
        return new ScalarValue(this.total);
    }
}

// Mean of the numeric values as a Float64; null over no numeric input.
export class AvgAggregator implements IAggregator
{
    private total = 0;
    private n = 0;

    public Accept(value: CypherValue): void
    {
        if (value instanceof ScalarValue && ScalarSemantics.IsNumeric(value.Value))
        {
            this.total += Number(value.Value);
            this.n++;
        }
    }

    public Result(): CypherValue
    {
        return this.n === 0 ? NullValue.Instance : new ScalarValue(this.total / this.n);
    }
}

/** min / max under the ORDER BY total order (CypherValue.Compare): nulls are skipped and NaN is the largest number. */
abstract class ExtremeAggregator implements IAggregator
{
    private best: CypherValue | null = null;

    protected abstract Prefers(cmp: number): boolean;

    public Accept(value: CypherValue): void
    {
        if (value instanceof NullValue)
        {
            return;
        }
        if (this.best === null || this.Prefers(CypherValue.Compare(value, this.best)))
        {
            this.best = value;
        }
    }

    public Result(): CypherValue
    {
        return this.best ?? NullValue.Instance;
    }
}

export class MinAggregator extends ExtremeAggregator
{
    protected Prefers(cmp: number): boolean
    {
        return cmp < 0;
    }
}

export class MaxAggregator extends ExtremeAggregator
{
    protected Prefers(cmp: number): boolean
    {
        return cmp > 0;
    }
}

export class AggregatorFactory
{
    private static readonly CountName = 'count';
    private static readonly CollectName = 'collect';
    private static readonly SumName = 'sum';
    private static readonly AvgName = 'avg';
    private static readonly MinName = 'min';
    private static readonly MaxName = 'max';
    private static readonly UnknownMessage = 'Unknown aggregate function: ';

    public static Create(name: string, countStar: boolean): IAggregator
    {
        switch (name.toLowerCase())
        {
            case AggregatorFactory.CountName: return new CountAggregator(countStar);
            case AggregatorFactory.CollectName: return new CollectAggregator();
            case AggregatorFactory.SumName: return new SumAggregator();
            case AggregatorFactory.AvgName: return new AvgAggregator();
            case AggregatorFactory.MinName: return new MinAggregator();
            case AggregatorFactory.MaxName: return new MaxAggregator();
        }
        throw new CypherSemanticError(AggregatorFactory.UnknownMessage + name);
    }
}
