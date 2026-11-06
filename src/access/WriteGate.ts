import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { CellValue } from '../columns/CellValue.js';
import { NodeEvaluator } from '../predicate/NodeEvaluator.js';
import type { Predicate } from '../predicate/Predicate.js';
import type { IReadNode } from '../RecordedReads.js';
import { type BatchOp, type WriteBatch, WriteOp } from '../txn/WriteBatch.js';
import { AccessError, AccessErrorCode } from './AccessError.js';
import { AccessDefault, type IWriteRules } from './AccessScope.js';
import type { ScopeEvaluator } from './ScopeEvaluator.js';

/** A node the batch creates: its concept and the values the batch sets on it (last wins). */
class CreatedNode
{
    public readonly Values = new Map<string, CellValue>();

    /** False for an unknown or aspect concept: the committer rejects the op itself, so the gate skips it. */
    public readonly Known: boolean;

    public constructor(public readonly Concept: string, catalog: CatalogSnapshot)
    {
        this.Known = catalog.Has(Concept) && !catalog.IsAspect(Concept);
    }
}

/** What one op writes to: the node the batch created (when it did, at that point), else a snapshot node by id. */
class OpTargets
{
    public constructor(public readonly Source: CreatedNode | undefined, public readonly Target: CreatedNode | undefined)
    {
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
 *   batch, unset = null). Create predicates must be node-local; one that is not denies the create.
 * - SetProperty, Link, Unlink (the node is the edge's source): the node must be visible and every
 *   applicable Update predicate hold on its snapshot values (R30); a node the batch created is exempt.
 *   The member written must not be hidden on the node's concept. A Link/Unlink target must be visible
 *   (or created by the batch).
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
    private static readonly ErrNotNodeLocal = 'its Create predicate is not node-local (Create rules may read only the new node\'s own values)';
    private static readonly ErrCreate = 'a Create rule does not hold on the new node\'s values';
    private static readonly ErrUpdate = 'an Update rule does not hold on the node';
    private static readonly ErrDelete = 'a Delete rule does not hold on the node';
    private static readonly ErrDefault = 'the scope has no rule for it and denies by default';
    private static readonly ErrHidden = 'the scope hides member ';
    private static readonly ErrInvisible = 'the node is not visible under the scope';
    private static readonly ErrInvisibleTarget = 'the target is not visible under the scope: ';
    private static readonly AccessDenied = 'Access denied: op ';
    private static readonly Open = ' (';
    private static readonly Close = ')';
    private static readonly On = ' on \'';
    private static readonly Quote = '\'';
    private static readonly Colon = ': ';
    private static readonly NotVisible = 'concept not visible';

    private readonly created = new Map<string, CreatedNode>();
    private readonly targets: OpTargets[] = [];
    private readonly updates = new Map<bigint, boolean>();

    private constructor(private readonly evaluator: ScopeEvaluator, private readonly catalog: CatalogSnapshot)
    {
    }

    /** Throws AccessError for the first op of `batch` the evaluator's scope does not allow. */
    public static async Check(evaluator: ScopeEvaluator, batch: WriteBatch, catalog: CatalogSnapshot): Promise<void>
    {
        const gate = new WriteGate(evaluator, catalog);
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
                    const node = new CreatedNode(op.Concept, this.catalog);
                    live.set(op.PublicId, node);
                    this.targets.push(new OpTargets(node, undefined));
                    break;
                }
                case WriteOp.SetProperty:
                {
                    const node = live.get(op.PublicId);
                    node?.Values.set(op.Member, op.Value);
                    this.targets.push(new OpTargets(node, undefined));
                    break;
                }
                case WriteOp.DeleteNode:
                    this.targets.push(new OpTargets(live.get(op.PublicId), undefined));
                    live.delete(op.PublicId);
                    break;
                case WriteOp.Link:
                case WriteOp.Unlink:
                    this.targets.push(new OpTargets(live.get(op.From), live.get(op.To)));
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
                await this.CheckWrite(index, op.Op, op.PublicId, op.Member, targets.Source);
                break;
            case WriteOp.Link:
            case WriteOp.Unlink:
            {
                const concept = await this.CheckWrite(index, op.Op, op.From, op.Relationship, targets.Source);
                if (targets.Target === undefined && (await this.VisibleNode(op.To)) === undefined)
                {
                    throw this.Denied(AccessErrorCode.InvisibleNode, index, op.Op, op.From, concept, WriteGate.ErrInvisibleTarget + op.To);
                }
                break;
            }
            case WriteOp.DeleteNode:
                await this.CheckDelete(index, op.PublicId, targets.Source);
                break;
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
        if (rules.some(rule => !rule.IsNodeLocal))
        {
            throw this.Denied(AccessErrorCode.CreateDenied, index, op, publicId, node.Concept, WriteGate.ErrNotNodeLocal);
        }
        for (const rule of rules)
        {
            if (!NodeEvaluator.Matches(rule, node.Values, publicId))
            {
                throw this.Denied(AccessErrorCode.CreateDenied, index, op, publicId, node.Concept, WriteGate.ErrCreate);
            }
        }
    }

    /** SetProperty, Link or Unlink of `member` on the node `publicId` (an edge's source); resolves with its concept. */
    private async CheckWrite(index: number, op: WriteOp, publicId: string, member: string, created: CreatedNode | undefined): Promise<string>
    {
        if (created !== undefined)
        {
            if (created.Known)
            {
                this.CheckHidden(index, op, publicId, created.Concept, member);
            }
            return created.Concept;
        }
        const node = await this.RequireVisible(index, op, publicId);
        this.CheckHidden(index, op, publicId, node.Concept, member);
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
