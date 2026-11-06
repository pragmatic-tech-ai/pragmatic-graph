import { ValueType } from '../catalog/ValueType.js';
import { CellValue, DateTimeValue, DateValue, DurationValue } from './CellValue.js';
import { ChunkCodecError } from './ChunkCodecError.js';
import { PackedBits } from './PackedBits.js';
import { ValueCodec } from './ValueCodec.js';

/**
 * Plain payload: one fixed slot per cell, O(1) random access. Null cells (and dictionary-free
 * placeholders) occupy their slot with zero bytes. Cells passed to Write are already validated.
 */
export class PlainLayout
{
    private static readonly Truncated = 'plain payload truncated';
    private static readonly BadOffsets = 'string offsets are not monotonic';
    private static readonly BadZoneIndex = 'zone index outside zone table';

    public static Write(type: ValueType, cells: readonly CellValue[]): Uint8Array
    {
        const n = cells.length;
        switch (type)
        {
            case ValueType.Boolean:
                return PackedBits.Pack(cells.map(c => (c === true ? 1n : 0n)), 1);
            case ValueType.Int64:
            {
                const out = new Uint8Array(8 * n);
                const view = new DataView(out.buffer);
                cells.forEach((c, i) => view.setBigInt64(8 * i, (c as bigint | null) ?? 0n, true));
                return out;
            }
            case ValueType.Float64:
            {
                const out = new Uint8Array(8 * n);
                const view = new DataView(out.buffer);
                cells.forEach((c, i) => view.setFloat64(8 * i, (c as number | null) ?? 0, true));
                return out;
            }
            case ValueType.Date:
            {
                const out = new Uint8Array(4 * n);
                const view = new DataView(out.buffer);
                cells.forEach((c, i) => view.setInt32(4 * i, c === null ? 0 : (c as DateValue).Days, true));
                return out;
            }
            case ValueType.Duration:
            {
                const out = new Uint8Array(16 * n);
                const view = new DataView(out.buffer);
                cells.forEach((c, i) =>
                {
                    const d = c as DurationValue | null;
                    view.setInt32(16 * i, d === null ? 0 : d.Months, true);
                    view.setInt32(16 * i + 4, d === null ? 0 : d.Days, true);
                    view.setBigInt64(16 * i + 8, d === null ? 0n : d.Micros, true);
                });
                return out;
            }
            case ValueType.String:
                return PlainLayout.WriteStrings(cells as readonly (string | null)[]);
            default:
                return PlainLayout.WriteDateTimes(cells as readonly (DateTimeValue | null)[]);
        }
    }

    /** Reads one non-null cell. `payload` holds exactly `count` slots. */
    public static Read(type: ValueType, payload: Uint8Array, count: number, slot: number): CellValue
    {
        const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
        switch (type)
        {
            case ValueType.Boolean:
                PlainLayout.Need(payload, Math.floor(slot / 8) + 1);
                return ((payload[Math.floor(slot / 8)]! >> (slot % 8)) & 1) === 1;
            case ValueType.Int64:
                PlainLayout.Need(payload, 8 * (slot + 1));
                return view.getBigInt64(8 * slot, true);
            case ValueType.Float64:
                PlainLayout.Need(payload, 8 * (slot + 1));
                return view.getFloat64(8 * slot, true);
            case ValueType.Date:
                PlainLayout.Need(payload, 4 * (slot + 1));
                return new DateValue(view.getInt32(4 * slot, true));
            case ValueType.Duration:
                PlainLayout.Need(payload, 16 * (slot + 1));
                return new DurationValue(view.getInt32(16 * slot, true), view.getInt32(16 * slot + 4, true), view.getBigInt64(16 * slot + 8, true));
            case ValueType.String:
                return PlainLayout.ReadString(payload, view, count, slot);
            default:
                return PlainLayout.ReadDateTime(payload, view, count, slot);
        }
    }

    private static WriteStrings(cells: readonly (string | null)[]): Uint8Array
    {
        const n = cells.length;
        const texts = cells.map(c => (c === null ? new Uint8Array(0) : ValueCodec.EncodeText(c)));
        const heap = texts.reduce((sum, t) => sum + t.length, 0);
        const out = new Uint8Array(4 * n + heap);
        const view = new DataView(out.buffer);
        let end = 0;
        texts.forEach((t, i) =>
        {
            out.set(t, 4 * n + end);
            end += t.length;
            view.setUint32(4 * i, end, true);
        });
        return out;
    }

    private static ReadString(payload: Uint8Array, view: DataView, count: number, slot: number): string
    {
        PlainLayout.Need(payload, 4 * count);
        const start = slot === 0 ? 0 : view.getUint32(4 * (slot - 1), true);
        const end = view.getUint32(4 * slot, true);
        if (start > end)
        {
            throw ChunkCodecError.Corrupt(PlainLayout.BadOffsets);
        }
        PlainLayout.Need(payload, 4 * count + end);
        return ValueCodec.DecodeText(payload.subarray(4 * count + start, 4 * count + end));
    }

    /** micros i64[n], zoneIndex u16[n], zoneCount u16, zoneEnd u32[zoneCount], zone UTF-8 heap. */
    private static WriteDateTimes(cells: readonly (DateTimeValue | null)[]): Uint8Array
    {
        const n = cells.length;
        const zones: string[] = [];
        const zoneIds = new Map<string, number>();
        for (const c of cells)
        {
            if (c !== null && !zoneIds.has(c.Zone))
            {
                zoneIds.set(c.Zone, zones.length);
                zones.push(c.Zone);
            }
        }
        const zoneBytes = zones.map(z => ValueCodec.EncodeText(z));
        const heap = zoneBytes.reduce((sum, z) => sum + z.length, 0);
        const tableAt = 10 * n;
        const out = new Uint8Array(tableAt + 2 + 4 * zones.length + heap);
        const view = new DataView(out.buffer);
        cells.forEach((c, i) =>
        {
            view.setBigInt64(8 * i, c === null ? 0n : c.Micros, true);
            view.setUint16(8 * n + 2 * i, c === null ? 0 : (zoneIds.get(c.Zone) as number), true);
        });
        view.setUint16(tableAt, zones.length, true);
        let end = 0;
        zoneBytes.forEach((z, k) =>
        {
            out.set(z, tableAt + 2 + 4 * zones.length + end);
            end += z.length;
            view.setUint32(tableAt + 2 + 4 * k, end, true);
        });
        return out;
    }

    private static ReadDateTime(payload: Uint8Array, view: DataView, count: number, slot: number): DateTimeValue
    {
        const tableAt = 10 * count;
        PlainLayout.Need(payload, tableAt + 2);
        const zoneCount = view.getUint16(tableAt, true);
        const zone = view.getUint16(8 * count + 2 * slot, true);
        if (zone >= zoneCount)
        {
            throw ChunkCodecError.Corrupt(PlainLayout.BadZoneIndex);
        }
        const endsAt = tableAt + 2;
        const heapAt = endsAt + 4 * zoneCount;
        PlainLayout.Need(payload, heapAt);
        const start = zone === 0 ? 0 : view.getUint32(endsAt + 4 * (zone - 1), true);
        const end = view.getUint32(endsAt + 4 * zone, true);
        if (start > end)
        {
            throw ChunkCodecError.Corrupt(PlainLayout.BadOffsets);
        }
        PlainLayout.Need(payload, heapAt + end);
        const name = ValueCodec.DecodeText(payload.subarray(heapAt + start, heapAt + end));
        return new DateTimeValue(view.getBigInt64(8 * slot, true), name);
    }

    private static Need(payload: Uint8Array, length: number): void
    {
        if (payload.length < length)
        {
            throw ChunkCodecError.Corrupt(PlainLayout.Truncated);
        }
    }
}
