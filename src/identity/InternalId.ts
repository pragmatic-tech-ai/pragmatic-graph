/** Range rules for internal ids: 0 is reserved ("no id"); ids are positive signed 64-bit. */
export class InternalId
{
    public static readonly Max = (1n << 63n) - 1n;
    private static readonly ErrRange = 'Internal id must be within 1..2^63-1: ';

    public static Require(id: bigint): void
    {
        if (id < 1n || id > InternalId.Max)
        {
            throw new RangeError(InternalId.ErrRange + id);
        }
    }
}
