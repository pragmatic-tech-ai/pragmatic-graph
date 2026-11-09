import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AccessScope } from '../../index.js';
import { CypherParser } from '../CypherParser.js';
import { CypherSemanticError, CypherWriteError, CypherWriteErrorCode } from '../CypherError.js';
import { NodeValue } from '../CypherValue.js';
import { LogicalPlanner } from '../LogicalPlanner.js';
import { ReaderSource } from '../ReaderSource.js';
import { TransactionSink } from '../write/TransactionSink.js';
import { CypherFixture as F } from './CypherFixture.js';
import { SequencePlacement, WriteFixture as W } from './WriteFixture.js';

/**
 * Port of TODL write-operators.test.ts: TODL's FakeCypherWriter call log becomes the sink's pending writes
 * (WriteBatch ops, rendered), created nodes get ids n0, n1, ... from SequencePlacement. A created node's
 * properties are SetProperty steps after its CreateNode; RemoveProperty is SetProperty(null).
 */
class Shop
{
    public static readonly Customer = 'shop.Customer';
    public static readonly Order = 'shop.Order';

    public static Open(): Promise<F>
    {
        return F.Open([
            F.Concept(Shop.Customer, [
                F.Text('name'), F.Int('a'), F.Int('b'),
                F.Rel('orders', [Shop.Order]), F.Rel('items', [Shop.Order]), F.Rel('knows', [Shop.Customer]),
            ]),
            F.Concept(Shop.Order, [F.Text('ref'), F.Rel('buyer', [Shop.Customer])]),
        ], [
            F.Node('c1', Shop.Customer, { name: 'Ada' }, [['orders', 'o1']]),
            F.Node('o1', Shop.Order, { ref: 'old' }),
            F.Node('o2', Shop.Order, { ref: 'new' }),
        ]);
    }
}

describe('cypher write operators', () =>
{
    let fx: F;
    before(async () => { fx = await Shop.Open(); });
    after(async () => { await fx.dispose(); });

    test('CREATE creates the node with resolved concept + properties and binds it as a node', async () =>
    {
        const r = await W.Steps(fx, "CREATE (n:Customer {name: 'Bob'}) RETURN n");
        assert.deepEqual(r.Steps, ['CreateNode(n0,shop.Customer)', 'SetProperty(n0,name,"Bob")']);
        const n = r.Values[0]![0]!;
        assert.ok(n instanceof NodeValue);
        assert.equal(n.Id, 'n0');
        assert.equal(n.Field('name'), 'Bob');
    });

    test('MATCH ... CREATE (a)-[:orders]->(o) creates o then links a to it', async () =>
    {
        const r = await W.Steps(fx, "MATCH (a:shop.Customer) CREATE (a)-[:orders]->(o:shop.Order {ref: 'x'})");
        assert.deepEqual(r.Steps, ['CreateNode(n0,shop.Order)', 'SetProperty(n0,ref,"x")', 'Link(c1,orders,n0)']);
    });

    test('MERGE matches an existing visible node (no create) when label+props match', async () =>
    {
        const r = await W.Steps(fx, "MERGE (n:shop.Customer {name: 'Ada'}) RETURN n");
        assert.deepEqual(r.Steps, []);
        assert.equal(r.Rows[0]!.get('n'), 'c1');
    });

    test('MERGE creates when no visible match', async () =>
    {
        const r = await W.Steps(fx, "MERGE (n:shop.Customer {name: 'Zed'}) RETURN n");
        assert.deepEqual(r.Steps, ['CreateNode(n0,shop.Customer)', 'SetProperty(n0,name,"Zed")']);
        assert.ok(r.Values[0]![0] instanceof NodeValue);
    });

    test('repeated identical MERGE rows in one clause create once', async () =>
    {
        const r = await W.Steps(fx, "UNWIND [1,2,3] AS i MERGE (n:shop.Customer {name: 'Zed'}) RETURN n");
        assert.equal(r.Steps.length, 2);
        assert.deepEqual(r.Rows.map(x => x.get('n')), ['n0', 'n0', 'n0']);
    });

    test('SET n.p = scalar sets; SET n.p = null sets null; n += {a:1,b:null} sets a and nulls b', async () =>
    {
        assert.deepEqual((await W.Steps(fx, "MATCH (n:shop.Customer) SET n.name = 'Eve'")).Steps, ['SetProperty(c1,name,"Eve")']);
        assert.deepEqual((await W.Steps(fx, 'MATCH (n:shop.Customer) SET n.name = null')).Steps, ['SetProperty(c1,name,null)']);
        assert.deepEqual((await W.Steps(fx, 'MATCH (n:shop.Customer) SET n += {a: 1, b: null}')).Steps, ['SetProperty(c1,a,1)', 'SetProperty(c1,b,null)']);
    });

    test('SET n.member = otherNode replaces the reference (unlink existing, link new)', async () =>
    {
        const r = await W.Steps(fx, "MATCH (n:shop.Customer), (o:shop.Order {ref: 'new'}) SET n.orders = o");
        assert.deepEqual(r.Steps, ['Unlink(c1,orders,o1)', 'Link(c1,orders,o2)']);
    });

    test('SET n.m = a then a later SET n.m = b unlinks the edge the earlier clause created (last wins)', async () =>
    {
        const r = await W.Steps(fx, "MATCH (n:shop.Customer), (a:shop.Order {ref: 'new'}), (b:shop.Order {ref: 'old'}) SET n.orders = a SET n.orders = b");
        assert.ok(r.Steps.includes('Link(c1,orders,o2)'));
        assert.ok(r.Steps.includes('Unlink(c1,orders,o2)'));
        assert.equal(r.Steps[r.Steps.length - 1], 'Link(c1,orders,o1)');
    });

    // Adapted: TODL's fake writer ignored edges. On the engine a plain DELETE of a node with edges fails
    // (NodeHasRelationships), so the plain case deletes the edge-free o2 and DETACH first unlinks c1's edge.
    test('DELETE n deletes the node; DETACH DELETE unlinks its edges first; DELETE of a linked node fails', async () =>
    {
        assert.deepEqual((await W.Steps(fx, "MATCH (n:shop.Order {ref: 'new'}) DELETE n")).Steps, ['DeleteNode(o2)']);
        assert.deepEqual((await W.Steps(fx, 'MATCH (n:shop.Customer) DETACH DELETE n')).Steps, ['Unlink(c1,orders,o1)', 'DeleteNode(c1)']);
        await assert.rejects(W.Steps(fx, 'MATCH (n:shop.Customer) DELETE n'), (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.NodeHasRelationships && /relationships/.test(e.message));
    });

    test('REMOVE n.p sets the property to null', async () =>
    {
        assert.deepEqual((await W.Steps(fx, 'MATCH (n:shop.Customer) REMOVE n.name')).Steps, ['SetProperty(c1,name,null)']);
    });

    test('an unknown label in CREATE throws CypherSemanticError', async () =>
    {
        await assert.rejects(W.Steps(fx, 'CREATE (n:Nope)'), CypherSemanticError);
    });

    test('PlanForWrite returns the final RETURN projection separately and CREATE vars are in scope', async () =>
    {
        const t = await fx.Engine.Begin(AccessScope.System);
        try
        {
            const sink = new TransactionSink(t, new ReaderSource(t), new SequencePlacement());
            const plan = new LogicalPlanner(sink.View, new Map(), undefined, undefined, false, sink).PlanForWrite(new CypherParser("CREATE (n:Customer {name: 'Bob'}) RETURN n.name AS name").Parse());
            assert.ok(plan.Projection !== undefined);
            assert.equal(plan.Projection.Items[0]!.ColumnName(), 'name');
        }
        finally
        {
            t.dispose();
        }
    });

    test('a write clause without a sink throws CypherSemanticError', async () =>
    {
        await fx.Read(async source =>
        {
            assert.throws(() => new LogicalPlanner(source, new Map()).Plan(new CypherParser('CREATE (n:Customer)').Parse()), CypherSemanticError);
        });
    });

    test('CREATE rejects undirected, untyped and variable-length relationships, each with its own message', async () =>
    {
        const cases: [string, RegExp][] = [
            ['MATCH (a:shop.Customer) CREATE (a)-[:orders]-(o:shop.Order)', /requires a direction/],
            ['MATCH (a:shop.Customer) CREATE (a)-->(o:shop.Order)', /requires a type/],
            ['MATCH (a:shop.Customer) CREATE (a)-[:orders*1..2]->(o:shop.Order)', /variable-length relationships cannot be created/],
        ];
        for (const [q, message] of cases)
        {
            await assert.rejects(W.Steps(fx, q), (e: unknown) => e instanceof CypherSemanticError && message.test(e.message), q);
        }
    });

    test('MERGE on a variable bound to a non-node value throws', async () =>
    {
        await assert.rejects(W.Steps(fx, 'UNWIND [1] AS n MERGE (n)'), (e: unknown) => e instanceof CypherSemanticError && /non-node/.test(e.message));
    });

    // Adapted: the relationship is `buyer` (Order -> Customer) instead of TODL's `m`.
    test('incoming-direction CREATE swaps from/to', async () =>
    {
        const r = await W.Steps(fx, 'MATCH (a:shop.Customer) CREATE (a)<-[:buyer]-(b:shop.Order)');
        assert.deepEqual(r.Steps, ['CreateNode(n0,shop.Order)', 'Link(n0,buyer,c1)']);
    });

    test('CREATE from a variable bound to null (empty OPTIONAL MATCH) throws', async () =>
    {
        await assert.rejects(W.Steps(fx, "OPTIONAL MATCH (a:shop.Customer {name: 'Nobody'}) CREATE (a)-[:orders]->(o:shop.Order)"), CypherSemanticError);
    });

    test('MERGE on an already-bound variable keeps the bound node (no create)', async () =>
    {
        const r = await W.Steps(fx, 'MATCH (n:shop.Customer) MERGE (n) RETURN n');
        assert.deepEqual(r.Steps, []);
        assert.equal(r.Rows[0]!.get('n'), 'c1');
    });

    test('MERGE cannot add a label or properties to an already-bound variable (openCypher)', async () =>
    {
        await assert.rejects(W.Steps(fx, "MATCH (n:shop.Customer) MERGE (n:shop.Customer {name: 'Zed'})"), (e: unknown) => e instanceof CypherSemanticError && /already-bound/.test(e.message));
    });

    test('SET ref onto a node created in the same query only creates the relationship', async () =>
    {
        const r = await W.Steps(fx, 'CREATE (a:shop.Customer), (o:shop.Order) SET a.orders = o');
        assert.deepEqual(r.Steps, ['CreateNode(n0,shop.Customer)', 'CreateNode(n1,shop.Order)', 'Link(n0,orders,n1)']);
    });

    test('SET ref on a node with no prior edge only creates the relationship', async () =>
    {
        const r = await W.Steps(fx, "MATCH (n:shop.Customer), (o:shop.Order {ref: 'new'}) SET n.items = o");
        assert.deepEqual(r.Steps, ['Link(c1,items,o2)']);
    });

    test('SET ref replaces edges written for an earlier row (no leak)', async () =>
    {
        const r = await W.Steps(fx, 'MATCH (n:shop.Customer), (o:shop.Order) SET n.items = o');
        assert.deepEqual(r.Steps, ['Link(c1,items,o1)', 'Unlink(c1,items,o1)', 'Link(c1,items,o2)']);
    });
});
