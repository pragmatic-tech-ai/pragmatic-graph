import { Binding, EvalContext } from './Binding.js';
import { ComparisonOp } from './CypherEnums.js';
import { Comparison, FunctionCall, InExpression, ListLiteral, VariableRef, type Expression } from './Expression.js';
import { FunctionRegistry } from './FunctionRegistry.js';
import { CypherSemanticError } from './CypherError.js';
import { NullValue, ScalarValue, type CypherValue } from './CypherValue.js';
import { ListValue } from './StructuredValues.js';

/**
 * One `elementId(variable) = value` or `elementId(variable) IN list` conjunct of a WHERE (ruling R121 F2), the shape a
 * by-id seek answers. Operand is the value (Single) or the list (not Single) and mentions no variable, so it can be
 * evaluated with no row.
 */
export class IdSeekTerm
{
    constructor(
        public readonly Variable: string,
        public readonly Operand: Expression,
        public readonly Single: boolean,
        public readonly Source: Expression,
    )
    {
    }

    /**
     * The distinct ids the term admits, in first-seen order: the value when Single and a string, the string items of
     * the list otherwise. Anything else (null, a number, a list where one value is expected) equals no id, as the
     * `=` / IN filter would decide.
     */
    public Ids(parameters: ReadonlyMap<string, CypherValue>): readonly string[]
    {
        const value = this.Operand.Evaluate(new EvalContext(new Binding(), parameters));
        if (!this.Single && !(value instanceof ListValue) && !(value instanceof NullValue))
        {
            throw new CypherSemanticError(InExpression.NotAList);
        }
        const candidates = this.Single ? [value] : value instanceof ListValue ? value.Items : [];
        const ids = new Set<string>();
        for (const c of candidates)
        {
            if (c instanceof ScalarValue && typeof c.Value === 'string')
            {
                ids.add(c.Value);
            }
        }
        return [...ids];
    }

    /** The term a conjunct states, or undefined when it is any other shape. */
    public static TryParse(conjunct: Expression): IdSeekTerm | undefined
    {
        if (conjunct instanceof Comparison && conjunct.Op === ComparisonOp.Eq)
        {
            return IdSeekTerm.Make(conjunct.Left, conjunct.Right, true, conjunct) ?? IdSeekTerm.Make(conjunct.Right, conjunct.Left, true, conjunct);
        }
        if (conjunct instanceof InExpression)
        {
            const list = conjunct.Source ?? new ListLiteral(conjunct.List);
            return IdSeekTerm.Make(conjunct.Operand, list, false, conjunct);
        }
        return undefined;
    }

    /** The variable when the expression is `elementId(variable)`. */
    public static IdOf(e: Expression): string | undefined
    {
        if (e instanceof FunctionCall && e.Name.toLowerCase() === FunctionRegistry.ElementIdName && e.Args.length === 1 && !e.Distinct && !e.Star)
        {
            const arg = e.Args[0]!;
            return arg instanceof VariableRef ? arg.Variable : undefined;
        }
        return undefined;
    }

    private static Make(call: Expression, operand: Expression, single: boolean, source: Expression): IdSeekTerm | undefined
    {
        const variable = IdSeekTerm.IdOf(call);
        if (variable === undefined)
        {
            return undefined;
        }
        const used = new Set<string>();
        operand.CollectVariables(used);
        return used.size === 0 && !operand.ContainsAggregate() ? new IdSeekTerm(variable, operand, single, source) : undefined;
    }
}
