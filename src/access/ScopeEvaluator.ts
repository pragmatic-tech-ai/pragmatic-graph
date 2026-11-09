import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { NodeEvaluator, Truth } from '../predicate/NodeEvaluator.js';
import { type And, type ConceptIs, type Not, type Or, type OwnerIs, Predicate, PredicateKind, type Reachable, type Related } from '../predicate/Predicate.js';
import type { IReadNode, RecordedReads } from '../RecordedReads.js';
import { AccessDefault, type AccessScope, type IReadOnlyMembers, type IWriteRules } from './AccessScope.js';
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
 * (Kleene logic, Unknown collapsed to not visible at the top), and Default decides when none applies.
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
    private static readonly NoReadOnly: ReadonlySet<string> = new Set();

    private readonly rows = new Map<string, readonly Predicate[]>();
    private readonly writes = new Map<string, readonly IWriteRules[]>();
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
        if (rows.length === 0)
        {
            return this.scope.Default === AccessDefault.Allow ? Truth.True : Truth.False;
        }
        const known = this.visible.get(node.Id);
        if (known !== undefined)
        {
            return known ? Truth.True : Truth.False;
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
                const neighbor = await this.reads.NodeById(id);
                const visible = await this.Decide(neighbor, evaluation);
                if (visible === Truth.False)
                {
                    continue;
                }
                const target = await this.Eval(p.Target, new NodeFacts(neighbor), evaluation);
                if (visible === Truth.True && target === Truth.True)
                {
                    return Truth.True;
                }
                if (target !== Truth.False)
                {
                    result = Truth.Unknown;
                }
            }
        }
        return result;
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
