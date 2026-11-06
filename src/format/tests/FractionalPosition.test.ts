import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FractionalPosition } from '../FractionalPosition.js';
import { TupleCodec } from '../TupleCodec.js';

describe('FractionalPosition', () =>
{
    it('returns First for an empty list', () =>
    {
        assert.deepEqual(FractionalPosition.Between(null, null), FractionalPosition.First);
    });

    it('returns a copy of First so callers cannot mutate the shared instance', () =>
    {
        const copy = FractionalPosition.Between(null, null);
        copy[0] = 0x01;
        assert.deepEqual(FractionalPosition.First, Uint8Array.of(0x80, 0x80));
    });

    it('inserts before the first and after the last', () =>
    {
        const first = FractionalPosition.First;
        const before = FractionalPosition.Between(null, first);
        const after = FractionalPosition.Between(first, null);
        assert.ok(TupleCodec.Compare(before, first) < 0);
        assert.ok(TupleCodec.Compare(first, after) < 0);
    });

    it('appends and prepends grow logarithmically: 100,000 of each stay within 5 bytes (F1)', () =>
    {
        let hi: Uint8Array | null = null;
        let lo: Uint8Array | null = null;
        const lengths = new Map<number, number>();
        for (let i = 1; i <= 100000; i++)
        {
            const nhi: Uint8Array = FractionalPosition.Between(hi, null);
            const nlo: Uint8Array = FractionalPosition.Between(null, lo ?? nhi);
            if (hi !== null)
            {
                assert.ok(TupleCodec.Compare(hi, nhi) < 0);
            }
            if (lo !== null)
            {
                assert.ok(TupleCodec.Compare(nlo, lo) < 0);
            }
            hi = nhi;
            lo = nlo;
            if (i === 2000 || i === 16000 || i === 100000)
            {
                lengths.set(i, Math.max(nhi.length, nlo.length));
            }
        }
        for (const [n, length] of lengths)
        {
            assert.ok(length <= 5, n + ' appends gave ' + length + ' bytes');
        }
    });

    it('keeps order over 1000 inserts at the same spot, between the new item and its right neighbour', () =>
    {
        FractionalPositionTestHelper.RunSameSpot(true);
    });

    it('keeps order over 1000 inserts at the same spot, between the left neighbour and the new item', () =>
    {
        FractionalPositionTestHelper.RunSameSpot(false);
    });

    it('keeps order over 1000 repeated prepends and appends', () =>
    {
        let lo = FractionalPosition.First;
        let hi = FractionalPosition.First;
        for (let i = 0; i < 1000; i++)
        {
            const nlo = FractionalPosition.Between(null, lo);
            const nhi = FractionalPosition.Between(hi, null);
            assert.ok(TupleCodec.Compare(nlo, lo) < 0);
            assert.ok(TupleCodec.Compare(nhi, hi) > 0);
            lo = nlo;
            hi = nhi;
        }
    });

    it('random inserts into one list keep strict order and only produce valid positions', () =>
    {
        const list: Uint8Array[] = [];
        let seed = 12345;
        for (let i = 0; i < 5000; i++)
        {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            const at = list.length === 0 ? 0 : seed % (list.length + 1);
            const created = FractionalPosition.Between(at === 0 ? null : list[at - 1] as Uint8Array, at === list.length ? null : list[at] as Uint8Array);
            assert.ok(FractionalPosition.IsValid(created));
            list.splice(at, 0, created);
        }
        for (let i = 0; i + 1 < list.length; i++)
        {
            assert.ok(TupleCodec.Compare(list[i] as Uint8Array, list[i + 1] as Uint8Array) < 0, 'strict order at ' + i);
        }
    });

    it('steps across integer widths in order (head overflow up and down)', () =>
    {
        const below = Uint8Array.of(0x80, 0xff);
        const above = FractionalPosition.Between(below, null);
        assert.deepEqual(above, Uint8Array.of(0x81, 0x00, 0x01));
        assert.ok(TupleCodec.Compare(below, above) < 0);
        const down = FractionalPosition.Between(null, Uint8Array.of(0x80, 0x01));
        assert.deepEqual(down, Uint8Array.of(0x7f, 0xff));
        assert.ok(TupleCodec.Compare(FractionalPosition.Between(down, Uint8Array.of(0x80, 0x01)), Uint8Array.of(0x80, 0x01)) < 0);
    });

    it('Sequence gives consecutive, short, ascending positions starting at First', () =>
    {
        const seq = FractionalPosition.Sequence(70000);
        assert.deepEqual(seq[0], FractionalPosition.First);
        for (let i = 0; i + 1 < seq.length; i++)
        {
            assert.ok(TupleCodec.Compare(seq[i] as Uint8Array, seq[i + 1] as Uint8Array) < 0);
        }
        assert.ok(Math.max(...seq.map(p => p.length)) <= 4);
    });

    it('rejects out-of-order or malformed bounds', () =>
    {
        const a = FractionalPosition.First;
        assert.throws(() => FractionalPosition.Between(a, a));
        assert.throws(() => FractionalPosition.Between(Uint8Array.of(0x80, 0x90), Uint8Array.of(0x80, 0x80)));
        assert.throws(() => FractionalPosition.Between(null, Uint8Array.of(0x80, 0x80, 0x00)), 'ends in 0x00');
        assert.throws(() => FractionalPosition.Between(null, Uint8Array.of(0x81, 0x01)), 'integer part cut short');
        assert.throws(() => FractionalPosition.Between(null, Uint8Array.of()));
        assert.equal(FractionalPosition.IsValid(Uint8Array.of(0x80, 0x00)), false);
        assert.equal(FractionalPosition.IsValid(Uint8Array.of(0x80, 0x00, 0x80)), true);
    });
});

class FractionalPositionTestHelper
{
    public static RunSameSpot(rightAnchored: boolean): void
    {
        const left = FractionalPosition.First;
        const right = FractionalPosition.Between(left, null);
        const list: Uint8Array[] = [left, right];
        const snapshot = list.map(p => Uint8Array.from(p));
        let insertAt = 1;
        for (let i = 0; i < 1000; i++)
        {
            const created = FractionalPosition.Between(list[insertAt - 1] as Uint8Array, list[insertAt] as Uint8Array);
            list.splice(insertAt, 0, created);
            snapshot.splice(insertAt, 0, Uint8Array.from(created));
            if (!rightAnchored)
            {
                insertAt += 1;
            }
        }
        for (let i = 0; i + 1 < list.length; i++)
        {
            assert.ok(TupleCodec.Compare(list[i] as Uint8Array, list[i + 1] as Uint8Array) < 0, `strict order at ${i}`);
        }
        for (let i = 0; i < list.length; i++)
        {
            assert.deepEqual(list[i], snapshot[i]);
        }
        const longest = Math.max(...list.map(p => p.length));
        assert.ok(longest < 1100, `longest ${longest}`);
    }
}
