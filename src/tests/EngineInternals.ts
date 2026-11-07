import type { ColumnStore } from '../columns/ColumnStore.js';
import type { EdgeStore } from '../edges/EdgeStore.js';
import type { GraphContext } from '../GraphContext.js';
import type { GraphStore } from '../GraphStore.js';
import type { GraphTransaction } from '../GraphTransaction.js';
import type { PublicIdIndex } from '../identity/PublicIdIndex.js';
import type { RowIndex } from '../identity/RowIndex.js';
import type { IndexStore } from '../indexes/IndexStore.js';
import type { DataPurger } from '../schema/DataPurger.js';
import type { Committer } from '../txn/Committer.js';
import type { PreparedCommit } from '../txn/PreparedCommit.js';
import type { ReadSet } from '../txn/ReadSet.js';
import type { WriteBatch } from '../txn/WriteBatch.js';

/** The committer's private building blocks (the purger is replaceable: the purge test seam, ruling R52). */
export interface ICommitterInternals
{
    purger: DataPurger;
    readonly columns: ColumnStore;
    readonly edges: EdgeStore;
    readonly rows: RowIndex;
    readonly ids: PublicIdIndex;
    readonly indexes: IndexStore;
}

/** The private members of a GraphTransaction that the engine side of a write-through uses. */
interface ITransactionInternals
{
    committing: boolean;
    readonly batch: WriteBatch;
    readonly context: GraphContext;
    readonly Reads: ReadSet;
    RequireActive(): void;
    RequireCatalog(): number;
    Authorize(): Promise<void>;
    ValidationCommit(): bigint;
    dispose(): void;
}

/**
 * Test-only access to engine internals: the one place tests reach past the public API (never exported
 * from src/index.ts, excluded from the build with every tests/ folder). Every cast lives here, so a
 * renamed private member breaks one file.
 */
export class EngineInternals
{
    /** The store's internal context. */
    public static Context(store: GraphStore): GraphContext
    {
        return (store as unknown as { context: GraphContext }).context;
    }

    /** The store's committer. */
    public static Committer(store: GraphStore): Committer
    {
        return EngineInternals.Context(store).Committer;
    }

    /** The committer's private building blocks. */
    public static CommitterParts(store: GraphStore): ICommitterInternals
    {
        return EngineInternals.Committer(store) as unknown as ICommitterInternals;
    }

    /** A transaction's recorded read set (protected on GraphReader). */
    public static Reads(transaction: GraphTransaction): ReadSet
    {
        return (transaction as unknown as ITransactionInternals).Reads;
    }

    /**
     * The engine side of a write-through without connectors (ruling R71): the transaction's schema check
     * and write gate, then Committer.Prepare on its recorded writes and read set. Ends the transaction
     * like Commit. An empty batch is prepared too (its reads stay reserved until Finalize).
     */
    public static async Prepare(transaction: GraphTransaction, timeoutMs?: number): Promise<PreparedCommit>
    {
        const t = transaction as unknown as ITransactionInternals;
        t.RequireActive();
        t.committing = true;
        try
        {
            const began = t.RequireCatalog();
            await t.Authorize();
            return await t.context.Committer.Prepare(t.batch, t.Reads, t.ValidationCommit(), began, timeoutMs);
        }
        finally
        {
            t.dispose();
        }
    }
}
