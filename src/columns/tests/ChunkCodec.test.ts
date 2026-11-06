import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ValueType } from '../../catalog/ValueType.js';
import { CellValue, DateTimeValue, DateValue, DurationValue } from '../CellValue.js';
import { ChunkCodec } from '../ChunkCodec.js';
import { ChunkCodecError } from '../ChunkCodecError.js';
import { Encoding } from '../Encoding.js';

class Fixtures
{
    public static readonly Zones = ['UTC', 'Europe/Kyiv', 'America/New_York'];
    public static readonly Words = ['alpha', 'beta', 'gamma', 'naïve', '日本語', '😀 emoji', ''];
    public static readonly Slots = [0, 1, 1023, 2047];

    public static Make(type: ValueType, n: number, distinct: number): CellValue[]
    {
        const cells: CellValue[] = [];
        for (let i = 0; i < n; i++)
        {
            cells.push(i % 7 === 3 ? null : Fixtures.Value(type, i % distinct));
        }
        return cells;
    }

    public static Value(type: ValueType, k: number): CellValue
    {
        switch (type)
        {
            case ValueType.Boolean:
                return k % 2 === 0;
            case ValueType.Int64:
                return BigInt(k * 37) - 500n;
            case ValueType.Float64:
                return k % 5 === 0 ? -0 : k * 1.5 - 7;
            case ValueType.String:
                return Fixtures.Words[k % Fixtures.Words.length] + (k >= Fixtures.Words.length ? String(k) : '');
            case ValueType.Date:
                return new DateValue(k * 11 - 300);
            case ValueType.DateTime:
                return new DateTimeValue(BigInt(k) * 1_000_003n - 5n, Fixtures.Zones[k % Fixtures.Zones.length]!);
            default:
                return new DurationValue(k - 3, k * 2, BigInt(k) * -999_999n);
        }
    }

    public static Applicable(type: ValueType): Encoding[]
    {
        switch (type)
        {
            case ValueType.Boolean:
                return [Encoding.Plain, Encoding.BitPacked];
            case ValueType.Int64:
            case ValueType.Date:
                return [Encoding.Plain, Encoding.BitPacked, Encoding.Dictionary];
            default:
                return [Encoding.Plain, Encoding.Dictionary];
        }
    }
}

describe('ChunkCodec', () =>
{
    const types = [ValueType.Boolean, ValueType.Int64, ValueType.Float64, ValueType.String, ValueType.Date, ValueType.DateTime, ValueType.Duration];

    for (const type of types)
    {
        for (const encoding of Fixtures.Applicable(type))
        {
            it(`round-trips 2048 cells of ${ValueType[type]} as ${Encoding[encoding]}`, () =>
            {
                const cells = Fixtures.Make(type, 2048, 40);
                const chunk = ChunkCodec.Encode(type, cells, encoding);
                assert.equal(chunk[0], encoding);
                for (const slot of Fixtures.Slots)
                {
                    assert.deepStrictEqual(ChunkCodec.ReadCell(type, chunk, slot), cells[slot]);
                }
                assert.deepStrictEqual(ChunkCodec.DecodeAll(type, chunk), cells);
            });
        }
    }

    it('round-trips short and all-null chunks', () =>
    {
        for (const type of types)
        {
            for (const encoding of Fixtures.Applicable(type))
            {
                for (const cells of [[null], [null, null, null], Fixtures.Make(type, 9, 3)])
                {
                    assert.deepStrictEqual(ChunkCodec.DecodeAll(type, ChunkCodec.Encode(type, cells, encoding)), cells);
                }
            }
        }
    });

    it('chooses Dictionary for a string column with 3 distinct values', () =>
    {
        const cells = Fixtures.Make(ValueType.String, 2048, 3);
        assert.equal(ChunkCodec.ChooseEncoding(ValueType.String, cells), Encoding.Dictionary);
        assert.equal(ChunkCodec.Encode(ValueType.String, cells)[0], Encoding.Dictionary);
    });

    it('chooses BitPacked for Int64 values within 0..1000', () =>
    {
        const cells: CellValue[] = [];
        for (let i = 0; i < 2048; i++)
        {
            cells.push(BigInt((i * 7919) % 1001));
        }
        assert.equal(ChunkCodec.ChooseEncoding(ValueType.Int64, cells), Encoding.BitPacked);
    });

    it('falls back to Plain when the Int64 range needs 64 bits', () =>
    {
        const cells: CellValue[] = [-(2n ** 63n), 2n ** 63n - 1n, 0n];
        assert.equal(ChunkCodec.ChooseEncoding(ValueType.Int64, cells), Encoding.Plain);
        assert.throws(() => ChunkCodec.Encode(ValueType.Int64, cells, Encoding.BitPacked), ChunkCodecError);
        assert.deepStrictEqual(ChunkCodec.DecodeAll(ValueType.Int64, ChunkCodec.Encode(ValueType.Int64, cells, Encoding.Plain)), cells);
    });

    it('bit-packs negative and extreme 63-bit ranges', () =>
    {
        const cells: CellValue[] = [-(2n ** 62n), 2n ** 62n - 1n, -1n, 0n, null];
        const chunk = ChunkCodec.Encode(ValueType.Int64, cells, Encoding.BitPacked);
        assert.deepStrictEqual(ChunkCodec.DecodeAll(ValueType.Int64, chunk), cells);
        const negatives: CellValue[] = [-5n, -4n, -3n];
        assert.deepStrictEqual(ChunkCodec.DecodeAll(ValueType.Int64, ChunkCodec.Encode(ValueType.Int64, negatives, Encoding.BitPacked)), negatives);
    });

    it('preserves NaN and negative zero', () =>
    {
        const cells: CellValue[] = [NaN, -0, 0, Infinity, -Infinity];
        for (const encoding of [Encoding.Plain, Encoding.Dictionary])
        {
            const out = ChunkCodec.DecodeAll(ValueType.Float64, ChunkCodec.Encode(ValueType.Float64, cells, encoding));
            assert.deepStrictEqual(out, cells);
        }
    });

    it('round-trips astral Unicode and rejects lone surrogates', () =>
    {
        const cells: CellValue[] = ['😀', 'a\u0000b', 'é'];
        assert.deepStrictEqual(ChunkCodec.DecodeAll(ValueType.String, ChunkCodec.Encode(ValueType.String, cells)), cells);
        assert.throws(() => ChunkCodec.Encode(ValueType.String, ['\uD800']), ChunkCodecError);
        assert.throws(() => ChunkCodec.Encode(ValueType.String, ['x\uDC00y']), ChunkCodecError);
    });

    it('rejects inapplicable encodings, bad counts and mismatched values', () =>
    {
        assert.throws(() => ChunkCodec.Encode(ValueType.Boolean, [true], Encoding.Dictionary), ChunkCodecError);
        assert.throws(() => ChunkCodec.Encode(ValueType.Float64, [1], Encoding.BitPacked), ChunkCodecError);
        assert.throws(() => ChunkCodec.Encode(ValueType.String, [], undefined), ChunkCodecError);
        assert.throws(() => ChunkCodec.Encode(ValueType.String, new Array(2049).fill('a')), ChunkCodecError);
        assert.throws(() => ChunkCodec.Encode(ValueType.Int64, [1]), ChunkCodecError);
        assert.throws(() => ChunkCodec.Encode(ValueType.Int64, [2n ** 63n]), ChunkCodecError);
        assert.throws(() => ChunkCodec.Encode(ValueType.Date, [new DateValue(1.5)]), ChunkCodecError);
        assert.throws(() => ChunkCodec.Encode(ValueType.DateTime, [new DateTimeValue(0n, '')]), ChunkCodecError);
    });

    it('rejects out-of-range slots and corrupt chunks', () =>
    {
        const chunk = ChunkCodec.Encode(ValueType.String, ['a', 'bb', null, 'dddd'], Encoding.Plain);
        assert.throws(() => ChunkCodec.ReadCell(ValueType.String, chunk, 4), ChunkCodecError);
        assert.throws(() => ChunkCodec.ReadCell(ValueType.String, chunk, -1), ChunkCodecError);
        assert.throws(() => ChunkCodec.ReadCell(ValueType.String, new Uint8Array(2), 0), ChunkCodecError);
        const badEncoding = chunk.slice();
        badEncoding[0] = 9;
        assert.throws(() => ChunkCodec.ReadCell(ValueType.String, badEncoding, 0), ChunkCodecError);
        assert.throws(() => ChunkCodec.DecodeAll(ValueType.String, chunk.subarray(0, chunk.length - 2)), ChunkCodecError);
        const zeroCount = chunk.slice();
        zeroCount[1] = 0;
        assert.throws(() => ChunkCodec.DecodeAll(ValueType.String, zeroCount), ChunkCodecError);
    });

    it('rejects corrupt payloads for every encoding', () =>
    {
        const dict = ChunkCodec.Encode(ValueType.String, ['a', 'b', 'c', 'a'], Encoding.Dictionary);
        assert.throws(() => ChunkCodec.DecodeAll(ValueType.String, dict.subarray(0, 5)), ChunkCodecError);
        const bad = dict.slice();
        bad[4 + 1] = 0xFF;
        assert.throws(() => ChunkCodec.DecodeAll(ValueType.String, bad), ChunkCodecError);
        const bp = ChunkCodec.Encode(ValueType.Int64, [1n, 2n, 3n], Encoding.BitPacked);
        assert.throws(() => ChunkCodec.DecodeAll(ValueType.Int64, bp.subarray(0, bp.length - 1)), ChunkCodecError);
        const wide = bp.slice();
        wide[4 + 8] = 64;
        assert.throws(() => ChunkCodec.ReadCell(ValueType.Int64, wide, 0), ChunkCodecError);
        const dt = ChunkCodec.Encode(ValueType.DateTime, [new DateTimeValue(1n, 'UTC')], Encoding.Plain);
        const badZone = dt.slice();
        badZone[4 + 8] = 5;
        assert.throws(() => ChunkCodec.ReadCell(ValueType.DateTime, badZone, 0), ChunkCodecError);
        const utf = ChunkCodec.Encode(ValueType.String, ['ab'], Encoding.Plain);
        utf[utf.length - 1] = 0xFF;
        assert.throws(() => ChunkCodec.ReadCell(ValueType.String, utf, 0), ChunkCodecError);
    });

    it('encodes and decodes single values for every type', () =>
    {
        for (const type of types)
        {
            for (let k = 0; k < 6; k++)
            {
                const value = Fixtures.Value(type, k);
                assert.deepStrictEqual(ChunkCodec.DecodeValue(type, ChunkCodec.EncodeValue(type, value)), value);
            }
        }
        assert.throws(() => ChunkCodec.EncodeValue(ValueType.Int64, null), ChunkCodecError);
        assert.throws(() => ChunkCodec.DecodeValue(ValueType.Int64, new Uint8Array(7)), ChunkCodecError);
        assert.throws(() => ChunkCodec.DecodeValue(ValueType.Boolean, Uint8Array.of(1, 0)), ChunkCodecError);
        assert.throws(() => ChunkCodec.DecodeValue(ValueType.Boolean, Uint8Array.of(2)), ChunkCodecError);
    });
});
