import { Binding, EvalContext } from '../Binding.js';
import { CypherSemanticError } from '../CypherError.js';
import { NodeValue, NullValue, type CypherValue } from '../CypherValue.js';
import type { Expression } from '../Expression.js';

/** Shared helpers and messages of the write operators. */
export class WriteSupport
{
    public static readonly NotANode = 'write target is not a node';
    public static readonly UnboundVariable = 'variable not bound';
    public static readonly LabelRequired = 'a created node requires a label';
    public static readonly RelTypeRequired = 'a created relationship requires a type';
    public static readonly RelDirectionRequired = 'a created relationship requires a direction';
    public static readonly VarLengthCreate = 'variable-length relationships cannot be created';
    public static readonly NotAScalar = 'property value must be a scalar, null, or a node';
    public static readonly MergeMapNotMap = 'SET n += requires a map';
    public static readonly ReplaceNotMap = 'SET n = requires a map';
    public static readonly NullEndpoint = 'cannot create a relationship from a null node variable';
    public static readonly MergeNeedsNode = 'MERGE requires a node pattern';
    public static readonly MergeBoundNotNode = 'MERGE variable is bound to a non-node value';
    public static readonly MergeBoundNull = 'MERGE variable is bound to null';
    public static readonly MergeBoundConstrained = 'MERGE cannot add a label or properties to an already-bound variable';
    public static readonly MergePathVariable = 'a path variable is not supported in MERGE';

    /** The node's public id; undefined for null (or an absent value); CypherSemanticError for a non-node. */
    public static NodeId(value: CypherValue | undefined): string | undefined
    {
        if (value === undefined || value instanceof NullValue) return undefined;
        if (value instanceof NodeValue) return value.Id;
        throw new CypherSemanticError(WriteSupport.NotANode);
    }

    public static RequiredNodeId(row: Binding, variable: string): string | undefined
    {
        const value = row.Get(variable);
        if (value === undefined) throw new CypherSemanticError(`${WriteSupport.UnboundVariable}: "${variable}"`);
        return WriteSupport.NodeId(value);
    }

    public static Eval(expr: Expression, row: Binding, parameters: ReadonlyMap<string, CypherValue>): CypherValue
    {
        return expr.Evaluate(new EvalContext(row, parameters));
    }
}
