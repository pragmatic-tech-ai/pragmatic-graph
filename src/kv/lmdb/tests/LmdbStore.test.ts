import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { GraphError, GraphErrorCode } from '../../../errors/GraphError.js';
import { Keyspace } from '../../Keyspace.js';
import { LmdbLock } from '../LmdbLock.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LmdbStore } from '../LmdbStore.js';
import { KeyValueConformance } from '../../tests/KeyValueConformance.js';

class LmdbTestDirs
{
    private static readonly Prefix = 'pragmatic-graph-lmdb-';
    private static readonly Created: string[] = [];

    public static Make(): string
    {
        const dir = mkdtempSync(join(tmpdir(), LmdbTestDirs.Prefix));
        LmdbTestDirs.Created.push(dir);
        return dir;
    }

    public static RemoveAll(): void
    {
        for (const dir of LmdbTestDirs.Created)
        {
            rmSync(dir, { recursive: true, force: true });
        }
        LmdbTestDirs.Created.length = 0;
    }
}

class LmdbReopenTarget
{
    private static readonly Dirs = new WeakMap<object, string>();

    public static async Open(): Promise<LmdbStore>
    {
        const dir = LmdbTestDirs.Make();
        const store = await LmdbStore.Open(dir);
        LmdbReopenTarget.Dirs.set(store, dir);
        return store;
    }

    public static async Reopen(store: LmdbStore): Promise<LmdbStore>
    {
        const dir = LmdbReopenTarget.Dirs.get(store) as string;
        await store.dispose();
        const reopened = await LmdbStore.Open(dir);
        LmdbReopenTarget.Dirs.set(reopened, dir);
        return reopened;
    }
}

after(() => LmdbTestDirs.RemoveAll());

KeyValueConformance.Register(
    'lmdb',
    () => LmdbReopenTarget.Open(),
    store => LmdbReopenTarget.Reopen(store as LmdbStore),
);

describe('lmdb store durability options', () =>
{
    it('opens with overlappingSync off on every platform, so a commit resolves only once it is durable (F2)', async () =>
    {
        assert.equal(LmdbStore.OpenOptions(LmdbTestDirs.Make()).overlappingSync, false);
        const store = await LmdbStore.Open(LmdbTestDirs.Make());
        try
        {
            assert.equal(store.OverlappingSync, false);
        }
        finally
        {
            await store.dispose();
        }
    });
});

describe('lmdb store open options, lock and snapshot reuse (F9)', () =>
{
    it('applies MapSizeBytes and MaxReaders', async () =>
    {
        const store = await LmdbStore.Open(LmdbTestDirs.Make(), { MapSizeBytes: 64 * 1024 * 1024, MaxReaders: 200 });
        try
        {
            assert.deepEqual(store.Settings, { MapSizeBytes: 64 * 1024 * 1024, MaxReaders: 200 });
        }
        finally
        {
            await store.dispose();
        }
    });

    it('a second store on the same directory is refused with Locked until the first is disposed', async () =>
    {
        const dir = LmdbTestDirs.Make();
        const first = await LmdbStore.Open(dir);
        await assert.rejects(LmdbStore.Open(dir), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.Locked);
        await first.dispose();
        const second = await LmdbStore.Open(dir);
        await second.dispose();
    });

    it('a lock held by another live process is refused; a stale lock of an exited process is taken over', async () =>
    {
        const dir = LmdbTestDirs.Make();
        const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        try
        {
            writeFileSync(join(dir, LmdbLock.FileName), String(sleeper.pid));
            await assert.rejects(LmdbStore.Open(dir), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.Locked && /process \d+/.test(e.message));
        }
        finally
        {
            sleeper.kill();
        }
        const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
        writeFileSync(join(dir, LmdbLock.FileName), exited.stdout);
        const store = await LmdbStore.Open(dir);
        assert.equal(readFileSync(join(dir, LmdbLock.FileName), 'utf8'), String(process.pid));
        await store.dispose();
        assert.equal(existsSync(join(dir, LmdbLock.FileName)), false, 'dispose removes the lock');
    });

    it('readers opened between two commits share one native snapshot; a commit makes the next reader pin a new one', async () =>
    {
        const store = await LmdbStore.Open(LmdbTestDirs.Make());
        try
        {
            const key = Uint8Array.of(0x15, 1);
            await store.Write(async txn => txn.Put(Keyspace.Meta, key, Uint8Array.of(1)));
            const base = store.NativeSnapshotsOpened;
            const a = await store.BeginRead();
            const b = await store.BeginRead();
            const c = await store.BeginRead();
            assert.equal(store.NativeSnapshotsOpened - base, 1);
            await store.Write(async txn => txn.Put(Keyspace.Meta, key, Uint8Array.of(2)));
            const d = await store.BeginRead();
            assert.deepEqual(await a.Get(Keyspace.Meta, key), Uint8Array.of(1));
            assert.deepEqual(await d.Get(Keyspace.Meta, key), Uint8Array.of(2));
            a.dispose();
            b.dispose();
            assert.deepEqual(await c.Get(Keyspace.Meta, key), Uint8Array.of(1), 'the shared snapshot lives while any reader holds it');
            c.dispose();
            d.dispose();
        }
        finally
        {
            await store.dispose();
        }
    });
});
