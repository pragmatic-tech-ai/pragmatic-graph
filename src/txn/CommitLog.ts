import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { TupleCodec } from '../format/TupleCodec.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { type ICommitApplied, LogEntry } from './LogEntry.js';

/**
 * The commit log: Log(commit) = a LogEntry (a batch with its catalog version and created ids, or a
 * schema change with the resulting catalog), commits gap-free from 1, and Meta("commit") = the last
 * commit number (absent = 0). Written only by the Committer inside its Writes; readable from any
 * snapshot as an ordered, self-sufficient changefeed (ruling F4).
 */
export class CommitLog
{
    private static readonly CommitName = 'commit';
    private static readonly ErrCorrupt = 'Corrupt Meta("commit") value';
    /** Above every tuple-encoded integer key (integer type codes end at 0x1C). */
    private static readonly LogEnd = Uint8Array.of(0xff);

    public static async ReadLastCommit(txn: IReadTransaction): Promise<bigint>
    {
        const raw = await txn.Get(Keyspace.Meta, FormatKeys.Meta(CommitLog.CommitName));
        if (raw === undefined)
        {
            return 0n;
        }
        const parts = TupleCodec.Decode(raw);
        const value = parts[0];
        if (parts.length !== 1 || typeof value !== 'bigint' || value < 0n)
        {
            throw new GraphError(GraphErrorCode.Corrupt, CommitLog.ErrCorrupt);
        }
        return value;
    }

    /** Appends an encoded LogEntry. The caller writes commits consecutively and then calls WriteLastCommit once. */
    public Append(txn: IWriteTransaction, commit: bigint, entry: Uint8Array): void
    {
        txn.Put(Keyspace.Log, FormatKeys.LogEntry(commit), entry);
    }

    public WriteLastCommit(txn: IWriteTransaction, commit: bigint): void
    {
        txn.Put(Keyspace.Meta, FormatKeys.Meta(CommitLog.CommitName), TupleCodec.Encode([commit]));
    }

    public async Read(txn: IReadTransaction, commit: bigint): Promise<ICommitApplied | undefined>
    {
        const raw = await txn.Get(Keyspace.Log, FormatKeys.LogEntry(commit));
        return raw === undefined ? undefined : LogEntry.Decode(commit, raw);
    }

    /** Entries with Commit > after, in commit order. */
    public async *Scan(txn: IReadTransaction, after: bigint): AsyncIterable<ICommitApplied>
    {
        const range = { Start: FormatKeys.LogEntry(after + 1n), End: CommitLog.LogEnd };
        for await (const [key, value] of txn.Scan(Keyspace.Log, range))
        {
            yield LogEntry.Decode(TupleCodec.Decode(key)[0] as bigint, value);
        }
    }
}
