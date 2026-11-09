import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DateTimeValue, DateValue, DurationValue } from '../../columns/CellValue.js';
import { WriteBatch, WriteOp } from '../WriteBatch.js';

class BatchFx
{
    /** A batch exercising every op, every value type, null, and every LinkOptions shape. */
    public static Full(): WriteBatch
    {
        const b = new WriteBatch();
        b.CreateNode('p1', 'Person');
        b.CreateNode('p2', 'Person', { ClusterHint: 'cluster-a' });
        b.CreateNode('p5', 'Person', { Owner: 'm1' });
        b.CreateNode('p6', 'Person', { ClusterHint: 'cluster-b', Owner: 'm2' });
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
        b.CreateNode('a', 'Person', { ClusterHint: 'h', Owner: 'm' });
        b.SetProperty('a', 'name', 'Ann');
        b.Link('a', 'knows', 'b', { AfterSibling: 'c' });
        b.Unlink('a', 'knows', 'b');
        b.DeleteNode('a');
        assert.deepEqual(b.Ops().map(o => o.Op), [WriteOp.CreateNode, WriteOp.SetProperty, WriteOp.Link, WriteOp.Unlink, WriteOp.DeleteNode]);
        assert.deepEqual(b.Ops()[0], { Op: WriteOp.CreateNode, PublicId: 'a', Concept: 'Person', ClusterHint: 'h', Owner: 'm' });
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

    it('a strict DeleteNode records Strict and serializes as kind 6; a plain one keeps kind 3 bytes', () =>
    {
        const b = new WriteBatch();
        b.DeleteNode('x', { Strict: true });
        b.DeleteNode('y', { Strict: false });
        assert.deepEqual(b.Ops(), [{ Op: WriteOp.DeleteNode, PublicId: 'x', Strict: true }, { Op: WriteOp.DeleteNode, PublicId: 'y' }]);
        const bytes = b.Serialize();
        assert.equal(WriteOp.StrictDeleteNode, 6, 'kind 6 is reserved for the strict delete');
        assert.deepEqual([...bytes], [1, 2, 0, 0, 0, WriteOp.StrictDeleteNode, 1, 0, 0, 0, 0x78, WriteOp.DeleteNode, 1, 0, 0, 0, 0x79]);
        assert.ok(b.Ops().every(o => (o.Op as WriteOp) !== WriteOp.StrictDeleteNode), 'never a recorded Op');
        assert.deepEqual(WriteBatch.Deserialize(bytes).Ops(), b.Ops());
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

    it('rejects unknown CreateNode flags', () =>
    {
        const bytes = Uint8Array.of(1, 1, 0, 0, 0, WriteOp.CreateNode, 1, 0, 0, 0, 0x61, 1, 0, 0, 0, 0x50, 4, 1, 0, 0, 0, 0x68);
        assert.throws(() => WriteBatch.Deserialize(bytes), RangeError);
        bytes[16] = 1;
        assert.equal(WriteBatch.Deserialize(bytes).Ops()[0]?.Op, WriteOp.CreateNode);
    });

    it('Ops() is a frozen copy and edge property maps are read-only', () =>
    {
        const b = new WriteBatch();
        b.Link('a', 'rated', 'b', { Properties: new Map([['weight', 1n]]) });
        const ops = b.Ops();
        assert.ok(Object.isFrozen(ops));
        assert.throws(() => (ops as unknown as unknown[]).push(1), TypeError);
        b.DeleteNode('a');
        assert.equal(ops.length, 1);
        assert.equal(b.Ops().length, 2);
        const op = ops[0];
        assert.ok(op !== undefined && op.Op === WriteOp.Link);
        assert.ok(Object.isFrozen(op) && Object.isFrozen(op.Options));
        const props = op.Options?.Properties as Map<string, unknown>;
        assert.throws(() => props.set('weight', 2n), TypeError);
        assert.throws(() => props.delete('weight'), TypeError);
        assert.throws(() => props.clear(), TypeError);
        assert.equal(props.get('weight'), 1n);
    });

    it('a sealed batch rejects further recording and still equals its unsealed copy', () =>
    {
        const b = new WriteBatch();
        b.CreateNode('a', 'Person');
        const copy = WriteBatch.Deserialize(b.Serialize());
        assert.equal(b.Seal(), b);
        assert.equal(b.IsSealed, true);
        assert.equal(copy.IsSealed, false);
        assert.throws(() => b.CreateNode('b', 'Person'), TypeError);
        assert.throws(() => b.SetProperty('a', 'x', 1n), TypeError);
        assert.throws(() => b.DeleteNode('a'), TypeError);
        assert.throws(() => b.Link('a', 'r', 'b'), TypeError);
        assert.throws(() => b.Unlink('a', 'r', 'b'), TypeError);
        assert.deepEqual(copy, b);
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
