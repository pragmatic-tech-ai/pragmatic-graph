import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TupleCodec } from '../../format/TupleCodec.js';
import { IKeyRange, IKeyValueStore, IReadTransaction } from '../KeyValue.js';
import { Keyspace } from '../Keyspace.js';

type Open = () => Promise<IKeyValueStore>;
type Reopen = (store: IKeyValueStore) => Promise<IKeyValueStore>;

/** Shared semantic suite every IKeyValueStore backend must pass. */
export class KeyValueConformance
{
    private static readonly SuiteSuffix = ' key-value conformance';
    private static readonly Boom = 'boom';
    private static readonly DisposedPattern = /disposed/i;
    private static readonly Space = Keyspace.Rows;
    private static readonly AllKeys: IKeyRange = {
        Start: Uint8Array.of(),
        End: Uint8Array.of(0xff, 0xff, 0xff, 0xff),
    };

    public static Register(name: string, open: Open, reopen?: Reopen): void
    {
        describe(name + KeyValueConformance.SuiteSuffix, () =>
        {
            KeyValueConformance.Case('puts, gets and deletes', open, KeyValueConformance.PutGetDelete);
            KeyValueConformance.Case('isolates keyspaces', open, KeyValueConformance.Isolation);
            KeyValueConformance.Case('scans in Compare order', open, KeyValueConformance.ScanOrder);
            KeyValueConformance.Case('scan honors End exclusivity and Start inclusivity', open, KeyValueConformance.ScanBounds);
            KeyValueConformance.Case('scan honors limit', open, KeyValueConformance.ScanLimit);
            KeyValueConformance.Case('read snapshot ignores later commits', open, KeyValueConformance.SnapshotIsolation);
            KeyValueConformance.Case('write reads see own pending writes in Get', open, KeyValueConformance.OwnWritesGet);
            KeyValueConformance.Case('write reads see own pending writes in Scan', open, KeyValueConformance.OwnWritesScan);
            KeyValueConformance.Case('a rejected write leaves no trace', open, KeyValueConformance.Rollback);
            KeyValueConformance.Case('writes run one at a time', open, KeyValueConformance.WriteExclusion);
            KeyValueConformance.Case('a rejected write does not block the next one', open, KeyValueConformance.RejectionReleasesLock);
            KeyValueConformance.Case('Put copies key and value', open, KeyValueConformance.CopyOnPut);
            KeyValueConformance.Case('returned buffers are copies', open, KeyValueConformance.CopyOnRead);
            KeyValueConformance.Case('a disposed transaction throws', open, KeyValueConformance.DisposedTransaction);
            if (reopen !== undefined)
            {
                KeyValueConformance.ReopenCase('committed data survives reopen', open, reopen);
            }
        });
    }

    private static Case(title: string, open: Open, body: (store: IKeyValueStore) => Promise<void>): void
    {
        it(title, async () =>
        {
            const store = await open();
            try
            {
                await body(store);
            }
            finally
            {
                await store.dispose();
            }
        });
    }

    private static ReopenCase(title: string, open: Open, reopen: Reopen): void
    {
        it(title, async () =>
        {
            let store = await open();
            try
            {
                await store.Write(async txn =>
                {
                    txn.Put(Keyspace.Meta, KeyValueConformance.Key(1), KeyValueConformance.Val(7));
                    txn.Put(Keyspace.Edges, KeyValueConformance.Key(2), KeyValueConformance.Val(8));
                });
                store = await reopen(store);
                const read = await store.BeginRead();
                try
                {
                    assert.deepEqual(await read.Get(Keyspace.Meta, KeyValueConformance.Key(1)), KeyValueConformance.Val(7));
                    assert.deepEqual(await read.Get(Keyspace.Edges, KeyValueConformance.Key(2)), KeyValueConformance.Val(8));
                }
                finally
                {
                    read.dispose();
                }
            }
            finally
            {
                await store.dispose();
            }
        });
    }

    private static Key(n: number): Uint8Array
    {
        return TupleCodec.Encode([n]);
    }

    private static Val(n: number): Uint8Array
    {
        return Uint8Array.of(n, n + 1);
    }

    private static Range(from: number, to: number): IKeyRange
    {
        return { Start: KeyValueConformance.Key(from), End: KeyValueConformance.Key(to) };
    }

    private static async Collect(iter: AsyncIterable<[Uint8Array, Uint8Array]>): Promise<[Uint8Array, Uint8Array][]>
    {
        const out: [Uint8Array, Uint8Array][] = [];
        for await (const pair of iter)
        {
            out.push(pair);
        }
        return out;
    }

    private static async Keys(read: IReadTransaction, range: IKeyRange, limit?: number): Promise<Uint8Array[]>
    {
        const pairs = await KeyValueConformance.Collect(read.Scan(KeyValueConformance.Space, range, limit));
        return pairs.map(p => p[0]);
    }

    private static async Seed(store: IKeyValueStore, numbers: number[]): Promise<void>
    {
        await store.Write(async txn =>
        {
            for (const n of numbers)
            {
                txn.Put(KeyValueConformance.Space, KeyValueConformance.Key(n), KeyValueConformance.Val(n));
            }
        });
    }

    private static async PutGetDelete(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const key = KeyValueConformance.Key(1);
        await store.Write(async txn =>
        {
            assert.equal(await txn.Get(space, key), undefined);
            txn.Put(space, key, KeyValueConformance.Val(5));
        });
        let read = await store.BeginRead();
        assert.deepEqual(await read.Get(space, key), KeyValueConformance.Val(5));
        read.dispose();
        await store.Write(async txn =>
        {
            txn.Put(space, key, KeyValueConformance.Val(6));
        });
        read = await store.BeginRead();
        assert.deepEqual(await read.Get(space, key), KeyValueConformance.Val(6));
        read.dispose();
        await store.Write(async txn =>
        {
            txn.Delete(space, key);
            txn.Delete(space, KeyValueConformance.Key(99));
        });
        read = await store.BeginRead();
        assert.equal(await read.Get(space, key), undefined);
        read.dispose();
    }

    private static async Isolation(store: IKeyValueStore): Promise<void>
    {
        const key = KeyValueConformance.Key(1);
        await store.Write(async txn =>
        {
            txn.Put(Keyspace.Rows, key, KeyValueConformance.Val(1));
            txn.Put(Keyspace.Columns, key, KeyValueConformance.Val(2));
        });
        const read = await store.BeginRead();
        assert.deepEqual(await read.Get(Keyspace.Rows, key), KeyValueConformance.Val(1));
        assert.deepEqual(await read.Get(Keyspace.Columns, key), KeyValueConformance.Val(2));
        assert.equal(await read.Get(Keyspace.Edges, key), undefined);
        assert.equal((await KeyValueConformance.Collect(read.Scan(Keyspace.Edges, KeyValueConformance.AllKeys))).length, 0);
        read.dispose();
        await store.Write(async txn =>
        {
            txn.Delete(Keyspace.Rows, key);
        });
        const after = await store.BeginRead();
        assert.equal(await after.Get(Keyspace.Rows, key), undefined);
        assert.deepEqual(await after.Get(Keyspace.Columns, key), KeyValueConformance.Val(2));
        after.dispose();
    }

    private static async ScanOrder(store: IKeyValueStore): Promise<void>
    {
        const numbers = [300, 5, 70000, 1, 128, 255, 256, 2];
        await KeyValueConformance.Seed(store, numbers);
        const read = await store.BeginRead();
        const keys = await KeyValueConformance.Keys(read, KeyValueConformance.AllKeys);
        read.dispose();
        const expected = numbers.map(n => KeyValueConformance.Key(n)).sort((a, b) => TupleCodec.Compare(a, b));
        assert.deepEqual(keys, expected);
    }

    private static async ScanBounds(store: IKeyValueStore): Promise<void>
    {
        await KeyValueConformance.Seed(store, [1, 2, 3, 4, 5]);
        const read = await store.BeginRead();
        const keys = await KeyValueConformance.Keys(read, KeyValueConformance.Range(2, 4));
        read.dispose();
        assert.deepEqual(keys, [KeyValueConformance.Key(2), KeyValueConformance.Key(3)]);
    }

    private static async ScanLimit(store: IKeyValueStore): Promise<void>
    {
        await KeyValueConformance.Seed(store, [1, 2, 3, 4, 5]);
        const read = await store.BeginRead();
        const two = await KeyValueConformance.Keys(read, KeyValueConformance.AllKeys, 2);
        const zero = await KeyValueConformance.Keys(read, KeyValueConformance.AllKeys, 0);
        const many = await KeyValueConformance.Keys(read, KeyValueConformance.AllKeys, 99);
        read.dispose();
        assert.deepEqual(two, [KeyValueConformance.Key(1), KeyValueConformance.Key(2)]);
        assert.equal(zero.length, 0);
        assert.equal(many.length, 5);
    }

    private static async SnapshotIsolation(store: IKeyValueStore): Promise<void>
    {
        await KeyValueConformance.Seed(store, [1, 2]);
        const before = await store.BeginRead();
        await store.Write(async txn =>
        {
            txn.Put(KeyValueConformance.Space, KeyValueConformance.Key(1), KeyValueConformance.Val(9));
            txn.Delete(KeyValueConformance.Space, KeyValueConformance.Key(2));
            txn.Put(KeyValueConformance.Space, KeyValueConformance.Key(3), KeyValueConformance.Val(3));
        });
        const after = await store.BeginRead();
        assert.deepEqual(await before.Get(KeyValueConformance.Space, KeyValueConformance.Key(1)), KeyValueConformance.Val(1));
        assert.deepEqual(await before.Get(KeyValueConformance.Space, KeyValueConformance.Key(2)), KeyValueConformance.Val(2));
        assert.equal(await before.Get(KeyValueConformance.Space, KeyValueConformance.Key(3)), undefined);
        assert.equal((await KeyValueConformance.Keys(before, KeyValueConformance.AllKeys)).length, 2);
        assert.deepEqual(await after.Get(KeyValueConformance.Space, KeyValueConformance.Key(1)), KeyValueConformance.Val(9));
        assert.equal(await after.Get(KeyValueConformance.Space, KeyValueConformance.Key(2)), undefined);
        assert.deepEqual(await KeyValueConformance.Keys(after, KeyValueConformance.AllKeys), [KeyValueConformance.Key(1), KeyValueConformance.Key(3)]);
        before.dispose();
        after.dispose();
    }

    private static async OwnWritesGet(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        await KeyValueConformance.Seed(store, [1, 2]);
        await store.Write(async txn =>
        {
            txn.Put(space, KeyValueConformance.Key(1), KeyValueConformance.Val(9));
            txn.Delete(space, KeyValueConformance.Key(2));
            txn.Put(space, KeyValueConformance.Key(3), KeyValueConformance.Val(3));
            assert.deepEqual(await txn.Get(space, KeyValueConformance.Key(1)), KeyValueConformance.Val(9));
            assert.equal(await txn.Get(space, KeyValueConformance.Key(2)), undefined);
            assert.deepEqual(await txn.Get(space, KeyValueConformance.Key(3)), KeyValueConformance.Val(3));
            txn.Delete(space, KeyValueConformance.Key(3));
            assert.equal(await txn.Get(space, KeyValueConformance.Key(3)), undefined);
        });
    }

    private static async OwnWritesScan(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        await KeyValueConformance.Seed(store, [1, 2, 4]);
        await store.Write(async txn =>
        {
            txn.Put(space, KeyValueConformance.Key(3), KeyValueConformance.Val(3));
            txn.Put(space, KeyValueConformance.Key(1), KeyValueConformance.Val(9));
            txn.Delete(space, KeyValueConformance.Key(2));
            txn.Put(space, KeyValueConformance.Key(50), KeyValueConformance.Val(50));
            const pairs = await KeyValueConformance.Collect(txn.Scan(space, KeyValueConformance.AllKeys));
            assert.deepEqual(pairs.map(p => p[0]), [1, 3, 4, 50].map(n => KeyValueConformance.Key(n)));
            assert.deepEqual(pairs[0]?.[1], KeyValueConformance.Val(9));
            const bounded = await KeyValueConformance.Keys(txn, KeyValueConformance.Range(2, 50));
            assert.deepEqual(bounded, [KeyValueConformance.Key(3), KeyValueConformance.Key(4)]);
            const limited = await KeyValueConformance.Keys(txn, KeyValueConformance.AllKeys, 2);
            assert.deepEqual(limited, [KeyValueConformance.Key(1), KeyValueConformance.Key(3)]);
        });
    }

    private static async Rollback(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        await KeyValueConformance.Seed(store, [1]);
        await assert.rejects(
            store.Write(async txn =>
            {
                txn.Put(space, KeyValueConformance.Key(1), KeyValueConformance.Val(9));
                txn.Put(space, KeyValueConformance.Key(2), KeyValueConformance.Val(2));
                throw new Error(KeyValueConformance.Boom);
            }),
            new RegExp(KeyValueConformance.Boom),
        );
        const read = await store.BeginRead();
        assert.deepEqual(await read.Get(space, KeyValueConformance.Key(1)), KeyValueConformance.Val(1));
        assert.equal(await read.Get(space, KeyValueConformance.Key(2)), undefined);
        read.dispose();
    }

    private static async WriteExclusion(store: IKeyValueStore): Promise<void>
    {
        const events: string[] = [];
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve =>
        {
            release = resolve;
        });
        const first = store.Write(async txn =>
        {
            events.push('first-start');
            await gate;
            txn.Put(KeyValueConformance.Space, KeyValueConformance.Key(1), KeyValueConformance.Val(1));
            events.push('first-end');
        });
        const second = store.Write(async txn =>
        {
            events.push('second-start');
            assert.deepEqual(await txn.Get(KeyValueConformance.Space, KeyValueConformance.Key(1)), KeyValueConformance.Val(1));
            events.push('second-end');
        });
        for (let i = 0; i < 20; i++)
        {
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        assert.deepEqual(events, ['first-start']);
        release();
        await Promise.all([first, second]);
        assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
    }

    private static async RejectionReleasesLock(store: IKeyValueStore): Promise<void>
    {
        const failing = store.Write(async () =>
        {
            throw new Error(KeyValueConformance.Boom);
        });
        const next = store.Write(async txn =>
        {
            txn.Put(KeyValueConformance.Space, KeyValueConformance.Key(1), KeyValueConformance.Val(1));
            return 42;
        });
        await assert.rejects(failing);
        assert.equal(await next, 42);
    }

    private static async CopyOnPut(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const key = KeyValueConformance.Key(1);
        const keyBuffer = key.slice();
        const valueBuffer = KeyValueConformance.Val(5);
        await store.Write(async txn =>
        {
            txn.Put(space, keyBuffer, valueBuffer);
            keyBuffer[keyBuffer.length - 1] = 0x7f;
            valueBuffer[0] = 0xee;
            assert.deepEqual(await txn.Get(space, key), KeyValueConformance.Val(5));
        });
        keyBuffer[0] = 0x00;
        valueBuffer[1] = 0xdd;
        const read = await store.BeginRead();
        assert.deepEqual(await read.Get(space, key), KeyValueConformance.Val(5));
        assert.deepEqual(await KeyValueConformance.Keys(read, KeyValueConformance.AllKeys), [key]);
        read.dispose();
    }

    private static async CopyOnRead(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        await KeyValueConformance.Seed(store, [1]);
        const read = await store.BeginRead();
        const got = await read.Get(space, KeyValueConformance.Key(1));
        assert.ok(got !== undefined);
        got.fill(0xaa);
        const [pair] = await KeyValueConformance.Collect(read.Scan(space, KeyValueConformance.AllKeys));
        assert.ok(pair !== undefined);
        assert.deepEqual(pair[1], KeyValueConformance.Val(1));
        pair[0].fill(0xbb);
        pair[1].fill(0xcc);
        assert.deepEqual(await read.Get(space, KeyValueConformance.Key(1)), KeyValueConformance.Val(1));
        assert.deepEqual(await KeyValueConformance.Keys(read, KeyValueConformance.AllKeys), [KeyValueConformance.Key(1)]);
        read.dispose();
    }

    private static async DisposedTransaction(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const read = await store.BeginRead();
        read.dispose();
        await assert.rejects(read.Get(space, KeyValueConformance.Key(1)), KeyValueConformance.DisposedPattern);
        await assert.rejects(
            KeyValueConformance.Collect(read.Scan(space, KeyValueConformance.AllKeys)),
            KeyValueConformance.DisposedPattern,
        );
        let leaked: IReadTransaction | undefined;
        await store.Write(async txn =>
        {
            leaked = txn;
        });
        assert.ok(leaked !== undefined);
        await assert.rejects(leaked.Get(space, KeyValueConformance.Key(1)), KeyValueConformance.DisposedPattern);
    }
}
