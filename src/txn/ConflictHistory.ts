import { ConflictError } from './ConflictError.js';
import type { ReadSet } from './ReadSet.js';
import type { WriteKeySet } from './WriteKeySet.js';

/** A registered snapshot: pins conflict history back to Commit until disposed. dispose() is idempotent. */
export interface ISnapshotHandle
{
    readonly Commit: bigint;
    dispose(): void;
}

interface IHistoryEntry
{
    readonly Commit: bigint;
    readonly Keys: WriteKeySet;
}

/**
 * Committed write-key sets kept in memory for read-set validation (FoundationDB-resolver style,
 * ruling R24). The retained window is (Floor, Last]: every commit after Floor still has its write set.
 * Floor follows the oldest registered snapshot; with none registered only the latest commit is kept.
 * A read set validated against a snapshot below Floor cannot be checked and is a conflict.
 */
export class ConflictHistory
{
    private static readonly ErrTooOld = 'Snapshot is older than the retained conflict window: ';
    private static readonly ErrConflict = 'Read set conflicts with commit ';
    private static readonly ErrAfter = ' (snapshot ';
    private static readonly ErrClose = ')';

    private readonly entries: IHistoryEntry[] = [];
    private readonly registered = new Map<number, bigint>();
    private nextHandle = 0;
    private last: bigint;
    private floor: bigint;

    public constructor(lastCommit: bigint)
    {
        this.last = lastCommit;
        this.floor = lastCommit;
    }

    public get Last(): bigint
    {
        return this.last;
    }

    /** Commits after Floor have retained write sets. */
    public get Floor(): bigint
    {
        return this.floor;
    }

    public Register(): ISnapshotHandle
    {
        const handle = this.nextHandle++;
        const commit = this.last;
        this.registered.set(handle, commit);
        return {
            Commit: commit,
            dispose: () =>
            {
                if (this.registered.delete(handle))
                {
                    this.Prune();
                }
            },
        };
    }

    /**
     * The conflict for `reads` taken at `snapshot` against commits after it, or undefined. An empty
     * read set never conflicts (there is nothing to invalidate), even when its snapshot is too old.
     */
    public Check(reads: ReadSet, snapshot: bigint): ConflictError | undefined
    {
        if (reads.IsEmpty)
        {
            return undefined;
        }
        if (snapshot < this.floor)
        {
            return new ConflictError(ConflictHistory.ErrTooOld + snapshot);
        }
        for (const entry of this.entries)
        {
            if (entry.Commit > snapshot && entry.Keys.Intersects(reads))
            {
                return new ConflictError(ConflictHistory.ErrConflict + entry.Commit + ConflictHistory.ErrAfter + snapshot + ConflictHistory.ErrClose);
            }
        }
        return undefined;
    }

    /** Records the next commit (Last + 1) with its write set. */
    public Record(commit: bigint, keys: WriteKeySet): void
    {
        this.last = commit;
        this.entries.push({ Commit: commit, Keys: keys });
    }

    /** Drops write sets no registered snapshot (and not the latest commit) needs any more. */
    public Prune(): void
    {
        let target = this.last - 1n;
        for (const commit of this.registered.values())
        {
            if (commit < target)
            {
                target = commit;
            }
        }
        if (target > this.floor)
        {
            this.floor = target;
        }
        let drop = 0;
        while (drop < this.entries.length && this.entries[drop]!.Commit <= this.floor)
        {
            drop++;
        }
        this.entries.splice(0, drop);
    }
}
