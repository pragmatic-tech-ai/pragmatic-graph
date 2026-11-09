import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CypherCellCodec } from '../CypherCellCodec.js';
import { CypherEngine } from '../CypherEngine.js';
import { CypherSemanticError, CypherTimeout } from '../CypherError.js';
import { CypherQuery, Expr, Fn, Pattern, Return, Sort } from '../CypherQuery.js';
import { CypherValue, NodeValue, NullValue, ScalarValue, type ParameterValue } from '../CypherValue.js';
import { Deadline } from '../ExecutionLimits.js';
import type { PlannerOptions } from '../LogicalPlanner.js';
import { ListValue, MapValue, PathValue, RelValue } from '../StructuredValues.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

class Sp2Fixture
{
    // Graph: checkout->ledger->billing->checkout (cycle), billing->audit, vault(Core)->ledger, lonely (isolated).
    public static Open(extraEdges: readonly (readonly [string, string])[] = [], options?: PlannerOptions): Promise<EngineHarness>
    {
        const F = CypherFixture;
        const edges: [string, string][] = [['s1', 's2'], ['s2', 's3'], ['s3', 's1'], ['s3', 's4'], ['c1', 's2'], ...extraEdges.map(([a, b]) => [a, b] as [string, string])];
        const links = (id: string): [string, string][] => edges.filter(([from]) => from === id).map(([, to]) => ['calls', to]);
        const svc = (id: string, name: string, kind: string, concept: string = 'Service') => F.Node(id, concept, { name, kind }, links(id));
        return EngineHarness.Open(
            [
                F.Concept('Element', []),
                F.Concept('Service', [F.Text('name'), F.Text('kind'), F.Rel('calls', ['Service'])], 'Element'),
                F.Concept('CoreService', [], 'Service'),
            ],
            [
                svc('s1', 'checkout', 'api'), svc('s2', 'ledger', 'core'), svc('s3', 'billing', 'core'),
                svc('s4', 'audit', 'api'), svc('s5', 'lonely', 'api'), svc('c1', 'vault', 'core', 'CoreService'),
            ],
            options);
    }

    public static Rel(v: CypherValue | undefined): unknown
    {
        return CypherCellCodec.Encode(v as RelValue);
    }

    public static Params(entries: readonly (readonly [string, ParameterValue])[]): ReadonlyMap<string, ParameterValue>
    {
        return new Map(entries);
    }
}

const P = EngineHarness;

describe('CypherEngine SP2 read-plus (end-to-end)', () =>
{
    let e: EngineHarness;
    before(async () => { e = await Sp2Fixture.Open(); });
    after(() => e.dispose());

    test('subtype instances match the supertype label', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute('MATCH (a:Service) RETURN a.name AS n ORDER BY n')), ['audit', 'billing', 'checkout', 'ledger', 'lonely', 'vault']);
        assert.deepEqual(P.Col(await e.Execute('MATCH (a:CoreService) RETURN a.name AS n')), ['vault']);
    });

    test('WITH chaining carries projected variables', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute('MATCH (a:Service) WITH a.name AS n ORDER BY n SKIP 3 LIMIT 1 RETURN n')), ['ledger']);
        const r2 = await e.Execute('MATCH (a:Service)-[:calls]->(b:Service) WITH b, count(*) AS c ORDER BY c DESC LIMIT 1 RETURN b.name AS n, c');
        assert.deepEqual(P.Pairs(r2), [['ledger', 2n]]);
    });

    test('variable not carried through WITH is out of scope (semantic error)', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service) WITH a.name AS n RETURN a'), CypherSemanticError);
        await assert.rejects(e.Execute('MATCH (a:Service)-[:calls]->(b:Service) WITH a RETURN b.name'), CypherSemanticError);
    });

    test('aggregation with grouping: count and collect', async () =>
    {
        const r = await e.Execute('MATCH (a:Service) RETURN a.kind AS k, count(*) AS c, collect(a.name) AS names ORDER BY k');
        assert.deepEqual(r.Columns, ['k', 'c', 'names']);
        assert.deepEqual(P.Col(r, 0), ['api', 'core']);
        assert.deepEqual(P.Col(r, 1), [3n, 3n]);
        const names = P.Col(r, 2) as string[][];
        assert.deepEqual([...names[0]!].sort(), ['audit', 'checkout', 'lonely']);
        assert.deepEqual([...names[1]!].sort(), ['billing', 'ledger', 'vault']);
    });

    test('ORDER BY / SKIP / LIMIT / DISTINCT', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute('MATCH (a:Service) RETURN a.name AS n ORDER BY n DESC')), ['vault', 'lonely', 'ledger', 'checkout', 'billing', 'audit']);
        assert.deepEqual(P.Col(await e.Execute('MATCH (a:Service) RETURN a.name AS n ORDER BY n SKIP 1 LIMIT 2')), ['billing', 'checkout']);
        assert.deepEqual(P.Col(await e.Execute('MATCH (a:Service) RETURN DISTINCT a.kind AS k ORDER BY k')), ['api', 'core']);
    });

    test('OPTIONAL MATCH keeps the row with a null cell when nothing matches', async () =>
    {
        const lonely = await e.Execute("MATCH (a:Service) WHERE a.name = 'lonely' OPTIONAL MATCH (a)-[:calls]->(b:Service) RETURN a.name AS n, b.name AS m");
        assert.equal(lonely.Rows.length, 1);
        assert.equal((lonely.Rows[0]![0] as ScalarValue).Value, 'lonely');
        assert.ok(lonely.Rows[0]![1] instanceof NullValue);
        const mixed = await e.Execute('MATCH (a:Service) OPTIONAL MATCH (a)-[:calls]->(b:Service) RETURN a.name AS n, b.name AS m ORDER BY n, m');
        assert.equal(mixed.Rows.length, 7);
        const audit = mixed.Rows.find((row) => (row[0] as ScalarValue).Value === 'audit')!;
        assert.ok(audit[1] instanceof NullValue);
    });

    test('variable-length paths: bounds, path functions, cycle safety', async () =>
    {
        const r = await e.Execute("MATCH p = (a:Service)-[:calls*1..3]->(b) WHERE a.name = 'checkout' RETURN b.name AS n, length(p) AS len ORDER BY len, n");
        assert.deepEqual(P.Pairs(r), [['ledger', 1n], ['billing', 2n], ['audit', 3n], ['checkout', 3n]]);
        assert.deepEqual(P.Col(await e.Execute("MATCH p = (a:Service)-[:calls*2..2]->(b) WHERE a.name = 'checkout' RETURN b.name AS n")), ['billing']);
        const all = await e.Execute('MATCH p = (a:Service)-[:calls*1..3]->(b) RETURN length(p) AS len ORDER BY len');
        assert.deepEqual(P.Col(all), [1n, 1n, 1n, 1n, 1n, 2n, 2n, 2n, 2n, 2n, 3n, 3n, 3n, 3n, 3n, 3n]);
        const unbounded = await e.Execute("MATCH p = (a:Service)-[:calls*]->(b) WHERE a.name = 'checkout' RETURN b.name AS n, length(p) AS len, relationships(p) AS rs ORDER BY len, n");
        assert.deepEqual(unbounded.Rows.map((r) => [P.Plain(r[0]!), P.Plain(r[1]!)]), [['ledger', 1n], ['billing', 2n], ['audit', 3n], ['checkout', 3n]]);
        for (const row of unbounded.Rows)
        {
            const keys = (row[2] as ListValue).Items.map((x) => x.GroupKey());
            assert.equal(new Set(keys).size, keys.length, 'a relationship repeated within one path');
        }
    });

    test('nodes(p) and relationships(p)', async () =>
    {
        const r = await e.Execute("MATCH p = (a:Service)-[:calls*2..2]->(b) WHERE a.name = 'checkout' RETURN nodes(p) AS ns, relationships(p) AS rs");
        assert.equal(r.Rows.length, 1);
        assert.deepEqual((r.Rows[0]![0] as ListValue).Items.map((n) => (n as NodeValue).Id), ['s1', 's2', 's3']);
        assert.deepEqual((r.Rows[0]![1] as ListValue).Items.map((x) => Sp2Fixture.Rel(x)), [
            { from: 's1', type: 'calls', to: 's2' },
            { from: 's2', type: 'calls', to: 's3' },
        ]);
    });

    test('UNWIND list literal, scalar parameter, and null', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute('UNWIND [1, 2, 3] AS x RETURN x')), [1n, 2n, 3n]);
        assert.deepEqual(P.Col(await e.Execute('UNWIND $xs AS x RETURN x', Sp2Fixture.Params([['xs', 7]]))), [7n]);
        assert.equal((await e.Execute('UNWIND null AS x RETURN x')).Rows.length, 0);
    });

    test('list/map literals and index access in RETURN', async () =>
    {
        const r = await e.Execute("RETURN [10, 20, 30][1] AS i, {a: 1, b: 'x'} AS m, [1, 2] AS l");
        assert.equal((r.Rows[0]![0] as ScalarValue).Value, 20n);
        const m = r.Rows[0]![1] as MapValue;
        assert.equal((m.Get('a') as ScalarValue).Value, 1n);
        assert.equal((m.Get('b') as ScalarValue).Value, 'x');
        assert.deepEqual(P.Plain(r.Rows[0]![2]!), [1n, 2n]);
        assert.equal(((await e.Execute("RETURN {a: 5}['a'] AS v")).Rows[0]![0] as ScalarValue).Value, 5n);
    });

    test('multi-path MATCH: cartesian product and shared-variable join', async () =>
    {
        assert.equal((await e.Execute('MATCH (a:Service), (b:Service) RETURN a, b')).Rows.length, 36);
        const join = await e.Execute('MATCH (a:Service)-[:calls]->(b:Service), (b)-[:calls]->(c:Service) RETURN a.name AS x, c.name AS z ORDER BY x, z');
        assert.deepEqual(P.Pairs(join), [
            ['billing', 'ledger'],
            ['checkout', 'billing'],
            ['ledger', 'audit'],
            ['ledger', 'checkout'],
            ['vault', 'billing'],
        ]);
    });

    test('converging join: two sources must reach the SAME bound target', async () =>
    {
        const r = await e.Execute('MATCH (a:Service)-[:calls]->(b:Service), (c:Service)-[:calls]->(b) RETURN a.name AS x, b.name AS y, c.name AS z ORDER BY x, y, z');
        assert.deepEqual(P.Pairs(r), [
            ['billing', 'audit', 'billing'],
            ['billing', 'checkout', 'billing'],
            ['checkout', 'ledger', 'checkout'],
            ['checkout', 'ledger', 'vault'],
            ['ledger', 'billing', 'ledger'],
            ['vault', 'ledger', 'checkout'],
            ['vault', 'ledger', 'vault'],
        ]);
        assert.ok(!P.Pairs(r).some(([x, y]) => x === 'billing' && y === 'ledger'));
    });

    test('triangle: a 3-cycle only matches when the closing hop returns to the anchor', async () =>
    {
        const r = await e.Execute('MATCH (a:Service)-[:calls]->(b:Service)-[:calls]->(c:Service)-[:calls]->(a) RETURN a.name AS x, b.name AS y, c.name AS z ORDER BY x, y, z');
        assert.deepEqual(P.Pairs(r), [
            ['billing', 'checkout', 'ledger'],
            ['checkout', 'ledger', 'billing'],
            ['ledger', 'billing', 'checkout'],
        ]);
    });

    test('converging join is order-independent regardless of which path binds the shared target', async () =>
    {
        const first = await e.Execute('MATCH (a:Service)-[:calls]->(b:Service), (c:Service)-[:calls]->(b) RETURN a.name AS x, b.name AS y, c.name AS z ORDER BY x, y, z');
        const swapped = await e.Execute('MATCH (c:Service)-[:calls]->(b:Service), (a:Service)-[:calls]->(b) RETURN a.name AS x, b.name AS y, c.name AS z ORDER BY x, y, z');
        assert.deepEqual(P.Pairs(first), P.Pairs(swapped));
    });

    test('variable-length expansion into an already-bound node is a loud error', async () =>
    {
        await assert.rejects(
            e.Execute('MATCH (a:Service)-[:calls]->(b:Service), (a)-[:calls*1..2]->(b) RETURN a.name AS x'),
            (err: unknown) => err instanceof CypherSemanticError && /already-bound node is not yet supported/.test(err.message));
    });

    test('ToDto: list/map/rel/path cells have the documented shapes', async () =>
    {
        const r = await e.Execute("MATCH p = (a:Service)-[:calls*1..1]->(b) WHERE a.name = 'checkout' RETURN [1, 2] AS l, {k: 'v'} AS m, relationships(p) AS rs, p");
        const dto = CypherEngine.ToDto(r);
        assert.deepEqual(dto.Columns, ['l', 'm', 'rs', 'p']);
        const row = dto.Rows[0]!;
        assert.deepEqual(row[0], [1, 2]);
        assert.deepEqual(row[1], { k: 'v' });
        assert.deepEqual(row[2], [{ from: 's1', type: 'calls', to: 's2' }]);
        const path = row[3] as unknown as { nodes: unknown[]; relationships: unknown[] };
        assert.deepEqual(path.nodes.map((n) => CypherCellCodec.AsNode(n)!.id), ['s1', 's2']);
        assert.deepEqual(path.relationships, [{ from: 's1', type: 'calls', to: 's2' }]);
        assert.ok(r.Rows[0]![3] instanceof PathValue);
    });

    // TODL: "... a $node cell whose snapshot SnapshotReader rehydrates"; the engine cell carries the fields itself.
    test('node nested in nodes(p) DTO is a $node cell carrying its fields', async () =>
    {
        const dto = CypherEngine.ToDto(await e.Execute("MATCH p = (a:Service)-[:calls*2..2]->(b) WHERE a.name = 'checkout' RETURN nodes(p) AS ns"));
        const node = CypherCellCodec.AsNode((dto.Rows[0]![0] as unknown[])[1])!;
        assert.equal(node.id, 's2');
        assert.equal(node.concept, 'Service');
        assert.equal(node.properties['name'], 'ledger');
        assert.equal(node.properties['kind'], 'core');
        assert.deepEqual(node.links, { calls: ['s3'] });
    });

    test('parity: text and fluent produce identical results on an aggregating query', async () =>
    {
        const text = await e.Execute("MATCH (a:Service)-[:calls]->(b:Service) WHERE a.kind = 'core' RETURN b.name AS n, count(*) AS c ORDER BY n");
        const fluent = await e.Execute(
            CypherQuery
                .Match(Pattern.Node('a').Label('Service').Out('calls', Pattern.Node('b').Label('Service')))
                .Where(Expr.Prop('a', 'kind').Eq('core'))
                .Return(Return.Prop('b', 'name', 'n'), Return.Item(Fn.Count(), 'c'))
                .OrderBy(Sort.By(Expr.Var('n'))),
        );
        assert.deepEqual(text.Columns, fluent.Columns);
        assert.deepEqual(CypherEngine.ToDto(text), CypherEngine.ToDto(fluent));
    });

    test('NodeValue compares by id and ranks between scalars and lists', async () =>
    {
        const r = await e.Execute('MATCH (a:Service) RETURN a ORDER BY a.name');
        const nodes = r.Rows.map((row) => row[0] as NodeValue);
        assert.equal(nodes.length, 6);
        const byId = new Map(nodes.map((n) => [n.Id, n]));
        assert.ok(CypherValue.Compare(byId.get('s1')!, byId.get('s2')!) < 0);
        assert.ok(CypherValue.Compare(byId.get('s2')!, byId.get('s1')!) > 0);
        assert.equal(CypherValue.Compare(byId.get('s3')!, byId.get('s3')!), 0);
        const node = byId.get('s1')!;
        assert.ok(CypherValue.Compare(new ScalarValue(true), node) < 0);
        assert.ok(CypherValue.Compare(node, new ListValue([])) < 0);
        assert.ok(CypherValue.Compare(node, NullValue.Instance) < 0);
        const sorted = await e.Execute('MATCH (a:Service) RETURN a ORDER BY a DESC');
        assert.deepEqual(sorted.Rows.map((row) => (row[0] as NodeValue).Id), ['s5', 's4', 's3', 's2', 's1', 'c1']);
    });

    test('nested unary minus and decimals evaluate', async () =>
    {
        assert.deepEqual(P.Pairs(await e.Execute('RETURN - -1 AS a, -(-2) AS b, - - -3 AS c, 2 - -1 AS d, 1.5 + 1 AS f')), [[1n, 2n, -3n, 3n, 2.5]]);
    });

    test('coalesce(...) IN [list] evaluates; aggregate inside IN is a clear semantic error', async () =>
    {
        assert.deepEqual(P.Pairs(await e.Execute('RETURN coalesce(null, 2) IN [2, 3] AS yes, coalesce(null, 9) IN [2, 3] AS no')), [[true, false]]);
        await assert.rejects(
            e.Execute('MATCH (a:Service) RETURN count(*) IN [1] AS x'),
            (err: unknown) => err instanceof CypherSemanticError && /direct call in a projection item/.test(err.message));
    });

    test('exact-hops *3 end-to-end', async () =>
    {
        const r = await e.Execute("MATCH p = (a:Service)-[:calls*3]->(b) WHERE a.name = 'checkout' RETURN b.name AS n, length(p) AS len ORDER BY n");
        assert.deepEqual(P.Pairs(r), [['audit', 3n], ['checkout', 3n]]);
        assert.equal((await e.Execute("MATCH (a:Service)-[:calls*4]->(b) WHERE a.name = 'checkout' RETURN b.name AS n")).Rows.length, 0);
    });

    test('relationship variable on a variable-length pattern binds the list of traversed relationships', async () =>
    {
        const r = await e.Execute("MATCH (a:Service)-[r:calls*2]->(b) WHERE a.name = 'checkout' RETURN r");
        assert.equal(r.Rows.length, 1);
        const list = r.Rows[0]![0] as ListValue;
        assert.ok(list instanceof ListValue);
        assert.deepEqual(list.Items.map((x) => Sp2Fixture.Rel(x)), [
            { from: 's1', type: 'calls', to: 's2' },
            { from: 's2', type: 'calls', to: 's3' },
        ]);
    });

    test('relationship variable on a fixed-length pattern binds a RelValue', async () =>
    {
        const r = await e.Execute("MATCH (a:Service)-[r:calls]->(b:Service) WHERE a.name = 'billing' RETURN r, b.name AS n ORDER BY n");
        assert.equal(r.Rows.length, 2);
        assert.ok(r.Rows.every((row) => row[0] instanceof RelValue));
        assert.deepEqual(r.Rows.map((row) => Sp2Fixture.Rel(row[0])), [
            { from: 's3', type: 'calls', to: 's4' },
            { from: 's3', type: 'calls', to: 's1' },
        ]);
    });

    test('fixed-length rel variable DTO round-trips as a RelDto', async () =>
    {
        const r = await e.Execute("MATCH (a:Service)-[r:calls]->(b:Service) WHERE a.name = 'checkout' RETURN r");
        assert.equal(r.Rows.length, 1);
        assert.deepEqual(CypherEngine.ToDto(r).Rows[0]![0], { from: 's1', type: 'calls', to: 's2' });
    });

    test('incoming fixed-length rel variable reports the real edge direction', async () =>
    {
        const r = await e.Execute("MATCH (b:Service)<-[r:calls]-(a:Service) WHERE b.name = 'ledger' RETURN r, a.name AS n ORDER BY n");
        assert.deepEqual(r.Rows.map((row) => Sp2Fixture.Rel(row[0])), [
            { from: 's1', type: 'calls', to: 's2' },
            { from: 'c1', type: 'calls', to: 's2' },
        ]);
    });

    // TODL: "untyped rel variable uses the empty type sentinel"; the engine reports the relationship walked (R82 f).
    test('untyped rel variable carries the relationship actually walked', async () =>
    {
        const r = await e.Execute("MATCH (a:Service)-[r]->(b:Service) WHERE a.name = 'checkout' RETURN r");
        assert.deepEqual(Sp2Fixture.Rel(r.Rows[0]![0]), { from: 's1', type: 'calls', to: 's2' });
    });

    test('rel variable binds when the target is already bound (ExpandInto path)', async () =>
    {
        const r = await e.Execute("MATCH (a:Service)-[:calls]->(b:Service), (a)-[r:calls]->(b) WHERE a.name = 'checkout' RETURN r");
        assert.equal(r.Rows.length, 1);
        assert.ok(r.Rows[0]![0] instanceof RelValue);
        assert.deepEqual(Sp2Fixture.Rel(r.Rows[0]![0]), { from: 's1', type: 'calls', to: 's2' });
        const conv = await e.Execute("MATCH (a:Service)-[:calls]->(b:Service), (c)-[r:calls]->(b) WHERE a.name = 'checkout' RETURN r, c.name AS n ORDER BY n");
        assert.deepEqual(conv.Rows.map((row) => Sp2Fixture.Rel(row[0])), [
            { from: 's1', type: 'calls', to: 's2' },
            { from: 'c1', type: 'calls', to: 's2' },
        ]);
    });

    test('incoming variable-length rel variable lists real-direction edges in path order', async () =>
    {
        const r = await e.Execute("MATCH (b:Service)<-[r:calls*2]-(a:Service) WHERE b.name = 'billing' RETURN r, a.name AS n ORDER BY n");
        assert.equal(r.Rows.length, 2);
        assert.deepEqual(r.Rows.map((row) => (row[0] as ListValue).Items.map((x) => Sp2Fixture.Rel(x))), [
            [{ from: 's2', type: 'calls', to: 's3' }, { from: 's1', type: 'calls', to: 's2' }],
            [{ from: 's2', type: 'calls', to: 's3' }, { from: 'c1', type: 'calls', to: 's2' }],
        ]);
    });
});

describe('CypherEngine SP2 WITH ... WHERE', () =>
{
    const base = 'MATCH (a:Service) OPTIONAL MATCH (a)-[:calls]->(b) WITH a.name AS n, count(b) AS c';
    let e: EngineHarness;
    before(async () => { e = await Sp2Fixture.Open(); });
    after(() => e.dispose());

    test('WITH ... WHERE keeps only rows satisfying the predicate', async () =>
    {
        const r = await e.Execute(`${base} WHERE c > 0 RETURN n, c`);
        assert.deepEqual(P.Pairs(r).sort((x, y) => String(x[0]).localeCompare(String(y[0]))), [['billing', 2n], ['checkout', 1n], ['ledger', 1n], ['vault', 1n]]);
    });

    test('WHERE filters before ORDER BY / LIMIT', async () =>
    {
        assert.deepEqual(P.Pairs(await e.Execute(`${base} WHERE c >= 1 ORDER BY c, n LIMIT 1 RETURN n, c`)), [['checkout', 1n]]);
        assert.deepEqual(P.Pairs(await e.Execute(`${base} WHERE c >= 1 ORDER BY c DESC LIMIT 1 RETURN n, c`)), [['billing', 2n]]);
    });

    test('WITH ... WHERE referencing a non-projected name is a semantic error', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service) WITH a.name AS n WHERE zzz > 1 RETURN n'), CypherSemanticError);
        await assert.rejects(e.Execute("MATCH (a:Service) WITH a.name AS n WHERE a.kind = 'x' RETURN n"), CypherSemanticError);
    });

    test('WHERE on an aggregate alias works as HAVING', async () =>
    {
        assert.deepEqual(P.Pairs(await e.Execute('MATCH (a:Service)-[:calls]->(b:Service) WITH b.name AS n, count(*) AS c WHERE c > 1 RETURN n, c')), [['ledger', 2n]]);
    });

    test('WITH ... WHERE matches a projected expression structurally (ORDER BY symmetry)', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute("MATCH (a:Service) WITH a.name AS n WHERE a.name = 'checkout' RETURN n")), ['checkout']);
    });

    test('WITH ... WHERE accepts a parameter on the projected alias', async () =>
    {
        const q = 'MATCH (a:Service) WITH a.name AS n WHERE n = $x RETURN n';
        assert.deepEqual(P.Col(await e.Execute(q, Sp2Fixture.Params([['x', 'checkout']]))), ['checkout']);
        assert.equal((await e.Execute(q, Sp2Fixture.Params([['x', 'no-such-service']]))).Rows.length, 0);
    });

    test('WITH ... WHERE alias form still works', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute("MATCH (a:Service) WITH a.name AS n WHERE n = 'checkout' RETURN n")), ['checkout']);
    });

    test('WITH ... WHERE matches a projected aggregate expression', async () =>
    {
        const byAlias = await e.Execute('MATCH (a:Service)-[:calls]->(b:Service) WITH b.name AS n, count(*) AS c WHERE c > 1 RETURN n, c');
        const byExpr = await e.Execute('MATCH (a:Service)-[:calls]->(b:Service) WITH b.name AS n, count(*) AS c WHERE count(*) > 1 RETURN n, c');
        assert.deepEqual(P.Pairs(byExpr), [['ledger', 2n]]);
        assert.deepEqual(P.Pairs(byExpr), P.Pairs(byAlias));
    });

    test('WITH ... WHERE mixed predicate rewrites only the matched part', async () =>
    {
        assert.deepEqual(P.Pairs(await e.Execute(`${base} WHERE a.name = 'billing' AND c > 0 RETURN n, c`)), [['billing', 2n]]);
    });

    test('WITH ... WHERE unmatched expression over a non-projected property is still an error', async () =>
    {
        await assert.rejects(e.Execute("MATCH (a:Service) WITH a.name AS n WHERE a.name = 'x' AND zzz > 1 RETURN n"), CypherSemanticError);
    });

    test('list parameter in UNWIND', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute('UNWIND $xs AS x RETURN x', Sp2Fixture.Params([['xs', [1, 2, 3]]]))), [1n, 2n, 3n]);
    });

    test('fluent Expr.Param executes end-to-end', async () =>
    {
        const q = CypherQuery.Unwind(Expr.Param('xs'), 'x').Return(Return.Node('x'));
        assert.deepEqual(P.Col(await e.Execute(q, Sp2Fixture.Params([['xs', [1, 2, 3]]]))), [1n, 2n, 3n]);
    });

    test('fluent relationship variable binds and executes', async () =>
    {
        const q = CypherQuery.Match(Pattern.Node('a').Label('Service').Out('calls', Pattern.Node('b').Label('Service'), undefined, 'r')).Return(Fn.Count().As('n'));
        const text = await e.Execute('MATCH (a:Service)-[r:calls]->(b:Service) RETURN count(*) AS n');
        assert.deepEqual(P.Col(await e.Execute(q)), P.Col(text));
    });

    test('list parameter indexing', async () =>
    {
        const r = await e.Execute('RETURN $xs[1] AS second', Sp2Fixture.Params([['xs', [10, 20, 30]]]));
        assert.equal((r.Rows[0]![0] as ScalarValue).Value, 20n);
    });

    test('map parameter property and index access', async () =>
    {
        const params = Sp2Fixture.Params([['m', { k: 'hi' }]]);
        assert.equal(((await e.Execute('RETURN $m.k AS v', params)).Rows[0]![0] as ScalarValue).Value, 'hi');
        assert.equal(((await e.Execute("RETURN $m['k'] AS v", params)).Rows[0]![0] as ScalarValue).Value, 'hi');
    });

    test('nested list parameter round-trips through ToDto', async () =>
    {
        const r = await e.Execute('UNWIND $xs AS pair RETURN pair', Sp2Fixture.Params([['xs', [[1, 2], [3]]]]));
        assert.equal(r.Rows.length, 2);
        assert.ok(r.Rows[0]![0] instanceof ListValue);
        assert.deepEqual(CypherEngine.ToDto(r).Rows, [[[1, 2]], [[3]]]);
        const whole = await e.Execute('RETURN $xs AS xs', Sp2Fixture.Params([['xs', [1, 'a', null]]]));
        assert.deepEqual(CypherEngine.ToDto(whole).Rows, [[[1, 'a', null]]]);
    });

    test('null parameter is NullValue', async () =>
    {
        assert.equal((await e.Execute('RETURN $n AS n', Sp2Fixture.Params([['n', null]]))).Rows[0]![0], NullValue.Instance);
    });

    test('scalar parameter returned directly', async () =>
    {
        const r = await e.Execute('RETURN $one AS x', Sp2Fixture.Params([['one', 5]]));
        assert.equal(r.Rows.length, 1);
        assert.equal((r.Rows[0]![0] as ScalarValue).Value, 5n);
    });

    test('non-plain-object parameter is rejected', async () =>
    {
        await assert.rejects(e.Execute('RETURN $d AS d', Sp2Fixture.Params([['d', new Date() as unknown as null]])), CypherSemanticError);
    });

    test('scalar parameter back-compat and missing parameter', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute('UNWIND $one AS x RETURN x', Sp2Fixture.Params([['one', 5]]))), [5n]);
        await assert.rejects(e.Execute('RETURN $nope AS v'), CypherSemanticError);
    });
});

describe('CypherEngine SP2 constraints on reused variable occurrences', () =>
{
    // Adds checkout(s1)->vault(c1) so the CoreService vault is reachable as a call target.
    const TripleCols = 'a.name AS a, b.name AS b, c.name AS c';
    let e: EngineHarness;
    before(async () => { e = await Sp2Fixture.Open([['s1', 'c1']]); });
    after(() => e.dispose());

    test('reused target label excludes bound nodes that are not that label', async () =>
    {
        const r = await e.Execute(`MATCH (a:Service)-[:calls]->(b), (c:Service)-[:calls]->(b:CoreService) RETURN ${TripleCols} ORDER BY a, c`);
        assert.deepEqual(P.Pairs(r), [['checkout', 'vault', 'checkout']]);
    });

    test('reused target property excludes non-matching bound nodes', async () =>
    {
        const r = await e.Execute(`MATCH (a)-[:calls]->(b), (c)-[:calls]->(b {kind: 'api'}) RETURN ${TripleCols} ORDER BY a, b, c`);
        assert.deepEqual(P.Pairs(r), [['billing', 'audit', 'billing'], ['billing', 'checkout', 'billing']]);
    });

    test('reused anchor label constrains the bound variable', async () =>
    {
        const r = await e.Execute('MATCH (a:Service)-[:calls]->(b), (b:CoreService)-[:calls]->(x) RETURN a.name AS a, b.name AS b, x.name AS x');
        assert.deepEqual(P.Pairs(r), [['checkout', 'vault', 'ledger']]);
    });

    test('reused anchor property constrains the bound variable', async () =>
    {
        const r = await e.Execute("MATCH (a)-[:calls]->(b), (b {kind: 'core'})-[:calls]->(x) RETURN a.name AS a, b.name AS b, x.name AS x ORDER BY a, b, x");
        assert.deepEqual(P.Pairs(r), [
            ['checkout', 'ledger', 'billing'],
            ['checkout', 'vault', 'ledger'],
            ['ledger', 'billing', 'audit'],
            ['ledger', 'billing', 'checkout'],
            ['vault', 'ledger', 'billing'],
        ]);
    });

    test('reused occurrences with no extra constraint are unchanged', async () =>
    {
        const r = await e.Execute(`MATCH (a)-[:calls]->(b), (c)-[:calls]->(b) WHERE a.name < c.name RETURN ${TripleCols} ORDER BY a, c`);
        assert.deepEqual(P.Pairs(r), [['checkout', 'ledger', 'vault']]);
        assert.deepEqual(P.Col(await e.Execute('MATCH (a)-[:calls]->(b), (b)-[:calls]->(x) RETURN count(*) AS n')), [7n]);
    });
});

describe('CypherEngine strict WITH-segment scope (opt-in)', () =>
{
    const dropped = 'MATCH (a:Service) WITH a.name AS n MATCH (a)-[:calls]->(b) RETURN b.name';
    let strict: EngineHarness;
    let lax: EngineHarness;
    before(async () => { strict = await Sp2Fixture.Open([], { StrictWithScope: true }); lax = await Sp2Fixture.Open(); });
    after(async () => { await strict.dispose(); await lax.dispose(); });

    test('strict rejects reuse of a name dropped by WITH', async () =>
    {
        await assert.rejects(strict.Execute(dropped), (e: unknown) => e instanceof CypherSemanticError && /dropped by an earlier WITH/.test(e.message));
    });

    test('default mode still allows the dropped-name reuse (fresh variable)', async () =>
    {
        assert.ok((await lax.Execute(dropped)).Rows.length > 0);
    });

    test('strict allows a variable carried through WITH as a join', async () =>
    {
        assert.ok((await strict.Execute('MATCH (a:Service) WITH a AS a MATCH (a)-[:calls]->(b) RETURN b.name')).Rows.length > 0);
    });

    test('strict allows a genuinely new variable in a later segment', async () =>
    {
        assert.ok((await strict.Execute('MATCH (a:Service) WITH a.name AS n MATCH (x:Service) RETURN n, x.name')).Rows.length > 0);
    });

    test('strict leaves single-part queries alone', async () =>
    {
        assert.ok((await strict.Execute('MATCH (a:Service)-[:calls]->(b:Service) RETURN a.name, b.name')).Rows.length > 0);
    });
});

describe('Execute limits', () =>
{
    let engine: EngineHarness;
    before(async () => { engine = await Sp2Fixture.Open(); });
    after(() => engine.dispose());

    test('Execute RowCap truncates and flags Truncated', async () =>
    {
        const all = await engine.Execute('MATCH (a:Service) RETURN a.name');
        assert.ok(all.Rows.length >= 3);
        const capped = await engine.Execute('MATCH (a:Service) RETURN a.name', undefined, { RowCap: 2 });
        assert.equal(capped.Rows.length, 2);
        assert.equal(capped.Truncated, true);
        assert.equal(all.Truncated, false);
        assert.equal(CypherEngine.ToDto(capped).Truncated, true);
    });

    test('RowCap equal to the row count keeps every row and is not flagged Truncated', async () =>
    {
        const all = await engine.Execute('MATCH (a:Service) RETURN a.name');
        const capped = await engine.Execute('MATCH (a:Service) RETURN a.name', undefined, { RowCap: all.Rows.length });
        assert.equal(capped.Rows.length, all.Rows.length);
        assert.equal(capped.Truncated, false);
    });

    test('an expired deadline aborts inside a buffering operator (Sort/Cartesian)', async () =>
    {
        const expired = { Expired: () => true };
        await assert.rejects(engine.Execute('MATCH (a:Service), (b:Service) RETURN a.name ORDER BY a.name', undefined, { Cancel: expired }), (e) => e instanceof CypherTimeout);
    });

    test('an expired deadline aborts Distinct, Aggregate and VarLengthExpand', async () =>
    {
        const expired = { Expired: () => true };
        const queries = [
            'MATCH (a:Service) RETURN DISTINCT a.kind',
            'MATCH (a:Service) RETURN count(a)',
            'MATCH (a:Service)-[:calls*1..3]->(b:Service) RETURN b.name',
        ];
        for (const q of queries)
        {
            await assert.rejects(engine.Execute(q, undefined, { Cancel: expired }), (e) => e instanceof CypherTimeout, q);
        }
    });

    test('a non-expired deadline lets the query complete with unchanged rows', async () =>
    {
        const q = 'MATCH (a:Service), (b:Service) RETURN a.name ORDER BY a.name';
        const plain = await engine.Execute(q);
        const live = await engine.Execute(q, undefined, { Cancel: Deadline.After(60000) });
        const stub = await engine.Execute(q, undefined, { Cancel: { Expired: () => false } });
        assert.equal(live.Rows.length, plain.Rows.length);
        assert.equal(stub.Rows.length, plain.Rows.length);
        assert.equal(live.Truncated, false);
    });
});

describe('CypherEngine projection column names are unique', () =>
{
    let e: EngineHarness;
    before(async () => { e = await Sp2Fixture.Open(); });
    after(() => e.dispose());

    test('RETURN with two items aliased to the same name is a semantic error (no silent collapse)', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service) RETURN a.name AS n, a.kind AS n'), CypherSemanticError);
    });

    test('two implicit columns with the same name are a semantic error', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service) RETURN a.name, a.name'), CypherSemanticError);
    });

    test('WITH duplicate names are a semantic error (the downstream variable would be ambiguous)', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service) WITH a.name AS n, a.kind AS n RETURN n'), CypherSemanticError);
    });

    test('the same expression under two distinct names is still fine', async () =>
    {
        assert.deepEqual(P.Pairs(await e.Execute("MATCH (a:Service {name: 'ledger'}) RETURN a.name AS x, a.name AS y")), [['ledger', 'ledger']]);
    });
});

describe('CypherEngine WHERE NOT / IS NULL / bare arrows (end-to-end)', () =>
{
    let e: EngineHarness;
    before(async () => { e = await Sp2Fixture.Open(); });
    after(() => e.dispose());

    test('WHERE NOT negates the predicate', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute("MATCH (a:Service) WHERE NOT a.kind = 'core' RETURN a.name AS n ORDER BY n")), ['audit', 'checkout', 'lonely']);
    });

    test('IS NOT NULL keeps every node with the property; IS NULL keeps none', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute('MATCH (a:Service) WHERE a.kind IS NOT NULL RETURN count(a) AS c')), [6n]);
        assert.deepEqual(P.Col(await e.Execute('MATCH (a:Service) WHERE a.kind IS NULL RETURN count(a) AS c')), [0n]);
    });

    test('bare --> follows outgoing edges of any type', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute("MATCH (a:Service {name: 'billing'})-->(b) RETURN b.name AS n ORDER BY n")), ['audit', 'checkout']);
    });

    test('bare <-- follows incoming edges of any type', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute("MATCH (a:Service {name: 'ledger'})<--(b) RETURN b.name AS n ORDER BY n")), ['checkout', 'vault']);
    });

    test('bare -- follows edges in both directions', async () =>
    {
        assert.deepEqual(P.Col(await e.Execute("MATCH (a:Service {name: 'billing'})--(b) RETURN b.name AS n ORDER BY n")), ['audit', 'checkout', 'ledger']);
    });
});
