import { AccessError } from '../../access/AccessError.js';
import { WriteStage } from '../../access/WriteStage.js';
import type { MemberDef } from '../../catalog/CatalogTypes.js';
import type { CatalogSnapshot } from '../../catalog/CatalogSnapshot.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import type { CellValue } from '../../columns/CellValue.js';
import { ChunkCodecError } from '../../columns/ChunkCodecError.js';
import { ValueCodec } from '../../columns/ValueCodec.js';
import { ConnectorError } from '../../connectors/ConnectorError.js';
import { GraphError } from '../../errors/GraphError.js';
import { FederatedReads } from '../../FederatedReads.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { CommitError, CommitErrorCode } from '../../txn/CommitError.js';
import { ConflictError } from '../../txn/ConflictError.js';
import { WriteBatch, WriteOp, type BatchOp, type IExternalTarget } from '../../txn/WriteBatch.js';
import { RelDirection } from '../CypherEnums.js';
import { CypherWriteError, CypherWriteErrorCode } from '../CypherError.js';
import { CypherNode } from '../CypherNode.js';
import type { ICypherSource } from '../CypherSource.js';
import type { CypherScalar } from '../CypherValue.js';
import { CypherWriteStats } from './CypherWriteStats.js';
import type { ICypherSink } from './CypherSink.js';
import type { INodePlacement } from './NodePlacement.js';
import { OverlaySource } from './OverlaySource.js';
import { OverlayEdge, PendingOverlay } from './PendingOverlay.js';

/**
 * Where the Cypher write operators write. Every write is checked as the engine would check it (member exists
 * and is a property, the value fits its type, null only for a nullable member), recorded in the PendingOverlay
 * (read-your-writes for the rest of the query, through View) and appended to a pending WriteBatch. Nothing
 * reaches the GraphTransaction until Commit, called once after the mutation pipeline drained without error: it
 * replays the pending writes in order onto the transaction and commits it, mapping engine failures to
 * CypherWriteError with the GraphError as cause (ConflictError → Conflict, AccessError → Denied, CommitError →
 * Invalid, ConnectorError → ConnectorFailed).
 *
 * A relationship created to an external node (one whose owner and concept bind to an External connector: fetched by the
 * query, or reached through a stub) carries LinkOptions.ExternalTarget, so the commit creates or reuses its stub (ruling
 * R102).
 */
export class TransactionSink implements ICypherSink
{
    private static readonly Dot = '.';
    private static readonly NoOwner = '';
    private static readonly Quote = '"';
    private static readonly UnknownNode = 'cannot write a node that is not visible or was deleted earlier in this query: ';
    private static readonly UnknownMember = 'unknown member ';
    private static readonly NotInstantiable = 'cannot create a node of ';
    private static readonly NotAProperty = 'member is a relationship, not a property: ';
    private static readonly NotARelationship = 'member is a property, not a relationship; it cannot hold a node: ';
    private static readonly NullNotAllowed = 'null is not allowed for the required property ';
    private static readonly Inexact = 'integer is not exactly representable as a Float64 for ';
    private static readonly BadValue = 'value does not fit the property ';
    private static readonly NodeHasRelationships = 'cannot delete a node that still has relationships; use DETACH DELETE';
    private static readonly Conflict = 'the write conflicted with a concurrent commit; retry the query';
    private static readonly Denied = 'the access scope does not allow the write';
    private static readonly Invalid = 'the write was rejected by the graph';
    private static readonly ConnectorFailed = 'a connector taking part in the write failed';
    private static readonly AlreadyCommitted = 'the write query has already committed';
    private static readonly NoDefaults: ReadonlyMap<string, CellValue> = new Map();

    public readonly View: OverlaySource;
    public readonly Stats = new CypherWriteStats();

    private readonly overlay = new PendingOverlay();
    private readonly pending = new WriteBatch();
    /** Indexes in `pending` of the SetProperty ops that are placement defaults (replayed with SetDefault). */
    private readonly defaults = new Set<number>();
    /** Indexes in `pending` of the Unlink ops a DETACH DELETE implies (replayed with DetachUnlink). */
    private readonly detaches = new Set<number>();
    private readonly catalog: CatalogSnapshot;
    private committed = false;

    constructor(private readonly transaction: GraphTransaction, base: ICypherSource, private readonly placement: INodePlacement)
    {
        this.View = new OverlaySource(base, this.overlay);
        this.catalog = transaction.Catalog;
    }

    /** The pending writes, in order (nothing has reached the transaction before Commit). */
    public Steps(): readonly BatchOp[]
    {
        return this.pending.Ops();
    }

    /**
     * Creates a node of the (resolved) concept with the given properties; returns it as the query now sees it. The
     * placement's Defaults fill the properties the query did not set (ruling R91), checked like query values.
     */
    public CreateNode(concept: string, properties: ReadonlyMap<string, CypherScalar>): CypherNode
    {
        try
        {
            this.catalog.RequireInstantiable(concept);
        }
        catch (error)
        {
            throw TransactionSink.Wrap(error, TransactionSink.NotInstantiable + concept);
        }
        const cells = new Map<string, CellValue>();
        for (const [name, value] of properties)
        {
            cells.set(name, this.Cell(this.Property(concept, name), concept, value));
        }
        const place = this.placement.Place(concept, cells);
        const placed = new Map<string, CellValue>();
        for (const [name, value] of place.Defaults ?? TransactionSink.NoDefaults)
        {
            if (!cells.has(name))
            {
                placed.set(name, this.Cell(this.Property(concept, name), concept, value));
            }
        }
        this.pending.CreateNode(place.PublicId, concept, place.Owner === TransactionSink.NoOwner ? undefined : { Owner: place.Owner });
        for (const [name, value] of cells)
        {
            this.pending.SetProperty(place.PublicId, name, value);
        }
        for (const [name, value] of placed)
        {
            this.defaults.add(this.pending.Count);
            this.pending.SetProperty(place.PublicId, name, value);
            cells.set(name, value);
        }
        const node = new CypherNode(place.PublicId, concept, place.Owner, this.Visible(concept, cells));
        this.overlay.RecordCreate(node);
        this.Stats.NodesCreated++;
        this.Stats.PropertiesSet += cells.size;
        return node;
    }

    public async SetProperty(publicId: string, member: string, value: CypherScalar | null): Promise<void>
    {
        const node = await this.Require(publicId);
        const cell = this.Cell(this.Property(node.Concept, member), node.Concept, value);
        this.pending.SetProperty(publicId, member, cell);
        this.overlay.RecordSet(node, member, cell);
        this.Stats.PropertiesSet++;
    }

    /** REMOVE n.p / SET n.p = null: a property is set to null; a relationship member loses every outgoing edge. */
    public async RemoveProperty(publicId: string, member: string): Promise<void>
    {
        const node = await this.Require(publicId);
        if (this.Member(node.Concept, member).Kind === MemberKind.Relationship)
        {
            for (const target of await this.Targets(publicId, member)) await this.DeleteRelationship(publicId, member, target);
            return;
        }
        await this.SetProperty(publicId, member, null);
    }

    /** SET n.rel = m: unlinks every other outgoing edge of the relationship, then links m (TODL's replace). */
    public async ReplaceRelationship(publicId: string, member: string, targetId: string): Promise<void>
    {
        const node = await this.Require(publicId);
        if (this.Member(node.Concept, member).Kind !== MemberKind.Relationship)
        {
            throw new CypherWriteError(TransactionSink.NotARelationship + TransactionSink.Label(node.Concept, member));
        }
        for (const target of await this.Targets(publicId, member))
        {
            if (target !== targetId) await this.DeleteRelationship(publicId, member, target);
        }
        await this.CreateRelationship(publicId, member, targetId);
    }

    /** False, writing nothing, when the edge already exists in the query's view. */
    public async CreateRelationship(from: string, relationship: string, to: string): Promise<boolean>
    {
        await this.Require(from);
        const target = await this.Require(to);
        if ((await this.Targets(from, relationship)).includes(to)) return false;
        const external = this.ExternalTarget(target);
        this.pending.Link(from, relationship, to, external === undefined ? undefined : { ExternalTarget: external });
        this.overlay.RecordLink(from, relationship, to);
        this.Stats.RelationshipsCreated++;
        return true;
    }

    /** False, writing nothing, when the edge does not exist in the query's view. */
    public DeleteRelationship(from: string, relationship: string, to: string): Promise<boolean>
    {
        return this.Unlink(from, relationship, to, false);
    }

    /** DeleteRelationship; `detach`: implied by the DETACH DELETE that follows (ruling R92). */
    private async Unlink(from: string, relationship: string, to: string, detach: boolean): Promise<boolean>
    {
        if (!(await this.Targets(from, relationship)).includes(to)) return false;
        if (detach) this.detaches.add(this.pending.Count);
        this.pending.Unlink(from, relationship, to);
        this.overlay.RecordUnlink(from, relationship, to);
        this.Stats.RelationshipsDeleted++;
        return true;
    }

    /**
     * Deletes the node; a node this query already deleted is skipped (several rows may delete it). DETACH unlinks
     * every edge (in the query's view) first; without DETACH a node with edges is a CypherWriteError (Invalid).
     */
    public async DeleteNode(publicId: string, detach: boolean): Promise<void>
    {
        if (this.overlay.IsDeleted(publicId)) return;
        await this.Require(publicId);
        const edges: [string, string, string][] = [];
        const seen = new Set<string>();
        for (const way of [RelDirection.Outgoing, RelDirection.Incoming])
        {
            for await (const row of this.View.Expand(publicId, undefined, way))
            {
                const edge: [string, string, string] = way === RelDirection.Outgoing ? [publicId, row.Relationship, row.Target.PublicId] : [row.Target.PublicId, row.Relationship, publicId];
                const key = OverlayEdge.Key(...edge);
                if (seen.has(key)) continue;
                seen.add(key);
                edges.push(edge);
            }
        }
        if (edges.length > 0 && !detach)
        {
            throw new CypherWriteError(TransactionSink.NodeHasRelationships, CypherWriteErrorCode.NodeHasRelationships);
        }
        for (const [from, relationship, to] of edges) await this.Unlink(from, relationship, to, true);
        // Strict: hidden edges the query cannot see still fail the commit (NodeHasEdges). DETACH: the engine
        // removes the hidden ones too, and routes their Unlinks to connectors itself (ruling R89).
        this.pending.DeleteNode(publicId, detach ? undefined : { Strict: true });
        this.overlay.RecordDelete(publicId);
        this.Stats.NodesDeleted++;
    }

    /** Replays the pending writes onto the transaction and commits it (once); resolves with the commit number. */
    public async Commit(): Promise<bigint>
    {
        if (this.committed) throw new CypherWriteError(TransactionSink.AlreadyCommitted);
        this.committed = true;
        const t = this.transaction;
        const ops = this.pending.Ops();
        for (let i = 0; i < ops.length; i++)
        {
            const op = ops[i] as BatchOp;
            switch (op.Op)
            {
                case WriteOp.CreateNode:
                    t.CreateNode(op.PublicId, op.Concept, op.Owner === undefined ? undefined : { Owner: op.Owner });
                    break;
                case WriteOp.SetProperty:
                    if (this.defaults.has(i))
                    {
                        t.SetDefault(op.PublicId, op.Member, op.Value);
                    }
                    else
                    {
                        t.SetProperty(op.PublicId, op.Member, op.Value);
                    }
                    break;
                case WriteOp.DeleteNode:
                    t.DeleteNode(op.PublicId, op.Strict === true ? { Strict: true } : undefined);
                    break;
                case WriteOp.Link:
                    t.Link(op.From, op.Relationship, op.To, op.Options);
                    break;
                case WriteOp.Unlink:
                    if (this.detaches.has(i))
                    {
                        t.DetachUnlink(op.From, op.Relationship, op.To);
                    }
                    else
                    {
                        t.Unlink(op.From, op.Relationship, op.To);
                    }
                    break;
            }
        }
        try
        {
            return await t.Commit();
        }
        catch (error)
        {
            throw TransactionSink.MapCommitError(error);
        }
    }

    /** An engine commit failure as a CypherWriteError (cause = the GraphError); anything else unchanged. */
    public static MapCommitError(error: unknown): unknown
    {
        if (error instanceof ConflictError) return new CypherWriteError(TransactionSink.Conflict, CypherWriteErrorCode.Conflict, error);
        if (error instanceof AccessError) return new CypherWriteError(TransactionSink.Denied, CypherWriteErrorCode.Denied, error);
        if (error instanceof CommitError && error.Code === CommitErrorCode.NodeHasEdges)
        {
            return new CypherWriteError(TransactionSink.NodeHasRelationships, CypherWriteErrorCode.NodeHasRelationships, error);
        }
        if (error instanceof CommitError) return new CypherWriteError(`${TransactionSink.Invalid}: ${error.message}`, CypherWriteErrorCode.Invalid, error);
        if (error instanceof ConnectorError && error.IsConflict) return new CypherWriteError(TransactionSink.Conflict, CypherWriteErrorCode.Conflict, error);
        if (error instanceof ConnectorError) return new CypherWriteError(TransactionSink.ConnectorFailed, CypherWriteErrorCode.ConnectorFailed, error);
        return error;
    }

    /** The node's identity when it is external data (its owner and concept bind to an External connector), else undefined. */
    private ExternalTarget(node: CypherNode): IExternalTarget | undefined
    {
        const setup = FederatedReads.Of(this.transaction).Setup;
        if (setup === undefined || !setup.IsStub(node.Owner, node.Concept, this.catalog))
        {
            return undefined;
        }
        return { Concept: node.Concept, Owner: node.Owner };
    }

    /** The node as the query now sees it; CypherWriteError when it is invisible, missing or deleted. */
    private async Require(publicId: string): Promise<CypherNode>
    {
        const node = await this.View.Node(publicId);
        if (node === undefined) throw new CypherWriteError(TransactionSink.UnknownNode + TransactionSink.Quote + publicId + TransactionSink.Quote);
        return node;
    }

    private async Targets(publicId: string, relationship: string): Promise<string[]>
    {
        const out: string[] = [];
        for await (const row of this.View.Expand(publicId, relationship, RelDirection.Outgoing)) out.push(row.Target.PublicId);
        return out;
    }

    private Member(concept: string, name: string): MemberDef
    {
        try
        {
            return this.catalog.Member(concept, name);
        }
        catch (error)
        {
            throw TransactionSink.Wrap(error, TransactionSink.UnknownMember + TransactionSink.Label(concept, name));
        }
    }

    private Property(concept: string, name: string): MemberDef
    {
        const def = this.Member(concept, name);
        if (def.Kind !== MemberKind.Property) throw new CypherWriteError(TransactionSink.NotAProperty + TransactionSink.Label(concept, name));
        return def;
    }

    /**
     * The Cypher value as the member's cell, under the engine's value rules: null only for a nullable member; an
     * Int64 into a Float64 member when exactly representable; otherwise the value must already be the member's
     * type (ValueCodec.Check). No lossy or cross-type coercion.
     */
    private Cell(def: MemberDef, concept: string, value: CypherScalar | null): CellValue
    {
        const label = TransactionSink.Label(concept, def.Name);
        if (value === null)
        {
            if (!def.Nullable) throw new CypherWriteError(TransactionSink.NullNotAllowed + label);
            return null;
        }
        let cell: CellValue = value;
        if (def.Type === ValueType.Float64 && typeof value === 'bigint')
        {
            cell = Number(value);
            if (BigInt(cell) !== value) throw new CypherWriteError(TransactionSink.Inexact + label);
        }
        try
        {
            ValueCodec.Check(def.Type!, cell);
        }
        catch (error)
        {
            if (error instanceof ChunkCodecError) throw new CypherWriteError(`${TransactionSink.BadValue}${label}: ${error.message}`, CypherWriteErrorCode.Invalid, error);
            throw error;
        }
        return cell;
    }

    public ReadOnlyMembers(publicId: string, concept: string): ReadonlySet<string>
    {
        return this.transaction.ReadOnlyMembers(concept, this.overlay.IsCreated(publicId) ? WriteStage.Create : WriteStage.Update);
    }

    /** A created node's properties as a reader under the transaction's scope would show them (null for unset). */
    private Visible(concept: string, cells: ReadonlyMap<string, CellValue>): Map<string, CellValue>
    {
        const hidden = this.transaction.HiddenMembers(concept);
        const out = new Map<string, CellValue>();
        for (const def of this.catalog.EffectiveMembers(concept))
        {
            if (def.Kind === MemberKind.Property && !hidden.has(def.Name)) out.set(def.Name, cells.get(def.Name) ?? null);
        }
        return out;
    }

    private static Label(concept: string, member: string): string
    {
        return concept + TransactionSink.Dot + member;
    }

    private static Wrap(error: unknown, message: string): unknown
    {
        if (error instanceof GraphError)
        {
            return new CypherWriteError(`${message}: ${error.message}`, CypherWriteErrorCode.Invalid, error);
        }
        return error;
    }
}
