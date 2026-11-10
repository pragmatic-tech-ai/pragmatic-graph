import type { MemberDef, TypeDefinition } from '../catalog/CatalogTypes.js';
import { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { ColumnStore } from '../columns/ColumnStore.js';
import type { EdgeStore } from '../edges/EdgeStore.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import type { Location } from '../identity/Location.js';
import type { ConceptIndex, IIndexEntry, IndexStore } from '../indexes/IndexStore.js';
import type { PublicIdIndex } from '../identity/PublicIdIndex.js';
import type { RowIndex } from '../identity/RowIndex.js';
import type { IWriteTransaction } from '../kv/KeyValue.js';
import type { CatalogIndex } from '../txn/CatalogIndex.js';
import { StubRule } from '../txn/StubRule.js';
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
    /**
     * Public ids (sorted) of the surviving nodes the purge modified: a non-null value of theirs dropped, or
     * an edge from or to them removed. Seed synchronization re-applies seeded ones (ruling R55).
     */
    readonly ModifiedNodes: readonly string[];
}

/** What one residency reconciliation did (DataPurger.Reconcile, final review I2). */
export interface IResidencyStats
{
    /** Engine nodes whose binding became External, stripped to stubs and kept (they still have an incoming edge). */
    readonly NodesStripped: number;
    /** Stubs whose binding is no longer External, plus stripped nodes left without an edge, removed. */
    readonly NodesRemoved: number;
    readonly ValuesRemoved: number;
    readonly EdgesRemoved: number;
    /** Public ids (sorted) of the surviving engine nodes that lost an edge (seed synchronization re-applies seeded ones). */
    readonly ModifiedNodes: readonly string[];
}

/** A stored node whose residency changes, located in the new catalog. */
interface IResidencyNode
{
    readonly Id: bigint;
    readonly PublicId: string;
    readonly Location: Location;
    readonly Concept: string;
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
    /** An identity-only stub (ruling R102): it has no cells and no index entries to remove. */
    readonly Stub?: true;
}

/** One edge to remove, with the old relationship definition and the position its scan found. */
interface IDoomedEdge
{
    readonly Relationship: MemberDef;
    readonly From: bigint;
    readonly To: bigint;
    readonly Position: Uint8Array;
}

/** An index (as resolved on one surviving concept) to build over that concept's surviving nodes. */
interface IIndexBuild
{
    readonly Index: ConceptIndex;
    readonly TypeId: number;
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
    /** Index entries computed with the OLD catalog from the OLD values, removed in the write phase (by hex). */
    private readonly staleEntries = new Map<string, IIndexEntry>();
    private readonly builds: IIndexBuild[] = [];
    /** Internal ids of nodes that lose a value or an edge (doomed ones included; filtered at the end). */
    private readonly touched = new Set<bigint>();
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
        private readonly indexes: IndexStore,
        private readonly stubs: StubRule,
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
        await this.CollectOrphanedStubs();
        await this.CollectIndexes();
        const modified = await this.ModifiedNodes();

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
        await this.RewriteIndexes();
        return { NodesRemoved: this.doomed.size, ValuesRemoved: this.values, EdgesRemoved: this.doomedEdges.size, ModifiedNodes: modified };
    }

    /**
     * Per old concept and each index kept by id (removed indexes are dropped wholesale): an index slice
     * (the index as resolved on the concept) is stale when it no longer applies to the concept, its
     * resolved members (key or `Where`-read) changed, or one of them lost its column; every live node's
     * entry of a stale slice goes and the slice is rebuilt when it still applies. Otherwise only removed
     * nodes lose their entries. A slice that newly applies to a surviving concept (an added index, or a
     * hierarchy change) is built. Entries are computed now, from the old values with the old catalog.
     */
    private async CollectIndexes(): Promise<void>
    {
        const nextIds = new Set(this.next.Catalog.Indexes().map(i => i.Id));
        const keptTypes = new Set(this.keptConcepts.map(d => d.TypeId));
        for (const def of this.old.Catalog.Definitions().filter(d => !d.IsAspect))
        {
            const before = this.old.IndexesFor(def.Name).filter(i => nextIds.has(i.Def.Id));
            const after = keptTypes.has(def.TypeId) ? this.next.IndexesFor(def.Name) : [];
            const lost = new Set(this.diff.RemovedMembers.filter(r => r.Type === def.Name).map(r => r.Member.Id));
            const stale = before.filter(o =>
            {
                const n = after.find(x => x.Def.Id === o.Def.Id);
                return n === undefined || o.Reads.some(m => lost.has(m.Id)) || !PurgeRun.SameMembers(o, n);
            });
            if (stale.length > 0)
            {
                for (const node of await this.Live(def.TypeId))
                {
                    await this.CollectEntries(def.TypeId, node.Id, node.Slot, stale);
                }
            }
            const rest = before.filter(i => !stale.includes(i));
            if (rest.length > 0)
            {
                for (const node of this.doomed.values())
                {
                    if (node.Location.TypeId === def.TypeId && node.Stub !== true)
                    {
                        await this.CollectEntries(def.TypeId, node.Id, node.Location.Slot, rest);
                    }
                }
            }
            for (const n of after)
            {
                const o = before.find(x => x.Def.Id === n.Def.Id);
                if (o === undefined || stale.includes(o))
                {
                    this.builds.push({ Index: n, TypeId: def.TypeId });
                }
            }
        }
    }

    /**
     * Removed indexes go wholesale, stale entries one by one; then the slices to build are built over the surviving
     * nodes.
     */
    private async RewriteIndexes(): Promise<void>
    {
        for (const removed of this.diff.RemovedIndexes)
        {
            await this.indexes.Drop(this.txn, removed.Id, this.keys);
        }
        await this.indexes.Apply(this.txn, [...this.staleEntries.values()], [], this.keys);
        for (const build of this.builds)
        {
            await this.indexes.Build(this.txn, build.Index, build.TypeId, this.keys);
        }
    }

    private async CollectEntries(typeId: number, id: bigint, slot: number, slices: readonly ConceptIndex[]): Promise<void>
    {
        const publicId = await this.ids.PublicIdOf(this.txn, id);
        if (publicId === undefined)
        {
            throw new GraphError(GraphErrorCode.Corrupt, PurgeRun.ErrNoPublicId + id);
        }
        const location: Location = { Partition: PurgeRun.Partition, TypeId: typeId, Slot: slot };
        for (const entry of await this.indexes.EntriesOf(this.txn, slices, location, id, publicId))
        {
            this.staleEntries.set(entry.Hex, entry);
        }
    }

    /** Same key members in the same order and the same set of read members. */
    private static SameMembers(a: ConceptIndex, b: ConceptIndex): boolean
    {
        return PurgeRun.Ids(a.Members.map(m => m.Id)) === PurgeRun.Ids(b.Members.map(m => m.Id))
            && PurgeRun.Ids(a.Reads.map(m => m.Id).sort((p, q) => p - q)) === PurgeRun.Ids(b.Reads.map(m => m.Id).sort((p, q) => p - q));
    }

    private static Ids(ids: readonly number[]): string
    {
        return ids.join(PurgeRun.Separator);
    }

    /** Public ids of the touched nodes that survive, read before anything is removed. */
    private async ModifiedNodes(): Promise<string[]>
    {
        const out: string[] = [];
        for (const id of this.touched)
        {
            if (this.doomed.has(id))
            {
                continue;
            }
            const publicId = await this.ids.PublicIdOf(this.txn, id);
            if (publicId === undefined)
            {
                throw new GraphError(GraphErrorCode.Corrupt, PurgeRun.ErrNoPublicId + id);
            }
            out.push(publicId);
        }
        return out.sort();
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
        await this.CollectRemovedStubs();
    }

    /**
     * Stubs have no node-id cell, so Live cannot see them: the nodes of a removed concept that remain are found
     * through the public-id index and the row index (one scan of the Ids keyspace, only when a concept is removed).
     */
    private async CollectRemovedStubs(): Promise<void>
    {
        if (this.removedTypes.length === 0)
        {
            return;
        }
        const names = new Map(this.removedTypes.map(t => [t.TypeId, t.Name]));
        for await (const id of this.ids.Scan(this.txn))
        {
            const location = await this.rows.Locate(this.txn, id);
            const name = location === undefined ? undefined : names.get(location.TypeId);
            if (location !== undefined && name !== undefined && !this.doomed.has(id))
            {
                this.doomed.set(id, { Id: id, Location: location, Concept: name, TypeKept: false, Stub: true });
            }
        }
    }

    /**
     * Stubs of surviving concepts that the doomed edges leave without any edge are removed with them, in the same
     * commit (ruling R102): a stub never outlives its last edge.
     */
    private async CollectOrphanedStubs(): Promise<void>
    {
        if (!this.stubs.IsActive)
        {
            return;
        }
        const candidates = new Set<bigint>();
        for (const edge of this.doomedEdges.values())
        {
            candidates.add(edge.From);
            candidates.add(edge.To);
        }
        for (const id of candidates)
        {
            if (this.doomed.has(id))
            {
                continue;
            }
            const location = await this.rows.Locate(this.txn, id);
            const concept = location === undefined ? undefined : this.old.ConceptOf(location.TypeId);
            if (location === undefined || concept === undefined || !this.keptConcepts.some(d => d.TypeId === location.TypeId))
            {
                continue;
            }
            if (this.stubs.IsStub(await this.ids.OwnerOf(this.txn, id), concept, this.next.Catalog) && !(await this.HasSurvivingEdge(id, concept)))
            {
                this.doomed.set(id, { Id: id, Location: location, Concept: concept, TypeKept: true, Stub: true });
            }
        }
    }

    /** True when the node has an edge, in either direction, that the purge does not remove. */
    private async HasSurvivingEdge(id: bigint, concept: string): Promise<boolean>
    {
        const outgoing = this.old.Catalog.EffectiveMembers(concept).filter(m => m.Kind === MemberKind.Relationship).map(rel => [rel, EdgeDirection.Out] as const);
        const incoming = this.old.IncomingRelationships(concept).map(rel => [rel, EdgeDirection.In] as const);
        for (const [rel, direction] of [...outgoing, ...incoming])
        {
            for await (const edge of this.edges.Adjacent(this.txn, rel, id, direction))
            {
                const from = direction === EdgeDirection.Out ? id : edge.Node;
                const to = direction === EdgeDirection.Out ? edge.Node : id;
                if (!this.doomedEdges.has(PurgeRun.EdgeKey(rel, from, to, edge.Position)))
                {
                    return true;
                }
            }
        }
        return false;
    }

    private static EdgeKey(rel: MemberDef, from: bigint, to: bigint, position: Uint8Array): string
    {
        const s = PurgeRun.Separator;
        return rel.Id + s + from + s + to + s + ConflictKeys.Hex(position);
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
        if (node.Stub !== true)
        {
            await this.columns.WriteCell(this.txn, node.Location, CatalogSnapshot.NodeIdMember, null);
        }
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
                this.touched.add(row.NodeId);
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
            const id = PurgeRun.EdgeKey(rel, from, to, edge.Position);
            if (!this.doomedEdges.has(id))
            {
                this.doomedEdges.set(id, { Relationship: rel, From: from, To: to, Position: edge.Position.slice() });
                this.touched.add(from);
                this.touched.add(to);
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
 * One residency reconciliation (final review I2, spec 12): run in an upgrade's write transaction after the purge, it
 * compares the stub rule before the upgrade (old catalog, old setup) with the one after (new catalog, new setup) for
 * every stored node, found through the public-id index (stubs have no node-id cell). Collects first, then writes.
 *
 * - A node that BECOMES a stub (its binding now resolves to an External connector): its index entries (computed from its
 *   values with the new catalog), every property cell and its node-id cell go; its identity, owner, seed marker and
 *   incoming edges stay. Its outgoing edges go too: an external node's links live in its connector (D2), never in
 *   engine storage. One left without any edge is removed as well (ruling R102: a stub never outlives its last edge).
 * - A stub that is NO LONGER a stub (its binding is now engine-held or Mirrored, or its connector is gone): removed with
 *   every edge in both directions, as a discard (spec 4.3: discard is always safe; nothing is converted).
 *
 * Every removal's logical write keys (ruling R23) go into `keys`.
 */
class ResidencyRun
{
    private static readonly Separator = '/';
    private static readonly ErrNoPublicId = 'Corrupt graph: node has a row but no public id: ';

    private readonly strip: IResidencyNode[] = [];
    private readonly remove = new Map<bigint, IResidencyNode>();
    private readonly doomedEdges = new Map<string, IDoomedEdge>();
    private readonly touched = new Set<bigint>();
    private values = 0;

    public constructor(
        private readonly txn: IWriteTransaction,
        private readonly old: CatalogIndex,
        private readonly next: CatalogIndex,
        private readonly keys: WriteKeySet,
        private readonly columns: ColumnStore,
        private readonly edges: EdgeStore,
        private readonly rows: RowIndex,
        private readonly ids: PublicIdIndex,
        private readonly indexes: IndexStore,
        private readonly before: StubRule,
        private readonly after: StubRule,
    )
    {
    }

    public async Run(): Promise<IResidencyStats>
    {
        await this.Classify();
        for (const node of this.strip)
        {
            await this.CollectEdges(node, EdgeDirection.Out);
        }
        for (const node of this.remove.values())
        {
            await this.CollectEdges(node, EdgeDirection.Out);
            await this.CollectEdges(node, EdgeDirection.In);
        }
        const kept: IResidencyNode[] = [];
        const orphans: IResidencyNode[] = [];
        for (const node of this.strip)
        {
            (await this.HasSurvivingEdge(node) ? kept : orphans).push(node);
        }
        const stale: IIndexEntry[] = [];
        for (const node of this.strip)
        {
            stale.push(...(await this.indexes.EntriesOf(this.txn, this.next.IndexesFor(node.Concept), node.Location, node.Id, node.PublicId)));
        }
        const modified = await this.ModifiedNodes();

        for (const edge of this.doomedEdges.values())
        {
            await this.edges.UnlinkAt(this.txn, edge.Relationship, edge.From, edge.To, edge.Position);
        }
        await this.indexes.Apply(this.txn, stale, [], this.keys);
        for (const node of this.strip)
        {
            await this.Strip(node);
        }
        for (const node of [...this.remove.values(), ...orphans])
        {
            await this.Remove(node);
        }
        return {
            NodesStripped: kept.length,
            NodesRemoved: this.remove.size + orphans.length,
            ValuesRemoved: this.values,
            EdgesRemoved: this.doomedEdges.size,
            ModifiedNodes: modified,
        };
    }

    /** Every stored node whose stub verdict differs between the old and the new rule (collected before any write). */
    private async Classify(): Promise<void>
    {
        for await (const id of this.ids.Scan(this.txn))
        {
            const location = await this.rows.Locate(this.txn, id);
            const concept = location === undefined ? undefined : this.next.ConceptOf(location.TypeId);
            if (location === undefined || concept === undefined)
            {
                continue;
            }
            const owner = await this.ids.OwnerOf(this.txn, id);
            const previous = this.old.ConceptOf(location.TypeId);
            const was = previous !== undefined && this.before.IsStub(owner, previous, this.old.Catalog);
            const is = this.after.IsStub(owner, concept, this.next.Catalog);
            if (was === is)
            {
                continue;
            }
            const node: IResidencyNode = { Id: id, PublicId: await this.PublicIdOf(id), Location: location, Concept: concept };
            if (is)
            {
                this.strip.push(node);
            }
            else
            {
                this.remove.set(id, node);
            }
        }
    }

    /** The node's edges in `direction`, by the new catalog's relationships (the purge already removed what no longer fits). */
    private async CollectEdges(node: IResidencyNode, direction: EdgeDirection): Promise<void>
    {
        const rels = direction === EdgeDirection.Out
            ? this.next.Catalog.EffectiveMembers(node.Concept).filter(m => m.Kind === MemberKind.Relationship)
            : this.next.IncomingRelationships(node.Concept);
        for (const rel of rels)
        {
            for await (const edge of this.edges.Adjacent(this.txn, rel, node.Id, direction))
            {
                const from = direction === EdgeDirection.Out ? node.Id : edge.Node;
                const to = direction === EdgeDirection.Out ? edge.Node : node.Id;
                const key = ResidencyRun.EdgeKey(rel, from, to, edge.Position);
                if (!this.doomedEdges.has(key))
                {
                    this.doomedEdges.set(key, { Relationship: rel, From: from, To: to, Position: edge.Position.slice() });
                    this.touched.add(from);
                    this.touched.add(to);
                    this.keys.Add(ConflictKeys.EdgeSpace, ConflictKeys.Edge(rel.Id, EdgeDirection.Out, from, to));
                    this.keys.Add(ConflictKeys.EdgeSpace, ConflictKeys.Edge(rel.Id, EdgeDirection.In, to, from));
                }
            }
        }
    }

    /** True when an incoming edge of the node survives the reconciliation (its outgoing ones all go). */
    private async HasSurvivingEdge(node: IResidencyNode): Promise<boolean>
    {
        for (const rel of this.next.IncomingRelationships(node.Concept))
        {
            for await (const edge of this.edges.Adjacent(this.txn, rel, node.Id, EdgeDirection.In))
            {
                if (!this.doomedEdges.has(ResidencyRun.EdgeKey(rel, edge.Node, node.Id, edge.Position)))
                {
                    return true;
                }
            }
        }
        return false;
    }

    /** Public ids of the touched nodes that stay engine nodes (neither stripped nor removed). */
    private async ModifiedNodes(): Promise<string[]>
    {
        const changed = new Set<bigint>([...this.remove.keys(), ...this.strip.map(n => n.Id)]);
        const out: string[] = [];
        for (const id of this.touched)
        {
            if (!changed.has(id))
            {
                out.push(await this.PublicIdOf(id));
            }
        }
        return out.sort();
    }

    /** Nulls every property cell that holds a value and the node-id cell: the node keeps no engine data. */
    private async Strip(node: IResidencyNode): Promise<void>
    {
        this.keys.Add(ConflictKeys.NodeSpace, ConflictKeys.Node(node.PublicId));
        this.keys.Add(ConflictKeys.ExtentSpace, ConflictKeys.Extent(node.Location.TypeId));
        this.AddCellKeys(node.Id, node.Location.TypeId, CatalogSnapshot.NodeIdMember.Id);
        for (const member of this.next.Catalog.EffectiveMembers(node.Concept).filter(m => m.Kind === MemberKind.Property))
        {
            this.AddCellKeys(node.Id, node.Location.TypeId, member.Id);
            if ((await this.columns.ReadCell(this.txn, node.Location, member)) !== null)
            {
                await this.columns.WriteCell(this.txn, node.Location, member.Nullable ? member : { ...member, Nullable: true }, null);
                this.values += 1;
            }
        }
        await this.columns.WriteCell(this.txn, node.Location, CatalogSnapshot.NodeIdMember, null);
    }

    /** Removes the node as DeleteNode does (row, public-id binding and owner, seed marker); it holds no cell by now. */
    private async Remove(node: IResidencyNode): Promise<void>
    {
        await this.rows.Clear(this.txn, node.Id);
        await this.ids.Unbind(this.txn, node.PublicId, node.Id);
        SeedMarkers.Delete(this.txn, node.PublicId);
        this.keys.Add(ConflictKeys.NodeSpace, ConflictKeys.Node(node.PublicId));
        this.keys.Add(ConflictKeys.ExtentSpace, ConflictKeys.Extent(node.Location.TypeId));
    }

    private async PublicIdOf(id: bigint): Promise<string>
    {
        const publicId = await this.ids.PublicIdOf(this.txn, id);
        if (publicId === undefined)
        {
            throw new GraphError(GraphErrorCode.Corrupt, ResidencyRun.ErrNoPublicId + id);
        }
        return publicId;
    }

    private AddCellKeys(node: bigint, typeId: number, memberId: number): void
    {
        this.keys.Add(ConflictKeys.CellSpace, ConflictKeys.Cell(node, memberId));
        this.keys.Add(ConflictKeys.ColumnSpace, ConflictKeys.Column(typeId, memberId));
    }

    private static EdgeKey(rel: MemberDef, from: bigint, to: bigint, position: Uint8Array): string
    {
        const s = ResidencyRun.Separator;
        return rel.Id + s + from + s + to + s + ConflictKeys.Hex(position);
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
 * - Secondary indexes: a removed index's entries all go; entries of removed nodes, and of index slices
 *   whose concept, members or member columns changed, go (computed from the old values before anything
 *   is removed); then added and changed slices are built over the surviving nodes, so a unique violation
 *   in existing data is CommitError UniqueViolation and fails the upgrade. The seed batch that follows
 *   is maintained incrementally by BatchApplier.
 *
 * The caller flushes the column store and row index afterwards (rulings R20, F6).
 */
export class DataPurger
{
    public constructor(
        private readonly columns: ColumnStore,
        private readonly edges: EdgeStore,
        private readonly rows: RowIndex,
        private readonly ids: PublicIdIndex,
        private readonly indexes: IndexStore,
    )
    {
    }

    /**
     * `old` is the catalog the stored data conforms to, `next` the one being installed and `diff` the
     * plan's diff between them. The logical write keys of everything removed are added to `keys`. `stubs`
     * says which surviving nodes are stubs: one left without an edge is removed too (ruling R102).
     */
    public Purge(txn: IWriteTransaction, old: CatalogIndex, next: CatalogIndex, diff: CatalogDiff, keys: WriteKeySet, stubs: StubRule = new StubRule()): Promise<IPurgeStats>
    {
        return new PurgeRun(txn, old, next, diff, keys, this.columns, this.edges, this.rows, this.ids, this.indexes, stubs).Run();
    }

    /**
     * Reconciles stored data with a change of the stub rule (final review I2): after Purge, in the same upgrade write.
     * `before` is the rule the stored data was written under (with `old`), `after` the one being installed (with
     * `next`). See ResidencyRun: nodes whose binding became External are stripped to stubs, stubs whose binding is no
     * longer External are removed with their edges. The logical write keys of everything removed go into `keys`.
     */
    public Reconcile(txn: IWriteTransaction, old: CatalogIndex, next: CatalogIndex, keys: WriteKeySet, before: StubRule, after: StubRule): Promise<IResidencyStats>
    {
        return new ResidencyRun(txn, old, next, keys, this.columns, this.edges, this.rows, this.ids, this.indexes, before, after).Run();
    }
}
