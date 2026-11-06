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
                const decoded = ValueCodec.DecodeAt(type, bytes, at, view);
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

    /** Entries must already be sorted by slot with no duplicates. Encodes (and so validates) each value once. */
    public static Serialize(type: ValueType, entries: readonly IDeltaEntry[]): Uint8Array
    {
        const values: Array<Uint8Array | null> = [];
        let total = 0;
        for (const e of entries)
        {
            const value = e.Value === null ? null : ChunkCodec.EncodeValue(type, e.Value);
            values.push(value);
            total += ChunkDelta.HeaderBytes + (value === null ? 0 : value.length);
        }
        const out = new Uint8Array(total);
        const view = new DataView(out.buffer);
        let at = 0;
        for (let i = 0; i < entries.length; i++)
        {
            const value = values[i]!;
            view.setUint16(at, entries[i]!.Slot, true);
            out[at + ChunkDelta.SlotBytes] = value === null ? ChunkDelta.Absent : ChunkDelta.Present;
            at += ChunkDelta.HeaderBytes;
            if (value !== null)
            {
                out.set(value, at);
                at += value.length;
            }
        }
        return out;
    }

    /**
     * Finds one slot's entry by walking the framing only (slot, present, value length), stopping once past
     * the slot, and decoding just the hit. Entries are sorted, so no later entry can match.
     */
    public static Lookup(type: ValueType, bytes: Uint8Array, slot: number): IDeltaEntry | undefined
    {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        let at = 0;
        while (at < bytes.length)
        {
            if (at + ChunkDelta.HeaderBytes > bytes.length)
            {
                throw ChunkCodecError.Corrupt(ChunkDelta.TruncatedEntry);
            }
            const entrySlot = view.getUint16(at, true);
            const present = bytes[at + ChunkDelta.SlotBytes];
            at += ChunkDelta.HeaderBytes;
            if (entrySlot > slot)
            {
                return undefined;
            }
            if (present === ChunkDelta.Absent)
            {
                if (entrySlot === slot)
                {
                    return { Slot: slot, Value: null };
                }
            }
            else if (present === ChunkDelta.Present)
            {
                if (entrySlot === slot)
                {
                    return { Slot: slot, Value: ValueCodec.DecodeAt(type, bytes, at, view).Value };
                }
                at += ValueCodec.ValueLength(type, bytes, at, view);
            }
            else
            {
                throw ChunkCodecError.Corrupt(ChunkDelta.BadPresent);
            }
        }
        return undefined;
    }
}
