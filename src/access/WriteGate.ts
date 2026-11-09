import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { CellValue } from '../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { NodeEvaluator, Truth } from '../predicate/NodeEvaluator.js';
import { type And, type ConceptIs, type Not, type Or, type OwnerIs, type Predicate, PredicateKind } from '../predicate/Predicate.js';
import type { IReadNode } from '../RecordedReads.js';
import { type BatchOp, type WriteBatch, WriteOp } from '../txn/WriteBatch.js';
import { AccessError, AccessErrorCode } from './AccessError.js';
import { AccessDefault, type IWriteRules } from './AccessScope.js';
import type { ScopeEvaluator } from './ScopeEvaluator.js';
import { WriteExemptions } from './WriteExemptions.js';
import { WriteStage } from './WriteStage.js';

/** A node the batch creates: its concept, owner ('' for none) and the values the batch sets on it (last wins). */
class CreatedNode
{
    public readonly Values = new Map<string, CellValue>();

    /** False for an unknown or aspect concept: the committer rejects the op itself, so the gate skips it. */
    public readonly Known: boolean;

    public constructor(public readonly PublicId: string, public readonly Concept: string, public readonly Owner: string, catalog: CatalogSnapshot)
    {
        this.Known = catalog.Has(Concept) && !catalog.IsAspect(Concept);
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

/** Selects one kind of write rule from an entry. */
enum RuleKind
{
    Create = 1,
    Update = 2,
    Delete = 3,
}

/**
 * Internal: enforces a transaction's AccessScope on its WriteBatch at commit, before anything is
 * submitted (ruling R68). Ops are checked in order and the first refused raises an AccessError naming
 * the op index, the public id and the concept.
 *
 * - CreateNode: every applicable Create predicate holds on the node's end-of-batch values (set in the
 *   batch, unset = null), its op's owner (OwnerIs) and Seeded = false (CreateEvaluator). A Create
 *   predicate using Related or Reachable is not node-local and denies the create.
 * - SetProperty, Link, Unlink (the node is the edge's source): the node must be visible and every
 *   applicable Update predicate hold on its snapshot values (R30); a node the batch created is exempt.
 *   The member written must not be hidden on the node's concept, nor read-only (ruling R92): the entries'
 *   ReadOnly.Create sets on a node the batch created, their ReadOnly.Update sets on an existing node. A host-placed
 *   default on a node the batch created (GraphTransaction.SetDefault, R91) is exempt from both; an unlink a
 *   DETACH DELETE implies (GraphTransaction.DetachUnlink) is exempt from ReadOnly when the batch later deletes
 *   one of its ends (the Delete rule governs it). A Link/Unlink target and a Link's
 *   AfterSibling/BeforeSibling must be visible (or created by the batch and live at that op).
 * - DeleteNode: the node must be visible and every applicable Delete predicate hold on its snapshot
 *   values; deleting a node the batch created is exempt.
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
    private static readonly ErrDefault = 'the scope has no rule for it and denies by default';
    private static readonly ErrHidden = 'the scope hides member ';
    private static readonly ErrReadOnly = 'the scope makes member read-only: ';
    private static readonly ErrInvisible = 'the node is not visible under the scope';
    private static readonly ErrInvisibleTarget = 'the target is not visible under the scope: ';
    private static readonly ErrInvisibleSibling = 'the sibling is not visible under the scope: ';
    private static readonly ErrSeedOnly = 'an owner change is recorded by seed synchronization only';
    private static readonly NoOwner = '';
    private static readonly AccessDenied = 'Access denied: op ';
    private static readonly Open = ' (';
    private static readonly Close = ')';
    private static readonly On = ' on \'';
    private static readonly Quote = '\'';
    private static readonly Colon = ': ';
    private static readonly NotVisible = 'concept not visible';

    private readonly targets: OpTargets[] = [];
    private readonly updates = new Map<bigint, boolean>();
    /** Per public id, the index of the batch's last DeleteNode of it. */
    private readonly lastDelete = new Map<string, number>();

    private constructor(private readonly evaluator: ScopeEvaluator, private readonly catalog: CatalogSnapshot, private readonly exempt: WriteExemptions)
    {
    }

    /** Throws AccessError for the first op of `batch` the evaluator's scope does not allow; `exempt` as WriteExemptions. */
    public static async Check(evaluator: ScopeEvaluator, batch: WriteBatch, catalog: CatalogSnapshot, exempt: WriteExemptions = WriteExemptions.None): Promise<void>
    {
        const gate = new WriteGate(evaluator, catalog, exempt);
        const ops = batch.Ops();
        gate.Resolve(ops);
        for (let i = 0; i < ops.length; i++)
        {
            await gate.CheckOp(i, ops[i] as BatchOp);
        }
    }

    /** First pass: which ops address nodes the batch creates, and those nodes' end-of-batch values. */
    private Resolve(ops: readonly BatchOp[]): void
    {
        const live = new Map<string, CreatedNode>();
        for (const op of ops)
        {
            switch (op.Op)
            {
                case WriteOp.CreateNode:
                {
                    const node = new CreatedNode(op.PublicId, op.Concept, op.Owner ?? WriteGate.NoOwner, this.catalog);
                    live.set(op.PublicId, node);
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
                    this.lastDelete.set(op.PublicId, this.targets.length);
                    this.targets.push(new OpTargets(live.get(op.PublicId)));
                    live.delete(op.PublicId);
                    break;
                case WriteOp.Link:
                {
                    const after = op.Options?.AfterSibling;
                    const before = op.Options?.BeforeSibling;
                    this.targets.push(new OpTargets(live.get(op.From), live.get(op.To), after === undefined ? undefined : live.get(after), before === undefined ? undefined : live.get(before)));
                    break;
                }
                case WriteOp.Unlink:
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
                await this.CheckWrite(index, op.Op, op.PublicId, op.Member, targets.Source, this.IsPlacedDefault(index, targets), false);
                break;
            case WriteOp.Link:
            case WriteOp.Unlink:
            {
                const concept = await this.CheckWrite(index, op.Op, op.From, op.Relationship, targets.Source, false, op.Op === WriteOp.Unlink && this.IsDetach(index, op.From, op.To));
                await this.CheckReferenced(index, op.Op, op.From, concept, op.To, targets.Target, WriteGate.ErrInvisibleTarget);
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

    /** A node a Link/Unlink names besides its source must be created by the batch or visible (a recorded read). */
    private async CheckReferenced(index: number, op: WriteOp, from: string, concept: string, publicId: string, created: CreatedNode | undefined, reason: string): Promise<void>
    {
        if (created === undefined && (await this.VisibleNode(publicId)) === undefined)
        {
            throw this.Denied(AccessErrorCode.InvisibleNode, index, op, from, concept, reason + publicId);
        }
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

    /** A SetDefault op on a node the batch created (live at that op): exempt from Hidden and ReadOnly (R91). */
    private IsPlacedDefault(index: number, targets: OpTargets): boolean
    {
        return targets.Source !== undefined && this.exempt.Defaults.has(index);
    }

    /** A DetachUnlink op one of whose ends the batch deletes later: exempt from ReadOnly (R92). */
    private IsDetach(index: number, from: string, to: string): boolean
    {
        return this.exempt.Detaches.has(index) && ((this.lastDelete.get(from) ?? -1) > index || (this.lastDelete.get(to) ?? -1) > index);
    }

    /**
     * SetProperty, Link or Unlink of `member` on the node `publicId` (an edge's source); resolves with its concept.
     * `placed`: a default the host placed on a node the batch created, exempt from Hidden and ReadOnly.
     * `detach`: an unlink a later delete in the batch implies, exempt from ReadOnly.
     */
    private async CheckWrite(index: number, op: WriteOp, publicId: string, member: string, created: CreatedNode | undefined, placed: boolean, detach: boolean): Promise<string>
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
            return created.Concept;
        }
        const node = await this.RequireVisible(index, op, publicId);
        this.CheckHidden(index, op, publicId, node.Concept, member);
        if (!detach)
        {
            this.CheckReadOnly(index, op, publicId, node.Concept, member, WriteStage.Update);
        }
        let allowed = this.updates.get(node.Id);
        if (allowed === undefined)
        {
            allowed = await this.Allows(node, RuleKind.Update);
            this.updates.set(node.Id, allowed);
        }
        if (!allowed)
        {
            throw this.Denied(AccessErrorCode.UpdateDenied, index, op, publicId, node.Concept, this.Reason(node.Concept, RuleKind.Update, WriteGate.ErrUpdate));
        }
        return node.Concept;
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

    /** True iff every applicable rule of `kind` holds on the node's snapshot values (none: the Default decides). */
    private async Allows(node: IReadNode, kind: RuleKind): Promise<boolean>
    {
        const rules = this.Rules(node.Concept, kind);
        if (rules.length === 0)
        {
            return this.evaluator.Scope.Default === AccessDefault.Allow;
        }
        for (const rule of rules)
        {
            if (!(await this.evaluator.Holds(rule, node)))
            {
                return false;
            }
        }
        return true;
    }

    private async RequireVisible(index: number, op: WriteOp, publicId: string): Promise<IReadNode>
    {
        const node = await this.VisibleNode(publicId);
        if (node === undefined)
        {
            throw this.Denied(AccessErrorCode.InvisibleNode, index, op, publicId, undefined, WriteGate.ErrInvisible);
        }
        return node;
    }

    /** The snapshot node when it exists and is visible; missing and invisible are indistinguishable. */
    private async VisibleNode(publicId: string): Promise<IReadNode | undefined>
    {
        const node = await this.evaluator.Locate(publicId);
        return node !== undefined && (await this.evaluator.IsVisible(node)) ? node : undefined;
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
        }
    }

    /** "Access denied: op 2 (SetProperty) on 't' (Ticket): reason"; an invisible node's concept is not named. */
    private Denied(code: AccessErrorCode, index: number, op: WriteOp, publicId: string, concept: string | undefined, reason: string): AccessError
    {
        return new AccessError(code, WriteGate.AccessDenied + index + WriteGate.Open + WriteOp[op] + WriteGate.Close + WriteGate.On + publicId + WriteGate.Quote
            + WriteGate.Open + (concept ?? WriteGate.NotVisible) + WriteGate.Close + WriteGate.Colon + reason);
    }
}
