import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogError, CatalogErrorCode } from '../CatalogError.js';
import { CatalogModel } from '../CatalogModel.js';
import { CatalogSnapshot } from '../CatalogSnapshot.js';
import { CatalogStore } from '../CatalogStore.js';
import { MemberKind, Placement, ValueType } from '../ValueType.js';
import type { IKeyValueStore } from '../../kv/KeyValue.js';
import { LmdbStore } from '../../kv/lmdb/LmdbStore.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { FormatKeys } from '../../format/FormatKeys.js';
import { MemoryStore } from '../../kv/memory/MemoryStore.js';

class CatalogFx
{
    /** Raw stored JSON definitions of the current catalog root. */
    public static async RawDefinitions(store: IKeyValueStore): Promise<Array<Record<string, unknown>>>
    {
        const r = await store.BeginRead();
        const raw = await r.Get(Keyspace.Catalog, FormatKeys.CatalogRoot()) as Uint8Array;
        r.dispose();
        return (JSON.parse(new TextDecoder().decode(raw)) as { Definitions: Array<Record<string, unknown>> }).Definitions;
    }

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

    public static async PutRaw(store: IKeyValueStore, bytes: Uint8Array): Promise<void>
    {
        await store.Write(async txn => { txn.Put(Keyspace.Catalog, FormatKeys.CatalogRoot(), bytes); });
    }

    public static async PutObject(store: IKeyValueStore, value: unknown): Promise<void>
    {
        await CatalogFx.PutRaw(store, new TextEncoder().encode(JSON.stringify(value)));
    }

    public static Corrupt(e: unknown): boolean
    {
        return e instanceof CatalogError && e.Code === CatalogErrorCode.CorruptCatalog;
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

        it('derived floors: new ids exceed all old and old ids are unchanged', async () =>
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

        it('stored counters beyond the max used id are honoured', async () =>
        {
            const store = await open();
            await CatalogFx.PutObject(store, { NextTypeId: 50, NextMemberId: 100, Definitions: CatalogFx.Sample().Definitions() });
            const loaded = await CatalogFx.Load(store);
            assert.equal(loaded.NextTypeId, 50);
            assert.equal(loaded.NextMemberId, 100);
            const m = CatalogModel.FromSnapshot(loaded);
            m.DefineConcept('Pet', null, [], [{ Name: 'tag', Kind: MemberKind.Property, Type: ValueType.String }]);
            const next = m.Seal();
            assert.ok(next.TypeId('Pet') >= 50);
            assert.ok(next.Member('Pet', 'tag').Id >= 100);
            await store.dispose();
        });

        it('saved counters round-trip through Save and Load', async () =>
        {
            const store = await open();
            const m = new CatalogModel();
            m.DefineConcept('Gone', null, [], [{ Name: 'g', Kind: MemberKind.Property, Type: ValueType.String }]);
            const s1 = m.Seal();
            const fresh = CatalogModel.FromSnapshot(s1);
            const s2 = fresh.Seal();
            await CatalogFx.Save(store, s1);
            await CatalogFx.Save(store, s2);
            const loaded = await CatalogFx.Load(store);
            assert.equal(loaded.NextTypeId, s2.NextTypeId);
            assert.equal(loaded.NextMemberId, s2.NextMemberId);
            await store.dispose();
        });

        it('garbage or mis-shaped catalog bytes throw CorruptCatalog', async () =>
        {
            const cases: unknown[] = [
                [1, 2, 3],
                { NextTypeId: 'x', NextMemberId: 1, Definitions: [] },
                { NextTypeId: 1, NextMemberId: 1 },
                { NextTypeId: 1, NextMemberId: 1, Definitions: {} },
                null,
            ];
            const store = await open();
            await CatalogFx.PutRaw(store, new Uint8Array([0xff, 0x00, 0x7b]));
            await assert.rejects(CatalogFx.Load(store), CatalogFx.Corrupt);
            for (const c of cases)
            {
                await CatalogFx.PutObject(store, c);
                await assert.rejects(CatalogFx.Load(store), CatalogFx.Corrupt);
            }
            await store.dispose();
        });

        it('duplicate type ids or member ids throw CorruptCatalog', async () =>
        {
            const defs = JSON.parse(JSON.stringify(CatalogFx.Sample().Definitions())) as { TypeId: number; Members: { Id: number; EdgeProperties?: { Id: number }[] }[] }[];
            const store = await open();
            const dupType = JSON.parse(JSON.stringify(defs)) as typeof defs;
            dupType[1]!.TypeId = dupType[0]!.TypeId;
            await CatalogFx.PutObject(store, { NextTypeId: 9, NextMemberId: 9, Definitions: dupType });
            await assert.rejects(CatalogFx.Load(store), CatalogFx.Corrupt);
            const dupEdge = JSON.parse(JSON.stringify(defs)) as typeof defs;
            const person = dupEdge.find(d => d.Members.some(m => m.EdgeProperties !== undefined))!;
            const rel = person.Members.find(m => m.EdgeProperties !== undefined)!;
            rel.EdgeProperties![0]!.Id = rel.Id;
            await CatalogFx.PutObject(store, { NextTypeId: 9, NextMemberId: 9, Definitions: dupEdge });
            await assert.rejects(CatalogFx.Load(store), CatalogFx.Corrupt);
            await store.dispose();
        });

        it('loaded definitions are deeply frozen', async () =>
        {
            const store = await open();
            await CatalogFx.Save(store, CatalogFx.Sample());
            const loaded = await CatalogFx.Load(store);
            const defs = loaded.Definitions();
            const person = defs.find(d => d.Name === 'Person')!;
            assert.throws(() => { (person as { Name: string }).Name = 'x'; });
            assert.throws(() => (person.Aspects as string[]).push('y'));
            assert.throws(() => { (person.Members[0] as { Name: string }).Name = 'x'; });
            assert.throws(() => { (person.Members[0]!.EdgeProperties![0] as { Name: string }).Name = 'x'; });
            assert.throws(() => (person.Members[0]!.Targets as string[]).push('y'));
            assert.equal(loaded.TypeId('Person'), person.TypeId);
            await store.dispose();
        });

        it('counters below the largest used id plus one, or below 1, throw CorruptCatalog', async () =>
        {
            const defs = CatalogFx.Sample().Definitions();
            const store = await open();
            const cases = [
                { NextTypeId: 0, NextMemberId: 100, Definitions: defs },
                { NextTypeId: 50, NextMemberId: -1, Definitions: defs },
                { NextTypeId: 1, NextMemberId: 100, Definitions: defs },
                { NextTypeId: 50, NextMemberId: 2, Definitions: defs },
                { NextTypeId: 1, NextMemberId: 1, Definitions: [] },
            ];
            for (const c of cases.slice(0, 4))
            {
                await CatalogFx.PutObject(store, c);
                await assert.rejects(CatalogFx.Load(store), CatalogFx.Corrupt);
            }
            await CatalogFx.PutObject(store, cases[4]);
            assert.equal((await CatalogFx.Load(store)).Definitions().length, 0);
            await store.dispose();
        });

        it('deeply mis-shaped definitions throw CorruptCatalog, not TypeError', async () =>
        {
            const ok = { Name: 'T', IsAspect: false, TypeId: 1, Parent: null, Aspects: [], Members: [] as unknown[] };
            const member = { Id: 1, Name: 'm', Kind: 1, Type: 4, Nullable: false, DeclaredBy: 'T' };
            const bad: unknown[] = [
                [{ ...ok, Members: [null] }],
                [{ ...ok, Name: 5 }],
                [{ ...ok, TypeId: 'x' }],
                [{ ...ok, Members: [{ ...member, Id: 'x' }] }],
                [{ ...ok, Members: [{ ...member, Name: 7 }] }],
                [{ ...ok, Members: [{ ...member, Kind: 'p' }] }],
                [{ ...ok, Members: [{ ...member, EdgeProperties: [null] }] }],
                [{ ...ok, Members: [{ ...member, EdgeProperties: [{ ...member, Id: 2, Name: 3 }] }] }],
                [42],
                [{ ...ok, Members: [{ ...member, Targets: 5 }] }],
                [{ ...ok, Members: [{ ...member, Targets: [1] }] }],
                [{ ...ok, Members: [{ ...member, Many: 'y' }] }],
                [{ ...ok, Members: [{ ...member, Ordered: 1 }] }],
                [{ ...ok, Members: [{ ...member, Nullable: 'n' }] }],
                [{ ...ok, Members: [{ ...member, Type: 'String' }] }],
                [{ ...ok, Aspects: [3] }],
                [{ ...ok, Parent: 7 }],
            ];
            const store = await open();
            for (const defs of bad)
            {
                await CatalogFx.PutObject(store, { NextTypeId: 10, NextMemberId: 10, Definitions: defs });
                await assert.rejects(CatalogFx.Load(store), CatalogFx.Corrupt);
            }
            await store.dispose();
        });

        it('loads a catalog with ~200k member ids without argument-limit errors', async () =>
        {
            const defs: unknown[] = [];
            let memberId = 1;
            for (let t = 1; t <= 1000; t++)
            {
                const members: unknown[] = [];
                for (let i = 0; i < 200; i++)
                {
                    members.push({ Id: memberId, Name: 'm' + i, Kind: 1, Type: 4, Nullable: false, DeclaredBy: 'T' + t });
                    memberId += 1;
                }
                defs.push({ Name: 'T' + t, IsAspect: false, TypeId: t, Parent: null, Aspects: [], Members: members });
            }
            const store = await open();
            await CatalogFx.PutObject(store, { NextTypeId: 1001, NextMemberId: memberId, Definitions: defs });
            const loaded = await CatalogFx.Load(store);
            assert.equal(loaded.Definitions().length, 1000);
            assert.equal(loaded.NextMemberId, 200001);
            await store.dispose();
        });
    });
}

describe('catalog placement (F5)', () =>
{
    it('concepts record Placement (default Partitioned) and an optional AggregateRoot; both round-trip', async () =>
    {
        const store = new MemoryStore();
        const m = new CatalogModel();
        m.DefineConcept('File', null, [], []);
        m.DefineConcept('Term', null, [], [], { Placement: Placement.Replicated });
        m.DefineConcept('AstNode', null, [], [], { AggregateRoot: 'File' });
        m.DefineAspect('Named', [], []);
        const saved = m.Seal();
        await CatalogFx.Save(store, saved);
        const raw = await CatalogFx.RawDefinitions(store);
        assert.deepEqual(raw.map(d => [d['Name'], d['Placement'], d['AggregateRoot']]), [
            ['File', Placement.Partitioned, undefined],
            ['Term', Placement.Replicated, undefined],
            ['AstNode', Placement.Partitioned, 'File'],
            ['Named', undefined, undefined],
        ]);
        const r = await store.BeginRead();
        const loaded = await CatalogStore.Load(r);
        r.dispose();
        assert.deepEqual(loaded.Definitions(), saved.Definitions());
        await store.dispose();
    });

    it('a stored concept without Placement loads as Partitioned (additive JSON)', async () =>
    {
        const store = new MemoryStore();
        await CatalogFx.PutObject(store, { NextTypeId: 2, NextMemberId: 1, Definitions: [{ Name: 'Old', IsAspect: false, TypeId: 1, Parent: null, Aspects: [], Members: [] }] });
        const r = await store.BeginRead();
        const loaded = await CatalogStore.Load(r);
        r.dispose();
        assert.equal(loaded.Definitions()[0]?.Placement, Placement.Partitioned);
        await store.dispose();
    });

    it('AggregateRoot must name a concept; aspects carry no placement; unknown Placement values are corrupt', async () =>
    {
        for (const root of ['Missing', 'Named'])
        {
            const m = new CatalogModel();
            m.DefineAspect('Named', [], []);
            m.DefineConcept('AstNode', null, [], [], { AggregateRoot: root });
            assert.throws(() => m.Seal(), (e: unknown) => e instanceof CatalogError && e.Code === CatalogErrorCode.InvalidAggregateRoot, root);
        }
        const store = new MemoryStore();
        await CatalogFx.PutObject(store, { NextTypeId: 2, NextMemberId: 1, Definitions: [{ Name: 'X', IsAspect: false, TypeId: 1, Parent: null, Aspects: [], Members: [], Placement: 7 }] });
        const r = await store.BeginRead();
        await assert.rejects(CatalogStore.Load(r), (e: unknown) => e instanceof CatalogError && e.Code === CatalogErrorCode.CorruptCatalog);
        r.dispose();
        await CatalogFx.PutObject(store, { NextTypeId: 2, NextMemberId: 1, Definitions: [{ Name: 'A', IsAspect: true, TypeId: 1, Parent: null, Aspects: [], Members: [], Placement: 1 }] });
        const r2 = await store.BeginRead();
        await assert.rejects(CatalogStore.Load(r2), (e: unknown) => e instanceof CatalogError && e.Code === CatalogErrorCode.CorruptCatalog);
        r2.dispose();
        await store.dispose();
    });
});
