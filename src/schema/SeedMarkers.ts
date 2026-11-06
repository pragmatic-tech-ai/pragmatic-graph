import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { TupleCodec } from '../format/TupleCodec.js';
import { Keyspace } from '../kv/Keyspace.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { SeedHash } from './SeedHash.js';

/**
 * The seed markers in Keyspace.Meta (docs/format/on-disk-format.md, Meta): `("seed", publicId)` -> the
 * 32-byte SeedHash of the seed node last applied to that node. A marker exists only while its node does:
 * DeleteNode and the upgrade purge remove it with the node.
 */
export class SeedMarkers
{
    private static readonly ErrCorrupt = 'Corrupt seed marker: ';

    /** A copy of the node's marker hash; undefined when the node is not seeded. */
    public static async Read(txn: IReadTransaction, publicId: string): Promise<Uint8Array | undefined>
    {
        const raw = await txn.Get(Keyspace.Meta, FormatKeys.Seed(publicId));
        if (raw === undefined)
        {
            return undefined;
        }
        SeedMarkers.RequireHash(raw, publicId);
        return raw.slice();
    }

    /** Every marker, by public id (copies). */
    public static async ReadAll(txn: IReadTransaction): Promise<Map<string, Uint8Array>>
    {
        const out = new Map<string, Uint8Array>();
        for await (const [key, value] of txn.Scan(Keyspace.Meta, FormatKeys.SeedRange()))
        {
            const tuple = TupleCodec.Decode(key);
            const publicId = tuple[1];
            if (tuple.length !== 2 || typeof publicId !== 'string')
            {
                throw new GraphError(GraphErrorCode.Corrupt, SeedMarkers.ErrCorrupt + Buffer.from(key).toString('hex'));
            }
            SeedMarkers.RequireHash(value, publicId);
            out.set(publicId, value.slice());
        }
        return out;
    }

    public static Write(txn: IWriteTransaction, publicId: string, hash: Uint8Array): void
    {
        txn.Put(Keyspace.Meta, FormatKeys.Seed(publicId), hash);
    }

    public static Delete(txn: IWriteTransaction, publicId: string): void
    {
        txn.Delete(Keyspace.Meta, FormatKeys.Seed(publicId));
    }

    private static RequireHash(value: Uint8Array, publicId: string): void
    {
        if (value.length !== SeedHash.Bytes)
        {
            throw new GraphError(GraphErrorCode.Corrupt, SeedMarkers.ErrCorrupt + publicId);
        }
    }
}
