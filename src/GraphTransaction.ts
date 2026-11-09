import type { AccessScope } from './access/AccessScope.js';
import { AccessError } from './access/AccessError.js';
import { WriteGate } from './access/WriteGate.js';
import type { CellValue } from './columns/CellValue.js';
import { type INodeOrigins, WriteCoordinator } from './connectors/WriteCoordinator.js';
import type { GraphContext, ReadSnapshot } from './GraphContext.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import { GraphReader } from './GraphReader.js';
import { ConflictError } from './txn/ConflictError.js';
import type { ISnapshotHandle } from './txn/ConflictHistory.js';
import { ReadSet } from './txn/ReadSet.js';
import { type ICreateNodeOptions, type IDeleteNodeOptions, type LinkOptions, WriteBatch } from './txn/WriteBatch.js';

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
 */
export class GraphTransaction extends GraphReader
{
    private static readonly ErrFinished = 'Transaction has already committed or been disposed';
    private static readonly ErrSchema = 'The schema changed after the transaction began: catalog version ';
    private static readonly ErrSchemaNow = ', now ';

    private readonly batch = new WriteBatch();
    private committing = false;

    /** @internal Created by GraphStore.Begin. */
    public constructor(context: GraphContext, snapshot: ReadSnapshot, scope: AccessScope)
    {
        super(context, snapshot, scope, new ReadSet());
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
     * Deletes the node and every edge it has; with Strict the commit instead fails while any edge remains (CommitError
     * NodeHasEdges).
     */
    public DeleteNode(publicId: string, options?: IDeleteNodeOptions): void
    {
        this.RequireActive();
        this.batch.DeleteNode(publicId, options);
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
                // Routing reads the snapshot unscoped and records it like any read (ruling R72).
                const origins: INodeOrigins = { Origin: id => this.NodeOrigin(id) };
                const sets = await WriteCoordinator.Route(this.batch, setup.Bindings, this.snapshot.Index.Catalog, origins);
                if (sets.size > 0)
                {
                    const prepare = () => this.context.Committer.Prepare(this.batch, this.Reads, this.ValidationCommit(), began, setup.TimeoutMs, generation);
                    return await new WriteCoordinator(setup, this.context.ConnectorRevertFailed).Run(prepare, sets);
                }
            }
            return await this.context.Committer.Submit(this.batch, this.Reads, this.ValidationCommit(), began, generation);
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
            await WriteGate.Check(this.WriteEvaluator(), this.batch, this.snapshot.Index.Catalog);
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
