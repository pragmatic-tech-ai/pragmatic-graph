import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { ConflictKeys } from '../ConflictKeys.js';
import { ReadSet } from '../ReadSet.js';
import { WriteKeySet } from '../WriteKeySet.js';
import { Linearity } from '../../kv/tests/Linearity.js';
import { TupleCodec } from '../../format/TupleCodec.js';

describe('ReadSet', () =>
{
    it('matches added keys exactly, per keyspace', () =>
    {
        const r = new ReadSet();
        const key = ConflictKeys.Cell(5n, 3);
        r.AddKey(Keyspace.Columns, key);
        assert.equal(r.Intersects(Keyspace.Columns, ConflictKeys.Cell(5n, 3)), true);
        assert.equal(r.Intersects(Keyspace.Columns, ConflictKeys.Cell(5n, 4)), false);
        assert.equal(r.Intersects(Keyspace.Ids, key), false);
    });

    it('keeps ranges sorted and coalesced: overlapping and adjacent ranges merge, disjoint ones stay (F7)', () =>
    {
        const r = new ReadSet();
        const k = (n: number): Uint8Array => TupleCodec.Encode([n]);
        r.AddRange(Keyspace.Edges, { Start: k(50), End: k(60) });
        r.AddRange(Keyspace.Edges, { Start: k(10), End: k(20) });
        r.AddRange(Keyspace.Edges, { Start: k(20), End: k(30) });
        r.AddRange(Keyspace.Edges, { Start: k(70), End: k(80) });
        assert.equal(r.RangeCount, 3, 'adjacent [10,20) + [20,30) coalesce');
        r.AddRange(Keyspace.Edges, { Start: k(25), End: k(75) });
        assert.equal(r.RangeCount, 1, 'one range spanning the others swallows them');
        assert.equal(r.Intersects(Keyspace.Edges, k(10)), true);
        assert.equal(r.Intersects(Keyspace.Edges, k(79)), true);
        assert.equal(r.Intersects(Keyspace.Edges, k(80)), false);
        assert.equal(r.Intersects(Keyspace.Edges, k(9)), false);
        r.AddRange(Keyspace.Edges, { Start: k(5), End: k(5) });
        assert.equal(r.RangeCount, 1, 'empty ranges are ignored');
    });

    it('agrees with a naive check on random ranges and keys', () =>
    {
        let seed = 7;
        const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) % 1000;
        const r = new ReadSet();
        const naive: Array<[number, number]> = [];
        for (let i = 0; i < 300; i++)
        {
            const a = next();
            const b = a + (next() % 20);
            naive.push([a, b]);
            r.AddRange(Keyspace.Edges, { Start: TupleCodec.Encode([a]), End: TupleCodec.Encode([b]) });
        }
        for (let x = 0; x < 1100; x++)
        {
            const expected = naive.some(([a, b]) => a <= x && x < b);
            assert.equal(r.Intersects(Keyspace.Edges, TupleCodec.Encode([x])), expected, 'key ' + x);
        }
    });

    it('validating many write keys against many ranges scales linearly (binary search, F7)', async () =>
    {
        await Linearity.Check('read-set validation', 5000, n =>
        {
            const reads = new ReadSet();
            const writes = new WriteKeySet();
            for (let i = 0; i < n; i++)
            {
                // Every other node's adjacency: n disjoint ranges.
                reads.AddRange(Keyspace.Edges, ConflictKeys.Adjacency(1, EdgeDirection.Out, BigInt(2 * i)));
                writes.Add(Keyspace.Edges, ConflictKeys.Edge(1, EdgeDirection.Out, BigInt(2 * i + 1), 5n));
            }
            assert.equal(writes.Intersects(reads), false);
        }, 3);
    });

    it('matches keys inside half-open ranges', () =>
    {
        const r = new ReadSet();
        r.AddRange(Keyspace.Edges, ConflictKeys.Adjacency(7, EdgeDirection.Out, 10n));
        assert.equal(r.Intersects(Keyspace.Edges, ConflictKeys.Edge(7, EdgeDirection.Out, 10n, 99n)), true);
        assert.equal(r.Intersects(Keyspace.Edges, ConflictKeys.Edge(7, EdgeDirection.In, 10n, 99n)), false);
        assert.equal(r.Intersects(Keyspace.Edges, ConflictKeys.Edge(7, EdgeDirection.Out, 11n, 99n)), false);
        assert.equal(r.Intersects(Keyspace.Edges, ConflictKeys.Edge(8, EdgeDirection.Out, 10n, 99n)), false);
    });

    it('copies keys and ranges so caller mutation does not change it', () =>
    {
        const r = new ReadSet();
        const key = ConflictKeys.Node('a');
        r.AddKey(Keyspace.Ids, key);
        key[key.length - 2] = 0x62;
        assert.equal(r.Intersects(Keyspace.Ids, ConflictKeys.Node('a')), true);
        const c = r.Clone();
        c.AddKey(Keyspace.Ids, ConflictKeys.Node('b'));
        assert.equal(r.Intersects(Keyspace.Ids, ConflictKeys.Node('b')), false);
        assert.equal(c.Intersects(Keyspace.Ids, ConflictKeys.Node('a')), true);
    });

    it('reports emptiness', () =>
    {
        const r = new ReadSet();
        assert.equal(r.IsEmpty, true);
        r.AddRange(Keyspace.Rows, ConflictKeys.ExtentRange(1));
        assert.equal(r.IsEmpty, false);
    });
});
