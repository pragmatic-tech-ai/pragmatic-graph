import type { CellValue } from '../columns/CellValue.js';
import type { CypherNode } from './CypherNode.js';
import { ScalarSemantics } from './ScalarSemantics.js';

/** A non-null engine cell value: the Cypher scalar currency (Int64 is bigint, Float64 is number). */
export type CypherScalar = Exclude<CellValue, null>;

/**
 * A caller-supplied parameter tree (see ParameterBinder). Plain objects `{ $date }`, `{ $datetime, zone }` and
 * `{ $duration }` carry temporal values.
 */
export type ParameterValue = CypherScalar | null | readonly ParameterValue[] | { readonly [key: string]: ParameterValue };

/** Cross-type order of value kinds (ORDER BY): scalars by ScalarRank, then nodes, lists, maps, rels, paths; null last. */
export enum ValueRank
{
    Node = 6,
    List = 7,
    Map = 8,
    Rel = 9,
    Path = 10,
    Null = 100,
}

export abstract class CypherValue
{
    // Equivalence key (DISTINCT, grouping, joins): 2 and 2.0 share a key.
    public abstract GroupKey(): string;

    // Type-exact identity key (expression structural keys): 2 and 2.0 differ. Same as GroupKey unless numbers are inside.
    public TypedKey(): string
    {
        return this.GroupKey();
    }

    // Total order; nulls sort last for ascending. Cross-type by TypeRank, then within-type.
    public static Compare(a: CypherValue, b: CypherValue): number
    {
        const ra = a.TypeRank();
        const rb = b.TypeRank();
        if (ra !== rb) return ra - rb;
        return a.CompareSameType(b);
    }

    protected abstract TypeRank(): number;
    protected abstract CompareSameType(other: CypherValue): number;
}

export class ScalarValue extends CypherValue
{
    constructor(public readonly Value: CypherScalar)
    {
        super();
    }

    public GroupKey(): string
    {
        return ScalarSemantics.GroupKey(this.Value);
    }

    public override TypedKey(): string
    {
        return ScalarSemantics.TypedKey(this.Value);
    }

    protected TypeRank(): number
    {
        return ScalarSemantics.Rank(this.Value);
    }

    protected CompareSameType(other: CypherValue): number
    {
        return ScalarSemantics.TotalOrder(this.Value, (other as ScalarValue).Value);
    }
}

export class NullValue extends CypherValue
{
    private static readonly GroupKeyText = 'null';
    public static readonly Instance = new NullValue();

    private constructor()
    {
        super();
    }

    public GroupKey(): string
    {
        return NullValue.GroupKeyText;
    }

    protected TypeRank(): number
    {
        return ValueRank.Null;
    }

    protected CompareSameType(): number
    {
        return 0;
    }
}

export class NodeValue extends CypherValue
{
    public static readonly GroupKeyPrefix = 'node:';

    constructor(private readonly node: CypherNode)
    {
        super();
    }

    public get Node(): CypherNode
    {
        return this.node;
    }

    public get Id(): string
    {
        return this.node.PublicId;
    }

    public get Concept(): string
    {
        return this.node.Concept;
    }

    public get Owner(): string
    {
        return this.node.Owner;
    }

    /** The property's cell; null when the member is unset, undefined when the node has no such visible member. */
    public Field(name: string): CellValue | undefined
    {
        return this.node.Properties.get(name);
    }

    public GroupKey(): string
    {
        return `${NodeValue.GroupKeyPrefix}${this.Id}`;
    }

    protected TypeRank(): number
    {
        return ValueRank.Node;
    }

    protected CompareSameType(other: CypherValue): number
    {
        const o = (other as NodeValue).Id;
        if (this.Id < o) return -1;
        if (this.Id > o) return 1;
        return 0;
    }
}
