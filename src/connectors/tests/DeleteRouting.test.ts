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
import { CatalogIndex } from '../../txn/CatalogIndex.js';
import { WriteBatch, WriteOp } from '../../txn/WriteBatch.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { BindingTable } from '../BindingTable.js';
import { type INodeOrigins, WriteCoordinator } from '../WriteCoordinator.js';
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
    /** Node ids: x, y (crm), h, k (hr), e (ext); n is created by a test. */
    public static readonly X = 'x';
    public static readonly Y = 'y';
    public static readonly H = 'h';
    public static readonly K = 'k';
    public static readonly E = 'e';
    public static readonly N = 'n';

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
            t.CreateNode(DeleteFx.X, DeleteFx.Item, { Owner: DeleteFx.Crm });
            t.CreateNode(DeleteFx.Y, DeleteFx.Item, { Owner: DeleteFx.Crm });
            t.CreateNode(DeleteFx.H, DeleteFx.Item, { Owner: DeleteFx.Hr });
            t.CreateNode(DeleteFx.K, DeleteFx.Item, { Owner: DeleteFx.Hr });
            t.CreateNode(DeleteFx.E, DeleteFx.Item, { Owner: DeleteFx.Ext });
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
                const fx = await F.Ready(open, [[F.H, F.Ref, F.X], [F.H, F.Next, F.X], [F.K, F.Next, F.X]]);
                await F.Commit(fx.G, t => t.DeleteNode(F.X));
                assert.deepEqual(F.Changes(fx.A), [F.Delete(F.X, F.Crm)]);
                // Relationship declaration order (next before ref), then edge order.
                assert.deepEqual(F.Changes(fx.B), [F.Unlink(F.H, F.Next, F.X, F.Hr), F.Unlink(F.K, F.Next, F.X, F.Hr), F.Unlink(F.H, F.Ref, F.X, F.Hr)]);
                await fx.G.dispose();
            });

            it('outgoing edges route by the deleted node, before its DeleteNode; an engine-only source routes nowhere', async () =>
            {
                const fx = await F.Ready(open, [[F.X, F.Ref, F.Y], [F.X, F.Next, F.H], [F.E, F.Next, F.X]]);
                await F.Commit(fx.G, t => t.DeleteNode(F.X));
                assert.deepEqual(F.Changes(fx.A), [F.Unlink(F.X, F.Next, F.H, F.Crm), F.Unlink(F.X, F.Ref, F.Y, F.Crm), F.Delete(F.X, F.Crm)]);
                assert.deepEqual(F.Changes(fx.B), []);
                await fx.G.dispose();
            });

            it('a self-loop is unlinked once', async () =>
            {
                const fx = await F.Ready(open, [[F.X, F.Next, F.X]]);
                await F.Commit(fx.G, t => t.DeleteNode(F.X));
                assert.deepEqual(F.Changes(fx.A), [F.Unlink(F.X, F.Next, F.X, F.Crm), F.Delete(F.X, F.Crm)]);
                await fx.G.dispose();
            });

            it('an explicit Unlink earlier in the batch is not repeated', async () =>
            {
                const fx = await F.Ready(open, [[F.H, F.Next, F.X], [F.K, F.Next, F.X]]);
                await F.Commit(fx.G, t =>
                {
                    t.Unlink(F.H, F.Next, F.X);
                    t.DeleteNode(F.X);
                });
                assert.deepEqual(F.Changes(fx.B), [F.Unlink(F.H, F.Next, F.X, F.Hr), F.Unlink(F.K, F.Next, F.X, F.Hr)]);
                assert.deepEqual(F.Changes(fx.A), [F.Delete(F.X, F.Crm)]);
                await fx.G.dispose();
            });

            it('edges follow the batch: links added earlier are unlinked, edges an earlier delete removed are not repeated', async () =>
            {
                const fx = await F.Ready(open, [[F.H, F.Next, F.X], [F.X, F.Next, F.H]]);
                await F.Commit(fx.G, t =>
                {
                    t.CreateNode(F.N, F.Item, { Owner: F.Hr });
                    t.Link(F.N, F.Ref, F.X);
                    t.Link(F.X, F.Next, F.Y);
                    t.DeleteNode(F.H);
                    t.DeleteNode(F.X);
                });
                assert.deepEqual(F.Changes(fx.B), [
                    { Op: WriteOp.CreateNode, PublicId: F.N, Concept: F.Item, Owner: F.Hr },
                    { Op: WriteOp.Link, From: F.N, Relationship: F.Ref, To: F.X, Owner: F.Hr, Concept: F.Item },
                    F.Unlink(F.H, F.Next, F.X, F.Hr),
                    F.Delete(F.H, F.Hr),
                    F.Unlink(F.N, F.Ref, F.X, F.Hr),
                ]);
                assert.deepEqual(F.Changes(fx.A), [
                    { Op: WriteOp.Link, From: F.X, Relationship: F.Next, To: F.Y, Owner: F.Crm, Concept: F.Item },
                    F.Unlink(F.X, F.Next, F.H, F.Crm),
                    F.Unlink(F.X, F.Next, F.Y, F.Crm),
                    F.Delete(F.X, F.Crm),
                ]);
                await fx.G.dispose();
            });

            it('a node deleted and re-created in the batch has only the batch\'s edges', async () =>
            {
                const fx = await F.Ready(open, [[F.H, F.Next, F.X]]);
                await F.Commit(fx.G, t =>
                {
                    t.DeleteNode(F.X);
                    t.CreateNode(F.X, F.Item, { Owner: F.Crm });
                    t.Link(F.K, F.Next, F.X);
                    t.DeleteNode(F.X);
                });
                assert.deepEqual(F.Changes(fx.B), [F.Unlink(F.H, F.Next, F.X, F.Hr), { Op: WriteOp.Link, From: F.K, Relationship: F.Next, To: F.X, Owner: F.Hr, Concept: F.Item }, F.Unlink(F.K, F.Next, F.X, F.Hr)]);
                await fx.G.dispose();
            });

            it('a strict delete gets no synthetic Unlinks', async () =>
            {
                const fx = await F.Ready(open, [[F.H, F.Next, F.X]]);
                await F.Commit(fx.G, t => t.DeleteNode(F.Y, { Strict: true }));
                assert.deepEqual(F.Changes(fx.A), [{ ...F.Delete(F.Y, F.Crm), Strict: true }]);
                await assert.rejects(F.Commit(fx.G, t => t.DeleteNode(F.X, { Strict: true })), (e: unknown) => e instanceof CommitError && e.Code === CommitErrorCode.NodeHasEdges);
                assert.equal(fx.B.Applied.length, 0, 'the strict delete failed at Prepare: no connector began');
                await fx.G.dispose();
            });

            it('an edge linked after the snapshot makes the routed delete conflict', async () =>
            {
                const fx = await F.Ready(open, []);
                const t = await fx.G.Begin(AccessScope.System);
                try
                {
                    t.DeleteNode(F.X);
                    await F.Commit(fx.G, w => w.Link(F.K, F.Next, F.X));
                    await assert.rejects(t.Commit(), ConflictError);
                }
                finally
                {
                    t.dispose();
                }
                assert.equal(fx.A.Applied.length, 0);
                await fx.G.dispose();
            });

            it('with connectors installed, a concurrent link into an engine-only node also makes its plain delete conflict', async () =>
            {
                const fx = await F.Ready(open, []);
                const t = await fx.G.Begin(AccessScope.System);
                try
                {
                    t.DeleteNode(F.E);
                    await F.Commit(fx.G, w => w.Link(F.K, F.Next, F.E));
                    await assert.rejects(t.Commit(), ConflictError);
                }
                finally
                {
                    t.dispose();
                }
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
    public static readonly Name = 'name';
    public static readonly NodeA = 'a';
    public static readonly NodeB = 'b';
    public static readonly NodeC = 'c';
    /** Deletes node b by its name (each node's name is its id). */
    public static readonly DetachB = `MATCH (n:${DetachFx.Server} {${DetachFx.Name}: '${DetachFx.NodeB}'}) DETACH DELETE n`;
}

describe('Cypher DETACH DELETE routes hidden edges', () =>
{
    it('the edge the scope hides is unlinked through its source connector', async () =>
    {
        const F = CypherFixture;
        const a = new FakeConnector(DetachFx.A, []);
        const b = new FakeConnector(DetachFx.B, []);
        const fx = await F.Open(
            [F.Concept(DetachFx.Server, [F.Text(DetachFx.Name), F.Rel(DetachFx.Peer, [DetachFx.Server]), F.Rel(DetachFx.Ref, [DetachFx.Server])])],
            [
                F.Node(DetachFx.NodeA, DetachFx.Server, { [DetachFx.Name]: DetachFx.NodeA }, [[DetachFx.Peer, DetachFx.NodeB]], DetachFx.Crm),
                F.Node(DetachFx.NodeB, DetachFx.Server, { [DetachFx.Name]: DetachFx.NodeB }, [], DetachFx.Hr),
                F.Node(DetachFx.NodeC, DetachFx.Server, { [DetachFx.Name]: DetachFx.NodeC }, [[DetachFx.Ref, DetachFx.NodeB]], DetachFx.Hr),
            ],
            [],
            [{ Model: DetachFx.Crm, Connector: DetachFx.A }, { Model: DetachFx.Hr, Connector: DetachFx.B }],
            [a, b],
        );
        try
        {
            const scope = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[DetachFx.Server, new Set([DetachFx.Peer])]]) });
            await WriteFixture.Write(fx, DetachFx.DetachB, { Scope: scope });
            const changes = (c: FakeConnector): object[] => c.Applied.flatMap(set => set.Changes.map(ch => ({ ...ch })));
            assert.deepEqual(changes(a), [{ Op: WriteOp.Unlink, From: DetachFx.NodeA, Relationship: DetachFx.Peer, To: DetachFx.NodeB, Owner: DetachFx.Crm, Concept: DetachFx.Server }]);
            assert.deepEqual(changes(b), [
                { Op: WriteOp.Unlink, From: DetachFx.NodeC, Relationship: DetachFx.Ref, To: DetachFx.NodeB, Owner: DetachFx.Hr, Concept: DetachFx.Server },
                { Op: WriteOp.DeleteNode, PublicId: DetachFx.NodeB, Owner: DetachFx.Hr, Concept: DetachFx.Server },
            ]);
        }
        finally
        {
            await fx.dispose();
        }
    });
});

describe('WriteCoordinator.Route', () =>
{
    it('refuses a seed-only SetOwner op (ruling R90): it is never routed', async () =>
    {
        const m = new CatalogModel();
        DeleteFx.Define(m);
        const batch = new WriteBatch();
        batch.SetOwner(DeleteFx.X, DeleteFx.Crm);
        const origins: INodeOrigins = { Origin: async () => ({ Owner: DeleteFx.Crm, Concept: DeleteFx.Item }), Edges: async () => [], Version: () => undefined };
        const table = new BindingTable([{ Model: DeleteFx.Crm, Connector: DeleteFx.A }]);
        await assert.rejects(WriteCoordinator.Route(batch, table, new CatalogIndex(m.Seal()), origins), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.Internal);
    });
});

DeleteFx.Register('memory', () => GraphStore.OpenMemory());
DeleteFx.Register('lmdb', () => GraphStore.OpenLmdb(DeleteFx.Dir()));

after(() => DeleteFx.RemoveDirs());
