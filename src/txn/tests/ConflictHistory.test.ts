import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError } from '../ConflictError.js';
import { ConflictHistory } from '../ConflictHistory.js';
import { ConflictKeys } from '../ConflictKeys.js';
import { ReadSet } from '../ReadSet.js';
import { WriteKeySet } from '../WriteKeySet.js';

class HistoryFx
{
    /** History with commits 1..n where commit i wrote Cell(i, 1); a snapshot at 0 is registered. */
    public static Build(n: number): ConflictHistory
    {
        const h = new ConflictHistory(0n);
        h.Register();
        for (let i = 1; i <= n; i++)
        {
            const keys = new WriteKeySet();
            keys.Add(ConflictKeys.CellSpace, ConflictKeys.Cell(BigInt(i), 1));
            h.Record(BigInt(i), keys);
            h.Prune();
        }
        return h;
    }

    public static Reads(i: number): ReadSet
    {
        const r = new ReadSet();
        r.AddKey(ConflictKeys.CellSpace, ConflictKeys.Cell(BigInt(i), 1));
        return r;
    }
}

describe('ConflictHistory', () =>
{
    it('a read of commit k conflicts exactly for snapshots before k, at every boundary', () =>
    {
        const n = 37;
        const h = HistoryFx.Build(n);
        for (let k = 1; k <= n; k++)
        {
            for (let s = 0; s <= n; s++)
            {
                const conflict = h.Check(HistoryFx.Reads(k), BigInt(s));
                assert.equal(conflict instanceof ConflictError, k > s, `k=${k} s=${s}`);
            }
        }
    });

    it('without registered snapshots keeps only the latest commit', () =>
    {
        const h = new ConflictHistory(0n);
        for (let i = 1; i <= 5; i++)
        {
            const keys = new WriteKeySet();
            keys.Add(ConflictKeys.CellSpace, ConflictKeys.Cell(BigInt(i), 1));
            h.Record(BigInt(i), keys);
            h.Prune();
        }
        assert.equal(h.Floor, 4n);
        assert.ok(h.Check(HistoryFx.Reads(5), 4n) instanceof ConflictError);
        assert.equal(h.Check(HistoryFx.Reads(4), 4n), undefined);
        assert.ok(h.Check(HistoryFx.Reads(1), 3n) instanceof ConflictError, 'below the window');
    });
});
