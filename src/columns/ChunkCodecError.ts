import { ValueType } from '../catalog/ValueType.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { Encoding } from './Encoding.js';

/**
 * Thrown for invalid encode input (InvalidArgument) and for corrupt or truncated chunks on read
 * (Corrupt). All message text lives here.
 */
export class ChunkCodecError extends GraphError
{
    private static readonly ErrorName = 'ChunkCodecError';
    private static readonly CellCountText = 'Cell count must be 1..2048, got ';
    private static readonly TypeMismatchText = 'Value does not match column type ';
    private static readonly EncodingText = 'Encoding ';
    private static readonly NotApplicableText = ' is not applicable to ';
    private static readonly EncodingArgumentText = 'Encoding argument ';
    private static readonly NotAnEncodingText = ' is not a valid encoding id (0 Plain, 1 BitPacked, 2 Dictionary)';
    private static readonly CorruptText = 'Corrupt chunk: ';
    private static readonly SlotText = 'Slot ';
    private static readonly OutsideText = ' is outside 0..';
    private static readonly DetailSeparator = ': ';

    public constructor(message: string, code: GraphErrorCode = GraphErrorCode.InvalidArgument)
    {
        super(code, message);
        this.name = ChunkCodecError.ErrorName;
    }

    public static BadCellCount(count: number): ChunkCodecError
    {
        return new ChunkCodecError(ChunkCodecError.CellCountText + count);
    }

    public static TypeMismatch(type: ValueType, detail: string): ChunkCodecError
    {
        return new ChunkCodecError(ChunkCodecError.TypeMismatchText + ValueType[type] + ChunkCodecError.DetailSeparator + detail);
    }

    public static NotApplicable(type: ValueType, encoding: Encoding, reason: string): ChunkCodecError
    {
        return new ChunkCodecError(ChunkCodecError.EncodingText + Encoding[encoding] + ChunkCodecError.NotApplicableText + ValueType[type] + ChunkCodecError.DetailSeparator + reason);
    }

    public static BadEncodingArgument(encoding: number): ChunkCodecError
    {
        return new ChunkCodecError(ChunkCodecError.EncodingArgumentText + encoding + ChunkCodecError.NotAnEncodingText);
    }

    public static Corrupt(detail: string): ChunkCodecError
    {
        return new ChunkCodecError(ChunkCodecError.CorruptText + detail, GraphErrorCode.Corrupt);
    }

    public static BadSlot(slot: number, count: number): ChunkCodecError
    {
        return new ChunkCodecError(ChunkCodecError.SlotText + slot + ChunkCodecError.OutsideText + (count - 1));
    }
}
