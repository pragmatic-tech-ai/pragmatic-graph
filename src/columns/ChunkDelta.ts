import { ValueType } from '../catalog/ValueType.js';
import { CellValue } from './CellValue.js';
import { ChunkCodec } from './ChunkCodec.js';
import { ChunkCodecError } from './ChunkCodecError.js';
import { ValueCodec } from './ValueCodec.js';

/** One overlaid cell: the slot within its chunk and the value (null = the cell is null). */
export interface IDeltaEntry
{
    readonly Slot: number;
    readonly Value: CellValue;
}

/**
 * Codec for a chunk's delta: concatenated `(slot u16 LE, present u8, value)` entries in ascending
 * slot order, at most one per slot. See docs/format/on-disk-format.md (Deltas).
 */
export class ChunkDelta
{
    private static readonly SlotBytes = 2;
    private static readonly HeaderBytes = 3;
    private static readonly Absent = 0;
    private static readonly Present = 1;
    private static readonly TruncatedEntry = 'delta entry truncated';
    private static readonly BadPresent = 'delta present flag is not 0 or 1';
    private static readonly BadOrder = 'delta entries are not in strictly ascending slot order';
    private static readonly BadSlot = 'delta slot is not within the chunk';

    public static Parse(type: ValueType, bytes: Uint8Array): IDeltaEntry[]
    {
        const entries: IDeltaEntry[] = [];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        let at = 0;
        while (at < bytes.length)
        {
            if (at + ChunkDelta.HeaderBytes > bytes.length)
            {
                throw ChunkCodecError.Corrupt(ChunkDelta.TruncatedEntry);
            }
            const slot = view.getUint16(at, true);
            const present = bytes[at + ChunkDelta.SlotBytes];
            at += ChunkDelta.HeaderBytes;
            if (slot >= ChunkCodec.SlotsPerChunk)
            {
                throw ChunkCodecError.Corrupt(ChunkDelta.BadSlot);
            }
            if (entries.length > 0 && entries[entries.length - 1]!.Slot >= slot)
            {
                throw ChunkCodecError.Corrupt(ChunkDelta.BadOrder);
            }
            if (present === ChunkDelta.Absent)
            {
                entries.push({ Slot: slot, Value: null });
            }
            else if (present === ChunkDelta.Present)
            {
                const decoded = ValueCodec.DecodeAt(type, bytes, at);
                at = decoded.End;
                entries.push({ Slot: slot, Value: decoded.Value });
            }
            else
            {
                throw ChunkCodecError.Corrupt(ChunkDelta.BadPresent);
            }
        }
        return entries;
    }

    /** Entries must already be sorted by slot with no duplicates. */
    public static Serialize(type: ValueType, entries: readonly IDeltaEntry[]): Uint8Array
    {
        const parts: Uint8Array[] = [];
        let total = 0;
        for (const e of entries)
        {
            const value = e.Value === null ? new Uint8Array(0) : ChunkCodec.EncodeValue(type, e.Value);
            const part = new Uint8Array(ChunkDelta.HeaderBytes + value.length);
            new DataView(part.buffer).setUint16(0, e.Slot, true);
            part[ChunkDelta.SlotBytes] = e.Value === null ? ChunkDelta.Absent : ChunkDelta.Present;
            part.set(value, ChunkDelta.HeaderBytes);
            parts.push(part);
            total += part.length;
        }
        const out = new Uint8Array(total);
        let at = 0;
        for (const p of parts)
        {
            out.set(p, at);
            at += p.length;
        }
        return out;
    }

    /** Returns a new sorted list with the slot's entry added or replaced. */
    public static With(entries: readonly IDeltaEntry[], slot: number, value: CellValue): IDeltaEntry[]
    {
        const out = entries.filter(e => e.Slot !== slot);
        out.push({ Slot: slot, Value: value });
        out.sort((a, b) => a.Slot - b.Slot);
        return out;
    }

    /** Finds the entry for a slot, or undefined when the delta does not touch it. */
    public static Find(entries: readonly IDeltaEntry[], slot: number): IDeltaEntry | undefined
    {
        return entries.find(e => e.Slot === slot);
    }
}
