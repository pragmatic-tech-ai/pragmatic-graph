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
        assert.deepEqual(FractionalPosition.First, Uint8Array.of(0x80));
    });

    it('inserts before the first and after the last', () =>
    {
        const first = FractionalPosition.First;
        const before = FractionalPosition.Between(null, first);
        const after = FractionalPosition.Between(first, null);
        assert.ok(TupleCodec.Compare(before, first) < 0);
        assert.ok(TupleCodec.Compare(first, after) < 0);
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

    it('rejects out-of-order or malformed bounds', () =>
    {
        const a = FractionalPosition.First;
        assert.throws(() => FractionalPosition.Between(a, a));
        assert.throws(() => FractionalPosition.Between(new Uint8Array([0x90]), new Uint8Array([0x80])));
        assert.throws(() => FractionalPosition.Between(null, new Uint8Array([0x80, 0x00])));
    });
});

class FractionalPositionTestHelper
{
    public static RunSameSpot(rightAnchored: boolean): void
    {
        const list: Uint8Array[] = [new Uint8Array([0x40]), new Uint8Array([0xc0])];
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
