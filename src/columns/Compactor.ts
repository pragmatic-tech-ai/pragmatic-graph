import type { MemberDef } from '../catalog/CatalogTypes.js';
import { FormatKeys } from '../format/FormatKeys.js';
import type { IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { CellValue } from './CellValue.js';
import { ChunkCodec } from './ChunkCodec.js';
import { ChunkDelta } from './ChunkDelta.js';
import { ColumnStore } from './ColumnStore.js';

/** Folds a chunk's delta into its column chunk (re-encoded with the best encoding) and deletes the delta. */
export class Compactor
{
    public async CompactChunk(txn: IWriteTransaction, partition: number, typeId: number, member: MemberDef, chunk: bigint): Promise<void>
    {
        const type = ColumnStore.RequireType(member);
        ColumnStore.RequirePartition(partition);
        const deltaKey = FormatKeys.Delta(partition, typeId, member.Id, chunk);
        const deltaBytes = await txn.Get(Keyspace.Deltas, deltaKey);
        if (deltaBytes === undefined)
        {
            return;
        }
        const entries = ChunkDelta.Parse(type, deltaBytes);
        const columnKey = FormatKeys.Column(partition, typeId, member.Id, chunk);
        const chunkBytes = await txn.Get(Keyspace.Columns, columnKey);
        const cells: CellValue[] = chunkBytes === undefined ? [] : ChunkCodec.DecodeAll(type, chunkBytes);
        const needed = entries.length === 0 ? 0 : entries[entries.length - 1]!.Slot + 1;
        while (cells.length < needed)
        {
            cells.push(null);
        }
        for (const e of entries)
        {
            cells[e.Slot] = e.Value;
        }
        if (cells.length > 0)
        {
            txn.Put(Keyspace.Columns, columnKey, ChunkCodec.Encode(type, cells, ChunkCodec.ChooseEncoding(type, cells)));
        }
        txn.Delete(Keyspace.Deltas, deltaKey);
    }
}
