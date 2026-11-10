import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { InternalId } from './InternalId.js';
import { TupleCodec } from '../format/TupleCodec.js';

export class PublicIdTooLongError extends GraphError
{
    private static readonly ErrorName = 'PublicIdTooLongError';
    private static readonly Text = 'Public id exceeds 400 UTF-8 bytes';

    public constructor()
    {
        super(GraphErrorCode.InvalidArgument, PublicIdTooLongError.Text);
        this.name = PublicIdTooLongError.ErrorName;
    }
}

/** Bidirectional public id (string) to internal id index in the Ids keyspace. */
export class PublicIdIndex
{
    public static readonly MaxBytes = 400;
    private static readonly Encoder = new TextEncoder();
    private static readonly Decoder = new TextDecoder('utf-8');
    private static readonly NoOwner = '';
    private static readonly ErrEmpty = 'Public id must not be empty';
    private static readonly ErrNul = 'Public id must not contain U+0000';
    private static readonly Nul = '\u0000';
    private static readonly ErrBound = 'Public id is already bound to a different internal id: ';
    private static readonly ErrIdBound = 'Internal id is already bound to a different public id: ';
    private static readonly ErrMismatch = 'Unbind does not match the bound pair: ';

    public async Resolve(txn: IReadTransaction, publicId: string): Promise<bigint | undefined>
    {
        PublicIdIndex.Validate(publicId);
        const raw = await txn.Get(Keyspace.Ids, FormatKeys.PublicToInternal(publicId));
        return raw === undefined ? undefined : (TupleCodec.Decode(raw)[0] as bigint);
    }

    /** Every bound node's internal id, in id order (a full scan of the Ids keyspace; schema purges only). */
    public async *Scan(txn: IReadTransaction): AsyncIterable<bigint>
    {
        for await (const [key] of txn.Scan(Keyspace.Ids, FormatKeys.InternalToPublicRange()))
        {
            yield TupleCodec.Decode(key)[1] as bigint;
        }
    }

    /** The node's owner: '' when it was created without one. Callers establish that the node exists. */
    public async OwnerOf(txn: IReadTransaction, id: bigint): Promise<string>
    {
        InternalId.Require(id);
        const raw = await txn.Get(Keyspace.Ids, FormatKeys.NodeOwner(id));
        return raw === undefined ? PublicIdIndex.NoOwner : PublicIdIndex.Decoder.decode(raw);
    }

    /** Records the owner of a freshly bound node; an empty owner stores nothing. Create-time only. */
    public SetOwner(txn: IWriteTransaction, id: bigint, owner: string): void
    {
        InternalId.Require(id);
        if (owner.length > 0)
        {
            txn.Put(Keyspace.Ids, FormatKeys.NodeOwner(id), PublicIdIndex.Encoder.encode(owner));
        }
    }

    /** Replaces the owner of a live node (seed re-own, ruling R90); an empty owner deletes the key. */
    public ReplaceOwner(txn: IWriteTransaction, id: bigint, owner: string): void
    {
        InternalId.Require(id);
        if (owner.length > 0)
        {
            txn.Put(Keyspace.Ids, FormatKeys.NodeOwner(id), PublicIdIndex.Encoder.encode(owner));
        }
        else
        {
            txn.Delete(Keyspace.Ids, FormatKeys.NodeOwner(id));
        }
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
            throw new GraphError(GraphErrorCode.ConstraintViolation, PublicIdIndex.ErrBound + publicId);
        }
        const owner = await this.PublicIdOf(txn, id);
        if (owner !== undefined && owner !== publicId)
        {
            throw new GraphError(GraphErrorCode.ConstraintViolation, PublicIdIndex.ErrIdBound + id);
        }
        txn.Put(Keyspace.Ids, FormatKeys.PublicToInternal(publicId), TupleCodec.Encode([id]));
        txn.Put(Keyspace.Ids, FormatKeys.InternalToPublic(id), PublicIdIndex.Encoder.encode(publicId));
    }

    public async Unbind(txn: IWriteTransaction, publicId: string, id: bigint): Promise<void>
    {
        const existing = await this.Resolve(txn, publicId);
        if (existing !== id)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, PublicIdIndex.ErrMismatch + publicId);
        }
        txn.Delete(Keyspace.Ids, FormatKeys.PublicToInternal(publicId));
        txn.Delete(Keyspace.Ids, FormatKeys.InternalToPublic(id));
        txn.Delete(Keyspace.Ids, FormatKeys.NodeOwner(id));
    }

    private static Validate(publicId: string): void
    {
        if (publicId.length === 0)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, PublicIdIndex.ErrEmpty);
        }
        if (PublicIdIndex.Encoder.encode(publicId).length > PublicIdIndex.MaxBytes)
        {
            throw new PublicIdTooLongError();
        }
        // Rejected so a 400-byte id always fits the 511-byte key limit (tuple strings escape 0x00 as two bytes; ruling
        // F1).
        if (publicId.includes(PublicIdIndex.Nul))
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, PublicIdIndex.ErrNul);
        }
    }
}
