import { ValueType } from '../catalog/ValueType.js';
import { CellValue, DateValue } from './CellValue.js';
import { ChunkCodecError } from './ChunkCodecError.js';
import { Encoding } from './Encoding.js';
import { PackedBits } from './PackedBits.js';
import { PlainLayout } from './PlainLayout.js';

/**
 * BitPacked payload. Boolean: identical to Plain (1 bit per slot). Int64 and Date: frame of reference,
 * `base i64`, `width u8` (0..63), then (value - base) packed LSB-first at `width` bits per slot; null slots pack 0.
 */
export class BitPackedLayout
{
    private static readonly HeaderBytes = 9;
    private static readonly MaxWidth = 63;
    private static readonly RangeTooWide = 'value range needs 64 bits';
    private static readonly NoReason = 'only Boolean, Int64 and Date can be bit-packed';
    private static readonly Truncated = 'bit-packed payload truncated';
    private static readonly BadWidth = 'bit width exceeds 63';

    /** Whether the type supports BitPacked at all. */
    public static Supports(type: ValueType): boolean
    {
        return type === ValueType.Boolean || type === ValueType.Int64 || type === ValueType.Date;
    }

    /** Frame-of-reference parameters, or null when the range needs 64 bits. Cells must be integer-like. */
    public static Plan(type: ValueType, cells: readonly CellValue[]): { Base: bigint; Width: number } | null
    {
        let min: bigint | null = null;
        let max: bigint | null = null;
        for (const c of cells)
        {
            if (c === null)
            {
                continue;
            }
            const v = BitPackedLayout.ToBigInt(type, c);
            min = min === null || v < min ? v : min;
            max = max === null || v > max ? v : max;
        }
        if (min === null || max === null)
        {
            return { Base: 0n, Width: 0 };
        }
        const width = PackedBits.WidthFor(max - min);
        return width > BitPackedLayout.MaxWidth ? null : { Base: min, Width: width };
    }

    public static Write(type: ValueType, cells: readonly CellValue[]): Uint8Array
    {
        if (type === ValueType.Boolean)
        {
            return PlainLayout.Write(type, cells);
        }
        if (!BitPackedLayout.Supports(type))
        {
            throw ChunkCodecError.NotApplicable(type, Encoding.BitPacked, BitPackedLayout.NoReason);
        }
        const plan = BitPackedLayout.Plan(type, cells);
        if (plan === null)
        {
            throw ChunkCodecError.NotApplicable(type, Encoding.BitPacked, BitPackedLayout.RangeTooWide);
        }
        const packed = PackedBits.Pack(cells.map(c => (c === null ? 0n : BitPackedLayout.ToBigInt(type, c) - plan.Base)), plan.Width);
        const out = new Uint8Array(BitPackedLayout.HeaderBytes + packed.length);
        const view = new DataView(out.buffer);
        view.setBigInt64(0, plan.Base, true);
        out[8] = plan.Width;
        out.set(packed, BitPackedLayout.HeaderBytes);
        return out;
    }

    public static Read(type: ValueType, payload: Uint8Array, count: number, slot: number): CellValue
    {
        if (type === ValueType.Boolean)
        {
            return PlainLayout.Read(type, payload, count, slot);
        }
        if (!BitPackedLayout.Supports(type))
        {
            throw ChunkCodecError.NotApplicable(type, Encoding.BitPacked, BitPackedLayout.NoReason);
        }
        if (payload.length < BitPackedLayout.HeaderBytes)
        {
            throw ChunkCodecError.Corrupt(BitPackedLayout.Truncated);
        }
        const width = payload[8]!;
        if (width > BitPackedLayout.MaxWidth)
        {
            throw ChunkCodecError.Corrupt(BitPackedLayout.BadWidth);
        }
        if (payload.length < BitPackedLayout.HeaderBytes + PackedBits.ByteLength(slot + 1, width))
        {
            throw ChunkCodecError.Corrupt(BitPackedLayout.Truncated);
        }
        const base = new DataView(payload.buffer, payload.byteOffset, payload.length).getBigInt64(0, true);
        const value = base + PackedBits.Read(payload.subarray(BitPackedLayout.HeaderBytes), slot, width);
        if (type === ValueType.Int64)
        {
            if (BigInt.asIntN(64, value) !== value)
            {
                throw ChunkCodecError.Corrupt(BitPackedLayout.BadWidth);
            }
            return value;
        }
        if (BigInt.asIntN(32, value) !== value)
        {
            throw ChunkCodecError.Corrupt(BitPackedLayout.BadWidth);
        }
        return new DateValue(Number(value));
    }

    /** Exact byte length the payload must have for `count` slots. */
    public static ExactLength(type: ValueType, payload: Uint8Array, count: number): number
    {
        if (type === ValueType.Boolean)
        {
            return PlainLayout.ExactLength(type, payload, count);
        }
        if (payload.length < BitPackedLayout.HeaderBytes)
        {
            throw ChunkCodecError.Corrupt(BitPackedLayout.Truncated);
        }
        const width = payload[8]!;
        if (width > BitPackedLayout.MaxWidth)
        {
            throw ChunkCodecError.Corrupt(BitPackedLayout.BadWidth);
        }
        return BitPackedLayout.HeaderBytes + PackedBits.ByteLength(count, width);
    }

    private static ToBigInt(type: ValueType, cell: CellValue): bigint
    {
        switch (type)
        {
            case ValueType.Boolean:
                return cell === true ? 1n : 0n;
            case ValueType.Int64:
                return cell as bigint;
            default:
                return BigInt((cell as DateValue).Days);
        }
    }
}
