import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TupleCodec } from '../../format/TupleCodec.js';
import { Keyspace } from '../Keyspace.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { KeyValueConformance } from './KeyValueConformance.js';

KeyValueConformance.Register('memory', async () => new MemoryStore());

describe('memory store commit', () =>
{
    it('rebuilds only keyspaces with staged changes: a keyspace that was only scanned is shared', async () =>
    {
        const store = new MemoryStore();
        const all = { Start: Uint8Array.of(0), End: Uint8Array.of(0xff) };
        await store.Write(async txn => txn.Put(Keyspace.Rows, Uint8Array.of(1), Uint8Array.of(1)));
        const before = store.KeyspacesRebuilt;
        await store.Write(async txn =>
        {
            for await (const _ of txn.Scan(Keyspace.Rows, all))
            {
                // only reading
            }
            txn.Put(Keyspace.Meta, Uint8Array.of(2), Uint8Array.of(2));
        });
        assert.equal(store.KeyspacesRebuilt - before, 1);
        await store.dispose();
    });
});

describe('memory store copy-on-write commits (F9)', () =>
{
    it('a commit copies only the leaves it touches, not the whole keyspace', async () =>
    {
        const store = new MemoryStore();
        const key = (n: number): Uint8Array => TupleCodec.Encode([n]);
        await store.Write(async txn =>
        {
            for (let i = 0; i < 100000; i++)
            {
                txn.Put(Keyspace.Rows, key(2 * i), Uint8Array.of(1));
            }
        });
        const before = store.EntriesCopied;
        await store.Write(async txn =>
        {
            txn.Put(Keyspace.Rows, key(50001), Uint8Array.of(2));
            txn.Delete(Keyspace.Rows, key(10));
        });
        const copied = store.EntriesCopied - before;
        assert.ok(copied <= 2 * 1024, 'copied ' + copied + ' entries');
        const read = await store.BeginRead();
        assert.deepEqual(await read.Get(Keyspace.Rows, key(50001)), Uint8Array.of(2));
        assert.equal(await read.Get(Keyspace.Rows, key(10)), undefined);
        let count = 0;
        let last = -1;
        for await (const [k] of read.Scan(Keyspace.Rows, { Start: Uint8Array.of(0x00), End: Uint8Array.of(0xff) }))
        {
            const n = Number(TupleCodec.Decode(k)[0]);
            assert.ok(n > last);
            last = n;
            count++;
        }
        assert.equal(count, 100000);
        read.dispose();
        await store.dispose();
    });
});
