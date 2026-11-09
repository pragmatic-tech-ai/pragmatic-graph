import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessDefault, AccessScope } from '../../access/AccessScope.js';
import { CatalogModel } from '../../catalog/CatalogModel.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { CypherFixture } from '../../cypher/tests/CypherFixture.js';
import { WriteFixture } from '../../cypher/tests/WriteFixture.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { CommitError, CommitErrorCode } from '../../txn/CommitError.js';
import { ConflictError } from '../../txn/ConflictError.js';
import { WriteOp } from '../../txn/WriteBatch.js';
import { BindingTable } from '../BindingTable.js';
import { FakeConnector } from './FakeConnector.js';

/**
 * A DeleteNode routes one Unlink per edge it removes (ruling R89). Schema: item { name: String?,
 * next -> item (many), ref -> item (many) }; crm → connector A, hr → connector B, ext engine-only.
 * Seeded before the connectors are installed: x, y (crm), h, k (hr), e (ext).
 */
class DeleteFx
{
    private static readonly DirPrefix = 'pragmatic-graph-delete-routing-';
    private static readonly Dirs: string[] = [];

    public static readonly Item = 'item';
    public static readonly Name = 'name';
    public static readonly Next = 'next';
    public static readonly Ref = 'ref';
    public static readonly Crm = 'crm';
    public static readonly Hr = 'hr';
    public static readonly Ext = 'ext';
    public static readonly A = 'A';
    public static readonly B = 'B';

    public static Define(m: CatalogModel): void
    {
        m.DefineConcept(DeleteFx.Item, null, [], [
            { Name: DeleteFx.Name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: DeleteFx.Next, Kind: MemberKind.Relationship, Targets: [DeleteFx.Item], Many: true },
            { Name: DeleteFx.Ref, Kind: MemberKind.Relationship, Targets: [DeleteFx.Item], Many: true },
        ]);
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), DeleteFx.DirPrefix));
        DeleteFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of DeleteFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    /** The seeded store with `links` committed, then A (crm) and B (hr) installed. */
    public static async Ready(open: () => Promise<GraphStore>, links: readonly (readonly [string, string, string])[]): Promise<{ G: GraphStore; A: FakeConnector; B: FakeConnector }>
    {
        const g = await open();
        await g.DefineSchema(m => DeleteFx.Define(m));
        await DeleteFx.Commit(g, t =>
        {
            t.CreateNode('x', DeleteFx.Item, { Owner: DeleteFx.Crm });
            t.CreateNode('y', DeleteFx.Item, { Owner: DeleteFx.Crm });
            t.CreateNode('h', DeleteFx.Item, { Owner: DeleteFx.Hr });
            t.CreateNode('k', DeleteFx.Item, { Owner: DeleteFx.Hr });
            t.CreateNode('e', DeleteFx.Item, { Owner: DeleteFx.Ext });
            for (const [from, rel, to] of links)
            {
                t.Link(from, rel, to);
            }
        });
        const a = new FakeConnector(DeleteFx.A, []);
        const b = new FakeConnector(DeleteFx.B, []);
        g.SetConnectors(new BindingTable([{ Model: DeleteFx.Crm, Connector: DeleteFx.A }, { Model: DeleteFx.Hr, Connector: DeleteFx.B }, { Model: DeleteFx.Ext, Connector: BindingTable.EngineStorage }]), [a, b]);
        return { G: g, A: a, B: b };
    }

    public static async Commit(g: GraphStore, build: (t: GraphTransaction) => void, scope: AccessScope = AccessScope.System): Promise<bigint>
    {
        const t = await g.Begin(scope);
        try
        {
            build(t);
            return await t.Commit();
        }
        finally
        {
            t.dispose();
        }
    }

    public static Changes(c: FakeConnector): object[]
    {
        return c.Applied.flatMap(set => set.Changes.map(ch => ({ ...ch })));
    }

    public static Unlink(from: string, rel: string, to: string, owner: string): object
    {
        return { Op: WriteOp.Unlink, From: from, Relationship: rel, To: to, Owner: owner, Concept: DeleteFx.Item };
    }

    public static Delete(id: string, owner: string): object
    {
        return { Op: WriteOp.DeleteNode, PublicId: id, Owner: owner, Concept: DeleteFx.Item };
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        const F = DeleteFx;
        describe('delete routes the edges it removes on ' + name, () =>
        {
            it('incoming edges from a node bound to another connector reach that connector with the source owner', async () =>
            {
                const fx = await F.Ready(open, [['h', F.Ref, 'x'], ['h', F.Next, 'x'], ['k', F.Next, 'x']]);
                await F.Commit(fx.G, t => t.DeleteNode('x'));
                assert.deepEqual(F.Changes(fx.A), [F.Delete('x', F.Crm)]);
                // Relationship declaration order (next before ref), then edge order.
                assert.deepEqual(F.Changes(fx.B), [F.Unlink('h', F.Next, 'x', F.Hr), F.Unlink('k', F.Next, 'x', F.Hr), F.Unlink('h', F.Ref, 'x', F.Hr)]);
                await fx.G.dispose();
            });

            it('outgoing edges route by the deleted node, before its DeleteNode; an engine-only source routes nowhere', async () =>
            {
                const fx = await F.Ready(open, [['x', F.Ref, 'y'], ['x', F.Next, 'h'], ['e', F.Next, 'x']]);
                await F.Commit(fx.G, t => t.DeleteNode('x'));
                assert.deepEqual(F.Changes(fx.A), [F.Unlink('x', F.Next, 'h', F.Crm), F.Unlink('x', F.Ref, 'y', F.Crm), F.Delete('x', F.Crm)]);
                assert.deepEqual(F.Changes(fx.B), []);
                await fx.G.dispose();
            });

            it('a self-loop is unlinked once', async () =>
            {
                const fx = await F.Ready(open, [['x', F.Next, 'x']]);
                await F.Commit(fx.G, t => t.DeleteNode('x'));
                assert.deepEqual(F.Changes(fx.A), [F.Unlink('x', F.Next, 'x', F.Crm), F.Delete('x', F.Crm)]);
                await fx.G.dispose();
            });

            it('an explicit Unlink earlier in the batch is not repeated', async () =>
            {
                const fx = await F.Ready(open, [['h', F.Next, 'x'], ['k', F.Next, 'x']]);
                await F.Commit(fx.G, t =>
                {
                    t.Unlink('h', F.Next, 'x');
                    t.DeleteNode('x');
                });
                assert.deepEqual(F.Changes(fx.B), [F.Unlink('h', F.Next, 'x', F.Hr), F.Unlink('k', F.Next, 'x', F.Hr)]);
                assert.deepEqual(F.Changes(fx.A), [F.Delete('x', F.Crm)]);
                await fx.G.dispose();
            });

            it('edges follow the batch: links added earlier are unlinked, edges an earlier delete removed are not repeated', async () =>
            {
                const fx = await F.Ready(open, [['h', F.Next, 'x'], ['x', F.Next, 'h']]);
                await F.Commit(fx.G, t =>
                {
                    t.CreateNode('n', F.Item, { Owner: F.Hr });
                    t.Link('n', F.Ref, 'x');
                    t.Link('x', F.Next, 'y');
                    t.DeleteNode('h');
                    t.DeleteNode('x');
                });
                assert.deepEqual(F.Changes(fx.B), [
                    { Op: WriteOp.CreateNode, PublicId: 'n', Concept: F.Item, Owner: F.Hr },
                    { Op: WriteOp.Link, From: 'n', Relationship: F.Ref, To: 'x', Owner: F.Hr, Concept: F.Item },
                    F.Unlink('h', F.Next, 'x', F.Hr),
                    F.Delete('h', F.Hr),
                    F.Unlink('n', F.Ref, 'x', F.Hr),
                ]);
                assert.deepEqual(F.Changes(fx.A), [
                    { Op: WriteOp.Link, From: 'x', Relationship: F.Next, To: 'y', Owner: F.Crm, Concept: F.Item },
                    F.Unlink('x', F.Next, 'h', F.Crm),
                    F.Unlink('x', F.Next, 'y', F.Crm),
                    F.Delete('x', F.Crm),
                ]);
                await fx.G.dispose();
            });

            it('a node deleted and re-created in the batch has only the batch\'s edges', async () =>
            {
                const fx = await F.Ready(open, [['h', F.Next, 'x']]);
                await F.Commit(fx.G, t =>
                {
                    t.DeleteNode('x');
                    t.CreateNode('x', F.Item, { Owner: F.Crm });
                    t.Link('k', F.Next, 'x');
                    t.DeleteNode('x');
                });
                assert.deepEqual(F.Changes(fx.B), [F.Unlink('h', F.Next, 'x', F.Hr), { Op: WriteOp.Link, From: 'k', Relationship: F.Next, To: 'x', Owner: F.Hr, Concept: F.Item }, F.Unlink('k', F.Next, 'x', F.Hr)]);
                await fx.G.dispose();
            });

            it('a strict delete gets no synthetic Unlinks', async () =>
            {
                const fx = await F.Ready(open, [['h', F.Next, 'x']]);
                await F.Commit(fx.G, t => t.DeleteNode('y', { Strict: true }));
                assert.deepEqual(F.Changes(fx.A), [{ ...F.Delete('y', F.Crm), Strict: true }]);
                await assert.rejects(F.Commit(fx.G, t => t.DeleteNode('x', { Strict: true })), (e: unknown) => e instanceof CommitError && e.Code === CommitErrorCode.NodeHasEdges);
                assert.equal(fx.B.Applied.length, 0, 'the strict delete failed at Prepare: no connector began');
                await fx.G.dispose();
            });

            it('an edge linked after the snapshot makes the routed delete conflict', async () =>
            {
                const fx = await F.Ready(open, []);
                const t = await fx.G.Begin(AccessScope.System);
                try
                {
                    t.DeleteNode('x');
                    await F.Commit(fx.G, w => w.Link('k', F.Next, 'x'));
                    await assert.rejects(t.Commit(), ConflictError);
                }
                finally
                {
                    t.dispose();
                }
                assert.equal(fx.A.Applied.length, 0);
                await fx.G.dispose();
            });
        });
    }
}

/** Cypher DETACH DELETE under a scope hiding one edge: the hidden edge's Unlink is routed too. */
class DetachFx
{
    public static readonly Server = 'Server';
    public static readonly Peer = 'peer';
    public static readonly Ref = 'ref';
    public static readonly Crm = 'crm';
    public static readonly Hr = 'hr';
    public static readonly A = 'A';
    public static readonly B = 'B';
}

describe('Cypher DETACH DELETE routes hidden edges', () =>
{
    it('the edge the scope hides is unlinked through its source connector', async () =>
    {
        const F = CypherFixture;
        const a = new FakeConnector(DetachFx.A, []);
        const b = new FakeConnector(DetachFx.B, []);
        const fx = await F.Open(
            [F.Concept(DetachFx.Server, [F.Text('name'), F.Rel(DetachFx.Peer, [DetachFx.Server]), F.Rel(DetachFx.Ref, [DetachFx.Server])])],
            [
                F.Node('a', DetachFx.Server, { name: 'a' }, [[DetachFx.Peer, 'b']], DetachFx.Crm),
                F.Node('b', DetachFx.Server, { name: 'b' }, [], DetachFx.Hr),
                F.Node('c', DetachFx.Server, { name: 'c' }, [[DetachFx.Ref, 'b']], DetachFx.Hr),
            ],
            [],
            [{ Model: DetachFx.Crm, Connector: DetachFx.A }, { Model: DetachFx.Hr, Connector: DetachFx.B }],
            [a, b],
        );
        try
        {
            const scope = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[DetachFx.Server, new Set([DetachFx.Peer])]]) });
            await WriteFixture.Write(fx, "MATCH (n:Server {name: 'b'}) DETACH DELETE n", { Scope: scope });
            const changes = (c: FakeConnector): object[] => c.Applied.flatMap(set => set.Changes.map(ch => ({ ...ch })));
            assert.deepEqual(changes(a), [{ Op: WriteOp.Unlink, From: 'a', Relationship: DetachFx.Peer, To: 'b', Owner: DetachFx.Crm, Concept: DetachFx.Server }]);
            assert.deepEqual(changes(b), [
                { Op: WriteOp.Unlink, From: 'c', Relationship: DetachFx.Ref, To: 'b', Owner: DetachFx.Hr, Concept: DetachFx.Server },
                { Op: WriteOp.DeleteNode, PublicId: 'b', Owner: DetachFx.Hr, Concept: DetachFx.Server },
            ]);
        }
        finally
        {
            await fx.dispose();
        }
    });
});

DeleteFx.Register('memory', () => GraphStore.OpenMemory());
DeleteFx.Register('lmdb', () => GraphStore.OpenLmdb(DeleteFx.Dir()));

after(() => DeleteFx.RemoveDirs());
