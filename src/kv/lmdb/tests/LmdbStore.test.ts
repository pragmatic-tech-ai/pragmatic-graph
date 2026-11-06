import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
