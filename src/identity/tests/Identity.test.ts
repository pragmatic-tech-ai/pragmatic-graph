import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IKeyValueStore } from '../../kv/KeyValue.js';
import { LmdbStore } from '../../kv/lmdb/LmdbStore.js';
import { MemoryStore } from '../../kv/memory/MemoryStore.js';
import { IdAllocator } from '../IdAllocator.js';
import { PublicIdIndex, PublicIdTooLongError } from '../PublicIdIndex.js';
import { RowIndex } from '../RowIndex.js';
import { InternalId } from '../InternalId.js';

class IdentityFx
{
    private static readonly DirPrefix = 'pragmatic-graph-identity-';
    private static readonly Dirs: string[] = [];
    private static readonly Hint = 'cu';
    private static readonly OtherHint = 'other';
    private static readonly Accented = 'user:é';
    private static readonly AccentChar = 'é';
    public static readonly BlockSize = 4096n;
    public static readonly SmallBound = 4;

    public static async OpenLmdb(): Promise<IKeyValueStore>
    {
        const dir = mkdtempSync(join(tmpdir(), IdentityFx.DirPrefix));
        IdentityFx.Dirs.push(dir);
        return LmdbStore.Open(dir);
    }

    public static RemoveDirs(): void
    {
        for (const d of IdentityFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Loc(typeId: number, slot: number)
    {
        return { Partition: 0, TypeId: typeId, Slot: slot };
    }

    public static Register(name: string, open: () => Promise<IKeyValueStore>): void
    {
        describe('identity on ' + name, () =>
        {
            it('allocates 10,000 unique non-zero ids', async () =>
            {
                const store = await open();
                const alloc = await IdAllocator.Open(store);
                const seen = new Set<bigint>();
                for (let i = 0; i < 10000; i++)
                {
                    const id = await alloc.Next(i % 2 === 0 ? IdentityFx.Hint : undefined);
                    assert.ok(id > 0n);
                    assert.ok(!seen.has(id));
                    seen.add(id);
                }
                await store.dispose();
            });

            it('clusters ids with the same hint into one block', async () =>
            {
                const store = await open();
                const alloc = await IdAllocator.Open(store);
                const a = await alloc.Next(IdentityFx.Hint);
                await alloc.Next(IdentityFx.OtherHint);
                const b = await alloc.Next(IdentityFx.Hint);
                assert.equal(a / IdentityFx.BlockSize, b / IdentityFx.BlockSize);
                const c = await alloc.Next();
                const d = await alloc.Next();
                assert.equal(c / IdentityFx.BlockSize, d / IdentityFx.BlockSize);
                assert.notEqual(a / IdentityFx.BlockSize, c / IdentityFx.BlockSize);
                await store.dispose();
            });

            it('moves a hint to a new block when full, never duplicating', async () =>
            {
                const store = await open();
                const alloc = await IdAllocator.Open(store);
                const blocks = new Set<bigint>();
                const seen = new Set<bigint>();
                for (let i = 0; i < 4096 + 10; i++)
                {
                    const id = await alloc.Next(IdentityFx.Hint);
                    assert.ok(!seen.has(id));
                    seen.add(id);
                    blocks.add(id / IdentityFx.BlockSize);
                }
                assert.equal(blocks.size, 2);
                await store.dispose();
            });

            it('survives restart without duplicating ids', async () =>
            {
                const store = await open();
                const first = await IdAllocator.Open(store);
                const before = new Set<bigint>();
                for (let i = 0; i < 50; i++)
                {
                    before.add(await first.Next(IdentityFx.Hint));
                }
                const second = await IdAllocator.Open(store);
                for (let i = 0; i < 50; i++)
                {
                    assert.ok(!before.has(await second.Next(IdentityFx.Hint)));
                }
                await store.dispose();
            });

            it('bounds open hinted blocks and evicts least recently used', async () =>
            {
                const store = await open();
                const alloc = await IdAllocator.Open(store, { MaxOpenHints: IdentityFx.SmallBound });
                const first = new Map<string, bigint>();
                for (const h of ['a', 'b', 'c', 'd'])
                {
                    first.set(h, await alloc.Next(h));
                }
                await alloc.Next('a');
                await alloc.Next('e');
                assert.equal(alloc.OpenHintCount, IdentityFx.SmallBound);
                const a = await alloc.Next('a');
                assert.equal(a / IdentityFx.BlockSize, (first.get('a') as bigint) / IdentityFx.BlockSize);
                const b = await alloc.Next('b');
                assert.notEqual(b / IdentityFx.BlockSize, (first.get('b') as bigint) / IdentityFx.BlockSize);
                assert.ok(alloc.OpenHintCount <= IdentityFx.SmallBound);
                await store.dispose();
            });

            it('rejects invalid MaxOpenHints', async () =>
            {
                const store = await open();
                for (const bad of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY])
                {
                    await assert.rejects(IdAllocator.Open(store, { MaxOpenHints: bad }), RangeError);
                }
                await store.dispose();
            });

            it('InternalId bounds', async () =>
            {
                assert.equal(InternalId.Max, (1n << 63n) - 1n);
                InternalId.Require(1n);
                InternalId.Require(InternalId.Max);
                assert.throws(() => InternalId.Require(0n), RangeError);
                assert.throws(() => InternalId.Require(InternalId.Max + 1n), RangeError);
            });

            it('rejects invalid public ids on Resolve and Unbind', async () =>
            {
                const store = await open();
                const idx = new PublicIdIndex();
                const r = await store.BeginRead();
                await assert.rejects(idx.Resolve(r, 'a'.repeat(401)), PublicIdTooLongError);
                await assert.rejects(idx.Resolve(r, ''));
                r.dispose();
                await store.Write(async txn =>
                {
                    await assert.rejects(idx.Unbind(txn, 'a'.repeat(401), 1n), PublicIdTooLongError);
                    await assert.rejects(idx.Unbind(txn, '', 1n));
                });
                await store.dispose();
            });

            it('rejects internal ids outside 1..2^63-1', async () =>
            {
                const store = await open();
                const idx = new PublicIdIndex();
                const rows = new RowIndex();
                const max = (1n << 63n) - 1n;
                await store.Write(async txn =>
                {
                    for (const bad of [0n, -1n, 1n << 63n])
                    {
                        await assert.rejects(idx.Bind(txn, 'x', bad), RangeError);
                        await assert.rejects(rows.Assign(txn, bad, IdentityFx.Loc(1, 1)), RangeError);
                        await assert.rejects(rows.Locate(txn, bad), RangeError);
                    }
                    await idx.Bind(txn, 'x', max);
                    await rows.Assign(txn, max, IdentityFx.Loc(1, 1));
                    assert.deepEqual(await rows.Locate(txn, max), IdentityFx.Loc(1, 1));
                });
                await store.dispose();
            });

            it('round-trips public ids both ways', async () =>
            {
                const store = await open();
                const idx = new PublicIdIndex();
                await store.Write(async txn => { await idx.Bind(txn, IdentityFx.Accented, 42n); });
                const r = await store.BeginRead();
                assert.equal(await idx.Resolve(r, IdentityFx.Accented), 42n);
                assert.equal(await idx.PublicIdOf(r, 42n), IdentityFx.Accented);
                assert.equal(await idx.Resolve(r, 'nope'), undefined);
                assert.equal(await idx.PublicIdOf(r, 7n), undefined);
                r.dispose();
                await store.dispose();
            });

            it('validates public ids', async () =>
            {
                const store = await open();
                const idx = new PublicIdIndex();
                await store.Write(async txn =>
                {
                    await idx.Bind(txn, 'a'.repeat(400), 1n);
                    await assert.rejects(idx.Bind(txn, 'a'.repeat(401), 2n), PublicIdTooLongError);
                    await assert.rejects(idx.Bind(txn, IdentityFx.AccentChar.repeat(201), 2n), PublicIdTooLongError);
                    await assert.rejects(idx.Bind(txn, '', 2n));
                    await assert.rejects(idx.Bind(txn, 'a\u0000b', 2n), /U\+0000/);
                    await assert.rejects(idx.Resolve(txn, '\u0000'), /U\+0000/);
                });
                await store.dispose();
            });

            it('rejects rebinding and mismatching unbind; allows idempotent bind', async () =>
            {
                const store = await open();
                const idx = new PublicIdIndex();
                await store.Write(async txn =>
                {
                    await idx.Bind(txn, 'p', 1n);
                    await idx.Bind(txn, 'p', 1n);
                });
                await assert.rejects(store.Write(async txn => idx.Bind(txn, 'p', 2n)));
                await assert.rejects(store.Write(async txn => idx.Bind(txn, 'q', 1n)));
                await assert.rejects(store.Write(async txn => idx.Unbind(txn, 'p', 2n)));
                await store.Write(async txn => idx.Unbind(txn, 'p', 1n));
                const r = await store.BeginRead();
                assert.equal(await idx.Resolve(r, 'p'), undefined);
                assert.equal(await idx.PublicIdOf(r, 1n), undefined);
                r.dispose();
                await store.dispose();
            });

            it('assigns, locates and clears row entries', async () =>
            {
                const store = await open();
                const rows = new RowIndex();
                await store.Write(async txn =>
                {
                    assert.equal(await rows.Locate(txn, 5n), undefined);
                    await rows.Assign(txn, 5n, IdentityFx.Loc(3, 9));
                    assert.deepEqual(await rows.Locate(txn, 5n), IdentityFx.Loc(3, 9));
                });
                const r = await store.BeginRead();
                assert.deepEqual(await rows.Locate(r, 5n), IdentityFx.Loc(3, 9));
                assert.equal(await rows.Locate(r, 6n), undefined);
                r.dispose();
                await store.Write(async txn => rows.Clear(txn, 5n));
                const r2 = await store.BeginRead();
                assert.equal(await rows.Locate(r2, 5n), undefined);
                r2.dispose();
                await store.dispose();
            });

            it('re-assign changes only that entry, across blocks', async () =>
            {
                const store = await open();
                const rows = new RowIndex();
                await store.Write(async txn =>
                {
                    await rows.Assign(txn, 1n, IdentityFx.Loc(1, 1));
                    await rows.Assign(txn, 2n, IdentityFx.Loc(1, 2));
                    await rows.Assign(txn, 5000n, IdentityFx.Loc(2, 0));
                });
                await store.Write(async txn => rows.Assign(txn, 1n, IdentityFx.Loc(4, 7)));
                const r = await store.BeginRead();
                assert.deepEqual(await rows.Locate(r, 1n), IdentityFx.Loc(4, 7));
                assert.deepEqual(await rows.Locate(r, 2n), IdentityFx.Loc(1, 2));
                assert.deepEqual(await rows.Locate(r, 5000n), IdentityFx.Loc(2, 0));
                r.dispose();
                await store.dispose();
            });

            it('isolates snapshots: an older txn does not see later commits', async () =>
            {
                const store = await open();
                const rows = new RowIndex();
                await store.Write(async txn => rows.Assign(txn, 1n, IdentityFx.Loc(1, 1)));
                const old = await store.BeginRead();
                assert.deepEqual(await rows.Locate(old, 1n), IdentityFx.Loc(1, 1));
                await store.Write(async txn => rows.Assign(txn, 1n, IdentityFx.Loc(9, 9)));
                assert.deepEqual(await rows.Locate(old, 1n), IdentityFx.Loc(1, 1));
                old.dispose();
                const fresh = await store.BeginRead();
                assert.deepEqual(await rows.Locate(fresh, 1n), IdentityFx.Loc(9, 9));
                fresh.dispose();
                await store.dispose();
            });

            it('rejects invalid ids and locations', async () =>
            {
                const store = await open();
                const rows = new RowIndex();
                await store.Write(async txn =>
                {
                    await assert.rejects(rows.Assign(txn, 0n, IdentityFx.Loc(1, 1)));
                    await assert.rejects(rows.Assign(txn, 1n, IdentityFx.Loc(0xffffffff, 1)));
                    await assert.rejects(rows.Assign(txn, 1n, { Partition: 1, TypeId: 1, Slot: 1 }));
                });
                await store.dispose();
            });
        });
    }
}

after(() => IdentityFx.RemoveDirs());

IdentityFx.Register('memory', async () => new MemoryStore());
IdentityFx.Register('lmdb', () => IdentityFx.OpenLmdb());
