import { Keyspace } from '../kv/Keyspace.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { FormatKeys } from './FormatKeys.js';
import { TupleCodec } from './TupleCodec.js';

export class FormatVersionMismatchError extends Error
{
    public constructor(public readonly Found: bigint | undefined, public readonly Expected: bigint)
    {
        super(`Unsupported on-disk format version: found ${Found === undefined ? 'none' : String(Found)}, expected ${String(Expected)}`);
        this.name = 'FormatVersionMismatchError';
    }
}

/** Writes and checks the format version stored under Meta("format") as a TupleCodec-encoded integer. */
export class FormatMeta
{
    public static readonly CurrentVersion = 1n;
    private static readonly FormatKeyName = 'format';

    public static async Initialize(txn: IWriteTransaction): Promise<void>
    {
        txn.Put(Keyspace.Meta, FormatKeys.Meta(FormatMeta.FormatKeyName), TupleCodec.Encode([FormatMeta.CurrentVersion]));
    }

    public static async Verify(txn: IReadTransaction): Promise<void>
    {
        const raw = await txn.Get(Keyspace.Meta, FormatKeys.Meta(FormatMeta.FormatKeyName));
        let found: bigint | undefined;
        if (raw !== undefined)
        {
            const decoded = TupleCodec.Decode(raw);
            found = typeof decoded[0] === 'bigint' ? decoded[0] : undefined;
        }
        if (found !== FormatMeta.CurrentVersion)
        {
            throw new FormatVersionMismatchError(found, FormatMeta.CurrentVersion);
        }
    }
}
