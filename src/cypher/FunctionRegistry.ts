import { CypherValue, NodeValue, ScalarValue, NullValue, type CypherScalar } from './CypherValue.js';
import { ListValue, MapValue, PathValue } from './StructuredValues.js';
import { CypherSemanticError } from './CypherError.js';
import { ScalarSemantics } from './ScalarSemantics.js';

export interface IScalarFunction
{
    Invoke(args: readonly CypherValue[]): CypherValue;
}

abstract class FunctionBase implements IScalarFunction
{
    // Decimal notation only: rejects "Infinity", "0x10", "0b1", etc.
    protected static readonly DecimalPattern = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
    // Plain integer notation, converted exactly (no Float64 round trip).
    protected static readonly IntegerPattern = /^\s*[+-]?\d+\s*$/;

    public abstract Invoke(args: readonly CypherValue[]): CypherValue;

    protected static Str(v: CypherValue | undefined): string | undefined
    {
        return v instanceof ScalarValue && typeof v.Value === 'string' ? v.Value : undefined;
    }

    // A numeric argument (Int64 or Float64) as is.
    protected static Numeric(v: CypherValue | undefined): bigint | number | undefined
    {
        return v instanceof ScalarValue && ScalarSemantics.IsNumeric(v.Value) ? v.Value : undefined;
    }

    // An integer-valued argument (Int64, or an integral Float64) as a bigint; a fractional Float64 is undefined.
    protected static Int(v: CypherValue | undefined): bigint | undefined
    {
        return v instanceof ScalarValue ? ScalarSemantics.AsInteger(v.Value) : undefined;
    }

    // An Int64 result, or null when it falls outside the Int64 range.
    protected static Int64OrNull(n: bigint): CypherValue
    {
        return n < ScalarSemantics.Int64Min || n > ScalarSemantics.Int64Max ? NullValue.Instance : new ScalarValue(n);
    }

    protected static List(v: CypherValue | undefined): ListValue | undefined
    {
        return v instanceof ListValue ? v : undefined;
    }

    protected static Wrap(v: CypherScalar | undefined): CypherValue
    {
        return v === undefined ? NullValue.Instance : new ScalarValue(v);
    }
}

class CoalesceFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        return args.find((a) => !(a instanceof NullValue)) ?? NullValue.Instance;
    }
}

class ToStringFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const a = args[0];
        if (!(a instanceof ScalarValue)) return NullValue.Instance;
        return new ScalarValue(ScalarSemantics.Text(a.Value));
    }
}

// Int64 result; a Float64 or decimal string truncates toward zero; null for non-numeric, non-finite or out-of-range.
class ToIntegerFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const a = args[0];
        if (!(a instanceof ScalarValue)) return NullValue.Instance;
        if (typeof a.Value === 'bigint') return a;
        if (typeof a.Value === 'string' && FunctionBase.IntegerPattern.test(a.Value)) return FunctionBase.Int64OrNull(BigInt(a.Value.trim()));
        const n = typeof a.Value === 'number' ? a.Value : typeof a.Value === 'string' && FunctionBase.DecimalPattern.test(a.Value) ? Number(a.Value) : Number.NaN;
        return Number.isFinite(n) ? FunctionBase.Int64OrNull(BigInt(Math.trunc(n))) : NullValue.Instance;
    }
}

class ToFloatFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const a = args[0];
        if (!(a instanceof ScalarValue)) return NullValue.Instance;
        const n = typeof a.Value === 'number' || typeof a.Value === 'bigint'
            ? Number(a.Value)
            : typeof a.Value === 'string' && FunctionBase.DecimalPattern.test(a.Value) ? Number(a.Value) : Number.NaN;
        return Number.isFinite(n) ? new ScalarValue(n) : NullValue.Instance;
    }
}

class SizeFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const a = args[0];
        if (a instanceof ListValue) return new ScalarValue(BigInt(a.Items.length));
        const s = FunctionBase.Str(a);
        return s === undefined ? NullValue.Instance : new ScalarValue(BigInt(s.length));
    }
}

class HeadFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        return FunctionBase.List(args[0])?.Items[0] ?? NullValue.Instance;
    }
}

class LastFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const l = FunctionBase.List(args[0]);
        return l === undefined ? NullValue.Instance : l.Items[l.Items.length - 1] ?? NullValue.Instance;
    }
}

class TailFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const l = FunctionBase.List(args[0]);
        return l === undefined ? NullValue.Instance : new ListValue(l.Items.slice(1));
    }
}

class ReverseFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const l = FunctionBase.List(args[0]);
        return l === undefined ? NullValue.Instance : new ListValue([...l.Items].reverse());
    }
}

class RangeFunction extends FunctionBase
{
    private static readonly NonFiniteBound = 'range() bounds and step must be finite numbers';
    private static readonly TooLarge = 'range() would produce too many elements';
    private static readonly MaxElements = 10_000_000n;

    // Checks in TODL's order: a non-numeric argument or a zero step yields null, a non-finite one throws; then (engine
    // rule) a fractional bound or step yields null, since the elements are Int64.
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const ra = FunctionBase.Numeric(args[0]);
        const rb = FunctionBase.Numeric(args[1]);
        const rstep = args.length > 2 ? FunctionBase.Numeric(args[2]) : 1n;
        if (ra === undefined || rb === undefined || rstep === undefined || Number(rstep) === 0) return NullValue.Instance;
        if ([ra, rb, rstep].some((v) => typeof v === 'number' && !Number.isFinite(v)))
        {
            throw new CypherSemanticError(RangeFunction.NonFiniteBound);
        }
        const a = ScalarSemantics.AsInteger(ra);
        const b = ScalarSemantics.AsInteger(rb);
        const step = ScalarSemantics.AsInteger(rstep);
        if (a === undefined || b === undefined || step === undefined) return NullValue.Instance;
        if ((b - a) / step >= RangeFunction.MaxElements)
        {
            throw new CypherSemanticError(RangeFunction.TooLarge);
        }
        const out: CypherValue[] = [];
        for (let i = a; step > 0n ? i <= b : i >= b; i += step) out.push(new ScalarValue(i));
        return new ListValue(out);
    }
}

class KeysFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const m = args[0];
        if (!(m instanceof MapValue)) return NullValue.Instance;
        return new ListValue([...m.Entries.keys()].map((k) => new ScalarValue(k)));
    }
}

class ToUpperFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        return FunctionBase.Wrap(FunctionBase.Str(args[0])?.toUpperCase());
    }
}

class ToLowerFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        return FunctionBase.Wrap(FunctionBase.Str(args[0])?.toLowerCase());
    }
}

class TrimFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        return FunctionBase.Wrap(FunctionBase.Str(args[0])?.trim());
    }
}

class SubstringFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const s = FunctionBase.Str(args[0]);
        const start = FunctionBase.Int(args[1]);
        if (s === undefined || start === undefined) return NullValue.Instance;
        if (args.length > 2)
        {
            const len = FunctionBase.Int(args[2]);
            return len === undefined ? NullValue.Instance : new ScalarValue(s.substring(Number(start), Number(start + len)));
        }
        return new ScalarValue(s.substring(Number(start)));
    }
}

class ReplaceFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const s = FunctionBase.Str(args[0]);
        const search = FunctionBase.Str(args[1]);
        const repl = FunctionBase.Str(args[2]);
        if (s === undefined || search === undefined || repl === undefined) return NullValue.Instance;
        return new ScalarValue(s.split(search).join(repl));
    }
}

// The node's public id (Neo4j 5 elementId); null for null, a Cypher type error for anything but a node.
class ElementIdFunction extends FunctionBase
{
    private static readonly NotANode = 'elementId() takes a node';

    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const a = args[0];
        if (a instanceof NullValue) return NullValue.Instance;
        if (!(a instanceof NodeValue)) throw new CypherSemanticError(ElementIdFunction.NotANode);
        return new ScalarValue(a.Node.PublicId);
    }
}

class PathLengthFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const p = args[0];
        return p instanceof PathValue ? new ScalarValue(BigInt(p.Length())) : NullValue.Instance;
    }
}

class PathNodesFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const p = args[0];
        return p instanceof PathValue ? new ListValue([...p.Nodes]) : NullValue.Instance;
    }
}

class PathRelationshipsFunction extends FunctionBase
{
    public Invoke(args: readonly CypherValue[]): CypherValue
    {
        const p = args[0];
        return p instanceof PathValue ? new ListValue([...p.Rels]) : NullValue.Instance;
    }
}

export class FunctionRegistry
{
    private static readonly CoalesceName = 'coalesce';
    private static readonly ToStringName = 'tostring';
    private static readonly ToIntegerName = 'tointeger';
    private static readonly ToFloatName = 'tofloat';
    private static readonly SizeName = 'size';
    private static readonly HeadName = 'head';
    private static readonly LastName = 'last';
    private static readonly TailName = 'tail';
    private static readonly ReverseName = 'reverse';
    private static readonly RangeName = 'range';
    private static readonly KeysName = 'keys';
    private static readonly ToUpperName = 'toupper';
    private static readonly ToLowerName = 'tolower';
    private static readonly TrimName = 'trim';
    private static readonly SubstringName = 'substring';
    private static readonly ReplaceName = 'replace';
    public static readonly ElementIdName = 'elementid';
    private static readonly LengthName = 'length';
    private static readonly NodesName = 'nodes';
    private static readonly RelationshipsName = 'relationships';
    private static readonly CountName = 'count';
    private static readonly CollectName = 'collect';
    private static readonly SumName = 'sum';
    private static readonly AvgName = 'avg';
    private static readonly MinName = 'min';
    private static readonly MaxName = 'max';

    private static readonly Aggregates: ReadonlySet<string> = new Set([FunctionRegistry.CountName, FunctionRegistry.CollectName, FunctionRegistry.SumName, FunctionRegistry.AvgName, FunctionRegistry.MinName, FunctionRegistry.MaxName]);

    private static readonly Scalars: ReadonlyMap<string, IScalarFunction> = new Map<string, IScalarFunction>([
        [FunctionRegistry.CoalesceName, new CoalesceFunction()],
        [FunctionRegistry.ToStringName, new ToStringFunction()],
        [FunctionRegistry.ToIntegerName, new ToIntegerFunction()],
        [FunctionRegistry.ToFloatName, new ToFloatFunction()],
        [FunctionRegistry.SizeName, new SizeFunction()],
        [FunctionRegistry.HeadName, new HeadFunction()],
        [FunctionRegistry.LastName, new LastFunction()],
        [FunctionRegistry.TailName, new TailFunction()],
        [FunctionRegistry.ReverseName, new ReverseFunction()],
        [FunctionRegistry.RangeName, new RangeFunction()],
        [FunctionRegistry.KeysName, new KeysFunction()],
        [FunctionRegistry.ToUpperName, new ToUpperFunction()],
        [FunctionRegistry.ToLowerName, new ToLowerFunction()],
        [FunctionRegistry.TrimName, new TrimFunction()],
        [FunctionRegistry.SubstringName, new SubstringFunction()],
        [FunctionRegistry.ReplaceName, new ReplaceFunction()],
        [FunctionRegistry.ElementIdName, new ElementIdFunction()],
        [FunctionRegistry.LengthName, new PathLengthFunction()],
        [FunctionRegistry.NodesName, new PathNodesFunction()],
        [FunctionRegistry.RelationshipsName, new PathRelationshipsFunction()],
    ]);

    public static Scalar(name: string): IScalarFunction | undefined
    {
        return FunctionRegistry.Scalars.get(name.toLowerCase());
    }

    public static IsAggregate(name: string): boolean
    {
        return FunctionRegistry.Aggregates.has(name.toLowerCase());
    }
}
