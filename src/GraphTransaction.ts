import { randomUUID } from 'node:crypto';
import type { AccessScope } from './access/AccessScope.js';
import { AccessError } from './access/AccessError.js';
import type { CatalogSnapshot } from './catalog/CatalogSnapshot.js';
import { WriteExemptions } from './access/WriteExemptions.js';
import { WriteGate } from './access/WriteGate.js';
import type { WriteStage } from './access/WriteStage.js';
import type { CellValue } from './columns/CellValue.js';
import { FetchedNode } from './access/FetchedNode.js';
import { BindingTable } from './connectors/BindingTable.js';
import type { ConnectorChange } from './connectors/ConnectorChangeSet.js';
import { ConnectorError, ConnectorPhase } from './connectors/ConnectorError.js';
import type { ConnectorContext } from './connectors/ConnectorContext.js';
import { VersionLedger } from './connectors/FetchSession.js';
import type { IFetchedRow, RowVersion } from './connectors/FetchContract.js';
import type { IAssignedCreate, IAssignedOutcome } from './connectors/GraphConnector.js';
import { StepRouter } from './connectors/StepRouter.js';
import { TransactionFetch } from './connectors/TransactionFetch.js';
import { type ConnectorSetup, type INodeOrigin, type INodeOrigins, WriteCoordinator } from './connectors/WriteCoordinator.js';
import { CommitError, CommitErrorCode } from './txn/CommitError.js';
import type { GraphContext, ReadSnapshot } from './GraphContext.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import { FederatedReads } from './FederatedReads.js';
import { GraphReader, type INodeView } from './GraphReader.js';
import { CommitErrorRedactor } from './txn/CommitErrorRedactor.js';
import { ConflictError } from './txn/ConflictError.js';
import type { ISnapshotHandle } from './txn/ConflictHistory.js';
import { ReadSet } from './txn/ReadSet.js';
import { TransactionDroppedError } from './txn/TransactionDroppedError.js';
import { type ICreateNodeOptions, type IDeleteNodeOptions, type LinkOptions, WriteBatch } from './txn/WriteBatch.js';

/**
 * A key of GraphTransaction.Fetch (ruling R121 F1): the public id, and for an id the engine stores no node of, the concept
 * (and optionally the owner model) to fetch it as. TODL ids are opaque to the engine: without Concept such an id is absent.
 */
export interface IFetchKey
{
    readonly PublicId: string;
    readonly Concept?: string;
    readonly Owner?: string;
}

/**
 * A node as GraphTransaction.Fetch returns it: the scoped view (hidden members removed, null for an unset property).
 * External is true for a row fetched from an External connector, whose Version is the source's version of the row the
 * transaction's session holds (R119 V1); an engine node has none.
 */
export interface IFetchedView extends INodeView
{
    readonly External: boolean;
    readonly Version?: RowVersion;
}

/**
 * An optimistic, serializable read-write transaction. Reads are snapshot reads at Begin and are
 * recorded (ruling R31), visibility reads under the transaction's AccessScope included; writes are
 * recorded as a WriteBatch and applied only by Commit.
 *
 * Reads do NOT see the transaction's own pending writes (no read-your-own-writes, as in the flow
 * language): every read answers from the snapshot taken at Begin. Commit fails with ConflictError when
 * anything read was changed by a commit after the snapshot, or the schema changed since Begin; with
 * AccessError when the transaction's AccessScope does not allow a write (checked first, nothing is
 * submitted; WriteGate); with CommitError when the writes are semantically invalid. Commit always ends
 * the transaction, whatever its outcome; retry on a new transaction. dispose() without Commit discards
 * the writes.
 *
 * When the store has connectors installed and the batch writes nodes bound to one (BindingTable), Commit
 * is a write-through (ruling R72): the engine prepares, every participating connector begins, applies
 * and commits, then the engine finalizes. Any connector failure, the timeout, or a failed Finalize
 * reverts every connector that began, leaves the engine unchanged and fails with ConnectorError.
 *
 * Writes to external nodes (ruling R103): with External connectors installed the transaction has one FetchSession
 * (design ruling D3), which its write queries read through. A node bound to an External connector (created with such an
 * owner and concept, a stored stub, or a row the transaction fetched) is written to that connector only, never to engine
 * storage. The commit decides such writes against the row the transaction fetched: a row it never fetched, or one its
 * scope does not admit, is AccessError InvisibleNode, as a missing engine node is. Fetched rows carry no conflict
 * detection (spec §6): only the engine reads are validated. A commit whose writes are all external makes no engine
 * commit and resolves with SnapshotCommit (ruling P13); every successful write-through raises ConnectorApplied.
 */
export class GraphTransaction extends GraphReader
{
    private static readonly ErrFinished = 'Transaction has already committed or been disposed';
    private static readonly ErrSchema = 'The schema changed after the transaction began: catalog version ';
    private static readonly ErrSchemaNow = ', now ';
    private static readonly ErrNoConnectors = 'CreateAssigned needs an external connector binding, and the store has no connectors installed';
    private static readonly ErrAssignedEngineOnly = 'CreateAssigned was asked to create a node that is not bound to an external connector: ';
    private static readonly ErrAssignedConcept = 'A source-assigned create returned a row of the wrong concept: ';
    private static readonly ErrAssignedDuplicate = 'A source-assigned create returned a public id that is already in use: ';
    private static readonly ErrOutcomeCount = 'A connector returned a different number of create outcomes than requests';
    private static readonly ErrNoRow = 'A source-assigned create outcome carried neither a row nor an error';
    /** The synthetic public id a CreateAssigned pre-flight check gives each request (the key is not yet known). */
    private static readonly AssignedProbe = '\u0001assigned\u0001';
    /** The empty read-only set (no member is read-only). */
    private static readonly NoReadOnly: ReadonlySet<string> = new Set();

    /** A UUID assigned at Begin; the TransactionDroppedError that reports a dropped transaction carries it (R137 E6). */
    public readonly Id: string = randomUUID();

    private readonly batch = new WriteBatch();
    /** The batch ops SetDefault and DetachUnlink recorded. */
    private readonly exempt = new WriteExemptions();
    private committing = false;
    /** Set once the transaction reached a terminal state (committed, aborted, compensated or dropped). */
    private ended = false;

    /** The engine's part of every step routed so far, concatenated: what Commit prepares (ruling R135 E2). */
    private readonly engineBatch = new WriteBatch();
    /** Per Mirrored connector, its changes staged across the steps, committed at Commit (name order at Run). */
    private readonly mirrored = new Map<string, ConnectorChange[]>();
    /** The persistent per-transaction router and write-through coordinator (created at the first step). */
    private router: StepRouter | undefined;
    private coordinator: WriteCoordinator | undefined;
    /** The transaction's version ledger (ruling R137 E5): shared by the router (read) and the coordinator (reported). */
    private ledger: VersionLedger | undefined;
    /** How many recorded ops have been routed into a step. */
    private flushedCount = 0;
    /** The number of external steps executed, assigned to each step for the step log. */
    private stepNumber = 0;

    /** @internal Created by GraphStore.Begin. */
    public constructor(context: GraphContext, snapshot: ReadSnapshot, scope: AccessScope, connector: ConnectorContext)
    {
        super(context, snapshot, scope, connector, new ReadSet());
    }

    public CreateNode(publicId: string, concept: string, options?: ICreateNodeOptions): void
    {
        this.RequireActive();
        this.batch.CreateNode(publicId, concept, options);
    }

    public SetProperty(publicId: string, member: string, value: CellValue): void
    {
        this.RequireActive();
        this.batch.SetProperty(publicId, member, value);
    }

    /**
     * Records a value the host places on a node this transaction created earlier (a placement default, ruling
     * R91). It BYPASSES the scope's Hidden and ReadOnly member rules for that write. The bypass holds only for a
     * node created earlier in this same transaction; on any other node SetDefault is checked exactly as
     * SetProperty. Otherwise it is SetProperty (same op, same commit).
     */
    public SetDefault(publicId: string, member: string, value: CellValue): void
    {
        this.RequireActive();
        const index = this.batch.Count;
        this.batch.SetProperty(publicId, member, value);
        this.exempt.Defaults.add(index);
    }

    /**
     * Deletes the node and every edge it has; with Strict the commit instead fails while any edge remains (CommitError
     * NodeHasEdges).
     */
    public DeleteNode(publicId: string, options?: IDeleteNodeOptions): void
    {
        this.RequireActive();
        this.batch.DeleteNode(publicId, options);
    }

    /**
     * The members the scope's write gate refuses to write on a node of `concept` at `stage` (ReadOnly for the stage
     * plus ReadOnlyExact; ruling R92); empty when the scope's writes are unrestricted. Scope metadata only:
     * nothing is read or recorded.
     */
    public ReadOnlyMembers(concept: string, stage: WriteStage): ReadonlySet<string>
    {
        return this.Scope.WritesUnrestricted ? GraphTransaction.NoReadOnly : this.WriteEvaluator().ReadOnlyMembers(concept, stage);
    }

    public Link(from: string, relationship: string, to: string, options?: LinkOptions): void
    {
        this.RequireActive();
        this.batch.Link(from, relationship, to, options);
    }

    public Unlink(from: string, relationship: string, to: string): void
    {
        this.RequireActive();
        this.batch.Unlink(from, relationship, to);
    }

    /**
     * Records an Unlink implied by deleting `from` or `to` later in this transaction (a Cypher DETACH DELETE,
     * ruling R92). It BYPASSES the scope's ReadOnly members, as the engine's own DeleteNode does for the edges it
     * removes: the Delete rule governs it. The bypass holds only when the transaction deletes one of the edge's
     * ends after it; otherwise it is checked exactly as Unlink. Otherwise it is Unlink (same op, same commit).
     */
    public DetachUnlink(from: string, relationship: string, to: string): void
    {
        this.RequireActive();
        const index = this.batch.Count;
        this.batch.Unlink(from, relationship, to);
        this.exempt.Detaches.add(index);
    }

    /**
     * The nodes of the keys as this transaction may see them (ruling R121 F1), keyed by public id; a key it may not see,
     * or cannot resolve, is absent. A string key is an IFetchKey without Concept. A stored engine node is read as ReadNode
     * reads it (External false). A stub, or an id with no stored node whose key names a Concept (and optionally an Owner),
     * is fetched from its External connector through the transaction's FetchSession, under the scope and memoised for the
     * transaction: the sanctioned fetch-before-write path, so a later write to a returned external node is decided
     * against that row (R103) and carries its Version as ExpectedVersion (R119 V2). An id the scope does not admit stays
     * unwritable (AccessError InvisibleNode). ReadNode still serves no stub data (P15).
     */
    public async Fetch(keys: readonly (string | IFetchKey)[]): Promise<ReadonlyMap<string, IFetchedView>>
    {
        this.RequireActive();
        const normalized = keys.map(key => typeof key === 'string' ? { PublicId: key } : key);
        return new TransactionFetch(this, FederatedReads.Of(this)).Resolve(normalized);
    }

    /**
     * Creates nodes whose keys the source assigns (ruling R136 E4), index-aligned with `requests`. It flushes the ops
     * recorded since the previous step, checks every request (R29; the gate's Create rules judged hypothetically; the
     * scope's Hidden and ReadOnly.Create members over the Properties and Links; the AppendTo of every existing link
     * target; the external schema checks), then groups the requests by binding connector and calls each connector's
     * Create once, in name order, as its own step. Each returned row is validated (FetchedNode.Validated); its concept
     * must be the request's, its id valid and neither a stored engine node's nor one the transaction created. A failed
     * check, an Error outcome, an outcome count that does not match, or an invalid row fails the step as ConnectorError
     * Write; the connector's Undo of that step compensates exactly the requests that produced a row, and the transaction
     * compensates and ends (ruling R137 E6). On success each row is remembered in the session and in the router as
     * created by this transaction (so later ops on its id route External and carry its Version as ExpectedVersion), and
     * the returned view carries the real public id, the id member and source defaults, and the Version.
     */
    public async CreateAssigned(requests: readonly IAssignedCreate[]): Promise<readonly IFetchedView[]>
    {
        this.RequireActive();
        try
        {
            return await this.AssignedCreates(requests);
        }
        catch (error)
        {
            throw await this.CompensateAndEnd(error);
        }
    }

    /** The body of CreateAssigned (ruling R136 E4), its failures compensated and the transaction ended by CreateAssigned. */
    private async AssignedCreates(requests: readonly IAssignedCreate[]): Promise<readonly IFetchedView[]>
    {
        const setup = this.context.Connectors;
        if (setup === undefined)
        {
            throw new GraphError(GraphErrorCode.Unsupported, GraphTransaction.ErrNoConnectors);
        }
        // Step 1: flush the ops recorded since the previous step.
        await this.FlushStep();
        this.EnsureRouter(setup);
        const catalog = this.snapshot.Index.Catalog;
        // Step 2: check every request before any connector call.
        await this.CheckAssigned(requests, setup);
        // Step 3: group by binding connector; one Create call per connector, in name order, each its own step.
        const groups = this.GroupAssigned(requests, setup, catalog);
        const accepted: { readonly Row: IFetchedRow; readonly Model: string; readonly Index: number }[] = [];
        for (const name of [...groups.keys()].sort())
        {
            const group = groups.get(name)!;
            this.stepNumber++;
            // Step 4/5: call Create, then map outcome i back to request i; a count mismatch is a connector error.
            const outcomes = await this.coordinator!.Create(name, group.map(g => g.Request), this.stepNumber);
            if (outcomes.length !== group.length)
            {
                throw new ConnectorError(name, ConnectorPhase.Write, new GraphError(GraphErrorCode.Internal, GraphTransaction.ErrOutcomeCount));
            }
            for (let k = 0; k < group.length; k++)
            {
                const member = group[k]!;
                accepted.push({ Row: await this.ValidateAssigned(name, member.Request, outcomes[k]!), Model: member.Request.Owner, Index: member.Index });
            }
        }
        // Register and build views only once every row passed, so a failed step registers nothing (it is compensated).
        const session = FederatedReads.Of(this).Session;
        const views = new Array<IFetchedView>(requests.length);
        for (const a of accepted)
        {
            this.router!.Created(a.Row.PublicId, { Owner: a.Model, Concept: a.Row.Concept });
            session?.Remember(a.Row, a.Model);
            if (a.Row.Version !== undefined)
            {
                this.ledger!.Reported(a.Row.PublicId, a.Row.Version);
            }
            views[a.Index] = await this.AssignedView(a.Row, a.Model);
        }
        return views;
    }

    /**
     * Checks every create request before any connector call (ruling R136 E4 step 2), over a synthetic batch whose
     * placeholder ids stand in until the source assigns the real ones: the gate's Create rules, Hidden, ReadOnly.Create
     * and the AppendTo of every existing link target (skipped when the scope restricts no write), then R29 and the
     * external schema checks on the properties and links (through a throwaway StepRouter, which runs ExternalWriteCheck).
     */
    private async CheckAssigned(requests: readonly IAssignedCreate[], setup: ConnectorSetup): Promise<void>
    {
        const synth = new WriteBatch();
        requests.forEach((request, index) =>
        {
            const id = GraphTransaction.AssignedProbe + index;
            synth.CreateNode(id, request.Concept, { Owner: request.Owner });
            for (const [member, value] of request.Properties)
            {
                synth.SetProperty(id, member, value);
            }
            for (const link of request.Links)
            {
                synth.Link(id, link.Relationship, link.To);
            }
        });
        if (!this.Scope.WritesUnrestricted)
        {
            await WriteGate.Check(this.WriteEvaluator(), synth, this.snapshot.Index.Catalog, WriteExemptions.None(), id => this.FetchedRow(id));
        }
        await new StepRouter(setup.Bindings, this.snapshot.Index, this.RoutingOrigins(), setup.External, new VersionLedger()).Route(synth.Ops());
    }

    /** Groups the requests by the connector their (Owner, Concept) binds to; a request bound to no connector is refused. */
    private GroupAssigned(requests: readonly IAssignedCreate[], setup: ConnectorSetup, catalog: CatalogSnapshot): Map<string, { readonly Request: IAssignedCreate; readonly Index: number }[]>
    {
        const groups = new Map<string, { readonly Request: IAssignedCreate; readonly Index: number }[]>();
        requests.forEach((request, index) =>
        {
            const name = setup.Bindings.Resolve(request.Owner, request.Concept, catalog);
            if (name === undefined || BindingTable.IsEngineOnly(name))
            {
                throw new ConnectorError(name ?? BindingTable.EngineStorage, ConnectorPhase.Write, new GraphError(GraphErrorCode.Unsupported, GraphTransaction.ErrAssignedEngineOnly + request.Concept));
            }
            let group = groups.get(name);
            if (group === undefined)
            {
                group = [];
                groups.set(name, group);
            }
            group.push({ Request: request, Index: index });
        });
        return groups;
    }

    /** Validates one create outcome (ruling R136 E4): an Error fails the step, and the row must pass FetchedNode.Validated, be of the request's concept, and own an id no engine node or earlier create holds. */
    private async ValidateAssigned(connector: string, request: IAssignedCreate, outcome: IAssignedOutcome): Promise<IFetchedRow>
    {
        if (outcome.Error !== undefined || outcome.Row === undefined)
        {
            throw new ConnectorError(connector, ConnectorPhase.Write, outcome.Error ?? new GraphError(GraphErrorCode.Internal, GraphTransaction.ErrNoRow));
        }
        let row: IFetchedRow;
        try
        {
            row = FetchedNode.Validated(this.snapshot.Index.Catalog, outcome.Row);
        }
        catch (cause)
        {
            throw new ConnectorError(connector, ConnectorPhase.Write, cause);
        }
        if (row.Concept !== request.Concept)
        {
            throw new ConnectorError(connector, ConnectorPhase.Write, new GraphError(GraphErrorCode.SchemaViolation, GraphTransaction.ErrAssignedConcept + row.Concept));
        }
        if ((await FederatedReads.Of(this).StoredNonStub(row.PublicId)) || this.router!.IsCreated(row.PublicId))
        {
            throw new ConnectorError(connector, ConnectorPhase.Write, new CommitError(CommitErrorCode.DuplicatePublicId, GraphTransaction.ErrAssignedDuplicate + row.PublicId));
        }
        return row;
    }

    /** The view of a source-assigned created row: its real public id, scoped properties, External true and the Version. */
    private async AssignedView(row: IFetchedRow, model: string): Promise<IFetchedView>
    {
        return {
            PublicId: row.PublicId,
            Concept: row.Concept,
            Owner: model,
            Properties: await this.ScopedProperties(row.Concept, def => row.Values.get(def.Name)),
            External: true,
            ...(row.Version === undefined ? {} : { Version: row.Version }),
        };
    }

    /**
     * Executes, as one write step, the ops recorded since the previous step (ruling R135 E1): the step's writes to
     * External connectors run now (routed one connector at a time in name order), its Mirrored writes stage until
     * Commit, and its engine ops join the transaction's engine batch. The write gate and R29 are judged over the
     * step, before any connector call; a denial or a connector failure fails the step. A caller that wants a prior
     * API call's external effect calls Flush after it; a writer that only commits never needs it.
     */
    public async Flush(): Promise<void>
    {
        this.RequireActive();
        try
        {
            await this.FlushStep();
        }
        catch (error)
        {
            // Any step failure (connector throw, version conflict, timeout, gate denial after earlier steps) compensates
            // the executed steps and ends the transaction (ruling R137 E6); later calls are GraphError Disposed.
            throw await this.CompensateAndEnd(error);
        }
    }

    /**
     * Aborts the transaction (ruling R137 E6): compensates the external steps it executed, in reverse order (Mirrored
     * reverted first in reverse Begin order, then the step log walked in reverse), raises ConnectorApplied with
     * Outcome Compensated (or CompensationFailed), and ends it. Resolves whatever compensation's outcome; a failed
     * compensation surfaces on ConnectorRevertFailed, not as a rejection here.
     */
    public async Abort(): Promise<void>
    {
        this.RequireActive();
        this.ended = true;
        this.committing = true;
        try
        {
            if (this.coordinator !== undefined)
            {
                await this.coordinator.Compensate(undefined);
            }
        }
        finally
        {
            super.dispose();
        }
    }

    /**
     * Commits the recorded writes; resolves with the commit number. Ends the transaction. A
     * transaction that recorded no writes commits nothing: after the schema check it resolves with its
     * SnapshotCommit, consumes no commit number and raises no CommitApplied (its reads need no
     * validation, being a consistent snapshot).
     */
    public async Commit(): Promise<bigint>
    {
        this.RequireActive();
        this.committing = true;
        try
        {
            const began = this.RequireCatalog();
            // A transaction that executed external steps (CreateAssigned, Flush) still finalizes them, even when it
            // recorded nothing in its engine batch (ruling R136 E4, P13): only a truly empty transaction short-circuits.
            if (this.batch.Count === 0 && this.ExecutedSteps === 0)
            {
                return this.SnapshotCommit;
            }
            // Read together: the committer rejects the batch if the setup it was routed with is replaced (R77).
            const setup = this.context.Connectors;
            const generation = this.context.Committer.BindingGeneration;
            if (setup === undefined)
            {
                await this.Authorize(0);
                return await this.context.Committer.Submit(this.batch, this.Reads, this.ValidationCommit(), began, generation);
            }
            // The final flush executes the remaining external ops as the last step, before anything else (R135 E1).
            await this.FlushStep();
            if (this.coordinator === undefined || (!this.coordinator.Participated && this.mirrored.size === 0))
            {
                // No connector took part: a plain engine submit of the routed engine ops.
                return await this.context.Committer.Submit(this.engineBatch, this.Reads, this.ValidationCommit(), began, generation);
            }
            const prepare = () => this.context.Committer.Prepare(this.engineBatch, this.Reads, this.ValidationCommit(), began, setup.TimeoutMs, generation);
            // An all-external write makes no engine commit (controller ruling P13): it answers like an empty batch.
            const unchanged = this.engineBatch.Count === 0 ? this.SnapshotCommit : undefined;
            return await this.coordinator.Run(prepare, this.mirrored, unchanged);
        }
        catch (error)
        {
            // A commit failure with external steps already executed compensates them (ruling R137 E6). Under a
            // read-restricting scope commit errors are then reduced to "something conflicts" (security S2, R131).
            const mapped = await this.CompensateAndEnd(error);
            throw this.Scope.ReadsUnrestricted ? mapped : CommitErrorRedactor.RedactAny(mapped);
        }
        finally
        {
            // Only now: the registered snapshot must pin conflict history until the batch was validated. The internal,
            // non-throwing end: a committed or compensated-by-failure transaction is never dropped (ruling R137 E6).
            this.End();
        }
    }

    /**
     * The catalog version the transaction began with, when it is still current. Early check, so the gate
     * never judges writes against a schema that has since changed; the authoritative check is still inside
     * the commit group against the group's catalog (ruling F4).
     */
    private RequireCatalog(): number
    {
        const began = this.snapshot.Index.Catalog.Version;
        if (began !== this.context.CatalogVersion)
        {
            throw new ConflictError(GraphTransaction.ErrSchema + began + GraphTransaction.ErrSchemaNow + this.context.CatalogVersion);
        }
        return began;
    }

    /**
     * The write gate (ruling R68): throws AccessError when the scope does not allow a recorded write.
     * Runs before anything leaves the transaction (Submit, or the write-through's Prepare), so a denied commit consumes
     * no commit number and raises no CommitApplied. Its reads land in this transaction's ReadSet. A
     * denial decided on reads a later commit changed is a ConflictError instead (ruling R70): a retry may
     * be allowed. A scope that restricts nothing (System) skips it at no cost.
     */
    private async Authorize(from: number): Promise<void>
    {
        if (this.Scope.WritesUnrestricted)
        {
            return;
        }
        try
        {
            await WriteGate.Check(this.WriteEvaluator(), this.batch, this.snapshot.Index.Catalog, this.exempt, id => this.FetchedRow(id), from);
        }
        catch (error)
        {
            if (error instanceof AccessError)
            {
                throw this.context.Committer.CheckReads(this.Reads, this.ValidationCommit()) ?? error;
            }
            throw error;
        }
    }

    /**
     * Routes and executes the ops recorded since the previous step (ruling R135 E2). Routing reads the snapshot
     * unscoped and records it like any read (rulings R72, R89); a node that is not stored routes by the row this
     * transaction fetched (R103), and a fetched row's version is its changes' ExpectedVersion (R119 V2). Nothing to
     * route (no connectors installed, or every op already flushed) is a no-op.
     */
    private async FlushStep(): Promise<void>
    {
        const setup = this.context.Connectors;
        if (setup === undefined)
        {
            return;
        }
        const ops = this.batch.Ops();
        if (this.flushedCount >= ops.length)
        {
            return;
        }
        this.EnsureRouter(setup);
        const from = this.flushedCount;
        // The write gate runs per step, over this step's ops, before any connector call (ruling R135 E2).
        await this.Authorize(from);
        const step = await this.router!.Route(ops.slice(from));
        for (const op of step.Engine)
        {
            this.engineBatch.Append(op);
        }
        for (const [name, changes] of step.Mirrored)
        {
            const existing = this.mirrored.get(name);
            if (existing === undefined)
            {
                this.mirrored.set(name, [...changes]);
            }
            else
            {
                existing.push(...changes);
            }
        }
        if (step.External.size > 0)
        {
            this.stepNumber++;
            await this.coordinator!.Step(step.External, this.stepNumber);
        }
        // Advanced only after the whole step succeeded: a failed step leaves no ops marked flushed (ruling R137 E6).
        this.flushedCount = ops.length;
    }

    /** Creates the persistent router, coordinator and version ledger on the first step; all serve this transaction only (ruling E11). */
    private EnsureRouter(setup: ConnectorSetup): void
    {
        if (this.router !== undefined)
        {
            return;
        }
        this.ledger = new VersionLedger();
        this.router = new StepRouter(setup.Bindings, this.snapshot.Index, this.RoutingOrigins(), setup.External, this.ledger);
        this.coordinator = new WriteCoordinator(setup, this.context.ConnectorRevertFailed, this.context.ConnectorApplied, this.Connector, this.ledger);
    }

    /** Where routing looks up the nodes a step does not create: the snapshot, else the rows the transaction fetched. */
    private RoutingOrigins(): INodeOrigins
    {
        return {
            Origin: id => this.RoutingOrigin(id),
            Edges: id => this.NodeEdges(id),
            Version: id => FederatedReads.Of(this).OpenSession?.Known(id)?.Row.Version,
        };
    }

    /** The row this transaction's FetchSession holds for the id, as a FetchedNode of its model; undefined when none. */
    private async FetchedRow(publicId: string): Promise<FetchedNode | undefined>
    {
        const channel = FederatedReads.Of(this);
        const known = channel.OpenSession?.Known(publicId);
        return known === undefined ? undefined : channel.FetchedNodeOf(known.Row, known.Model);
    }

    /** The stored node's origin (NodeOrigin), else that of the row this transaction fetched for the id. */
    private async RoutingOrigin(publicId: string): Promise<INodeOrigin | undefined>
    {
        const stored = await this.NodeOrigin(publicId);
        if (stored !== undefined)
        {
            return stored;
        }
        const known = FederatedReads.Of(this).OpenSession?.Known(publicId);
        return known === undefined ? undefined : { Owner: known.Model, Concept: known.Row.Concept, Fetched: true };
    }

    /** Always set: the constructor hands the reader a ReadSet. */
    protected override get Reads(): ReadSet
    {
        return super.Reads as ReadSet;
    }

    /**
     * The commit the reads are validated from. The KV snapshot's own last commit, unless the committer
     * has not yet recorded it (a group whose store write just landed): then the registered commit,
     * which is older and so only ever more conservative.
     */
    private ValidationCommit(): bigint
    {
        // A transaction's snapshot always carries a registration (GraphStore.Begin opens it with register = true).
        const registered = (this.snapshot.Handle as ISnapshotHandle).Commit;
        return this.snapshot.Commit <= this.context.Committer.LastCommit() ? this.snapshot.Commit : registered;
    }

    /**
     * Ends the transaction (ruling R137 E6). Not dropped (committed, aborted, already ended, or no external step
     * executed): disposes and resolves. Dropped (external steps executed, never committed or aborted): compensates,
     * raises ConnectorApplied with the outcome and GraphEngine.TransactionDropped, then rejects with
     * TransactionDroppedError, its Outcome set. Also [Symbol.asyncDispose]. This is the primary teardown path.
     */
    public async DisposeAsync(): Promise<void>
    {
        if (this.ended || this.ExecutedSteps === 0)
        {
            this.End();
            return;
        }
        this.ended = true;
        const steps = this.ExecutedSteps;
        const outcome = (await this.coordinator!.Compensate(undefined)).Outcome;
        super.dispose();
        const error = new TransactionDroppedError(this.Id, steps, Promise.resolve(outcome), outcome);
        this.RaiseDropped(error);
        throw error;
    }

    public [Symbol.asyncDispose](): Promise<void>
    {
        return this.DisposeAsync();
    }

    /**
     * Releases the transaction (ruling R137 E6). Not dropped: as GraphReader.dispose, and does not throw. Dropped:
     * marks the transaction ended, starts the same compensation detached, and throws synchronously a
     * TransactionDroppedError whose Outcome is undefined and whose Compensation settles later; ConnectorApplied and
     * GraphEngine.TransactionDropped are raised when compensation completes.
     */
    public override dispose(): void
    {
        if (this.ended || this.ExecutedSteps === 0)
        {
            this.End();
            return;
        }
        this.ended = true;
        const steps = this.ExecutedSteps;
        const compensation = this.coordinator!.Compensate(undefined).then(r => r.Outcome);
        super.dispose();
        const error = new TransactionDroppedError(this.Id, steps, compensation, undefined);
        void compensation.then(() => this.RaiseDropped(error), () => this.RaiseDropped(error));
        throw error;
    }

    /**
     * @internal Ends a still-open transaction at store dispose (ruling R137 E6): as the dropped path, but it compensates
     * and raises TransactionDropped without throwing, so store shutdown finishes.
     */
    public async Drop(): Promise<void>
    {
        if (this.ended || this.ExecutedSteps === 0)
        {
            this.End();
            return;
        }
        this.ended = true;
        const steps = this.ExecutedSteps;
        const outcome = (await this.coordinator!.Compensate(undefined)).Outcome;
        super.dispose();
        this.RaiseDropped(new TransactionDroppedError(this.Id, steps, Promise.resolve(outcome), outcome));
    }

    /** The number of external steps this transaction executed (ruling R137 E6). */
    private get ExecutedSteps(): number
    {
        return this.coordinator?.ExecutedSteps ?? 0;
    }

    /** Compensates the executed steps (when a connector took part) and ends the transaction; returns the error to throw. */
    private async CompensateAndEnd(error: unknown): Promise<unknown>
    {
        this.ended = true;
        this.committing = true;
        let mapped = error;
        if (this.coordinator !== undefined)
        {
            // Compensate reverts whatever began (a no-op when nothing did) and raises ConnectorApplied only when a
            // connector actually took part (ruling R137 E6, R138 E7).
            mapped = (await this.coordinator.Compensate(error)).Error;
        }
        super.dispose();
        return mapped;
    }

    /** The internal, non-throwing end used by Commit and the not-dropped teardown paths. */
    private End(): void
    {
        this.ended = true;
        super.dispose();
    }

    /** Raises GraphEngine.TransactionDropped once per dropped transaction; a throwing subscriber is ignored. */
    private RaiseDropped(error: TransactionDroppedError): void
    {
        try
        {
            this.context.TransactionDropped.Raise(error);
        }
        catch
        {
            // A throwing subscriber cannot un-drop the transaction; Signal already ran (and aggregated) every handler.
        }
    }

    private RequireActive(): void
    {
        this.RequireOpen();
        if (this.committing)
        {
            throw new GraphError(GraphErrorCode.Disposed, GraphTransaction.ErrFinished);
        }
    }
}
