import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { NodeEvaluator, Truth } from '../predicate/NodeEvaluator.js';
import { type And, type Not, type Or, type OwnerIs, Predicate, PredicateKind, type Reachable, type Related } from '../predicate/Predicate.js';
import type { IReadNode, RecordedReads } from '../RecordedReads.js';
import { AccessDefault, type AccessScope } from './AccessScope.js';

/** One node under evaluation, with the property values read so far (absent = not a property of the node). */
class NodeFacts
{
    public readonly Values = new Map<string, CellValue>();

    public constructor(public readonly Node: IReadNode)
    {
    }
}

/**
 * Internal: decides, for one reader or transaction, which nodes its AccessScope lets it see and which
 * members it hides. Applicable entries for a node are those keyed by its concept, an ancestor or a
 * carried aspect (CatalogSnapshot.IsA); the node is visible iff every applicable Rows predicate is True
 * (Kleene logic, Unknown collapsed to not visible at the top), and Default decides when none applies.
 *
 * Every read goes through the reader's RecordedReads (unscoped, recorded): visibility is a read and
 * lands in a transaction's ReadSet. Related evaluates its Target on visible neighbors only, under the
 * same scope; a node whose visibility is asked while it is being decided counts as not visible (cycle
 * guard). Reachable sets are computed once per evaluator (BFS through unscoped edges) and cached, as
 * are per-concept applicable entries and visibility results that did not depend on the cycle guard.
 * The snapshot never changes under a reader (R30), so cached results stay correct for its lifetime.
 */
export class ScopeEvaluator
{
    private static readonly ErrKind = 'Unknown predicate kind in an access scope: ';
    private static readonly NoHidden: ReadonlySet<string> = new Set();

    private readonly rows = new Map<string, readonly Predicate[]>();
    private readonly hidden = new Map<string, ReadonlySet<string>>();
    private readonly properties = new Map<string, ReadonlyMap<string, MemberDef>>();
    private readonly memberNames = new Map<Predicate, ReadonlySet<string>>();
    private readonly reachable = new Map<Reachable, Promise<ReadonlySet<bigint>>>();
    private readonly visible = new Map<bigint, boolean>();
    private readonly deciding = new Set<bigint>();
    private cycleHits = 0;

    public constructor(private readonly scope: AccessScope, private readonly reads: RecordedReads)
    {
    }

    /** True iff a node has the public id and the scope lets the reader see it. Records the reads it makes. */
    public async Visible(publicId: string): Promise<boolean>
    {
        const node = await this.reads.Locate(publicId);
        return node !== undefined && this.IsVisible(node);
    }

    /** Visibility of a resolved node. */
    public async IsVisible(node: IReadNode): Promise<boolean>
    {
        const rows = this.ApplicableRows(node.Concept);
        if (rows.length === 0)
        {
            return this.scope.Default === AccessDefault.Allow;
        }
        const known = this.visible.get(node.Id);
        if (known !== undefined)
        {
            return known;
        }
        if (this.deciding.has(node.Id))
        {
            this.cycleHits += 1;
            return false;
        }
        const hitsBefore = this.cycleHits;
        this.deciding.add(node.Id);
        let result = true;
        try
        {
            const facts = new NodeFacts(node);
            for (const row of rows)
            {
                if ((await this.Eval(row, facts)) !== Truth.True)
                {
                    result = false;
                    break;
                }
            }
        }
        finally
        {
            this.deciding.delete(node.Id);
        }
        if (this.cycleHits === hitsBefore)
        {
            this.visible.set(node.Id, result);
        }
        return result;
    }

    /** The node behind an internal id when it is visible, else undefined. */
    public async VisibleById(id: bigint): Promise<IReadNode | undefined>
    {
        const node = await this.reads.NodeById(id);
        return (await this.IsVisible(node)) ? node : undefined;
    }

    /** Members hidden on instances of `concept`: the union of every applicable Hidden entry. */
    public HiddenMembers(concept: string): ReadonlySet<string>
    {
        let out = this.hidden.get(concept);
        if (out === undefined)
        {
            const union = new Set<string>();
            for (const [name, members] of this.scope.Hidden)
            {
                if (this.Applies(concept, name))
                {
                    for (const m of members)
                    {
                        union.add(m);
                    }
                }
            }
            out = union.size === 0 ? ScopeEvaluator.NoHidden : union;
            this.hidden.set(concept, out);
        }
        return out;
    }

    private ApplicableRows(concept: string): readonly Predicate[]
    {
        let out = this.rows.get(concept);
        if (out === undefined)
        {
            const list: Predicate[] = [];
            for (const [name, predicate] of this.scope.Rows)
            {
                if (this.Applies(concept, name))
                {
                    list.push(predicate);
                }
            }
            out = list;
            this.rows.set(concept, out);
        }
        return out;
    }

    /** A scope entry applies to the concept itself, its ancestors and its carried aspects; unknown names never apply. */
    private Applies(concept: string, name: string): boolean
    {
        const catalog = this.reads.Catalog;
        return catalog.Has(name) && catalog.IsA(concept, name);
    }

    private async Eval(p: Predicate, facts: NodeFacts): Promise<Truth>
    {
        if (p.IsNodeLocal)
        {
            await this.Load(p, facts);
            return NodeEvaluator.Evaluate(p, facts.Values, facts.Node.PublicId);
        }
        switch (p.Kind)
        {
            case PredicateKind.And:
                return this.EvalAnd(p as And, facts);
            case PredicateKind.Or:
                return this.EvalOr(p as Or, facts);
            case PredicateKind.Not:
            {
                const inner = await this.Eval((p as Not).Term, facts);
                return inner === Truth.Unknown ? Truth.Unknown : inner === Truth.True ? Truth.False : Truth.True;
            }
            case PredicateKind.Related:
                return (await this.EvalRelated(p as Related, facts.Node)) ? Truth.True : Truth.False;
            case PredicateKind.Reachable:
                return (await this.ReachableSet(p as Reachable)).has(facts.Node.Id) ? Truth.True : Truth.False;
            case PredicateKind.Seeded:
                return (await this.reads.Seeded(facts.Node)) ? Truth.True : Truth.False;
            case PredicateKind.OwnerIs:
                return (p as OwnerIs).Owners.has(await this.reads.Owner(facts.Node)) ? Truth.True : Truth.False;
            default:
                throw new GraphError(GraphErrorCode.Internal, ScopeEvaluator.ErrKind + String(p.Kind));
        }
    }

    private async EvalAnd(p: And, facts: NodeFacts): Promise<Truth>
    {
        let result = Truth.True;
        for (const term of p.Terms)
        {
            const t = await this.Eval(term, facts);
            if (t === Truth.False)
            {
                return Truth.False;
            }
            if (t === Truth.Unknown)
            {
                result = Truth.Unknown;
            }
        }
        return result;
    }

    private async EvalOr(p: Or, facts: NodeFacts): Promise<Truth>
    {
        let result = Truth.False;
        for (const term of p.Terms)
        {
            const t = await this.Eval(term, facts);
            if (t === Truth.True)
            {
                return Truth.True;
            }
            if (t === Truth.Unknown)
            {
                result = Truth.Unknown;
            }
        }
        return result;
    }

    /** Some neighbor over the relationship is visible under this scope and satisfies Target. */
    private async EvalRelated(p: Related, node: IReadNode): Promise<boolean>
    {
        for (const rel of this.reads.RelationshipsOrNone(node.Concept, p.Relationship, p.Direction))
        {
            for await (const id of this.reads.Adjacent(rel, node.Id, p.Direction))
            {
                const neighbor = await this.VisibleById(id);
                if (neighbor !== undefined && (await this.Eval(p.Target, new NodeFacts(neighbor))) === Truth.True)
                {
                    return true;
                }
            }
        }
        return false;
    }

    private ReachableSet(p: Reachable): Promise<ReadonlySet<bigint>>
    {
        let set = this.reachable.get(p);
        if (set === undefined)
        {
            set = this.ComputeReachable(p);
            this.reachable.set(p, set);
        }
        return set;
    }

    /** BFS from From over any of Steps per hop, up to MaxHops, through unscoped recorded edges. */
    private async ComputeReachable(p: Reachable): Promise<ReadonlySet<bigint>>
    {
        const seen = new Set<bigint>();
        let frontier: IReadNode[] = [];
        for (const publicId of p.From)
        {
            const start = await this.reads.Locate(publicId);
            if (start !== undefined && !seen.has(start.Id))
            {
                seen.add(start.Id);
                frontier.push(start);
            }
        }
        for (let hop = 0; hop < p.MaxHops && frontier.length > 0; hop++)
        {
            const next: IReadNode[] = [];
            for (const node of frontier)
            {
                for (const step of p.Steps)
                {
                    for (const rel of this.reads.RelationshipsOrNone(node.Concept, step.Relationship, step.Direction))
                    {
                        for await (const id of this.reads.Adjacent(rel, node.Id, step.Direction))
                        {
                            if (!seen.has(id))
                            {
                                seen.add(id);
                                next.push(await this.reads.NodeById(id));
                            }
                        }
                    }
                }
            }
            frontier = next;
        }
        return seen;
    }

    /** Reads the node's values for the member names `p` uses that are properties of its concept. */
    private async Load(p: Predicate, facts: NodeFacts): Promise<void>
    {
        let names = this.memberNames.get(p);
        if (names === undefined)
        {
            names = Predicate.MemberNames(p);
            this.memberNames.set(p, names);
        }
        if (names.size === 0)
        {
            return;
        }
        const props = this.Properties(facts.Node.Concept);
        for (const name of names)
        {
            const def = props.get(name);
            if (def !== undefined && !facts.Values.has(name))
            {
                facts.Values.set(name, await this.reads.Cell(facts.Node, def));
            }
        }
    }

    private Properties(concept: string): ReadonlyMap<string, MemberDef>
    {
        let out = this.properties.get(concept);
        if (out === undefined)
        {
            const map = new Map<string, MemberDef>();
            for (const m of this.reads.Catalog.EffectiveMembers(concept))
            {
                if (m.Kind === MemberKind.Property)
                {
                    map.set(m.Name, m);
                }
            }
            out = map;
            this.properties.set(concept, out);
        }
        return out;
    }
}
