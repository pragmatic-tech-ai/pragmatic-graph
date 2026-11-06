import { ValueType } from '../catalog/ValueType.js';
import { Encoding } from './Encoding.js';

/** Thrown for invalid encode input and for corrupt or truncated chunks on read. All message text lives here. */
export class ChunkCodecError extends Error
{
    private static readonly ErrorName = 'ChunkCodecError';

    public constructor(message: string)
    {
        super(message);
        this.name = ChunkCodecError.ErrorName;
    }

    public static BadCellCount(count: number): ChunkCodecError
    {
        return new ChunkCodecError(`Cell count must be 1..2048, got ${count}`);
    }

    public static TypeMismatch(type: ValueType, detail: string): ChunkCodecError
    {
        return new ChunkCodecError(`Value does not match column type ${ValueType[type]}: ${detail}`);
    }

    public static NotApplicable(type: ValueType, encoding: Encoding, reason: string): ChunkCodecError
    {
        return new ChunkCodecError(`Encoding ${Encoding[encoding]} is not applicable to ${ValueType[type]}: ${reason}`);
    }

    public static BadEncodingArgument(encoding: number): ChunkCodecError
    {
        return new ChunkCodecError(`Encoding argument ${encoding} is not a valid encoding id (0 Plain, 1 BitPacked, 2 Dictionary)`);
    }

    public static Corrupt(detail: string): ChunkCodecError
    {
        return new ChunkCodecError(`Corrupt chunk: ${detail}`);
    }

    public static BadSlot(slot: number, count: number): ChunkCodecError
    {
        return new ChunkCodecError(`Slot ${slot} is outside 0..${count - 1}`);
    }
}
