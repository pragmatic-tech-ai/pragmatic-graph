import type { AccessScope } from './access/AccessScope.js';
import { HypotheticalNode } from './access/HypotheticalNode.js';
import { ScopeEvaluator } from './access/ScopeEvaluator.js';
import { CatalogError, CatalogErrorCode } from './catalog/CatalogError.js';
import type { MemberDef } from './catalog/CatalogTypes.js';
import { CatalogSnapshot } from './catalog/CatalogSnapshot.js';
import { MemberKind } from './catalog/ValueType.js';
import type { CellValue } from './columns/CellValue.js';
import type { IFetchedRow } from './connectors/FetchContract.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import { EdgeDirection } from './format/FormatKeys.js';
import { FederatedReads } from './FederatedReads.js';
import { IndexKey, type IIndexRange } from './indexes/IndexKey.js';
import type { IKeyRange } from './kv/KeyValue.js';
import type { GraphContext, IGraphDisposable, ReadSnapshot } from './GraphContext.js';
import { Predicate } from './predicate/Predicate.js';
import { type IReadNode, RecordedReads } from './RecordedReads.js';
import { ConflictKeys } from './txn/ConflictKeys.js';
import type { ReadSet } from './txn/ReadSet.js';

/** One row of ScanConcept: the node's public id and the member's value (for a relationship, a target's public id). */
export interface IScanRow
{
    readonly PublicId: string;
    readonly Value: CellValue;
}

/** A whole node as the query layer reads it: every effective, non-hidden property (null when unset). */
export interface INodeView
{
    readonly PublicId: string;
    readonly Concept: string;
    readonly Owner: string;
    readonly Properties: ReadonlyMap<string, CellValue>;
}

/** One edge of a node as the query layer reads it: the relationship name and the far node's public id. */
export interface ILinkView
{
    readonly Relationship: string;
    readonly PublicId: string;
}

/**
 * A read probe the caller passes to a scan, seek or link read: Tick() runs once per stored entry the
 * reader examines (a slot, an index entry, an adjacency entry), visible or not, before the scope filters
 * it. It may throw to abort the read (a query deadline, say); the error propagates unchanged.
 */
export interface IReadProbe
{
    Tick(): void;
}

/**
 * A consistent, read-only view of the graph at one commit (snapshot isolation): commits made after
 * the reader opened are not visible. Created by GraphStore.BeginRead; end it with dispose() (the store
 * disposes readers still open when it is disposed). Values returned are copies, never live storage.
 *
 * Every reader carries an AccessScope (spec section 7). A node the scope does not let it see behaves
 * exactly as a missing node in every read; a member the scope hides (Hidden or HiddenExact) reads as
 * null in GetProperty and yields no rows in ScanConcept (and an index over a hidden member skips the
 * node in SeekIndex). The visibility reads are recorded like any other read. EstimateCount stays an
 * unscoped upper bound.
 */
export class GraphReader implements IGraphDisposable
{
    private static readonly ErrDisposed = 'Reader has been disposed';
    private static readonly ErrNotProperty = 'Member is not a property: ';
    private static readonly ErrDirection = 'Unknown edge direction: ';
    private static readonly ErrUnknownIndex = 'Unknown index: ';
    private static readonly Dot = '.';
    private static readonly Partition = 0;
    private static readonly NoHidden: ReadonlySet<string> = new Set();

    private readonly recorded: RecordedReads;
    /** Undefined when the scope restricts no read (System): the hot path then does no evaluator work. */
    private readonly evaluator: ScopeEvaluator | undefined;
    /** Only for a scope that restricts writes but not reads (WriteEvaluator). */
    private writeEvaluator: ScopeEvaluator | undefined;
    /** The unscoped reads of a federated Cypher read (ruling R101); engine code obtains them through FederatedReads.Of. */
    private readonly federated: FederatedReads;
    private disposed = false;

    /** @internal Created by GraphStore.BeginRead and GraphStore.Begin; `reads` only for a transaction. */
    public constructor(protected readonly context: GraphContext, protected readonly snapshot: ReadSnapshot, private readonly scope: AccessScope, reads?: ReadSet)
    {
        this.recorded = new RecordedReads(context, snapshot, reads);
        this.evaluator = scope.ReadsUnrestricted ? undefined : new ScopeEvaluator(scope, this.recorded);
        this.federated = new FederatedReads(this, this.recorded, this.evaluator, snapshot.Index);
        context.Track(this);
    }

    /** The commit this reader sees (every commit up to and including it). */
    public get SnapshotCommit(): bigint
    {
        return this.snapshot.Commit;
    }

    /** The catalog this reader's snapshot was taken under (fixed for the reader's life). */
    public get Catalog(): CatalogSnapshot
    {
        return this.snapshot.Index.Catalog;
    }

    /** The access scope every read of this reader is enforced under. */
    public get Scope(): AccessScope
    {
        return this.scope;
    }

    /**
     * The members the scope hides on nodes whose own concept is `concept` (the union of every Hidden entry naming it, an
     * ancestor or a carried aspect, and the HiddenExact entry naming it); empty when nothing is hidden. Scope metadata only: nothing is read or recorded.
     */
    public HiddenMembers(concept: string): ReadonlySet<string>
    {
        return this.evaluator?.HiddenMembers(concept) ?? GraphReader.NoHidden;
    }

    /**
     * True iff a node of `concept` with exactly these property values, no owner, no seed provenance and no relationships
     * would pass this reader's scope Rows (ruling R95): how a host asks whether to show something that is not an engine
     * instance (a schema-level node, say) without deciding visibility itself. Entries apply by the usual inheritance
     * (ancestors, carried aspects) and ConceptIs names exactly `concept`; a missing property is null. Predicates that need
     * stored identity or edges (IdIn, OwnerIs, Seeded, Related, Reachable) cannot hold, also under Not (fail closed).
     * False for an unknown concept or an aspect name; true otherwise under a scope that restricts no read (System).
     * An undefined or null entry reads as unset; any other value must fit its member as a write would (an Int64 widens to a
     * Float64 member when exact), else GraphError SchemaViolation naming `Concept.member`, under every scope.
     * Synchronous: reads nothing from the store and records nothing.
     */
    public Admits(concept: string, properties: ReadonlyMap<string, CellValue>): boolean
    {
        this.RequireOpen();
        const node = HypotheticalNode.Build(this.Catalog, concept, properties);
        if (node === undefined)
        {
            return false;
        }
        return this.evaluator === undefined || this.evaluator.Admits(node);
    }

    /**
     * The row fetched from an External connector as this reader may see it (ruling R100). The row is first checked
     * against the reader's catalog (FetchedNode.Validated: GraphError SchemaViolation for a concept that is unknown or an
     * aspect, a Values key that is not an effective property, a value that does not fit its member, or a Links key that
     * is not an effective relationship; nulls dropped, Int64 widened into Float64 when exact), under every scope. Then
     * undefined when the scope does not let the reader see the row (ScopeEvaluator.VisibleFetched; Unknown is not
     * visible), else the checked row with every member HiddenMembers(row.Concept) names removed from its Values and
     * Links. Always a new row; the caller's is never changed. `owner` is the model the row was fetched for. Looks up the row's stub (the
     * stored node of that public id owned by `owner` whose binding is External) and records that node read, whether or
     * not one exists, so a transaction conflicts with a commit that creates or removes it.
     */
    public async AdmitFetched(fetched: IFetchedRow, owner: string): Promise<IFetchedRow | undefined>
    {
        this.RequireOpen();
        const node = await this.federated.FetchedNodeOf(fetched, owner);
        const row = node.Row;
        const evaluator = this.evaluator;
        if (evaluator === undefined)
        {
            return row;
        }
        if (!(await evaluator.VisibleFetched(node)))
        {
            return undefined;
        }
        const hidden = evaluator.HiddenMembers(row.Concept);
        if (hidden.size === 0)
        {
            return row;
        }
        return { PublicId: row.PublicId, Concept: row.Concept, Values: GraphReader.Without(row.Values, hidden), Links: GraphReader.Without(row.Links, hidden) };
    }

    /**
     * The scope's row predicate for a fetch of `concept` (design ruling D4): the And of the applicable Rows predicates
     * (the predicate itself when one applies), True when none applies and Default allows (and under a scope that
     * restricts no read), False when Default denies. Advisory push-down: fetched rows still pass AdmitFetched.
     */
    public FetchPredicate(concept: string): Predicate
    {
        this.RequireOpen();
        return this.evaluator?.RowsPredicate(concept) ?? Predicate.True;
    }

    /** A copy of `map` without the `hidden` keys. */
    private static Without<T>(map: ReadonlyMap<string, T>, hidden: ReadonlySet<string>): ReadonlyMap<string, T>
    {
        const out = new Map<string, T>();
        for (const [name, value] of map)
        {
            if (!hidden.has(name))
            {
                out.set(name, value);
            }
        }
        return out;
    }

    /**
     * The property's value (null for an unset nullable property or a member the scope hides), or
     * undefined when no visible node has the public id or the node is a stub (ruling D2, final review I3: a stub's
     * data lives in its External connector; this reader serves engine data only). Errors are GraphErrors with the codes a commit
     * uses for the same mistake (ruling F8): unknown members are a CatalogError and relationship members
     * a GraphError (both SchemaViolation); public ids over 400 UTF-8 bytes a PublicIdTooLongError
     * (InvalidArgument).
     */
    public async GetProperty(publicId: string, member: string): Promise<CellValue | undefined>
    {
        this.RequireOpen();
        const node = await this.EngineNode(publicId);
        if (node === undefined)
        {
            return undefined;
        }
        const def = this.snapshot.Index.Catalog.Member(node.Concept, member);
        if (def.Kind !== MemberKind.Property)
        {
            throw new GraphError(GraphErrorCode.SchemaViolation, GraphReader.ErrNotProperty + node.Concept + GraphReader.Dot + member);
        }
        if (this.evaluator !== undefined && this.evaluator.HiddenMembers(node.Concept).has(member))
        {
            return null;
        }
        return this.recorded.Cell(node, def);
    }

    /**
     * The whole node: concept, owner and every effective property the scope does not hide (null for an
     * unset one), in effective member order. Undefined when no visible node has the public id or the node is a stub
     * (as GetProperty). Records the node's binding and one Cell key per returned property, as GetProperty does.
     */
    public async ReadNode(publicId: string): Promise<INodeView | undefined>
    {
        this.RequireOpen();
        const node = await this.EngineNode(publicId);
        if (node === undefined)
        {
            return undefined;
        }
        const hidden = this.evaluator?.HiddenMembers(node.Concept);
        const properties = new Map<string, CellValue>();
        for (const def of this.snapshot.Index.Catalog.EffectiveMembers(node.Concept))
        {
            if (def.Kind === MemberKind.Property && hidden?.has(def.Name) !== true)
            {
                properties.set(def.Name, await this.recorded.Cell(node, def));
            }
        }
        return { PublicId: node.PublicId, Concept: node.Concept, Owner: await this.recorded.Owner(node), Properties: properties };
    }

    /**
     * Every edge of the node in `direction` whose far node is visible: Out follows each relationship
     * effective on the node's concept in effective member order (parent's, then aspects', then own),
     * In each relationship targeting the concept (catalog order); within one relationship in edge order.
     * A relationship the scope hides on its source concept is omitted, and so is an edge whose far node is a stub
     * (final review I3: this reader serves engine data only; Cypher resolves stubs through its connector). A missing
     * or invisible node has none. Records the node's binding and the adjacency ranges, as Neighbors does. With `relationship`
     * only edges of that relationship are walked and only its adjacency ranges are recorded; a node whose
     * concept has no such relationship (in that direction) has none, rather than an error as in Neighbors.
     * `probe` ticks once per adjacency entry examined.
     */
    public async Links(publicId: string, direction: EdgeDirection, relationship?: string, probe?: IReadProbe): Promise<readonly ILinkView[]>
    {
        this.RequireOpen();
        if (direction !== EdgeDirection.Out && direction !== EdgeDirection.In)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, GraphReader.ErrDirection + String(direction));
        }
        const node = await this.Locate(publicId);
        const out: ILinkView[] = [];
        if (node === undefined)
        {
            return out;
        }
        const evaluator = this.evaluator;
        const rels = relationship !== undefined
            ? this.recorded.RelationshipsOrNone(node.Concept, relationship, direction)
            : direction === EdgeDirection.Out
                ? this.snapshot.Index.Catalog.EffectiveMembers(node.Concept).filter(m => m.Kind === MemberKind.Relationship)
                : this.snapshot.Index.IncomingRelationships(node.Concept);
        const hidden = direction === EdgeDirection.Out ? evaluator?.HiddenMembers(node.Concept) : undefined;
        for (const rel of rels)
        {
            if (hidden?.has(rel.Name) === true)
            {
                continue;
            }
            for await (const id of this.recorded.Adjacent(rel, node.Id, direction))
            {
                this.RequireOpen();
                probe?.Tick();
                const neighbor = await this.EngineNeighbor(id, rel.Name, direction);
                if (neighbor !== undefined)
                {
                    out.push({ Relationship: rel.Name, PublicId: neighbor });
                }
            }
        }
        return out;
    }

    /**
     * Public ids of the visible nodes at the far end of the node's `relationship` edges, in edge order
     * (ordered relationships keep their insertion order). Out follows the node's own relationship; In
     * follows every relationship of that name whose targets admit the node's concept. A missing or
     * invisible node has none; a relationship the scope hides on its source concept yields none; a far node that is
     * a stub is omitted (as Links).
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
        const rels = this.recorded.Relationships(node.Concept, relationship, direction);
        const out: string[] = [];
        if (direction === EdgeDirection.Out && this.evaluator?.HiddenMembers(node.Concept).has(relationship) === true)
        {
            return out;
        }
        for (const rel of rels)
        {
            for await (const id of this.recorded.Adjacent(rel, node.Id, direction))
            {
                const neighbor = await this.EngineNeighbor(id, relationship, direction);
                if (neighbor !== undefined)
                {
                    out.push(neighbor);
                }
            }
        }
        return out;
    }

    /** The located node unless it is a stub (Locate's recording, plus the node's binding when External connectors exist). */
    private async EngineNode(publicId: string): Promise<IReadNode | undefined>
    {
        const node = await this.Locate(publicId);
        return node === undefined || (await this.recorded.IsStub(node)) ? undefined : node;
    }

    /**
     * The public id of an edge's far node as Links and Neighbors report it: undefined when it is a stub or invisible, or
     * for an In edge whose source (the far node) hides the relationship.
     */
    private async EngineNeighbor(id: bigint, relationship: string, direction: EdgeDirection): Promise<string | undefined>
    {
        const evaluator = this.evaluator;
        if (evaluator === undefined && !this.recorded.HasExternal)
        {
            return this.recorded.PublicIdOf(id);
        }
        const far = evaluator === undefined ? await this.recorded.NodeById(id) : await evaluator.VisibleById(id);
        if (far === undefined || (await this.recorded.IsStub(far)))
        {
            return undefined;
        }
        // In: the edge is a member of the far node (its source), so the far node's Hidden decides.
        if (direction === EdgeDirection.In && evaluator?.HiddenMembers(far.Concept).has(relationship) === true)
        {
            return undefined;
        }
        return far.PublicId;
    }

    /**
     * Every visible live node whose concept is, inherits from, or carries `conceptOrAspect`, with its
     * `member` value: one row per node for a property, one row per outgoing edge to a visible target
     * (Value = target public id) for a relationship; none for a concept on which the scope hides the
     * member. Rows come per matching concept, then in storage (slot) order. The member must belong to
     * the named concept or aspect (CatalogError UnknownMember otherwise, even when nothing carries the
     * aspect). Disposing the reader ends the scan: the next row rejects.
     */
    public async *ScanConcept(conceptOrAspect: string, member: string): AsyncIterable<IScanRow>
    {
        this.RequireOpen();
        const index = this.snapshot.Index;
        index.Catalog.MemberOf(conceptOrAspect, member);
        for (const typeId of index.Catalog.ConceptsMatching(conceptOrAspect))
        {
            this.RequireOpen();
            const concept = index.ConceptOf(typeId) as string;
            if (this.evaluator !== undefined && this.evaluator.HiddenMembers(concept).has(member))
            {
                continue;
            }
            const def = index.Catalog.Member(concept, member);
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

    /** The node's concept name, or undefined when no visible node has the public id. Records the node's binding. */
    public async ConceptOf(publicId: string): Promise<string | undefined>
    {
        this.RequireOpen();
        return (await this.Locate(publicId))?.Concept;
    }

    /**
     * The name of the model that holds the node: '' when it was created without an owner, undefined when
     * no visible node has the public id. Records the node's binding.
     */
    public async OwnerOf(publicId: string): Promise<string | undefined>
    {
        this.RequireOpen();
        const node = await this.Locate(publicId);
        return node === undefined ? undefined : this.recorded.Owner(node);
    }

    /**
     * True iff the node exists, is visible and was placed by the schema's seed (it has a seed marker,
     * spec 4.3): false for runtime nodes and when no visible node has the public id. Records the node's
     * binding, which every seed commit that writes the node's data or marker also writes; a marker-only
     * seed run is no commit and does not invalidate the read (ruling R53).
     */
    public async IsSeeded(publicId: string): Promise<boolean>
    {
        this.RequireOpen();
        const node = await this.Locate(publicId);
        return node !== undefined && this.recorded.Seeded(node);
    }

    /**
     * Public ids of the visible live nodes whose concept is, inherits from, or carries `conceptOrAspect`,
     * per matching concept then in slot order. Disposing the reader ends the scan: the next id rejects.
     * `probe` ticks once per slot examined, hidden or not.
     */
    public async *ScanNodes(conceptOrAspect: string, probe?: IReadProbe): AsyncIterable<string>
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
                probe?.Tick();
                const publicId = await this.VisibleIdOf(row.NodeId);
                this.RequireOpen();
                if (publicId !== undefined)
                {
                    yield publicId;
                }
            }
        }
    }

    /**
     * An upper bound of the live nodes matching `conceptOrAspect`: the sum of the matching concepts' slot
     * counts, which still include deleted slots. Unscoped (it counts invisible nodes too) and records
     * nothing: the figure is advisory.
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

    /**
     * Public ids of the visible nodes whose entries in the named secondary index lie in `range`, in index
     * order (by value tuple, then internal id; descending with Reverse), at most Limit (counting visible
     * nodes only). A node on which the scope hides a member the index reads (key or Where) is skipped.
     * `Prefix` fixes the leading members (null matches a null value: nulls are indexed and sort first);
     * `Lower`/`Upper` bound the member after the prefix. Records the key range scanned (phantom-safe):
     * the whole range, or, when Limit ids were produced, the range up to the last entry examined.
     * Errors: CatalogError UnknownMember for an unknown index; GraphError InvalidArgument for a prefix
     * longer than the index, a bound after a full prefix, a value that does not fit its member, or a
     * non-integer Limit. Disposing the reader ends the seek: the next id rejects. `probe` ticks once per
     * index entry examined, skipped or not.
     */
    public async *SeekIndex(index: string, range: IIndexRange, probe?: IReadProbe): AsyncIterable<string>
    {
        this.RequireOpen();
        const catalog = this.snapshot.Index.Catalog;
        const def = catalog.Index(index);
        if (def === undefined)
        {
            throw new CatalogError(CatalogErrorCode.UnknownMember, GraphReader.ErrUnknownIndex + index);
        }
        const members = catalog.IndexMembers(def);
        const keys = IndexKey.SeekRange(def.Name, def.Id, members, range);
        const limit = range.Limit ?? 0;
        const reverse = range.Reverse === true;
        const evaluator = this.evaluator;
        // Under a restricting scope Limit counts visible ids, so the store seek itself is unlimited.
        const seek = limit > 0 && evaluator === undefined ? { Limit: limit, Reverse: reverse } : { Reverse: reverse };
        const read = evaluator === undefined ? undefined : new Set([...members.map(m => m.Name), ...(def.Where === undefined ? [] : Predicate.MemberNames(def.Where))]);
        let last: Uint8Array | undefined;
        let count = 0;
        try
        {
            for await (const key of this.context.Indexes.Seek(this.snapshot.Txn, keys, seek))
            {
                this.RequireOpen();
                probe?.Tick();
                last = key;
                const publicId = evaluator === undefined
                    ? await this.recorded.PublicIdOf(IndexKey.InternalId(key))
                    : await this.VisibleIndexed(evaluator, IndexKey.InternalId(key), read as ReadonlySet<string>);
                this.RequireOpen();
                if (publicId === undefined)
                {
                    continue;
                }
                count += 1;
                yield publicId;
                if (limit > 0 && count >= limit)
                {
                    break;
                }
            }
        }
        finally
        {
            this.Reads?.AddRange(ConflictKeys.IndexSpace, ConflictKeys.IndexRange(GraphReader.Scanned(keys, limit, reverse, count, last)));
        }
    }

    /** Releases the snapshot. Idempotent; later reads reject. */
    public dispose(): void
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        this.federated.Close();
        this.context.Forget(this);
        this.snapshot.dispose();
    }

    /** Where reads are recorded for conflict detection; only a GraphTransaction records (ruling R31). */
    protected get Reads(): ReadSet | undefined
    {
        return this.recorded.Reads;
    }

    /**
     * The evaluator the WriteGate checks this reader's writes with: the read evaluator when the scope
     * restricts reads (sharing its caches), else one made on first use over the same recorded reads.
     */
    protected WriteEvaluator(): ScopeEvaluator
    {
        return this.evaluator ?? (this.writeEvaluator ??= new ScopeEvaluator(this.scope, this.recorded));
    }

    /**
     * The owner ('' for none) and concept of the live node with that public id, unscoped (a write-through
     * routes by it whatever the scope may see); undefined when there is none. Records the node's binding.
     */
    protected async NodeOrigin(publicId: string): Promise<{ readonly Owner: string; readonly Concept: string } | undefined>
    {
        const node = await this.recorded.Locate(publicId);
        return node === undefined ? undefined : { Owner: await this.recorded.Owner(node), Concept: node.Concept };
    }

    /**
     * Every edge of the live node with that public id, unscoped (a write-through routes the edges a delete
     * removes whatever the scope may see, ruling R89): outgoing over its effective relationships in
     * declaration order, then incoming over IncomingRelationships, each in stored edge order; a self-loop
     * appears in both. None when there is no such node. Records the node's binding and every adjacency
     * range it walks.
     */
    protected async NodeEdges(publicId: string): Promise<{ readonly From: string; readonly Relationship: string; readonly To: string }[]>
    {
        const out: { readonly From: string; readonly Relationship: string; readonly To: string }[] = [];
        const node = await this.recorded.Locate(publicId);
        if (node === undefined)
        {
            return out;
        }
        for (const rel of this.snapshot.Index.Catalog.EffectiveMembers(node.Concept).filter(m => m.Kind === MemberKind.Relationship))
        {
            for await (const id of this.recorded.Adjacent(rel, node.Id, EdgeDirection.Out))
            {
                out.push({ From: publicId, Relationship: rel.Name, To: await this.recorded.PublicIdOf(id) });
            }
        }
        for (const rel of this.snapshot.Index.IncomingRelationships(node.Concept))
        {
            for await (const id of this.recorded.Adjacent(rel, node.Id, EdgeDirection.In))
            {
                out.push({ From: await this.recorded.PublicIdOf(id), Relationship: rel.Name, To: publicId });
            }
        }
        return out;
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
            const publicId = await this.VisibleIdOf(row.NodeId);
            this.RequireOpen();
            if (publicId !== undefined)
            {
                yield { PublicId: publicId, Value: row.Value };
            }
        }
    }

    private async *ScanRelationship(typeId: number, def: MemberDef): AsyncIterable<IScanRow>
    {
        for await (const row of this.context.Columns.ScanColumn(this.snapshot.Txn, GraphReader.Partition, typeId, CatalogSnapshot.NodeIdMember))
        {
            this.RequireOpen();
            const source = await this.VisibleIdOf(row.NodeId);
            if (source === undefined)
            {
                continue;
            }
            for await (const n of this.recorded.Adjacent(def, row.NodeId, EdgeDirection.Out))
            {
                this.RequireOpen();
                const target = await this.VisibleIdOf(n);
                this.RequireOpen();
                if (target !== undefined)
                {
                    yield { PublicId: source, Value: target };
                }
            }
        }
    }

    /** The public id of the node behind an internal id when the scope lets the reader see it. */
    private async VisibleIdOf(id: bigint): Promise<string | undefined>
    {
        if (this.evaluator === undefined)
        {
            return this.recorded.PublicIdOf(id);
        }
        return (await this.evaluator.VisibleById(id))?.PublicId;
    }

    /** As VisibleIdOf, also skipping a node on which the scope hides a member the index reads. */
    private async VisibleIndexed(evaluator: ScopeEvaluator, id: bigint, read: ReadonlySet<string>): Promise<string | undefined>
    {
        const node = await evaluator.VisibleById(id);
        if (node === undefined)
        {
            return undefined;
        }
        const hidden = evaluator.HiddenMembers(node.Concept);
        for (const name of read)
        {
            if (hidden.has(name))
            {
                return undefined;
            }
        }
        return node.PublicId;
    }

    /** The part of a seek's range its result depends on: up to the last key when Limit stopped it, else all of it. */
    private static Scanned(range: IKeyRange, limit: number, reverse: boolean, count: number, last: Uint8Array | undefined): IKeyRange
    {
        if (limit <= 0 || count < limit || last === undefined)
        {
            return range;
        }
        return reverse ? { Start: last, End: range.End } : { Start: range.Start, End: IndexKey.After(last) };
    }

    /**
     * Resolves the node when it exists and is visible, recording its binding (also when missing) and the visibility
     * reads.
     */
    private async Locate(publicId: string): Promise<IReadNode | undefined>
    {
        const node = await this.recorded.Locate(publicId);
        if (node === undefined || this.evaluator === undefined)
        {
            return node;
        }
        return (await this.evaluator.IsVisible(node)) ? node : undefined;
    }
}
