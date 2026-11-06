import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { PublicIdIndex } from './PublicIdIndex.js';
import type { Location } from './Location.js';

/**
 * Internal id to Location. Row blocks (4,096 entries of typeId u32, slot u32 LE) are decoded
 * once per transaction (WeakMap keyed by the txn object) and never shared across transactions,
 * so no snapshot sees another's state. Partition is always 0 in v1.
 */
export class RowIndex
{
    private static readonly BlockEntries = 4096;
    private static readonly BlockEntriesBig = 4096n;
    private static readonly EntryBytes = 8;
    private static readonly Unassigned = 0xffffffff;
    private static readonly Partition = 0;
    private static readonly ErrLocation = 'Invalid location (partition must be 0; type id and slot must be below 0xFFFFFFFF)';

    private readonly cache = new WeakMap<object, Map<bigint, Uint8Array>>();

    public async Locate(txn: IReadTransaction, id: bigint): Promise<Location | undefined>
    {
        RowIndex.RequireId(id);
        const block = await this.Load(txn, id / RowIndex.BlockEntriesBig);
        const view = RowIndex.View(block);
        const offset = Number(id % RowIndex.BlockEntriesBig) * RowIndex.EntryBytes;
        const typeId = view.getUint32(offset, true);
        const slot = view.getUint32(offset + 4, true);
        if (typeId === RowIndex.Unassigned && slot === RowIndex.Unassigned)
        {
            return undefined;
        }
        return { Partition: RowIndex.Partition, TypeId: typeId, Slot: slot };
    }

    public async Assign(txn: IWriteTransaction, id: bigint, location: Location): Promise<void>
    {
        RowIndex.RequireId(id);
        if (
            location.Partition !== RowIndex.Partition ||
            !RowIndex.IsU32(location.TypeId) ||
            !RowIndex.IsU32(location.Slot)
        )
        {
            throw new Error(RowIndex.ErrLocation);
        }
        await this.Write(txn, id, location.TypeId, location.Slot);
    }

    public async Clear(txn: IWriteTransaction, id: bigint): Promise<void>
    {
        RowIndex.RequireId(id);
        if ((await this.Locate(txn, id)) === undefined)
        {
            return;
        }
        await this.Write(txn, id, RowIndex.Unassigned, RowIndex.Unassigned);
    }

    private async Write(txn: IWriteTransaction, id: bigint, typeId: number, slot: number): Promise<void>
    {
        const blockNo = id / RowIndex.BlockEntriesBig;
        const block = await this.Load(txn, blockNo);
        const view = RowIndex.View(block);
        const offset = Number(id % RowIndex.BlockEntriesBig) * RowIndex.EntryBytes;
        view.setUint32(offset, typeId, true);
        view.setUint32(offset + 4, slot, true);
        txn.Put(Keyspace.Rows, FormatKeys.RowBlock(RowIndex.Partition, blockNo), block.slice());
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
        const raw = await txn.Get(Keyspace.Rows, FormatKeys.RowBlock(RowIndex.Partition, blockNo));
        const block = raw === undefined ? RowIndex.EmptyBlock() : raw.slice();
        blocks.set(blockNo, block);
        return block;
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

    private static RequireId(id: bigint): void
    {
        PublicIdIndex.RequireId(id);
    }
}
