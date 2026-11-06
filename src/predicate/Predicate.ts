import type { CellValue } from '../columns/CellValue.js';
import { EdgeDirection } from '../format/FormatKeys.js';

export enum CompareOp
{
    Eq = 1,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

export enum PredicateKind
{
    True = 1,
    False,
    Compare,
    In,
    IsNull,
    And,
    Or,
    Not,
    IdIn,
    Related,
    Reachable,
    Seeded,
    OwnerIs,
}

/** One hop of a Reachable predicate: follow `Relationship` in `Direction`. */
export interface IPathStep
{
    readonly Relationship: string;
    readonly Direction: EdgeDirection;
}

/**
 * Immutable predicate AST shared by partial indexes, access scopes and the query layer. Node-local
 * predicates (see IsNodeLocal) are evaluated by NodeEvaluator; the rest need a reader.
 */
export abstract class Predicate
{
    public abstract readonly Kind: PredicateKind;

    /** True iff the tree contains no Related, Reachable, Seeded or OwnerIs. */
    public get IsNodeLocal(): boolean
    {
        return true;
    }

    public static get True(): Predicate
    {
        return TruePredicate.Instance;
    }

    public static get False(): Predicate
    {
        return FalsePredicate.Instance;
    }
}

export class TruePredicate extends Predicate
{
    public static readonly Instance = new TruePredicate();

    public readonly Kind = PredicateKind.True;

    private constructor()
    {
        super();
        Object.freeze(this);
    }
}

export class FalsePredicate extends Predicate
{
    public static readonly Instance = new FalsePredicate();

    public readonly Kind = PredicateKind.False;

    private constructor()
    {
        super();
        Object.freeze(this);
    }
}

export class Compare extends Predicate
{
    public readonly Kind = PredicateKind.Compare;

    public constructor(public readonly Member: string, public readonly Op: CompareOp, public readonly Value: CellValue)
    {
        super();
        Object.freeze(this);
    }
}

export class In extends Predicate
{
    public readonly Kind = PredicateKind.In;
    public readonly Values: readonly CellValue[];

    public constructor(public readonly Member: string, values: readonly CellValue[])
    {
        super();
        this.Values = Object.freeze([...values]);
        Object.freeze(this);
    }
}

export class IsNull extends Predicate
{
    public readonly Kind = PredicateKind.IsNull;

    public constructor(public readonly Member: string)
    {
        super();
        Object.freeze(this);
    }
}

export class IdIn extends Predicate
{
    public readonly Kind = PredicateKind.IdIn;
    public readonly Ids: ReadonlySet<string>;

    public constructor(ids: ReadonlySet<string>)
    {
        super();
        this.Ids = new Set(ids);
        Object.freeze(this);
    }
}

export class Seeded extends Predicate
{
    public readonly Kind = PredicateKind.Seeded;

    public constructor()
    {
        super();
        Object.freeze(this);
    }

    public override get IsNodeLocal(): boolean
    {
        return false;
    }
}

export class OwnerIs extends Predicate
{
    public readonly Kind = PredicateKind.OwnerIs;
    public readonly Owners: ReadonlySet<string>;

    public constructor(owners: ReadonlySet<string>)
    {
        super();
        this.Owners = new Set(owners);
        Object.freeze(this);
    }

    public override get IsNodeLocal(): boolean
    {
        return false;
    }
}

export class And extends Predicate
{
    public readonly Kind = PredicateKind.And;
    public readonly Terms: readonly Predicate[];

    public constructor(terms: readonly Predicate[])
    {
        super();
        this.Terms = Object.freeze([...terms]);
        Object.freeze(this);
    }

    public override get IsNodeLocal(): boolean
    {
        return this.Terms.every(t => t.IsNodeLocal);
    }
}

export class Or extends Predicate
{
    public readonly Kind = PredicateKind.Or;
    public readonly Terms: readonly Predicate[];

    public constructor(terms: readonly Predicate[])
    {
        super();
        this.Terms = Object.freeze([...terms]);
        Object.freeze(this);
    }

    public override get IsNodeLocal(): boolean
    {
        return this.Terms.every(t => t.IsNodeLocal);
    }
}

export class Not extends Predicate
{
    public readonly Kind = PredicateKind.Not;

    public constructor(public readonly Term: Predicate)
    {
        super();
        Object.freeze(this);
    }

    public override get IsNodeLocal(): boolean
    {
        return this.Term.IsNodeLocal;
    }
}

/** Has at least one neighbor over `Relationship` in `Direction` satisfying `Target`. */
export class Related extends Predicate
{
    public readonly Kind = PredicateKind.Related;

    public constructor(public readonly Relationship: string, public readonly Direction: EdgeDirection, public readonly Target: Predicate)
    {
        super();
        Object.freeze(this);
    }

    public override get IsNodeLocal(): boolean
    {
        return false;
    }
}

/** The node is one of `From`, or reachable from one in 1..MaxHops hops, each hop over any of `Steps`. */
export class Reachable extends Predicate
{
    public readonly Kind = PredicateKind.Reachable;
    public readonly From: ReadonlySet<string>;
    public readonly Steps: readonly IPathStep[];

    public constructor(from: ReadonlySet<string>, steps: readonly IPathStep[], public readonly MaxHops: number)
    {
        super();
        this.From = new Set(from);
        this.Steps = Object.freeze(steps.map(s => Object.freeze({ Relationship: s.Relationship, Direction: s.Direction })));
        Object.freeze(this);
    }

    public override get IsNodeLocal(): boolean
    {
        return false;
    }
}
