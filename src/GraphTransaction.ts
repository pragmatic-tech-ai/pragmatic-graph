import type { CellValue } from './columns/CellValue.js';
import type { GraphContext, ReadSnapshot } from './GraphContext.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import { GraphReader } from './GraphReader.js';
import { ConflictError } from './txn/ConflictError.js';
import type { ISnapshotHandle } from './txn/ConflictHistory.js';
import { ReadSet } from './txn/ReadSet.js';
import { type LinkOptions, WriteBatch } from './txn/WriteBatch.js';

/**
 * An optimistic, serializable read-write transaction. Reads are snapshot reads at Begin and are
 * recorded (ruling R31); writes are recorded as a WriteBatch and applied only by Commit.
 *
 * Reads do NOT see the transaction's own pending writes (no read-your-own-writes, as in the flow
 * language): every read answers from the snapshot taken at Begin. Commit fails with ConflictError when
 * anything read was changed by a commit after the snapshot, or the schema changed since Begin; with
 * CommitError when the writes are semantically invalid. Commit always ends the transaction, whatever
 * its outcome; retry on a new transaction. dispose() without Commit discards the writes.
 */
export class GraphTransaction extends GraphReader
{
    private static readonly ErrFinished = 'Transaction has already committed or been disposed';
    private static readonly ErrSchema = 'The schema changed after the transaction began: catalog version ';
    private static readonly ErrSchemaNow = ', now ';

    private readonly batch = new WriteBatch();
    private readonly reads = new ReadSet();
    private committing = false;

    /** @internal Created by GraphStore.Begin. */
    public constructor(context: GraphContext, snapshot: ReadSnapshot)
    {
        super(context, snapshot);
    }

    public CreateNode(publicId: string, concept: string, clusterHint?: string): void
    {
        this.RequireActive();
        this.batch.CreateNode(publicId, concept, clusterHint);
    }

    public SetProperty(publicId: string, member: string, value: CellValue): void
    {
        this.RequireActive();
        this.batch.SetProperty(publicId, member, value);
    }

    public DeleteNode(publicId: string): void
    {
        this.RequireActive();
        this.batch.DeleteNode(publicId);
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
            const began = this.snapshot.Index.Catalog.Version;
            if (began !== this.context.CatalogVersion)
            {
                throw new ConflictError(GraphTransaction.ErrSchema + began + GraphTransaction.ErrSchemaNow + this.context.CatalogVersion);
            }
            if (this.batch.Count === 0)
            {
                return this.SnapshotCommit;
            }
            return await this.context.Committer.Submit(this.batch, this.reads, this.ValidationCommit());
        }
        finally
        {
            // Only now: the registered snapshot must pin conflict history until the batch was validated.
            this.dispose();
        }
    }

    protected override get Reads(): ReadSet
    {
        return this.reads;
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
