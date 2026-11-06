import { DateTimeValue, DateValue, DurationValue, type CellValue } from '../columns/CellValue.js';
import { And, Compare, CompareOp, IdIn, In, IsNull, Not, Or, Predicate, PredicateKind } from './Predicate.js';
import { PredicateError, PredicateErrorCode } from './PredicateError.js';

/** Internal three-valued truth (SQL style). Unknown arises only from null/absent operands. */
enum Tri
{
    False = 0,
    True = 1,
    Unknown = 2,
}

/**
 * Evaluates a node-local predicate against one node's own values. Three-valued internally (a null
 * or absent operand makes a comparison Unknown; Not of Unknown stays Unknown; And/Or follow Kleene
 * logic) and collapsed to false only at the top of Matches. A comparison across value types, or
 * involving NaN, is plainly false. Int64 vs Float64 compare numerically; strings by UTF-8 byte
 * order; DateTimes by Micros (zone ignored); Date and DateTime are distinct types; Durations
 * support only Eq/Ne.
 */
export class NodeEvaluator
{
    private static readonly NotNodeLocalMessage = 'Predicate needs the graph reader and cannot be evaluated against a node alone.';
    private static readonly UnknownKindMessage = 'Unknown predicate kind.';

    public static Matches(p: Predicate, values: ReadonlyMap<string, CellValue>, publicId: string): boolean
    {
        if (!p.IsNodeLocal)
        {
            throw new PredicateError(PredicateErrorCode.NotNodeLocal, NodeEvaluator.NotNodeLocalMessage);
        }
        return NodeEvaluator.Eval(p, values, publicId) === Tri.True;
    }

    private static Eval(p: Predicate, values: ReadonlyMap<string, CellValue>, publicId: string): Tri
    {
        switch (p.Kind)
        {
            case PredicateKind.True:
                return Tri.True;
            case PredicateKind.False:
                return Tri.False;
            case PredicateKind.Compare:
            {
                const c = p as Compare;
                return NodeEvaluator.CompareValues(values.get(c.Member) ?? null, c.Op, c.Value);
            }
            case PredicateKind.In:
                return NodeEvaluator.EvalIn(p as In, values);
            case PredicateKind.IsNull:
                return (values.get((p as IsNull).Member) ?? null) === null ? Tri.True : Tri.False;
            case PredicateKind.IdIn:
                return (p as IdIn).Ids.has(publicId) ? Tri.True : Tri.False;
            case PredicateKind.And:
                return NodeEvaluator.EvalAnd(p as And, values, publicId);
            case PredicateKind.Or:
                return NodeEvaluator.EvalOr(p as Or, values, publicId);
            case PredicateKind.Not:
            {
                const inner = NodeEvaluator.Eval((p as Not).Term, values, publicId);
                return inner === Tri.Unknown ? Tri.Unknown : inner === Tri.True ? Tri.False : Tri.True;
            }
            default:
                throw new PredicateError(PredicateErrorCode.NotNodeLocal, NodeEvaluator.UnknownKindMessage);
        }
    }

    private static EvalAnd(p: And, values: ReadonlyMap<string, CellValue>, publicId: string): Tri
    {
        let result = Tri.True;
        for (const term of p.Terms)
        {
            const t = NodeEvaluator.Eval(term, values, publicId);
            if (t === Tri.False)
            {
                return Tri.False;
            }
            if (t === Tri.Unknown)
            {
                result = Tri.Unknown;
            }
        }
        return result;
    }

    private static EvalOr(p: Or, values: ReadonlyMap<string, CellValue>, publicId: string): Tri
    {
        let result = Tri.False;
        for (const term of p.Terms)
        {
            const t = NodeEvaluator.Eval(term, values, publicId);
            if (t === Tri.True)
            {
                return Tri.True;
            }
            if (t === Tri.Unknown)
            {
                result = Tri.Unknown;
            }
        }
        return result;
    }

    private static EvalIn(p: In, values: ReadonlyMap<string, CellValue>): Tri
    {
        const v = values.get(p.Member) ?? null;
        if (v === null)
        {
            return Tri.Unknown;
        }
        let result = Tri.False;
        for (const candidate of p.Values)
        {
            const t = NodeEvaluator.CompareValues(v, CompareOp.Eq, candidate);
            if (t === Tri.True)
            {
                return Tri.True;
            }
            if (t === Tri.Unknown)
            {
                result = Tri.Unknown;
            }
        }
        return result;
    }

    private static CompareValues(a: CellValue, op: CompareOp, b: CellValue): Tri
    {
        if (a === null || b === null)
        {
            return Tri.Unknown;
        }
        if (a instanceof DurationValue)
        {
            if (!(b instanceof DurationValue) || (op !== CompareOp.Eq && op !== CompareOp.Ne))
            {
                return Tri.False;
            }
            return (a.Equals(b) === (op === CompareOp.Eq)) ? Tri.True : Tri.False;
        }
        const order = NodeEvaluator.Order(a, b);
        if (order === undefined)
        {
            return Tri.False;
        }
        return NodeEvaluator.Satisfies(order, op) ? Tri.True : Tri.False;
    }

    private static Satisfies(order: number, op: CompareOp): boolean
    {
        switch (op)
        {
            case CompareOp.Eq: return order === 0;
            case CompareOp.Ne: return order !== 0;
            case CompareOp.Lt: return order < 0;
            case CompareOp.Le: return order <= 0;
            case CompareOp.Gt: return order > 0;
            case CompareOp.Ge: return order >= 0;
            default: return false;
        }
    }

    /** Negative/zero/positive ordering of two non-null values, or undefined when they are not comparable. */
    private static Order(a: CellValue, b: CellValue): number | undefined
    {
        if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number'))
        {
            if (Number.isNaN(a) || Number.isNaN(b))
            {
                return undefined;
            }
            // Mixed bigint/number relational operators in JS compare the exact mathematical values.
            return a < b ? -1 : a > b ? 1 : 0;
        }
        if (typeof a === 'string' && typeof b === 'string')
        {
            return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
        }
        if (typeof a === 'boolean' && typeof b === 'boolean')
        {
            return Number(a) - Number(b);
        }
        if (a instanceof DateValue && b instanceof DateValue)
        {
            return Math.sign(a.Days - b.Days);
        }
        if (a instanceof DateTimeValue && b instanceof DateTimeValue)
        {
            return a.Micros < b.Micros ? -1 : a.Micros > b.Micros ? 1 : 0;
        }
        return undefined;
    }
}
