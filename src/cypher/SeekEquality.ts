import { BooleanOp, ComparisonOp } from './CypherEnums.js';
import { BooleanExpression, Comparison, Literal, Parameter, PropertyAccess, type Expression } from './Expression.js';

/**
 * One `variable.property = literal|$param` equality found among the top-level AND conjuncts of a WHERE (or
 * built from an inline property map), the shape an index seek can answer. Value is a Literal or a Parameter, so
 * it can be evaluated with no row.
 */
export class SeekEquality
{
    constructor(
        public readonly Variable: string,
        public readonly Property: string,
        public readonly Value: Expression,
        public readonly Source: Expression | undefined,
    )
    {
    }

    /** The top-level AND conjuncts of a predicate (the predicate itself when it is not an AND). */
    public static Conjuncts(predicate: Expression): Expression[]
    {
        if (predicate instanceof BooleanExpression && predicate.Op === BooleanOp.And)
        {
            return predicate.Operands.flatMap(o => SeekEquality.Conjuncts(o));
        }
        return [predicate];
    }

    /** The conjuncts re-joined with AND, or undefined when none remain. */
    public static Join(conjuncts: readonly Expression[]): Expression | undefined
    {
        if (conjuncts.length === 0)
        {
            return undefined;
        }
        return conjuncts.length === 1 ? conjuncts[0] : new BooleanExpression(BooleanOp.And, conjuncts);
    }

    /** The equality a conjunct states, or undefined when it is any other shape (a null literal never seeks). */
    public static TryParse(conjunct: Expression): SeekEquality | undefined
    {
        if (!(conjunct instanceof Comparison) || conjunct.Op !== ComparisonOp.Eq)
        {
            return undefined;
        }
        return SeekEquality.Pair(conjunct.Left, conjunct.Right, conjunct) ?? SeekEquality.Pair(conjunct.Right, conjunct.Left, conjunct);
    }

    private static Pair(property: Expression, value: Expression, source: Expression): SeekEquality | undefined
    {
        if (!(property instanceof PropertyAccess))
        {
            return undefined;
        }
        if (value instanceof Parameter || (value instanceof Literal && value.Value !== null))
        {
            return new SeekEquality(property.Variable, property.Property, value, source);
        }
        return undefined;
    }
}
