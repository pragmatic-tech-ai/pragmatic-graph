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

/**
 * Global Meta values outside the catalog: the format version under Meta("format") (a TupleCodec-encoded
 * integer) and the schema version under Meta("schemaVersion") (a TupleCodec-encoded string).
 */
export class FormatMeta
{
    public static readonly CurrentVersion = 1n;
    private static readonly FormatKeyName = 'format';
    private static readonly SchemaVersionKeyName = 'schemaVersion';
    private static readonly StubRuleKeyName = 'stubRule';
    private static readonly ErrStubRule = 'Corrupt Meta("stubRule"): not a single string';
    private static readonly ErrSchemaVersion = 'Corrupt Meta("schemaVersion"): not a single string';

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

    /** The opaque version of the schema description last applied by an upgrade; undefined before the first. */
    public static async ReadSchemaVersion(txn: IReadTransaction): Promise<string | undefined>
    {
        const raw = await txn.Get(Keyspace.Meta, FormatKeys.Meta(FormatMeta.SchemaVersionKeyName));
        if (raw === undefined)
        {
            return undefined;
        }
        let decoded: unknown[];
        try
        {
            decoded = TupleCodec.Decode(raw);
        }
        catch (error)
        {
            throw new GraphError(GraphErrorCode.Corrupt, FormatMeta.ErrSchemaVersion, error);
        }
        if (decoded.length !== 1 || typeof decoded[0] !== 'string')
        {
            throw new GraphError(GraphErrorCode.Corrupt, FormatMeta.ErrSchemaVersion);
        }
        return decoded[0];
    }

    /**
     * The fingerprint of the stub rule the stored data conforms to (StubRule.Fingerprint), written by the upgrade that
     * reconciled the data with it; undefined before any (no stored node is then a stub by rule).
     */
    public static async ReadStubRule(txn: IReadTransaction): Promise<string | undefined>
    {
        const raw = await txn.Get(Keyspace.Meta, FormatKeys.Meta(FormatMeta.StubRuleKeyName));
        if (raw === undefined)
        {
            return undefined;
        }
        let decoded: unknown[];
        try
        {
            decoded = TupleCodec.Decode(raw);
        }
        catch (error)
        {
            throw new GraphError(GraphErrorCode.Corrupt, FormatMeta.ErrStubRule, error);
        }
        if (decoded.length !== 1 || typeof decoded[0] !== 'string')
        {
            throw new GraphError(GraphErrorCode.Corrupt, FormatMeta.ErrStubRule);
        }
        return decoded[0];
    }

    /** Written only by the committer, in the write transaction of the upgrade that reconciled the data with the rule. */
    public static WriteStubRule(txn: IWriteTransaction, fingerprint: string): void
    {
        txn.Put(Keyspace.Meta, FormatKeys.Meta(FormatMeta.StubRuleKeyName), TupleCodec.Encode([fingerprint]));
    }

    /** Written only by the committer, in the write transaction of the upgrade it belongs to. */
    public static WriteSchemaVersion(txn: IWriteTransaction, version: string): void
    {
        txn.Put(Keyspace.Meta, FormatKeys.Meta(FormatMeta.SchemaVersionKeyName), TupleCodec.Encode([version]));
    }
}
