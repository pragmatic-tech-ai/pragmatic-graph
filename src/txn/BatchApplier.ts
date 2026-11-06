import { CatalogError, CatalogErrorCode } from '../catalog/CatalogError.js';
import type { MemberDef } from '../catalog/CatalogTypes.js';
import { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { MemberKind, ValueType } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import { ChunkCodecError } from '../columns/ChunkCodecError.js';
import type { ColumnStore } from '../columns/ColumnStore.js';
import { ValueCodec } from '../columns/ValueCodec.js';
import { EdgeError, EdgeErrorCode } from '../edges/EdgeError.js';
import type { EdgeStore, ILinkOptions } from '../edges/EdgeStore.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import type { Location } from '../identity/Location.js';
import { PublicIdIndex } from '../identity/PublicIdIndex.js';
import type { RowIndex } from '../identity/RowIndex.js';
import type { IWriteTransaction } from '../kv/KeyValue.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { CatalogIndex } from './CatalogIndex.js';
import { CommitError, CommitErrorCode } from './CommitError.js';
import { ConflictKeys } from './ConflictKeys.js';
import { type ICreateNodeOp, type IDeleteNodeOp, type ILinkOp, type ISetPropertyOp, type IUnlinkOp, WriteBatch, WriteOp } from './WriteBatch.js';
import { WriteKeySet } from './WriteKeySet.js';

/** A live node resolved from its public id inside the applying transaction. */
interface INode
{
    readonly PublicId: string;
    readonly Id: bigint;
    readonly Location: Location;
    readonly Concept: string;
}

/** A node created by the batch being applied, with the members the batch has set on it so far. */
interface ICreatedNode
{
    readonly PublicId: string;
    readonly Concept: string;
    readonly Set: Set<number>;
}

/**
 * Applies one WriteBatch's operations, in order, inside the committer's write transaction (so each
 * operation sees the batch's earlier ones) and returns the batch's logical write-key set (ruling R23).
 * Semantic violations throw CommitError (ruling R26); any other error means storage trouble or an
 * engine bug and is not attributed to the batch. Partition is always 0 in v1.
 */
export class BatchApplier
{
    private static readonly Partition = 0;
    private static readonly Encoder = new TextEncoder();
    private static readonly ErrUnknownNode = 'Unknown node: ';
    private static readonly ErrDuplicate = 'Public id already exists: ';
    private static readonly ErrNotProperty = 'Member is not a property: ';
    private static readonly ErrNotRelationship = 'Member is not a relationship: ';
    private static readonly ErrTarget = 'Target concept is not admitted by the relationship: ';
    private static readonly ErrValue = 'Invalid value for ';
    private static readonly ErrNull = 'Null is not allowed for ';
    private static readonly ErrRequired = 'Created node is missing a required property: ';
    private static readonly ErrEdge = 'Edge rejected: ';
    private static readonly ErrSibling = 'Sibling is not a target of this relationship from the source: ';
    private static readonly ErrPublicId = 'Public id must be 1..400 UTF-8 bytes without U+0000: ';
    private static readonly Nul = '\u0000';
    private static readonly ErrCorruptRow = 'Node has a public id but no stored row: ';
    private static readonly ErrIdsExhausted = 'Batch has more CreateNode operations than allocated ids';
    private static readonly Dot = '.';
    private static readonly Colon = ': ';
    private static readonly Arrow = ' -> ';

    public constructor(
        private readonly index: CatalogIndex,
        private readonly columns: ColumnStore,
        private readonly edges: EdgeStore,
        private readonly rows: RowIndex,
        private readonly ids: PublicIdIndex,
    )
    {
    }

    /** Internal ids a batch needs: one per CreateNode, in op order, with the op's cluster hint. */
    public static CreateHints(batch: WriteBatch): Array<string | undefined>
    {
        return batch.Ops().filter((op): op is ICreateNodeOp => op.Op === WriteOp.CreateNode).map(op => op.ClusterHint);
    }

    /**
     * `allocated` holds one fresh internal id per CreateNode op, in op order (see CreateHints). Every node
     * the batch creates (and does not delete again) must have each non-nullable property set by the
     * end of the batch (ruling R29), else MissingRequired.
     */
    public async Apply(txn: IWriteTransaction, batch: WriteBatch, allocated: readonly bigint[]): Promise<WriteKeySet>
    {
        const keys = new WriteKeySet();
        const created = new Map<bigint, ICreatedNode>();
        let nextId = 0;
        for (const op of batch.Ops())
        {
            switch (op.Op)
            {
                case WriteOp.CreateNode:
                {
                    const id = allocated[nextId++];
                    if (id === undefined)
                    {
                        throw new GraphError(GraphErrorCode.Internal, BatchApplier.ErrIdsExhausted);
                    }
                    const concept = await this.CreateNode(txn, op, id, keys);
                    created.set(id, { PublicId: op.PublicId, Concept: concept, Set: new Set() });
                    break;
                }
                case WriteOp.SetProperty:
                {
                    const set = await this.SetProperty(txn, op, keys);
                    created.get(set.Node)?.Set.add(set.Member);
                    break;
                }
                case WriteOp.DeleteNode:
                    created.delete(await this.DeleteNode(txn, op, keys));
                    break;
                case WriteOp.Link:
                    await this.Link(txn, op, keys);
                    break;
                case WriteOp.Unlink:
                    await this.Unlink(txn, op, keys);
                    break;
            }
        }
        for (const node of created.values())
        {
            this.RequireComplete(node);
        }
        return keys;
    }

    /** R29: each non-nullable property of a newly created node was given a value by the batch. */
    private RequireComplete(node: ICreatedNode): void
    {
        for (const m of this.index.Catalog.EffectiveMembers(node.Concept))
        {
            if (m.Kind === MemberKind.Property && !m.Nullable && !node.Set.has(m.Id))
            {
                throw new CommitError(CommitErrorCode.MissingRequired, BatchApplier.ErrRequired + node.PublicId + BatchApplier.Dot + m.Name);
            }
        }
    }

    /** Returns the created node's concept. */
    private async CreateNode(txn: IWriteTransaction, op: ICreateNodeOp, id: bigint, keys: WriteKeySet): Promise<string>
    {
        BatchApplier.RequirePublicId(op.PublicId);
        const typeId = BatchApplier.Catalog(() => this.index.Catalog.RequireInstantiable(op.Concept));
        if ((await this.ids.Resolve(txn, op.PublicId)) !== undefined)
        {
            throw new CommitError(CommitErrorCode.DuplicatePublicId, BatchApplier.ErrDuplicate + op.PublicId);
        }
        const slot = await this.columns.AllocateSlot(txn, BatchApplier.Partition, typeId);
        const location: Location = { Partition: BatchApplier.Partition, TypeId: typeId, Slot: slot };
        await this.rows.Assign(txn, id, location);
        await this.columns.WriteCell(txn, location, CatalogSnapshot.NodeIdMember, id);
        await this.ids.Bind(txn, op.PublicId, id);
        keys.Add(ConflictKeys.NodeSpace, ConflictKeys.Node(op.PublicId));
        keys.Add(ConflictKeys.CellSpace, ConflictKeys.Cell(id, CatalogSnapshot.NodeIdMember.Id));
        keys.Add(ConflictKeys.ExtentSpace, ConflictKeys.Extent(typeId));
        return op.Concept;
    }

    /** Returns the node and member written. */
    private async SetProperty(txn: IWriteTransaction, op: ISetPropertyOp, keys: WriteKeySet): Promise<{ Node: bigint; Member: number }>
    {
        const node = await this.Locate(txn, op.PublicId);
        const member = BatchApplier.Catalog(() => this.index.Catalog.Member(node.Concept, op.Member));
        if (member.Kind !== MemberKind.Property)
        {
            throw new CommitError(CommitErrorCode.NotAProperty, BatchApplier.ErrNotProperty + node.Concept + BatchApplier.Dot + op.Member);
        }
        BatchApplier.RequireValue(node, member, op.Value);
        await this.columns.WriteCell(txn, node.Location, member, op.Value);
        keys.Add(ConflictKeys.CellSpace, ConflictKeys.Cell(node.Id, member.Id));
        return { Node: node.Id, Member: member.Id };
    }

    /** Returns the deleted node's internal id. */
    private async DeleteNode(txn: IWriteTransaction, op: IDeleteNodeOp, keys: WriteKeySet): Promise<bigint>
    {
        const node = await this.Locate(txn, op.PublicId);
        const members = this.index.Catalog.EffectiveMembers(node.Concept);
        for (const rel of members.filter(m => m.Kind === MemberKind.Relationship))
        {
            for (const other of await this.Adjacent(txn, rel, node.Id, EdgeDirection.Out))
            {
                await this.edges.Unlink(txn, rel, node.Id, other);
                BatchApplier.AddEdgeKeys(keys, rel, node.Id, other);
            }
        }
        for (const rel of this.index.IncomingRelationships(node.Concept))
        {
            for (const other of await this.Adjacent(txn, rel, node.Id, EdgeDirection.In))
            {
                await this.edges.Unlink(txn, rel, other, node.Id);
                BatchApplier.AddEdgeKeys(keys, rel, other, node.Id);
            }
        }
        await this.columns.WriteCell(txn, node.Location, CatalogSnapshot.NodeIdMember, null);
        await this.rows.Clear(txn, node.Id);
        await this.ids.Unbind(txn, node.PublicId, node.Id);
        keys.Add(ConflictKeys.NodeSpace, ConflictKeys.Node(node.PublicId));
        keys.Add(ConflictKeys.ExtentSpace, ConflictKeys.Extent(node.Location.TypeId));
        keys.Add(ConflictKeys.CellSpace, ConflictKeys.Cell(node.Id, CatalogSnapshot.NodeIdMember.Id));
        for (const m of members.filter(x => x.Kind === MemberKind.Property))
        {
            keys.Add(ConflictKeys.CellSpace, ConflictKeys.Cell(node.Id, m.Id));
        }
        return node.Id;
    }

    private async Link(txn: IWriteTransaction, op: ILinkOp, keys: WriteKeySet): Promise<void>
    {
        const from = await this.Locate(txn, op.From);
        const rel = this.Relationship(from, op.Relationship);
        const to = await this.Locate(txn, op.To);
        if (!this.index.Accepts(rel, to.Concept))
        {
            throw new CommitError(CommitErrorCode.TargetTypeMismatch, BatchApplier.ErrTarget + BatchApplier.Label(from, rel, to));
        }
        const options: { After?: Uint8Array; Before?: Uint8Array; Properties?: ReadonlyMap<string, CellValue> } = {};
        if (op.Options?.AfterSibling !== undefined)
        {
            options.After = await this.SiblingPosition(txn, from, rel, op.Options.AfterSibling);
        }
        if (op.Options?.BeforeSibling !== undefined)
        {
            options.Before = await this.SiblingPosition(txn, from, rel, op.Options.BeforeSibling);
        }
        if (op.Options?.Properties !== undefined)
        {
            options.Properties = op.Options.Properties;
        }
        await BatchApplier.Edge(from, rel, to, () => this.edges.Link(txn, rel, from.Id, to.Id, options as ILinkOptions));
        BatchApplier.AddEdgeKeys(keys, rel, from.Id, to.Id);
        // A renumbering (ruling F1) rewrote these edges' keys: they are writes of this batch too.
        for (const moved of this.edges.TakeRenumbered(txn))
        {
            BatchApplier.AddEdgeKeys(keys, moved.Relationship, moved.From, moved.To);
        }
    }

    private async Unlink(txn: IWriteTransaction, op: IUnlinkOp, keys: WriteKeySet): Promise<void>
    {
        const from = await this.Locate(txn, op.From);
        const rel = this.Relationship(from, op.Relationship);
        const to = await this.Locate(txn, op.To);
        await BatchApplier.Edge(from, rel, to, () => this.edges.Unlink(txn, rel, from.Id, to.Id));
        BatchApplier.AddEdgeKeys(keys, rel, from.Id, to.Id);
    }

    private Relationship(from: INode, name: string): MemberDef
    {
        const rel = BatchApplier.Catalog(() => this.index.Catalog.Member(from.Concept, name));
        if (rel.Kind !== MemberKind.Relationship)
        {
            throw new CommitError(CommitErrorCode.NotARelationship, BatchApplier.ErrNotRelationship + from.Concept + BatchApplier.Dot + name);
        }
        return rel;
    }

    /** Position of the existing edge (from, rel, sibling), found from the sibling's In range (ruling R33); UnknownNode if the sibling does not exist, InvalidEdge if it is not linked. */
    private async SiblingPosition(txn: IWriteTransaction, from: INode, rel: MemberDef, sibling: string): Promise<Uint8Array>
    {
        const target = await this.Locate(txn, sibling);
        const position = await this.edges.PositionOf(txn, rel, from.Id, target.Id);
        if (position !== undefined)
        {
            return position;
        }
        const label = BatchApplier.Label(from, rel, target);
        throw new CommitError(CommitErrorCode.InvalidEdge, BatchApplier.ErrSibling + label, new EdgeError(EdgeErrorCode.UnknownSibling, BatchApplier.ErrSibling + label));
    }

    private async Adjacent(txn: IWriteTransaction, rel: MemberDef, node: bigint, direction: EdgeDirection): Promise<bigint[]>
    {
        const out: bigint[] = [];
        for await (const n of this.edges.Neighbors(txn, rel, node, direction))
        {
            out.push(n.Node);
        }
        return out;
    }

    /**
     * Checks the value against the member before anything is written, so that errors the column store
     * raises afterwards (corrupt stored deltas, slot or partition range errors) are storage failures and
     * pass through unmapped rather than being blamed on the batch.
     */
    private static RequireValue(node: INode, member: MemberDef, value: CellValue): void
    {
        const label = node.Concept + BatchApplier.Dot + member.Name;
        if (value === null)
        {
            if (!member.Nullable)
            {
                throw new CommitError(CommitErrorCode.InvalidValue, BatchApplier.ErrNull + label);
            }
            return;
        }
        try
        {
            ValueCodec.Check(member.Type as ValueType, value);
        }
        catch (error)
        {
            if (error instanceof ChunkCodecError)
            {
                throw new CommitError(CommitErrorCode.InvalidValue, BatchApplier.ErrValue + label, error);
            }
            throw error;
        }
    }

    private async Locate(txn: IWriteTransaction, publicId: string): Promise<INode>
    {
        BatchApplier.RequirePublicId(publicId);
        const id = await this.ids.Resolve(txn, publicId);
        if (id === undefined)
        {
            throw new CommitError(CommitErrorCode.UnknownNode, BatchApplier.ErrUnknownNode + publicId);
        }
        const location = await this.rows.Locate(txn, id);
        const concept = location === undefined ? undefined : this.index.ConceptOf(location.TypeId);
        if (location === undefined || concept === undefined)
        {
            throw new GraphError(GraphErrorCode.Corrupt, BatchApplier.ErrCorruptRow + publicId);
        }
        return { PublicId: publicId, Id: id, Location: location, Concept: concept };
    }

    private static AddEdgeKeys(keys: WriteKeySet, rel: MemberDef, from: bigint, to: bigint): void
    {
        keys.Add(ConflictKeys.EdgeSpace, ConflictKeys.Edge(rel.Id, EdgeDirection.Out, from, to));
        keys.Add(ConflictKeys.EdgeSpace, ConflictKeys.Edge(rel.Id, EdgeDirection.In, to, from));
    }

    private static async Edge<T>(from: INode, rel: MemberDef, to: INode, work: () => Promise<T>): Promise<T>
    {
        try
        {
            return await work();
        }
        catch (error)
        {
            // CorruptEdge is damaged stored data, not a rule the batch broke: let it pass through.
            if (error instanceof EdgeError && error.Code !== EdgeErrorCode.CorruptEdge)
            {
                throw new CommitError(CommitErrorCode.InvalidEdge, BatchApplier.ErrEdge + BatchApplier.Label(from, rel, to) + BatchApplier.Colon + error.message, error);
            }
            throw error;
        }
    }

    private static Catalog<T>(lookup: () => T): T
    {
        try
        {
            return lookup();
        }
        catch (error)
        {
            if (!(error instanceof CatalogError))
            {
                throw error;
            }
            switch (error.Code)
            {
                case CatalogErrorCode.UnknownMember:
                    throw new CommitError(CommitErrorCode.UnknownMember, error.message, error);
                case CatalogErrorCode.AspectNotInstantiable:
                    throw new CommitError(CommitErrorCode.NotInstantiable, error.message, error);
                default:
                    throw new CommitError(CommitErrorCode.UnknownType, error.message, error);
            }
        }
    }

    private static RequirePublicId(publicId: string): void
    {
        const length = BatchApplier.Encoder.encode(publicId).length;
        if (length === 0 || length > PublicIdIndex.MaxBytes || publicId.includes(BatchApplier.Nul))
        {
            throw new CommitError(CommitErrorCode.InvalidPublicId, BatchApplier.ErrPublicId + publicId.slice(0, 40));
        }
    }

    private static Label(from: INode, rel: MemberDef, to: INode): string
    {
        return from.PublicId + BatchApplier.Dot + rel.Name + BatchApplier.Arrow + to.PublicId;
    }
}
