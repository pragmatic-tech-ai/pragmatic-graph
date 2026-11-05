import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../kv/memory/MemoryStore.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { FormatMeta, FormatVersionMismatchError } from '../FormatMeta.js';
import { EdgeDirection, FormatKeys } from '../FormatKeys.js';
import { FractionalPosition } from '../FractionalPosition.js';
import { TupleCodec } from '../TupleCodec.js';

describe('FormatMeta', () =>
{
    it('Initialize then Verify passes', async () =>
    {
        const store = new MemoryStore();
        await store.Write(txn => FormatMeta.Initialize(txn));
        const read = await store.BeginRead();
        await FormatMeta.Verify(read);
        read.dispose();
        await store.dispose();
    });

    it('rejects a different stored version', async () =>
    {
        const store = new MemoryStore();
        await store.Write(async txn => { txn.Put(Keyspace.Meta, FormatKeys.Meta('format'), TupleCodec.Encode([2n])); });
        const read = await store.BeginRead();
        await assert.rejects(FormatMeta.Verify(read), FormatVersionMismatchError);
        read.dispose();
        await store.dispose();
    });

    it('rejects an uninitialized store', async () =>
    {
        const store = new MemoryStore();
        const read = await store.BeginRead();
        await assert.rejects(FormatMeta.Verify(read), FormatVersionMismatchError);
        read.dispose();
        await store.dispose();
    });
});

describe('FormatKeys', () =>
{
    it('orders edges by position then other id, all inside the edge range', () =>
    {
        const lo = FractionalPosition.Between(null, null);
        const hi = FractionalPosition.Between(lo, null);
        const keys = [
            FormatKeys.Edge(0, 3, EdgeDirection.Out, 7n, hi, 1n),
            FormatKeys.Edge(0, 3, EdgeDirection.Out, 7n, lo, 9n),
            FormatKeys.Edge(0, 3, EdgeDirection.Out, 7n, lo, 2n),
        ];
        const sorted = [...keys].sort(TupleCodec.Compare);
        assert.deepEqual(sorted, [keys[2], keys[1], keys[0]]);
        const range = FormatKeys.EdgeRange(0, 3, EdgeDirection.Out, 7n);
        for (const k of keys)
        {
            assert.ok(TupleCodec.Compare(range.Start, k) <= 0 && TupleCodec.Compare(k, range.End) < 0);
        }
        const otherNode = FormatKeys.Edge(0, 3, EdgeDirection.Out, 8n, lo, 1n);
        const otherDir = FormatKeys.Edge(0, 3, EdgeDirection.In, 7n, lo, 1n);
        for (const k of [otherNode, otherDir])
        {
            assert.ok(TupleCodec.Compare(k, range.Start) < 0 || TupleCodec.Compare(k, range.End) >= 0);
        }
    });

    it('keeps the two Ids key families disjoint', () =>
    {
        assert.notDeepEqual(FormatKeys.PublicToInternal('1'), FormatKeys.InternalToPublic(1n));
    });

    it('builds Meta keys from name and qualifiers', () =>
    {
        assert.deepEqual(TupleCodec.Decode(FormatKeys.Meta('x', 5, 'q')), ['x', 5n, 'q']);
    });

    it('orders Column and Delta keys by chunk across byte-width boundaries', () =>
    {
        const chunks = [0n, 1n, 255n, 256n, 65535n, 65536n];
        for (const build of [FormatKeys.Column, FormatKeys.Delta])
        {
            const keys = chunks.map(c => build(0, 4, 2, c));
            assert.deepEqual([...keys].sort(TupleCodec.Compare), keys);
        }
    });

    it('orders LogEntry keys by commit across byte-width boundaries', () =>
    {
        const commits = [1n, 255n, 256n, 65535n, 65536n];
        const keys = commits.map(c => FormatKeys.LogEntry(c));
        assert.deepEqual([...keys].sort(TupleCodec.Compare), keys);
    });
});
