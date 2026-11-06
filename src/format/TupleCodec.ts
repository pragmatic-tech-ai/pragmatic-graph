/**
 * An IEEE-754 double tuple element (a plain `number` element is a non-negative integer). Encoded as the
 * FoundationDB double: code 0x21 then the 8 big-endian bytes with the sign bit flipped (non-negative)
 * or every bit flipped (negative), so doubles order numerically: -Infinity < ... < -0 < 0 < ... <
 * +Infinity < NaN. Callers that need -0 = 0 or a single NaN canonicalize before encoding.
 */
export class TupleDouble
{
    public constructor(public readonly Value: number)
    {
        Object.freeze(this);
    }
}

export type TupleElement = Uint8Array | string | bigint | number | boolean | null | TupleDouble;

/**
 * FoundationDB tuple-layer encoding for flat tuples of null, byte strings, UTF-8 strings, integers (up
 * to 64-bit magnitude), doubles and booleans. Encoded keys order bytewise like their logical tuples;
 * across types the order is null < bytes < string < integer < double < false < true.
 */
export class TupleCodec
{
    private static readonly NullCode = 0x00;
    private static readonly DoubleCode = 0x21;
    private static readonly FalseCode = 0x26;
    private static readonly TrueCode = 0x27;
    private static readonly DoubleBytes = 8;
    private static readonly SignBit = 0x80;
    private static readonly BytesCode = 0x01;
    private static readonly StringCode = 0x02;
    private static readonly IntZeroCode = 0x14;
    private static readonly IntMinCode = 0x0c;
    private static readonly IntMaxCode = 0x1c;
    private static readonly Terminator = 0x00;
    private static readonly EscapeSuffix = 0xff;
    private static readonly MaxIntBytes = 8;
    private static readonly ByteBits = 8n;
    private static readonly ByteMask = 0xffn;
    private static readonly Utf8 = 'utf-8';
    private static readonly Encoder = new TextEncoder();
    private static readonly Decoder = new TextDecoder(TupleCodec.Utf8, { fatal: true });

    private static readonly ErrBadNumber = 'Tuple number must be a non-negative safe integer: ';
    private static readonly ErrTooLarge = 'Tuple integer magnitude exceeds 64 bits: ';
    private static readonly ErrBadElement = 'Unsupported tuple element type';
    private static readonly ErrBadCode = 'Unsupported tuple type code: ';
    private static readonly ErrTruncated = 'Truncated tuple key';
    private static readonly ErrNoPrefixEnd = 'Prefix has no end: it is empty or all 0xFF bytes';

    public static Encode(elements: readonly TupleElement[]): Uint8Array
    {
        const out: number[] = [];
        for (const element of elements)
        {
            if (element === null)
            {
                out.push(TupleCodec.NullCode);
            }
            else if (typeof element === 'boolean')
            {
                out.push(element ? TupleCodec.TrueCode : TupleCodec.FalseCode);
            }
            else if (element instanceof TupleDouble)
            {
                TupleCodec.WriteDouble(out, element.Value);
            }
            else if (element instanceof Uint8Array)
            {
                out.push(TupleCodec.BytesCode);
                TupleCodec.WriteEscaped(out, element);
            }
            else if (typeof element === 'string')
            {
                out.push(TupleCodec.StringCode);
                TupleCodec.WriteEscaped(out, TupleCodec.Encoder.encode(element));
            }
            else if (typeof element === 'bigint')
            {
                TupleCodec.WriteInteger(out, element);
            }
            else if (typeof element === 'number')
            {
                if (!Number.isSafeInteger(element) || element < 0)
                {
                    throw new RangeError(TupleCodec.ErrBadNumber + String(element));
                }
                TupleCodec.WriteInteger(out, BigInt(element));
            }
            else
            {
                throw new TypeError(TupleCodec.ErrBadElement);
            }
        }
        return Uint8Array.from(out);
    }

    public static Decode(key: Uint8Array): TupleElement[]
    {
        const result: TupleElement[] = [];
        let pos = 0;
        while (pos < key.length)
        {
            const code = key[pos] as number;
            pos++;
            if (code === TupleCodec.NullCode)
            {
                result.push(null);
            }
            else if (code === TupleCodec.FalseCode || code === TupleCodec.TrueCode)
            {
                result.push(code === TupleCodec.TrueCode);
            }
            else if (code === TupleCodec.DoubleCode)
            {
                if (pos + TupleCodec.DoubleBytes > key.length)
                {
                    throw new RangeError(TupleCodec.ErrTruncated);
                }
                result.push(new TupleDouble(TupleCodec.ReadDouble(key, pos)));
                pos += TupleCodec.DoubleBytes;
            }
            else if (code === TupleCodec.BytesCode || code === TupleCodec.StringCode)
            {
                const { bytes, next } = TupleCodec.ReadEscaped(key, pos);
                pos = next;
                result.push(code === TupleCodec.BytesCode ? bytes : TupleCodec.Decoder.decode(bytes));
            }
            else if (code >= TupleCodec.IntMinCode && code <= TupleCodec.IntMaxCode)
            {
                const length = Math.abs(code - TupleCodec.IntZeroCode);
                if (pos + length > key.length)
                {
                    throw new RangeError(TupleCodec.ErrTruncated);
                }
                let stored = 0n;
                for (let i = 0; i < length; i++)
                {
                    stored = (stored << TupleCodec.ByteBits) | BigInt(key[pos + i] as number);
                }
                pos += length;
                if (code < TupleCodec.IntZeroCode)
                {
                    stored -= (1n << (BigInt(length) * TupleCodec.ByteBits)) - 1n;
                }
                result.push(stored);
            }
            else
            {
                throw new RangeError(TupleCodec.ErrBadCode + code);
            }
        }
        return result;
    }

    /** Bytewise lexicographic comparison; returns -1, 0 or 1. */
    public static Compare(a: Uint8Array, b: Uint8Array): number
    {
        const common = Math.min(a.length, b.length);
        for (let i = 0; i < common; i++)
        {
            const x = a[i] as number;
            const y = b[i] as number;
            if (x !== y)
            {
                return x < y ? -1 : 1;
            }
        }
        if (a.length === b.length)
        {
            return 0;
        }
        return a.length < b.length ? -1 : 1;
    }

    /** Smallest key greater than every key that starts with prefix (exclusive range end). */
    public static PrefixEnd(prefix: Uint8Array): Uint8Array
    {
        let end = prefix.length;
        while (end > 0 && prefix[end - 1] === TupleCodec.EscapeSuffix)
        {
            end--;
        }
        if (end === 0)
        {
            throw new RangeError(TupleCodec.ErrNoPrefixEnd);
        }
        const result = prefix.slice(0, end);
        result[end - 1] = (result[end - 1] as number) + 1;
        return result;
    }

    private static WriteDouble(out: number[], value: number): void
    {
        const bytes = new Uint8Array(TupleCodec.DoubleBytes);
        new DataView(bytes.buffer).setFloat64(0, value);
        const negative = ((bytes[0] as number) & TupleCodec.SignBit) !== 0;
        out.push(TupleCodec.DoubleCode);
        for (let i = 0; i < bytes.length; i++)
        {
            const b = bytes[i] as number;
            out.push(negative ? b ^ TupleCodec.EscapeSuffix : i === 0 ? b ^ TupleCodec.SignBit : b);
        }
    }

    private static ReadDouble(key: Uint8Array, start: number): number
    {
        const bytes = key.slice(start, start + TupleCodec.DoubleBytes);
        const negative = ((bytes[0] as number) & TupleCodec.SignBit) === 0;
        for (let i = 0; i < bytes.length; i++)
        {
            const b = bytes[i] as number;
            bytes[i] = negative ? b ^ TupleCodec.EscapeSuffix : i === 0 ? b ^ TupleCodec.SignBit : b;
        }
        return new DataView(bytes.buffer).getFloat64(0);
    }

    private static WriteEscaped(out: number[], bytes: Uint8Array): void
    {
        for (const b of bytes)
        {
            out.push(b);
            if (b === TupleCodec.Terminator)
            {
                out.push(TupleCodec.EscapeSuffix);
            }
        }
        out.push(TupleCodec.Terminator);
    }

    private static ReadEscaped(key: Uint8Array, start: number): { bytes: Uint8Array; next: number }
    {
        const bytes: number[] = [];
        let pos = start;
        while (pos < key.length)
        {
            const b = key[pos] as number;
            pos++;
            if (b !== TupleCodec.Terminator)
            {
                bytes.push(b);
            }
            else if (key[pos] === TupleCodec.EscapeSuffix)
            {
                bytes.push(TupleCodec.Terminator);
                pos++;
            }
            else
            {
                return { bytes: Uint8Array.from(bytes), next: pos };
            }
        }
        throw new RangeError(TupleCodec.ErrTruncated);
    }

    private static WriteInteger(out: number[], value: bigint): void
    {
        if (value === 0n)
        {
            out.push(TupleCodec.IntZeroCode);
            return;
        }
        const negative = value < 0n;
        const magnitude = negative ? -value : value;
        const digits: number[] = [];
        for (let m = magnitude; m > 0n; m >>= TupleCodec.ByteBits)
        {
            digits.unshift(Number(m & TupleCodec.ByteMask));
        }
        if (digits.length > TupleCodec.MaxIntBytes)
        {
            throw new RangeError(TupleCodec.ErrTooLarge + String(value));
        }
        if (negative)
        {
            out.push(TupleCodec.IntZeroCode - digits.length);
            for (const d of digits)
            {
                out.push(d ^ TupleCodec.EscapeSuffix);
            }
        }
        else
        {
            out.push(TupleCodec.IntZeroCode + digits.length);
            out.push(...digits);
        }
    }
}
