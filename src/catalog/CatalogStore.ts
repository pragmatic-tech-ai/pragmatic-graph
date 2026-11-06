import { Keyspace } from '../kv/Keyspace.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { TupleCodec } from '../format/TupleCodec.js';
import { CatalogError, CatalogErrorCode } from './CatalogError.js';
import { CatalogSnapshot } from './CatalogSnapshot.js';
import type { MemberDef, TypeDefinition } from './CatalogTypes.js';
import { Placement } from './ValueType.js';

interface IStoredCatalog
{
    readonly NextTypeId: number;
    readonly NextMemberId: number;
    readonly Definitions: TypeDefinition[];
}

/** Persists the catalog: `{ NextTypeId, NextMemberId, Definitions }` as UTF-8 JSON under the catalog root, version under Meta("catalogVersion"). */
export class CatalogStore
{
    private static readonly VersionKeyName = 'catalogVersion';
    private static readonly VersionConflictMessage = 'Catalog version conflict: stored ';
    private static readonly SavingMessage = ', saving ';
    private static readonly CorruptMessage = 'Corrupt catalog: ';
    private static readonly NotParsableMessage = 'not valid JSON';
    private static readonly BadShapeMessage = 'unexpected shape';
    private static readonly CounterMessage = 'id counter below largest used id or below 1: ';
    private static readonly DuplicateTypeIdMessage = 'duplicate type id ';
    private static readonly DuplicateMemberIdMessage = 'duplicate member id ';

    public static async Load(txn: IReadTransaction): Promise<CatalogSnapshot>
    {
        const version = await CatalogStore.StoredVersion(txn);
        const raw = await txn.Get(Keyspace.Catalog, FormatKeys.CatalogRoot());
        if (raw === undefined)
        {
            return CatalogSnapshot.Build(version, [], 1, 1);
        }
        const stored = CatalogStore.Parse(raw);
        CatalogStore.CheckIds(stored);
        return CatalogSnapshot.Build(
            version,
            stored.Definitions.map(d => CatalogStore.FreezeDefinition(d)),
            stored.NextTypeId,
            stored.NextMemberId);
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
        const payload: IStoredCatalog = {
            NextTypeId: snapshot.NextTypeId,
            NextMemberId: snapshot.NextMemberId,
            Definitions: [...snapshot.Definitions()],
        };
        const json = JSON.stringify(payload);
        txn.Put(Keyspace.Catalog, FormatKeys.CatalogRoot(), new TextEncoder().encode(json));
        txn.Put(Keyspace.Meta, FormatKeys.Meta(CatalogStore.VersionKeyName), TupleCodec.Encode([BigInt(snapshot.Version)]));
    }

    private static Parse(raw: Uint8Array): IStoredCatalog
    {
        let value: unknown;
        try
        {
            value = JSON.parse(new TextDecoder().decode(raw));
        }
        catch
        {
            throw CatalogStore.Corrupt(CatalogStore.NotParsableMessage);
        }
        const o = value as Partial<IStoredCatalog> | null;
        if (typeof o !== 'object' || o === null
            || !Number.isInteger(o.NextTypeId) || !Number.isInteger(o.NextMemberId) || !Array.isArray(o.Definitions)
            || !o.Definitions.every(d => CatalogStore.IsDefinition(d)))
        {
            throw CatalogStore.Corrupt(CatalogStore.BadShapeMessage);
        }
        return o as IStoredCatalog;
    }

    private static MaxOf(values: ReadonlySet<number>): number
    {
        let max = 0;
        for (const v of values)
        {
            max = Math.max(max, v);
        }
        return max;
    }

    private static IsStringArray(v: unknown): boolean
    {
        return Array.isArray(v) && v.every((x: unknown) => typeof x === 'string');
    }

    private static IsOptional(v: unknown, test: (x: unknown) => boolean): boolean
    {
        return v === undefined || test(v);
    }

    private static IsBoolean(v: unknown): boolean
    {
        return typeof v === 'boolean';
    }

    private static IsObject(v: unknown): v is Record<string, unknown>
    {
        return typeof v === 'object' && v !== null && !Array.isArray(v);
    }

    private static IsDefinition(v: unknown): boolean
    {
        return CatalogStore.IsObject(v)
            && typeof v.Name === 'string'
            && Number.isInteger(v.TypeId)
            && (v.Parent === null || typeof v.Parent === 'string')
            && CatalogStore.IsStringArray(v.Aspects)
            && Array.isArray(v.Members)
            && v.Members.every((m: unknown) => CatalogStore.IsMember(m))
            && CatalogStore.IsPlacement(v);
    }

    /** Placement and AggregateRoot (ruling F5): optional on concepts (Placement defaults to Partitioned on load), absent on aspects. */
    private static IsPlacement(v: Record<string, unknown>): boolean
    {
        if (v.IsAspect === true)
        {
            return v.Placement === undefined && v.AggregateRoot === undefined;
        }
        return CatalogStore.IsOptional(v.Placement, x => x === Placement.Replicated || x === Placement.Partitioned)
            && CatalogStore.IsOptional(v.AggregateRoot, x => typeof x === 'string');
    }

    private static IsMember(v: unknown): boolean
    {
        return CatalogStore.IsObject(v)
            && typeof v.Name === 'string'
            && Number.isInteger(v.Id)
            && Number.isInteger(v.Kind)
            && CatalogStore.IsOptional(v.Type, x => Number.isInteger(x))
            && CatalogStore.IsOptional(v.Targets, x => CatalogStore.IsStringArray(x))
            && CatalogStore.IsOptional(v.Many, x => CatalogStore.IsBoolean(x))
            && CatalogStore.IsOptional(v.Ordered, x => CatalogStore.IsBoolean(x))
            && CatalogStore.IsOptional(v.Nullable, x => CatalogStore.IsBoolean(x))
            && (v.EdgeProperties === undefined
                || (Array.isArray(v.EdgeProperties) && v.EdgeProperties.every((m: unknown) => CatalogStore.IsMember(m))));
    }

    private static CheckIds(stored: IStoredCatalog): void
    {
        const maxType = CatalogStore.CheckUniqueIds(stored.Definitions);
        if (stored.NextTypeId < 1 || stored.NextTypeId < maxType.Type + 1)
        {
            throw CatalogStore.Corrupt(CatalogStore.CounterMessage + 'NextTypeId ' + stored.NextTypeId);
        }
        if (stored.NextMemberId < 1 || stored.NextMemberId < maxType.Member + 1)
        {
            throw CatalogStore.Corrupt(CatalogStore.CounterMessage + 'NextMemberId ' + stored.NextMemberId);
        }
    }

    private static CheckUniqueIds(defs: readonly TypeDefinition[]): { Type: number; Member: number }
    {
        const typeIds = new Set<number>();
        const memberIds = new Set<number>();
        for (const d of defs)
        {
            if (typeIds.has(d.TypeId))
            {
                throw CatalogStore.Corrupt(CatalogStore.DuplicateTypeIdMessage + d.TypeId);
            }
            typeIds.add(d.TypeId);
            CatalogStore.CheckMemberIds(d.Members, memberIds);
        }
        return { Type: CatalogStore.MaxOf(typeIds), Member: CatalogStore.MaxOf(memberIds) };
    }

    private static CheckMemberIds(members: readonly MemberDef[], seen: Set<number>): void
    {
        for (const m of members)
        {
            if (seen.has(m.Id))
            {
                throw CatalogStore.Corrupt(CatalogStore.DuplicateMemberIdMessage + m.Id);
            }
            seen.add(m.Id);
            CatalogStore.CheckMemberIds(m.EdgeProperties ?? [], seen);
        }
    }

    private static FreezeDefinition(d: TypeDefinition): TypeDefinition
    {
        return Object.freeze({
            ...d,
            ...(d.IsAspect ? {} : { Placement: d.Placement ?? Placement.Partitioned }),
            Aspects: Object.freeze([...d.Aspects]),
            Members: Object.freeze(d.Members.map(m => CatalogStore.FreezeMember(m))),
        });
    }

    private static FreezeMember(m: MemberDef): MemberDef
    {
        const copy: { -readonly [K in keyof MemberDef]: MemberDef[K] } = { ...m };
        if (m.Targets !== undefined) { copy.Targets = Object.freeze([...m.Targets]); }
        if (m.EdgeProperties !== undefined) { copy.EdgeProperties = Object.freeze(m.EdgeProperties.map(e => CatalogStore.FreezeMember(e))); }
        return Object.freeze(copy);
    }

    private static Corrupt(detail: string): CatalogError
    {
        return new CatalogError(CatalogErrorCode.CorruptCatalog, CatalogStore.CorruptMessage + detail);
    }

    /** The stored catalog version (0 when no catalog was ever saved). */
    public static async StoredVersion(txn: IReadTransaction): Promise<number>
    {
        const raw = await txn.Get(Keyspace.Meta, FormatKeys.Meta(CatalogStore.VersionKeyName));
        if (raw === undefined)
        {
            return 0;
        }
        return Number(TupleCodec.Decode(raw)[0]);
    }
}
