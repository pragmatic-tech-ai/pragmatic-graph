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
import { ChunkDelta } from './ChunkDelta.js';

/**
 * Node property cells in column chunks, with writes going to a per-chunk delta overlay (folded into
 * the chunk by Compactor). Chunk number = slot / 2048, slot-in-chunk = slot % 2048. A missing chunk
 * and no delta entry reads as null. The per-type slot counter lives in Meta("slots", typeId) and is
 * read/written through the caller's write transaction, so it commits or rolls back with it.
 * Only properties (and the node-id member 0) are stored here; relationships are rejected.
 * Deleting a node is writing null to member 0; its slot is not reused in v1.
 */
export class ColumnStore
{
    private static readonly SlotsName = 'slots';
    private static readonly ReservedSlot = 0xffffffff;
    private static readonly SlotsPerChunkBig = BigInt(ChunkCodec.SlotsPerChunk);
    private static readonly ErrPartition = 'Only partition 0 exists in v1: ';
    private static readonly ErrSlot = 'Slot must be an integer within 0..0xFFFFFFFE: ';
    private static readonly ErrMember = 'Only property members are stored in columns: ';
    private static readonly ErrSlotsExhausted = 'Slot space exhausted for type ';
    private static readonly ErrTypeId = 'Type id must be a non-negative integer: ';

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
        const next = await this.SlotCount(txn, partition, typeId);
        if (next >= ColumnStore.ReservedSlot)
        {
            throw new RangeError(ColumnStore.ErrSlotsExhausted + typeId);
        }
        txn.Put(Keyspace.Meta, ColumnStore.SlotsKey(typeId), TupleCodec.Encode([BigInt(next + 1)]));
        return next;
    }

    /** Number of slots ever allocated for the type (live or deleted). */
    public async SlotCount(txn: IReadTransaction, partition: number, typeId: number): Promise<number>
    {
        ColumnStore.RequirePartition(partition);
        const raw = await txn.Get(Keyspace.Meta, ColumnStore.SlotsKey(typeId));
        return raw === undefined ? 0 : Number(TupleCodec.Decode(raw)[0] as bigint);
    }

    public async ReadCell(txn: IReadTransaction, location: Location, member: MemberDef): Promise<CellValue>
    {
        const type = ColumnStore.RequireType(member);
        ColumnStore.RequirePartition(location.Partition);
        ColumnStore.RequireSlot(location.Slot);
        const chunk = BigInt(Math.floor(location.Slot / ChunkCodec.SlotsPerChunk));
        const inChunk = location.Slot % ChunkCodec.SlotsPerChunk;
        const deltaBytes = await txn.Get(Keyspace.Deltas, FormatKeys.Delta(location.Partition, location.TypeId, member.Id, chunk));
        if (deltaBytes !== undefined)
        {
            const hit = ChunkDelta.Find(ChunkDelta.Parse(type, deltaBytes), inChunk);
            if (hit !== undefined)
            {
                return hit.Value;
            }
        }
        const chunkBytes = await txn.Get(Keyspace.Columns, FormatKeys.Column(location.Partition, location.TypeId, member.Id, chunk));
        if (chunkBytes === undefined || inChunk >= ColumnStore.ChunkSlotCount(chunkBytes))
        {
            return null;
        }
        return ChunkCodec.ReadCell(type, chunkBytes, inChunk);
    }

    /** Records the cell in the chunk's delta (one entry per slot; a later write replaces). */
    public async WriteCell(txn: IWriteTransaction, location: Location, member: MemberDef, value: CellValue): Promise<void>
    {
        const type = ColumnStore.RequireType(member);
        ColumnStore.RequirePartition(location.Partition);
        ColumnStore.RequireSlot(location.Slot);
        if (value !== null)
        {
            ChunkCodec.EncodeValue(type, value);
        }
        const chunk = BigInt(Math.floor(location.Slot / ChunkCodec.SlotsPerChunk));
        const key = FormatKeys.Delta(location.Partition, location.TypeId, member.Id, chunk);
        const existing = await txn.Get(Keyspace.Deltas, key);
        const entries = existing === undefined ? [] : ChunkDelta.Parse(type, existing);
        const updated = ChunkDelta.With(entries, location.Slot % ChunkCodec.SlotsPerChunk, value);
        txn.Put(Keyspace.Deltas, key, ChunkDelta.Serialize(type, updated));
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
        const deltaBytes = await txn.Get(Keyspace.Deltas, FormatKeys.Delta(partition, typeId, memberId, chunk));
        if (deltaBytes !== undefined)
        {
            for (const e of ChunkDelta.Parse(type, deltaBytes))
            {
                if (e.Slot < n)
                {
                    cells[e.Slot] = e.Value;
                }
            }
        }
        return cells;
    }

    private static SlotsKey(typeId: number): Uint8Array
    {
        if (!Number.isInteger(typeId) || typeId < 0)
        {
            throw new RangeError(ColumnStore.ErrTypeId + typeId);
        }
        return FormatKeys.Meta(ColumnStore.SlotsName, typeId);
    }

    private static RequireSlot(slot: number): void
    {
        if (!Number.isInteger(slot) || slot < 0 || slot >= ColumnStore.ReservedSlot)
        {
            throw new RangeError(ColumnStore.ErrSlot + slot);
        }
    }

    private static ChunkSlotCount(chunk: Uint8Array): number
    {
        return new DataView(chunk.buffer, chunk.byteOffset, chunk.length).getUint16(1, true);
    }
}
