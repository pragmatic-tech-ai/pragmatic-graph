import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { InternalId } from './InternalId.js';
import { TupleCodec } from '../format/TupleCodec.js';

export class PublicIdTooLongError extends Error
{
    private static readonly ErrorName = 'PublicIdTooLongError';
    private static readonly Text = 'Public id exceeds 400 UTF-8 bytes';

    public constructor()
    {
        super(PublicIdTooLongError.Text);
        this.name = PublicIdTooLongError.ErrorName;
    }
}

/** Bidirectional public id (string) to internal id index in the Ids keyspace. */
export class PublicIdIndex
{
    public static readonly MaxBytes = 400;
    private static readonly Encoder = new TextEncoder();
    private static readonly Decoder = new TextDecoder('utf-8');
    private static readonly ErrEmpty = 'Public id must not be empty';
    private static readonly ErrBound = 'Public id is already bound to a different internal id: ';
    private static readonly ErrIdBound = 'Internal id is already bound to a different public id: ';
    private static readonly ErrMismatch = 'Unbind does not match the bound pair: ';

    public async Resolve(txn: IReadTransaction, publicId: string): Promise<bigint | undefined>
    {
        PublicIdIndex.Validate(publicId);
        const raw = await txn.Get(Keyspace.Ids, FormatKeys.PublicToInternal(publicId));
        return raw === undefined ? undefined : (TupleCodec.Decode(raw)[0] as bigint);
    }

    public async PublicIdOf(txn: IReadTransaction, id: bigint): Promise<string | undefined>
    {
        InternalId.Require(id);
        const raw = await txn.Get(Keyspace.Ids, FormatKeys.InternalToPublic(id));
        return raw === undefined ? undefined : PublicIdIndex.Decoder.decode(raw);
    }

    /** Binds publicId to id. Rebinding the identical pair is a no-op; any conflict throws. */
    public async Bind(txn: IWriteTransaction, publicId: string, id: bigint): Promise<void>
    {
        PublicIdIndex.Validate(publicId);
        InternalId.Require(id);
        const existing = await this.Resolve(txn, publicId);
        if (existing !== undefined && existing !== id)
        {
            throw new Error(PublicIdIndex.ErrBound + publicId);
        }
        const owner = await this.PublicIdOf(txn, id);
        if (owner !== undefined && owner !== publicId)
        {
            throw new Error(PublicIdIndex.ErrIdBound + id);
        }
        txn.Put(Keyspace.Ids, FormatKeys.PublicToInternal(publicId), TupleCodec.Encode([id]));
        txn.Put(Keyspace.Ids, FormatKeys.InternalToPublic(id), PublicIdIndex.Encoder.encode(publicId));
    }

    public async Unbind(txn: IWriteTransaction, publicId: string, id: bigint): Promise<void>
    {
        const existing = await this.Resolve(txn, publicId);
        if (existing !== id)
        {
            throw new Error(PublicIdIndex.ErrMismatch + publicId);
        }
        txn.Delete(Keyspace.Ids, FormatKeys.PublicToInternal(publicId));
        txn.Delete(Keyspace.Ids, FormatKeys.InternalToPublic(id));
    }

    private static Validate(publicId: string): void
    {
        if (publicId.length === 0)
        {
            throw new Error(PublicIdIndex.ErrEmpty);
        }
        if (PublicIdIndex.Encoder.encode(publicId).length > PublicIdIndex.MaxBytes)
        {
            throw new PublicIdTooLongError();
        }
    }
}
