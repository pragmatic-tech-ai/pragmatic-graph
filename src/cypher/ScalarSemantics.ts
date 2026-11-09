import { CellOrder } from '../columns/CellOrder.js';
import { DateTimeValue, DateValue, DurationValue } from '../columns/CellValue.js';
import { ArithmeticOp, ComparisonOp } from './CypherEnums.js';
import { CypherError, CypherErrorCode } from './CypherError.js';
import type { CypherScalar } from './CypherValue.js';
import { TemporalText } from './TemporalText.js';

/** Scalar type groups in the cross-type total order (ORDER BY); numbers (Int64 and Float64) share one group. */
export enum ScalarRank
{
    Number = 0,
    String = 1,
    Boolean = 2,
    Date = 3,
    DateTime = 4,
    Duration = 5,
}

/**
 * Cypher semantics of engine scalars (CellValue minus null). Integers are bigint (Int64) and decimals number
 * (Float64). Comparison follows the engine predicate rules (CellOrder): Int64 vs Float64 numerically, Date and
 * DateTime distinct, DateTime by instant, Duration only = and <>; any other cross-type comparison is false.
 * Arithmetic: Int64 with Int64 stays Int64 and raises IntegerOverflow outside the Int64 range; a Float64 operand
 * makes the result Float64; division or modulo by zero yields null.
 */
export class ScalarSemantics
{
    public static readonly Int64Min = -(2n ** 63n);
    public static readonly Int64Max = 2n ** 63n - 1n;
    private static readonly OverflowMessage = 'integer overflow: result outside the 64-bit integer range';
    private static readonly DateTag = 'date';
    private static readonly DateTimeTag = 'datetime';
    private static readonly DurationTag = 'duration';
    private static readonly KeySeparator = ':';
    private static readonly NumberTag = 'num';
    private static readonly DecimalPoint = '.';
    private static readonly FloatSuffix = '.0';
    private static readonly ExponentMarker = 'e';
    private static readonly NonFinite: ReadonlyMap<string, number> = new Map([
        [String(Number.NaN), Number.NaN], [String(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY], [String(Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY],
    ]);

    /** A JS number as a Cypher scalar: a safe integer is an Int64 (bigint), anything else a Float64. */
    public static FromNumber(n: number): bigint | number
    {
        return Number.isSafeInteger(n) ? BigInt(n) : n;
    }

    /** A host-supplied scalar with JS numbers normalised by FromNumber and bigints checked against the Int64 range. */
    public static FromHost(value: CypherScalar): CypherScalar
    {
        if (typeof value === 'number') return ScalarSemantics.FromNumber(value);
        if (typeof value === 'bigint') return ScalarSemantics.CheckInt64(value);
        return value;
    }

    /** The text of a NaN or infinite Float64: 'NaN', 'Infinity' or '-Infinity' (the `$float` tag's payload). */
    public static NonFiniteText(value: number): string
    {
        return String(value);
    }

    /** The NaN or infinite Float64 that NonFiniteText wrote, or undefined for any other text. */
    public static ParseNonFinite(text: string): number | undefined
    {
        return ScalarSemantics.NonFinite.get(text);
    }

    /** Returns the value, or raises IntegerOverflow when it is outside the Int64 range. */
    public static CheckInt64(value: bigint): bigint
    {
        if (value < ScalarSemantics.Int64Min || value > ScalarSemantics.Int64Max)
        {
            throw new CypherError(ScalarSemantics.OverflowMessage, CypherErrorCode.IntegerOverflow);
        }
        return value;
    }

    public static IsNumeric(value: CypherScalar): value is bigint | number
    {
        return typeof value === 'bigint' || typeof value === 'number';
    }

    /** An integer-valued scalar (an Int64, or a finite integral Float64) as a bigint; undefined otherwise. */
    public static AsInteger(value: CypherScalar | undefined): bigint | undefined
    {
        if (typeof value === 'bigint')
        {
            return value;
        }
        if (typeof value === 'number' && Number.isInteger(value))
        {
            return BigInt(value);
        }
        return undefined;
    }

    public static Compare(a: CypherScalar, op: ComparisonOp, b: CypherScalar): boolean
    {
        if (a instanceof DurationValue || b instanceof DurationValue)
        {
            if (!(a instanceof DurationValue) || !(b instanceof DurationValue))
            {
                return false;
            }
            if (op === ComparisonOp.Eq)
            {
                return a.Equals(b);
            }
            return op === ComparisonOp.Neq ? !a.Equals(b) : false;
        }
        const order = CellOrder.Order(a, b);
        if (order === undefined)
        {
            return false;
        }
        switch (op)
        {
            case ComparisonOp.Eq: return order === 0;
            case ComparisonOp.Neq: return order !== 0;
            case ComparisonOp.Lt: return order < 0;
            case ComparisonOp.Lte: return order <= 0;
            case ComparisonOp.Gt: return order > 0;
            case ComparisonOp.Gte: return order >= 0;
        }
        return false;
    }

    public static Equals(a: CypherScalar, b: CypherScalar): boolean
    {
        return ScalarSemantics.Compare(a, ComparisonOp.Eq, b);
    }

    public static Rank(value: CypherScalar): ScalarRank
    {
        if (ScalarSemantics.IsNumeric(value)) return ScalarRank.Number;
        if (typeof value === 'string') return ScalarRank.String;
        if (typeof value === 'boolean') return ScalarRank.Boolean;
        if (value instanceof DateValue) return ScalarRank.Date;
        if (value instanceof DateTimeValue) return ScalarRank.DateTime;
        return ScalarRank.Duration;
    }

    /**
     * Deterministic total order of two scalars of the same rank (ORDER BY, the implicit paging order). openCypher
     * orderability: NaN equals NaN and sorts above every other number. Only here; `=` and `<` (Compare) keep NaN
     * incomparable.
     */
    public static TotalOrder(a: CypherScalar, b: CypherScalar): number
    {
        if (a instanceof DurationValue && b instanceof DurationValue)
        {
            return Math.sign(a.Months - b.Months) || Math.sign(a.Days - b.Days) || ScalarSemantics.BigSign(a.Micros - b.Micros);
        }
        const aNaN = Number.isNaN(a);
        const bNaN = Number.isNaN(b);
        if (aNaN || bNaN)
        {
            return aNaN === bNaN ? 0 : aNaN ? 1 : -1;
        }
        const order = CellOrder.Order(a, b) ?? 0;
        if (order === 0 && a instanceof DateTimeValue && b instanceof DateTimeValue)
        {
            return a.Zone < b.Zone ? -1 : a.Zone > b.Zone ? 1 : 0;
        }
        return order;
    }

    /**
     * Grouping key (DISTINCT, aggregation groups, join equality) under openCypher equivalence: an Int64 and an
     * integral Float64 of the same value share one numeric key (2 and 2.0), and NaN is a single key.
     */
    public static GroupKey(value: CypherScalar): string
    {
        const s = ScalarSemantics.KeySeparator;
        if (typeof value === 'bigint') return ScalarSemantics.NumberTag + s + value.toString();
        if (typeof value === 'number')
        {
            const text = Number.isInteger(value) ? BigInt(value).toString() : String(value);
            return ScalarSemantics.NumberTag + s + text;
        }
        return ScalarSemantics.TypedKey(value);
    }

    /** Type-exact identity key (literal structural keys): an Int64 2 and a Float64 2.0 differ. */
    public static TypedKey(value: CypherScalar): string
    {
        const s = ScalarSemantics.KeySeparator;
        if (value instanceof DateValue) return ScalarSemantics.DateTag + s + value.Days;
        if (value instanceof DateTimeValue) return ScalarSemantics.DateTimeTag + s + value.Micros;
        if (value instanceof DurationValue) return ScalarSemantics.DurationTag + s + value.Months + s + value.Days + s + value.Micros;
        return `${typeof value}${s}${String(value)}`;
    }

    /**
     * Display text (toString, default column names): String() for primitives except that an integral Float64 keeps
     * a decimal point (toString(2.0) = '2.0'); ISO-8601 for temporals.
     */
    public static Text(value: CypherScalar): string
    {
        if (value instanceof DateValue) return TemporalText.FormatDate(value);
        if (value instanceof DateTimeValue) return TemporalText.FormatDateTime(value);
        if (value instanceof DurationValue) return TemporalText.FormatDuration(value);
        const text = String(value);
        if (typeof value === 'number' && Number.isInteger(value)
            && !text.includes(ScalarSemantics.DecimalPoint) && !text.includes(ScalarSemantics.ExponentMarker))
        {
            return text + ScalarSemantics.FloatSuffix;
        }
        return text;
    }

    /** a op b, or undefined (Cypher null) for unsupported operand types and division/modulo by zero. */
    public static Arithmetic(a: CypherScalar, op: ArithmeticOp, b: CypherScalar): CypherScalar | undefined
    {
        if (typeof a === 'bigint' && typeof b === 'bigint')
        {
            return ScalarSemantics.Integers(a, op, b);
        }
        if (ScalarSemantics.IsNumeric(a) && ScalarSemantics.IsNumeric(b))
        {
            return ScalarSemantics.Floats(Number(a), op, Number(b));
        }
        if (op === ArithmeticOp.Add && typeof a === 'string' && typeof b === 'string')
        {
            return a + b;
        }
        return undefined;
    }

    public static Negate(value: CypherScalar): CypherScalar | undefined
    {
        if (typeof value === 'bigint') return ScalarSemantics.CheckInt64(-value);
        if (typeof value === 'number') return -value;
        return undefined;
    }

    private static Integers(a: bigint, op: ArithmeticOp, b: bigint): bigint | undefined
    {
        switch (op)
        {
            case ArithmeticOp.Add: return ScalarSemantics.CheckInt64(a + b);
            case ArithmeticOp.Sub: return ScalarSemantics.CheckInt64(a - b);
            case ArithmeticOp.Mul: return ScalarSemantics.CheckInt64(a * b);
            // bigint division truncates toward zero and % takes the dividend's sign, as Cypher integer division does.
            case ArithmeticOp.Div: return b === 0n ? undefined : ScalarSemantics.CheckInt64(a / b);
            case ArithmeticOp.Mod: return b === 0n ? undefined : a % b;
        }
        return undefined;
    }

    private static Floats(a: number, op: ArithmeticOp, b: number): number | undefined
    {
        switch (op)
        {
            case ArithmeticOp.Add: return a + b;
            case ArithmeticOp.Sub: return a - b;
            case ArithmeticOp.Mul: return a * b;
            case ArithmeticOp.Div: return b === 0 ? undefined : a / b;
            case ArithmeticOp.Mod: return b === 0 ? undefined : a % b;
        }
        return undefined;
    }

    private static BigSign(n: bigint): number
    {
        return n < 0n ? -1 : n > 0n ? 1 : 0;
    }
}
