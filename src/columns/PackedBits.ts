/** LSB-first bit packing of unsigned fixed-width values (width 0..63) into a byte array. */
export class PackedBits
{
    public static ByteLength(count: number, width: number): number
    {
        return Math.ceil((count * width) / 8);
    }

    public static Pack(values: readonly bigint[], width: number): Uint8Array
    {
        const out = new Uint8Array(PackedBits.ByteLength(values.length, width));
        if (width === 0)
        {
            return out;
        }
        for (let i = 0; i < values.length; i++)
        {
            const bit = i * width;
            const shift = bit % 8;
            const shifted = values[i]! << BigInt(shift);
            const span = Math.ceil((shift + width) / 8);
            for (let k = 0; k < span; k++)
            {
                out[Math.floor(bit / 8) + k]! |= Number((shifted >> BigInt(8 * k)) & 0xFFn);
            }
        }
        return out;
    }

    /** Reads value `index`. The caller guarantees `packed` covers it. */
    public static Read(packed: Uint8Array, index: number, width: number): bigint
    {
        if (width === 0)
        {
            return 0n;
        }
        const bit = index * width;
        const first = Math.floor(bit / 8);
        const shift = bit % 8;
        const span = Math.ceil((shift + width) / 8);
        let acc = 0n;
        for (let k = 0; k < span; k++)
        {
            acc |= BigInt(packed[first + k]!) << BigInt(8 * k);
        }
        return (acc >> BigInt(shift)) & ((1n << BigInt(width)) - 1n);
    }

    /** Smallest width that can hold `max`. */
    public static WidthFor(max: bigint): number
    {
        return max === 0n ? 0 : max.toString(2).length;
    }
}
