import { CatalogError, CatalogErrorCode } from '../catalog/CatalogError.js';
import type { MemberDef } from '../catalog/CatalogTypes.js';
import { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { MemberKind, ValueType } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import { ChunkCodecError } from '../columns/ChunkCodecError.js';
import type { ColumnStore } from '../columns/ColumnStore.js';
import { ValueCodec } from '../columns/ValueCodec.js';
import { EdgeError, EdgeErrorCode } from '../edges/EdgeError.js';
import type { EdgeStore, IAdjacent, ILinkOptions } from '../edges/EdgeStore.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import type { Location } from '../identity/Location.js';
import type { IIndexEntry, IndexStore } from '../indexes/IndexStore.js';
import { PublicIdIndex } from '../identity/PublicIdIndex.js';
import type { RowIndex } from '../identity/RowIndex.js';
import type { IWriteTransaction } from '../kv/KeyValue.js';
import type { ConnectorSetup } from '../connectors/WriteCoordinator.js';
import { SeedMarkers } from '../schema/SeedMarkers.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { CatalogIndex } from './CatalogIndex.js';
import { StubRule } from './StubRule.js';
import { CommitError, CommitErrorCode } from './CommitError.js';
import { ConflictKeys } from './ConflictKeys.js';
import type { ReadSet } from './ReadSet.js';
import { type ICreateNodeOp, type IDeleteNodeOp, type IExternalTarget, type ILinkOp, type ISetOwnerOp, type ISetPropertyOp, type IUnlinkOp, WriteBatch, WriteOp } from './WriteBatch.js';
import { WriteKeySet } from './WriteKeySet.js';

/** A live node resolved from its public id inside the applying transaction. */
interface INode
{
    readonly PublicId: string;
    readonly Id: bigint;
    readonly Location: Location;
    readonly Concept: string;
}

/**
 * A node whose secondary-index entries the batch may change: its entries before the batch (none for a
 * node the batch created) and whether it is still live at the end of the batch.
 */
interface ITouchedNode
{
    readonly Node: INode;
    readonly Before: readonly IIndexEntry[];
    Live: boolean;
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
 *
 * Secondary indexes are maintained at the end of the batch, per node, from its post-batch values (like
 * MissingRequired): every node the batch created, deleted, or set an indexed (or `Where`-read) member of
 * gets its entries recomputed; removed entries are deleted before added ones are unique-checked and put.
 *
 * With `dependencies` (a prepare's dry-run, ruling R71) the applier also records, as logical keys, the
 * state its semantic checks and its write set depend on beyond the keys it writes: Node(publicId) of every
 * node it resolves, Adjacency(rel, Out, from) of every Link (duplicates, cardinality, siblings, ordering),
 * Adjacency of every relationship and direction a DeleteNode enumerates, the Cell keys an index diff reads
 * and the key range of every unique check. While none of them nor the written keys change, re-applying the
 * batch reaches the same outcome.
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
    private static readonly ErrHasEdges = 'Node still has relationships: ';
    private static readonly ErrEdge = 'Edge rejected: ';
    private static readonly ErrSibling = 'Sibling is not a target of this relationship from the source: ';
    private static readonly ErrPublicId = 'Public id must be 1..400 UTF-8 bytes without U+0000: ';
    private static readonly Nul = '\u0000';
    private static readonly ErrCorruptRow = 'Node has a public id but no stored row: ';
    private static readonly ErrIdsExhausted = 'Batch has more CreateNode operations than allocated ids';
    private static readonly ErrStub = 'External target is not bound to an external connector: ';
    private static readonly ErrStubConcept = 'Target exists as a different concept than the external target declares: ';
    private static readonly Dot = '.';
    private static readonly Colon = ': ';
    private static readonly Arrow = ' -> ';

    /** Which stored nodes are stubs (ruling R102). */
    private readonly stubs: StubRule;

    public constructor(
        private readonly index: CatalogIndex,
        private readonly columns: ColumnStore,
        private readonly edges: EdgeStore,
        private readonly rows: RowIndex,
        private readonly ids: PublicIdIndex,
        private readonly indexes: IndexStore,
        private readonly dependencies?: ReadSet,
        setup?: ConnectorSetup,
    )
    {
        this.stubs = new StubRule(setup);
    }

    /**
     * Internal ids a batch needs, in op order, with the op's cluster hint: one per CreateNode and one per Link that
     * carries an ExternalTarget (whether or not its stub already exists, so the order stays deterministic for replay).
     */
    public static CreateHints(batch: WriteBatch): Array<string | undefined>
    {
        return batch.Ops().filter(op => WriteBatch.TakesId(op)).map(op => op.Op === WriteOp.CreateNode ? op.ClusterHint : undefined);
    }

    /**
     * `allocated` holds one fresh internal id per CreateNode op and per Link op carrying an ExternalTarget, in op
     * order (see CreateHints; the Link's id is used only when it creates the stub). Every node
     * the batch creates (and does not delete again) must have each non-nullable property set by the
     * end of the batch (ruling R29), else MissingRequired.
     */
    public async Apply(txn: IWriteTransaction, batch: WriteBatch, allocated: readonly bigint[]): Promise<WriteKeySet>
    {
        const keys = new WriteKeySet();
        const created = new Map<bigint, ICreatedNode>();
        const touched = new Map<bigint, ITouchedNode>();
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
                    const node = await this.CreateNode(txn, op, id, keys);
                    created.set(id, { PublicId: op.PublicId, Concept: node.Concept, Set: new Set() });
                    if (this.index.IndexesFor(node.Concept).length > 0)
                    {
                        touched.set(id, { Node: node, Before: [], Live: true });
                    }
                    break;
                }
                case WriteOp.SetProperty:
                {
                    const set = await this.SetProperty(txn, op, keys, touched);
                    created.get(set.Node)?.Set.add(set.Member);
                    break;
                }
                case WriteOp.DeleteNode:
                    created.delete(await this.DeleteNode(txn, op, keys, touched));
                    break;
                case WriteOp.Link:
                {
                    if (op.Options?.ExternalTarget !== undefined)
                    {
                        const id = allocated[nextId++];
                        if (id === undefined)
                        {
                            throw new GraphError(GraphErrorCode.Internal, BatchApplier.ErrIdsExhausted);
                        }
                        await this.EnsureStub(txn, op, id, keys);
                    }
                    await this.Link(txn, op, keys);
                    break;
                }
                case WriteOp.Unlink:
                    await this.Unlink(txn, op, keys, touched);
                    break;
                case WriteOp.SetOwner:
                    await this.SetOwner(txn, op, keys);
                    break;
            }
        }
        for (const node of created.values())
        {
            this.RequireComplete(node);
        }
        await this.MaintainIndexes(txn, touched, keys);
        return keys;
    }

    /** Records the node's current index entries before the batch first changes something they depend on. */
    private async Track(txn: IWriteTransaction, node: INode, touched: Map<bigint, ITouchedNode>): Promise<void>
    {
        if (touched.has(node.Id))
        {
            return;
        }
        const indexes = this.index.IndexesFor(node.Concept);
        if (this.dependencies !== undefined)
        {
            for (const m of this.index.Catalog.EffectiveMembers(node.Concept))
            {
                if (m.Kind === MemberKind.Property && indexes.some(i => i.Touches(m.Id)))
                {
                    this.dependencies.AddKey(ConflictKeys.CellSpace, ConflictKeys.Cell(node.Id, m.Id));
                }
            }
        }
        const before = await this.indexes.EntriesOf(txn, indexes, node.Location, node.Id, node.PublicId);
        touched.set(node.Id, { Node: node, Before: before, Live: true });
    }

    /** Diffs each touched node's entries before the batch against its post-batch ones and applies the diff. */
    private async MaintainIndexes(txn: IWriteTransaction, touched: ReadonlyMap<bigint, ITouchedNode>, keys: WriteKeySet): Promise<void>
    {
        const removed: IIndexEntry[] = [];
        const added: IIndexEntry[] = [];
        for (const t of touched.values())
        {
            const after = t.Live ? await this.indexes.EntriesOf(txn, this.index.IndexesFor(t.Node.Concept), t.Node.Location, t.Node.Id, t.Node.PublicId) : [];
            const kept = new Set(after.map(e => e.Hex));
            const had = new Set(t.Before.map(e => e.Hex));
            removed.push(...t.Before.filter(e => !kept.has(e.Hex)));
            added.push(...after.filter(e => !had.has(e.Hex)));
        }
        await this.indexes.Apply(txn, removed, added, keys, this.dependencies);
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

    /** `stub`: an identity-only node (ruling R102) writes no node-id cell, so no concept scan lists it. */
    private async CreateNode(txn: IWriteTransaction, op: ICreateNodeOp, id: bigint, keys: WriteKeySet, stub: boolean = false): Promise<INode>
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
        if (!stub)
        {
            await this.columns.WriteCell(txn, location, CatalogSnapshot.NodeIdMember, id);
        }
        await this.ids.Bind(txn, op.PublicId, id);
        this.ids.SetOwner(txn, id, op.Owner ?? '');
        keys.Add(ConflictKeys.NodeSpace, ConflictKeys.Node(op.PublicId));
        if (!stub)
        {
            BatchApplier.AddCellKeys(keys, id, typeId, CatalogSnapshot.NodeIdMember.Id);
        }
        keys.Add(ConflictKeys.ExtentSpace, ConflictKeys.Extent(typeId));
        return { PublicId: op.PublicId, Id: id, Location: location, Concept: op.Concept };
    }

    /** Returns the node and member written. */
    private async SetProperty(txn: IWriteTransaction, op: ISetPropertyOp, keys: WriteKeySet, touched: Map<bigint, ITouchedNode>): Promise<{ Node: bigint; Member: number }>
    {
        const node = await this.Locate(txn, op.PublicId);
        const member = BatchApplier.Catalog(() => this.index.Catalog.Member(node.Concept, op.Member));
        if (member.Kind !== MemberKind.Property)
        {
            throw new CommitError(CommitErrorCode.NotAProperty, BatchApplier.ErrNotProperty + node.Concept + BatchApplier.Dot + op.Member);
        }
        BatchApplier.RequireValue(node, member, op.Value);
        if (this.index.IndexesFor(node.Concept).some(i => i.Touches(member.Id)))
        {
            await this.Track(txn, node, touched);
        }
        await this.columns.WriteCell(txn, node.Location, member, op.Value);
        BatchApplier.AddCellKeys(keys, node.Id, node.Location.TypeId, member.Id);
        return { Node: node.Id, Member: member.Id };
    }

    /** Returns the deleted node's internal id. */
    private async DeleteNode(txn: IWriteTransaction, op: IDeleteNodeOp, keys: WriteKeySet, touched: Map<bigint, ITouchedNode>): Promise<bigint>
    {
        return this.DeleteLocated(txn, await this.Locate(txn, op.PublicId), op.Strict === true, keys, touched);
    }

    /** DeleteNode on a resolved node. A stub is identity only: no index entries, no cells to null (ruling R102). */
    private async DeleteLocated(txn: IWriteTransaction, node: INode, strict: boolean, keys: WriteKeySet, touched: Map<bigint, ITouchedNode>): Promise<bigint>
    {
        const stub = await this.IsStubNode(txn, node);
        if (!stub && this.index.IndexesFor(node.Concept).length > 0)
        {
            await this.Track(txn, node, touched);
            (touched.get(node.Id) as ITouchedNode).Live = false;
        }
        const members = this.index.Catalog.EffectiveMembers(node.Concept);
        let far: bigint[] = [];
        if (strict)
        {
            // One scan: it records the adjacency dependencies and proves there is nothing to unlink.
            await this.RequireNoEdges(txn, node, members);
        }
        else
        {
            far = await this.UnlinkAll(txn, node, members, keys);
        }
        // Every property cell of the slot is nulled, not just the node id (F9); slots are not reused in v1.
        if (!stub)
        {
            for (const m of members.filter(x => x.Kind === MemberKind.Property))
            {
                await this.columns.WriteCell(txn, node.Location, BatchApplier.Erasable(m), null);
            }
            await this.columns.WriteCell(txn, node.Location, CatalogSnapshot.NodeIdMember, null);
        }
        await this.rows.Clear(txn, node.Id);
        await this.ids.Unbind(txn, node.PublicId, node.Id);
        // A deleted node is no longer seeded: its marker goes with it (ruling R53).
        SeedMarkers.Delete(txn, node.PublicId);
        keys.Add(ConflictKeys.NodeSpace, ConflictKeys.Node(node.PublicId));
        keys.Add(ConflictKeys.ExtentSpace, ConflictKeys.Extent(node.Location.TypeId));
        if (!stub)
        {
            BatchApplier.AddCellKeys(keys, node.Id, node.Location.TypeId, CatalogSnapshot.NodeIdMember.Id);
            for (const m of members.filter(x => x.Kind === MemberKind.Property))
            {
                BatchApplier.AddCellKeys(keys, node.Id, node.Location.TypeId, m.Id);
            }
        }
        for (const id of far)
        {
            await this.RemoveStubById(txn, id, keys, touched);
        }
        return node.Id;
    }

    /**
     * Re-owns the node in place (ruling R90): the owner key only, so identity, cells, edges, index entries
     * and the seed marker stay. The owner is covered by the Node key (R36), which OwnerOf and OwnerIs record.
     */
    private async SetOwner(txn: IWriteTransaction, op: ISetOwnerOp, keys: WriteKeySet): Promise<void>
    {
        const node = await this.Locate(txn, op.PublicId);
        this.ids.ReplaceOwner(txn, node.Id, op.Owner);
        keys.Add(ConflictKeys.NodeSpace, ConflictKeys.Node(node.PublicId));
    }

    private async Link(txn: IWriteTransaction, op: ILinkOp, keys: WriteKeySet): Promise<void>
    {
        const from = await this.Locate(txn, op.From);
        const rel = this.Relationship(from, op.Relationship);
        const to = await this.Locate(txn, op.To);
        this.DependOn(rel, from.Id, EdgeDirection.Out);
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

    private async Unlink(txn: IWriteTransaction, op: IUnlinkOp, keys: WriteKeySet, touched: Map<bigint, ITouchedNode>): Promise<void>
    {
        const from = await this.Locate(txn, op.From);
        const rel = this.Relationship(from, op.Relationship);
        const to = await this.Locate(txn, op.To);
        await BatchApplier.Edge(from, rel, to, () => this.edges.Unlink(txn, rel, from.Id, to.Id));
        BatchApplier.AddEdgeKeys(keys, rel, from.Id, to.Id);
        await this.RemoveStubIfOrphaned(txn, to, keys, touched);
    }

    /**
     * Ruling R102: creates the identity-only stub (op.To, ExternalTarget) when no node has that public id. The
     * stub's binding must name an External connector (InvalidEdge); an existing node of another concept is
     * TargetTypeMismatch. The stub takes an id from `allocated` whether or not it is created.
     */
    private async EnsureStub(txn: IWriteTransaction, op: ILinkOp, id: bigint, keys: WriteKeySet): Promise<void>
    {
        const target = op.Options?.ExternalTarget as IExternalTarget;
        BatchApplier.RequirePublicId(op.To);
        this.dependencies?.AddKey(ConflictKeys.NodeSpace, ConflictKeys.Node(op.To));
        if ((await this.ids.Resolve(txn, op.To)) !== undefined)
        {
            // Anything but a stub of the declared concept and owner is not what ExternalTarget claims.
            const existing = await this.Locate(txn, op.To);
            const owner = await this.ids.OwnerOf(txn, existing.Id);
            if (existing.Concept !== target.Concept || owner !== target.Owner || !this.stubs.IsStub(owner, existing.Concept, this.index.Catalog))
            {
                throw new CommitError(CommitErrorCode.TargetTypeMismatch, BatchApplier.ErrStubConcept + op.To);
            }
            return;
        }
        BatchApplier.Catalog(() => this.index.Catalog.RequireInstantiable(target.Concept));
        if (!this.stubs.IsStub(target.Owner, target.Concept, this.index.Catalog))
        {
            throw new CommitError(CommitErrorCode.InvalidEdge, BatchApplier.ErrStub + op.To + BatchApplier.Colon + target.Concept);
        }
        // Not tracked for index maintenance: a stub has no values, so it has no index entries.
        await this.CreateNode(txn, { Op: WriteOp.CreateNode, PublicId: op.To, Concept: target.Concept, Owner: target.Owner }, id, keys, true);
    }

    /** True when the stored node is a stub (ruling R102): its binding resolves to an External connector. */
    private async IsStubNode(txn: IWriteTransaction, node: INode): Promise<boolean>
    {
        return this.stubs.IsActive && this.stubs.IsStub(await this.ids.OwnerOf(txn, node.Id), node.Concept, this.index.Catalog);
    }

    /** RemoveStubIfOrphaned for a far node known only by internal id (an edge scan of a deleted node). */
    private async RemoveStubById(txn: IWriteTransaction, id: bigint, keys: WriteKeySet, touched: Map<bigint, ITouchedNode>): Promise<void>
    {
        if (!this.stubs.IsActive)
        {
            return;
        }
        const location = await this.rows.Locate(txn, id);
        const concept = location === undefined ? undefined : this.index.ConceptOf(location.TypeId);
        const publicId = concept === undefined ? undefined : await this.ids.PublicIdOf(txn, id);
        if (location === undefined || concept === undefined || publicId === undefined)
        {
            return;
        }
        await this.RemoveStubIfOrphaned(txn, { PublicId: publicId, Id: id, Location: location, Concept: concept }, keys, touched);
    }

    /**
     * Ruling R102: deletes `node` when it is a stub (its binding is External) that no edge touches any more,
     * in the same batch that removed its last edge.
     */
    private async RemoveStubIfOrphaned(txn: IWriteTransaction, node: INode, keys: WriteKeySet, touched: Map<bigint, ITouchedNode>): Promise<void>
    {
        if (!this.stubs.IsActive || !(await this.IsStubNode(txn, node)) || (await this.HasEdges(txn, node)))
        {
            return;
        }
        this.dependencies?.AddKey(ConflictKeys.NodeSpace, ConflictKeys.Node(node.PublicId));
        await this.DeleteLocated(txn, node, false, keys, touched);
    }

    private async HasEdges(txn: IWriteTransaction, node: INode): Promise<boolean>
    {
        const outgoing = this.index.Catalog.EffectiveMembers(node.Concept).filter(m => m.Kind === MemberKind.Relationship).map(rel => [rel, EdgeDirection.Out] as const);
        const incoming = this.index.IncomingRelationships(node.Concept).map(rel => [rel, EdgeDirection.In] as const);
        for (const [rel, direction] of [...outgoing, ...incoming])
        {
            this.DependOn(rel, node.Id, direction);
            for await (const _ of this.edges.Adjacent(txn, rel, node.Id, direction))
            {
                return true;
            }
        }
        return false;
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

    /**
     * Position of the existing edge (from, rel, sibling), found from the sibling's In range (ruling R33); UnknownNode
     * if the sibling does not exist, InvalidEdge if it is not linked.
     */
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

    /** Unlinks every edge of the node being deleted, in both directions (a plain DeleteNode). */
    private async UnlinkAll(txn: IWriteTransaction, node: INode, members: readonly MemberDef[], keys: WriteKeySet): Promise<bigint[]>
    {
        const far: bigint[] = [];
        // Each edge is unlinked at the position its scan already found: no per-edge lookup (F9).
        for (const rel of members.filter(m => m.Kind === MemberKind.Relationship))
        {
            this.DependOn(rel, node.Id, EdgeDirection.Out);
            for (const edge of await this.Adjacent(txn, rel, node.Id, EdgeDirection.Out))
            {
                await this.edges.UnlinkAt(txn, rel, node.Id, edge.Node, edge.Position);
                BatchApplier.AddEdgeKeys(keys, rel, node.Id, edge.Node);
                far.push(edge.Node);
            }
        }
        for (const rel of this.index.IncomingRelationships(node.Concept))
        {
            this.DependOn(rel, node.Id, EdgeDirection.In);
            for (const edge of await this.Adjacent(txn, rel, node.Id, EdgeDirection.In))
            {
                await this.edges.UnlinkAt(txn, rel, edge.Node, node.Id, edge.Position);
                BatchApplier.AddEdgeKeys(keys, rel, edge.Node, node.Id);
                far.push(edge.Node);
            }
        }
        return far;
    }

    /**
     * Strict delete: CommitError NodeHasEdges when any edge of the node remains (after the batch's earlier ops),
     * hidden or not. The message names the node only, no relationship, far node or count.
     */
    private async RequireNoEdges(txn: IWriteTransaction, node: INode, members: readonly MemberDef[]): Promise<void>
    {
        const outgoing = members.filter(m => m.Kind === MemberKind.Relationship).map(rel => [rel, EdgeDirection.Out] as const);
        const incoming = this.index.IncomingRelationships(node.Concept).map(rel => [rel, EdgeDirection.In] as const);
        for (const [rel, direction] of [...outgoing, ...incoming])
        {
            this.DependOn(rel, node.Id, direction);
            for await (const _ of this.edges.Adjacent(txn, rel, node.Id, direction))
            {
                throw new CommitError(CommitErrorCode.NodeHasEdges, BatchApplier.ErrHasEdges + node.PublicId);
            }
        }
    }

    /** Collected first: the edges are deleted afterwards (no writes while a scan of the keyspace is open). */
    private async Adjacent(txn: IWriteTransaction, rel: MemberDef, node: bigint, direction: EdgeDirection): Promise<IAdjacent[]>
    {
        const out: IAdjacent[] = [];
        for await (const n of this.edges.Adjacent(txn, rel, node, direction))
        {
            out.push(n);
        }
        return out;
    }

    /** Records the node's whole adjacency of `rel` in `direction` as a dependency (prepare dry-runs only). */
    private DependOn(rel: MemberDef, node: bigint, direction: EdgeDirection): void
    {
        this.dependencies?.AddRange(ConflictKeys.EdgeSpace, ConflictKeys.Adjacency(rel.Id, direction, node));
    }

    /** The member as nullable, so DeleteNode may null a required property of the deleted slot. */
    private static Erasable(member: MemberDef): MemberDef
    {
        return member.Nullable ? member : { ...member, Nullable: true };
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
        this.dependencies?.AddKey(ConflictKeys.NodeSpace, ConflictKeys.Node(publicId));
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

    /** A cell write: its Cell key and the coarse Column key of the node's type (ruling F7). */
    private static AddCellKeys(keys: WriteKeySet, node: bigint, typeId: number, memberId: number): void
    {
        keys.Add(ConflictKeys.CellSpace, ConflictKeys.Cell(node, memberId));
        keys.Add(ConflictKeys.ColumnSpace, ConflictKeys.Column(typeId, memberId));
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

    /** CommitError InvalidPublicId unless the id is 1..400 UTF-8 bytes without U+0000. */
    public static RequirePublicId(publicId: string): void
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
