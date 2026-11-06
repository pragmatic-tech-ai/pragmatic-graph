import { ValueType } from '../catalog/ValueType.js';
import { CellValue, DateTimeValue, DateValue, DurationValue } from './CellValue.js';
import { ChunkCodecError } from './ChunkCodecError.js';

/** Result of decoding one self-delimiting value from a larger buffer. */
export interface DecodedValue
{
    Value: CellValue;
    End: number;
}

/**
 * Validation and single-value byte format shared by chunk payloads and delta entries.
 * A value is self-delimiting so delta entries can be concatenated.
 */
export class ValueCodec
{
    private static readonly Encoder = new TextEncoder();
    private static readonly Decoder = new TextDecoder('utf-8', { fatal: true });
    private static readonly LoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    private static readonly MinI32 = -2147483648;
    private static readonly MaxI32 = 2147483647;
    private static readonly MaxU16 = 65535;
    private static readonly TruncatedValue = 'truncated value';
    private static readonly BadBoolean = 'boolean byte is not 0 or 1';
    private static readonly BadUtf8 = 'invalid UTF-8 text';
    private static readonly EmptyZone = 'zone name is empty';
    private static readonly TrailingBytes = 'trailing bytes after value';
    private static readonly UnknownType = 'unknown column type';
    private static readonly NullHasNoBytes = 'null has no value bytes';
    private static readonly ExpectedBoolean = 'expected boolean';
    private static readonly ExpectedBigInt = 'expected bigint';
    private static readonly ExpectedNumber = 'expected number';
    private static readonly ExpectedString = 'expected string';
    private static readonly ExpectedDate = 'expected DateValue';
    private static readonly ExpectedDateTime = 'expected DateTimeValue';
    private static readonly ExpectedDuration = 'expected DurationValue';
    private static readonly OutOfI64 = 'out of signed 64-bit range';
    private static readonly MicrosOutOfI64 = 'Micros out of signed 64-bit range';
    private static readonly LoneSurrogateString = 'string contains a lone surrogate';
    private static readonly LoneSurrogateZone = 'zone contains a lone surrogate';
    private static readonly ZoneTooLong = 'zone name too long';
    private static readonly NotI32Suffix = 'is not a signed 32-bit integer';
    private static readonly FieldDays = 'Days';
    private static readonly FieldMonths = 'Months';
    private static readonly CanonicalNaNHigh = 0x7FF80000;

    /** Throws ChunkCodecError unless the (non-null) value is valid for the type. */
    public static Check(type: ValueType, value: CellValue): void
    {
        switch (type)
        {
            case ValueType.Boolean:
                ValueCodec.Require(typeof value === 'boolean', type, ValueCodec.ExpectedBoolean);
                return;
            case ValueType.Int64:
                ValueCodec.Require(typeof value === 'bigint', type, ValueCodec.ExpectedBigInt);
                ValueCodec.Require(BigInt.asIntN(64, value as bigint) === value, type, ValueCodec.OutOfI64);
                return;
            case ValueType.Float64:
                ValueCodec.Require(typeof value === 'number', type, ValueCodec.ExpectedNumber);
                return;
            case ValueType.String:
                ValueCodec.Require(typeof value === 'string', type, ValueCodec.ExpectedString);
                ValueCodec.Require(!ValueCodec.LoneSurrogate.test(value as string), type, ValueCodec.LoneSurrogateString);
                return;
            case ValueType.Date:
                ValueCodec.Require(value instanceof DateValue, type, ValueCodec.ExpectedDate);
                ValueCodec.RequireI32((value as DateValue).Days, type, ValueCodec.FieldDays);
                return;
            case ValueType.DateTime:
            {
                ValueCodec.Require(value instanceof DateTimeValue, type, ValueCodec.ExpectedDateTime);
                const dt = value as DateTimeValue;
                ValueCodec.Require(typeof dt.Micros === 'bigint' && BigInt.asIntN(64, dt.Micros) === dt.Micros, type, ValueCodec.MicrosOutOfI64);
                ValueCodec.Require(typeof dt.Zone === 'string' && dt.Zone.length > 0, type, ValueCodec.EmptyZone);
                ValueCodec.Require(!ValueCodec.LoneSurrogate.test(dt.Zone), type, ValueCodec.LoneSurrogateZone);
                ValueCodec.Require(ValueCodec.Encoder.encode(dt.Zone).length <= ValueCodec.MaxU16, type, ValueCodec.ZoneTooLong);
                return;
            }
            case ValueType.Duration:
            {
                ValueCodec.Require(value instanceof DurationValue, type, ValueCodec.ExpectedDuration);
                const du = value as DurationValue;
                ValueCodec.RequireI32(du.Months, type, ValueCodec.FieldMonths);
                ValueCodec.RequireI32(du.Days, type, ValueCodec.FieldDays);
                ValueCodec.Require(typeof du.Micros === 'bigint' && BigInt.asIntN(64, du.Micros) === du.Micros, type, ValueCodec.MicrosOutOfI64);
                return;
            }
            default:
                throw ChunkCodecError.TypeMismatch(type, ValueCodec.UnknownType);
        }
    }

    /** Throws ChunkCodecError unless 1..2048 cells are given and every non-null cell is valid for the type. */
    public static CheckCells(type: ValueType, cells: readonly CellValue[], maxCount: number): void
    {
        if (cells.length < 1 || cells.length > maxCount)
        {
            throw ChunkCodecError.BadCellCount(cells.length);
        }
        for (const c of cells)
        {
            if (c !== null)
            {
                ValueCodec.Check(type, c);
            }
        }
    }

    /** Encodes one non-null value. Layouts are in docs/format/on-disk-format.md. */
    public static Encode(type: ValueType, value: CellValue): Uint8Array
    {
        if (value === null)
        {
            throw ChunkCodecError.TypeMismatch(type, ValueCodec.NullHasNoBytes);
        }
        ValueCodec.Check(type, value);
        switch (type)
        {
            case ValueType.Boolean:
                return Uint8Array.of(value ? 1 : 0);
            case ValueType.Int64:
            {
                const out = new Uint8Array(8);
                new DataView(out.buffer).setBigInt64(0, value as bigint, true);
                return out;
            }
            case ValueType.Float64:
            {
                const out = new Uint8Array(8);
                ValueCodec.WriteFloat64(new DataView(out.buffer), 0, value as number);
                return out;
            }
            case ValueType.String:
            {
                const text = ValueCodec.Encoder.encode(value as string);
                const out = new Uint8Array(4 + text.length);
                new DataView(out.buffer).setUint32(0, text.length, true);
                out.set(text, 4);
                return out;
            }
            case ValueType.Date:
            {
                const out = new Uint8Array(4);
                new DataView(out.buffer).setInt32(0, (value as DateValue).Days, true);
                return out;
            }
            case ValueType.DateTime:
            {
                const zone = ValueCodec.Encoder.encode((value as DateTimeValue).Zone);
                const out = new Uint8Array(10 + zone.length);
                const view = new DataView(out.buffer);
                view.setBigInt64(0, (value as DateTimeValue).Micros, true);
                view.setUint16(8, zone.length, true);
                out.set(zone, 10);
                return out;
            }
            default:
            {
                const out = new Uint8Array(16);
                const view = new DataView(out.buffer);
                view.setInt32(0, (value as DurationValue).Months, true);
                view.setInt32(4, (value as DurationValue).Days, true);
                view.setBigInt64(8, (value as DurationValue).Micros, true);
                return out;
            }
        }
    }

    /** Decodes a value that occupies exactly all of `bytes`. */
    public static Decode(type: ValueType, bytes: Uint8Array): CellValue
    {
        const decoded = ValueCodec.DecodeAt(type, bytes, 0);
        if (decoded.End !== bytes.length)
        {
            throw ChunkCodecError.Corrupt(ValueCodec.TrailingBytes);
        }
        return decoded.Value;
    }

    /** Decodes one value starting at `offset`; End is the offset just past it. Pass `view` to avoid building one per call. */
    public static DecodeAt(type: ValueType, bytes: Uint8Array, offset: number, view?: DataView): DecodedValue
    {
        view ??= new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        switch (type)
        {
            case ValueType.Boolean:
            {
                ValueCodec.Need(bytes, offset, 1);
                const b = bytes[offset]!;
                if (b > 1)
                {
                    throw ChunkCodecError.Corrupt(ValueCodec.BadBoolean);
                }
                return { Value: b === 1, End: offset + 1 };
            }
            case ValueType.Int64:
                ValueCodec.Need(bytes, offset, 8);
                return { Value: view.getBigInt64(offset, true), End: offset + 8 };
            case ValueType.Float64:
                ValueCodec.Need(bytes, offset, 8);
                return { Value: view.getFloat64(offset, true), End: offset + 8 };
            case ValueType.String:
            {
                ValueCodec.Need(bytes, offset, 4);
                const len = view.getUint32(offset, true);
                ValueCodec.Need(bytes, offset, 4 + len);
                return { Value: ValueCodec.DecodeText(bytes.subarray(offset + 4, offset + 4 + len)), End: offset + 4 + len };
            }
            case ValueType.Date:
                ValueCodec.Need(bytes, offset, 4);
                return { Value: new DateValue(view.getInt32(offset, true)), End: offset + 4 };
            case ValueType.DateTime:
            {
                ValueCodec.Need(bytes, offset, 10);
                const len = view.getUint16(offset + 8, true);
                ValueCodec.Need(bytes, offset, 10 + len);
                const zone = ValueCodec.DecodeText(bytes.subarray(offset + 10, offset + 10 + len));
                if (zone.length === 0)
                {
                    throw ChunkCodecError.Corrupt(ValueCodec.EmptyZone);
                }
                return { Value: new DateTimeValue(view.getBigInt64(offset, true), zone), End: offset + 10 + len };
            }
            case ValueType.Duration:
                ValueCodec.Need(bytes, offset, 16);
                return {
                    Value: new DurationValue(view.getInt32(offset, true), view.getInt32(offset + 4, true), view.getBigInt64(offset + 8, true)),
                    End: offset + 16,
                };
            default:
                throw ChunkCodecError.TypeMismatch(type, ValueCodec.UnknownType);
        }
    }

    /** Byte length of the single value at `offset`, read from its framing without decoding it. */
    public static ValueLength(type: ValueType, bytes: Uint8Array, offset: number, view: DataView): number
    {
        let length: number;
        switch (type)
        {
            case ValueType.Boolean:
                length = 1;
                break;
            case ValueType.Int64:
            case ValueType.Float64:
                length = 8;
                break;
            case ValueType.Date:
                length = 4;
                break;
            case ValueType.Duration:
                length = 16;
                break;
            case ValueType.String:
                ValueCodec.Need(bytes, offset, 4);
                length = 4 + view.getUint32(offset, true);
                break;
            case ValueType.DateTime:
                ValueCodec.Need(bytes, offset, 10);
                length = 10 + view.getUint16(offset + 8, true);
                break;
            default:
                throw ChunkCodecError.TypeMismatch(type, ValueCodec.UnknownType);
        }
        ValueCodec.Need(bytes, offset, length);
        return length;
    }

    private static Need(bytes: Uint8Array, offset: number, n: number): void
    {
        if (offset + n > bytes.length)
        {
            throw ChunkCodecError.Corrupt(ValueCodec.TruncatedValue);
        }
    }

    /** Writes a Float64; every NaN is stored as the canonical quiet NaN 0x7FF8000000000000. */
    public static WriteFloat64(view: DataView, offset: number, value: number): void
    {
        if (Number.isNaN(value))
        {
            view.setUint32(offset, 0, true);
            view.setUint32(offset + 4, ValueCodec.CanonicalNaNHigh, true);
            return;
        }
        view.setFloat64(offset, value, true);
    }

    /** UTF-8 encodes text (already validated). */
    public static EncodeText(text: string): Uint8Array
    {
        return ValueCodec.Encoder.encode(text);
    }

    /** Strict UTF-8 decode; invalid bytes raise ChunkCodecError. */
    public static DecodeText(bytes: Uint8Array): string
    {
        try
        {
            return ValueCodec.Decoder.decode(bytes);
        }
        catch
        {
            throw ChunkCodecError.Corrupt(ValueCodec.BadUtf8);
        }
    }

    private static Require(condition: boolean, type: ValueType, detail: string): void
    {
        if (!condition)
        {
            throw ChunkCodecError.TypeMismatch(type, detail);
        }
    }

    private static RequireI32(n: number, type: ValueType, field: string): void
    {
        ValueCodec.Require(Number.isInteger(n) && n >= ValueCodec.MinI32 && n <= ValueCodec.MaxI32, type, `${field} ${ValueCodec.NotI32Suffix}`);
    }
}
