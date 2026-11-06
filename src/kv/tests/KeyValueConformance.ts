import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TupleCodec } from '../../format/TupleCodec.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { IKeyRange, IKeyValueStore, IReadTransaction, IScanProbe, IWriteTransaction, KeyLimits } from '../KeyValue.js';
import { Keyspace } from '../Keyspace.js';
import { Linearity } from './Linearity.js';

type Open = () => Promise<IKeyValueStore>;
type Reopen = (store: IKeyValueStore) => Promise<IKeyValueStore>;

/** Shared semantic suite every IKeyValueStore backend must pass. */
export class KeyValueConformance
{
    private static readonly SuiteSuffix = ' key-value conformance';
    private static readonly Boom = 'boom';
    private static readonly DisposedPattern = /disposed/i;
    private static readonly EmptyKeyPattern = /empty key/i;
    private static readonly ChangedPattern = /changed during the scan/i;
    private static readonly BulkKeys = 20000;
    private static readonly BulkLabel = 'random-order bulk stage + commit';
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
            KeyValueConformance.Case('reverse scan yields descending order with Start inclusive, End exclusive and limit', open, KeyValueConformance.ReverseScan);
            KeyValueConformance.Case('reverse write scan merges own staged puts and deletes in descending order', open, KeyValueConformance.ReverseOwnWrites);
            KeyValueConformance.Case('a reverse scan with limit 1 reads a bounded number of entries over 10,000 keys', open, KeyValueConformance.ReverseEarlyExit);
            KeyValueConformance.Case('keys up to 511 bytes work; longer keys are rejected with KeyTooLong on Put, Delete, Get and scan bounds', open, KeyValueConformance.KeyLimit);
            KeyValueConformance.Case('write scan with limit 1 merges a staged delete or put at the start of the range', open, KeyValueConformance.LimitedOwnWrites);
            KeyValueConformance.Case('a limited scan stops early: it reads a bounded number of stored entries over 10,000 keys', open, KeyValueConformance.ScanEarlyExit);
            KeyValueConformance.Case('staging a new key in the keyspace while its scan is open makes the scan throw', open, KeyValueConformance.MutationDuringScan);
            KeyValueConformance.Case('replacing or deleting an already-staged key while its scan is open makes the scan throw', open, KeyValueConformance.ReplaceDuringScan);
            KeyValueConformance.Case('the first staged change of a keyspace while its scan is open makes the scan throw', open, KeyValueConformance.FirstStageDuringScan);
            KeyValueConformance.Case('staging and committing new keys in random order in one write scales linearly up to 200,000', open, KeyValueConformance.BulkRandomPuts);
            KeyValueConformance.Case('read snapshot ignores later commits', open, KeyValueConformance.SnapshotIsolation);
            KeyValueConformance.Case('write reads see own pending writes in Get', open, KeyValueConformance.OwnWritesGet);
            KeyValueConformance.Case('write reads see own pending writes in Scan', open, KeyValueConformance.OwnWritesScan);
            KeyValueConformance.Case('a rejected write leaves no trace', open, KeyValueConformance.Rollback);
            KeyValueConformance.Case('writes run one at a time', open, KeyValueConformance.WriteExclusion);
            KeyValueConformance.Case('a rejected write does not block the next one', open, KeyValueConformance.RejectionReleasesLock);
            KeyValueConformance.Case('Put copies key and value', open, KeyValueConformance.CopyOnPut);
            KeyValueConformance.Case('returned buffers are copies', open, KeyValueConformance.CopyOnRead);
            KeyValueConformance.Case('a disposed transaction throws', open, KeyValueConformance.DisposedTransaction);
            KeyValueConformance.Case('a commit mid-scan does not change what the scan yields', open, KeyValueConformance.MidScanCommit);
            KeyValueConformance.Case('write transaction reads of staged values are copies', open, KeyValueConformance.StagedCopies);
            KeyValueConformance.Case('Put and Delete on a disposed transaction throw', open, KeyValueConformance.DisposedMutation);
            KeyValueConformance.Case('a synchronous throw from work rejects and leaves no trace', open, KeyValueConformance.SyncThrow);
            KeyValueConformance.Case('empty key rejected', open, KeyValueConformance.EmptyKey);
            KeyValueConformance.Case('dispose mid-scan makes the next step throw', open, KeyValueConformance.DisposeMidScan);
            KeyValueConformance.OwnStoreCase('store dispose releases open transactions', open, KeyValueConformance.StoreDisposeReleasesReads);
            KeyValueConformance.OwnStoreCase('double store dispose is a no-op', open, KeyValueConformance.DoubleDispose);
            KeyValueConformance.UseAfterDisposeCase('use after store dispose rejects', open);
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

    private static OwnStoreCase(title: string, open: Open, body: (store: IKeyValueStore) => Promise<void>): void
    {
        it(title, async () =>
        {
            await body(await open());
        });
    }

    private static UseAfterDisposeCase(title: string, open: Open): void
    {
        it(title, async () =>
        {
            const store = await open();
            await store.dispose();
            await assert.rejects(store.BeginRead(), KeyValueConformance.DisposedPattern);
            await assert.rejects(
                store.Write(async () => undefined),
                KeyValueConformance.DisposedPattern,
            );
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
        const pairs = await KeyValueConformance.Collect(read.Scan(KeyValueConformance.Space, range, limit === undefined ? undefined : { Limit: limit }));
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

    private static async ReverseKeys(read: IReadTransaction, range: IKeyRange, limit?: number): Promise<Uint8Array[]>
    {
        const options = limit === undefined ? { Reverse: true } : { Reverse: true, Limit: limit };
        const pairs = await KeyValueConformance.Collect(read.Scan(KeyValueConformance.Space, range, options));
        return pairs.map(p => p[0]);
    }

    private static async ReverseScan(store: IKeyValueStore): Promise<void>
    {
        const key = KeyValueConformance.Key;
        await KeyValueConformance.Seed(store, [1, 2, 3, 4, 5, 6]);
        const read = await store.BeginRead();
        try
        {
            assert.deepEqual(await KeyValueConformance.ReverseKeys(read, KeyValueConformance.AllKeys), [6, 5, 4, 3, 2, 1].map(key));
            assert.deepEqual(await KeyValueConformance.ReverseKeys(read, KeyValueConformance.Range(2, 5)), [4, 3, 2].map(key), 'End exclusive, Start inclusive');
            assert.deepEqual(await KeyValueConformance.ReverseKeys(read, KeyValueConformance.Range(2, 5), 2), [4, 3].map(key));
            assert.deepEqual(await KeyValueConformance.ReverseKeys(read, KeyValueConformance.Range(0, 99), 1), [key(6)]);
            assert.deepEqual(await KeyValueConformance.ReverseKeys(read, KeyValueConformance.Range(7, 99)), []);
            assert.deepEqual(await KeyValueConformance.ReverseKeys(read, KeyValueConformance.AllKeys, 0), []);
            const [pair] = await KeyValueConformance.Collect(read.Scan(KeyValueConformance.Space, KeyValueConformance.Range(3, 4), { Reverse: true }));
            assert.deepEqual(pair, [key(3), KeyValueConformance.Val(3)], 'values come with their keys');
        }
        finally
        {
            read.dispose();
        }
    }

    private static async ReverseOwnWrites(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const key = KeyValueConformance.Key;
        await KeyValueConformance.Seed(store, [10, 20, 30]);
        await store.Write(async txn =>
        {
            txn.Delete(space, key(30));
            assert.deepEqual(await KeyValueConformance.ReverseKeys(txn, KeyValueConformance.AllKeys, 1), [key(20)], 'a staged delete hides the last stored key');
            txn.Put(space, key(40), KeyValueConformance.Val(40));
            txn.Put(space, key(15), KeyValueConformance.Val(15));
            txn.Put(space, key(20), KeyValueConformance.Val(99));
            assert.deepEqual(await KeyValueConformance.ReverseKeys(txn, KeyValueConformance.AllKeys), [40, 20, 15, 10].map(key));
            assert.deepEqual(await KeyValueConformance.ReverseKeys(txn, KeyValueConformance.Range(11, 40)), [20, 15].map(key));
            const replaced = await KeyValueConformance.Collect(txn.Scan(space, KeyValueConformance.Range(16, 30), { Reverse: true, Limit: 1 }));
            assert.deepEqual(replaced, [[key(20), KeyValueConformance.Val(99)]], 'a staged put over a stored key wins');
        });
    }

    private static async ReverseEarlyExit(store: IKeyValueStore): Promise<void>
    {
        const probe = store as unknown as IScanProbe;
        await KeyValueConformance.Seed(store, Array.from({ length: 10000 }, (_, i) => i + 1));
        const read = await store.BeginRead();
        let before = probe.EntriesRead;
        assert.deepEqual(await KeyValueConformance.ReverseKeys(read, KeyValueConformance.AllKeys, 1), [KeyValueConformance.Key(10000)]);
        assert.ok(probe.EntriesRead - before <= 3, 'read scan pulled ' + (probe.EntriesRead - before) + ' entries');
        read.dispose();
        await store.Write(async txn =>
        {
            txn.Put(KeyValueConformance.Space, KeyValueConformance.Key(5000), KeyValueConformance.Val(1));
            before = probe.EntriesRead;
            assert.deepEqual(await KeyValueConformance.ReverseKeys(txn, KeyValueConformance.Range(0, 6000), 1), [KeyValueConformance.Key(5999)]);
            assert.ok(probe.EntriesRead - before <= 4, 'write scan pulled ' + (probe.EntriesRead - before) + ' entries');
        });
    }

    private static async KeyLimit(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const max = new Uint8Array(KeyLimits.MaxKeyBytes).fill(7);
        const over = new Uint8Array(KeyLimits.MaxKeyBytes + 1).fill(7);
        const tooLong = (error: unknown): boolean => error instanceof GraphError && error.GraphCode === GraphErrorCode.KeyTooLong;
        await store.Write(async txn =>
        {
            txn.Put(space, max, KeyValueConformance.Val(1));
            assert.throws(() => txn.Put(space, over, KeyValueConformance.Val(1)), tooLong);
            assert.throws(() => txn.Delete(space, over), tooLong);
            await assert.rejects(txn.Get(space, over), tooLong);
        });
        const read = await store.BeginRead();
        try
        {
            assert.deepEqual(await read.Get(space, max), KeyValueConformance.Val(1));
            await assert.rejects(read.Get(space, over), tooLong);
            await assert.rejects(KeyValueConformance.Collect(read.Scan(space, { Start: Uint8Array.of(1), End: over })), tooLong);
            assert.equal((await KeyValueConformance.Collect(read.Scan(space, KeyValueConformance.AllKeys))).length, 1);
        }
        finally
        {
            read.dispose();
        }
    }

    private static async LimitedOwnWrites(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const key = KeyValueConformance.Key;
        await KeyValueConformance.Seed(store, [10, 20, 30]);
        await store.Write(async txn =>
        {
            txn.Delete(space, key(10));
            assert.deepEqual(await KeyValueConformance.Keys(txn, KeyValueConformance.AllKeys, 1), [key(20)], 'a staged delete hides the first stored key');
            txn.Put(space, key(5), KeyValueConformance.Val(5));
            assert.deepEqual(await KeyValueConformance.Keys(txn, KeyValueConformance.AllKeys, 1), [key(5)], 'a staged put before the first stored key');
            txn.Put(space, key(20), KeyValueConformance.Val(99));
            const replaced = await KeyValueConformance.Collect(txn.Scan(space, KeyValueConformance.Range(11, 40), { Limit: 1 }));
            assert.deepEqual(replaced, [[key(20), KeyValueConformance.Val(99)]], 'a staged put over a stored key wins');
            txn.Delete(space, key(5));
            txn.Delete(space, key(20));
            assert.deepEqual(await KeyValueConformance.Keys(txn, KeyValueConformance.AllKeys, 1), [key(30)], 'several staged deletes in a row');
            assert.deepEqual(await KeyValueConformance.Keys(txn, KeyValueConformance.AllKeys, 0), []);
        });
    }

    private static async ScanEarlyExit(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const key = KeyValueConformance.Key;
        const probe = store as unknown as Partial<IScanProbe>;
        assert.equal(typeof probe.EntriesRead, 'number', 'backend implements IScanProbe');
        const read = (): number => probe.EntriesRead as number;
        const numbers = Array.from({ length: 10000 }, (_, i) => i + 1);
        await KeyValueConformance.Seed(store, numbers);
        const snapshot = await store.BeginRead();
        let before = read();
        assert.deepEqual(await KeyValueConformance.Keys(snapshot, KeyValueConformance.AllKeys, 2), [key(1), key(2)]);
        assert.ok(read() - before <= 4, 'read scan pulled ' + (read() - before) + ' entries');
        snapshot.dispose();
        await store.Write(async txn =>
        {
            for (let i = 0; i < 3000; i++)
            {
                txn.Put(space, key(20000 + i), KeyValueConformance.Val(1));
            }
            txn.Put(space, key(0), KeyValueConformance.Val(0));
            txn.Delete(space, key(1));
            before = read();
            assert.deepEqual(await KeyValueConformance.Keys(txn, KeyValueConformance.AllKeys, 2), [key(0), key(2)]);
            assert.ok(read() - before <= 8, 'write scan pulled ' + (read() - before) + ' entries');
        });
    }

    private static async MutationDuringScan(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const key = KeyValueConformance.Key;
        await KeyValueConformance.Seed(store, [1, 2, 3, 4]);
        await store.Write(async txn =>
        {
            txn.Put(space, key(2), KeyValueConformance.Val(9));
            const rows = txn.Scan(space, KeyValueConformance.AllKeys)[Symbol.asyncIterator]();
            assert.deepEqual((await rows.next()).value?.[0], key(1));
            txn.Put(Keyspace.Meta, key(7), KeyValueConformance.Val(7));
            assert.deepEqual((await rows.next()).value?.[0], key(2), 'other keyspaces do not disturb the scan');
            txn.Put(space, key(5), KeyValueConformance.Val(5));
            await assert.rejects(rows.next(), KeyValueConformance.ChangedPattern);
            const fresh = txn.Scan(space, KeyValueConformance.AllKeys)[Symbol.asyncIterator]();
            assert.deepEqual((await fresh.next()).value?.[0], key(1));
            txn.Delete(space, key(3));
            await assert.rejects(fresh.next(), KeyValueConformance.ChangedPattern, 'a new staged delete also counts');
            assert.deepEqual(await KeyValueConformance.Keys(txn, KeyValueConformance.AllKeys), [1, 2, 4, 5].map(n => key(n)), 'a scan opened afterwards is fine');
        });
    }

    private static async ReplaceDuringScan(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const key = KeyValueConformance.Key;
        await KeyValueConformance.Seed(store, [1, 2, 3, 4]);
        await store.Write(async txn =>
        {
            txn.Put(space, key(2), KeyValueConformance.Val(9));
            txn.Put(space, key(3), KeyValueConformance.Val(9));
            const rows = txn.Scan(space, KeyValueConformance.AllKeys)[Symbol.asyncIterator]();
            assert.deepEqual((await rows.next()).value?.[0], key(1));
            txn.Put(space, key(2), KeyValueConformance.Val(8));
            await assert.rejects(rows.next(), KeyValueConformance.ChangedPattern, 'replacing a staged put');
            const again = txn.Scan(space, KeyValueConformance.AllKeys)[Symbol.asyncIterator]();
            assert.deepEqual((await again.next()).value?.[0], key(1));
            txn.Delete(space, key(3));
            await assert.rejects(again.next(), KeyValueConformance.ChangedPattern, 'deleting a staged key');
            const rest = await KeyValueConformance.Collect(txn.Scan(space, KeyValueConformance.AllKeys));
            assert.deepEqual(rest.map(p => p[0]), [1, 2, 4].map(n => key(n)), 'a scan opened afterwards sees the final state');
            assert.deepEqual(rest[1]?.[1], KeyValueConformance.Val(8));
        });
    }

    private static async FirstStageDuringScan(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const key = KeyValueConformance.Key;
        await KeyValueConformance.Seed(store, [1, 2, 3]);
        await store.Write(async txn =>
        {
            const rows = txn.Scan(space, KeyValueConformance.AllKeys)[Symbol.asyncIterator]();
            assert.deepEqual((await rows.next()).value?.[0], key(1));
            txn.Put(space, key(9), KeyValueConformance.Val(9));
            await assert.rejects(rows.next(), KeyValueConformance.ChangedPattern);
        });
    }

    private static async BulkRandomPuts(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const small = KeyValueConformance.BulkKeys;
        const large = small * Linearity.Factor;
        // Each run writes its own key block [base, base + n): the small run above the large run's keys.
        await Linearity.Check(KeyValueConformance.BulkLabel, small, n => store.Write(async txn =>
        {
            const base = n === small ? large : 0;
            // A full-period LCG over 0..n-1 (n = 2^a * 5^b with a >= 2; multiplier - 1 divisible by 2*5*4): every key once, in scrambled order.
            let x = 12345 % n;
            for (let i = 0; i < n; i++)
            {
                x = (x * 400001 + 7) % n;
                txn.Put(space, KeyValueConformance.Key(base + x), KeyValueConformance.Val(1));
            }
            assert.deepEqual(await KeyValueConformance.Keys(txn, KeyValueConformance.Range(base, base + n), 3), [0, 1, 2].map(k => KeyValueConformance.Key(base + k)));
        }));
        const read = await store.BeginRead();
        const all = await KeyValueConformance.Keys(read, KeyValueConformance.Range(0, large));
        const others = await KeyValueConformance.Keys(read, KeyValueConformance.Range(large, large + small));
        read.dispose();
        assert.equal(all.length, large);
        assert.deepEqual(all[large - 1], KeyValueConformance.Key(large - 1));
        assert.equal(others.length, small);
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

    private static async MidScanCommit(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        await KeyValueConformance.Seed(store, [1, 2, 3, 4]);
        const read = await store.BeginRead();
        const seen: Uint8Array[] = [];
        for await (const [key] of read.Scan(space, KeyValueConformance.AllKeys))
        {
            seen.push(key);
            if (seen.length === 1)
            {
                await store.Write(async txn =>
                {
                    txn.Delete(space, KeyValueConformance.Key(2));
                    txn.Put(space, KeyValueConformance.Key(3), KeyValueConformance.Val(9));
                    txn.Put(space, KeyValueConformance.Key(5), KeyValueConformance.Val(5));
                });
            }
        }
        read.dispose();
        assert.deepEqual(seen, [1, 2, 3, 4].map(n => KeyValueConformance.Key(n)));
    }

    private static async StagedCopies(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        await store.Write(async txn =>
        {
            txn.Put(space, KeyValueConformance.Key(1), KeyValueConformance.Val(1));
            const got = await txn.Get(space, KeyValueConformance.Key(1));
            assert.ok(got !== undefined);
            got.fill(0xaa);
            const [pair] = await KeyValueConformance.Collect(txn.Scan(space, KeyValueConformance.AllKeys));
            assert.ok(pair !== undefined);
            assert.deepEqual(pair[1], KeyValueConformance.Val(1));
            pair[0].fill(0xbb);
            pair[1].fill(0xcc);
            assert.deepEqual(await txn.Get(space, KeyValueConformance.Key(1)), KeyValueConformance.Val(1));
            assert.deepEqual(await KeyValueConformance.Keys(txn, KeyValueConformance.AllKeys), [KeyValueConformance.Key(1)]);
        });
    }

    private static async DisposedMutation(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        let leaked: IWriteTransaction | undefined;
        await store.Write(async txn =>
        {
            leaked = txn;
        });
        const txn = leaked;
        assert.ok(txn !== undefined);
        assert.throws(() => txn.Put(space, KeyValueConformance.Key(1), KeyValueConformance.Val(1)), KeyValueConformance.DisposedPattern);
        assert.throws(() => txn.Delete(space, KeyValueConformance.Key(1)), KeyValueConformance.DisposedPattern);
    }

    private static async SyncThrow(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const work = ((txn: IWriteTransaction) =>
        {
            txn.Put(space, KeyValueConformance.Key(1), KeyValueConformance.Val(1));
            throw new Error(KeyValueConformance.Boom);
        }) as unknown as (txn: IWriteTransaction) => Promise<void>;
        await assert.rejects(store.Write(work), new RegExp(KeyValueConformance.Boom));
        const read = await store.BeginRead();
        assert.equal(await read.Get(space, KeyValueConformance.Key(1)), undefined);
        read.dispose();
        await store.Write(async txn =>
        {
            txn.Put(space, KeyValueConformance.Key(2), KeyValueConformance.Val(2));
        });
    }

    private static async EmptyKey(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        const empty = Uint8Array.of();
        const read = await store.BeginRead();
        await assert.rejects(read.Get(space, empty), KeyValueConformance.EmptyKeyPattern);
        read.dispose();
        await store.Write(async txn =>
        {
            await assert.rejects(txn.Get(space, empty), KeyValueConformance.EmptyKeyPattern);
            assert.throws(() => txn.Put(space, empty, KeyValueConformance.Val(1)), KeyValueConformance.EmptyKeyPattern);
            assert.throws(() => txn.Delete(space, empty), KeyValueConformance.EmptyKeyPattern);
        });
    }

    private static async DisposeMidScan(store: IKeyValueStore): Promise<void>
    {
        const space = KeyValueConformance.Space;
        await KeyValueConformance.Seed(store, [1, 2, 3]);
        const read = await store.BeginRead();
        const iterator = read.Scan(space, KeyValueConformance.AllKeys)[Symbol.asyncIterator]();
        const first = await iterator.next();
        assert.equal(first.done, false);
        read.dispose();
        await assert.rejects(iterator.next(), KeyValueConformance.DisposedPattern);
        await store.Write(async txn =>
        {
            const writeIterator = txn.Scan(space, KeyValueConformance.AllKeys)[Symbol.asyncIterator]();
            assert.equal((await writeIterator.next()).done, false);
            txn.dispose();
            await assert.rejects(writeIterator.next(), KeyValueConformance.DisposedPattern);
        });
    }

    private static async StoreDisposeReleasesReads(store: IKeyValueStore): Promise<void>
    {
        const read = await store.BeginRead();
        await store.dispose();
        await assert.rejects(read.Get(KeyValueConformance.Space, KeyValueConformance.Key(1)), KeyValueConformance.DisposedPattern);
        read.dispose();
    }

    private static async DoubleDispose(store: IKeyValueStore): Promise<void>
    {
        await store.dispose();
        await store.dispose();
    }
}
