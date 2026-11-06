import type { CellValue } from '../columns/CellValue.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import { PredicateError, PredicateErrorCode } from './PredicateError.js';

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

    /** True iff the tree contains no Related, Reachable, Seeded or OwnerIs. Computed once at construction. */
    public abstract readonly IsNodeLocal: boolean;

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
    public readonly IsNodeLocal: boolean;

    private constructor()
    {
        super();
        this.IsNodeLocal = true;
        Object.freeze(this);
    }
}

export class FalsePredicate extends Predicate
{
    public static readonly Instance = new FalsePredicate();

    public readonly Kind = PredicateKind.False;
    public readonly IsNodeLocal: boolean;

    private constructor()
    {
        super();
        this.IsNodeLocal = true;
        Object.freeze(this);
    }
}

export class Compare extends Predicate
{
    public readonly Kind = PredicateKind.Compare;
    public readonly IsNodeLocal: boolean;

    public constructor(public readonly Member: string, public readonly Op: CompareOp, public readonly Value: CellValue)
    {
        super();
        this.IsNodeLocal = true;
        Object.freeze(this);
    }
}

export class In extends Predicate
{
    public readonly Kind = PredicateKind.In;
    public readonly IsNodeLocal: boolean;
    public readonly Values: readonly CellValue[];

    public constructor(public readonly Member: string, values: readonly CellValue[])
    {
        super();
        this.IsNodeLocal = true;
        this.Values = Object.freeze([...values]);
        Object.freeze(this);
    }
}

export class IsNull extends Predicate
{
    public readonly Kind = PredicateKind.IsNull;
    public readonly IsNodeLocal: boolean;

    public constructor(public readonly Member: string)
    {
        super();
        this.IsNodeLocal = true;
        Object.freeze(this);
    }
}

export class IdIn extends Predicate
{
    public readonly Kind = PredicateKind.IdIn;
    public readonly IsNodeLocal: boolean;
    public readonly Ids: ReadonlySet<string>;

    public constructor(ids: ReadonlySet<string>)
    {
        super();
        this.IsNodeLocal = true;
        this.Ids = new Set(ids);
        Object.freeze(this);
    }
}

export class Seeded extends Predicate
{
    public readonly Kind = PredicateKind.Seeded;
    public readonly IsNodeLocal: boolean;

    public constructor()
    {
        super();
        this.IsNodeLocal = false;
        Object.freeze(this);
    }
}

export class OwnerIs extends Predicate
{
    public readonly Kind = PredicateKind.OwnerIs;
    public readonly IsNodeLocal: boolean;
    public readonly Owners: ReadonlySet<string>;

    public constructor(owners: ReadonlySet<string>)
    {
        super();
        this.IsNodeLocal = false;
        this.Owners = new Set(owners);
        Object.freeze(this);
    }
}

export class And extends Predicate
{
    public readonly Kind = PredicateKind.And;
    public readonly IsNodeLocal: boolean;
    public readonly Terms: readonly Predicate[];

    public constructor(terms: readonly Predicate[])
    {
        super();
        this.IsNodeLocal = terms.every(t => t.IsNodeLocal);
        this.Terms = Object.freeze([...terms]);
        Object.freeze(this);
    }
}

export class Or extends Predicate
{
    public readonly Kind = PredicateKind.Or;
    public readonly IsNodeLocal: boolean;
    public readonly Terms: readonly Predicate[];

    public constructor(terms: readonly Predicate[])
    {
        super();
        this.IsNodeLocal = terms.every(t => t.IsNodeLocal);
        this.Terms = Object.freeze([...terms]);
        Object.freeze(this);
    }
}

export class Not extends Predicate
{
    public readonly Kind = PredicateKind.Not;
    public readonly IsNodeLocal: boolean;

    public constructor(public readonly Term: Predicate)
    {
        super();
        this.IsNodeLocal = this.Term.IsNodeLocal;
        Object.freeze(this);
    }
}

/** Has at least one neighbor over `Relationship` in `Direction` satisfying `Target`. */
export class Related extends Predicate
{
    public readonly Kind = PredicateKind.Related;
    public readonly IsNodeLocal: boolean;

    public constructor(public readonly Relationship: string, public readonly Direction: EdgeDirection, public readonly Target: Predicate)
    {
        super();
        this.IsNodeLocal = false;
        Object.freeze(this);
    }
}

/** The node is one of `From`, or reachable from one in 1..MaxHops hops, each hop over any of `Steps`. */
export class Reachable extends Predicate
{
    private static readonly BadMaxHops = 'Reachable.MaxHops must be an integer >= 1.';

    public readonly Kind = PredicateKind.Reachable;
    public readonly MaxHops: number;
    public readonly IsNodeLocal: boolean;
    public readonly From: ReadonlySet<string>;
    public readonly Steps: readonly IPathStep[];

    public constructor(from: ReadonlySet<string>, steps: readonly IPathStep[], maxHops: number)
    {
        super();
        this.IsNodeLocal = false;
        if (!Number.isInteger(maxHops) || maxHops < 1)
        {
            throw new PredicateError(PredicateErrorCode.Malformed, Reachable.BadMaxHops);
        }
        this.MaxHops = maxHops;
        this.From = new Set(from);
        this.Steps = Object.freeze(steps.map(s => Object.freeze({ Relationship: s.Relationship, Direction: s.Direction })));
        Object.freeze(this);
    }
}
