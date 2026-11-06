import { ValueType } from '../catalog/ValueType.js';
import { CellValue } from './CellValue.js';
import { BitPackedLayout } from './BitPackedLayout.js';
import { ChunkCodecError } from './ChunkCodecError.js';
import { DictionaryLayout } from './DictionaryLayout.js';
import { Encoding } from './Encoding.js';
import { PlainLayout } from './PlainLayout.js';
import { ValueCodec } from './ValueCodec.js';

/**
 * Column chunk codec: header (`encoding u8`, `slotCount u16`, null bitmap) then an encoding-specific payload.
 * Every encoding is random access: ReadCell touches only the header, the bitmap bit and the bytes of one cell.
 */
export class ChunkCodec
{
    public static readonly SlotsPerChunk = 2048;
    private static readonly FixedHeaderBytes = 3;
    private static readonly Applicable: readonly Encoding[] = [Encoding.Plain, Encoding.BitPacked, Encoding.Dictionary];
    private static readonly TruncatedHeader = 'chunk header or null bitmap truncated';
    private static readonly BadSlotCount = 'slot count is not 1..2048';
    private static readonly PaddingBits = 'null bitmap padding bits are set';
    private static readonly BadPayloadLength = 'payload length does not match its encoding';
    private static readonly UnknownEncoding = 'unknown encoding id';

    public static Encode(type: ValueType, cells: readonly CellValue[], encoding?: Encoding): Uint8Array
    {
        if (encoding !== undefined && !ChunkCodec.Applicable.includes(encoding))
        {
            throw ChunkCodecError.BadEncodingArgument(encoding);
        }
        ValueCodec.CheckCells(type, cells, ChunkCodec.SlotsPerChunk);
        const chosen = encoding ?? ChunkCodec.ChooseEncoding(type, cells);
        const payload = ChunkCodec.WritePayload(type, cells, chosen);
        const n = cells.length;
        const bitmapBytes = Math.ceil(n / 8);
        const out = new Uint8Array(ChunkCodec.FixedHeaderBytes + bitmapBytes + payload.length);
        out[0] = chosen;
        new DataView(out.buffer).setUint16(1, n, true);
        cells.forEach((c, i) =>
        {
            if (c === null)
            {
                out[ChunkCodec.FixedHeaderBytes + (i >> 3)]! |= 1 << (i & 7);
            }
        });
        out.set(payload, ChunkCodec.FixedHeaderBytes + bitmapBytes);
        return out;
    }

    /** Reads one cell without decoding any other slot. */
    public static ReadCell(type: ValueType, chunk: Uint8Array, slot: number): CellValue
    {
        const header = ChunkCodec.ReadHeader(chunk);
        if (!Number.isInteger(slot) || slot < 0 || slot >= header.Count)
        {
            throw ChunkCodecError.BadSlot(slot, header.Count);
        }
        if (((chunk[ChunkCodec.FixedHeaderBytes + (slot >> 3)]! >> (slot & 7)) & 1) === 1)
        {
            return null;
        }
        const payload = chunk.subarray(header.PayloadAt);
        switch (header.Encoding)
        {
            case Encoding.Plain:
                return PlainLayout.Read(type, payload, header.Count, slot);
            case Encoding.BitPacked:
                return BitPackedLayout.Read(type, payload, header.Count, slot);
            default:
                return DictionaryLayout.Read(type, payload, header.Count, slot);
        }
    }

    /** Number of slots a chunk covers (validated header). */
    public static SlotCount(chunk: Uint8Array): number
    {
        return ChunkCodec.ReadHeader(chunk).Count;
    }

    public static DecodeAll(type: ValueType, chunk: Uint8Array): CellValue[]
    {
        const header = ChunkCodec.ReadHeader(chunk);
        const count = header.Count;
        ChunkCodec.VerifyShape(type, chunk, header);
        const cells: CellValue[] = [];
        for (let i = 0; i < count; i++)
        {
            cells.push(ChunkCodec.ReadCell(type, chunk, i));
        }
        return cells;
    }

    /** Smallest applicable encoding; ties go to the lower encoding id. */
    public static ChooseEncoding(type: ValueType, cells: readonly CellValue[]): Encoding
    {
        ValueCodec.CheckCells(type, cells, ChunkCodec.SlotsPerChunk);
        let best = Encoding.Plain;
        let bestSize = ChunkCodec.WritePayload(type, cells, Encoding.Plain).length;
        for (const candidate of ChunkCodec.Applicable)
        {
            if (candidate === Encoding.Plain || !ChunkCodec.IsApplicable(type, candidate, cells))
            {
                continue;
            }
            const size = ChunkCodec.WritePayload(type, cells, candidate).length;
            if (size < bestSize)
            {
                best = candidate;
                bestSize = size;
            }
        }
        return best;
    }

    /** Single non-null value bytes, as used by delta entries and edge properties. */
    public static EncodeValue(type: ValueType, value: CellValue): Uint8Array
    {
        return ValueCodec.Encode(type, value);
    }

    public static DecodeValue(type: ValueType, bytes: Uint8Array): CellValue
    {
        return ValueCodec.Decode(type, bytes);
    }

    /** Whole-chunk checks: bitmap padding bits are zero and the payload has exactly its expected length. */
    private static VerifyShape(type: ValueType, chunk: Uint8Array, header: { Encoding: Encoding; Count: number; PayloadAt: number }): void
    {
        const tail = header.Count % 8;
        if (tail !== 0 && ((chunk[header.PayloadAt - 1]! >> tail) !== 0))
        {
            throw ChunkCodecError.Corrupt(ChunkCodec.PaddingBits);
        }
        const payload = chunk.subarray(header.PayloadAt);
        let expected: number;
        switch (header.Encoding)
        {
            case Encoding.Plain:
                expected = PlainLayout.ExactLength(type, payload, header.Count);
                break;
            case Encoding.BitPacked:
                expected = BitPackedLayout.ExactLength(type, payload, header.Count);
                break;
            default:
                expected = DictionaryLayout.ExactLength(type, payload, header.Count);
                break;
        }
        if (payload.length !== expected)
        {
            throw ChunkCodecError.Corrupt(ChunkCodec.BadPayloadLength);
        }
    }

    private static IsApplicable(type: ValueType, encoding: Encoding, cells: readonly CellValue[]): boolean
    {
        switch (encoding)
        {
            case Encoding.Plain:
                return true;
            case Encoding.BitPacked:
                return BitPackedLayout.Supports(type) && (type === ValueType.Boolean || BitPackedLayout.Plan(type, cells) !== null);
            default:
                return DictionaryLayout.Supports(type);
        }
    }

    private static WritePayload(type: ValueType, cells: readonly CellValue[], encoding: Encoding): Uint8Array
    {
        switch (encoding)
        {
            case Encoding.Plain:
                return PlainLayout.Write(type, cells);
            case Encoding.BitPacked:
                return BitPackedLayout.Write(type, cells);
            case Encoding.Dictionary:
                return DictionaryLayout.Write(type, cells);
            default:
                throw ChunkCodecError.Corrupt(ChunkCodec.UnknownEncoding);
        }
    }

    private static ReadHeader(chunk: Uint8Array): { Encoding: Encoding; Count: number; PayloadAt: number }
    {
        if (chunk.length < ChunkCodec.FixedHeaderBytes)
        {
            throw ChunkCodecError.Corrupt(ChunkCodec.TruncatedHeader);
        }
        const count = new DataView(chunk.buffer, chunk.byteOffset, chunk.length).getUint16(1, true);
        if (count < 1 || count > ChunkCodec.SlotsPerChunk)
        {
            throw ChunkCodecError.Corrupt(ChunkCodec.BadSlotCount);
        }
        if (chunk[0] !== Encoding.Plain && chunk[0] !== Encoding.BitPacked && chunk[0] !== Encoding.Dictionary)
        {
            throw ChunkCodecError.Corrupt(ChunkCodec.UnknownEncoding);
        }
        const payloadAt = ChunkCodec.FixedHeaderBytes + Math.ceil(count / 8);
        if (chunk.length < payloadAt)
        {
            throw ChunkCodecError.Corrupt(ChunkCodec.TruncatedHeader);
        }
        return { Encoding: chunk[0] as Encoding, Count: count, PayloadAt: payloadAt };
    }
}
