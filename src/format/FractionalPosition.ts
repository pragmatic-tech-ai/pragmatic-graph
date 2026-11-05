import { TupleCodec } from './TupleCodec.js';

/**
 * Order-preserving positions: byte strings compared bytewise, read as base-256 fractions.
 * Between() only creates new values; existing positions are never modified. Valid positions
 * are non-empty and do not end in 0x00 (so every pair of distinct positions has room between).
 */
export class FractionalPosition
{
    public static readonly First: Uint8Array = Uint8Array.of(0x80);

    private static readonly Radix = 256;
    private static readonly ErrBadBound = 'Position must be non-empty and must not end in 0x00';
    private static readonly ErrOrder = 'Position bounds must satisfy before < after';

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
        const result: number[] = [];
        let bounded = after !== null;
        for (let i = 0; ; i++)
        {
            const lo = before === null ? 0 : (before[i] ?? 0);
            const hi = bounded && after !== null ? (after[i] ?? 0) : FractionalPosition.Radix;
            if (lo + 1 < hi)
            {
                result.push((lo + hi) >> 1);
                return Uint8Array.from(result);
            }
            result.push(lo);
            if (hi > lo)
            {
                bounded = false;
            }
        }
    }

    private static Validate(position: Uint8Array | null): void
    {
        if (position !== null && (position.length === 0 || position[position.length - 1] === 0))
        {
            throw new RangeError(FractionalPosition.ErrBadBound);
        }
    }
}
