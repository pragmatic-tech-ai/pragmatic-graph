import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { Keyspace } from '../kv/Keyspace.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { FormatKeys } from './FormatKeys.js';
import { TupleCodec } from './TupleCodec.js';

export class FormatVersionMismatchError extends GraphError
{
    private static readonly ErrorName = 'FormatVersionMismatchError';
    private static readonly FoundText = 'Unsupported on-disk format version: found ';
    private static readonly ExpectedText = ', expected ';
    private static readonly NoneText = 'none';

    public constructor(public readonly Found: bigint | undefined, public readonly Expected: bigint)
    {
        super(GraphErrorCode.Unsupported, FormatVersionMismatchError.FoundText + (Found === undefined ? FormatVersionMismatchError.NoneText : String(Found)) + FormatVersionMismatchError.ExpectedText + String(Expected));
        this.name = FormatVersionMismatchError.ErrorName;
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
