import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
