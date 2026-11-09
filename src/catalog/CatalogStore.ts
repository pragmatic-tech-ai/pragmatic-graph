import { Keyspace } from '../kv/Keyspace.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { TupleCodec } from '../format/TupleCodec.js';
import { CatalogError, CatalogErrorCode } from './CatalogError.js';
import { CatalogSnapshot } from './CatalogSnapshot.js';
import { PredicateCodec } from '../predicate/PredicateCodec.js';
import type { IndexDef, MemberDef, TypeDefinition } from './CatalogTypes.js';
import { Placement } from './ValueType.js';

interface IStoredCatalog
{
    readonly NextTypeId: number;
    readonly NextMemberId: number;
    readonly Definitions: TypeDefinition[];
    /** Additive: absent in catalogs written before indexes existed. */
    readonly NextIndexId?: number;
    readonly Indexes?: IStoredIndex[];
}

/** An index as stored: `Where` is the PredicateCodec JSON of the predicate. */
interface IStoredIndex
{
    readonly Id: number;
    readonly Name: string;
    readonly On: string;
    readonly Members: number[];
    readonly Unique: boolean;
    readonly Where?: unknown;
}

/**
 * Persists the catalog: `{ NextTypeId, NextMemberId, Definitions }` as UTF-8 JSON under the catalog root, version under
 * Meta("catalogVersion").
 */
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
    private static readonly DuplicateIndexIdMessage = 'duplicate index id ';
    private static readonly BadIndexMessage = 'invalid index ';

    public static async Load(txn: IReadTransaction): Promise<CatalogSnapshot>
    {
        const version = await CatalogStore.StoredVersion(txn);
        const raw = await txn.Get(Keyspace.Catalog, FormatKeys.CatalogRoot());
        if (raw === undefined)
        {
            return CatalogSnapshot.Build(version, [], 1, 1, [], 1);
        }
        return CatalogStore.Decode(version, raw);
    }

    /** The catalog root value (UTF-8 JSON) of a snapshot; also the payload of a SchemaChange log entry. */
    public static Serialize(snapshot: CatalogSnapshot): Uint8Array
    {
        const payload: IStoredCatalog = {
            NextTypeId: snapshot.NextTypeId,
            NextMemberId: snapshot.NextMemberId,
            Definitions: [...snapshot.Definitions()],
            NextIndexId: snapshot.NextIndexId,
            Indexes: snapshot.Indexes().map(i => CatalogStore.EncodeIndex(i)),
        };
        return new TextEncoder().encode(JSON.stringify(payload));
    }

    /** Parses and validates a catalog root value as the snapshot of `version`; CatalogError on bad input. */
    public static Decode(version: number, raw: Uint8Array): CatalogSnapshot
    {
        const stored = CatalogStore.Parse(raw);
        CatalogStore.CheckIds(stored);
        return CatalogSnapshot.Build(
            version,
            stored.Definitions.map(d => CatalogStore.FreezeDefinition(d)),
            stored.NextTypeId,
            stored.NextMemberId,
            (stored.Indexes ?? []).map(i => CatalogStore.DecodeIndex(i)),
            stored.NextIndexId ?? 1);
    }

    private static EncodeIndex(index: IndexDef): IStoredIndex
    {
        return {
            Id: index.Id,
            Name: index.Name,
            On: index.On,
            Members: [...index.Members],
            Unique: index.Unique,
            ...(index.Where === undefined ? {} : { Where: PredicateCodec.ToJson(index.Where) }),
        };
    }

    private static DecodeIndex(stored: IStoredIndex): IndexDef
    {
        let where;
        try
        {
            where = stored.Where === undefined ? undefined : PredicateCodec.FromJson(stored.Where);
        }
        catch
        {
            // Any codec failure (PredicateError or a malformed shape it did not anticipate) is a corrupt catalog.
            throw CatalogStore.Corrupt(CatalogStore.BadIndexMessage + stored.Name);
        }
        return Object.freeze({
            Id: stored.Id,
            Name: stored.Name,
            On: stored.On,
            Members: Object.freeze([...stored.Members]),
            Unique: stored.Unique,
            ...(where === undefined ? {} : { Where: where }),
        });
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
        txn.Put(Keyspace.Catalog, FormatKeys.CatalogRoot(), CatalogStore.Serialize(snapshot));
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
            || !o.Definitions.every(d => CatalogStore.IsDefinition(d))
            || !CatalogStore.IsOptional(o.NextIndexId, x => Number.isInteger(x))
            || !CatalogStore.IsOptional(o.Indexes, x => Array.isArray(x) && x.every((i: unknown) => CatalogStore.IsIndex(i))))
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

    private static IsIndex(v: unknown): boolean
    {
        return CatalogStore.IsObject(v)
            && Number.isInteger(v.Id)
            && typeof v.Name === 'string'
            && typeof v.On === 'string'
            && Array.isArray(v.Members) && v.Members.every((x: unknown) => Number.isInteger(x))
            && typeof v.Unique === 'boolean'
            && (v.Where === undefined || CatalogStore.IsObject(v.Where));
    }

    /**
     * Placement and AggregateRoot (ruling F5): optional on concepts (Placement defaults to Partitioned on load), absent
     * on aspects.
     */
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
        const indexIds = new Set<number>();
        for (const i of stored.Indexes ?? [])
        {
            if (indexIds.has(i.Id))
            {
                throw CatalogStore.Corrupt(CatalogStore.DuplicateIndexIdMessage + i.Id);
            }
            indexIds.add(i.Id);
        }
        if ((stored.NextIndexId ?? 1) < 1 || (stored.NextIndexId ?? 1) < CatalogStore.MaxOf(indexIds) + 1)
        {
            throw CatalogStore.Corrupt(CatalogStore.CounterMessage + 'NextIndexId ' + stored.NextIndexId);
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
