import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { InternalId } from './InternalId.js';
import type { Location } from './Location.js';

/** A row block decoded for one transaction; Dirty while it holds writes Flush has not yet persisted. */
class LoadedBlock
{
    public Dirty = false;

    public constructor(public readonly Number: bigint, public readonly Bytes: Uint8Array)
    {
    }
}

/**
 * Internal id to Location. The row index is global (ruling F5): blocks are keyed by block number only
 * and every entry carries its partition: (partition u32, typeId u32, slot u32) little-endian, 12 bytes;
 * unassigned iff all three are 0xFFFFFFFF. A block holds 512 entries (6,144 bytes), independent of the
 * 4,096-id allocation block; a missing block is all unassigned (ruling F6).
 *
 * Blocks are decoded once per transaction (WeakMap keyed by the txn object) and never shared across
 * transactions, so no snapshot sees another's state. Within a write transaction Assign and Clear only
 * change the decoded block and mark it dirty; Flush(txn) writes each dirty block once. The caller MUST
 * call Flush before the transaction commits (the committer does, then AssertFlushed), as with
 * ColumnStore. Only partition 0 is accepted in v1.
 */
export class RowIndex
{
    public static readonly BlockEntries = 512;
    public static readonly EntryBytes = 12;
    private static readonly BlockEntriesBig = BigInt(RowIndex.BlockEntries);
    private static readonly Unassigned = 0xffffffff;
    private static readonly Partition = 0;
    private static readonly TypeOffset = 4;
    private static readonly SlotOffset = 8;
    private static readonly ErrLocation = 'Invalid location (partition must be 0; type id and slot must be below 0xFFFFFFFF)';
    private static readonly ErrUnflushed = 'Row index has pending block writes: call Flush(txn) before commit';

    private readonly cache = new WeakMap<object, Map<bigint, LoadedBlock>>();

    public async Locate(txn: IReadTransaction, id: bigint): Promise<Location | undefined>
    {
        InternalId.Require(id);
        const view = RowIndex.View((await this.Load(txn, id / RowIndex.BlockEntriesBig)).Bytes);
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

    /** True when this write transaction holds block writes that Flush has not yet persisted. */
    public HasPendingWrites(txn: IWriteTransaction): boolean
    {
        for (const block of this.cache.get(txn)?.values() ?? [])
        {
            if (block.Dirty)
            {
                return true;
            }
        }
        return false;
    }

    /** Writes every dirty block once. Idempotent; a later Assign or Clear marks its block dirty again. */
    public Flush(txn: IWriteTransaction): void
    {
        for (const block of this.cache.get(txn)?.values() ?? [])
        {
            if (block.Dirty)
            {
                txn.Put(Keyspace.Rows, FormatKeys.RowBlock(block.Number), block.Bytes);
                block.Dirty = false;
            }
        }
    }

    /** Throws unless every write of this transaction has been flushed; for the committer to call just before commit. */
    public AssertFlushed(txn: IWriteTransaction): void
    {
        if (this.HasPendingWrites(txn))
        {
            throw new GraphError(GraphErrorCode.Internal, RowIndex.ErrUnflushed);
        }
    }

    private async Write(txn: IWriteTransaction, id: bigint, partition: number, typeId: number, slot: number): Promise<void>
    {
        const block = await this.Load(txn, id / RowIndex.BlockEntriesBig);
        const view = RowIndex.View(block.Bytes);
        const offset = RowIndex.Offset(id);
        view.setUint32(offset, partition, true);
        view.setUint32(offset + RowIndex.TypeOffset, typeId, true);
        view.setUint32(offset + RowIndex.SlotOffset, slot, true);
        block.Dirty = true;
    }

    private async Load(txn: IReadTransaction, blockNo: bigint): Promise<LoadedBlock>
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
        // A concurrent Load of the same block may have finished first: keep its (possibly written) copy.
        const winner = blocks.get(blockNo);
        if (winner !== undefined)
        {
            return winner;
        }
        const block = new LoadedBlock(blockNo, raw === undefined ? RowIndex.EmptyBlock() : raw);
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
