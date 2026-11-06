import type { MemberDef } from '../catalog/CatalogTypes.js';
import { FormatKeys } from '../format/FormatKeys.js';
import type { IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { CellValue } from './CellValue.js';
import { ChunkCodec } from './ChunkCodec.js';
import { ColumnStore } from './ColumnStore.js';

/**
 * Folds a chunk's delta into its column chunk (re-encoded with the best encoding) and deletes the delta.
 * Works through the ColumnStore it is given, so same-transaction pending writes are included.
 */
export class Compactor
{
    public constructor(private readonly columns: ColumnStore)
    {
    }

    public async CompactChunk(txn: IWriteTransaction, partition: number, typeId: number, member: MemberDef, chunk: bigint): Promise<void>
    {
        const type = ColumnStore.RequireType(member);
        const entries = await this.columns.TakeDelta(txn, partition, typeId, member, chunk);
        if (entries === undefined)
        {
            return;
        }
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
    }
}
