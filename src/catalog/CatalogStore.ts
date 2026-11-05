import { Keyspace } from '../kv/Keyspace.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { TupleCodec } from '../format/TupleCodec.js';
import { CatalogError, CatalogErrorCode } from './CatalogError.js';
import { CatalogSnapshot } from './CatalogSnapshot.js';
import type { TypeDefinition } from './CatalogTypes.js';

/** Persists the catalog: definitions as UTF-8 JSON under the catalog root, version under Meta("catalogVersion"). */
export class CatalogStore
{
    private static readonly VersionKeyName = 'catalogVersion';
    private static readonly VersionConflictMessage = 'Catalog version conflict: stored ';
    private static readonly SavingMessage = ', saving ';

    public static async Load(txn: IReadTransaction): Promise<CatalogSnapshot>
    {
        const version = await CatalogStore.StoredVersion(txn);
        const raw = await txn.Get(Keyspace.Catalog, FormatKeys.CatalogRoot());
        if (raw === undefined)
        {
            return CatalogSnapshot.Build(version, []);
        }
        const defs = JSON.parse(new TextDecoder().decode(raw)) as TypeDefinition[];
        return CatalogSnapshot.Build(version, defs);
    }

    /** Requires snapshot.Version to be exactly the stored version plus one. */
    public static async Save(txn: IWriteTransaction, snapshot: CatalogSnapshot): Promise<void>
    {
        const stored = await CatalogStore.StoredVersion(txn);
        if (snapshot.Version !== stored + 1)
        {
            throw new CatalogError(
                CatalogErrorCode.VersionConflict,
                CatalogStore.VersionConflictMessage + stored + CatalogStore.SavingMessage + snapshot.Version);
        }
        const json = JSON.stringify(snapshot.Definitions());
        txn.Put(Keyspace.Catalog, FormatKeys.CatalogRoot(), new TextEncoder().encode(json));
        txn.Put(Keyspace.Meta, FormatKeys.Meta(CatalogStore.VersionKeyName), TupleCodec.Encode([BigInt(snapshot.Version)]));
    }

    private static async StoredVersion(txn: IReadTransaction): Promise<number>
    {
        const raw = await txn.Get(Keyspace.Meta, FormatKeys.Meta(CatalogStore.VersionKeyName));
        if (raw === undefined)
        {
            return 0;
        }
        return Number(TupleCodec.Decode(raw)[0]);
    }
}
