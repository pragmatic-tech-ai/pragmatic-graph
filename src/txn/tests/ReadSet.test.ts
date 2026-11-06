import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { ConflictKeys } from '../ConflictKeys.js';
import { ReadSet } from '../ReadSet.js';

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
