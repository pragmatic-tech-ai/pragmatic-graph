import type { MemberDef, TypeDefinition } from '../catalog/CatalogTypes.js';
import { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { ColumnStore } from '../columns/ColumnStore.js';
import type { EdgeStore } from '../edges/EdgeStore.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import type { Location } from '../identity/Location.js';
import type { PublicIdIndex } from '../identity/PublicIdIndex.js';
import type { RowIndex } from '../identity/RowIndex.js';
import type { IWriteTransaction } from '../kv/KeyValue.js';
import type { CatalogIndex } from '../txn/CatalogIndex.js';
import { ConflictKeys } from '../txn/ConflictKeys.js';
import type { WriteKeySet } from '../txn/WriteKeySet.js';
import type { CatalogDiff } from './CatalogDiff.js';
import { SeedMarkers } from './SeedMarkers.js';

/** What one purge removed. A value is a non-null property cell (member 0 excluded); an edge counts once. */
export interface IPurgeStats
{
    readonly NodesRemoved: number;
    readonly ValuesRemoved: number;
    readonly EdgesRemoved: number;
}

/** A live node of a concept, from its node-id column. */
interface ILiveNode
{
    readonly Id: bigint;
    readonly Slot: number;
}

/** A node the purge removes. `Concept` is its name in the old catalog; `TypeKept`: its concept survives. */
interface IDoomedNode
{
    readonly Id: bigint;
    readonly Location: Location;
    readonly Concept: string;
    readonly TypeKept: boolean;
}

/** One edge to remove, with the old relationship definition and the position its scan found. */
interface IDoomedEdge
{
    readonly Relationship: MemberDef;
    readonly From: bigint;
    readonly To: bigint;
    readonly Position: Uint8Array;
}

/** A property column of a surviving concept that the new catalog no longer has. */
interface IDroppedColumn
{
    readonly TypeId: number;
    readonly Member: MemberDef;
}

/**
 * One purge: first collects everything to remove by reading with the OLD catalog index (no writes while a
 * scan is open; every edge is collected once, by key, whichever rule found it), then removes it. The
 * logical write keys (ruling R23) of everything removed go into `keys` during collection.
 */
class PurgeRun
{
    private static readonly Partition = 0;
    private static readonly Separator = '/';
    private static readonly ErrNoPublicId = 'Corrupt graph: node has a row but no public id: ';

    private readonly live = new Map<number, ILiveNode[]>();
    private readonly doomed = new Map<bigint, IDoomedNode>();
    private readonly doomedEdges = new Map<string, IDoomedEdge>();
    private readonly droppedColumns: IDroppedColumn[] = [];
    private readonly removedTypes: TypeDefinition[];
    private readonly keptConcepts: TypeDefinition[];
    private values = 0;

    public constructor(
        private readonly txn: IWriteTransaction,
        private readonly old: CatalogIndex,
        private readonly next: CatalogIndex,
        private readonly diff: CatalogDiff,
        private readonly keys: WriteKeySet,
        private readonly columns: ColumnStore,
        private readonly edges: EdgeStore,
        private readonly rows: RowIndex,
        private readonly ids: PublicIdIndex,
    )
    {
        this.removedTypes = diff.RemovedTypes.filter(d => !d.IsAspect);
        this.keptConcepts = next.Catalog.Definitions().filter(d => !d.IsAspect && old.ConceptOf(d.TypeId) === d.Name);
    }

    public async Run(): Promise<IPurgeStats>
    {
        await this.CollectRemovedTypes();
        await this.CollectIncomplete();
        for (const node of this.doomed.values())
        {
            await this.CollectNodeEdges(node);
        }
        await this.CollectRemovedMembers();
        await this.CollectRejectedTargets();

        for (const edge of this.doomedEdges.values())
        {
            await this.edges.UnlinkAt(this.txn, edge.Relationship, edge.From, edge.To, edge.Position);
        }
        for (const node of this.doomed.values())
        {
            await this.RemoveNode(node);
        }
        for (const column of this.droppedColumns)
        {
            await this.columns.DropColumn(this.txn, PurgeRun.Partition, column.TypeId, column.Member.Id);
        }
        for (const type of this.removedTypes)
        {
            await this.columns.DropType(this.txn, PurgeRun.Partition, type.TypeId);
        }
        return { NodesRemoved: this.doomed.size, ValuesRemoved: this.values, EdgesRemoved: this.doomedEdges.size };
    }

    /** Every node of a removed concept goes; its values are counted here, its columns go wholesale (DropType). */
    private async CollectRemovedTypes(): Promise<void>
    {
        for (const type of this.removedTypes)
        {
            this.keys.Add(ConflictKeys.ExtentSpace, ConflictKeys.Extent(type.TypeId));
            for (const node of await this.Live(type.TypeId))
            {
                this.Doom(node, type.TypeId, type.Name, false);
            }
            this.AddColumnKeys(type.TypeId, CatalogSnapshot.NodeIdMember);
            for (const member of this.Properties(this.old, type.Name))
            {
                await this.CountColumn(type.TypeId, member);
            }
        }
    }

    /**
     * A surviving concept's nodes that lack a value for a non-nullable property the new catalog makes
     * effective on it (a new or retyped member, or a kept member it newly inherits) are removed. A
     * property that was already effective and non-nullable under the same id needs no check: every live
     * node holds a value for it.
     */
    private async CollectIncomplete(): Promise<void>
    {
        for (const type of this.keptConcepts)
        {
            const before = new Set(this.old.Catalog.EffectiveMembers(type.Name).map(m => m.Id));
            for (const member of this.Properties(this.next, type.Name))
            {
                if (member.Nullable || before.has(member.Id))
                {
                    continue;
                }
                for await (const row of this.columns.ScanColumn(this.txn, PurgeRun.Partition, type.TypeId, member))
                {
                    if (row.Value === null)
                    {
                        this.Doom({ Id: row.NodeId, Slot: row.Slot }, type.TypeId, type.Name, true);
                    }
                }
            }
        }
    }

    /** Both directions of every edge of a removed node, by the old catalog's relationships. */
    private async CollectNodeEdges(node: IDoomedNode): Promise<void>
    {
        for (const rel of this.old.Catalog.EffectiveMembers(node.Concept).filter(m => m.Kind === MemberKind.Relationship))
        {
            await this.CollectAdjacent(rel, node.Id, EdgeDirection.Out);
        }
        for (const rel of this.old.IncomingRelationships(node.Concept))
        {
            await this.CollectAdjacent(rel, node.Id, EdgeDirection.In);
        }
    }

    /**
     * Members a surviving concept no longer has (removed, retyped or no longer inherited): a property's
     * column goes for that concept; a relationship's edges go from every node of that concept (both keys).
     * Members reported against an aspect no concept carries hold no data.
     */
    private async CollectRemovedMembers(): Promise<void>
    {
        for (const removed of this.diff.RemovedMembers)
        {
            const type = this.keptConcepts.find(d => d.Name === removed.Type);
            if (type === undefined)
            {
                continue;
            }
            if (removed.Member.Kind === MemberKind.Relationship)
            {
                for (const node of await this.Live(type.TypeId))
                {
                    await this.CollectAdjacent(removed.Member, node.Id, EdgeDirection.Out);
                }
                continue;
            }
            this.droppedColumns.push({ TypeId: type.TypeId, Member: removed.Member });
            await this.CountColumn(type.TypeId, removed.Member);
        }
    }

    /**
     * Edges into a surviving concept's nodes through a relationship whose targets no longer accept the
     * concept (a hierarchy change, or the relationship is gone): the node stays, the edges go.
     */
    private async CollectRejectedTargets(): Promise<void>
    {
        for (const type of this.keptConcepts)
        {
            const accepted = new Set(this.next.IncomingRelationships(type.Name).map(r => r.Id));
            const rejected = this.old.IncomingRelationships(type.Name).filter(r => !accepted.has(r.Id));
            if (rejected.length === 0)
            {
                continue;
            }
            for (const node of await this.Live(type.TypeId))
            {
                for (const rel of rejected)
                {
                    await this.CollectAdjacent(rel, node.Id, EdgeDirection.In);
                }
            }
        }
    }

    /**
     * Removes the node like DeleteNode does (rows, public-id binding and owner, member 0), except that a
     * removed concept's cells go with DropType; a surviving concept's node has every cell that can hold a
     * value nulled (slots are not reused). The node's seed marker goes too (ruling R53).
     */
    private async RemoveNode(node: IDoomedNode): Promise<void>
    {
        const publicId = await this.ids.PublicIdOf(this.txn, node.Id);
        if (publicId === undefined)
        {
            throw new GraphError(GraphErrorCode.Corrupt, PurgeRun.ErrNoPublicId + node.Id);
        }
        await this.rows.Clear(this.txn, node.Id);
        await this.ids.Unbind(this.txn, publicId, node.Id);
        SeedMarkers.Delete(this.txn, publicId);
        this.keys.Add(ConflictKeys.NodeSpace, ConflictKeys.Node(publicId));
        this.keys.Add(ConflictKeys.ExtentSpace, ConflictKeys.Extent(node.Location.TypeId));
        this.AddCellKeys(node.Id, node.Location.TypeId, CatalogSnapshot.NodeIdMember.Id);
        if (!node.TypeKept)
        {
            for (const member of this.Properties(this.old, node.Concept))
            {
                this.AddCellKeys(node.Id, node.Location.TypeId, member.Id);
            }
            return;
        }
        const after = new Set(this.Properties(this.next, node.Concept).map(m => m.Id));
        for (const member of this.Properties(this.old, node.Concept).filter(m => after.has(m.Id)))
        {
            this.AddCellKeys(node.Id, node.Location.TypeId, member.Id);
            if ((await this.columns.ReadCell(this.txn, node.Location, member)) !== null)
            {
                await this.columns.WriteCell(this.txn, node.Location, PurgeRun.Erasable(member), null);
                this.values += 1;
            }
        }
        await this.columns.WriteCell(this.txn, node.Location, CatalogSnapshot.NodeIdMember, null);
    }

    /** Counts the column's values on live nodes and records its Cell keys and Column key. */
    private async CountColumn(typeId: number, member: MemberDef): Promise<void>
    {
        this.AddColumnKeys(typeId, member);
        for await (const row of this.columns.ScanColumn(this.txn, PurgeRun.Partition, typeId, member))
        {
            this.keys.Add(ConflictKeys.CellSpace, ConflictKeys.Cell(row.NodeId, member.Id));
            if (row.Value !== null)
            {
                this.values += 1;
            }
        }
    }

    /** Collected first, unlinked later (no writes while the adjacency scan is open). */
    private async CollectAdjacent(rel: MemberDef, node: bigint, direction: EdgeDirection): Promise<void>
    {
        for await (const edge of this.edges.Adjacent(this.txn, rel, node, direction))
        {
            const from = direction === EdgeDirection.Out ? node : edge.Node;
            const to = direction === EdgeDirection.Out ? edge.Node : node;
            const s = PurgeRun.Separator;
            const id = rel.Id + s + from + s + to + s + ConflictKeys.Hex(edge.Position);
            if (!this.doomedEdges.has(id))
            {
                this.doomedEdges.set(id, { Relationship: rel, From: from, To: to, Position: edge.Position.slice() });
                this.keys.Add(ConflictKeys.EdgeSpace, ConflictKeys.Edge(rel.Id, EdgeDirection.Out, from, to));
                this.keys.Add(ConflictKeys.EdgeSpace, ConflictKeys.Edge(rel.Id, EdgeDirection.In, to, from));
            }
        }
    }

    /** The live nodes of a concept as they were before the purge (read once per type). */
    private async Live(typeId: number): Promise<ILiveNode[]>
    {
        let nodes = this.live.get(typeId);
        if (nodes === undefined)
        {
            nodes = [];
            for await (const row of this.columns.ScanColumn(this.txn, PurgeRun.Partition, typeId, CatalogSnapshot.NodeIdMember))
            {
                nodes.push({ Id: row.NodeId, Slot: row.Slot });
            }
            this.live.set(typeId, nodes);
        }
        return nodes;
    }

    private Doom(node: ILiveNode, typeId: number, concept: string, typeKept: boolean): void
    {
        if (!this.doomed.has(node.Id))
        {
            const location: Location = { Partition: PurgeRun.Partition, TypeId: typeId, Slot: node.Slot };
            this.doomed.set(node.Id, { Id: node.Id, Location: location, Concept: concept, TypeKept: typeKept });
        }
    }

    private Properties(index: CatalogIndex, concept: string): MemberDef[]
    {
        return index.Catalog.EffectiveMembers(concept).filter(m => m.Kind === MemberKind.Property);
    }

    private AddCellKeys(node: bigint, typeId: number, memberId: number): void
    {
        this.keys.Add(ConflictKeys.CellSpace, ConflictKeys.Cell(node, memberId));
        this.keys.Add(ConflictKeys.ColumnSpace, ConflictKeys.Column(typeId, memberId));
    }

    private AddColumnKeys(typeId: number, member: MemberDef): void
    {
        this.keys.Add(ConflictKeys.ColumnSpace, ConflictKeys.Column(typeId, member.Id));
    }

    /** The member as nullable, so a required property of a removed node's slot may be nulled. */
    private static Erasable(member: MemberDef): MemberDef
    {
        return member.Nullable ? member : { ...member, Nullable: true };
    }
}

/**
 * Applies the discard half of a schema upgrade (spec 4.3, ruling R48) inside the upgrade's write
 * transaction: removes every node, value and edge that does not fit the new catalog, so that the new
 * catalog's invariants hold for all stored data. Discard is always safe: nothing is converted.
 *
 * - Removed concept: every node goes (row, public-id binding, owner, edges in both directions including
 *   the reverse keys stored under surviving nodes); all its column chunks, deltas and its slot counter go.
 * - Member a surviving concept no longer has (removed, retyped, no longer inherited): a property's column
 *   for that concept goes; a relationship's edges from that concept's nodes go (both keys).
 * - Relationship targets no longer accepting a surviving concept: edges into its nodes go; nodes stay.
 * - Non-nullable property newly effective on a surviving concept: the nodes without a value go.
 *
 * Index entries of removed indexes join this purge once secondary indexes are stored. The caller flushes
 * the column store and row index afterwards (rulings R20, F6).
 */
export class DataPurger
{
    public constructor(
        private readonly columns: ColumnStore,
        private readonly edges: EdgeStore,
        private readonly rows: RowIndex,
        private readonly ids: PublicIdIndex,
    )
    {
    }

    /**
     * `old` is the catalog the stored data conforms to, `next` the one being installed and `diff` the
     * plan's diff between them. The logical write keys of everything removed are added to `keys`.
     */
    public Purge(txn: IWriteTransaction, old: CatalogIndex, next: CatalogIndex, diff: CatalogDiff, keys: WriteKeySet): Promise<IPurgeStats>
    {
        return new PurgeRun(txn, old, next, diff, keys, this.columns, this.edges, this.rows, this.ids).Run();
    }
}
