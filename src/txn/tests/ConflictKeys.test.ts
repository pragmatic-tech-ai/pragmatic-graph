import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { ConflictKeys } from '../ConflictKeys.js';
import { ReadSet } from '../ReadSet.js';

describe('ConflictKeys', () =>
{
    it('Edge keys fall inside their Adjacency range; Extent inside ExtentRange', () =>
    {
        const range = ConflictKeys.Adjacency(3, EdgeDirection.In, 4n);
        const r = new ReadSet();
        r.AddRange(Keyspace.Edges, range);
        assert.equal(r.Intersects(Keyspace.Edges, ConflictKeys.Edge(3, EdgeDirection.In, 4n, 1n)), true);
        const x = new ReadSet();
        x.AddRange(Keyspace.Rows, ConflictKeys.ExtentRange(2));
        assert.equal(x.Intersects(Keyspace.Rows, ConflictKeys.Extent(2)), true);
        assert.equal(x.Intersects(Keyspace.Rows, ConflictKeys.Extent(3)), false);
    });
});
