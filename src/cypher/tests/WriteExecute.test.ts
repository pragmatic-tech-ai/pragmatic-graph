import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccessScope } from '../../index.js';
import { CypherParser } from '../CypherParser.js';
import { CypherSemanticError } from '../CypherError.js';
import { NodeRefValue, NodeValue, NullValue } from '../CypherValue.js';
import { LogicalPlanner } from '../LogicalPlanner.js';
import { ListValue, MapValue } from '../StructuredValues.js';
import { WriteQueryRunner } from '../write/WriteQueryRunner.js';
import { CypherFixture as F } from './CypherFixture.js';
import { SequencePlacement, WriteFixture as W } from './WriteFixture.js';

/**
 * Port of TODL write-execute.test.ts onto engine transactions: TODL's fake writer + re-baked graph become a
 * real engine; "commits" are engine commits (ReadChanges), "rollback" is a transaction disposed uncommitted.
 * Read-your-writes now always exists (overlay), so TODL's "fails loudly" cases for intra-query reads of
 * created nodes now succeed (adapted, see each test).
 */
class Exec
{
    public static readonly Customer = 'shop.Customer';

    public static Open(seeded: boolean): Promise<F>
    {
        return F.Open(
            [F.Concept(Exec.Customer, [F.Text('name'), F.Text('tier'), F.Text('city'), F.Text('copy'), F.Text('c'), F.Text('m'), F.Rel('knows', [Exec.Customer])])],
            seeded ? [F.Node('c1', Exec.Customer, { name: 'Ada', tier: 'gold' }), F.Node('c2', Exec.Customer, { name: 'Bob' })] : [],
        );
    }
}

describe('cypher two-phase write execution', () =>
{
    let fx: F;
    let seeded: F;
    beforeEach(async () => { fx = await Exec.Open(false); seeded = await Exec.Open(true); });
    afterEach(async () => { await fx.dispose(); await seeded.dispose(); });

    test('a write query planned without a sink throws WritesNotExecutable', async () =>
    {
        await fx.Read(async source =>
        {
            assert.throws(() => new LogicalPlanner(source, new Map()).Plan(new CypherParser("CREATE (n:shop.Customer {name: 'Ada'})").Parse()), (e: unknown) => e instanceof CypherSemanticError && /require a writer/.test(e.message));
        });
    });

    // Adapted: there is no Rollback to fail; the original error surfaces and the transaction is left uncommitted.
    test('an error during apply surfaces as-is and leaves the transaction uncommitted', async () =>
    {
        const head = await W.Head(fx);
        const placement = new SequencePlacement();
        placement.FailAt = 0;
        await assert.rejects(W.Write(fx, "CREATE (n:shop.Customer {name: 'x'})", { Placement: placement }), /boom/);
        assert.equal(await W.CommitsAfter(fx, head), 0);
    });

    test('CREATE ... RETURN n returns the created node with its properties', async () =>
    {
        const r = await W.Write(fx, "CREATE (n:shop.Customer {name: 'Ada'}) RETURN n");
        assert.deepEqual(r.Columns, ['n']);
        assert.equal(r.Values.length, 1);
        const cell = r.Values[0]![0]!;
        assert.ok(cell instanceof NodeValue);
        assert.ok(!(cell instanceof NodeRefValue));
        assert.equal(cell.Id, 'n0');
        assert.equal(cell.Field('name'), 'Ada');
    });

    test("MATCH (n) SET n.tier='gold' RETURN n.tier yields the new value", async () =>
    {
        const r = await W.Write(seeded, "MATCH (n:shop.Customer) SET n.tier = 'gold' RETURN n.tier");
        assert.deepEqual(r.Rows.map(row => row.get('n.tier')), ['gold', 'gold']);
    });

    test('RETURN of a node deleted earlier in the same query yields null', async () =>
    {
        const r = await W.Write(seeded, "MATCH (n:shop.Customer {name: 'Ada'}) DELETE n RETURN n");
        assert.equal(r.Values.length, 1);
        assert.equal(r.Values[0]![0], NullValue.Instance);
    });

    test('a write-only query (no RETURN) returns empty columns/rows, Stats, and commits once', async () =>
    {
        const head = await W.Head(fx);
        const r = await W.Write(fx, "CREATE (n:shop.Customer {name: 'Ada'})");
        assert.deepEqual(r.Columns, []);
        assert.deepEqual(r.Values, []);
        assert.equal(r.Stats.NodesCreated, 1);
        assert.equal(await W.CommitsAfter(fx, head), 1);
    });

    test('an error thrown during apply commits nothing', async () =>
    {
        const head = await W.Head(fx);
        const placement = new SequencePlacement();
        placement.FailAt = 1;
        await assert.rejects(W.Write(fx, "UNWIND [1,2,3] AS i CREATE (n:shop.Customer {name: 'x'})", { Placement: placement }), /boom/);
        assert.equal(await W.CommitsAfter(fx, head), 0);
        assert.deepEqual(await fx.Column('MATCH (n:shop.Customer) RETURN n', 'n'), []);
    });

    test('a collect/list of created nodes in the final projection holds the nodes (one commit)', async () =>
    {
        const head = await W.Head(fx);
        const r = await W.Write(fx, "UNWIND [1,2] AS i CREATE (n:shop.Customer {name: 'x'}) WITH collect(n) AS ns RETURN ns");
        assert.equal(await W.CommitsAfter(fx, head), 1);
        const list = r.Values[0]![0]! as ListValue;
        assert.ok(list instanceof ListValue);
        assert.equal(list.Items.length, 2);
        assert.ok(list.Items.every(i => i instanceof NodeValue));
    });

    test('a map holding a node deleted earlier resolves that entry to null', async () =>
    {
        const r = await W.Write(seeded, "MATCH (n:shop.Customer {name: 'Ada'}) DELETE n RETURN {k: n} AS m");
        const m = r.Values[0]![0]! as MapValue;
        assert.equal(m.Get('k'), NullValue.Instance);
    });

    // Adapted: TODL had no read-your-writes without an overlay and threw; the overlay always exists here.
    test('WITH reading a property off a just-created node sees it (read-your-writes)', async () =>
    {
        assert.deepEqual(await W.Column(fx, "CREATE (n:shop.Customer {name: 'Ada'}) WITH n.name AS v RETURN v", 'v'), ['Ada']);
    });

    test('the final projection may read a property off a just-created node', async () =>
    {
        assert.deepEqual(await W.Column(fx, "CREATE (n:shop.Customer {name: 'Ada'}) RETURN n.name", 'n.name'), ['Ada']);
    });
});

describe('cypher MERGE ON CREATE / ON MATCH SET execution', () =>
{
    const query = "MERGE (n:shop.Customer {name: 'Ada'}) ON CREATE SET n.tier = 'new' ON MATCH SET n.tier = 'seen' RETURN n.tier";
    let fx: F;
    let seeded: F;
    beforeEach(async () => { fx = await Exec.Open(false); seeded = await Exec.Open(true); });
    afterEach(async () => { await fx.dispose(); await seeded.dispose(); });

    test('a MERGE that creates runs only the ON CREATE actions', async () =>
    {
        const r = await W.Write(fx, query);
        assert.equal(r.Stats.NodesCreated, 1);
        assert.deepEqual(r.Rows.map(row => row.get('n.tier')), ['new']);
    });

    test('a MERGE that matches runs only the ON MATCH actions', async () =>
    {
        const r = await W.Write(seeded, query);
        assert.equal(r.Stats.NodesCreated, 0);
        assert.deepEqual(r.Rows.map(row => row.get('n.tier')), ['seen']);
    });

    test('a later row merging a node this query created sees it as matched', async () =>
    {
        const r = await W.Write(fx, "UNWIND [1, 2] AS i MERGE (n:shop.Customer {name: 'Zed'}) ON CREATE SET n.c = 'created' ON MATCH SET n.m = 'matched' RETURN n.c, n.m");
        assert.equal(r.Stats.NodesCreated, 1);
        assert.deepEqual(r.Rows.map(row => [row.get('n.c'), row.get('n.m')]), [['created', 'matched'], ['created', 'matched']]);
    });

    // Adapted: TODL threw (no read-your-writes); the action now reads the created node's property.
    test('an ON CREATE action reading a property of the just-created node sees it', async () =>
    {
        assert.deepEqual(await W.Column(fx, "MERGE (n:shop.Customer {name: 'Ada'}) ON CREATE SET n.copy = n.name RETURN n.copy", 'n.copy'), ['Ada']);
    });
});

describe('cypher SET n = {map} full-replace execution', () =>
{
    let fx: F;
    beforeEach(async () => { fx = await Exec.Open(true); });
    afterEach(async () => { await fx.dispose(); });

    test('listed properties are set and every other own property is removed', async () =>
    {
        const r = await W.Write(fx, "MATCH (n:shop.Customer {name: 'Ada'}) SET n = {name: 'Ada2', city: 'Oslo'} RETURN n.name, n.tier, n.city");
        assert.deepEqual(r.Rows.map(row => [...row.values()]), [['Ada2', null, 'Oslo']]);
    });

    test('a null entry in the map removes that property', async () =>
    {
        const r = await W.Write(fx, "MATCH (n:shop.Customer {name: 'Ada'}) SET n = {name: 'X', tier: null} RETURN n.name, n.tier");
        assert.deepEqual(r.Rows.map(row => [...row.values()]), [['X', null]]);
    });

    test('SET n = null changes nothing (like SET n += null)', async () =>
    {
        const r = await W.Write(fx, "MATCH (n:shop.Customer {name: 'Ada'}) SET n = null RETURN n.name, n.tier");
        assert.deepEqual(r.Rows.map(row => [...row.values()]), [['Ada', 'gold']]);
    });

    test('a non-map value is a semantic error and commits nothing', async () =>
    {
        const head = await W.Head(fx);
        await assert.rejects(W.Write(fx, 'MATCH (n:shop.Customer) SET n = 1'), CypherSemanticError);
        assert.equal(await W.CommitsAfter(fx, head), 0);
    });

    // Adapted: TODL could not read a created node's properties and threw; the overlay can, so it replaces.
    test('full-replace on a node created in the same query replaces its properties', async () =>
    {
        const r = await W.Write(fx, "CREATE (n:shop.Customer {name: 'A', tier: 't'}) SET n = {name: 'B'} RETURN n.name, n.tier");
        assert.deepEqual(r.Rows.map(row => [...row.values()]), [['B', null]]);
    });
});

describe('cypher path MERGE across rows', () =>
{
    test('a repeated row reuses the path this query created instead of duplicating it', async () =>
    {
        const fx = await Exec.Open(false);
        try
        {
            const r = await W.Write(fx, "UNWIND [1, 2] AS i MERGE (a:shop.Customer {name: 'P'})-[:knows]->(b:shop.Customer {name: 'Q'})");
            assert.equal(r.Stats.NodesCreated, 2);
            assert.equal(r.Stats.RelationshipsCreated, 1);
        }
        finally
        {
            await fx.dispose();
        }
    });
});

describe('WriteQueryRunner', () =>
{
    test('Commit before Run is refused; Run twice is refused', async () =>
    {
        const fx = await Exec.Open(false);
        const t = await fx.Engine.Begin(AccessScope.System);
        try
        {
            const runner = new WriteQueryRunner(t);
            await assert.rejects(runner.Commit());
            await runner.Run(new CypherParser("CREATE (n:shop.Customer {name: 'x'})").Parse(), new Map());
            await assert.rejects(runner.Run(new CypherParser("CREATE (n:shop.Customer {name: 'y'})").Parse(), new Map()));
        }
        finally
        {
            t.dispose();
            await fx.dispose();
        }
    });
});
