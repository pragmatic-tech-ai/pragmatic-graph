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

    /**
     * The member names the predicate reads on the node itself (Compare, In and IsNull, through And, Or and
     * Not); the targets of Related and Reachable are other nodes and are not included.
     */
    public static MemberNames(p: Predicate): ReadonlySet<string>
    {
        const out = new Set<string>();
        Predicate.CollectNames(p, out);
        return out;
    }

    private static CollectNames(p: Predicate, out: Set<string>): void
    {
        switch (p.Kind)
        {
            case PredicateKind.Compare:
                out.add((p as Compare).Member);
                break;
            case PredicateKind.In:
                out.add((p as In).Member);
                break;
            case PredicateKind.IsNull:
                out.add((p as IsNull).Member);
                break;
            case PredicateKind.And:
            case PredicateKind.Or:
                for (const term of (p as And | Or).Terms)
                {
                    Predicate.CollectNames(term, out);
                }
                break;
            case PredicateKind.Not:
                Predicate.CollectNames((p as Not).Term, out);
                break;
            default:
                break;
        }
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
