import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineInternals } from './EngineInternals.js';
import { AccessDefault, AccessScope, CatalogModel, ConflictError, EdgeDirection, GraphReader, GraphStore, GraphTransaction, IdIn, MemberKind, ValueType } from '../index.js';

/** Schema and helpers for the query-layer read tests. */
class QueryFx
{
    private static readonly DirPrefix = 'pragmatic-graph-queryreads-';
    private static readonly Dirs: string[] = [];
    private static readonly Asset = 'Asset';
    private static readonly Server = 'Server';
    private static readonly Rack = 'Rack';
    private static readonly Secret = 'secret';
    private static readonly Name = 'name';
    private static readonly Hosts = 'hosts';
    private static readonly Peers = 'peers';

    /**
     * aspect Asset { tag: String?, peers -> Server* };
     * Server carries Asset { name: String?, secret: String?, hosts -> Server* }; Rack { label: String? }.
     */
    public static Define(m: CatalogModel): void
    {
        m.DefineAspect(QueryFx.Asset, [], [
            { Name: 'tag', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: QueryFx.Peers, Kind: MemberKind.Relationship, Targets: [QueryFx.Server], Many: true },
        ]);
        m.DefineConcept(QueryFx.Server, null, [QueryFx.Asset], [
            { Name: QueryFx.Name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: QueryFx.Secret, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: QueryFx.Hosts, Kind: MemberKind.Relationship, Targets: [QueryFx.Server], Many: true },
        ]);
        m.DefineConcept(QueryFx.Rack, null, [], [{ Name: 'label', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]);
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), QueryFx.DirPrefix));
        QueryFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of QueryFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static async Defined(open: () => Promise<GraphStore>): Promise<GraphStore>
    {
        const g = await open();
        await g.DefineSchema(m => QueryFx.Define(m));
        return g;
    }

    public static async Commit(g: GraphStore, build: (t: GraphTransaction) => void): Promise<bigint>
    {
        const t = await g.Begin(AccessScope.System);
        build(t);
        return t.Commit();
    }

    public static async Read<T>(g: GraphStore, scope: AccessScope, work: (r: GraphReader) => Promise<T>): Promise<T>
    {
        const r = await g.BeginRead(scope);
        try
        {
            return await work(r);
        }
        finally
        {
            r.dispose();
        }
    }

    public static async Settle(work: Promise<unknown>): Promise<unknown>
    {
        try
        {
            return await work;
        }
        catch (error)
        {
            return error;
        }
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        describe('query reads on ' + name, () =>
        {
            it('ReadNode returns null for unset properties', async () =>
            {
                const g = await QueryFx.Defined(open);
                await QueryFx.Commit(g, t =>
                {
                    t.CreateNode('s1', QueryFx.Server, { Owner: 'm1' });
                    t.SetProperty('s1', QueryFx.Name, 'alpha');
                });
                const view = await QueryFx.Read(g, AccessScope.System, r => r.ReadNode('s1'));
                assert.ok(view !== undefined);
                assert.equal(view.PublicId, 's1');
                assert.equal(view.Concept, QueryFx.Server);
                assert.equal(view.Owner, 'm1');
                assert.equal(view.Properties.get(QueryFx.Name), 'alpha');
                assert.equal(view.Properties.get('tag'), null);
                assert.ok(view.Properties.has(QueryFx.Secret) && view.Properties.get(QueryFx.Secret) === null);
                assert.equal(view.Properties.has(QueryFx.Hosts), false, 'relationships are not properties');
                assert.equal(await QueryFx.Read(g, AccessScope.System, r => r.ReadNode('zz')), undefined);
                await g.dispose();
            });

            it('ReadNode hides hidden members', async () =>
            {
                const g = await QueryFx.Defined(open);
                await QueryFx.Commit(g, t =>
                {
                    t.CreateNode('s1', QueryFx.Server);
                    t.SetProperty('s1', QueryFx.Secret, 'x');
                    t.SetProperty('s1', QueryFx.Name, 'alpha');
                });
                const scope = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[QueryFx.Server, new Set([QueryFx.Secret])]]) });
                const view = await QueryFx.Read(g, scope, r => r.ReadNode('s1'));
                assert.ok(view !== undefined);
                assert.equal(view.Properties.has(QueryFx.Secret), false);
                assert.equal(view.Properties.get(QueryFx.Name), 'alpha');
                await g.dispose();
            });

            it('ReadNode of invisible node is undefined', async () =>
            {
                const g = await QueryFx.Defined(open);
                await QueryFx.Commit(g, t =>
                {
                    t.CreateNode('s1', QueryFx.Server);
                    t.CreateNode('s2', QueryFx.Server);
                });
                const scope = AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[QueryFx.Server, new IdIn(new Set(['s1']))]]) });
                await QueryFx.Read(g, scope, async r =>
                {
                    assert.ok((await r.ReadNode('s1')) !== undefined);
                    assert.equal(await r.ReadNode('s2'), undefined);
                    assert.deepEqual(await r.Links('s2', EdgeDirection.Out), []);
                });
                await g.dispose();
            });

            it('Links covers every relationship in declaration order', async () =>
            {
                const g = await QueryFx.Defined(open);
                await QueryFx.Commit(g, t =>
                {
                    for (const id of ['s1', 's2', 's3'])
                    {
                        t.CreateNode(id, QueryFx.Server);
                    }
                    t.Link('s1', QueryFx.Hosts, 's3');
                    t.Link('s1', QueryFx.Hosts, 's2');
                    t.Link('s1', QueryFx.Peers, 's2');
                });
                await QueryFx.Read(g, AccessScope.System, async r =>
                {
                    // Effective order: aspect-contributed (peers) before the concept's own (hosts).
                    const out = await r.Links('s1', EdgeDirection.Out);
                    assert.deepEqual(out.map(l => l.Relationship), [QueryFx.Peers, QueryFx.Hosts, QueryFx.Hosts]);
                    assert.deepEqual(out.map(l => l.Relationship + '>' + l.PublicId).sort(), ['hosts>s2', 'hosts>s3', 'peers>s2']);
                    const incoming = await r.Links('s2', EdgeDirection.In);
                    assert.deepEqual(incoming.map(l => l.Relationship + '<' + l.PublicId).sort(), ['hosts<s1', 'peers<s1']);
                    assert.deepEqual(await r.Links('s3', EdgeDirection.Out), []);
                });
                await g.dispose();
            });

            it('Links omits invisible targets and hidden relationships', async () =>
            {
                const g = await QueryFx.Defined(open);
                await QueryFx.Commit(g, t =>
                {
                    for (const id of ['s1', 's2', 's3'])
                    {
                        t.CreateNode(id, QueryFx.Server);
                    }
                    t.Link('s1', QueryFx.Hosts, 's2');
                    t.Link('s1', QueryFx.Hosts, 's3');
                    t.Link('s1', QueryFx.Peers, 's3');
                });
                const rows = AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[QueryFx.Server, new IdIn(new Set(['s1', 's2']))]]) });
                await QueryFx.Read(g, rows, async r =>
                {
                    assert.deepEqual(await r.Links('s1', EdgeDirection.Out), [{ Relationship: QueryFx.Hosts, PublicId: 's2' }]);
                });
                const hidden = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[QueryFx.Server, new Set([QueryFx.Hosts])]]) });
                await QueryFx.Read(g, hidden, async r =>
                {
                    assert.deepEqual(await r.Links('s1', EdgeDirection.Out), [{ Relationship: QueryFx.Peers, PublicId: 's3' }]);
                    assert.deepEqual(await r.Links('s2', EdgeDirection.In), []);
                });
                await g.dispose();
            });

            it('IsA follows parent and aspects', async () =>
            {
                const g = await QueryFx.Defined(open);
                const catalog = EngineInternals.Context(g).Committer.Catalog;
                assert.equal(catalog.IsA(QueryFx.Server, QueryFx.Server), true);
                assert.equal(catalog.IsA(QueryFx.Server, QueryFx.Asset), true);
                assert.equal(catalog.IsA(QueryFx.Rack, QueryFx.Asset), false);
                assert.deepEqual([...catalog.Relationships()].sort(), [QueryFx.Hosts, QueryFx.Peers]);
                assert.deepEqual([...catalog.Names()].sort(), [QueryFx.Asset, QueryFx.Rack, QueryFx.Server]);
                await g.dispose();
            });

            it('ReadNode records reads', async () =>
            {
                const g = await QueryFx.Defined(open);
                await QueryFx.Commit(g, t => t.CreateNode('s1', QueryFx.Server));
                const t1 = await g.Begin(AccessScope.System);
                assert.ok((await t1.ReadNode('s1')) !== undefined);
                await QueryFx.Commit(g, t => t.SetProperty('s1', QueryFx.Name, 'beta'));
                t1.CreateNode('r1', QueryFx.Rack);
                assert.ok((await QueryFx.Settle(t1.Commit())) instanceof ConflictError);
                await g.dispose();
            });

            it('Links records reads', async () =>
            {
                const g = await QueryFx.Defined(open);
                await QueryFx.Commit(g, t =>
                {
                    t.CreateNode('s1', QueryFx.Server);
                    t.CreateNode('s2', QueryFx.Server);
                });
                const t1 = await g.Begin(AccessScope.System);
                assert.deepEqual(await t1.Links('s1', EdgeDirection.Out), []);
                await QueryFx.Commit(g, t => t.Link('s1', QueryFx.Hosts, 's2'));
                t1.CreateNode('r1', QueryFx.Rack);
                assert.ok((await QueryFx.Settle(t1.Commit())) instanceof ConflictError);
                await g.dispose();
            });
        });
    }
}

QueryFx.Register('memory', () => GraphStore.OpenMemory());
QueryFx.Register('lmdb', () => GraphStore.OpenLmdb(QueryFx.Dir()));

after(() => QueryFx.RemoveDirs());
