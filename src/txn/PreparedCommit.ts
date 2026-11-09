import type { Committer } from './Committer.js';
import type { Reservation } from './Reservations.js';
import type { WriteBatch } from './WriteBatch.js';

/**
 * A batch the committer validated and dry-ran but did not apply (Committer.Prepare, ruling R71). Its
 * reservation keeps every other commit off the keys the batch read, depends on and writes, so Finalize
 * cannot fail on a conflict while the reservation holds and the catalog is unchanged; it can still fail
 * on storage trouble, on disposal, or (ConflictError) on a schema change, upgrade or binding change since Prepare.
 * Finalize after Abort or expiry is a ConflictError. Settle it promptly: until then the reserved keys
 * conflict for everyone else.
 */
export class PreparedCommit
{
    /** @internal Created by Committer.Prepare. */
    public constructor(
        private readonly committer: Committer,
        /** The sealed batch that Finalize commits. */
        public readonly Batch: WriteBatch,
        /** @internal The batch as serialized at Prepare (the log entry's payload). */
        public readonly Bytes: Uint8Array,
        /** @internal The internal ids allocated at Prepare, reused by Finalize (ruling R16). */
        public readonly Ids: readonly bigint[],
        /** @internal The catalog version the dry-run ran against; Finalize requires it unchanged. */
        public readonly CatalogVersion: number,
        /** @internal */
        public readonly Reservation: Reservation,
        /**
         * @internal The connector-setup generation the batch was routed with; Finalize requires it unchanged (ruling
         * R77).
         */
        public readonly BindingGeneration?: number,
    )
    {
    }

    /** True once the reservation's deadline passed before Finalize was called. */
    public get Expired(): boolean
    {
        return this.Reservation.Expired;
    }

    /**
     * Commits the prepared batch through the normal group path, with the ids allocated at Prepare;
     * resolves with its commit number (CommitApplied is raised then, once) and releases the reservation.
     */
    public Finalize(): Promise<bigint>
    {
        return this.committer.SubmitPrepared(this);
    }

    /** Releases the reservation without committing; a no-op once Finalize was called or it ended. */
    public Abort(): void
    {
        this.Reservation.Abort();
    }
}
