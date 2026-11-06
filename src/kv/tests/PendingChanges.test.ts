import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TupleCodec } from '../../format/TupleCodec.js';
import { ScanCounter } from '../KeyValue.js';
import { PendingChanges } from '../PendingChanges.js';
import { Linearity } from './Linearity.js';

/** Seeded generator (mulberry32) so failures reproduce. */
class Rng
{
    private state: number;

    public constructor(seed: number)
    {
        this.state = seed >>> 0;
    }

    public Int(below: number): number
    {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (((t ^ (t >>> 14)) >>> 0) % below);
    }
}

class PendingFx
{
    public static Key(n: number): Uint8Array
    {
        return TupleCodec.Encode([n]);
    }

    /** Reference merge: stored entries overlaid with staged changes, in key order, cut at limit. */
    public static Expected(stored: ReadonlyMap<number, number>, staged: ReadonlyMap<number, number | null>, from: number, to: number, limit?: number): number[]
    {
        const all = new Map(stored);
        for (const [k, v] of staged)
        {
            if (v === null)
            {
                all.delete(k);
            }
            else
            {
                all.set(k, v);
            }
        }
        const keys = [...all.keys()].filter(k => k >= from && k < to).sort((a, b) => a - b);
        return limit === undefined ? keys : keys.slice(0, limit);
    }

    public static Actual(base: ReadonlyMap<number, number>, pending: PendingChanges, from: number, to: number, limit?: number): Array<[number, number]>
    {
        const stored = [...base.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [PendingFx.Key(k), Uint8Array.of(v)] as const);
        const range = { Start: PendingFx.Key(from), End: PendingFx.Key(to) };
        const inRange = stored.filter(([k]) => TupleCodec.Compare(k, range.Start) >= 0 && TupleCodec.Compare(k, range.End) < 0);
        const out: Array<[number, number]> = [];
        for (const [k, v] of PendingChanges.Merge(inRange, pending.InRange(range), new ScanCounter(), limit))
        {
            out.push([Number(TupleCodec.Decode(k)[0]), v[0] as number]);
        }
        return out;
    }
}

describe('PendingChanges', () =>
{
    it('matches a reference sorted map over seeded random Put/Delete/Get/Scan(limit) interleavings', () =>
    {
        for (const seed of [1, 7, 42, 1234, 99991])
        {
            const rng = new Rng(seed);
            const stored = new Map<number, number>();
            for (let i = 0; i < 300; i++)
            {
                stored.set(rng.Int(5000), 1 + rng.Int(200));
            }
            const pending = new PendingChanges();
            const staged = new Map<number, number | null>();
            for (let step = 0; step < 6000; step++)
            {
                const op = rng.Int(10);
                const k = rng.Int(5000);
                if (op < 5)
                {
                    const v = 1 + rng.Int(200);
                    pending.Set(PendingFx.Key(k), Uint8Array.of(v));
                    staged.set(k, v);
                }
                else if (op < 7)
                {
                    pending.Set(PendingFx.Key(k), null);
                    staged.set(k, null);
                }
                else if (op < 8)
                {
                    const got = pending.Get(PendingFx.Key(k));
                    const want = staged.get(k);
                    assert.equal(got === undefined ? undefined : got.Value === null ? null : got.Value[0], want, 'seed ' + seed + ' step ' + step + ' Get ' + k);
                }
                else
                {
                    const a = rng.Int(5000);
                    const b = a + rng.Int(2000);
                    const limit = rng.Int(3) === 0 ? undefined : rng.Int(20);
                    const actual = PendingFx.Actual(stored, pending, a, b, limit);
                    assert.deepEqual(actual.map(e => e[0]), PendingFx.Expected(stored, staged, a, b, limit), 'seed ' + seed + ' step ' + step);
                    for (const [key, v] of actual)
                    {
                        const s = staged.get(key);
                        assert.equal(v, s === undefined || s === null ? stored.get(key) : s);
                    }
                }
            }
            assert.equal(pending.Size, staged.size);
            assert.deepEqual([...pending.Values()].map(c => Number(TupleCodec.Decode(c.Key)[0])), [...staged.keys()].sort((x, y) => x - y));
        }
    });

    it('InRange throws a clear error on any Set during iteration: a new key, a replacement or a delete', () =>
    {
        const pending = new PendingChanges();
        for (const k of [1, 2, 3])
        {
            pending.Set(PendingFx.Key(k), Uint8Array.of(k));
        }
        const all = { Start: PendingFx.Key(0), End: PendingFx.Key(100) };
        for (const change of [[2, 9], [3, null], [50, 5]] as const)
        {
            const rows = pending.InRange(all)[Symbol.iterator]();
            rows.next();
            const before = PendingChanges.VersionOf(pending);
            pending.Set(PendingFx.Key(change[0]), change[1] === null ? null : Uint8Array.of(change[1]));
            assert.equal(PendingChanges.VersionOf(pending), before + 1);
            assert.throws(() => rows.next(), /changed during the scan/, 'Set of ' + change[0]);
        }
        assert.equal(PendingChanges.VersionOf(undefined), 0);
    });

    it('stays linear for many keys in random order and for alternating Set and bounded scans', async () =>
    {
        await Linearity.Check('PendingChanges random Set + alternating Set/InRange', 20000, n =>
        {
            const pending = new PendingChanges();
            const rng = new Rng(5);
            for (let i = 0; i < n; i++)
            {
                pending.Set(PendingFx.Key(rng.Int(1_000_000_000)), Uint8Array.of(1));
            }
            for (let i = 0; i < n / 10; i++)
            {
                const k = rng.Int(1_000_000_000);
                pending.Set(PendingFx.Key(k), Uint8Array.of(2));
                const first = pending.InRange({ Start: PendingFx.Key(k), End: PendingFx.Key(k + 1_000_000) })[Symbol.iterator]().next();
                assert.equal(first.done, false);
            }
        }, 3);
    });
});
