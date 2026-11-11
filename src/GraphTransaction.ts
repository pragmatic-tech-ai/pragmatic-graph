import type { AccessScope } from './access/AccessScope.js';
import { AccessError } from './access/AccessError.js';
import { WriteExemptions } from './access/WriteExemptions.js';
import type { FetchedNode } from './access/FetchedNode.js';
import { ScopeEvaluator } from './access/ScopeEvaluator.js';
import { WriteGate } from './access/WriteGate.js';
import type { WriteStage } from './access/WriteStage.js';
import type { CellValue } from './columns/CellValue.js';
import { type INodeOrigin, type INodeOrigins, WriteCoordinator } from './connectors/WriteCoordinator.js';
import type { GraphContext, ReadSnapshot } from './GraphContext.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import { FederatedReads } from './FederatedReads.js';
import { GraphReader } from './GraphReader.js';
import { CommitErrorRedactor } from './txn/CommitErrorRedactor.js';
import { ConflictError } from './txn/ConflictError.js';
import type { ISnapshotHandle } from './txn/ConflictHistory.js';
import { ReadSet } from './txn/ReadSet.js';
import { type ICreateNodeOptions, type IDeleteNodeOptions, type LinkOptions, WriteBatch } from './txn/WriteBatch.js';
import type { ConnectorContext } from './connectors/ConnectorContext.js';

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

    private readonly batch = new WriteBatch();
    /** The batch ops SetDefault and DetachUnlink recorded. */
    private readonly exempt = new WriteExemptions();
    private committing = false;

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
        return this.Scope.WritesUnrestricted ? ScopeEvaluator.NoReadOnly : this.WriteEvaluator().ReadOnlyMembers(concept, stage);
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
            if (this.batch.Count === 0)
            {
                return this.SnapshotCommit;
            }
            await this.Authorize();
            // Read together: the committer rejects the batch if the setup it was routed with is replaced (R77).
            const setup = this.context.Connectors;
            const generation = this.context.Committer.BindingGeneration;
            if (setup !== undefined)
            {
                // Routing reads the snapshot unscoped and records it like any read (rulings R72, R89); a node that is not
                // stored routes by the row this transaction fetched (R103).
                const origins: INodeOrigins = { Origin: id => this.RoutingOrigin(id), Edges: id => this.NodeEdges(id) };
                const routed = await WriteCoordinator.Route(this.batch, setup.Bindings, this.snapshot.Index, origins, setup.External);
                if (routed.Sets.size > 0)
                {
                    const prepare = () => this.context.Committer.Prepare(routed.Engine, this.Reads, this.ValidationCommit(), began, setup.TimeoutMs, generation);
                    // An all-external write makes no engine commit (controller ruling P13): it answers like an empty batch.
                    const unchanged = routed.Engine.Count === 0 ? this.SnapshotCommit : undefined;
                    return await new WriteCoordinator(setup, this.context.ConnectorRevertFailed, this.context.ConnectorApplied, this.Connector).Run(prepare, routed.Sets, unchanged);
                }
                return await this.context.Committer.Submit(routed.Engine, this.Reads, this.ValidationCommit(), began, generation);
            }
            return await this.context.Committer.Submit(this.batch, this.Reads, this.ValidationCommit(), began, generation);
        }
        catch (error)
        {
            // Under a read-restricting scope commit errors are reduced to "something conflicts" (security S2, R131).
            throw this.Scope.ReadsUnrestricted ? error : CommitErrorRedactor.RedactAny(error);
        }
        finally
        {
            // Only now: the registered snapshot must pin conflict history until the batch was validated.
            this.dispose();
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
    private async Authorize(): Promise<void>
    {
        if (this.Scope.WritesUnrestricted)
        {
            return;
        }
        try
        {
            await WriteGate.Check(this.WriteEvaluator(), this.batch, this.snapshot.Index.Catalog, this.exempt, id => this.FetchedRow(id));
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

    private RequireActive(): void
    {
        this.RequireOpen();
        if (this.committing)
        {
            throw new GraphError(GraphErrorCode.Disposed, GraphTransaction.ErrFinished);
        }
    }
}
