import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { InternalId } from './InternalId.js';
import type { Location } from './Location.js';

/**
 * Internal id to Location. The row index is global (ruling F5): blocks are keyed by block number only
 * and every entry carries its partition: (partition u32, typeId u32, slot u32) little-endian, 12 bytes;
 * unassigned iff all three are 0xFFFFFFFF. Blocks are decoded once per transaction (WeakMap keyed by
 * the txn object) and never shared across transactions, so no snapshot sees another's state. Only
 * partition 0 is accepted in v1.
 */
export class RowIndex
{
    public static readonly BlockEntries = 4096;
    public static readonly EntryBytes = 12;
    private static readonly BlockEntriesBig = BigInt(RowIndex.BlockEntries);
    private static readonly Unassigned = 0xffffffff;
    private static readonly Partition = 0;
    private static readonly TypeOffset = 4;
    private static readonly SlotOffset = 8;
    private static readonly ErrLocation = 'Invalid location (partition must be 0; type id and slot must be below 0xFFFFFFFF)';

    private readonly cache = new WeakMap<object, Map<bigint, Uint8Array>>();

    public async Locate(txn: IReadTransaction, id: bigint): Promise<Location | undefined>
    {
        InternalId.Require(id);
        const block = await this.Load(txn, id / RowIndex.BlockEntriesBig);
        const view = RowIndex.View(block);
        const offset = RowIndex.Offset(id);
        const partition = view.getUint32(offset, true);
        const typeId = view.getUint32(offset + RowIndex.TypeOffset, true);
        const slot = view.getUint32(offset + RowIndex.SlotOffset, true);
        if (partition === RowIndex.Unassigned && typeId === RowIndex.Unassigned && slot === RowIndex.Unassigned)
        {
            return undefined;
        }
        return { Partition: partition, TypeId: typeId, Slot: slot };
    }

    public async Assign(txn: IWriteTransaction, id: bigint, location: Location): Promise<void>
    {
        InternalId.Require(id);
        if (
            location.Partition !== RowIndex.Partition ||
            !RowIndex.IsU32(location.TypeId) ||
            !RowIndex.IsU32(location.Slot)
        )
        {
            throw new Error(RowIndex.ErrLocation);
        }
        await this.Write(txn, id, location.Partition, location.TypeId, location.Slot);
    }

    public async Clear(txn: IWriteTransaction, id: bigint): Promise<void>
    {
        InternalId.Require(id);
        if ((await this.Locate(txn, id)) === undefined)
        {
            return;
        }
        await this.Write(txn, id, RowIndex.Unassigned, RowIndex.Unassigned, RowIndex.Unassigned);
    }

    private async Write(txn: IWriteTransaction, id: bigint, partition: number, typeId: number, slot: number): Promise<void>
    {
        const blockNo = id / RowIndex.BlockEntriesBig;
        const block = await this.Load(txn, blockNo);
        const view = RowIndex.View(block);
        const offset = RowIndex.Offset(id);
        view.setUint32(offset, partition, true);
        view.setUint32(offset + RowIndex.TypeOffset, typeId, true);
        view.setUint32(offset + RowIndex.SlotOffset, slot, true);
        txn.Put(Keyspace.Rows, FormatKeys.RowBlock(blockNo), block.slice());
    }

    private async Load(txn: IReadTransaction, blockNo: bigint): Promise<Uint8Array>
    {
        let blocks = this.cache.get(txn);
        if (blocks === undefined)
        {
            blocks = new Map();
            this.cache.set(txn, blocks);
        }
        const cached = blocks.get(blockNo);
        if (cached !== undefined)
        {
            return cached;
        }
        const raw = await txn.Get(Keyspace.Rows, FormatKeys.RowBlock(blockNo));
        const block = raw === undefined ? RowIndex.EmptyBlock() : raw.slice();
        blocks.set(blockNo, block);
        return block;
    }

    private static Offset(id: bigint): number
    {
        return Number(id % RowIndex.BlockEntriesBig) * RowIndex.EntryBytes;
    }

    private static EmptyBlock(): Uint8Array
    {
        return new Uint8Array(RowIndex.BlockEntries * RowIndex.EntryBytes).fill(0xff);
    }

    private static View(block: Uint8Array): DataView
    {
        return new DataView(block.buffer, block.byteOffset, block.byteLength);
    }

    private static IsU32(value: number): boolean
    {
        return Number.isInteger(value) && value >= 0 && value < RowIndex.Unassigned;
    }
}
