import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FormatKeys, IdsTag } from '../format/FormatKeys.js';
import { TupleCodec } from '../format/TupleCodec.js';
import { Keyspace } from '../kv/Keyspace.js';
import type { GraphContext } from '../GraphContext.js';
import { AccessScope, CatalogModel, ConflictError, GraphReader, GraphStore, GraphTransaction, MemberKind, ValueType } from '../index.js';

/** Schema and helpers for the node-level read tests. */
class NodeFx
{
    private static readonly DirPrefix = 'pragmatic-graph-nodereads-';
    private static readonly Dirs: string[] = [];
    private static readonly Asset = 'Asset';
    private static readonly Server = 'Server';
    private static readonly Laptop = 'Laptop';
    private static readonly Person = 'Person';

    /** aspect Asset { tag: String? }; Server and Laptop carry it; Person does not. */
    public static Define(m: CatalogModel): void
    {
        m.DefineAspect(NodeFx.Asset, [], [{ Name: 'tag', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]);
        m.DefineConcept(NodeFx.Server, null, [NodeFx.Asset], []);
        m.DefineConcept(NodeFx.Laptop, null, [NodeFx.Asset], []);
        m.DefineConcept(NodeFx.Person, null, [], []);
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), NodeFx.DirPrefix));
        NodeFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of NodeFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static async Defined(open: () => Promise<GraphStore>): Promise<GraphStore>
    {
        const g = await open();
        await g.DefineSchema(m => NodeFx.Define(m));
        return g;
    }

    public static async Commit(g: GraphStore, build: (t: GraphTransaction) => void): Promise<bigint>
    {
        const t = await g.Begin(AccessScope.System);
        build(t);
        return t.Commit();
    }

    public static async Read<T>(g: GraphStore, work: (r: GraphReader) => Promise<T>): Promise<T>
    {
        const r = await g.BeginRead(AccessScope.System);
        try
        {
            return await work(r);
        }
        finally
        {
            r.dispose();
        }
    }

    public static async Ids(r: GraphReader, name: string): Promise<string[]>
    {
        const out: string[] = [];
        for await (const id of r.ScanNodes(name))
        {
            out.push(id);
        }
        return out;
    }

    /** Number of Owner entries in the raw Ids keyspace. */
    public static async OwnerEntries(g: GraphStore): Promise<number>
    {
        const context = (g as unknown as { context: GraphContext }).context;
        const txn = await context.Store.BeginRead();
        try
        {
            const prefix = TupleCodec.Encode([IdsTag.Owner]);
            let n = 0;
            for await (const _entry of txn.Scan(Keyspace.Ids, { Start: prefix, End: TupleCodec.PrefixEnd(prefix) }))
            {
                n++;
            }
            return n;
        }
        finally
        {
            txn.dispose();
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
        describe('node reads on ' + name, () =>
        {
            it('owner round-trips', async () =>
            {
                const g = await NodeFx.Defined(open);
                await NodeFx.Commit(g, t =>
                {
                    t.CreateNode('a', NodeFx.Server, { Owner: 'm1' });
                    t.CreateNode('b', NodeFx.Server);
                });
                await NodeFx.Read(g, async r =>
                {
                    assert.equal(await r.OwnerOf('a'), 'm1');
                    assert.equal(await r.OwnerOf('b'), '');
                    assert.equal(await r.OwnerOf('zz'), undefined);
                    assert.equal(await r.ConceptOf('a'), NodeFx.Server);
                    assert.equal(await r.ConceptOf('zz'), undefined);
                });
                assert.equal(await NodeFx.OwnerEntries(g), 1, 'only a non-empty owner is stored');
                await g.dispose();
            });

            it('owner cleared on delete', async () =>
            {
                const g = await NodeFx.Defined(open);
                await NodeFx.Commit(g, t => t.CreateNode('a', NodeFx.Server, { Owner: 'm1' }));
                assert.equal(await NodeFx.OwnerEntries(g), 1);
                await NodeFx.Commit(g, t => t.DeleteNode('a'));
                await NodeFx.Read(g, async r => assert.equal(await r.OwnerOf('a'), undefined));
                assert.equal(await NodeFx.OwnerEntries(g), 0);
                await g.dispose();
            });

            it('ScanNodes includes aspect carriers and excludes deleted nodes', async () =>
            {
                const g = await NodeFx.Defined(open);
                await NodeFx.Commit(g, t =>
                {
                    t.CreateNode('s1', NodeFx.Server);
                    t.CreateNode('l1', NodeFx.Laptop);
                    t.CreateNode('p1', NodeFx.Person);
                    t.CreateNode('s2', NodeFx.Server);
                });
                await NodeFx.Commit(g, t => t.DeleteNode('s2'));
                await NodeFx.Read(g, async r =>
                {
                    assert.deepEqual((await NodeFx.Ids(r, NodeFx.Asset)).sort(), ['l1', 's1']);
                    assert.deepEqual(await NodeFx.Ids(r, NodeFx.Person), ['p1']);
                });
                await g.dispose();
            });

            it('EstimateCount is an upper bound', async () =>
            {
                const g = await NodeFx.Defined(open);
                await NodeFx.Commit(g, t =>
                {
                    t.CreateNode('s1', NodeFx.Server);
                    t.CreateNode('s2', NodeFx.Server);
                    t.CreateNode('l1', NodeFx.Laptop);
                });
                await NodeFx.Commit(g, t => t.DeleteNode('s2'));
                await NodeFx.Read(g, async r =>
                {
                    assert.equal(await r.EstimateCount(NodeFx.Asset), 3);
                    assert.equal(await r.EstimateCount(NodeFx.Person), 0);
                });
                await g.dispose();
            });

            it('ScanNodes records extents', async () =>
            {
                const g = await NodeFx.Defined(open);
                await NodeFx.Commit(g, t => t.CreateNode('s1', NodeFx.Server));
                const t1 = await g.Begin(AccessScope.System);
                await NodeFx.Ids(t1, NodeFx.Asset);
                await NodeFx.Commit(g, t => t.CreateNode('l1', NodeFx.Laptop));
                t1.CreateNode('p1', NodeFx.Person);
                assert.ok((await NodeFx.Settle(t1.Commit())) instanceof ConflictError);
                await g.dispose();
            });

            it('ConceptOf and OwnerOf record the node key', async () =>
            {
                const g = await NodeFx.Defined(open);
                const t1 = await g.Begin(AccessScope.System);
                assert.equal(await t1.OwnerOf('a'), undefined);
                await NodeFx.Commit(g, t => t.CreateNode('a', NodeFx.Person, { Owner: 'm' }));
                t1.CreateNode('p1', NodeFx.Person);
                assert.ok((await NodeFx.Settle(t1.Commit())) instanceof ConflictError);
                const t2 = await g.Begin(AccessScope.System);
                assert.equal(await t2.ConceptOf('a'), NodeFx.Person);
                await NodeFx.Commit(g, t => t.DeleteNode('a'));
                t2.CreateNode('p2', NodeFx.Person);
                assert.ok((await NodeFx.Settle(t2.Commit())) instanceof ConflictError);
                await g.dispose();
            });
        });
    }
}

NodeFx.Register('memory', () => GraphStore.OpenMemory());
NodeFx.Register('lmdb', () => GraphStore.OpenLmdb(NodeFx.Dir()));

after(() => NodeFx.RemoveDirs());
