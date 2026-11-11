import { And, Compare, CompareOp, IdIn, In, IsNull, Not, type Predicate } from '../predicate/Predicate.js';
import { ComparisonOp } from './CypherEnums.js';
import { ScalarValue, type CypherScalar, type CypherValue } from './CypherValue.js';
import { Comparison, InExpression, IsNullExpression, Literal, Parameter, PropertyAccess, type Expression } from './Expression.js';
import { IdSeekTerm } from './IdSeekTerm.js';
import type { NodePattern } from './PatternPath.js';

/**
 * The push-down hint of a freshly bound scan anchor (ruling R101, design ruling D4): a node-local engine Predicate that
 * every node the query keeps satisfies, built from the anchor's pattern property map and the top-level AND conjuncts of
 * its MATCH's WHERE that compare one of the anchor's properties with a literal or a parameter: `=`, `<>`, `<`, `<=`,
 * `>`, `>=` (either side), `IN [..]`, `IS NULL` and `IS NOT NULL`. Anything else contributes nothing, so the hint is
 * implied by the query's filters, which stay in the plan unchanged. Cypher comparisons and the Predicate evaluator share
 * CellOrder, so a connector that applies the hint keeps every node the filters keep. Null and non-scalar values never
 * satisfy a comparison: such a term is left out, and such IN items are dropped (they match nothing).
 */
export class FetchHint
{
    public static For(node: NodePattern, conjuncts: readonly Expression[], parameters: ReadonlyMap<string, CypherValue>): Predicate | undefined
    {
        const terms: Predicate[] = [];
        for (const [key, value] of node.Properties)
        {
            terms.push(new Compare(key, CompareOp.Eq, value));
        }
        if (node.Variable !== undefined)
        {
            for (const conjunct of conjuncts)
            {
                const term = FetchHint.Term(conjunct, node.Variable, parameters);
                if (term !== undefined)
                {
                    terms.push(term);
                }
            }
        }
        if (terms.length === 0)
        {
            return undefined;
        }
        return terms.length === 1 ? terms[0] : new And(terms);
    }

    private static Term(conjunct: Expression, variable: string, parameters: ReadonlyMap<string, CypherValue>): Predicate | undefined
    {
        const id = IdSeekTerm.TryParse(conjunct);
        if (id !== undefined)
        {
            return id.Variable === variable ? FetchHint.IdTerm(id, parameters) : undefined;
        }
        if (conjunct instanceof Comparison)
        {
            const op = FetchHint.Op(conjunct.Op);
            const left = FetchHint.Property(conjunct.Left, variable);
            const right = FetchHint.Property(conjunct.Right, variable);
            if (left !== undefined && right === undefined)
            {
                const value = FetchHint.Value(conjunct.Right, parameters);
                return value === undefined ? undefined : new Compare(left, op, value);
            }
            if (right !== undefined && left === undefined)
            {
                const value = FetchHint.Value(conjunct.Left, parameters);
                return value === undefined ? undefined : new Compare(right, FetchHint.Flip(op), value);
            }
            return undefined;
        }
        if (conjunct instanceof IsNullExpression)
        {
            const member = FetchHint.Property(conjunct.Operand, variable);
            if (member === undefined)
            {
                return undefined;
            }
            return conjunct.Negated ? new Not(new IsNull(member)) : new IsNull(member);
        }
        if (conjunct instanceof InExpression)
        {
            const member = FetchHint.Property(conjunct.Operand, variable);
            if (member === undefined)
            {
                return undefined;
            }
            const values: CypherScalar[] = [];
            for (const item of conjunct.List)
            {
                const value = FetchHint.Value(item, parameters);
                if (value !== undefined)
                {
                    values.push(value);
                }
                else if (!(item instanceof Literal) && !(item instanceof Parameter))
                {
                    // An item the hint cannot evaluate might match: the whole IN contributes nothing.
                    return undefined;
                }
            }
            return new In(member, values);
        }
        return undefined;
    }

    /** IdIn of the ids an `elementId(v)` conjunct admits (ruling R121 F2); nothing when its operand cannot be evaluated. */
    private static IdTerm(term: IdSeekTerm, parameters: ReadonlyMap<string, CypherValue>): Predicate | undefined
    {
        try
        {
            return new IdIn(new Set(term.Ids(parameters)));
        }
        catch
        {
            return undefined;
        }
    }

    /** The property name when the expression is `variable.property`. */
    private static Property(e: Expression, variable: string): string | undefined
    {
        return e instanceof PropertyAccess && e.Variable === variable ? e.Property : undefined;
    }

    /** A non-null scalar literal or parameter value; undefined for anything else (or a parameter not supplied). */
    private static Value(e: Expression, parameters: ReadonlyMap<string, CypherValue>): CypherScalar | undefined
    {
        if (e instanceof Literal)
        {
            return e.Value ?? undefined;
        }
        if (e instanceof Parameter)
        {
            const value = parameters.get(e.Name);
            return value instanceof ScalarValue ? value.Value : undefined;
        }
        return undefined;
    }

    private static Op(op: ComparisonOp): CompareOp
    {
        switch (op)
        {
            case ComparisonOp.Eq: return CompareOp.Eq;
            case ComparisonOp.Neq: return CompareOp.Ne;
            case ComparisonOp.Lt: return CompareOp.Lt;
            case ComparisonOp.Lte: return CompareOp.Le;
            case ComparisonOp.Gt: return CompareOp.Gt;
            case ComparisonOp.Gte: return CompareOp.Ge;
        }
    }

    /** The operator with its operands swapped (`v < p` is `p > v`). */
    private static Flip(op: CompareOp): CompareOp
    {
        switch (op)
        {
            case CompareOp.Lt: return CompareOp.Gt;
            case CompareOp.Le: return CompareOp.Ge;
            case CompareOp.Gt: return CompareOp.Lt;
            case CompareOp.Ge: return CompareOp.Le;
            default: return op;
        }
    }
}
