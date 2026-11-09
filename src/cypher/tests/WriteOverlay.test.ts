import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessError, AccessScope, CommitError, ConflictError, ConnectorError, EdgeDirection, FalsePredicate } from '../../index.js';
import { FakeConnector, FakeStep } from '../../connectors/tests/FakeConnector.js';
import { RelDirection } from '../CypherEnums.js';
import { CypherParser } from '../CypherParser.js';
import { CypherWriteError, CypherWriteErrorCode } from '../CypherError.js';
import { NodeValue } from '../CypherValue.js';
import { LogicalPlanner } from '../LogicalPlanner.js';
import { WriteQueryRunner } from '../write/WriteQueryRunner.js';
import { CypherFixture as F } from './CypherFixture.js';
import { SequencePlacement, WriteFixture as W } from './WriteFixture.js';

/**
 * Server { name?, code (required), port: Int64?, load: Float64?, peer -> Server }, index ByName on name.
 * Seed a, b (owner crm, bound to connector A), a -peer-> b.
 */
class OverlayFx
{
    public static readonly Server = 'Server';
    public static readonly Crm = 'crm';
    public static readonly ConnectorName = 'A';

    private constructor(public readonly Fx: F, public readonly Connector: FakeConnector, public readonly Log: string[])
    {
    }

    public static async Open(): Promise<OverlayFx>
    {
        const log: string[] = [];
        const connector = new FakeConnector(OverlayFx.ConnectorName, log);
        const fx = await F.Open(
            [F.Concept(OverlayFx.Server, [F.Text('name'), F.Required('code'), F.Int('port'), F.Float('load'), F.Rel('peer', [OverlayFx.Server])])],
            [
                F.Node('a', OverlayFx.Server, { name: 'a', code: 'ca' }, [['peer', 'b']], OverlayFx.Crm),
                F.Node('b', OverlayFx.Server, { name: 'b', code: 'cb' }, [], OverlayFx.Crm),
            ],
            [{ Name: 'ByName', On: OverlayFx.Server, Members: ['name'] }],
            [{ Model: OverlayFx.Crm, Connector: OverlayFx.ConnectorName }],
            [connector],
        );
        log.length = 0;
        return new OverlayFx(fx, connector, log);
    }

    public dispose(): Promise<void>
    {
        return this.Fx.dispose();
    }
}

describe('write overlay: read-your-writes within one query', () =>
{
    let o: OverlayFx;
    let fx: F;
    beforeEach(async () => { o = await OverlayFx.Open(); fx = o.Fx; });
    afterEach(async () => { await o.dispose(); });

    test('created node visible later in same query', async () =>
    {
        const r = await W.Write(fx, "CREATE (n:Server {name:'a', code: 'x'}) WITH n MATCH (m:Server {name:'a'}) RETURN m");
        assert.deepEqual(r.Rows.map(x => x.get('m')).sort(), ['a', 'n0']);
    });

    test('created node visible to a label scan and an expand', async () =>
    {
        const r = await W.Write(fx, "MATCH (a:Server {name: 'a'}) CREATE (a)-[:peer]->(n:Server {name: 'new', code: 'x'}) WITH count(*) AS c MATCH (:Server {name: 'a'})-[:peer]->(t) RETURN t.name");
        assert.deepEqual(r.Rows.map(x => x.get('t.name')).sort(), ['b', 'new']);
    });

    test('set then read in same query sees new value', async () =>
    {
        const r = await W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.port = 2 WITH n MATCH (m:Server) WHERE m.port = 2 RETURN n.port, m.name");
        assert.deepEqual(r.Rows.map(x => [x.get('n.port'), x.get('m.name')]), [[2n, 'a']]);
    });

    test('a later SET item sees an earlier one on the same row', async () =>
    {
        assert.deepEqual(await W.Column(fx, "MATCH (n:Server {name: 'a'}) SET n.port = 7, n.name = 'p' + toString(n.port) RETURN n.name", 'n.name'), ['p7']);
    });

    test('deleted node not matched later', async () =>
    {
        const r = await W.Write(fx, "MATCH (n:Server {name: 'b'}) DETACH DELETE n WITH count(*) AS c MATCH (m:Server) RETURN m.name");
        assert.deepEqual(r.Rows.map(x => x.get('m.name')), ['a']);
        const e = await W.Write(fx, "MATCH (n:Server {name: 'a'}) DETACH DELETE n WITH count(*) AS c MATCH (:Server)-[:peer]->(t) RETURN t");
        assert.deepEqual(e.Rows, []);
    });

    test('a deleted node fails a later label filter and is gone from expands (R82 d)', async () =>
    {
        const t = await fx.Engine.Begin(AccessScope.System);
        try
        {
            const runner = new WriteQueryRunner(t, { Placement: new SequencePlacement() });
            const a = (await runner.Source.Node('a'))!;
            await runner.Run(new CypherParser("MATCH (n:Server {name: 'b'}) DETACH DELETE n").Parse(), new Map());
            const b = await runner.Source.Node('b');
            assert.equal(b, undefined);
            assert.equal(runner.Source.IsA(a, OverlayFx.Server), true);
            const stale = (await fx.Read(s => s.Node('b')))!;
            assert.equal(runner.Source.IsA(stale, OverlayFx.Server), false);
            const out: string[] = [];
            for await (const row of runner.Source.Expand('a', 'peer', RelDirection.Outgoing)) out.push(row.Target.PublicId);
            assert.deepEqual(out, []);
        }
        finally
        {
            t.dispose();
        }
    });

    test('index seeks see created nodes, changed values and deletions', async () =>
    {
        await fx.Read(async s =>
        {
            assert.match(LogicalPlanner.Explain(s, "MATCH (m:Server {name: 'a'}) RETURN m"), /IndexSeek\(ByName\)/);
        });
        assert.deepEqual(await W.Column(fx, "CREATE (n:Server {name: 'z', code: 'x'}) WITH n MATCH (m:Server {name: 'z'}) RETURN m", 'm'), ['n0']);
        const moved = await W.Write(fx, "MATCH (n:Server {name: 'b'}) SET n.name = 'q' WITH count(*) AS c OPTIONAL MATCH (old:Server {name: 'b'}) OPTIONAL MATCH (now:Server {name: 'q'}) RETURN old, now");
        assert.deepEqual(moved.Rows.map(x => [x.get('old'), x.get('now')]), [[null, 'b']]);
        const gone = await W.Write(fx, "MATCH (n:Server {name: 'q'}) DETACH DELETE n WITH count(*) AS c MATCH (m:Server {name: 'q'}) RETURN m");
        assert.deepEqual(gone.Rows, []);
    });

    test('failed write query commits nothing', async () =>
    {
        const head = await W.Head(fx);
        await assert.rejects(
            W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.name = 'changed' SET n.code = null"),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Invalid);
        assert.equal(await W.CommitsAfter(fx, head), 0);
        assert.equal(o.Log.length, 0, o.Log.join());
        assert.deepEqual(await fx.Column("MATCH (n:Server) RETURN n.name", 'n.name'), ['a', 'b']);
        // The same node does route through the connector when the write succeeds.
        await W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.name = 'changed'");
        assert.ok(o.Log.includes('A.Begin'));
    });

    test('placement supplies id and owner', async () =>
    {
        const placement = { Place: () => ({ PublicId: 'srv-1', Owner: 'ops' }) };
        const r = await W.Write(fx, "CREATE (n:Server {name: 'n', code: 'c'}) RETURN n", { Placement: placement });
        const n = r.Values[0]![0] as NodeValue;
        assert.equal(n.Id, 'srv-1');
        assert.equal(n.Owner, 'ops');
        const reader = await fx.Engine.BeginRead(AccessScope.System);
        try
        {
            const view = (await reader.ReadNode('srv-1'))!;
            assert.equal(view.Owner, 'ops');
            assert.equal(view.Properties.get('name'), 'n');
        }
        finally
        {
            reader.dispose();
        }
    });

    test('the default placement is a GUID with no owner', async () =>
    {
        const t = await fx.Engine.Begin(AccessScope.System);
        try
        {
            const runner = new WriteQueryRunner(t);
            const r = await runner.Run(new CypherParser("CREATE (n:Server {code: 'c'}) RETURN n").Parse(), new Map());
            const n = r.Rows[0]![0] as NodeValue;
            assert.match(n.Id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
            assert.equal(n.Owner, '');
        }
        finally
        {
            t.dispose();
        }
    });

    test('denied write maps to CypherWriteError Denied with cause', async () =>
    {
        const head = await W.Head(fx);
        const denied = AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[OverlayFx.Server, { Update: FalsePredicate.Instance }]]) });
        await assert.rejects(W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.port = 1", { Scope: denied }),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Denied && e.cause instanceof AccessError);
        assert.equal(await W.CommitsAfter(fx, head), 0);
    });

    test('a commit-time rule violation maps to Invalid with the CommitError as cause', async () =>
    {
        await assert.rejects(W.Write(fx, "CREATE (n:Server {name: 'no code'})"),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Invalid && e.cause instanceof CommitError);
    });

    test('a concurrent change maps to Conflict with the ConflictError as cause', async () =>
    {
        const t = await fx.Engine.Begin(AccessScope.System);
        try
        {
            const runner = new WriteQueryRunner(t, { Placement: new SequencePlacement() });
            await runner.Run(new CypherParser("MATCH (n:Server {name: 'a'}) SET n.port = n.port + 1").Parse(), new Map());
            await W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.port = 5");
            await assert.rejects(runner.Commit(), (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Conflict && e.cause instanceof ConflictError);
        }
        finally
        {
            t.dispose();
        }
    });

    test('a failing connector maps to ConnectorFailed with the ConnectorError as cause', async () =>
    {
        o.Connector.FailAt = FakeStep.Apply;
        await assert.rejects(W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.port = 1"),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.ConnectorFailed && e.cause instanceof ConnectorError);
    });

    test('merge does not duplicate edge', async () =>
    {
        const r = await W.Write(fx, "MATCH (a:Server {name: 'a'}), (b:Server {name: 'b'}) MERGE (a)-[:peer]->(b)");
        assert.equal(r.Stats.RelationshipsCreated, 0);
        const twice = await W.Write(fx, "UNWIND [1, 2] AS i MATCH (a:Server {name: 'b'}), (b:Server {name: 'a'}) MERGE (a)-[:peer]->(b)");
        assert.equal(twice.Stats.RelationshipsCreated, 1);
        const created = await W.Write(fx, "MATCH (a:Server {name: 'a'}), (b:Server {name: 'b'}) CREATE (a)-[:peer]->(b)");
        assert.equal(created.Stats.RelationshipsCreated, 0);
        const reader = await fx.Engine.BeginRead(AccessScope.System);
        try
        {
            assert.deepEqual((await reader.Links('a', EdgeDirection.Out)).map(l => l.PublicId), ['b']);
            assert.deepEqual((await reader.Links('b', EdgeDirection.Out)).map(l => l.PublicId), ['a']);
        }
        finally
        {
            reader.dispose();
        }
    });

    test('an Int64 into a Float64 property converts when exact, else is Invalid', async () =>
    {
        assert.deepEqual(await W.Column(fx, "MATCH (n:Server {name: 'a'}) SET n.load = 2 RETURN n.load", 'n.load'), [2]);
        assert.deepEqual(await fx.Column("MATCH (n:Server {name: 'a'}) RETURN n.load", 'n.load'), [2]);
        await assert.rejects(W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.load = 9007199254740993"),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Invalid);
        await assert.rejects(W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.port = 1.5"),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Invalid);
        await assert.rejects(W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.name = 3"),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Invalid);
    });

    test('unknown members and relationship misuse are Invalid before anything commits', async () =>
    {
        await assert.rejects(W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.nope = 1"),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Invalid);
        await assert.rejects(W.Write(fx, "MATCH (n:Server {name: 'a'}) SET n.peer = 1"),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Invalid);
        await assert.rejects(W.Write(fx, "MATCH (n:Server {name: 'a'}), (m:Server {name: 'b'}) SET n.name = m"),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Invalid);
    });

    test('REMOVE of a relationship member unlinks its edges', async () =>
    {
        const r = await W.Write(fx, "MATCH (n:Server {name: 'a'}) REMOVE n.peer WITH n MATCH (n)-[:peer]->(t) RETURN t");
        assert.deepEqual(r.Rows, []);
        assert.equal(r.Stats.RelationshipsDeleted, 1);
    });

    test('stats count creates, sets, links, unlinks and deletes', async () =>
    {
        const r = await W.Write(fx, "CREATE (n:Server {name: 'n', code: 'c'}) WITH n MATCH (a:Server {name: 'a'}) CREATE (a)-[:peer]->(n) SET a.port = 3 WITH a MATCH (b:Server {name: 'b'}) DETACH DELETE b");
        assert.deepEqual(r.Stats.ToDto(), { NodesCreated: 1, NodesDeleted: 1, RelationshipsCreated: 1, RelationshipsDeleted: 1, PropertiesSet: 3 });
    });

    test('deleting the same node from several rows deletes it once', async () =>
    {
        const r = await W.Write(fx, "UNWIND [1, 2] AS i MATCH (n:Server {name: 'b'}) DETACH DELETE n");
        assert.equal(r.Stats.NodesDeleted, 1);
    });
});
