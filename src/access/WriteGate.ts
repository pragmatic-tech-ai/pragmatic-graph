import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { CellValue } from '../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { NodeEvaluator, Truth } from '../predicate/NodeEvaluator.js';
import { type And, type ConceptIs, type Not, type Or, type OwnerIs, type Predicate, PredicateKind } from '../predicate/Predicate.js';
import type { IReadNode } from '../RecordedReads.js';
import { type BatchOp, type WriteBatch, WriteOp } from '../txn/WriteBatch.js';
import { AccessError, AccessErrorCode } from './AccessError.js';
import { AccessDefault, type IWriteRules } from './AccessScope.js';
import type { FetchedNode } from './FetchedNode.js';
import type { ScopeEvaluator } from './ScopeEvaluator.js';
import { WriteExemptions } from './WriteExemptions.js';
import { WriteStage } from './WriteStage.js';

/**
 * A node the batch creates: its CreateNode op index, concept, owner ('' for none), the values the batch sets on it
 * (last wins) and, per relationship member, the targets it links at the end of the batch (a Link adds, an Unlink
 * removes, so a link-then-unlink leaves the member unset).
 */
class CreatedNode
{
    public readonly Values = new Map<string, CellValue>();

    /** False for an unknown or aspect concept: the committer rejects the op itself, so the gate skips it. */
    public readonly Known: boolean;

    /** True once a later DeleteNode of the batch removes it (nothing of it is stored). */
    public Deleted = false;

    private readonly linked = new Map<string, Set<string>>();

    public constructor(public readonly Index: number, public readonly PublicId: string, public readonly Concept: string, public readonly Owner: string, catalog: CatalogSnapshot)
    {
        this.Known = catalog.Has(Concept) && !catalog.IsAspect(Concept);
    }

    public Link(member: string, target: string): void
    {
        let targets = this.linked.get(member);
        if (targets === undefined)
        {
            targets = new Set<string>();
            this.linked.set(member, targets);
        }
        targets.add(target);
    }

    public Unlink(member: string, target: string): void
    {
        this.linked.get(member)?.delete(target);
    }

    /** True iff the batch leaves `member` linked to some target. */
    public IsLinked(member: string): boolean
    {
        return (this.linked.get(member)?.size ?? 0) > 0;
    }
}

/**
 * What one op addresses, each slot the node the batch created (when it did, live at that point) or
 * undefined for a snapshot node: the source (or the node itself), a Link/Unlink target and the
 * AfterSibling/BeforeSibling a Link names.
 */
class OpTargets
{
    public constructor(
        public readonly Source: CreatedNode | undefined,
        public readonly Target: CreatedNode | undefined = undefined,
        public readonly After: CreatedNode | undefined = undefined,
        public readonly Before: CreatedNode | undefined = undefined)
    {
    }
}

/**
 * Evaluates a Create rule on a node that exists only in the batch (ruling R69): node-local subtrees by
 * NodeEvaluator on the end-of-batch values, OwnerIs against the CreateNode op's owner, ConceptIs against its
 * concept, Seeded as false
 * (a transaction never seeds); Kleene logic across the tree, collapsed at the top. Related and Reachable
 * would need the graph, which a batch is not (R30): such a rule is refused before evaluation.
 */
class CreateEvaluator
{
    private static readonly ErrUndecidable = 'Create rule evaluated a predicate Decidable refuses: ';
    private static readonly ErrKind = 'Unknown predicate kind in a Create rule: ';

    /** True iff `p` can be decided on a created node alone (no Related or Reachable anywhere). */
    public static Decidable(p: Predicate): boolean
    {
        switch (p.Kind)
        {
            case PredicateKind.Related:
            case PredicateKind.Reachable:
                return false;
            case PredicateKind.And:
            case PredicateKind.Or:
                return (p as And | Or).Terms.every(t => CreateEvaluator.Decidable(t));
            case PredicateKind.Not:
                return CreateEvaluator.Decidable((p as Not).Term);
            default:
                return true;
        }
    }

    public static Holds(p: Predicate, node: CreatedNode): boolean
    {
        return CreateEvaluator.Eval(p, node) === Truth.True;
    }

    private static Eval(p: Predicate, node: CreatedNode): Truth
    {
        if (p.IsNodeLocal)
        {
            return NodeEvaluator.Evaluate(p, node.Values, node.PublicId);
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
                // Always node-local, so handled above; kept for exhaustiveness.
                return NodeEvaluator.Evaluate(p, node.Values, node.PublicId);
            case PredicateKind.Seeded:
                return Truth.False;
            case PredicateKind.OwnerIs:
                return (p as OwnerIs).Owners.has(node.Owner) ? Truth.True : Truth.False;
            case PredicateKind.ConceptIs:
                return node.Concept === (p as ConceptIs).Concept ? Truth.True : Truth.False;
            case PredicateKind.Not:
            {
                const inner = CreateEvaluator.Eval((p as Not).Term, node);
                return inner === Truth.Unknown ? Truth.Unknown : inner === Truth.True ? Truth.False : Truth.True;
            }
            case PredicateKind.And:
                return CreateEvaluator.Combine((p as And).Terms, node, Truth.False, Truth.True);
            case PredicateKind.Or:
                return CreateEvaluator.Combine((p as Or).Terms, node, Truth.True, Truth.False);
            case PredicateKind.Related:
            case PredicateKind.Reachable:
                // Unreachable: Decidable refused them before evaluation. Never fail open (a False here would grant under Not).
                throw new GraphError(GraphErrorCode.Internal, CreateEvaluator.ErrUndecidable + PredicateKind[kind]);
            default:
            {
                const unknown: never = kind;
                throw new GraphError(GraphErrorCode.Internal, CreateEvaluator.ErrKind + String(unknown));
            }
        }
    }

    /**
     * Kleene And (dominant False) or Or (dominant True): the dominant value wins, else Unknown if any, else `identity`.
     */
    private static Combine(terms: readonly Predicate[], node: CreatedNode, dominant: Truth, identity: Truth): Truth
    {
        let result = identity;
        for (const term of terms)
        {
            const t = CreateEvaluator.Eval(term, node);
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

/**
 * A node the batch did not create, as the gate decides it: a stored engine node, or an external node's row fetched in the
 * transaction (ruling R103). Exactly one of Engine and External is set.
 */
class ExistingNode
{
    private constructor(public readonly PublicId: string, public readonly Concept: string, public readonly Engine: IReadNode | undefined, public readonly External: FetchedNode | undefined)
    {
    }

    public static OfEngine(node: IReadNode): ExistingNode
    {
        return new ExistingNode(node.PublicId, node.Concept, node, undefined);
    }

    public static OfExternal(node: FetchedNode): ExistingNode
    {
        return new ExistingNode(node.PublicId, node.Concept, undefined, node);
    }
}

/** Selects one kind of write rule from an entry. */
enum RuleKind
{
    Create = 1,
    Update = 2,
    Delete = 3,
    Append = 4,
    AppendTo = 5,
}

/**
 * Internal: enforces a transaction's AccessScope on its WriteBatch at commit, before anything is
 * submitted (ruling R68). Ops are checked in order and the first refused raises an AccessError naming
 * the op index, the public id and the concept.
 *
 * - CreateNode: every applicable Create predicate holds on the node's end-of-batch values (set in the
 *   batch, unset = null), its op's owner (OwnerIs) and Seeded = false (CreateEvaluator). A Create
 *   predicate using Related or Reachable is not node-local and denies the create.
 * - SetProperty (the node), Link and Unlink (the node is the edge's source): the node must be visible and every
 *   applicable Update (SetProperty) or Append (Link/Unlink) predicate hold on its snapshot values (R30, R129); a node
 *   the batch created is exempt. A Link/Unlink target must also satisfy every applicable AppendTo predicate (R129).
 *   The member written must not be hidden on the node's concept (Hidden or its own concept's HiddenExact), nor
 *   read-only (ruling R92): the entries' ReadOnly.Create sets on a node the batch created, their ReadOnly.Update sets
 *   on an existing node, plus the same stage of the own concept's entry's ReadOnlyExact (R94). A host-placed default
 *   on a node the batch created (GraphTransaction.SetDefault, R91) is exempt from both; an unlink a DETACH DELETE
 *   implies (GraphTransaction.DetachUnlink) is exempt from ReadOnly, from the source's Append rule and from the
 *   target's AppendTo rule when the batch later deletes one of its ends (ruling F-a: only the Delete rule governs
 *   it). A Link/Unlink target and a Link's AfterSibling/BeforeSibling must be visible (or created by the batch and
 *   live at that op); AppendTo is checked after all of those, so InvisibleNode is reported first.
 * - DeleteNode: the node must be visible and every applicable Delete predicate hold on its snapshot
 *   values; deleting a node the batch created is exempt.
 * - Reified edge nodes (a node with an applicable Endpoints entry, ruling R130): a Link/Unlink of its From member
 *   needs the target's Append rule instead of its AppendTo rule (AppendDenied), of its To member the target's AppendTo
 *   rule (AppendToDenied), also when the batch created the edge node; the edge node's own Append rule still governs
 *   it as the source. DeleteNode of an edge node also needs Append on the node at From and AppendTo on the node at
 *   To, and SetProperty on one the batch did not create Append on the node at From (snapshot endpoints). An endpoint
 *   the batch created and a delete-implied unlink stay exempt. A batch that creates an edge node (and keeps it) must
 *   leave both its From and its To member linked, else AppendDenied (From) or AppendToDenied (To) on the CreateNode op,
 *   checked after every other op; a stored edge node with an unset member is invisible. An endpoint the gate cannot
 *   see (an external stub whose row the transaction never fetched) is InvisibleNode, as a never-fetched Link target
 *   (R103), and is not named.
 *
 * External nodes (ruling R103): a node the batch did not create whose public id names no stored engine node, or names
 * a stub (R102), is external data. It is decided against the row the transaction fetched for it (`fetched`): visible
 * under the scope as a read decides it (ScopeEvaluator.VisibleFetched), and its Update and Delete rules evaluated on
 * that row (HoldsFetched). An external node the transaction never fetched, or whose row the scope does not admit, is
 * InvisibleNode, exactly as a missing or invisible engine node; this holds for an op's source, a Link/Unlink target
 * (a Link carrying ExternalTarget included) and a sibling. Create rules are evaluated as for engine nodes.
 *
 * Applicable entries are those keyed by the node's concept, an ancestor or a carried aspect; with no
 * applicable predicate of the op's kind the scope's Default decides. A node that does not exist in the
 * snapshot reads as invisible (the gate never reveals which). Every read goes through the evaluator's
 * recorded reads, so a permission granted on a value changed by a later commit conflicts.
 */
export class WriteGate
{
    private static readonly ErrNotNodeLocal = 'its Create predicate is not node-local (Create rules may read only the new node\'s own values, owner and seededness)';
    private static readonly ErrCreate = 'a Create rule does not hold on the new node\'s values';
    private static readonly ErrUpdate = 'an Update rule does not hold on the node';
    private static readonly ErrDelete = 'a Delete rule does not hold on the node';
    private static readonly ErrAppend = 'an Append rule does not hold on the source';
    private static readonly ErrAppendTo = 'an AppendTo rule does not hold on the target: ';
    private static readonly ErrEndpointAppend = 'an Append rule does not hold on the edge\'s From node: ';
    private static readonly ErrEndpointAppendTo = 'an AppendTo rule does not hold on the edge\'s To node: ';
    private static readonly ErrDefault = 'the scope has no rule for it and denies by default';
    private static readonly ErrHidden = 'the scope hides member ';
    private static readonly ErrReadOnly = 'the scope makes member read-only: ';
    private static readonly ErrInvisible = 'the node is not visible under the scope';
    private static readonly ErrInvisibleTarget = 'the target is not visible under the scope: ';
    private static readonly ErrInvisibleSibling = 'the sibling is not visible under the scope: ';
    private static readonly ErrInvisibleEndpoint = 'an endpoint of the edge node is not visible under the scope';
    private static readonly ErrUnlinkedFrom = 'the batch creates the edge node without linking its From member';
    private static readonly ErrUnlinkedTo = 'the batch creates the edge node without linking its To member';
    private static readonly ErrSeedOnly = 'an owner change is recorded by seed synchronization only';
    private static readonly NoOwner = '';
    /** The op index a synthetic created node (one the transaction created outside this batch) carries; it is never an op. */
    private static readonly AssignedIndex = -1;
    private static readonly NoCreated: ReadonlyMap<string, string> = new Map();
    private static readonly AccessDenied = 'Access denied: op ';
    private static readonly Open = ' (';
    private static readonly Close = ')';
    private static readonly On = ' on \'';
    private static readonly Quote = '\'';
    private static readonly Colon = ': ';
    private static readonly NotVisible = 'concept not visible';

    private readonly targets: OpTargets[] = [];
    /** The nodes the batch creates, in op order. */
    private readonly created: CreatedNode[] = [];
    /** Per rule kind and public id, whether the node's rules of that kind hold (decided once per node). */
    private readonly decided = new Map<RuleKind, Map<string, boolean>>();
    /** Per public id, the index of the batch's last DeleteNode of it. */
    private readonly lastDelete = new Map<string, number>();

    private constructor(
        private readonly evaluator: ScopeEvaluator,
        private readonly catalog: CatalogSnapshot,
        private readonly exempt: WriteExemptions,
        private readonly fetched: ((publicId: string) => Promise<FetchedNode | undefined>) | undefined,
        private readonly externalCreated: ReadonlyMap<string, string>)
    {
    }

    /**
     * Throws AccessError for the first op of `batch` the evaluator's scope does not allow; `exempt` as WriteExemptions.
     * `fetched`: the row the transaction fetched for an external public id (its stub attached), undefined when it
     * fetched none; without it every external node reads as not fetched.
     * `externalCreated`: public id -> concept of the nodes the transaction created outside this batch (CreateAssigned,
     * ruling R136 E4). An op on such a node gets the same created-node exemption the gate gives a node a CreateNode op
     * of the batch creates (no visibility, Update/Append/AppendTo/Delete or ReadOnly.Update check; a visible
     * Link/Unlink target), because its Create rules and ReadOnly.Create were already judged when it was created.
     */
    public static async Check(
        evaluator: ScopeEvaluator,
        batch: WriteBatch,
        catalog: CatalogSnapshot,
        exempt: WriteExemptions = WriteExemptions.None(),
        fetched?: (publicId: string) => Promise<FetchedNode | undefined>,
        from = 0,
        externalCreated: ReadonlyMap<string, string> = WriteGate.NoCreated): Promise<void>
    {
        const gate = new WriteGate(evaluator, catalog, exempt, fetched, externalCreated);
        const ops = batch.Ops();
        // The whole batch resolves (a step's op may address a node an earlier step created), but only the ops from
        // `from` are judged: earlier steps were checked at their own flush (ruling R135 E2, incremental gate).
        gate.Resolve(ops);
        for (let i = from; i < ops.length; i++)
        {
            await gate.CheckOp(i, ops[i] as BatchOp);
        }
        gate.CheckCreatedEdges(from);
    }

    /** First pass: which ops address nodes the batch creates, and those nodes' end-of-batch values. */
    private Resolve(ops: readonly BatchOp[]): void
    {
        const live = new Map<string, CreatedNode>();
        // Nodes the transaction created outside this batch (CreateAssigned) are live and exempt from here on, as if a
        // CreateNode op had created them (ruling R136 E4). They are not added to `this.created`, so CheckCreatedEdges and
        // CheckCreate never re-judge them (their Create rules ran at CreateAssigned).
        for (const [publicId, concept] of this.externalCreated)
        {
            live.set(publicId, new CreatedNode(WriteGate.AssignedIndex, publicId, concept, WriteGate.NoOwner, this.catalog));
        }
        for (const op of ops)
        {
            switch (op.Op)
            {
                case WriteOp.CreateNode:
                {
                    const node = new CreatedNode(this.targets.length, op.PublicId, op.Concept, op.Owner ?? WriteGate.NoOwner, this.catalog);
                    live.set(op.PublicId, node);
                    this.created.push(node);
                    this.targets.push(new OpTargets(node));
                    break;
                }
                case WriteOp.SetProperty:
                {
                    const node = live.get(op.PublicId);
                    node?.Values.set(op.Member, op.Value);
                    this.targets.push(new OpTargets(node));
                    break;
                }
                case WriteOp.DeleteNode:
                {
                    const node = live.get(op.PublicId);
                    this.lastDelete.set(op.PublicId, this.targets.length);
                    this.targets.push(new OpTargets(node));
                    if (node !== undefined)
                    {
                        node.Deleted = true;
                    }
                    live.delete(op.PublicId);
                    break;
                }
                case WriteOp.Link:
                {
                    const after = op.Options?.AfterSibling;
                    const before = op.Options?.BeforeSibling;
                    live.get(op.From)?.Link(op.Relationship, op.To);
                    this.targets.push(new OpTargets(live.get(op.From), live.get(op.To), after === undefined ? undefined : live.get(after), before === undefined ? undefined : live.get(before)));
                    break;
                }
                case WriteOp.Unlink:
                    live.get(op.From)?.Unlink(op.Relationship, op.To);
                    this.targets.push(new OpTargets(live.get(op.From), live.get(op.To)));
                    break;
                case WriteOp.SetOwner:
                    this.targets.push(new OpTargets(live.get(op.PublicId)));
                    break;
            }
        }
    }

    private async CheckOp(index: number, op: BatchOp): Promise<void>
    {
        const targets = this.targets[index] as OpTargets;
        switch (op.Op)
        {
            case WriteOp.CreateNode:
                this.CheckCreate(index, op.PublicId, targets.Source as CreatedNode);
                break;
            case WriteOp.SetProperty:
            {
                const placed = this.IsPlacedDefault(index, targets);
                const node = await this.CheckWrite(index, op.Op, op.PublicId, op.Member, targets.Source, placed, false, RuleKind.Update);
                const endpoints = node instanceof ExistingNode ? this.evaluator.EndpointsOf(node.Concept) : undefined;
                if (node instanceof ExistingNode && endpoints !== undefined)
                {
                    await this.CheckEndpoint(index, op.Op, node, endpoints.From, RuleKind.Append);
                }
                break;
            }
            case WriteOp.Link:
            case WriteOp.Unlink:
            {
                const detach = op.Op === WriteOp.Unlink && this.IsDetach(index, op.From, op.To);
                const concept = (await this.CheckWrite(index, op.Op, op.From, op.Relationship, targets.Source, false, detach, RuleKind.Append)).Concept;
                // An external target (a stub, or no stored node: an ExternalTarget link creates its stub, R102) is decided
                // against the row the transaction fetched (R103); a stored engine node keeps the ordinary rule.
                const target = await this.CheckReferenced(index, op.Op, op.From, concept, op.To, targets.Target, WriteGate.ErrInvisibleTarget);
                if (op.Op === WriteOp.Link)
                {
                    // The committer resolves siblings unscoped: an unchecked one would be an existence oracle.
                    const options = op.Options;
                    if (options?.AfterSibling !== undefined)
                    {
                        await this.CheckReferenced(index, op.Op, op.From, concept, options.AfterSibling, targets.After, WriteGate.ErrInvisibleSibling);
                    }
                    if (options?.BeforeSibling !== undefined)
                    {
                        await this.CheckReferenced(index, op.Op, op.From, concept, options.BeforeSibling, targets.Before, WriteGate.ErrInvisibleSibling);
                    }
                }
                // Last, so every visibility check (target, siblings) reports InvisibleNode first.
                if (target !== undefined && !detach)
                {
                    await this.CheckTarget(index, op.Op, op.From, concept, op.Relationship, op.To, target);
                }
                break;
            }
            case WriteOp.DeleteNode:
                await this.CheckDelete(index, op.PublicId, targets.Source);
                break;
            case WriteOp.SetOwner:
                // Unreachable through GraphTransaction (ruling R90); a gated batch never re-owns.
                throw this.Denied(AccessErrorCode.UpdateDenied, index, op.Op, op.PublicId, targets.Source?.Concept, WriteGate.ErrSeedOnly);
        }
    }

    /**
     * After every op passed: a reified edge node the batch creates (and does not delete) must leave the batch linked at
     * both its From and its To member (R130), else AppendDenied (From) or AppendToDenied (To) on its CreateNode op. A
     * stored edge node with an unset member is invisible, so the create is the only point a half-edge could be written
     * on purpose; a delete-implied unlink in the batch also leaves the member unset.
     */
    private CheckCreatedEdges(from: number): void
    {
        for (const node of this.created)
        {
            // Edge nodes created in an earlier step were completed and checked at that step's flush (R135 E2).
            if (node.Index < from)
            {
                continue;
            }
            const endpoints = node.Known && !node.Deleted ? this.evaluator.EndpointsOf(node.Concept) : undefined;
            if (endpoints === undefined)
            {
                continue;
            }
            if (!node.IsLinked(endpoints.From))
            {
                throw this.Denied(AccessErrorCode.AppendDenied, node.Index, WriteOp.CreateNode, node.PublicId, node.Concept, WriteGate.ErrUnlinkedFrom);
            }
            if (!node.IsLinked(endpoints.To))
            {
                throw this.Denied(AccessErrorCode.AppendToDenied, node.Index, WriteOp.CreateNode, node.PublicId, node.Concept, WriteGate.ErrUnlinkedTo);
            }
        }
    }

    /**
     * A node a Link/Unlink names besides its source must be created by the batch or visible (a recorded read);
     * resolves with the visible snapshot node, undefined when the batch created it.
     */
    private async CheckReferenced(index: number, op: WriteOp, from: string, concept: string, publicId: string, created: CreatedNode | undefined, reason: string): Promise<ExistingNode | undefined>
    {
        if (created !== undefined)
        {
            return undefined;
        }
        const node = await this.VisibleNode(publicId);
        if (node === undefined)
        {
            throw this.Denied(AccessErrorCode.InvisibleNode, index, op, from, concept, reason + publicId);
        }
        return node;
    }

    private CheckCreate(index: number, publicId: string, node: CreatedNode): void
    {
        if (!node.Known)
        {
            return;
        }
        const op = WriteOp.CreateNode;
        const rules = this.Rules(node.Concept, RuleKind.Create);
        if (rules.length === 0)
        {
            if (this.evaluator.Scope.Default !== AccessDefault.Allow)
            {
                throw this.Denied(AccessErrorCode.CreateDenied, index, op, publicId, node.Concept, WriteGate.ErrDefault);
            }
            return;
        }
        // The restriction is reported whatever the other rules say, so it never depends on entry order.
        if (rules.some(rule => !CreateEvaluator.Decidable(rule)))
        {
            throw this.Denied(AccessErrorCode.CreateDenied, index, op, publicId, node.Concept, WriteGate.ErrNotNodeLocal);
        }
        for (const rule of rules)
        {
            if (!CreateEvaluator.Holds(rule, node))
            {
                throw this.Denied(AccessErrorCode.CreateDenied, index, op, publicId, node.Concept, WriteGate.ErrCreate);
            }
        }
    }

    /**
     * The (visible, snapshot) target of a Link/Unlink of `member` must satisfy its AppendTo rules (R129); when the
     * source is a reified edge node and `member` is its From, its Append rules instead (R130). The caller skips
     * created targets and delete-implied unlinks.
     */
    private async CheckTarget(index: number, op: WriteOp, from: string, concept: string, member: string, to: string, target: ExistingNode): Promise<void>
    {
        const endpoints = this.evaluator.EndpointsOf(concept);
        if (endpoints !== undefined && (member === endpoints.From || member === endpoints.To))
        {
            await this.CheckEndpointNode(index, op, from, concept, target, member === endpoints.From ? RuleKind.Append : RuleKind.AppendTo);
            return;
        }
        if (!(await this.Decide(target, RuleKind.AppendTo)))
        {
            throw this.Denied(AccessErrorCode.AppendToDenied, index, op, from, concept, this.Reason(target.Concept, RuleKind.AppendTo, WriteGate.ErrAppendTo + to));
        }
    }

    /**
     * The snapshot node at `member` of the visible reified edge node `edge` must satisfy its `kind` rules (Append on
     * From, AppendTo on To; R130). An edge node is never external (ScopeValidator), and a visible one has both members
     * set (a stored half-edge is invisible, so RequireVisible already refused it); an unset member here fails closed as
     * InvisibleNode all the same.
     */
    private async CheckEndpoint(index: number, op: WriteOp, edge: ExistingNode, member: string, kind: RuleKind): Promise<void>
    {
        const stored = edge.Engine === undefined ? undefined : await this.evaluator.EndpointNode(edge.Engine, member);
        const end = stored === undefined ? undefined : await this.VisibleNode(stored.PublicId);
        if (end === undefined)
        {
            // A stub endpoint whose concept has no applicable Rows leaves the edge node visible, but the transaction may
            // never have fetched its row: InvisibleNode, as for a never-fetched external Link target (R103). The
            // endpoint is not named.
            throw this.Denied(AccessErrorCode.InvisibleNode, index, op, edge.PublicId, edge.Concept, WriteGate.ErrInvisibleEndpoint);
        }
        await this.CheckEndpointNode(index, op, edge.PublicId, edge.Concept, end, kind);
    }

    /** `end`, an endpoint of the edge node `publicId`, must satisfy its `kind` (Append or AppendTo) rules (R130). */
    private async CheckEndpointNode(index: number, op: WriteOp, publicId: string, concept: string, end: ExistingNode, kind: RuleKind): Promise<void>
    {
        if (!(await this.Decide(end, kind)))
        {
            throw this.Denied(WriteGate.EndpointCode(kind), index, op, publicId, concept, this.Reason(end.Concept, kind, WriteGate.EndpointReason(kind) + end.PublicId));
        }
    }

    private static EndpointCode(kind: RuleKind): AccessErrorCode
    {
        return kind === RuleKind.Append ? AccessErrorCode.AppendDenied : AccessErrorCode.AppendToDenied;
    }

    private static EndpointReason(kind: RuleKind): string
    {
        return kind === RuleKind.Append ? WriteGate.ErrEndpointAppend : WriteGate.ErrEndpointAppendTo;
    }

    /** A SetDefault op on a node the batch created (live at that op): exempt from Hidden and ReadOnly (R91). */
    private IsPlacedDefault(index: number, targets: OpTargets): boolean
    {
        return targets.Source !== undefined && this.exempt.Defaults.has(index);
    }

    /**
     * A DetachUnlink op one of whose ends the batch deletes later: exempt from ReadOnly, Append and AppendTo (R92, F-a,
     * R129), endpoint rules included (R130).
     */
    private IsDetach(index: number, from: string, to: string): boolean
    {
        return this.exempt.Detaches.has(index) && ((this.lastDelete.get(from) ?? -1) > index || (this.lastDelete.get(to) ?? -1) > index);
    }

    /**
     * SetProperty, Link or Unlink of `member` on the node `publicId` (an edge's source); resolves with the node (the
     * created one, or the visible snapshot node).
     * `placed`: a default the host placed on a node the batch created, exempt from Hidden and ReadOnly.
     * `detach`: an unlink a later delete in the batch implies, exempt from ReadOnly and the Update/Append rule (F-a).
     * `kind`: Update for SetProperty, Append for Link/Unlink (R129).
     */
    private async CheckWrite(index: number, op: WriteOp, publicId: string, member: string, created: CreatedNode | undefined, placed: boolean, detach: boolean, kind: RuleKind): Promise<CreatedNode | ExistingNode>
    {
        if (created !== undefined)
        {
            if (created.Known && !placed)
            {
                this.CheckHidden(index, op, publicId, created.Concept, member);
                if (!detach)
                {
                    this.CheckReadOnly(index, op, publicId, created.Concept, member, WriteStage.Create);
                }
            }
            return created;
        }
        const node = await this.RequireVisible(index, op, publicId);
        this.CheckHidden(index, op, publicId, node.Concept, member);
        if (detach)
        {
            // Ruling F-a (R92): a delete-implied unlink is governed only by the Delete rule of the node the batch
            // deletes, never by the source's ReadOnly or Append rules or the target's AppendTo rule.
            return node;
        }
        this.CheckReadOnly(index, op, publicId, node.Concept, member, WriteStage.Update);
        if (!(await this.Decide(node, kind)))
        {
            const append = kind === RuleKind.Append;
            throw this.Denied(append ? AccessErrorCode.AppendDenied : AccessErrorCode.UpdateDenied, index, op, publicId, node.Concept,
                this.Reason(node.Concept, kind, append ? WriteGate.ErrAppend : WriteGate.ErrUpdate));
        }
        return node;
    }

    /** `Allows`, decided once per node and kind within the batch. */
    private async Decide(node: ExistingNode, kind: RuleKind): Promise<boolean>
    {
        let byNode = this.decided.get(kind);
        if (byNode === undefined)
        {
            byNode = new Map<string, boolean>();
            this.decided.set(kind, byNode);
        }
        let allowed = byNode.get(node.PublicId);
        if (allowed === undefined)
        {
            allowed = await this.Allows(node, kind);
            byNode.set(node.PublicId, allowed);
        }
        return allowed;
    }

    private async CheckDelete(index: number, publicId: string, created: CreatedNode | undefined): Promise<void>
    {
        const op = WriteOp.DeleteNode;
        if (created !== undefined)
        {
            return;
        }
        const node = await this.RequireVisible(index, op, publicId);
        if (!(await this.Allows(node, RuleKind.Delete)))
        {
            throw this.Denied(AccessErrorCode.DeleteDenied, index, op, publicId, node.Concept, this.Reason(node.Concept, RuleKind.Delete, WriteGate.ErrDelete));
        }
        const endpoints = this.evaluator.EndpointsOf(node.Concept);
        if (endpoints !== undefined)
        {
            // Removing the edge node removes the edge: Append on its From node, AppendTo on its To node (R130).
            await this.CheckEndpoint(index, op, node, endpoints.From, RuleKind.Append);
            await this.CheckEndpoint(index, op, node, endpoints.To, RuleKind.AppendTo);
        }
    }

    private CheckHidden(index: number, op: WriteOp, publicId: string, concept: string, member: string): void
    {
        if (this.evaluator.HiddenMembers(concept).has(member))
        {
            throw this.Denied(AccessErrorCode.HiddenMember, index, op, publicId, concept, WriteGate.ErrHidden + member);
        }
    }

    private CheckReadOnly(index: number, op: WriteOp, publicId: string, concept: string, member: string, stage: WriteStage): void
    {
        if (this.evaluator.ReadOnlyMembers(concept, stage).has(member))
        {
            throw this.Denied(AccessErrorCode.MemberReadOnly, index, op, publicId, concept, WriteGate.ErrReadOnly + member);
        }
    }

    /**
     * True iff every applicable rule of `kind` holds on the node's snapshot values, or on an external node's fetched row
     * (none: the Default decides).
     */
    private async Allows(node: ExistingNode, kind: RuleKind): Promise<boolean>
    {
        const rules = this.Rules(node.Concept, kind);
        if (rules.length === 0)
        {
            return this.evaluator.Scope.Default === AccessDefault.Allow;
        }
        for (const rule of rules)
        {
            const holds = node.External !== undefined ? await this.evaluator.HoldsFetched(rule, node.External) : await this.evaluator.Holds(rule, node.Engine as IReadNode);
            if (!holds)
            {
                return false;
            }
        }
        return true;
    }

    private async RequireVisible(index: number, op: WriteOp, publicId: string): Promise<ExistingNode>
    {
        const node = await this.VisibleNode(publicId);
        if (node === undefined)
        {
            throw this.Denied(AccessErrorCode.InvisibleNode, index, op, publicId, undefined, WriteGate.ErrInvisible);
        }
        return node;
    }

    /**
     * The snapshot node when it exists and is visible; for an external node (a stub, or no stored node) the row the
     * transaction fetched when the scope admits it (ruling R103). Missing, not fetched and invisible are
     * indistinguishable.
     */
    private async VisibleNode(publicId: string): Promise<ExistingNode | undefined>
    {
        const node = await this.evaluator.Locate(publicId);
        if (node === undefined || (await this.evaluator.IsStub(node)))
        {
            const row = await this.fetched?.(publicId);
            return row !== undefined && (await this.evaluator.VisibleFetched(row)) ? ExistingNode.OfExternal(row) : undefined;
        }
        return (await this.evaluator.IsVisible(node)) ? ExistingNode.OfEngine(node) : undefined;
    }

    private Rules(concept: string, kind: RuleKind): readonly Predicate[]
    {
        const out: Predicate[] = [];
        for (const rules of this.evaluator.ApplicableWrites(concept))
        {
            const rule = WriteGate.Rule(rules, kind);
            if (rule !== undefined)
            {
                out.push(rule);
            }
        }
        return out;
    }

    private Reason(concept: string, kind: RuleKind, failed: string): string
    {
        return this.Rules(concept, kind).length === 0 ? WriteGate.ErrDefault : failed;
    }

    private static Rule(rules: IWriteRules, kind: RuleKind): Predicate | undefined
    {
        switch (kind)
        {
            case RuleKind.Create:
                return rules.Create;
            case RuleKind.Update:
                return rules.Update;
            case RuleKind.Delete:
                return rules.Delete;
            case RuleKind.Append:
                return rules.Append;
            case RuleKind.AppendTo:
                return rules.AppendTo;
        }
    }

    /** "Access denied: op 2 (SetProperty) on 't' (Ticket): reason"; an invisible node's concept is not named. */
    private Denied(code: AccessErrorCode, index: number, op: WriteOp, publicId: string, concept: string | undefined, reason: string): AccessError
    {
        return new AccessError(code, WriteGate.AccessDenied + index + WriteGate.Open + WriteOp[op] + WriteGate.Close + WriteGate.On + publicId + WriteGate.Quote
            + WriteGate.Open + (concept ?? WriteGate.NotVisible) + WriteGate.Close + WriteGate.Colon + reason);
    }
}
