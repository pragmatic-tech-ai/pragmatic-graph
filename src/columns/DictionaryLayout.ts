import { ValueType } from '../catalog/ValueType.js';
import { CellValue, DateTimeValue, DateValue, DurationValue } from './CellValue.js';
import { ChunkCodecError } from './ChunkCodecError.js';
import { Encoding } from './Encoding.js';
import { PackedBits } from './PackedBits.js';
import { PlainLayout } from './PlainLayout.js';

/**
 * Dictionary payload: `dictCount u16`, `codeWidth u8` (bits, 0 when dictCount <= 1), codes packed LSB-first
 * (null slots use code 0), then the dictionary as a Plain payload of dictCount distinct non-null values
 * in order of first appearance. Applies to every type except Boolean.
 */
export class DictionaryLayout
{
    private static readonly HeaderBytes = 3;
    private static readonly MaxWidth = 11;
    private static readonly Float64Bits = new DataView(new ArrayBuffer(8));
    private static readonly BooleanReason = 'a boolean needs one bit; the dictionary cannot help';
    private static readonly Truncated = 'dictionary payload truncated';
    private static readonly BadWidth = 'dictionary code width is invalid';
    private static readonly BadCode = 'dictionary code outside dictionary';
    private static readonly NaNKey = 'NaN';
    private static readonly KeySeparator = '|';

    public static Supports(type: ValueType): boolean
    {
        return type !== ValueType.Boolean;
    }

    public static Write(type: ValueType, cells: readonly CellValue[]): Uint8Array
    {
        if (!DictionaryLayout.Supports(type))
        {
            throw ChunkCodecError.NotApplicable(type, Encoding.Dictionary, DictionaryLayout.BooleanReason);
        }
        const dictionary: CellValue[] = [];
        const codes = new Map<string | bigint | number, number>();
        const slotCodes = cells.map(c =>
        {
            if (c === null)
            {
                return 0n;
            }
            const key = DictionaryLayout.Key(type, c);
            let code = codes.get(key);
            if (code === undefined)
            {
                code = dictionary.length;
                codes.set(key, code);
                dictionary.push(c);
            }
            return BigInt(code);
        });
        const width = dictionary.length <= 1 ? 0 : PackedBits.WidthFor(BigInt(dictionary.length - 1));
        const packed = PackedBits.Pack(slotCodes, width);
        const plain = PlainLayout.Write(type, dictionary);
        const out = new Uint8Array(DictionaryLayout.HeaderBytes + packed.length + plain.length);
        new DataView(out.buffer).setUint16(0, dictionary.length, true);
        out[2] = width;
        out.set(packed, DictionaryLayout.HeaderBytes);
        out.set(plain, DictionaryLayout.HeaderBytes + packed.length);
        return out;
    }

    public static Read(type: ValueType, payload: Uint8Array, count: number, slot: number): CellValue
    {
        if (!DictionaryLayout.Supports(type))
        {
            throw ChunkCodecError.NotApplicable(type, Encoding.Dictionary, DictionaryLayout.BooleanReason);
        }
        if (payload.length < DictionaryLayout.HeaderBytes)
        {
            throw ChunkCodecError.Corrupt(DictionaryLayout.Truncated);
        }
        const dictCount = new DataView(payload.buffer, payload.byteOffset, payload.length).getUint16(0, true);
        const width = payload[2]!;
        if (width > DictionaryLayout.MaxWidth)
        {
            throw ChunkCodecError.Corrupt(DictionaryLayout.BadWidth);
        }
        const codesBytes = PackedBits.ByteLength(count, width);
        if (payload.length < DictionaryLayout.HeaderBytes + PackedBits.ByteLength(slot + 1, width))
        {
            throw ChunkCodecError.Corrupt(DictionaryLayout.Truncated);
        }
        const code = Number(PackedBits.Read(payload.subarray(DictionaryLayout.HeaderBytes), slot, width));
        if (code >= dictCount)
        {
            throw ChunkCodecError.Corrupt(DictionaryLayout.BadCode);
        }
        return PlainLayout.Read(type, payload.subarray(DictionaryLayout.HeaderBytes + codesBytes), dictCount, code);
    }

    /** Exact byte length the payload must have for `count` slots. */
    public static ExactLength(type: ValueType, payload: Uint8Array, count: number): number
    {
        if (payload.length < DictionaryLayout.HeaderBytes)
        {
            throw ChunkCodecError.Corrupt(DictionaryLayout.Truncated);
        }
        const dictCount = new DataView(payload.buffer, payload.byteOffset, payload.length).getUint16(0, true);
        const width = payload[2]!;
        if (width > DictionaryLayout.MaxWidth)
        {
            throw ChunkCodecError.Corrupt(DictionaryLayout.BadWidth);
        }
        const before = DictionaryLayout.HeaderBytes + PackedBits.ByteLength(count, width);
        return before + PlainLayout.ExactLength(type, payload.subarray(before), dictCount);
    }

    /** Equality key: Float64 compares by bit pattern so -0 and 0 stay distinct. */
    private static Key(type: ValueType, cell: CellValue): string | bigint | number
    {
        switch (type)
        {
            case ValueType.Int64:
                return cell as bigint;
            case ValueType.String:
                return cell as string;
            case ValueType.Float64:
            {
                if (Number.isNaN(cell as number))
                {
                    return DictionaryLayout.NaNKey;
                }
                DictionaryLayout.Float64Bits.setFloat64(0, cell as number, true);
                return DictionaryLayout.Float64Bits.getBigUint64(0, true).toString();
            }
            case ValueType.Date:
                return (cell as DateValue).Days;
            case ValueType.DateTime:
                return `${(cell as DateTimeValue).Micros}${DictionaryLayout.KeySeparator}${(cell as DateTimeValue).Zone}`;
            default:
            {
                const d = cell as DurationValue;
                return `${d.Months}${DictionaryLayout.KeySeparator}${d.Days}${DictionaryLayout.KeySeparator}${d.Micros}`;
            }
        }
    }
}
