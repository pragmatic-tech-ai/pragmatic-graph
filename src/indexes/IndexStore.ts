import type { IndexDef, MemberDef } from '../catalog/CatalogTypes.js';
import { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { MemberKind, type ValueType } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import type { ColumnStore } from '../columns/ColumnStore.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { TupleElement } from '../format/TupleCodec.js';
import type { Location } from '../identity/Location.js';
import type { PublicIdIndex } from '../identity/PublicIdIndex.js';
import type { IKeyRange, IReadTransaction, IScanOptions, IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { NodeEvaluator } from '../predicate/NodeEvaluator.js';
import { Predicate } from '../predicate/Predicate.js';
import { CommitError, CommitErrorCode } from '../txn/CommitError.js';
import { ConflictKeys } from '../txn/ConflictKeys.js';
import type { ReadSet } from '../txn/ReadSet.js';
import type { WriteKeySet } from '../txn/WriteKeySet.js';
import { IndexKey } from './IndexKey.js';

/**
 * One index as it applies to one concept: the index's members and the members its `Where` reads,
 * resolved against the concept's effective properties.
 */
export class ConceptIndex
{
    private readonly touched: ReadonlySet<number>;

    private constructor(
        public readonly Def: IndexDef,
        /** The key members, in key order. */
        public readonly Members: readonly MemberDef[],
        /** Every property the entry depends on: the key members and the effective properties `Where` names. */
        public readonly Reads: readonly MemberDef[],
    )
    {
        this.touched = new Set(Reads.map(m => m.Id));
    }

    /** True when a write of the member can change this index's entry of a node. */
    public Touches(memberId: number): boolean
    {
        return this.touched.has(memberId);
    }

    /** The indexes that apply to a concept (declared on it, an ancestor or a carried aspect), resolved. */
    public static For(catalog: CatalogSnapshot, concept: string): readonly ConceptIndex[]
    {
        const properties = new Map(catalog.EffectiveMembers(concept).filter(m => m.Kind === MemberKind.Property).map(m => [m.Name, m]));
        return catalog.IndexesOn(concept).map(def =>
        {
            const members = catalog.IndexMembers(def);
            const reads = new Map(members.map(m => [m.Id, m]));
            if (def.Where !== undefined)
            {
                for (const name of Predicate.MemberNames(def.Where))
                {
                    const m = properties.get(name);
                    if (m !== undefined)
                    {
                        reads.set(m.Id, m);
                    }
                }
            }
            return new ConceptIndex(def, members, [...reads.values()]);
        });
    }
}

/** One stored index entry of one node. `Unique`: the entry is checked for uniqueness (a unique index, no null value). */
export interface IIndexEntry
{
    readonly Index: IndexDef;
    readonly Key: Uint8Array;
    readonly Hex: string;
    readonly Node: bigint;
    readonly UniqueRange?: IKeyRange;
}

/**
 * Secondary-index entries in Keyspace.Index (docs/format/on-disk-format.md, Index): computes a node's
 * entries from its stored values, adds and removes entries (every one a written conflict key,
 * `ConflictKeys.IndexEntry`), checks uniqueness, scans and builds whole indexes. Stateless across
 * transactions; values are read through the shared ColumnStore of the caller's transaction.
 */
export class IndexStore
{
    private static readonly Empty = new Uint8Array(0);
    private static readonly ErrUnique = 'Unique index already holds this value: ';
    private static readonly ErrNoPublicId = 'Corrupt graph: node has a row but no public id: ';
    private static readonly Partition = 0;

    public constructor(private readonly columns: ColumnStore, private readonly ids: PublicIdIndex)
    {
    }

    /**
     * The entries the node holds in `indexes`, from the values stored in `txn`: one per index whose
     * `Where` (if any) matches the node's values.
     */
    public async EntriesOf(txn: IReadTransaction, indexes: readonly ConceptIndex[], location: Location, internalId: bigint, publicId: string): Promise<IIndexEntry[]>
    {
        const out: IIndexEntry[] = [];
        const values = new Map<number, CellValue>();
        for (const index of indexes)
        {
            for (const m of index.Reads)
            {
                if (!values.has(m.Id))
                {
                    values.set(m.Id, await this.columns.ReadCell(txn, location, m));
                }
            }
            if (index.Def.Where !== undefined)
            {
                const named = new Map(index.Reads.map(m => [m.Name, values.get(m.Id) ?? null]));
                if (!NodeEvaluator.Matches(index.Def.Where, named, publicId))
                {
                    continue;
                }
            }
            out.push(IndexStore.Entry(index, index.Members.map(m => values.get(m.Id) ?? null), internalId));
        }
        return out;
    }

    /**
     * Applies an entry diff: deletes every removed entry first, then adds each added one after its
     * unique check (so values moving between nodes in one batch do not collide). Every entry touched is
     * a written conflict key. CommitError UniqueViolation when a unique entry would duplicate another
     * node's value tuple. With `dependencies`, each unique check's scanned range is recorded there too (a
     * prepare's dry-run, ruling R71).
     */
    public async Apply(txn: IWriteTransaction, removed: readonly IIndexEntry[], added: readonly IIndexEntry[], keys: WriteKeySet, dependencies?: ReadSet): Promise<void>
    {
        for (const entry of removed)
        {
            txn.Delete(Keyspace.Index, entry.Key);
            keys.Add(ConflictKeys.IndexSpace, ConflictKeys.IndexEntry(entry.Key));
        }
        for (const entry of added)
        {
            if (dependencies !== undefined && entry.UniqueRange !== undefined)
            {
                dependencies.AddRange(ConflictKeys.IndexSpace, ConflictKeys.IndexRange(entry.UniqueRange));
            }
            await this.RequireUnique(txn, entry);
            txn.Put(Keyspace.Index, entry.Key, IndexStore.Empty);
            keys.Add(ConflictKeys.IndexSpace, ConflictKeys.IndexEntry(entry.Key));
        }
    }

    /** Entry keys in the range, in key order (descending with Reverse). Copies. */
    public async *Seek(txn: IReadTransaction, range: IKeyRange, options: IScanOptions): AsyncIterable<Uint8Array>
    {
        for await (const [key] of txn.Scan(Keyspace.Index, range, options))
        {
            yield key;
        }
    }

    /** Deletes every entry of an index (collected first, then deleted); each is a written conflict key. */
    public async Drop(txn: IWriteTransaction, indexId: number, keys: WriteKeySet): Promise<void>
    {
        const doomed: Uint8Array[] = [];
        for await (const [key] of txn.Scan(Keyspace.Index, IndexKey.IndexRange(indexId)))
        {
            doomed.push(key);
        }
        for (const key of doomed)
        {
            txn.Delete(Keyspace.Index, key);
            keys.Add(ConflictKeys.IndexSpace, ConflictKeys.IndexEntry(key));
        }
    }

    /**
     * Adds the entries of every live node of the concept (type id `typeId`) to one index, from the stored
     * values; unique entries are checked against everything already stored (CommitError UniqueViolation).
     */
    public async Build(txn: IWriteTransaction, index: ConceptIndex, typeId: number, keys: WriteKeySet): Promise<void>
    {
        const live: Array<{ Id: bigint; Slot: number }> = [];
        for await (const row of this.columns.ScanColumn(txn, IndexStore.Partition, typeId, CatalogSnapshot.NodeIdMember))
        {
            live.push({ Id: row.NodeId, Slot: row.Slot });
        }
        for (const node of live)
        {
            const location: Location = { Partition: IndexStore.Partition, TypeId: typeId, Slot: node.Slot };
            const publicId = await this.ids.PublicIdOf(txn, node.Id);
            if (publicId === undefined)
            {
                throw new GraphError(GraphErrorCode.Corrupt, IndexStore.ErrNoPublicId + node.Id);
            }
            const entries = await this.EntriesOf(txn, [index], location, node.Id, publicId);
            await this.Apply(txn, [], entries, keys);
        }
    }

    private async RequireUnique(txn: IReadTransaction, entry: IIndexEntry): Promise<void>
    {
        if (entry.UniqueRange === undefined)
        {
            return;
        }
        for await (const [key] of txn.Scan(Keyspace.Index, entry.UniqueRange, { Limit: 2 }))
        {
            if (IndexKey.InternalId(key) !== entry.Node)
            {
                throw new CommitError(CommitErrorCode.UniqueViolation, IndexStore.ErrUnique + entry.Index.Name);
            }
        }
    }

    private static Entry(index: ConceptIndex, values: readonly CellValue[], internalId: bigint): IIndexEntry
    {
        const elements: TupleElement[] = values.map((v, i) => IndexKey.Element((index.Members[i] as MemberDef).Type as ValueType, v));
        const key = IndexKey.Entry(index.Def.Name, index.Def.Id, elements, internalId);
        const unique = index.Def.Unique && !values.includes(null);
        return {
            Index: index.Def,
            Key: key,
            Hex: ConflictKeys.Hex(key),
            Node: internalId,
            ...(unique ? { UniqueRange: IndexKey.PrefixRange(index.Def.Id, elements) } : {}),
        };
    }
}
