import { CatalogError, CatalogErrorCode } from './catalog/CatalogError.js';
import type { MemberDef } from './catalog/CatalogTypes.js';
import { CatalogSnapshot } from './catalog/CatalogSnapshot.js';
import { MemberKind } from './catalog/ValueType.js';
import type { CellValue } from './columns/CellValue.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import { EdgeDirection } from './format/FormatKeys.js';
import type { Location } from './identity/Location.js';
import type { GraphContext, IGraphDisposable, ReadSnapshot } from './GraphContext.js';
import { ConflictKeys } from './txn/ConflictKeys.js';
import type { ReadSet } from './txn/ReadSet.js';

/** One row of ScanConcept: the node's public id and the member's value (for a relationship, a target's public id). */
export interface IScanRow
{
    readonly PublicId: string;
    readonly Value: CellValue;
}

/** A live node resolved inside the reader's snapshot. */
interface IReadNode
{
    readonly Id: bigint;
    readonly Location: Location;
    readonly Concept: string;
}

/**
 * A consistent, read-only view of the graph at one commit (snapshot isolation): commits made after
 * the reader opened are not visible. Created by GraphStore.BeginRead; end it with dispose() (the store
 * disposes readers still open when it is disposed). Values returned are copies, never live storage.
 */
export class GraphReader implements IGraphDisposable
{
    private static readonly ErrDisposed = 'Reader has been disposed';
    private static readonly ErrNotProperty = 'Member is not a property: ';
    private static readonly ErrNotRelationship = 'Member is not a relationship: ';
    private static readonly ErrNoIncoming = 'No relationship of this name targets the concept: ';
    private static readonly ErrDirection = 'Unknown edge direction: ';
    private static readonly ErrCorrupt = 'Corrupt graph: node has no stored row or public id: ';
    private static readonly Dot = '.';
    private static readonly Partition = 0;

    private disposed = false;

    /** @internal Created by GraphStore.BeginRead and GraphStore.Begin. */
    public constructor(protected readonly context: GraphContext, protected readonly snapshot: ReadSnapshot)
    {
        context.Track(this);
    }

    /** The commit this reader sees (every commit up to and including it). */
    public get SnapshotCommit(): bigint
    {
        return this.snapshot.Commit;
    }

    /**
     * The property's value (null for an unset nullable property), or undefined when no node has the
     * public id. Errors are GraphErrors with the codes a commit uses for the same mistake (ruling F8):
     * unknown members are a CatalogError and relationship members a GraphError (both SchemaViolation);
     * public ids over 400 UTF-8 bytes a PublicIdTooLongError (InvalidArgument).
     */
    public async GetProperty(publicId: string, member: string): Promise<CellValue | undefined>
    {
        this.RequireOpen();
        const node = await this.Locate(publicId);
        if (node === undefined)
        {
            return undefined;
        }
        const def = this.snapshot.Index.Catalog.Member(node.Concept, member);
        if (def.Kind !== MemberKind.Property)
        {
            throw new GraphError(GraphErrorCode.SchemaViolation, GraphReader.ErrNotProperty + node.Concept + GraphReader.Dot + member);
        }
        this.Reads?.AddKey(ConflictKeys.CellSpace, ConflictKeys.Cell(node.Id, def.Id));
        return this.context.Columns.ReadCell(this.snapshot.Txn, node.Location, def);
    }

    /**
     * Public ids of the nodes at the far end of the node's `relationship` edges, in edge order (ordered
     * relationships keep their insertion order). Out follows the node's own relationship; In follows
     * every relationship of that name whose targets admit the node's concept. A missing node has none.
     */
    public async Neighbors(publicId: string, relationship: string, direction: EdgeDirection): Promise<string[]>
    {
        this.RequireOpen();
        if (direction !== EdgeDirection.Out && direction !== EdgeDirection.In)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, GraphReader.ErrDirection + String(direction));
        }
        const node = await this.Locate(publicId);
        if (node === undefined)
        {
            return [];
        }
        const out: string[] = [];
        for (const rel of this.Relationships(node.Concept, relationship, direction))
        {
            this.Reads?.AddRange(ConflictKeys.EdgeSpace, ConflictKeys.Adjacency(rel.Id, direction, node.Id));
            for await (const n of this.context.Edges.Adjacent(this.snapshot.Txn, rel, node.Id, direction))
            {
                out.push(await this.PublicIdOf(n.Node));
            }
        }
        return out;
    }

    /**
     * Every live node whose concept is, inherits from, or carries `conceptOrAspect`, with its `member`
     * value: one row per node for a property, one row per outgoing edge (Value = target public id) for a
     * relationship. Rows come per matching concept, then in storage (slot) order. The member must belong
     * to the named concept or aspect (CatalogError UnknownMember otherwise, even when nothing carries
     * the aspect). Disposing the reader ends the scan: the next row rejects.
     */
    public async *ScanConcept(conceptOrAspect: string, member: string): AsyncIterable<IScanRow>
    {
        this.RequireOpen();
        const index = this.snapshot.Index;
        index.Catalog.MemberOf(conceptOrAspect, member);
        for (const typeId of index.Catalog.ConceptsMatching(conceptOrAspect))
        {
            this.RequireOpen();
            const def = index.Catalog.Member(index.ConceptOf(typeId) as string, member);
            this.Reads?.AddKey(ConflictKeys.ExtentSpace, ConflictKeys.Extent(typeId));
            if (def.Kind === MemberKind.Property)
            {
                yield* this.ScanProperty(typeId, def);
            }
            else
            {
                yield* this.ScanRelationship(typeId, def);
            }
        }
    }

    /** The node's concept name, or undefined when no node has the public id. Records the node's binding. */
    public async ConceptOf(publicId: string): Promise<string | undefined>
    {
        this.RequireOpen();
        return (await this.Locate(publicId))?.Concept;
    }

    /**
     * The name of the model that holds the node: '' when it was created without an owner, undefined when
     * no node has the public id. Records the node's binding.
     */
    public async OwnerOf(publicId: string): Promise<string | undefined>
    {
        this.RequireOpen();
        const node = await this.Locate(publicId);
        return node === undefined ? undefined : this.context.Ids.OwnerOf(this.snapshot.Txn, node.Id);
    }

    /**
     * Public ids of the live nodes whose concept is, inherits from, or carries `conceptOrAspect`, per
     * matching concept then in slot order. Disposing the reader ends the scan: the next id rejects.
     */
    public async *ScanNodes(conceptOrAspect: string): AsyncIterable<string>
    {
        this.RequireOpen();
        const index = this.snapshot.Index;
        for (const typeId of index.Catalog.ConceptsMatching(conceptOrAspect))
        {
            this.RequireOpen();
            this.Reads?.AddKey(ConflictKeys.ExtentSpace, ConflictKeys.Extent(typeId));
            for await (const row of this.context.Columns.ScanColumn(this.snapshot.Txn, GraphReader.Partition, typeId, CatalogSnapshot.NodeIdMember))
            {
                this.RequireOpen();
                const publicId = await this.PublicIdOf(row.NodeId);
                this.RequireOpen();
                yield publicId;
            }
        }
    }

    /**
     * An upper bound of the live nodes matching `conceptOrAspect`: the sum of the matching concepts' slot
     * counts, which still include deleted slots. Records nothing: the figure is advisory.
     */
    public async EstimateCount(conceptOrAspect: string): Promise<number>
    {
        this.RequireOpen();
        let total = 0;
        for (const typeId of this.snapshot.Index.Catalog.ConceptsMatching(conceptOrAspect))
        {
            total += await this.context.Columns.SlotCount(this.snapshot.Txn, GraphReader.Partition, typeId);
        }
        return total;
    }

    /** Releases the snapshot. Idempotent; later reads reject. */
    public dispose(): void
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        this.context.Forget(this);
        this.snapshot.dispose();
    }

    /** Where reads are recorded for conflict detection; only a GraphTransaction records (ruling R31). */
    protected get Reads(): ReadSet | undefined
    {
        return undefined;
    }

    protected RequireOpen(): void
    {
        if (this.disposed)
        {
            throw new GraphError(GraphErrorCode.Disposed, GraphReader.ErrDisposed);
        }
    }

    /**
     * Live slots of the type in slot order; each column row carries its node id, so one pass suffices.
     * Records one coarse Column key for the whole column (ruling F7), not a Cell key per row; the
     * node-id column is covered by the Extent key.
     */
    private async *ScanProperty(typeId: number, def: MemberDef): AsyncIterable<IScanRow>
    {
        this.Reads?.AddKey(ConflictKeys.ColumnSpace, ConflictKeys.Column(typeId, def.Id));
        for await (const row of this.context.Columns.ScanColumn(this.snapshot.Txn, GraphReader.Partition, typeId, def))
        {
            this.RequireOpen();
            const publicId = await this.PublicIdOf(row.NodeId);
            this.RequireOpen();
            yield { PublicId: publicId, Value: row.Value };
        }
    }

    private async *ScanRelationship(typeId: number, def: MemberDef): AsyncIterable<IScanRow>
    {
        const txn = this.snapshot.Txn;
        for await (const row of this.context.Columns.ScanColumn(txn, GraphReader.Partition, typeId, CatalogSnapshot.NodeIdMember))
        {
            this.RequireOpen();
            const source = await this.PublicIdOf(row.NodeId);
            this.Reads?.AddRange(ConflictKeys.EdgeSpace, ConflictKeys.Adjacency(def.Id, EdgeDirection.Out, row.NodeId));
            for await (const n of this.context.Edges.Adjacent(txn, def, row.NodeId, EdgeDirection.Out))
            {
                this.RequireOpen();
                const target = await this.PublicIdOf(n.Node);
                this.RequireOpen();
                yield { PublicId: source, Value: target };
            }
        }
    }

    private Relationships(concept: string, name: string, direction: EdgeDirection): readonly MemberDef[]
    {
        const index = this.snapshot.Index;
        if (direction === EdgeDirection.Out)
        {
            const rel = index.Catalog.Member(concept, name);
            if (rel.Kind !== MemberKind.Relationship)
            {
                throw new GraphError(GraphErrorCode.SchemaViolation, GraphReader.ErrNotRelationship + concept + GraphReader.Dot + name);
            }
            return [rel];
        }
        const incoming = index.IncomingRelationships(concept).filter(r => r.Name === name);
        if (incoming.length === 0)
        {
            throw new CatalogError(CatalogErrorCode.UnknownMember, GraphReader.ErrNoIncoming + concept + GraphReader.Dot + name);
        }
        return incoming;
    }

    /** Resolves the node, recording the public id's binding (also when missing, which catches a later create). */
    private async Locate(publicId: string): Promise<IReadNode | undefined>
    {
        const txn = this.snapshot.Txn;
        const id = await this.context.Ids.Resolve(txn, publicId);
        this.Reads?.AddKey(ConflictKeys.NodeSpace, ConflictKeys.Node(publicId));
        if (id === undefined)
        {
            return undefined;
        }
        const location = await this.context.Rows.Locate(txn, id);
        const concept = location === undefined ? undefined : this.snapshot.Index.ConceptOf(location.TypeId);
        if (location === undefined || concept === undefined)
        {
            throw new GraphError(GraphErrorCode.Corrupt, GraphReader.ErrCorrupt + publicId);
        }
        return { Id: id, Location: location, Concept: concept };
    }

    private async PublicIdOf(id: bigint): Promise<string>
    {
        const publicId = await this.context.Ids.PublicIdOf(this.snapshot.Txn, id);
        if (publicId === undefined)
        {
            throw new GraphError(GraphErrorCode.Corrupt, GraphReader.ErrCorrupt + id);
        }
        return publicId;
    }
}
