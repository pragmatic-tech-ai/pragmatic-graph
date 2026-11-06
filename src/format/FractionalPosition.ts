import { TupleCodec } from './TupleCodec.js';

/**
 * Order-preserving positions with logarithmic growth (ruling F1): an integer part followed by a
 * fraction, compared bytewise. See docs/format/on-disk-format.md, Edges, Positions.
 *
 * Integer part: one head byte H, then n digit bytes, where n = H - 0x7F for H >= 0x80 and n = 0x80 - H
 * for H < 0x80 (so 1..128 digits). A larger head is a larger integer; equal heads compare digit by
 * digit. Fraction: zero or more base-256 digits read as 0.d1d2..., compared bytewise. A valid position
 * has its full integer part, and its last byte is not 0x00 (so every pair of distinct positions has
 * room between them). Appending or prepending steps the integer part (O(log n) bytes after n steps);
 * inserting between two positions with the same integer part bisects the fraction (about 1 bit per
 * insert at the same spot). Between() only creates new values; existing positions are never modified.
 */
export class FractionalPosition
{
    /** The first position of an empty list: integer 0x80 0x80 (head 0x80, one digit), no fraction. */
    public static readonly First: Uint8Array = Uint8Array.of(0x80, 0x80);

    private static readonly Radix = 256;
    private static readonly PositiveHead = 0x80;
    private static readonly MaxHead = 0xff;
    private static readonly MaxDigit = 0xff;
    private static readonly ErrBadBound = 'Position must hold its whole integer part and must not end in 0x00';
    private static readonly ErrOrder = 'Position bounds must satisfy before < after';
    private static readonly ErrExhausted = 'Position integer space exhausted';

    /** Returns a position strictly between before and after (null = open end). */
    public static Between(before: Uint8Array | null, after: Uint8Array | null): Uint8Array
    {
        if (before === null && after === null)
        {
            return FractionalPosition.First.slice();
        }
        FractionalPosition.Validate(before);
        FractionalPosition.Validate(after);
        if (before !== null && after !== null && TupleCodec.Compare(before, after) >= 0)
        {
            throw new RangeError(FractionalPosition.ErrOrder);
        }
        if (after === null)
        {
            return FractionalPosition.Increment(FractionalPosition.IntegerOf(before as Uint8Array));
        }
        if (before === null)
        {
            return FractionalPosition.Decrement(FractionalPosition.IntegerOf(after));
        }
        const lo = FractionalPosition.IntegerOf(before);
        const hi = FractionalPosition.IntegerOf(after);
        if (TupleCodec.Compare(lo, hi) === 0)
        {
            return FractionalPosition.Join(lo, FractionalPosition.MidFraction(before.subarray(lo.length), after.subarray(hi.length)));
        }
        const next = FractionalPosition.Increment(lo);
        if (TupleCodec.Compare(next, after) < 0)
        {
            return next;
        }
        return FractionalPosition.Join(lo, FractionalPosition.MidFraction(before.subarray(lo.length), null));
    }

    /** `count` ascending, evenly spaced (consecutive integer) positions from First: what a renumbered list uses. */
    public static Sequence(count: number): Uint8Array[]
    {
        const out: Uint8Array[] = [];
        let at: Uint8Array = FractionalPosition.First.slice();
        for (let i = 0; i < count; i++)
        {
            out.push(at);
            at = FractionalPosition.Increment(at);
        }
        return out;
    }

    /** True when the bytes are a valid position (see class comment). */
    public static IsValid(position: Uint8Array): boolean
    {
        if (position.length === 0 || position[position.length - 1] === 0)
        {
            return false;
        }
        return position.length >= 1 + FractionalPosition.Digits(position[0] as number);
    }

    private static Validate(position: Uint8Array | null): void
    {
        if (position !== null && !FractionalPosition.IsValid(position))
        {
            throw new RangeError(FractionalPosition.ErrBadBound);
        }
    }

    private static Digits(head: number): number
    {
        return head >= FractionalPosition.PositiveHead ? head - (FractionalPosition.PositiveHead - 1) : FractionalPosition.PositiveHead - head;
    }

    /** The integer part (head and digits) of a valid position, as a copy. */
    private static IntegerOf(position: Uint8Array): Uint8Array
    {
        return position.slice(0, 1 + FractionalPosition.Digits(position[0] as number));
    }

    private static Join(integer: Uint8Array, fraction: Uint8Array): Uint8Array
    {
        const out = new Uint8Array(integer.length + fraction.length);
        out.set(integer);
        out.set(fraction, integer.length);
        return out;
    }

    /** The next integer whose last digit is not 0x00 (so it is a valid position on its own). */
    private static Increment(integer: Uint8Array): Uint8Array
    {
        let current = integer;
        do
        {
            current = FractionalPosition.Step(current, 1);
        }
        while (current[current.length - 1] === 0);
        return current;
    }

    /** The previous integer whose last digit is not 0x00. */
    private static Decrement(integer: Uint8Array): Uint8Array
    {
        let current = integer;
        do
        {
            current = FractionalPosition.Step(current, -1);
        }
        while (current[current.length - 1] === 0);
        return current;
    }

    /**
     * Integer plus or minus one. On overflow of every digit the head moves by one and the digits restart
     * at all-0x00 (up) or all-0xFF (down) at the new head's digit count, so order is kept across heads.
     */
    private static Step(integer: Uint8Array, delta: 1 | -1): Uint8Array
    {
        const out = integer.slice();
        for (let i = out.length - 1; i >= 1; i--)
        {
            const digit = (out[i] as number) + delta;
            if (digit >= 0 && digit <= FractionalPosition.MaxDigit)
            {
                out[i] = digit;
                return out;
            }
            out[i] = delta > 0 ? 0 : FractionalPosition.MaxDigit;
        }
        const head = (integer[0] as number) + delta;
        if (head < 0 || head > FractionalPosition.MaxHead)
        {
            throw new RangeError(FractionalPosition.ErrExhausted);
        }
        const next = new Uint8Array(1 + FractionalPosition.Digits(head)).fill(delta > 0 ? 0 : FractionalPosition.MaxDigit);
        next[0] = head;
        return next;
    }

    /**
     * A non-empty fraction strictly between lo and hi (null = 1), read as base-256 fractions; lo may be
     * empty (0). The result never ends in 0x00.
     */
    private static MidFraction(lo: Uint8Array, hi: Uint8Array | null): Uint8Array
    {
        const result: number[] = [];
        let bounded = hi !== null;
        for (let i = 0; ; i++)
        {
            const l = lo[i] ?? 0;
            const h = bounded && hi !== null ? (hi[i] ?? 0) : FractionalPosition.Radix;
            if (l + 1 < h)
            {
                result.push((l + h) >> 1);
                return Uint8Array.from(result);
            }
            result.push(l);
            if (h > l)
            {
                bounded = false;
            }
        }
    }
}
