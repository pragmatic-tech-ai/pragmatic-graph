import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogError, CatalogErrorCode } from '../CatalogError.js';
import { CatalogModel } from '../CatalogModel.js';
import { CatalogSnapshot } from '../CatalogSnapshot.js';
import { CatalogStore } from '../CatalogStore.js';
import { MemberKind, ValueType } from '../ValueType.js';
import type { IKeyValueStore } from '../../kv/KeyValue.js';
import { LmdbStore } from '../../kv/lmdb/LmdbStore.js';
import { MemoryStore } from '../../kv/memory/MemoryStore.js';

class CatalogFx
{
    private static readonly Dirs: string[] = [];
    private static readonly DirPrefix = 'pragmatic-graph-catalog-';

    public static async OpenLmdb(): Promise<IKeyValueStore>
    {
        const dir = mkdtempSync(join(tmpdir(), CatalogFx.DirPrefix));
        CatalogFx.Dirs.push(dir);
        return LmdbStore.Open(dir);
    }

    public static RemoveDirs(): void
    {
        for (const d of CatalogFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Sample(): CatalogSnapshot
    {
        const m = new CatalogModel();
        m.DefineAspect('Named', [], [{ Name: 'name', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]);
        m.DefineConcept('Thing', null, [], [{ Name: 'id', Kind: MemberKind.Property, Type: ValueType.Int64 }]);
        m.DefineConcept('Person', 'Thing', ['Named'], [
            { Name: 'knows', Kind: MemberKind.Relationship, Targets: ['Person'], Many: true, Ordered: true,
                EdgeProperties: [{ Name: 'since', Kind: MemberKind.Property, Type: ValueType.Date }] },
        ]);
        return m.Seal();
    }

    public static async Save(store: IKeyValueStore, s: CatalogSnapshot): Promise<void>
    {
        await store.Write(txn => CatalogStore.Save(txn, s));
    }

    public static async Load(store: IKeyValueStore): Promise<CatalogSnapshot>
    {
        const txn = await store.BeginRead();
        try
        {
            return await CatalogStore.Load(txn);
        }
        finally
        {
            txn.dispose();
        }
    }
}

after(() => CatalogFx.RemoveDirs());

const backends: [string, () => Promise<IKeyValueStore>][] = [
    ['memory', async () => new MemoryStore()],
    ['lmdb', () => CatalogFx.OpenLmdb()],
];

for (const [name, open] of backends)
{
    describe(`CatalogStore (${name})`, () =>
    {
        it('an empty store loads an empty catalog at version 0', async () =>
        {
            const store = await open();
            const s = await CatalogFx.Load(store);
            assert.equal(s.Version, 0);
            assert.equal(s.Definitions().length, 0);
            await store.dispose();
        });

        it('save then load reproduces definitions, ids, intervals and version', async () =>
        {
            const store = await open();
            const saved = CatalogFx.Sample();
            await CatalogFx.Save(store, saved);
            const loaded = await CatalogFx.Load(store);
            assert.equal(loaded.Version, 1);
            assert.deepEqual(loaded.Definitions(), saved.Definitions());
            assert.deepEqual(loaded.EffectiveMembers('Person'), saved.EffectiveMembers('Person'));
            assert.deepEqual(loaded.PreOrderInterval('Person'), saved.PreOrderInterval('Person'));
            assert.equal(loaded.TypeId('Named'), saved.TypeId('Named'));
            await store.dispose();
        });

        it('versions increment by one per save; skipping or repeating is a VersionConflict', async () =>
        {
            const store = await open();
            const s1 = CatalogFx.Sample();
            await CatalogFx.Save(store, s1);
            const m = CatalogModel.FromSnapshot(await CatalogFx.Load(store));
            m.DefineConcept('Extra', null, [], []);
            const s2 = m.Seal();
            m.DefineConcept('Extra2', null, [], []);
            const s3 = m.Seal();
            const conflict = (e: unknown): boolean => e instanceof CatalogError && e.Code === CatalogErrorCode.VersionConflict;
            await assert.rejects(CatalogFx.Save(store, s3), conflict);
            await assert.rejects(CatalogFx.Save(store, s1), conflict);
            await CatalogFx.Save(store, s2);
            await CatalogFx.Save(store, s3);
            assert.equal((await CatalogFx.Load(store)).Version, 3);
            await store.dispose();
        });

        it('a first save must be version 1', async () =>
        {
            const store = await open();
            const m = CatalogModel.FromSnapshot(CatalogFx.Sample());
            const s2 = m.Seal();
            await assert.rejects(CatalogFx.Save(store, s2), (e: unknown) => e instanceof CatalogError && e.Code === CatalogErrorCode.VersionConflict);
            await store.dispose();
        });

        it('next-id counters survive load: new ids exceed all old and old ids are unchanged', async () =>
        {
            const store = await open();
            const saved = CatalogFx.Sample();
            await CatalogFx.Save(store, saved);
            const m = CatalogModel.FromSnapshot(await CatalogFx.Load(store));
            m.DefineConcept('Pet', null, [], [{ Name: 'tag', Kind: MemberKind.Property, Type: ValueType.String }]);
            const next = m.Seal();
            const oldTypeIds = saved.Definitions().map(d => d.TypeId);
            const oldMemberIds = saved.Definitions().flatMap(d => d.Members.flatMap(x => [x.Id, ...(x.EdgeProperties ?? []).map(e => e.Id)]));
            assert.ok(next.TypeId('Pet') > Math.max(...oldTypeIds));
            assert.ok(next.Member('Pet', 'tag').Id > Math.max(...oldMemberIds));
            for (const d of saved.Definitions())
            {
                assert.equal(next.TypeId(d.Name), d.TypeId);
            }
            assert.deepEqual(next.EffectiveMembers('Person'), saved.EffectiveMembers('Person'));
            await store.dispose();
        });
    });
}
