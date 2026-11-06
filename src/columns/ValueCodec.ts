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

    /** Throws ChunkCodecError unless the (non-null) value is valid for the type. */
    public static Check(type: ValueType, value: CellValue): void
    {
        switch (type)
        {
            case ValueType.Boolean:
                ValueCodec.Require(typeof value === 'boolean', type, 'expected boolean');
                return;
            case ValueType.Int64:
                ValueCodec.Require(typeof value === 'bigint', type, 'expected bigint');
                ValueCodec.Require(BigInt.asIntN(64, value as bigint) === value, type, 'out of signed 64-bit range');
                return;
            case ValueType.Float64:
                ValueCodec.Require(typeof value === 'number', type, 'expected number');
                return;
            case ValueType.String:
                ValueCodec.Require(typeof value === 'string', type, 'expected string');
                ValueCodec.Require(!ValueCodec.LoneSurrogate.test(value as string), type, 'string contains a lone surrogate');
                return;
            case ValueType.Date:
                ValueCodec.Require(value instanceof DateValue, type, 'expected DateValue');
                ValueCodec.RequireI32((value as DateValue).Days, type, 'Days');
                return;
            case ValueType.DateTime:
            {
                ValueCodec.Require(value instanceof DateTimeValue, type, 'expected DateTimeValue');
                const dt = value as DateTimeValue;
                ValueCodec.Require(typeof dt.Micros === 'bigint' && BigInt.asIntN(64, dt.Micros) === dt.Micros, type, 'Micros out of signed 64-bit range');
                ValueCodec.Require(typeof dt.Zone === 'string' && dt.Zone.length > 0, type, ValueCodec.EmptyZone);
                ValueCodec.Require(!ValueCodec.LoneSurrogate.test(dt.Zone), type, 'zone contains a lone surrogate');
                ValueCodec.Require(ValueCodec.Encoder.encode(dt.Zone).length <= ValueCodec.MaxU16, type, 'zone name too long');
                return;
            }
            case ValueType.Duration:
            {
                ValueCodec.Require(value instanceof DurationValue, type, 'expected DurationValue');
                const du = value as DurationValue;
                ValueCodec.RequireI32(du.Months, type, 'Months');
                ValueCodec.RequireI32(du.Days, type, 'Days');
                ValueCodec.Require(typeof du.Micros === 'bigint' && BigInt.asIntN(64, du.Micros) === du.Micros, type, 'Micros out of signed 64-bit range');
                return;
            }
            default:
                throw ChunkCodecError.TypeMismatch(type, ValueCodec.UnknownType);
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
                new DataView(out.buffer).setFloat64(0, value as number, true);
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

    /** Decodes one value starting at `offset`; End is the offset just past it. */
    public static DecodeAt(type: ValueType, bytes: Uint8Array, offset: number): DecodedValue
    {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        const need = (n: number): void =>
        {
            if (offset + n > bytes.length)
            {
                throw ChunkCodecError.Corrupt(ValueCodec.TruncatedValue);
            }
        };
        switch (type)
        {
            case ValueType.Boolean:
            {
                need(1);
                const b = bytes[offset]!;
                if (b > 1)
                {
                    throw ChunkCodecError.Corrupt(ValueCodec.BadBoolean);
                }
                return { Value: b === 1, End: offset + 1 };
            }
            case ValueType.Int64:
                need(8);
                return { Value: view.getBigInt64(offset, true), End: offset + 8 };
            case ValueType.Float64:
                need(8);
                return { Value: view.getFloat64(offset, true), End: offset + 8 };
            case ValueType.String:
            {
                need(4);
                const len = view.getUint32(offset, true);
                need(4 + len);
                return { Value: ValueCodec.DecodeText(bytes.subarray(offset + 4, offset + 4 + len)), End: offset + 4 + len };
            }
            case ValueType.Date:
                need(4);
                return { Value: new DateValue(view.getInt32(offset, true)), End: offset + 4 };
            case ValueType.DateTime:
            {
                need(10);
                const len = view.getUint16(offset + 8, true);
                need(10 + len);
                const zone = ValueCodec.DecodeText(bytes.subarray(offset + 10, offset + 10 + len));
                if (zone.length === 0)
                {
                    throw ChunkCodecError.Corrupt(ValueCodec.EmptyZone);
                }
                return { Value: new DateTimeValue(view.getBigInt64(offset, true), zone), End: offset + 10 + len };
            }
            case ValueType.Duration:
                need(16);
                return {
                    Value: new DurationValue(view.getInt32(offset, true), view.getInt32(offset + 4, true), view.getBigInt64(offset + 8, true)),
                    End: offset + 16,
                };
            default:
                throw ChunkCodecError.TypeMismatch(type, ValueCodec.UnknownType);
        }
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
        ValueCodec.Require(Number.isInteger(n) && n >= ValueCodec.MinI32 && n <= ValueCodec.MaxI32, type, `${field} is not a signed 32-bit integer`);
    }
}
