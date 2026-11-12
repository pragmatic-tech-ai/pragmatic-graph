import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind } from '../catalog/ValueType.js';
import { BatchApplier } from '../txn/BatchApplier.js';
import type { CatalogIndex } from '../txn/CatalogIndex.js';
import { CommitError, CommitErrorCode } from '../txn/CommitError.js';
import type { ICreateNodeOp, ILinkOp, ISetPropertyOp, IUnlinkOp } from '../txn/WriteBatch.js';

/** An external node the batch creates: its concept and the properties the batch has set on it so far. */
interface ICreatedExternal
{
    readonly Concept: string;
    readonly Set: Set<string>;
}

/** The concept a write routes by (INodeOrigin), as far as the check needs it. */
interface IConceptOf
{
    readonly Concept: string;
}

/**
 * The semantic checks of writes to external nodes (ruling R103). BatchApplier checks every engine op as it applies it;
 * ops on external nodes never reach it, so WriteCoordinator.Route checks them here, in batch order, with the codes the
 * engine would raise for the same write on an engine node: InvalidPublicId, UnknownType / NotInstantiable,
 * UnknownMember, NotAProperty, NotARelationship, InvalidValue, TargetTypeMismatch, UnknownNode (an op on an id the batch
 * deleted and did not re-create, or a link target found nowhere), DuplicatePublicId (a create of an id a stored engine
 * node has) and MissingRequired (Finish: a created external node lacks a non-nullable property, ruling R29). A failure
 * rejects the commit before any connector begins.
 */
export class ExternalWriteCheck
{
    private static readonly ErrUnknownNode = 'Unknown node: ';
    private static readonly ErrDuplicate = 'Public id already exists: ';
    private static readonly ErrNotProperty = 'Member is not a property: ';
    private static readonly ErrNotRelationship = 'Member is not a relationship: ';
    private static readonly ErrTarget = 'Target concept is not admitted by the relationship: ';
    private static readonly ErrRequired = 'Created node is missing a required property: ';
    private static readonly ErrHasEdges = 'Node still has relationships: ';
    private static readonly Dot = '.';
    private static readonly Arrow = ' -> ';

    private readonly created = new Map<string, ICreatedExternal>();
    /** Ids the batch deleted (engine or external) and has not re-created since. */
    private readonly deleted = new Set<string>();

    public constructor(private readonly index: CatalogIndex)
    {
    }

    /**
     * A CreateNode of an external node; `engine`: the id's latest origin (the snapshot's node, or an earlier CreateNode of
     * the batch) is an engine node, not a stub. DuplicatePublicId while that node, or an earlier external create of the
     * id, is live.
     */
    public Created(op: ICreateNodeOp, engine: boolean): void
    {
        BatchApplier.RequirePublicId(op.PublicId);
        BatchApplier.Catalog(() => this.index.Catalog.RequireInstantiable(op.Concept));
        if ((engine && !this.deleted.has(op.PublicId)) || this.created.has(op.PublicId))
        {
            throw new CommitError(CommitErrorCode.DuplicatePublicId, ExternalWriteCheck.ErrDuplicate + op.PublicId);
        }
        this.deleted.delete(op.PublicId);
        this.created.set(op.PublicId, { Concept: op.Concept, Set: new Set() });
    }

    /** An engine CreateNode: DuplicatePublicId when the batch created an external node of the id that is still live. */
    public EngineCreated(publicId: string): void
    {
        if (this.created.has(publicId))
        {
            throw new CommitError(CommitErrorCode.DuplicatePublicId, ExternalWriteCheck.ErrDuplicate + publicId);
        }
        this.deleted.delete(publicId);
    }

    /** True when the batch deleted the id and has not re-created it since. */
    public IsDeleted(publicId: string): boolean
    {
        return this.deleted.has(publicId);
    }

    /**
     * Registers an external node a source-keyed create minted (ruling R136 E4): it is live for later steps and a
     * re-create of its id is DuplicatePublicId. Its members are already the source's row, so R29 never re-judges it
     * (Finish is passed only the ids CreateNode created).
     */
    public Assigned(publicId: string, concept: string): void
    {
        this.deleted.delete(publicId);
        this.created.set(publicId, { Concept: concept, Set: new Set() });
    }

    /**
     * An engine-source Link to an id the batch deleted: UnknownNode when the target is external (its stub went with the
     * delete, and a link must not re-create it). An engine target is the engine's to reject.
     */
    public EngineLink(op: ILinkOp, external: boolean): void
    {
        if (external && this.deleted.has(op.To))
        {
            throw new CommitError(CommitErrorCode.UnknownNode, ExternalWriteCheck.ErrUnknownNode + op.To);
        }
    }

    /** Any DeleteNode (an engine one too: a later external create of its id is then no duplicate). */
    public Deleted(publicId: string): void
    {
        this.created.delete(publicId);
        this.deleted.add(publicId);
    }

    /** A delete of an external node, for which the batch leaves `engineEdges` engine edges: NodeHasEdges when strict. */
    public DeletedExternal(publicId: string, strict: boolean, engineEdges: number): void
    {
        this.RequireLive(publicId);
        if (strict && engineEdges > 0)
        {
            throw new CommitError(CommitErrorCode.NodeHasEdges, ExternalWriteCheck.ErrHasEdges + publicId);
        }
        this.Deleted(publicId);
    }

    public SetProperty(op: ISetPropertyOp, origin: IConceptOf): void
    {
        this.RequireLive(op.PublicId);
        const member = BatchApplier.Catalog(() => this.index.Catalog.Member(origin.Concept, op.Member));
        if (member.Kind !== MemberKind.Property)
        {
            throw new CommitError(CommitErrorCode.NotAProperty, ExternalWriteCheck.ErrNotProperty + origin.Concept + ExternalWriteCheck.Dot + op.Member);
        }
        BatchApplier.RequireValue(origin.Concept, member, op.Value);
        this.created.get(op.PublicId)?.Set.add(member.Name);
    }

    /** A Link whose source is external; `target` is the target's origin (undefined when found nowhere). */
    public Link(op: ILinkOp, source: IConceptOf, target: IConceptOf | undefined): void
    {
        const rel = this.Relationship(op.From, source, op.Relationship);
        if (target === undefined || this.deleted.has(op.To))
        {
            throw new CommitError(CommitErrorCode.UnknownNode, ExternalWriteCheck.ErrUnknownNode + op.To);
        }
        if (!this.index.Accepts(rel, target.Concept))
        {
            throw new CommitError(CommitErrorCode.TargetTypeMismatch, ExternalWriteCheck.ErrTarget + op.From + ExternalWriteCheck.Dot + rel.Name + ExternalWriteCheck.Arrow + op.To);
        }
    }

    /** An Unlink whose source is external. */
    public Unlink(op: IUnlinkOp, source: IConceptOf): void
    {
        this.Relationship(op.From, source, op.Relationship);
    }

    /**
     * R29 on the external nodes `created` in this step that are still live: a create must reach the source with every
     * required member set within its own step (ruling R135 E1). An id in `created` the step deleted again is skipped.
     */
    public Finish(created: ReadonlySet<string>): void
    {
        for (const publicId of created)
        {
            const node = this.created.get(publicId);
            if (node === undefined)
            {
                continue;
            }
            for (const m of this.index.Catalog.EffectiveMembers(node.Concept))
            {
                if (m.Kind === MemberKind.Property && !m.Nullable && !node.Set.has(m.Name))
                {
                    throw new CommitError(CommitErrorCode.MissingRequired, ExternalWriteCheck.ErrRequired + publicId + ExternalWriteCheck.Dot + m.Name);
                }
            }
        }
    }

    private Relationship(from: string, source: IConceptOf, name: string): MemberDef
    {
        this.RequireLive(from);
        const rel = BatchApplier.Catalog(() => this.index.Catalog.Member(source.Concept, name));
        if (rel.Kind !== MemberKind.Relationship)
        {
            throw new CommitError(CommitErrorCode.NotARelationship, ExternalWriteCheck.ErrNotRelationship + source.Concept + ExternalWriteCheck.Dot + name);
        }
        return rel;
    }

    private RequireLive(publicId: string): void
    {
        if (this.deleted.has(publicId))
        {
            throw new CommitError(CommitErrorCode.UnknownNode, ExternalWriteCheck.ErrUnknownNode + publicId);
        }
    }
}
