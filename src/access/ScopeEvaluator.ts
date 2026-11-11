import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import { NodeEvaluator, Truth } from '../predicate/NodeEvaluator.js';
import { And, type ConceptIs, type Not, type Or, type OwnerIs, Predicate, PredicateKind, type Reachable, type Related } from '../predicate/Predicate.js';
import type { IReadNode, RecordedReads } from '../RecordedReads.js';
import { AccessDefault, type AccessScope, type IEndpointMembers, type IReadOnlyMembers, type IWriteRules } from './AccessScope.js';
import type { FetchedNode } from './FetchedNode.js';
import type { HypotheticalNode } from './HypotheticalNode.js';
import { WriteStage } from './WriteStage.js';

/** One node under evaluation, with the property values read so far (absent = not a property of the node). */
class NodeFacts
{
    public readonly Values = new Map<string, CellValue>();

    public constructor(public readonly Node: IReadNode)
    {
    }
}

/**
 * One top-level visibility decision (one public read asking about one node): the nodes it is deciding
 * (its cycle guard), how often the guard was hit, the guard-dependent results it settled (decided at
 * most once per Evaluation; discarded with it) and how many node decisions it has made (its budget).
 * Never shared between decisions, so concurrent reads on one reader cannot see each other's state.
 */
class Evaluation
{
    public readonly Deciding = new Set<bigint>();
    public readonly Memo = new Map<bigint, Truth>();
    public GuardHits = 0;
    public Decisions = 0;
}

/**
 * Internal: decides, for one reader or transaction, which nodes its AccessScope lets it see and which
 * members it hides. Applicable entries for a node are those keyed by its concept, an ancestor or a
 * carried aspect (CatalogSnapshot.IsA); the node is visible iff every applicable Rows predicate is True
 * (Kleene logic, Unknown collapsed to not visible at the top), and Default decides when none applies. A node with an
 * applicable Endpoints entry (a reified edge, ruling R130) is visible iff, besides that, the nodes at its From and To
 * members are visible, each decided under the same Evaluation (Kleene And; an unset member hides nothing).
 *
 * Every read goes through the reader's RecordedReads (unscoped, recorded): visibility is a read and
 * lands in a transaction's ReadSet. Related is the Kleene Or, over the neighbors, of (neighbor visible
 * AND Target), under the same scope. Each top-level decision carries its own Evaluation: a node whose
 * visibility is asked again while that decision is deciding it is Unknown (cycle guard), which stays
 * Unknown under Not and collapses to not visible at the top, so cyclic rules terminate and never grant
 * through the cycle. Reachable sets are computed once per evaluator (BFS through unscoped edges) and
 * cached, as are per-concept applicable entries and visibility results that did not depend on a guard
 * hit (only those are facts about the node rather than about one decision); guard-dependent results
 * are memoised within their Evaluation, so a node is decided at most once per top-level decision (work
 * linear in the nodes and edges reached), with a MaxDecisions budget as a fail-closed backstop. The snapshot never
 * changes under a reader (R30), so cached results stay correct for its lifetime; the cache holds one boolean per node
 * actually decided.
 */
export class ScopeEvaluator
{
    private static readonly ErrKind = 'Unknown predicate kind in an access scope: ';
    /** Node decisions one top-level decision may make; beyond it the rest is Unknown (fail closed, R66). */
    private static readonly MaxDecisions = 10_000;
    private static readonly NoHidden: ReadonlySet<string> = new Set();
    /** The one empty read-only set (no member is read-only). */
    private static readonly NoReadOnly: ReadonlySet<string> = new Set();
    private static readonly NoLinks: readonly string[] = Object.freeze([]);
    private static readonly NoEndpoints: ReadonlyMap<string, IEndpointMembers> = new Map();

    private readonly rows = new Map<string, readonly Predicate[]>();
    private readonly writes = new Map<string, readonly IWriteRules[]>();
    /** Per concept, its applicable Endpoints entry (null: none applies). */
    private readonly endpoints = new Map<string, IEndpointMembers | null>();
    private readonly hidden = new Map<string, ReadonlySet<string>>();
    private readonly readOnlyCreate = new Map<string, ReadonlySet<string>>();
    private readonly readOnlyUpdate = new Map<string, ReadonlySet<string>>();
    private readonly properties = new Map<string, ReadonlyMap<string, MemberDef>>();
    private readonly memberNames = new Map<Predicate, ReadonlySet<string>>();
    private readonly reachable = new Map<Reachable, Promise<ReadonlySet<bigint>>>();
    private readonly visible = new Map<bigint, boolean>();

    public constructor(private readonly scope: AccessScope, private readonly reads: RecordedReads)
    {
    }

    /** True iff a node has the public id and the scope lets the reader see it. Records the reads it makes. */
    public async Visible(publicId: string): Promise<boolean>
    {
        const node = await this.reads.Locate(publicId);
        return node !== undefined && this.IsVisible(node);
    }

    /** Visibility of a resolved node: a top-level decision (Unknown collapses to not visible). */
    public async IsVisible(node: IReadNode): Promise<boolean>
    {
        return (await this.Decide(node, new Evaluation())) === Truth.True;
    }

    /** The node behind an internal id when it is visible, else undefined. */
    public async VisibleById(id: bigint): Promise<IReadNode | undefined>
    {
        const node = await this.reads.NodeById(id);
        return (await this.IsVisible(node)) ? node : undefined;
    }

    /** The scope this evaluator enforces. */
    public get Scope(): AccessScope
    {
        return this.scope;
    }

    /** The node with the public id in the snapshot, visible or not; records its binding (also when missing). */
    public Locate(publicId: string): Promise<IReadNode | undefined>
    {
        return this.reads.Locate(publicId);
    }

    /**
     * True iff `p` is True on the node's snapshot values under this scope (Kleene logic, Unknown
     * collapsed to false at the top; graph predicates allowed): how the WriteGate decides an Update or
     * Delete rule. A top-level decision of its own; records the reads it makes.
     */
    public async Holds(p: Predicate, node: IReadNode): Promise<boolean>
    {
        return (await this.Eval(p, new NodeFacts(node), new Evaluation())) === Truth.True;
    }

    /**
     * True iff the hypothetical node (built and checked by HypotheticalNode.Build) passes every applicable Rows
     * predicate (ruling R95); the scope's Default when none applies. Predicates needing stored identity or edges are
     * Unknown on it, so they never admit, also under Not. It has no relationships yet, so an Endpoints entry (R130) is not
     * applied to it: the WriteGate requires the batch that creates an edge node to link both its members, and a stored
     * edge node with an unset member is invisible. Reads nothing and records nothing.
     */
    public Admits(node: HypotheticalNode): boolean
    {
        const rows = this.ApplicableRows(node.Concept);
        if (rows.length === 0)
        {
            return this.scope.Default === AccessDefault.Allow;
        }
        return rows.every(row => node.Eval(row) === Truth.True);
    }

    /**
     * True iff the row fetched from an External connector passes every applicable Rows predicate (ruling R100, design
     * ruling D5); the scope's Default when none applies. A top-level decision of its own (a fresh Evaluation: cycle
     * guard, memo and MaxDecisions budget), with the row's stub, when one is attached, counted as being decided, so a
     * rule that comes back to it through engine edges hits the guard. Values come from the row (absent = null); IdIn,
     * OwnerIs (the fetch target's model) and ConceptIs (the row's concept) are known; Seeded is False. Related Out walks
     * the row's Links: an engine-resident target is decided as for engine nodes, an external one (a stub, or no stored
     * node) is Unknown, whatever Target is. Related In is True when the stub's engine edges make it True; otherwise
     * Unknown when some External binding could hold a source of the relationship (its edges are not in the engine),
     * else the engine result (False without a stub). Reachable is True when the row's id is in From or the engine BFS
     * reaches the stub; otherwise Unknown without a stub or when some step's relationship could have an externally held
     * source, else False. Unknown at the top is not visible. Records the reads it makes; caches nothing about the row.
     */
    public async VisibleFetched(node: FetchedNode): Promise<boolean>
    {
        const rows = this.ApplicableRows(node.Concept);
        if (rows.length === 0)
        {
            return this.scope.Default === AccessDefault.Allow;
        }
        const evaluation = new Evaluation();
        evaluation.Decisions += 1;
        const stub = node.StubNode;
        if (stub !== undefined)
        {
            evaluation.Deciding.add(stub.Id);
        }
        for (const row of rows)
        {
            if ((await this.EvalFetched(row, node, evaluation)) !== Truth.True)
            {
                return false;
            }
        }
        return true;
    }

    /**
     * True iff `p` is True on the fetched row under D5 (as VisibleFetched decides a Rows predicate; Unknown is false): how
     * the WriteGate decides an Update or Delete rule of an external node (ruling R103). A top-level decision of its own;
     * records the reads it makes.
     */
    public async HoldsFetched(p: Predicate, node: FetchedNode): Promise<boolean>
    {
        const evaluation = new Evaluation();
        evaluation.Decisions += 1;
        const stub = node.StubNode;
        if (stub !== undefined)
        {
            evaluation.Deciding.add(stub.Id);
        }
        return (await this.EvalFetched(p, node, evaluation)) === Truth.True;
    }

    /** True when the stored node is a stub (ruling R102): its binding resolves to an External connector. Records its binding. */
    public IsStub(node: IReadNode): Promise<boolean>
    {
        return this.reads.IsStub(node);
    }

    /**
     * The predicate a fetch of `concept` pushes down for the scope (design ruling D4): the applicable Rows predicate,
     * the And of them when several apply (in scope order), True when none applies and Default allows, False when it
     * denies. Advisory only: every fetched row is still decided by VisibleFetched.
     */
    public RowsPredicate(concept: string): Predicate
    {
        const rows = this.ApplicableRows(concept);
        if (rows.length === 0)
        {
            return this.scope.Default === AccessDefault.Allow ? Predicate.True : Predicate.False;
        }
        return rows.length === 1 ? rows[0]! : new And(rows);
    }

    /** Write rules of every Writes entry applicable to `concept` (keyed by it, an ancestor or a carried aspect). */
    public ApplicableWrites(concept: string): readonly IWriteRules[]
    {
        let out = this.writes.get(concept);
        if (out === undefined)
        {
            const list: IWriteRules[] = [];
            for (const [name, rules] of this.scope.Writes)
            {
                if (this.Applies(concept, name))
                {
                    list.push(rules);
                }
            }
            out = list;
            this.writes.set(concept, out);
        }
        return out;
    }

    /**
     * The Endpoints entry applicable to `concept` (keyed by it or an ancestor; ScopeValidator guarantees every
     * applicable entry names the same members), undefined when none applies, and for a name that is not a concept of
     * the catalog (a batch op naming one is rejected by the committer).
     */
    public EndpointsOf(concept: string): IEndpointMembers | undefined
    {
        let out = this.endpoints.get(concept);
        if (out === undefined)
        {
            out = null;
            const catalog = this.reads.Catalog;
            const known = this.scope.Endpoints.size > 0 && catalog.Has(concept) && !catalog.IsAspect(concept);
            for (const [name, members] of known ? this.scope.Endpoints : ScopeEvaluator.NoEndpoints)
            {
                if (this.Applies(concept, name))
                {
                    out = members;
                    break;
                }
            }
            this.endpoints.set(concept, out);
        }
        return out ?? undefined;
    }

    /**
     * The snapshot node at the single-valued relationship `member` of `node` (undefined when unset), visible or not.
     * Records the adjacency read, so a later commit that relinks it conflicts.
     */
    public async EndpointNode(node: IReadNode, member: string): Promise<IReadNode | undefined>
    {
        for (const rel of this.reads.RelationshipsOrNone(node.Concept, member, EdgeDirection.Out))
        {
            for await (const id of this.reads.Adjacent(rel, node.Id, EdgeDirection.Out))
            {
                return this.reads.NodeById(id);
            }
        }
        return undefined;
    }

    /**
     * Members hidden on nodes whose own concept is `concept`: the union of every applicable Hidden entry and the
     * HiddenExact entry keyed by `concept` itself (ruling R94). The single source every Hidden consumer reads.
     */
    public HiddenMembers(concept: string): ReadonlySet<string>
    {
        let out = this.hidden.get(concept);
        if (out === undefined)
        {
            const union = new Set<string>(this.scope.HiddenExact.get(concept) ?? ScopeEvaluator.NoHidden);
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

    /**
     * Members the writer may not write on instances of `concept` at `stage` (a node the batch creates, or an
     * existing one) whose own concept is `concept`: the union of every applicable Writes entry's ReadOnly set for that
     * stage (R92) and the ReadOnlyExact set of the entry keyed by `concept` itself (R94).
     */
    public ReadOnlyMembers(concept: string, stage: WriteStage): ReadonlySet<string>
    {
        const cache = stage === WriteStage.Create ? this.readOnlyCreate : this.readOnlyUpdate;
        let out = cache.get(concept);
        if (out === undefined)
        {
            const union = new Set<string>(ScopeEvaluator.Stage(this.scope.Writes.get(concept)?.ReadOnlyExact, stage));
            for (const rules of this.ApplicableWrites(concept))
            {
                for (const m of ScopeEvaluator.Stage(rules.ReadOnly, stage))
                {
                    union.add(m);
                }
            }
            out = union.size === 0 ? ScopeEvaluator.NoReadOnly : union;
            cache.set(concept, out);
        }
        return out;
    }

    /** The members of `readOnly` for `stage` (none when absent). */
    private static Stage(readOnly: IReadOnlyMembers | undefined, stage: WriteStage): ReadonlySet<string>
    {
        return (stage === WriteStage.Create ? readOnly?.Create : readOnly?.Update) ?? ScopeEvaluator.NoReadOnly;
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

    /**
     * A scope entry applies to the concept itself, its ancestors and its carried aspects. Every key is a
     * known concept or aspect: GraphStore validated the scope against this reader's catalog (R63).
     */
    private Applies(concept: string, name: string): boolean
    {
        return this.reads.Catalog.IsA(concept, name);
    }

    /**
     * The node's visibility within one decision: True or False when settled (a guard-free result is a
     * fact and is cached), Unknown when it depends on a node the decision is still deciding.
     */
    private async Decide(node: IReadNode, evaluation: Evaluation): Promise<Truth>
    {
        const rows = this.ApplicableRows(node.Concept);
        const endpoints = this.EndpointsOf(node.Concept);
        if (rows.length === 0 && (endpoints === undefined || this.scope.Default !== AccessDefault.Allow))
        {
            return this.scope.Default === AccessDefault.Allow ? Truth.True : Truth.False;
        }
        const known = this.visible.get(node.Id);
        if (known !== undefined)
        {
            return known ? Truth.True : Truth.False;
        }
        // A stub's data is external: engine storage cannot decide it, so it is never a settled verdict (never cached).
        if (await this.reads.IsStub(node))
        {
            return Truth.Unknown;
        }
        const memo = evaluation.Memo.get(node.Id);
        // A memoised result depended on the guard, so whoever uses it does too; likewise a guard or budget hit.
        if (memo !== undefined || evaluation.Deciding.has(node.Id) || evaluation.Decisions >= ScopeEvaluator.MaxDecisions)
        {
            evaluation.GuardHits += 1;
            return memo ?? Truth.Unknown;
        }
        evaluation.Decisions += 1;
        const hitsBefore = evaluation.GuardHits;
        evaluation.Deciding.add(node.Id);
        let result = Truth.True;
        try
        {
            const facts = new NodeFacts(node);
            for (const row of rows)
            {
                const t = await this.Eval(row, facts, evaluation);
                if (t === Truth.False)
                {
                    result = Truth.False;
                    break;
                }
                if (t === Truth.Unknown)
                {
                    result = Truth.Unknown;
                }
            }
            if (result !== Truth.False && endpoints !== undefined)
            {
                result = ScopeEvaluator.And(result, await this.EndpointsVisible(node, endpoints, evaluation));
            }
        }
        finally
        {
            evaluation.Deciding.delete(node.Id);
        }
        if (evaluation.GuardHits !== hitsBefore)
        {
            evaluation.Memo.set(node.Id, result);
            return result;
        }
        // Guard-free: an Unknown from null operands is a settled "not visible".
        const visible = result === Truth.True;
        this.visible.set(node.Id, visible);
        return visible ? Truth.True : Truth.False;
    }

    /**
     * The endpoint conjunct of a reified edge node (R130): the Kleene And of the visibility of the nodes at its From and
     * To members, each decided under `evaluation` (cycle guard, memo, budget). An unset member is False: a stored
     * half-edge (never created linked, or left by a delete of an endpoint) fails closed (spec PR4).
     */
    private async EndpointsVisible(node: IReadNode, endpoints: IEndpointMembers, evaluation: Evaluation): Promise<Truth>
    {
        let result = Truth.True;
        for (const member of [endpoints.From, endpoints.To])
        {
            const end = await this.EndpointNode(node, member);
            if (end === undefined)
            {
                return Truth.False;
            }
            result = ScopeEvaluator.And(result, await this.Decide(end, evaluation));
            if (result === Truth.False)
            {
                return result;
            }
        }
        return result;
    }

    /** Kleene And of two truths. */
    private static And(a: Truth, b: Truth): Truth
    {
        if (a === Truth.False || b === Truth.False)
        {
            return Truth.False;
        }
        return a === Truth.Unknown || b === Truth.Unknown ? Truth.Unknown : Truth.True;
    }

    private async Eval(p: Predicate, facts: NodeFacts, evaluation: Evaluation): Promise<Truth>
    {
        if (p.IsNodeLocal)
        {
            await this.Load(p, facts);
            return NodeEvaluator.Evaluate(p, facts.Values, facts.Node.PublicId);
        }
        switch (p.Kind)
        {
            case PredicateKind.And:
                return this.EvalAnd(p as And, facts, evaluation);
            case PredicateKind.Or:
                return this.EvalOr(p as Or, facts, evaluation);
            case PredicateKind.Not:
            {
                const inner = await this.Eval((p as Not).Term, facts, evaluation);
                return inner === Truth.Unknown ? Truth.Unknown : inner === Truth.True ? Truth.False : Truth.True;
            }
            case PredicateKind.Related:
                return this.EvalRelated(p as Related, facts.Node, evaluation);
            case PredicateKind.Reachable:
                return (await this.ReachableSet(p as Reachable)).has(facts.Node.Id) ? Truth.True : Truth.False;
            case PredicateKind.Seeded:
                return (await this.reads.Seeded(facts.Node)) ? Truth.True : Truth.False;
            case PredicateKind.OwnerIs:
                return (p as OwnerIs).Owners.has(await this.reads.Owner(facts.Node)) ? Truth.True : Truth.False;
            case PredicateKind.ConceptIs:
                return facts.Node.Concept === (p as ConceptIs).Concept ? Truth.True : Truth.False;
            default:
                throw new GraphError(GraphErrorCode.Internal, ScopeEvaluator.ErrKind + String(p.Kind));
        }
    }

    private async EvalAnd(p: And, facts: NodeFacts, evaluation: Evaluation): Promise<Truth>
    {
        let result = Truth.True;
        for (const term of p.Terms)
        {
            const t = await this.Eval(term, facts, evaluation);
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

    private async EvalOr(p: Or, facts: NodeFacts, evaluation: Evaluation): Promise<Truth>
    {
        let result = Truth.False;
        for (const term of p.Terms)
        {
            const t = await this.Eval(term, facts, evaluation);
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

    /**
     * Kleene Or over the neighbors of (visible AND Target): True when some neighbor is visible and
     * satisfies Target, Unknown when none does but some could (an Unknown visibility or Target), else False.
     */
    private async EvalRelated(p: Related, node: IReadNode, evaluation: Evaluation): Promise<Truth>
    {
        let result = Truth.False;
        for (const rel of this.reads.RelationshipsOrNone(node.Concept, p.Relationship, p.Direction))
        {
            for await (const id of this.reads.Adjacent(rel, node.Id, p.Direction))
            {
                const t = await this.Neighbor(p, await this.reads.NodeById(id), evaluation);
                if (t === Truth.True)
                {
                    return Truth.True;
                }
                if (t === Truth.Unknown)
                {
                    result = Truth.Unknown;
                }
            }
        }
        return result;
    }

    /**
     * One neighbor's part of a Related: (neighbor visible AND Target), Kleene. A stub neighbor is Unknown: its data is
     * external, so neither its visibility nor Target can be decided from its (empty) stored cells.
     */
    private async Neighbor(p: Related, neighbor: IReadNode, evaluation: Evaluation): Promise<Truth>
    {
        if (await this.reads.IsStub(neighbor))
        {
            return Truth.Unknown;
        }
        const visible = await this.Decide(neighbor, evaluation);
        if (visible === Truth.False)
        {
            return Truth.False;
        }
        const target = await this.Eval(p.Target, new NodeFacts(neighbor), evaluation);
        if (target === Truth.False)
        {
            return Truth.False;
        }
        return visible === Truth.True && target === Truth.True ? Truth.True : Truth.Unknown;
    }

    /** A Rows predicate on a fetched row under D5 (see VisibleFetched). */
    private async EvalFetched(p: Predicate, node: FetchedNode, evaluation: Evaluation): Promise<Truth>
    {
        if (p.IsNodeLocal)
        {
            return NodeEvaluator.Evaluate(p, node.Row.Values, node.PublicId);
        }
        const kind = p.Kind;
        switch (kind)
        {
            case PredicateKind.True:
            case PredicateKind.False:
            case PredicateKind.Compare:
            case PredicateKind.In:
            case PredicateKind.IsNull:
            case PredicateKind.IdIn:
                return NodeEvaluator.Evaluate(p, node.Row.Values, node.PublicId);
            case PredicateKind.And:
                return this.CombineFetched((p as And).Terms, node, evaluation, Truth.False, Truth.True);
            case PredicateKind.Or:
                return this.CombineFetched((p as Or).Terms, node, evaluation, Truth.True, Truth.False);
            case PredicateKind.Not:
            {
                const inner = await this.EvalFetched((p as Not).Term, node, evaluation);
                return inner === Truth.Unknown ? Truth.Unknown : inner === Truth.True ? Truth.False : Truth.True;
            }
            case PredicateKind.Related:
            {
                const related = p as Related;
                return related.Direction === EdgeDirection.Out ? this.FetchedOut(related, node, evaluation) : this.FetchedIn(related, node, evaluation);
            }
            case PredicateKind.Reachable:
                return this.FetchedReachable(p as Reachable, node);
            case PredicateKind.Seeded:
                return Truth.False;
            case PredicateKind.OwnerIs:
                return (p as OwnerIs).Owners.has(node.Owner) ? Truth.True : Truth.False;
            case PredicateKind.ConceptIs:
                return node.Concept === (p as ConceptIs).Concept ? Truth.True : Truth.False;
            default:
            {
                const unknown: never = kind;
                throw new GraphError(GraphErrorCode.Internal, ScopeEvaluator.ErrKind + String(unknown));
            }
        }
    }

    /**
     * Kleene And (dominant False) or Or (dominant True) over a fetched row: the dominant value wins, else Unknown if
     * any, else `identity`.
     */
    private async CombineFetched(terms: readonly Predicate[], node: FetchedNode, evaluation: Evaluation, dominant: Truth, identity: Truth): Promise<Truth>
    {
        let result = identity;
        for (const term of terms)
        {
            const t = await this.EvalFetched(term, node, evaluation);
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

    /**
     * Related Out over the row's Links: an engine-resident target (stored and not a stub) decides as for engine nodes;
     * an external one (a stub, or no stored node) is Unknown, also when Target is True: a link id says nothing about
     * the reader's right to see its target.
     */
    private async FetchedOut(p: Related, node: FetchedNode, evaluation: Evaluation): Promise<Truth>
    {
        if (this.reads.RelationshipsOrNone(node.Concept, p.Relationship, EdgeDirection.Out).length === 0)
        {
            return Truth.False;
        }
        let result = Truth.False;
        for (const target of node.Row.Links.get(p.Relationship) ?? ScopeEvaluator.NoLinks)
        {
            const stored = await this.reads.Locate(target);
            // Neighbor makes a stub Unknown.
            const t = stored === undefined ? Truth.Unknown : await this.Neighbor(p, stored, evaluation);
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

    /**
     * Related In: True when the stub's engine edges make it True; otherwise Unknown when some External binding could
     * hold a source of a relationship of that name targeting the row's concept (such edges never reach engine storage),
     * else the engine result (False without a stub).
     */
    private async FetchedIn(p: Related, node: FetchedNode, evaluation: Evaluation): Promise<Truth>
    {
        const stub = node.StubNode;
        const engine = stub === undefined ? Truth.False : await this.EvalRelated(p, stub, evaluation);
        if (engine === Truth.True)
        {
            return Truth.True;
        }
        for (const rel of this.reads.RelationshipsOrNone(node.Concept, p.Relationship, EdgeDirection.In))
        {
            if (this.reads.ExternallyHeld(rel.DeclaredBy))
            {
                return Truth.Unknown;
            }
        }
        return engine;
    }

    /**
     * Reachable: True when the row's id is in From or the engine BFS reaches the stub; otherwise Unknown without a stub,
     * or when some step's relationship could have an externally held source (a path through external data the engine
     * BFS cannot walk), else False.
     */
    private async FetchedReachable(p: Reachable, node: FetchedNode): Promise<Truth>
    {
        if (p.From.has(node.PublicId))
        {
            return Truth.True;
        }
        const stub = node.Stub;
        if (stub === undefined)
        {
            return Truth.Unknown;
        }
        if ((await this.ReachableSet(p)).has(stub))
        {
            return Truth.True;
        }
        return p.Steps.some(step => this.reads.ExternallyHeldSource(step.Relationship)) ? Truth.Unknown : Truth.False;
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
