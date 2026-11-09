import { CatalogError, CatalogErrorCode } from './catalog/CatalogError.js';
import type { CatalogSnapshot } from './catalog/CatalogSnapshot.js';
import type { MemberDef } from './catalog/CatalogTypes.js';
import { MemberKind } from './catalog/ValueType.js';
import type { CellValue } from './columns/CellValue.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import { EdgeDirection } from './format/FormatKeys.js';
import type { Location } from './identity/Location.js';
import type { GraphContext, ReadSnapshot } from './GraphContext.js';
import { SeedMarkers } from './schema/SeedMarkers.js';
import type { CatalogIndex } from './txn/CatalogIndex.js';
import { ConflictKeys } from './txn/ConflictKeys.js';
import type { ReadSet } from './txn/ReadSet.js';

/** A live node resolved inside a reader's snapshot. */
export interface IReadNode
{
    readonly Id: bigint;
    readonly PublicId: string;
    readonly Location: Location;
    readonly Concept: string;
}

/**
 * Internal: the unscoped read primitives of one reader's snapshot, each recording its logical keys in
 * the reader's ReadSet (a transaction's; none for a plain reader, ruling R31). GraphReader builds its
 * scoped public reads on these, and the ScopeEvaluator evaluates visibility through them, so visibility
 * is recorded like any other read and never recurses into the scoped methods.
 */
export class RecordedReads
{
    private static readonly ErrNotRelationship = 'Member is not a relationship: ';
    private static readonly ErrNoIncoming = 'No relationship of this name targets the concept: ';
    private static readonly ErrCorrupt = 'Corrupt graph: node has no stored row or public id: ';
    private static readonly Dot = '.';
    private static readonly None: readonly MemberDef[] = Object.freeze([]);

    public constructor(private readonly context: GraphContext, private readonly snapshot: ReadSnapshot, public readonly Reads: ReadSet | undefined)
    {
    }

    public get Index(): CatalogIndex
    {
        return this.snapshot.Index;
    }

    public get Catalog(): CatalogSnapshot
    {
        return this.snapshot.Index.Catalog;
    }

    /** Resolves the node, recording the public id's binding (also when missing, which catches a later create). */
    public async Locate(publicId: string): Promise<IReadNode | undefined>
    {
        const id = await this.context.Ids.Resolve(this.snapshot.Txn, publicId);
        this.Reads?.AddKey(ConflictKeys.NodeSpace, ConflictKeys.Node(publicId));
        if (id === undefined)
        {
            return undefined;
        }
        return this.Resolved(id, publicId);
    }

    /**
     * The live node with that internal id (one reached through an edge, a column or an index entry, whose
     * existence that read already recorded). Records nothing.
     */
    public async NodeById(id: bigint): Promise<IReadNode>
    {
        return this.Resolved(id, await this.PublicIdOf(id));
    }

    public async PublicIdOf(id: bigint): Promise<string>
    {
        const publicId = await this.context.Ids.PublicIdOf(this.snapshot.Txn, id);
        if (publicId === undefined)
        {
            throw new GraphError(GraphErrorCode.Corrupt, RecordedReads.ErrCorrupt + id);
        }
        return publicId;
    }

    /** The property cell; records Cell(node, member). */
    public async Cell(node: IReadNode, def: MemberDef): Promise<CellValue>
    {
        this.Reads?.AddKey(ConflictKeys.CellSpace, ConflictKeys.Cell(node.Id, def.Id));
        return this.context.Columns.ReadCell(this.snapshot.Txn, node.Location, def);
    }

    /** The model holding the node ('' for none); records the node's binding (owner changes only with the Node key: create, delete or a seed re-own, R36, R90). */
    public async Owner(node: IReadNode): Promise<string>
    {
        this.Reads?.AddKey(ConflictKeys.NodeSpace, ConflictKeys.Node(node.PublicId));
        return this.context.Ids.OwnerOf(this.snapshot.Txn, node.Id);
    }

    /** True iff the node has a seed marker; records the node's binding, which every seed write also writes. */
    public async Seeded(node: IReadNode): Promise<boolean>
    {
        this.Reads?.AddKey(ConflictKeys.NodeSpace, ConflictKeys.Node(node.PublicId));
        return (await SeedMarkers.Read(this.snapshot.Txn, node.PublicId)) !== undefined;
    }

    /**
     * Internal ids at the far end of the node's `rel` edges in `direction`, in edge order; records the adjacency range.
     */
    public async *Adjacent(rel: MemberDef, node: bigint, direction: EdgeDirection): AsyncIterable<bigint>
    {
        this.Reads?.AddRange(ConflictKeys.EdgeSpace, ConflictKeys.Adjacency(rel.Id, direction, node));
        for await (const n of this.context.Edges.Adjacent(this.snapshot.Txn, rel, node, direction))
        {
            yield n.Node;
        }
    }

    /**
     * The relationships `name` in `direction` from a node of `concept`: Out its own relationship, In
     * every relationship of that name targeting the concept. Throws for an unknown or non-relationship
     * member (Out) or no such incoming relationship (In).
     */
    public Relationships(concept: string, name: string, direction: EdgeDirection): readonly MemberDef[]
    {
        if (direction === EdgeDirection.Out)
        {
            const rel = this.Catalog.Member(concept, name);
            if (rel.Kind !== MemberKind.Relationship)
            {
                throw new GraphError(GraphErrorCode.SchemaViolation, RecordedReads.ErrNotRelationship + concept + RecordedReads.Dot + name);
            }
            return [rel];
        }
        const incoming = this.Index.IncomingRelationships(concept).filter(r => r.Name === name);
        if (incoming.length === 0)
        {
            throw new CatalogError(CatalogErrorCode.UnknownMember, RecordedReads.ErrNoIncoming + concept + RecordedReads.Dot + name);
        }
        return incoming;
    }

    /** As Relationships, but none (instead of an error) when the concept has no such relationship. */
    public RelationshipsOrNone(concept: string, name: string, direction: EdgeDirection): readonly MemberDef[]
    {
        if (direction === EdgeDirection.Out)
        {
            const rel = this.Catalog.EffectiveMembers(concept).find(m => m.Name === name);
            return rel === undefined || rel.Kind !== MemberKind.Relationship ? RecordedReads.None : [rel];
        }
        return this.Index.IncomingRelationships(concept).filter(r => r.Name === name);
    }

    private async Resolved(id: bigint, publicId: string): Promise<IReadNode>
    {
        const location = await this.context.Rows.Locate(this.snapshot.Txn, id);
        const concept = location === undefined ? undefined : this.snapshot.Index.ConceptOf(location.TypeId);
        if (location === undefined || concept === undefined)
        {
            throw new GraphError(GraphErrorCode.Corrupt, RecordedReads.ErrCorrupt + publicId);
        }
        return { Id: id, PublicId: publicId, Location: location, Concept: concept };
    }
}
