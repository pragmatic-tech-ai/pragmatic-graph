import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TupleCodec, type TupleElement } from '../TupleCodec.js';

describe('TupleCodec', () =>
{
    it('round-trips mixed elements', () =>
    {
        const input: TupleElement[] = [0, 42n, -7n, 2n ** 63n - 1n, 'a\u0000b', new Uint8Array([0, 255])];
        const decoded = TupleCodec.Decode(TupleCodec.Encode(input));
        assert.deepEqual(decoded, [0n, 42n, -7n, 2n ** 63n - 1n, 'a\u0000b', new Uint8Array([0, 255])]);
    });

    it('matches FoundationDB reference bytes', () =>
    {
        assert.deepEqual([...TupleCodec.Encode([0n])], [0x14]);
        assert.deepEqual([...TupleCodec.Encode([1n])], [0x15, 0x01]);
        assert.deepEqual([...TupleCodec.Encode([-1n])], [0x13, 0xfe]);
        assert.deepEqual([...TupleCodec.Encode([256n])], [0x16, 0x01, 0x00]);
        assert.deepEqual([...TupleCodec.Encode([-256n])], [0x12, 0xfe, 0xff]);
        assert.deepEqual([...TupleCodec.Encode(['a\u0000'])], [0x02, 0x61, 0x00, 0xff, 0x00]);
        assert.deepEqual([...TupleCodec.Encode([new Uint8Array([0x01])])], [0x01, 0x01, 0x00]);
    });

    it('round-trips 64-bit extremes', () =>
    {
        const values = [-(2n ** 64n) + 1n, -(2n ** 63n), -1n, 0n, 1n, 2n ** 64n - 1n];
        for (const v of values)
        {
            assert.deepEqual(TupleCodec.Decode(TupleCodec.Encode([v])), [v]);
        }
    });

    it('orders integers like their logical order', () =>
    {
        const sorted = [-(2n ** 64n) + 1n, -(2n ** 63n), -70000n, -256n, -255n, -7n, -1n, 0n, 1n, 7n, 255n, 256n, 70000n, 2n ** 63n - 1n, 2n ** 64n - 1n];
        TupleCodecTestHelper.AssertSortedAndDistinct(sorted);
    });

    it('orders strings bytewise', () =>
    {
        const sorted = ['', 'a', 'a\u0000', 'a\u0000b', 'ab', 'abc', 'b', 'é'];
        TupleCodecTestHelper.AssertSortedAndDistinct(sorted);
    });

    it('orders by type code across kinds', () =>
    {
        TupleCodecTestHelper.AssertSortedAndDistinct([new Uint8Array([9]), 'a', -5n, 5n]);
    });

    it('sorts a prefix tuple before its extensions and before longer siblings', () =>
    {
        const ab = TupleCodec.Encode(['ab']);
        assert.ok(TupleCodec.Compare(ab, TupleCodec.Encode(['ab', 1])) < 0);
        assert.ok(TupleCodec.Compare(ab, TupleCodec.Encode(['abc'])) < 0);
    });

    it('computes an exclusive prefix end', () =>
    {
        const end = TupleCodec.PrefixEnd(TupleCodec.Encode([5n]));
        assert.ok(TupleCodec.Compare(end, TupleCodec.Encode([5n, 'zzz'])) > 0);
        assert.ok(TupleCodec.Compare(end, TupleCodec.Encode([6n])) <= 0);
        assert.deepEqual([...TupleCodec.PrefixEnd(new Uint8Array([1, 0xff, 0xff]))], [2]);
    });

    it('rejects invalid input', () =>
    {
        assert.throws(() => TupleCodec.Encode([-1]));
        assert.throws(() => TupleCodec.Encode([1.5]));
        assert.throws(() => TupleCodec.Encode([Number.MAX_SAFE_INTEGER + 1]));
        assert.throws(() => TupleCodec.Encode([2n ** 64n]));
        assert.throws(() => TupleCodec.Encode([-(2n ** 64n)]));
        assert.throws(() => TupleCodec.Decode(new Uint8Array([0x99])));
        assert.throws(() => TupleCodec.Decode(new Uint8Array([0x16, 0x01])));
        assert.throws(() => TupleCodec.Decode(new Uint8Array([0x02, 0x61])));
        assert.throws(() => TupleCodec.PrefixEnd(new Uint8Array([0xff])));
    });
});

class TupleCodecTestHelper
{
    public static AssertSortedAndDistinct(sorted: readonly TupleElement[]): void
    {
        for (let i = 0; i < sorted.length; i++)
        {
            for (let j = 0; j < sorted.length; j++)
            {
                const a = sorted[i] as TupleElement;
                const b = sorted[j] as TupleElement;
                const cmp = TupleCodec.Compare(TupleCodec.Encode([a]), TupleCodec.Encode([b]));
                assert.equal(Math.sign(cmp), Math.sign(i - j), `order of #${i} vs #${j}`);
            }
        }
    }
}
