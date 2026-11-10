import { MemberKind } from '../catalog/ValueType.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { CatalogIndex } from '../txn/CatalogIndex.js';
import type { PreparedCommit } from '../txn/PreparedCommit.js';
import type { Signal } from '../txn/Signal.js';
import { type BatchOp, type IUnlinkOp, WriteBatch, WriteOp } from '../txn/WriteBatch.js';
import { BindingTable } from './BindingTable.js';
import type { IConnectorApplied } from './ConnectorApplied.js';
import { type ConnectorChange, ConnectorChangeSet } from './ConnectorChangeSet.js';
import { ConnectorError, ConnectorPhase } from './ConnectorError.js';
import { ExternalWriteCheck } from './ExternalWriteCheck.js';
import { ConnectorResidency, type IExternalConnector } from './FetchContract.js';
import type { IConnectorTransaction, IGraphConnector } from './GraphConnector.js';

/** The owner (model, '' for none) and concept a write routes by. */
export interface INodeOrigin
{
    readonly Owner: string;
    readonly Concept: string;
    /** True when the node is not stored and the origin is that of the row the transaction fetched for it (R103). */
    readonly Fetched?: boolean;
}

/** What WriteCoordinator.Route makes of one batch. */
export interface IRoutedBatch
{
    /** Per participating connector, its change set (in batch op order), keyed in connector-name order. */
    readonly Sets: ReadonlyMap<string, ConnectorChangeSet>;
    /** The part of the batch engine storage applies, in batch order: everything but the ops on external nodes (R103). */
    readonly Engine: WriteBatch;
}

/** One stored edge, by the public ids of its source and target. */
export interface IIncidentEdge
{
    readonly From: string;
    readonly Relationship: string;
    readonly To: string;
}

/**
 * Where routing looks up nodes the batch does not create: the transaction's snapshot (recorded reads), else the rows the
 * transaction fetched from External connectors.
 */
export interface INodeOrigins
{
    /** The stored node's origin, else the fetched row's (Fetched set), else undefined. */
    Origin(publicId: string): Promise<INodeOrigin | undefined>;
    /**
     * Every edge of the live node, unscoped, outgoing (effective relationships in declaration order) then
     * incoming (IncomingRelationships order), each in stored edge order; none when there is no such node.
     * A self-loop appears in both directions.
     */
    Edges(publicId: string): Promise<readonly IIncidentEdge[]>;
}

/**
 * The snapshot's edges as the batch has changed them so far, for routing the edges a plain DeleteNode
 * removes (ruling R89). A detached id is one whose stored edges no longer apply: the batch deleted it
 * (its edges went with it) or created it (a create that succeeds had no live node of that id).
 */
class BatchEdges
{
    private static readonly Separator = '\u0000';

    private readonly detached = new Set<string>();
    private readonly removed = new Set<string>();
    /** The batch's links still standing, by edge key, in batch order (Map keeps insertion order). */
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
        // A link re-added after an unlink moves to the end, as the batch order of its latest Link.
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
     * Removes the node from the overlay and returns the edges it had at this point of the batch, when
     * `concept` is given (a plain delete of a node of that concept): outgoing before incoming, by
     * relationship declaration order, then stored edges in stored order before the batch's links in batch
     * order; each edge once. A strict delete passes no concept: it removes no edges.
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

/** Groups one batch's changes by connector (WriteCoordinator.Route). */
class ChangeRouter
{
    private readonly known = new Map<string, INodeOrigin | undefined>();
    private readonly grouped = new Map<string, ConnectorChange[]>();

    public constructor(private readonly table: BindingTable, private readonly index: CatalogIndex, private readonly origins: INodeOrigins, private readonly external: ReadonlySet<string>)
    {
    }

    /** True when the origin binds to an External connector: the node's data lives only there (ruling R103). */
    public IsExternal(origin: INodeOrigin | undefined): origin is INodeOrigin
    {
        if (origin === undefined || this.external.size === 0)
        {
            return false;
        }
        const name = this.table.Resolve(origin.Owner, origin.Concept, this.index.Catalog);
        return name !== undefined && this.external.has(name);
    }

    /** Records the origin a CreateNode gives its id for the batch's later ops. */
    public Created(publicId: string, origin: INodeOrigin): void
    {
        this.known.set(publicId, origin);
    }

    /** The id's latest origin: its CreateNode earlier in the batch, else the snapshot's node (looked up once). */
    public async Origin(publicId: string): Promise<INodeOrigin | undefined>
    {
        if (!this.known.has(publicId))
        {
            this.known.set(publicId, await this.origins.Origin(publicId));
        }
        return this.known.get(publicId);
    }

    /** Adds the op to the change set of the connector its origin binds to; none when engine-only or found nowhere. */
    public Emit(op: BatchOp, origin: INodeOrigin | undefined): void
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
        changes.push({ ...op, Owner: origin.Owner, Concept: origin.Concept } as ConnectorChange);
    }

    /** The change sets, keyed in connector-name order. */
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

/** The connectors installed on a store, by name, with the bindings that route to them (GraphContext.SetConnectors). */
export class ConnectorSetup
{
    private static readonly ErrUnknown = 'A binding names a connector that is not installed: ';
    private static readonly ErrDuplicate = 'Two installed connectors share the name: ';
    private static readonly ErrReserved = 'A connector cannot use the reserved name: ';
    private static readonly ErrExternalDefault = 'An external connector cannot be the DefaultConnector: ';
    private static readonly ErrExternalContract = 'An external connector needs Capabilities and Fetch: ';
    private static readonly ErrTimeout = 'Connector timeout must be a finite positive number of milliseconds: ';

    public readonly Connectors: ReadonlyMap<string, IGraphConnector>;
    /** Names of the installed connectors whose Residency is External (ruling R96). */
    public readonly External: ReadonlySet<string>;

    public constructor(public readonly Bindings: BindingTable, connectors: readonly IGraphConnector[], public readonly TimeoutMs: number)
    {
        if (!Number.isFinite(TimeoutMs) || TimeoutMs <= 0)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrTimeout + TimeoutMs);
        }
        const byName = new Map<string, IGraphConnector>();
        for (const c of connectors)
        {
            if (c.Name === BindingTable.EngineStorage)
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrReserved + c.Name);
            }
            if (byName.has(c.Name))
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrDuplicate + c.Name);
            }
            ConnectorSetup.CheckResidency(c);
            byName.set(c.Name, c);
        }
        if (Bindings.DefaultConnector !== undefined && byName.get(Bindings.DefaultConnector)?.Residency === ConnectorResidency.External)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrExternalDefault + Bindings.DefaultConnector);
        }
        for (const name of Bindings.ConnectorNames())
        {
            if (name !== BindingTable.EngineStorage && !byName.has(name))
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrUnknown + name);
            }
        }
        this.Connectors = byName;
        this.External = new Set([...byName.values()].filter(c => c.Residency === ConnectorResidency.External).map(c => c.Name));
    }

    /** The installed External connectors by name (ruling R96): what a FetchSession fetches from. */
    public ExternalConnectors(): ReadonlyMap<string, IExternalConnector>
    {
        const out = new Map<string, IExternalConnector>();
        for (const name of this.External)
        {
            out.set(name, this.Connectors.get(name) as IExternalConnector);
        }
        return out;
    }

    /** An External connector must implement the fetch contract (ruling R96). */
    private static CheckResidency(connector: IGraphConnector): void
    {
        if (connector.Residency !== ConnectorResidency.External)
        {
            return;
        }
        const external = connector as Partial<IExternalConnector>;
        if (typeof external.Fetch !== 'function' || typeof external.Capabilities !== 'object' || external.Capabilities === null)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorSetup.ErrExternalContract + connector.Name);
        }
    }

    /**
     * True when `other` routes every write exactly as this setup does: the same binding table (bindings
     * and DefaultConnector, BindingTable.SameAs) and, per name, the same connector object. The timeout is
     * not compared: it bounds a write-through but does not route it.
     */
    public RoutesLike(other: ConnectorSetup): boolean
    {
        if (!this.Bindings.SameAs(other.Bindings) || this.Connectors.size !== other.Connectors.size)
        {
            return false;
        }
        for (const [name, connector] of this.Connectors)
        {
            if (other.Connectors.get(name) !== connector)
            {
                return false;
            }
        }
        return true;
    }
}

/** The connector call in flight when the connector phase timed out. */
interface IHungCall
{
    readonly Connector: IGraphConnector;
    readonly Phase: ConnectorPhase;
    /** The call; for Begin it resolves with the transaction to revert. */
    readonly Call: Promise<unknown>;
    /** The transaction that began, for Apply and Commit. */
    readonly Txn: IConnectorTransaction | undefined;
}

/** How a revert ended: undefined when it succeeded, else its error (boxed, so a thrown `undefined` still counts). */
type RevertOutcome = { readonly Error: unknown } | undefined;

/**
 * Write-through of one transaction (spec §6, ruling R72). Route groups the batch's ops by the connector
 * that holds each node's binding; Run then drives: Prepare (engine) → Begin each participant (sorted by
 * name) → Apply each → Commit each → Finalize (engine). Calls run one at a time, never inside a
 * store.Write. One deadline (the setup's timeout, from the start of Prepare) bounds Prepare, every
 * connector call and the reverts. On any failure or the timeout the prepared commit is aborted and every
 * connector that began is reverted, in reverse order of Begin (committed ones too: compensation); the
 * caller then gets a ConnectorError. A timeout during Prepare is ConnectorError (engine, Prepare) and the
 * commit is aborted once Prepare returns. Past the deadline nothing more is awaited: a call still hanging
 * is reverted once it returns, reverts still pending (or not yet started, which then start at once)
 * finish on that late path, and their failures are raised on `lateFailures`. An engine rejection at
 * Prepare is rethrown as-is (no connector began).
 */
export class WriteCoordinator
{
    private static readonly ErrTimedOut = 'Write-through timed out after ms: ';
    private static readonly ErrReverts = 'The write-through failed and reverting a connector failed too';
    private static readonly TimedOut: unique symbol = Symbol('TimedOut');
    /** The owner of a node created without one (as GraphReader.OwnerOf reports it). */
    private static readonly NoOwner = '';
    private static readonly NoExternal: ReadonlySet<string> = new Set();
    private static readonly ErrSeedOnly = 'A seed-only SetOwner op cannot be routed to connectors: ';
    private static readonly ErrUnhandled = 'Unhandled batch op kind: ';

    private began: { readonly Connector: IGraphConnector; readonly Txn: IConnectorTransaction }[] = [];
    private expired = false;
    private deadline: Promise<typeof WriteCoordinator.TimedOut> = new Promise(() => undefined);
    private timer: ReturnType<typeof setTimeout> | undefined;
    private hung: IHungCall | undefined;
    /** The connector call last started, for wrapping a non-connector error should one ever escape. */
    private current: { readonly Connector: string; readonly Phase: ConnectorPhase } = { Connector: BindingTable.EngineStorage, Phase: ConnectorPhase.Prepare };

    public constructor(private readonly setup: ConnectorSetup, private readonly lateFailures: Signal<ConnectorError>, private readonly applied: Signal<IConnectorApplied>)
    {
    }

    /**
     * Per participating connector, its change set (in batch op order), keyed in connector-name order, and the engine's
     * part of the batch. CreateNode / SetProperty / DeleteNode route by the node's owner and concept, Link / Unlink by the
     * source node's. An op routes by the latest CreateNode of its id earlier in the batch, else by the
     * node in the snapshot (`origins`, each id looked up once). DeleteNode does not change an id's
     * origin: an op on a deleted, not re-created id routes like the deleted node (the engine rejects it at
     * Prepare anyway, before any connector begins); a re-created id routes by its new CreateNode. A node
     * found nowhere routes nowhere (the engine rejects the op at Prepare).
     *
     * A plain (non-strict) DeleteNode is preceded by one Unlink per edge it removes (ruling R89): every
     * edge of the node in the snapshot as the batch's earlier ops left it (`origins.Edges`, unscoped, so
     * edges the writer's scope hides as well), each routed by its source node exactly like an explicit
     * Unlink, to whichever connector that binds to. A strict DeleteNode removes no edges and gets none.
     *
     * Writes to external nodes (ruling R103, `external` the installed External connectors): an op whose node (a Link /
     * Unlink: its source) binds to an External connector is that connector's change only and is left out of Engine, so
     * nothing external is written to KV. Such a node is the CreateNode's (owner, concept), a stored stub, or a row the
     * transaction fetched (`origins`). Its ops are checked as the engine checks its own (ExternalWriteCheck: CommitError
     * before any connector begins). A plain DeleteNode of an external node puts one Unlink per engine edge into its stub
     * (the edges as the batch's earlier ops left them) into Engine, each also routed by its source as R89 routes them;
     * the last one removes the stub (R102). A strict one fails with NodeHasEdges while any engine edge remains.
     */
    public static async Route(batch: WriteBatch, table: BindingTable, index: CatalogIndex, origins: INodeOrigins, external: ReadonlySet<string> = WriteCoordinator.NoExternal): Promise<IRoutedBatch>
    {
        const router = new ChangeRouter(table, index, origins, external);
        const edges = new BatchEdges(index, origins);
        const check = new ExternalWriteCheck(index);
        const engine = new WriteBatch();
        for (const op of batch.Ops())
        {
            switch (op.Op)
            {
                case WriteOp.CreateNode:
                {
                    const origin = { Owner: op.Owner ?? WriteCoordinator.NoOwner, Concept: op.Concept };
                    // The id's latest origin, the batch's own creates included, so an in-batch collision is caught too.
                    const prior = await router.Origin(op.PublicId);
                    if (router.IsExternal(origin))
                    {
                        check.Created(op, prior !== undefined && prior.Fetched !== true && !router.IsExternal(prior));
                    }
                    else
                    {
                        check.EngineCreated(op.PublicId);
                        engine.Append(op);
                    }
                    router.Created(op.PublicId, origin);
                    edges.Created(op.PublicId);
                    router.Emit(op, origin);
                    break;
                }
                case WriteOp.DeleteNode:
                {
                    const origin = await router.Origin(op.PublicId);
                    const outside = router.IsExternal(origin);
                    const strict = op.Strict === true;
                    // An external node's engine edges are removed op by op here; the engine removes an engine node's itself.
                    const concept = strict && !outside ? undefined : origin?.Concept;
                    const removed: IUnlinkOp[] = [];
                    for (const edge of await edges.Deleted(op.PublicId, concept))
                    {
                        const unlink: IUnlinkOp = { Op: WriteOp.Unlink, From: edge.From, Relationship: edge.Relationship, To: edge.To };
                        const source = await router.Origin(edge.From);
                        if (outside && !router.IsExternal(source))
                        {
                            removed.push(unlink);
                        }
                        if (!strict)
                        {
                            router.Emit(unlink, source);
                        }
                    }
                    if (outside)
                    {
                        check.DeletedExternal(op.PublicId, strict, removed.length);
                        removed.forEach(unlink => engine.Append(unlink));
                    }
                    else
                    {
                        check.Deleted(op.PublicId);
                        engine.Append(op);
                    }
                    router.Emit(op, origin);
                    break;
                }
                case WriteOp.Link:
                {
                    edges.Linked(op);
                    const source = await router.Origin(op.From);
                    if (router.IsExternal(source))
                    {
                        check.Link(op, source, await router.Origin(op.To));
                    }
                    else
                    {
                        // An external target the batch deleted has no stub to link to: it must not be re-created.
                        if (check.IsDeleted(op.To))
                        {
                            check.EngineLink(op, router.IsExternal(await router.Origin(op.To)));
                        }
                        engine.Append(op);
                    }
                    router.Emit(op, source);
                    break;
                }
                case WriteOp.Unlink:
                {
                    edges.Unlinked(op);
                    const source = await router.Origin(op.From);
                    if (router.IsExternal(source))
                    {
                        check.Unlink(op, source);
                    }
                    else
                    {
                        engine.Append(op);
                    }
                    router.Emit(op, source);
                    break;
                }
                case WriteOp.SetProperty:
                {
                    const origin = await router.Origin(op.PublicId);
                    if (router.IsExternal(origin))
                    {
                        check.SetProperty(op, origin);
                    }
                    else
                    {
                        engine.Append(op);
                    }
                    router.Emit(op, origin);
                    break;
                }
                case WriteOp.SetOwner:
                    // Seed synchronization only (ruling R90), and seed sync is never routed.
                    throw new GraphError(GraphErrorCode.Internal, WriteCoordinator.ErrSeedOnly + op.PublicId);
                default:
                    return WriteCoordinator.Unhandled(op);
            }
        }
        check.Finish();
        return { Sets: router.Sets(), Engine: engine };
    }

    /** Compile-time exhaustiveness: every BatchOp kind has a case in Route. */
    private static Unhandled(op: never): never
    {
        throw new GraphError(GraphErrorCode.Internal, WriteCoordinator.ErrUnhandled + String((op as BatchOp).Op));
    }

    /**
     * Runs the write-through of `sets` (from Route, non-empty); resolves with the engine's commit number. With `unchanged`
     * (the engine part of the batch is empty, controller ruling P13) the prepared commit only guards the engine reads
     * during the connector phase: once every connector committed it is released, not finalized (PreparedCommit.Release, which
     * fails where Finalize would: then every connector is reverted, as for a failed Finalize), and Run resolves with
     * `unchanged` (no engine commit, no log entry, no CommitApplied). On success ConnectorApplied is raised once, after
     * the engine commit when there is one (a throwing subscriber is ignored).
     */
    public async Run(prepare: () => Promise<PreparedCommit>, sets: ReadonlyMap<string, ConnectorChangeSet>, unchanged?: bigint): Promise<bigint>
    {
        this.deadline = new Promise(resolve =>
        {
            this.timer = setTimeout(() =>
            {
                this.expired = true;
                resolve(WriteCoordinator.TimedOut);
            }, this.setup.TimeoutMs);
        });
        try
        {
            const commit = await this.Drive(prepare, sets, unchanged);
            this.RaiseApplied(sets, unchanged === undefined ? commit : undefined);
            return commit;
        }
        finally
        {
            clearTimeout(this.timer);
        }
    }

    /** ConnectorApplied for a successful write-through: per connector, the distinct concepts of its change set, sorted. */
    private RaiseApplied(sets: ReadonlyMap<string, ConnectorChangeSet>, commit: bigint | undefined): void
    {
        const connectors = new Map<string, readonly string[]>();
        for (const [name, set] of sets)
        {
            connectors.set(name, Object.freeze([...new Set(set.Changes.map(c => c.Concept))].sort()));
        }
        const applied: IConnectorApplied = commit === undefined ? { Connectors: connectors } : { Commit: commit, Connectors: connectors };
        try
        {
            this.applied.Raise(Object.freeze(applied));
        }
        catch
        {
            // Subscriber failures cannot undo the connectors' commits; Signal already ran every handler.
        }
    }

    private async Drive(prepare: () => Promise<PreparedCommit>, sets: ReadonlyMap<string, ConnectorChangeSet>, unchanged: bigint | undefined): Promise<bigint>
    {
        const prepared = await this.Prepared(prepare);
        try
        {
            const participants = [...sets.keys()].map(name => this.setup.Connectors.get(name)!);
            for (const connector of participants)
            {
                const txn = await this.Call(connector, ConnectorPhase.Begin, undefined, () => connector.Begin());
                this.began.push({ Connector: connector, Txn: txn });
            }
            for (const { Connector, Txn } of this.began)
            {
                await this.Call(Connector, ConnectorPhase.Apply, Txn, () => Txn.Apply(sets.get(Connector.Name)!));
            }
            for (const { Connector, Txn } of this.began)
            {
                await this.Call(Connector, ConnectorPhase.Commit, Txn, () => Txn.Commit());
            }
        }
        catch (error)
        {
            prepared.Abort();
            throw await this.Failed(error instanceof ConnectorError ? error : new ConnectorError(this.current.Connector, this.current.Phase, error));
        }
        if (unchanged !== undefined)
        {
            // Nothing for engine storage: the reservation guarded the engine reads until the connectors committed, and
            // it must still hold now, as Finalize would require; else every connector is compensated.
            try
            {
                prepared.Release();
            }
            catch (error)
            {
                throw await this.Failed(new ConnectorError(BindingTable.EngineStorage, ConnectorPhase.Finalize, error));
            }
            return unchanged;
        }
        try
        {
            return await prepared.Finalize();
        }
        catch (error)
        {
            throw await this.Failed(new ConnectorError(BindingTable.EngineStorage, ConnectorPhase.Finalize, error));
        }
    }

    /**
     * Prepare raced against the deadline. Its own rejection is rethrown as-is; at the deadline it is
     * ConnectorError (engine, Prepare), and the commit is aborted whenever Prepare still resolves.
     */
    private async Prepared(prepare: () => Promise<PreparedCommit>): Promise<PreparedCommit>
    {
        const pending = prepare();
        const result = await Promise.race([pending, this.deadline]);
        if (result !== WriteCoordinator.TimedOut)
        {
            return result;
        }
        pending.then(p => p.Abort(), () => undefined);
        throw this.Timeout(BindingTable.EngineStorage, ConnectorPhase.Prepare);
    }

    /**
     * One connector call, raced against the deadline. A throw becomes a ConnectorError of this call; the
     * timeout too, after recording the call as hung. Past the deadline the call is not made.
     */
    private async Call<T>(connector: IGraphConnector, phase: ConnectorPhase, txn: IConnectorTransaction | undefined, call: () => Promise<T>): Promise<T>
    {
        this.current = { Connector: connector.Name, Phase: phase };
        if (this.expired)
        {
            throw this.Timeout(connector.Name, phase);
        }
        let pending: Promise<T>;
        try
        {
            pending = call();
        }
        catch (error)
        {
            throw new ConnectorError(connector.Name, phase, error);
        }
        let result: T | typeof WriteCoordinator.TimedOut;
        try
        {
            result = await Promise.race([pending, this.deadline]);
        }
        catch (error)
        {
            throw new ConnectorError(connector.Name, phase, error);
        }
        if (result === WriteCoordinator.TimedOut)
        {
            this.hung = { Connector: connector, Phase: phase, Call: pending, Txn: txn };
            throw this.Timeout(connector.Name, phase);
        }
        return result;
    }

    private Timeout(connector: string, phase: ConnectorPhase): ConnectorError
    {
        return new ConnectorError(connector, phase, new GraphError(GraphErrorCode.ConnectorFailed, WriteCoordinator.ErrTimedOut + this.setup.TimeoutMs));
    }

    /**
     * Reverts every connector that began, in reverse order (a hung one later, once its call returns),
     * and returns the error to throw: `failure`, its cause wrapped with the revert errors when any.
     * Reverts are awaited only until the deadline; the rest start at once and finish on the late path.
     */
    private async Failed(failure: ConnectorError): Promise<ConnectorError>
    {
        const hung = this.hung;
        if (hung !== undefined)
        {
            void this.RevertLate(hung);
        }
        const errors: unknown[] = [];
        for (const { Connector, Txn } of [...this.began].reverse())
        {
            if (hung !== undefined && hung.Connector === Connector)
            {
                continue;
            }
            const outcome = WriteCoordinator.Revert(Txn);
            if (this.expired)
            {
                this.ReportLate(Connector, failure.Phase, outcome);
                continue;
            }
            const result = await Promise.race([outcome, this.deadline]);
            if (result === WriteCoordinator.TimedOut)
            {
                this.ReportLate(Connector, failure.Phase, outcome);
            }
            else if (result !== undefined)
            {
                errors.push(result.Error);
            }
        }
        if (errors.length === 0)
        {
            return failure;
        }
        return new ConnectorError(failure.Connector, failure.Phase, new AggregateError([failure.cause, ...errors], WriteCoordinator.ErrReverts));
    }

    /** Starts the transaction's Revert; never rejects (a throw, synchronous or not, becomes the outcome). */
    private static async Revert(txn: IConnectorTransaction): Promise<RevertOutcome>
    {
        try
        {
            await txn.Revert();
            return undefined;
        }
        catch (error)
        {
            return { Error: error };
        }
    }

    /** Waits for the hung call, then reverts its connector's transaction on the late path. */
    private async RevertLate(hung: IHungCall): Promise<void>
    {
        let txn = hung.Txn;
        try
        {
            const value = await hung.Call;
            if (hung.Phase === ConnectorPhase.Begin)
            {
                txn = value as IConnectorTransaction;
            }
        }
        catch
        {
            // The call's own failure is moot: the caller already has the timeout. A failed Begin began nothing.
        }
        if (txn !== undefined)
        {
            this.ReportLate(hung.Connector, hung.Phase, WriteCoordinator.Revert(txn));
        }
    }

    /** Raises a late revert's failure on lateFailures once it settles. */
    private ReportLate(connector: IGraphConnector, phase: ConnectorPhase, outcome: Promise<RevertOutcome>): void
    {
        void outcome.then(result =>
        {
            if (result === undefined)
            {
                return;
            }
            try
            {
                this.lateFailures.Raise(new ConnectorError(connector.Name, phase, result.Error));
            }
            catch
            {
                // A throwing subscriber has nowhere to report to on this detached path (Signal aggregates handler
                // errors).
            }
        });
    }
}
