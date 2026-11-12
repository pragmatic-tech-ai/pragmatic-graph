import { MemberKind } from '../catalog/ValueType.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { CatalogIndex } from '../txn/CatalogIndex.js';
import { type BatchOp, type IUnlinkOp, WriteOp } from '../txn/WriteBatch.js';
import { BindingTable } from './BindingTable.js';
import { type ConnectorChange, ConnectorChangeSet } from './ConnectorChangeSet.js';
import { ExternalWriteCheck } from './ExternalWriteCheck.js';
import { VersionLedger } from './FetchSession.js';
import type { IIncidentEdge, INodeOrigin, INodeOrigins } from './WriteCoordinator.js';

/**
 * The snapshot's edges as the steps have changed them so far, for routing the edges a plain DeleteNode
 * removes (ruling R89). A detached id is one whose stored edges no longer apply: a step deleted it
 * (its edges went with it) or created it (a create that succeeds had no live node of that id).
 */
export class BatchEdges
{
    private static readonly Separator = '\u0000';

    private readonly detached = new Set<string>();
    private readonly removed = new Set<string>();
    /** The links still standing, by edge key, in record order (Map keeps insertion order). */
    private readonly added = new Map<string, IIncidentEdge>();

    public constructor(private readonly index: CatalogIndex, private readonly origins: INodeOrigins)
    {
    }

    public Created(publicId: string): void
    {
        this.detached.add(publicId);
    }

    public Linked(edge: IIncidentEdge): void
    {
        const key = BatchEdges.Key(edge);
        // A link re-added after an unlink moves to the end, as the order of its latest Link.
        this.added.delete(key);
        this.added.set(key, { From: edge.From, Relationship: edge.Relationship, To: edge.To });
    }

    public Unlinked(edge: IIncidentEdge): void
    {
        const key = BatchEdges.Key(edge);
        if (!this.added.delete(key))
        {
            this.removed.add(key);
        }
    }

    /**
     * Removes the node from the overlay and returns the edges it had at this point, when `concept` is given (a plain
     * delete of a node of that concept): outgoing before incoming, by relationship declaration order, then stored
     * edges in stored order before the recorded links in record order; each edge once. A strict delete passes no
     * concept: it removes no edges.
     */
    public async Deleted(publicId: string, concept: string | undefined): Promise<IIncidentEdge[]>
    {
        const edges = concept === undefined ? [] : await this.Incident(publicId, concept);
        for (const [key, e] of this.added)
        {
            if (e.From === publicId || e.To === publicId)
            {
                this.added.delete(key);
            }
        }
        this.detached.add(publicId);
        return edges;
    }

    private async Incident(publicId: string, concept: string): Promise<IIncidentEdge[]>
    {
        const definition = this.index.Catalog.Definition(concept);
        if (definition === undefined || definition.IsAspect)
        {
            // Not a node the engine can hold: the batch fails at Prepare.
            return [];
        }
        const candidates: IIncidentEdge[] = [];
        if (!this.detached.has(publicId))
        {
            for (const e of await this.origins.Edges(publicId))
            {
                if (!this.removed.has(BatchEdges.Key(e)) && !this.detached.has(e.From) && !this.detached.has(e.To))
                {
                    candidates.push(e);
                }
            }
        }
        for (const e of this.added.values())
        {
            if (e.From === publicId || e.To === publicId)
            {
                candidates.push(e);
            }
        }
        const outgoing = this.index.Catalog.EffectiveMembers(concept).filter(m => m.Kind === MemberKind.Relationship).map(m => m.Name);
        const incoming = this.index.IncomingRelationships(concept).map(m => m.Name);
        const seen = new Set<string>();
        const ranked: { readonly Edge: IIncidentEdge; readonly Rank: number; readonly At: number }[] = [];
        for (const e of candidates)
        {
            const key = BatchEdges.Key(e);
            if (seen.has(key))
            {
                continue;
            }
            seen.add(key);
            const rank = e.From === publicId ? BatchEdges.Rank(outgoing, e.Relationship) : outgoing.length + 1 + BatchEdges.Rank(incoming, e.Relationship);
            ranked.push({ Edge: e, Rank: rank, At: ranked.length });
        }
        return ranked.sort((p, q) => p.Rank - q.Rank || p.At - q.At).map(r => r.Edge);
    }

    /** Position of the relationship name; an unknown one (an op the engine rejects at Prepare) sorts last. */
    private static Rank(names: readonly string[], name: string): number
    {
        const at = names.indexOf(name);
        return at >= 0 ? at : names.length;
    }

    private static Key(edge: IIncidentEdge): string
    {
        return edge.From + BatchEdges.Separator + edge.Relationship + BatchEdges.Separator + edge.To;
    }
}

/** Groups changes by connector for one step; the id origins and created ids persist across the transaction's steps. */
export class ChangeRouter
{
    private readonly known = new Map<string, INodeOrigin | undefined>();
    private grouped = new Map<string, ConnectorChange[]>();
    /** The ids a CreateNode created so far: their later changes carry no ExpectedVersion (R119 V2). */
    private readonly createdHere = new Set<string>();

    public constructor(private readonly table: BindingTable, private readonly index: CatalogIndex, private readonly origins: INodeOrigins, private readonly external: ReadonlySet<string>, private readonly ledger: VersionLedger)
    {
    }

    /** Starts a fresh step: the per-step grouping is cleared, while the id origins and created set persist. */
    public BeginStep(): void
    {
        this.grouped = new Map<string, ConnectorChange[]>();
    }

    /** True when the origin binds to an External connector: the node's data lives only there (ruling R103). */
    public IsExternal(origin: INodeOrigin | undefined): origin is INodeOrigin
    {
        return origin !== undefined && this.external.size > 0 && this.table.IsStub(origin.Owner, origin.Concept, this.index.Catalog, this.external);
    }

    /** Records the origin a CreateNode gives its id for later ops. */
    public Created(publicId: string, origin: INodeOrigin): void
    {
        this.known.set(publicId, origin);
        this.createdHere.add(publicId);
    }

    /** True when a CreateNode (or a source-assigned create) of the id ran in this transaction (ruling R136 E4). */
    public IsCreated(publicId: string): boolean
    {
        return this.createdHere.has(publicId);
    }

    /** The id's latest origin: its CreateNode earlier, else the snapshot's node (looked up once). */
    public async Origin(publicId: string): Promise<INodeOrigin | undefined>
    {
        if (!this.known.has(publicId))
        {
            this.known.set(publicId, await this.origins.Origin(publicId));
        }
        return this.known.get(publicId);
    }

    /**
     * Adds the op to the change set of the connector its origin binds to; none when engine-only or found nowhere. On an
     * External connector the change carries the ExpectedVersion of `routingId` (the written node, or a Link / Unlink's
     * source) the VersionLedger gives (ruling R137 E5): the version this transaction's own latest step reported for it,
     * else the fetched one (R119 V1) unless a step created it earlier and the source has reported none yet (R119 V2);
     * the key is never added without a version, and Mirrored connectors never get one.
     */
    public Emit(op: BatchOp, origin: INodeOrigin | undefined, routingId: string): void
    {
        if (origin === undefined)
        {
            return;
        }
        const name = this.table.Resolve(origin.Owner, origin.Concept, this.index.Catalog);
        if (BindingTable.IsEngineOnly(name))
        {
            return;
        }
        let changes = this.grouped.get(name as string);
        if (changes === undefined)
        {
            changes = [];
            this.grouped.set(name as string, changes);
        }
        const version = this.external.has(name as string)
            ? this.ledger.Expected(routingId, this.origins.Version(routingId), this.createdHere.has(routingId))
            : undefined;
        changes.push((version === undefined
            ? { ...op, Owner: origin.Owner, Concept: origin.Concept }
            : { ...op, Owner: origin.Owner, Concept: origin.Concept, ExpectedVersion: version }) as ConnectorChange);
    }

    /** The step's change sets, keyed in connector-name order. */
    public Sets(): ReadonlyMap<string, ConnectorChangeSet>
    {
        const sets = new Map<string, ConnectorChangeSet>();
        for (const name of [...this.grouped.keys()].sort())
        {
            sets.set(name, new ConnectorChangeSet(this.grouped.get(name)!));
        }
        return sets;
    }
}

/** What StepRouter.Route makes of one step's ops (ruling R135 E2). */
export interface IRoutedStep
{
    /** Per External connector its change set, keyed in connector-name order: these execute now. */
    readonly External: ReadonlyMap<string, ConnectorChangeSet>;
    /** Per Mirrored connector its changes, keyed in connector-name order: these stage until Commit. */
    readonly Mirrored: ReadonlyMap<string, readonly ConnectorChange[]>;
    /** The part of the step engine storage applies, in order: everything but the ops on external nodes (R103). */
    readonly Engine: readonly BatchOp[];
}

/**
 * The persistent per-GraphTransaction router (ruling R135 E2): the ChangeRouter origins, BatchEdges and
 * ExternalWriteCheck of WriteCoordinator.Route, now kept across steps. Route groups one step's ops by the connector
 * that holds each node's binding, in the same order and with the same semantic checks WriteCoordinator.Route applies
 * to a whole batch (ruling R103), and splits the result into the sets that execute now (External), the sets that
 * stage until Commit (Mirrored) and the ops engine storage applies (Engine). A deleted id stays deleted, and an id a
 * step created stays live, for every later step (ruling R135 E7).
 */
export class StepRouter
{
    private static readonly NoOwner = '';
    private static readonly ErrSeedOnly = 'A seed-only SetOwner op cannot be routed to connectors: ';
    private static readonly ErrUnhandled = 'Unhandled batch op kind: ';

    private readonly router: ChangeRouter;
    private readonly edges: BatchEdges;
    private readonly check: ExternalWriteCheck;

    public constructor(private readonly table: BindingTable, private readonly index: CatalogIndex, origins: INodeOrigins, private readonly external: ReadonlySet<string>, ledger: VersionLedger = new VersionLedger())
    {
        this.router = new ChangeRouter(table, index, origins, external, ledger);
        this.edges = new BatchEdges(index, origins);
        this.check = new ExternalWriteCheck(index);
    }

    /**
     * Routes one step's ops. The External sets execute now; the Mirrored sets stage until Commit; the Engine ops append
     * to the transaction's engine batch (ruling R135 E2). R29 is judged over the step's own external creates
     * (ExternalWriteCheck.Finish). A failure (CommitError) rejects the step before any connector call.
     */
    public async Route(ops: readonly BatchOp[]): Promise<IRoutedStep>
    {
        this.router.BeginStep();
        const engine: BatchOp[] = [];
        const created = new Set<string>();
        for (const op of ops)
        {
            switch (op.Op)
            {
                case WriteOp.CreateNode:
                {
                    const origin = { Owner: op.Owner ?? StepRouter.NoOwner, Concept: op.Concept };
                    // The id's latest origin, earlier creates included, so an in-step or cross-step collision is caught.
                    const prior = await this.router.Origin(op.PublicId);
                    if (this.router.IsExternal(origin))
                    {
                        this.check.Created(op, prior !== undefined && prior.Fetched !== true && !this.router.IsExternal(prior));
                        created.add(op.PublicId);
                    }
                    else
                    {
                        this.check.EngineCreated(op.PublicId);
                        engine.push(op);
                    }
                    this.router.Created(op.PublicId, origin);
                    this.edges.Created(op.PublicId);
                    this.router.Emit(op, origin, op.PublicId);
                    break;
                }
                case WriteOp.DeleteNode:
                {
                    const origin = await this.router.Origin(op.PublicId);
                    const outside = this.router.IsExternal(origin);
                    const strict = op.Strict === true;
                    // An external node's engine edges are removed op by op here; the engine removes an engine node's itself.
                    const concept = strict && !outside ? undefined : origin?.Concept;
                    const removed: IUnlinkOp[] = [];
                    for (const edge of await this.edges.Deleted(op.PublicId, concept))
                    {
                        const unlink: IUnlinkOp = { Op: WriteOp.Unlink, From: edge.From, Relationship: edge.Relationship, To: edge.To };
                        const source = await this.router.Origin(edge.From);
                        if (outside && !this.router.IsExternal(source))
                        {
                            removed.push(unlink);
                        }
                        if (!strict)
                        {
                            this.router.Emit(unlink, source, edge.From);
                        }
                    }
                    if (outside)
                    {
                        this.check.DeletedExternal(op.PublicId, strict, removed.length);
                        removed.forEach(unlink => engine.push(unlink));
                    }
                    else
                    {
                        this.check.Deleted(op.PublicId);
                        engine.push(op);
                    }
                    created.delete(op.PublicId);
                    this.router.Emit(op, origin, op.PublicId);
                    break;
                }
                case WriteOp.Link:
                {
                    this.edges.Linked(op);
                    const source = await this.router.Origin(op.From);
                    if (this.router.IsExternal(source))
                    {
                        this.check.Link(op, source, await this.router.Origin(op.To));
                    }
                    else
                    {
                        // An external target a step deleted has no stub to link to: it must not be re-created.
                        if (this.check.IsDeleted(op.To))
                        {
                            this.check.EngineLink(op, this.router.IsExternal(await this.router.Origin(op.To)));
                        }
                        engine.push(op);
                    }
                    this.router.Emit(op, source, op.From);
                    break;
                }
                case WriteOp.Unlink:
                {
                    this.edges.Unlinked(op);
                    const source = await this.router.Origin(op.From);
                    if (this.router.IsExternal(source))
                    {
                        this.check.Unlink(op, source);
                    }
                    else
                    {
                        engine.push(op);
                    }
                    this.router.Emit(op, source, op.From);
                    break;
                }
                case WriteOp.SetProperty:
                {
                    const origin = await this.router.Origin(op.PublicId);
                    if (this.router.IsExternal(origin))
                    {
                        this.check.SetProperty(op, origin);
                    }
                    else
                    {
                        engine.push(op);
                    }
                    this.router.Emit(op, origin, op.PublicId);
                    break;
                }
                case WriteOp.SetOwner:
                    // Seed synchronization only (ruling R90), and seed sync is never routed.
                    throw new GraphError(GraphErrorCode.Internal, StepRouter.ErrSeedOnly + op.PublicId);
                default:
                    return StepRouter.Unhandled(op);
            }
        }
        this.check.Finish(created);
        return this.Split(engine);
    }

    /**
     * Records a node a source-keyed create minted (ruling R136 E4): its later ops route External, treat it as created
     * (no stale version, DuplicatePublicId on a re-create) and find it live. Also used by CreateAssigned (Task 2.3).
     */
    public Created(publicId: string, origin: INodeOrigin): void
    {
        this.router.Created(publicId, origin);
        this.edges.Created(publicId);
        this.check.Assigned(publicId, origin.Concept);
    }

    /** True when the transaction created the id (a CreateNode or a source-assigned create); its re-create is a duplicate. */
    public IsCreated(publicId: string): boolean
    {
        return this.router.IsCreated(publicId);
    }

    /** Splits the step's grouped change sets into External (execute now) and Mirrored (stage), each name-ordered. */
    private Split(engine: readonly BatchOp[]): IRoutedStep
    {
        const external = new Map<string, ConnectorChangeSet>();
        const mirrored = new Map<string, readonly ConnectorChange[]>();
        for (const [name, set] of this.router.Sets())
        {
            if (this.external.has(name))
            {
                external.set(name, set);
            }
            else
            {
                mirrored.set(name, set.Changes);
            }
        }
        return { External: external, Mirrored: mirrored, Engine: engine };
    }

    /** Compile-time exhaustiveness: every BatchOp kind has a case in Route. */
    private static Unhandled(op: never): never
    {
        throw new GraphError(GraphErrorCode.Internal, StepRouter.ErrUnhandled + String((op as BatchOp).Op));
    }
}
