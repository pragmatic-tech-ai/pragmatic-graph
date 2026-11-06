import { MemberKind, ValueType } from '../catalog/ValueType.js';
import type { MemberDef } from '../catalog/CatalogTypes.js';
import { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { TupleCodec } from '../format/TupleCodec.js';
import type { Location } from '../identity/Location.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { CellValue } from './CellValue.js';
import { ChunkCodec } from './ChunkCodec.js';
import { ChunkDelta, type IDeltaEntry } from './ChunkDelta.js';
import { ValueCodec } from './ValueCodec.js';

/** A chunk's pending delta held in memory for the life of one write transaction. */
class DeltaState
{
    public Dirty = false;

    public constructor(
        public readonly Key: Uint8Array,
        public readonly Type: ValueType,
        public readonly Cells: Map<number, CellValue>,
        public readonly Partition: number,
        public readonly TypeId: number,
        public readonly MemberId: number,
        public readonly Chunk: bigint,
    )
    {
    }

    public Entries(): IDeltaEntry[]
    {
        return [...this.Cells.keys()].sort((a, b) => a - b).map(slot => ({ Slot: slot, Value: this.Cells.get(slot) as CellValue }));
    }
}

/** A chunk whose delta this write transaction has written, with the delta's total entry count. */
export interface ITouchedDelta
{
    readonly Partition: number;
    readonly TypeId: number;
    readonly MemberId: number;
    readonly Chunk: bigint;
    /** Entries the chunk's delta holds (stored entries plus this transaction's), one per slot. */
    readonly Entries: number;
}

/** Everything ColumnStore caches for one write transaction. */
class TxnState
{
    public readonly Deltas = new Map<string, DeltaState>();
    public readonly Slots = new Map<number, number>();
    public readonly DeltaLoads = new Map<string, Promise<DeltaState>>();
    public readonly SlotLoads = new Map<number, Promise<number>>();
}

/**
 * Node property cells in column chunks, with writes going to a per-chunk delta overlay (folded into
 * the chunk by Compactor). Chunk number = slot / 2048, slot-in-chunk = slot % 2048. A missing chunk
 * and no delta entry reads as null. The per-type slot counter lives in Meta("slots", typeId) and is
 * written through the caller's write transaction, so it commits or rolls back with it.
 * Only properties (and the node-id member 0) are stored here; relationships are rejected.
 * Deleting a node is writing null to member 0; its slot is not reused in v1.
 *
 * Within a write transaction, WriteCell mutates a parsed in-memory delta (one parse per chunk per
 * transaction); reads in that transaction see it. The caller MUST call Flush(txn) before the
 * transaction commits, or the pending writes are lost. Compactor must use the same ColumnStore instance.
 */
export class ColumnStore
{
    private static readonly SlotsName = 'slots';
    private static readonly ReservedSlot = 0xffffffff;
    private static readonly SlotsPerChunkBig = BigInt(ChunkCodec.SlotsPerChunk);
    private static readonly KeySeparator = '/';
    private static readonly PutMethod = 'Put';
    private static readonly ErrPartition = 'Only partition 0 exists in v1: ';
    private static readonly ErrSlot = 'Slot must be an integer within 0..0xFFFFFFFE: ';
    private static readonly ErrUnallocated = 'Slot was never allocated for the type: ';
    private static readonly ErrMember = 'Only property members are stored in columns: ';
    private static readonly ErrUnflushed = 'Column store has pending delta writes: call Flush(txn) before commit';
    private static readonly ErrNull = 'Member does not accept null: ';
    private static readonly ErrSlotsExhausted = 'Slot space exhausted for type ';
    private static readonly ErrTypeId = 'Type id must be a non-negative integer: ';

    private readonly states = new WeakMap<object, TxnState>();
    private readonly slotKeys = new Map<number, Uint8Array>();

    /** Validates that the member is a stored property and returns its value type. */
    public static RequireType(member: MemberDef): ValueType
    {
        if (member.Kind !== MemberKind.Property || member.Type === undefined)
        {
            throw new RangeError(ColumnStore.ErrMember + member.Name);
        }
        return member.Type;
    }

    public static RequirePartition(partition: number): void
    {
        if (partition !== 0)
        {
            throw new RangeError(ColumnStore.ErrPartition + partition);
        }
    }

    /** Hands out the next dense slot (from 0) for the type and persists the counter through txn. */
    public async AllocateSlot(txn: IWriteTransaction, partition: number, typeId: number): Promise<number>
    {
        ColumnStore.RequirePartition(partition);
        await this.SlotCount(txn, partition, typeId);
        // Synchronous from here on, so concurrent callers on one transaction get distinct slots.
        const slots = (this.StateOf(txn) as TxnState).Slots;
        const next = slots.get(typeId) as number;
        if (next >= ColumnStore.ReservedSlot)
        {
            throw new RangeError(ColumnStore.ErrSlotsExhausted + typeId);
        }
        slots.set(typeId, next + 1);
        txn.Put(Keyspace.Meta, this.SlotsKey(typeId), TupleCodec.Encode([BigInt(next + 1)]));
        return next;
    }

    /** Number of slots ever allocated for the type (live or deleted). */
    public async SlotCount(txn: IReadTransaction, partition: number, typeId: number): Promise<number>
    {
        ColumnStore.RequirePartition(partition);
        const state = this.StateOf(txn);
        const cached = state?.Slots.get(typeId);
        if (cached !== undefined)
        {
            return cached;
        }
        if (state === undefined)
        {
            return this.LoadSlotCount(txn, typeId);
        }
        let loading = state.SlotLoads.get(typeId);
        if (loading === undefined)
        {
            loading = this.LoadSlotCount(txn, typeId).then(count =>
            {
                state.SlotLoads.delete(typeId);
                if (!state.Slots.has(typeId))
                {
                    state.Slots.set(typeId, count);
                }
                return state.Slots.get(typeId) as number;
            }, (error: unknown) =>
            {
                state.SlotLoads.delete(typeId);
                throw error;
            });
            state.SlotLoads.set(typeId, loading);
        }
        return loading;
    }

    public async ReadCell(txn: IReadTransaction, location: Location, member: MemberDef): Promise<CellValue>
    {
        const type = ColumnStore.RequireType(member);
        ColumnStore.RequirePartition(location.Partition);
        ColumnStore.RequireSlot(location.Slot);
        const chunk = BigInt(Math.floor(location.Slot / ChunkCodec.SlotsPerChunk));
        const inChunk = location.Slot % ChunkCodec.SlotsPerChunk;
        const cached = this.StateOf(txn)?.Deltas.get(ColumnStore.DeltaId(location.Partition, location.TypeId, member.Id, chunk));
        if (cached !== undefined)
        {
            if (cached.Cells.has(inChunk))
            {
                return cached.Cells.get(inChunk) as CellValue;
            }
        }
        else
        {
            const deltaBytes = await txn.Get(Keyspace.Deltas, FormatKeys.Delta(location.Partition, location.TypeId, member.Id, chunk));
            const hit = deltaBytes === undefined ? undefined : ChunkDelta.Lookup(type, deltaBytes, inChunk);
            if (hit !== undefined)
            {
                return hit.Value;
            }
        }
        const chunkBytes = await txn.Get(Keyspace.Columns, FormatKeys.Column(location.Partition, location.TypeId, member.Id, chunk));
        if (chunkBytes === undefined || inChunk >= ChunkCodec.SlotCount(chunkBytes))
        {
            return null;
        }
        return ChunkCodec.ReadCell(type, chunkBytes, inChunk);
    }

    /**
     * Records the cell in the chunk's in-memory delta (one entry per slot; a later write replaces).
     * The slot must have been allocated. Persisted by Flush(txn).
     */
    public async WriteCell(txn: IWriteTransaction, location: Location, member: MemberDef, value: CellValue): Promise<void>
    {
        const type = ColumnStore.RequireType(member);
        ColumnStore.RequirePartition(location.Partition);
        ColumnStore.RequireSlot(location.Slot);
        if (value === null)
        {
            if (!member.Nullable && member.Id !== CatalogSnapshot.NodeIdMember.Id)
            {
                throw new RangeError(ColumnStore.ErrNull + member.Name);
            }
        }
        else
        {
            ValueCodec.Check(type, value);
        }
        if (location.Slot >= (await this.SlotCount(txn, location.Partition, location.TypeId)))
        {
            throw new RangeError(ColumnStore.ErrUnallocated + location.Slot);
        }
        const chunk = BigInt(Math.floor(location.Slot / ChunkCodec.SlotsPerChunk));
        const state = await this.DeltaStateFor(txn, location.Partition, location.TypeId, member.Id, type, chunk);
        state.Cells.set(location.Slot % ChunkCodec.SlotsPerChunk, value);
        state.Dirty = true;
    }

    /** True when this write transaction holds delta writes that Flush has not yet persisted. */
    public HasPendingWrites(txn: IWriteTransaction): boolean
    {
        const state = this.states.get(txn);
        if (state === undefined)
        {
            return false;
        }
        for (const delta of state.Deltas.values())
        {
            if (delta.Dirty)
            {
                return true;
            }
        }
        return false;
    }

    /** Throws unless every write of this transaction has been flushed; for the committer to call just before commit. */
    public AssertFlushed(txn: IWriteTransaction): void
    {
        if (this.HasPendingWrites(txn))
        {
            throw new Error(ColumnStore.ErrUnflushed);
        }
    }

    /** Chunks whose delta this write transaction has written (and not yet compacted), for the compaction policy. */
    public TouchedDeltas(txn: IWriteTransaction): ITouchedDelta[]
    {
        const state = this.states.get(txn);
        if (state === undefined)
        {
            return [];
        }
        return [...state.Deltas.values()].map(d => ({
            Partition: d.Partition,
            TypeId: d.TypeId,
            MemberId: d.MemberId,
            Chunk: d.Chunk,
            Entries: d.Cells.size,
        }));
    }

    /** Serializes every dirty delta once. Idempotent; a write after Flush marks its delta dirty again and needs another Flush. Call before the write transaction commits. */
    public Flush(txn: IWriteTransaction): void
    {
        const state = this.states.get(txn);
        if (state === undefined)
        {
            return;
        }
        for (const delta of state.Deltas.values())
        {
            if (delta.Dirty)
            {
                txn.Put(Keyspace.Deltas, delta.Key, ChunkDelta.Serialize(delta.Type, delta.Entries()));
                delta.Dirty = false;
            }
        }
    }

    /**
     * For Compactor: removes and returns the chunk's delta entries (pending in-transaction state first,
     * else stored), deleting the stored delta. Undefined when the chunk has no delta.
     */
    public async TakeDelta(txn: IWriteTransaction, partition: number, typeId: number, member: MemberDef, chunk: bigint): Promise<IDeltaEntry[] | undefined>
    {
        const type = ColumnStore.RequireType(member);
        ColumnStore.RequirePartition(partition);
        const id = ColumnStore.DeltaId(partition, typeId, member.Id, chunk);
        const key = FormatKeys.Delta(partition, typeId, member.Id, chunk);
        const state = this.StateOf(txn);
        const cached = state?.Deltas.get(id);
        if (cached !== undefined)
        {
            state!.Deltas.delete(id);
            txn.Delete(Keyspace.Deltas, key);
            return cached.Entries();
        }
        const bytes = await txn.Get(Keyspace.Deltas, key);
        if (bytes === undefined)
        {
            return undefined;
        }
        txn.Delete(Keyspace.Deltas, key);
        return ChunkDelta.Parse(type, bytes);
    }

    /** Live slots (member-0 cell non-null after overlay) in slot order, with this member's value. */
    public async *ScanColumn(txn: IReadTransaction, partition: number, typeId: number, member: MemberDef): AsyncIterable<{ Slot: number; Value: CellValue }>
    {
        const type = ColumnStore.RequireType(member);
        ColumnStore.RequirePartition(partition);
        const count = await this.SlotCount(txn, partition, typeId);
        const idMember = CatalogSnapshot.NodeIdMember;
        const isId = member.Id === idMember.Id;
        for (let start = 0; start < count; start += ChunkCodec.SlotsPerChunk)
        {
            const chunk = BigInt(start) / ColumnStore.SlotsPerChunkBig;
            const n = Math.min(ChunkCodec.SlotsPerChunk, count - start);
            const values = await this.LoadChunk(txn, partition, typeId, member.Id, type, chunk, n);
            const ids = isId ? values : await this.LoadChunk(txn, partition, typeId, idMember.Id, idMember.Type as ValueType, chunk, n);
            for (let i = 0; i < n; i++)
            {
                if (ids[i] !== null)
                {
                    yield { Slot: start + i, Value: values[i] as CellValue };
                }
            }
        }
    }

    /** The first `n` cells of a chunk with its delta overlaid; missing chunk and delta give nulls. */
    private async LoadChunk(
        txn: IReadTransaction,
        partition: number,
        typeId: number,
        memberId: number,
        type: ValueType,
        chunk: bigint,
        n: number,
    ): Promise<CellValue[]>
    {
        const cells: CellValue[] = new Array<CellValue>(n).fill(null);
        const chunkBytes = await txn.Get(Keyspace.Columns, FormatKeys.Column(partition, typeId, memberId, chunk));
        if (chunkBytes !== undefined)
        {
            const decoded = ChunkCodec.DecodeAll(type, chunkBytes);
            for (let i = 0; i < n && i < decoded.length; i++)
            {
                cells[i] = decoded[i] as CellValue;
            }
        }
        const cached = this.StateOf(txn)?.Deltas.get(ColumnStore.DeltaId(partition, typeId, memberId, chunk));
        let overlay: Iterable<IDeltaEntry> | undefined;
        if (cached !== undefined)
        {
            overlay = cached.Entries();
        }
        else
        {
            const deltaBytes = await txn.Get(Keyspace.Deltas, FormatKeys.Delta(partition, typeId, memberId, chunk));
            overlay = deltaBytes === undefined ? undefined : ChunkDelta.Parse(type, deltaBytes);
        }
        if (overlay !== undefined)
        {
            for (const e of overlay)
            {
                if (e.Slot < n)
                {
                    cells[e.Slot] = e.Value;
                }
            }
        }
        return cells;
    }

    /** The cached delta for this chunk in this write transaction, loading (one parse) from storage on first touch. */
    private async DeltaStateFor(txn: IWriteTransaction, partition: number, typeId: number, memberId: number, type: ValueType, chunk: bigint): Promise<DeltaState>
    {
        const state = this.StateOf(txn) as TxnState;
        const id = ColumnStore.DeltaId(partition, typeId, memberId, chunk);
        const existing = state.Deltas.get(id);
        if (existing !== undefined)
        {
            return existing;
        }
        let loading = state.DeltaLoads.get(id);
        if (loading === undefined)
        {
            loading = this.LoadDelta(txn, partition, typeId, memberId, type, chunk).then(loaded =>
            {
                state.DeltaLoads.delete(id);
                const winner = state.Deltas.get(id);
                if (winner !== undefined)
                {
                    return winner;
                }
                state.Deltas.set(id, loaded);
                return loaded;
            }, (error: unknown) =>
            {
                state.DeltaLoads.delete(id);
                throw error;
            });
            state.DeltaLoads.set(id, loading);
        }
        return loading;
    }

    private async LoadDelta(txn: IWriteTransaction, partition: number, typeId: number, memberId: number, type: ValueType, chunk: bigint): Promise<DeltaState>
    {
        const key = FormatKeys.Delta(partition, typeId, memberId, chunk);
        const bytes = await txn.Get(Keyspace.Deltas, key);
        const cells = new Map<number, CellValue>();
        if (bytes !== undefined)
        {
            for (const e of ChunkDelta.Parse(type, bytes))
            {
                cells.set(e.Slot, e.Value);
            }
        }
        return new DeltaState(key, type, cells, partition, typeId, memberId, chunk);
    }

    private async LoadSlotCount(txn: IReadTransaction, typeId: number): Promise<number>
    {
        const raw = await txn.Get(Keyspace.Meta, this.SlotsKey(typeId));
        return raw === undefined ? 0 : Number(TupleCodec.Decode(raw)[0] as bigint);
    }

    /** The per-transaction cache for write transactions (created on demand); undefined for read-only ones. */
    private StateOf(txn: IReadTransaction): TxnState | undefined
    {
        if (!(ColumnStore.PutMethod in txn))
        {
            return undefined;
        }
        let state = this.states.get(txn);
        if (state === undefined)
        {
            state = new TxnState();
            this.states.set(txn, state);
        }
        return state;
    }

    private static DeltaId(partition: number, typeId: number, memberId: number, chunk: bigint): string
    {
        const s = ColumnStore.KeySeparator;
        return partition + s + typeId + s + memberId + s + chunk;
    }

    private SlotsKey(typeId: number): Uint8Array
    {
        let key = this.slotKeys.get(typeId);
        if (key === undefined)
        {
            if (!Number.isInteger(typeId) || typeId < 0)
            {
                throw new RangeError(ColumnStore.ErrTypeId + typeId);
            }
            key = FormatKeys.Meta(ColumnStore.SlotsName, typeId);
            this.slotKeys.set(typeId, key);
        }
        return key;
    }

    private static RequireSlot(slot: number): void
    {
        if (!Number.isInteger(slot) || slot < 0 || slot >= ColumnStore.ReservedSlot)
        {
            throw new RangeError(ColumnStore.ErrSlot + slot);
        }
    }
}
