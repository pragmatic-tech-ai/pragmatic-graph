import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind, ValueType } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import { ChunkCodecError } from '../columns/ChunkCodecError.js';
import { ValueCodec } from '../columns/ValueCodec.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { NodeEvaluator, Truth } from '../predicate/NodeEvaluator.js';
import { type And, type ConceptIs, type Not, type Or, type Predicate, PredicateKind } from '../predicate/Predicate.js';

/**
 * Internal: a node that is not stored (ruling R95): a concept and the values of its own properties (absent = null), with no
 * public id, owner, seed provenance or relationships. Evaluates a Rows predicate on it in Kleene logic: property
 * predicates as NodeEvaluator does, ConceptIs by exact name, and every predicate that needs stored identity or edges
 * (IdIn, OwnerIs, Seeded, Related, Reachable) as Unknown. Not of Unknown is Unknown and only True admits, so no
 * placement of Not can turn such a predicate into an admit: a True result holds whatever those predicates would be
 * on any real node with these values (Kleene logic is monotone in Unknown).
 */
export class HypotheticalNode
{
    private static readonly ErrKind = 'Unknown predicate kind in an access scope: ';
    /** Never consulted: IdIn, the one leaf that reads it, is decided here as Unknown before NodeEvaluator sees it. */
    private static readonly NoPublicId = '';
    private static readonly ErrValue = 'Admits value does not fit the member: ';
    private static readonly ErrInexact = 'Admits Int64 value is not exactly representable as Float64: ';
    private static readonly Dot = '.';

    private constructor(public readonly Concept: string, public readonly Values: ReadonlyMap<string, CellValue>)
    {
    }

    /**
     * The hypothetical node of `concept` with `properties`, or undefined when `concept` is unknown or an aspect (no node
     * can have it as its concept): the single place Admits decides that. Only names that are effective properties of
     * `concept` are taken; an absent name, an undefined entry and an explicit null all read as unset (null). Every other
     * value must fit its member as a write would (ValueCodec.Check; an Int64 into a Float64 member is widened when
     * exactly representable), else GraphError SchemaViolation naming `Concept.member`: a mistyped value would compare
     * as plainly False, and Not of that would admit a node no stored instance could be.
     */
    public static Build(catalog: CatalogSnapshot, concept: string, properties: ReadonlyMap<string, CellValue>): HypotheticalNode | undefined
    {
        if (!catalog.Has(concept) || catalog.IsAspect(concept))
        {
            return undefined;
        }
        const values = new Map<string, CellValue>();
        for (const def of catalog.EffectiveMembers(concept))
        {
            if (def.Kind !== MemberKind.Property)
            {
                continue;
            }
            const value = properties.get(def.Name);
            if (value !== undefined && value !== null)
            {
                values.set(def.Name, HypotheticalNode.Checked(concept, def, value));
            }
        }
        return new HypotheticalNode(concept, values);
    }

    /**
     * @internal `value` as a cell of `def` under the write path's value rules (an Int64 into a Float64 member widened when
     * exactly representable); GraphError SchemaViolation naming `concept.member` when it does not fit. Also how
     * FetchedNode.Validated checks fetched values.
     */
    public static Checked(concept: string, def: MemberDef, value: Exclude<CellValue, null>): CellValue
    {
        const label = concept + HypotheticalNode.Dot + def.Name;
        let cell: CellValue = value;
        if (def.Type === ValueType.Float64 && typeof value === 'bigint')
        {
            cell = Number(value);
            if (BigInt(cell) !== value)
            {
                throw new GraphError(GraphErrorCode.SchemaViolation, HypotheticalNode.ErrInexact + label);
            }
        }
        try
        {
            ValueCodec.Check(def.Type as ValueType, cell);
        }
        catch (error)
        {
            if (error instanceof ChunkCodecError)
            {
                throw new GraphError(GraphErrorCode.SchemaViolation, HypotheticalNode.ErrValue + label, error);
            }
            throw error;
        }
        return cell;
    }

    public Eval(p: Predicate): Truth
    {
        const kind = p.Kind;
        switch (kind)
        {
            case PredicateKind.True:
            case PredicateKind.False:
            case PredicateKind.Compare:
            case PredicateKind.In:
            case PredicateKind.IsNull:
                return NodeEvaluator.Evaluate(p, this.Values, HypotheticalNode.NoPublicId);
            case PredicateKind.ConceptIs:
                return this.Concept === (p as ConceptIs).Concept ? Truth.True : Truth.False;
            case PredicateKind.IdIn:
            case PredicateKind.OwnerIs:
            case PredicateKind.Seeded:
            case PredicateKind.Related:
            case PredicateKind.Reachable:
                return Truth.Unknown;
            case PredicateKind.Not:
            {
                const inner = this.Eval((p as Not).Term);
                return inner === Truth.Unknown ? Truth.Unknown : inner === Truth.True ? Truth.False : Truth.True;
            }
            case PredicateKind.And:
                return this.Combine((p as And).Terms, Truth.False, Truth.True);
            case PredicateKind.Or:
                return this.Combine((p as Or).Terms, Truth.True, Truth.False);
            default:
            {
                const unknown: never = kind;
                throw new GraphError(GraphErrorCode.Internal, HypotheticalNode.ErrKind + String(unknown));
            }
        }
    }

    /** Kleene And (dominant False) or Or (dominant True): the dominant value wins, else Unknown if any, else `identity`. */
    private Combine(terms: readonly Predicate[], dominant: Truth, identity: Truth): Truth
    {
        let result = identity;
        for (const term of terms)
        {
            const t = this.Eval(term);
            if (t === dominant)
            {
                return dominant;
            }
            if (t === Truth.Unknown)
            {
                result = Truth.Unknown;
            }
        }
        return result;
    }
}
