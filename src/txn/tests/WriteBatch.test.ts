import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DateTimeValue, DateValue, DurationValue } from '../../columns/CellValue.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { ConflictKeys } from '../ConflictKeys.js';
import { ReadSet } from '../ReadSet.js';
import { Signal } from '../Signal.js';
import { WriteBatch, WriteOp } from '../WriteBatch.js';

class BatchFx
{
    /** A batch exercising every op, every value type, null, and every LinkOptions shape. */
    public static Full(): WriteBatch
    {
        const b = new WriteBatch();
        b.CreateNode('p1', 'Person');
        b.CreateNode('p2', 'Person', 'cluster-a');
        b.SetProperty('p1', 'flag', true);
        b.SetProperty('p1', 'age', -42n);
        b.SetProperty('p1', 'score', -0.5);
        b.SetProperty('p1', 'name', 'Zoë \u{1F600}');
        b.SetProperty('p1', 'born', new DateValue(-3));
        b.SetProperty('p1', 'seen', new DateTimeValue(1234567890123n, 'Europe/Kyiv'));
        b.SetProperty('p1', 'span', new DurationValue(1, -2, 3n));
        b.SetProperty('p1', 'gone', null);
        b.Link('p1', 'knows', 'p2');
        b.Link('p1', 'friends', 'p2', {});
        b.Link('p1', 'friends', 'p3', { AfterSibling: 'p2' });
        b.Link('p1', 'friends', 'p4', { BeforeSibling: 'p3', AfterSibling: 'p2' });
        b.Link('p1', 'rated', 'p2', { Properties: new Map([['weight', 7n], ['note', null]]) });
        b.Unlink('p1', 'knows', 'p2');
        b.DeleteNode('p2');
        return b;
    }
}

describe('WriteBatch', () =>
{
    it('records operations in order with their fields', () =>
    {
        const b = new WriteBatch();
        b.CreateNode('a', 'Person', 'h');
        b.SetProperty('a', 'name', 'Ann');
        b.Link('a', 'knows', 'b', { AfterSibling: 'c' });
        b.Unlink('a', 'knows', 'b');
        b.DeleteNode('a');
        assert.deepEqual(b.Ops().map(o => o.Op), [WriteOp.CreateNode, WriteOp.SetProperty, WriteOp.Link, WriteOp.Unlink, WriteOp.DeleteNode]);
        assert.deepEqual(b.Ops()[0], { Op: WriteOp.CreateNode, PublicId: 'a', Concept: 'Person', ClusterHint: 'h' });
        assert.deepEqual(b.Ops()[2], { Op: WriteOp.Link, From: 'a', Relationship: 'knows', To: 'b', Options: { AfterSibling: 'c' } });
        assert.equal(b.Count, 5);
    });

    it('Deserialize(Serialize(b)) deep-equals b for every op and value type', () =>
    {
        const b = BatchFx.Full();
        const copy = WriteBatch.Deserialize(b.Serialize());
        assert.deepEqual(copy, b);
        assert.deepEqual(copy.Serialize(), b.Serialize());
    });

    it('round-trips the empty batch', () =>
    {
        const b = new WriteBatch();
        assert.deepEqual(WriteBatch.Deserialize(b.Serialize()), b);
    });

    it('starts with format version 1 and a u32 LE op count', () =>
    {
        const b = new WriteBatch();
        b.DeleteNode('x');
        const bytes = b.Serialize();
        assert.deepEqual([...bytes], [1, 1, 0, 0, 0, WriteOp.DeleteNode, 1, 0, 0, 0, 0x78]);
    });

    it('copies caller data so later mutation does not change the batch', () =>
    {
        const props = new Map<string, bigint | null>([['weight', 1n]]);
        const b = new WriteBatch();
        b.Link('a', 'rated', 'b', { Properties: props });
        props.set('weight', 2n);
        const op = b.Ops()[0];
        assert.ok(op !== undefined && op.Op === WriteOp.Link);
        assert.equal(op.Options?.Properties?.get('weight'), 1n);
    });

    it('rejects unsupported cell values at record time', () =>
    {
        const b = new WriteBatch();
        assert.throws(() => b.SetProperty('a', 'x', undefined as never), TypeError);
        assert.throws(() => b.SetProperty('a', 'x', (1n << 64n)), RangeError);
        assert.throws(() => b.Link('a', 'r', 'b', { Properties: new Map([['w', {} as never]]) }), TypeError);
    });

    it('rejects corrupt bytes: bad version, unknown op, truncation, trailing bytes, invalid UTF-8', () =>
    {
        const good = BatchFx.Full().Serialize();
        const badVersion = good.slice();
        badVersion[0] = 2;
        const unknownOp = Uint8Array.of(1, 1, 0, 0, 0, 99);
        const trailing = Uint8Array.of(...good, 0);
        const badUtf8 = Uint8Array.of(1, 1, 0, 0, 0, WriteOp.DeleteNode, 1, 0, 0, 0, 0xff);
        const badTag = Uint8Array.of(1, 1, 0, 0, 0, WriteOp.SetProperty, 1, 0, 0, 0, 0x61, 1, 0, 0, 0, 0x62, 42);
        for (const bytes of [badVersion, unknownOp, good.subarray(0, good.length - 1), trailing, badUtf8, badTag, new Uint8Array(0)])
        {
            assert.throws(() => WriteBatch.Deserialize(bytes), RangeError);
        }
    });
});

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

describe('Signal', () =>
{
    it('delivers to every subscriber in subscription order until disposed', () =>
    {
        const s = new Signal<number>();
        const seen: string[] = [];
        const a = s.Subscribe(v => seen.push('a' + v));
        s.Subscribe(v => seen.push('b' + v));
        s.Raise(1);
        a.dispose();
        a.dispose();
        s.Raise(2);
        assert.deepEqual(seen, ['a1', 'b1', 'b2']);
    });

    it('runs every handler even when one throws, then throws an AggregateError', () =>
    {
        const s = new Signal<number>();
        const seen: number[] = [];
        s.Subscribe(() =>
        {
            throw new Error('boom');
        });
        s.Subscribe(v => seen.push(v));
        assert.throws(() => s.Raise(5), AggregateError);
        assert.deepEqual(seen, [5]);
    });

    it('a handler subscribing or disposing during Raise does not affect the current delivery', () =>
    {
        const s = new Signal<number>();
        const seen: string[] = [];
        let late: { dispose(): void } | undefined;
        const first = s.Subscribe(v =>
        {
            seen.push('first' + v);
            late ??= s.Subscribe(w => seen.push('late' + w));
            first.dispose();
        });
        s.Raise(1);
        s.Raise(2);
        assert.deepEqual(seen, ['first1', 'late2']);
        late?.dispose();
    });
});
