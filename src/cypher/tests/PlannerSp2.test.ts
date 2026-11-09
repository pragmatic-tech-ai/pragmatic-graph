import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CypherSemanticError } from '../CypherError.js';
import { NodeValue, ScalarValue } from '../CypherValue.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

class Sp2PlannerFixture
{
    // a (checkout) calls b (ledger) and c (audit), plus any extra edges.
    public static Open(extra: readonly (readonly [string, string])[] = []): Promise<EngineHarness>
    {
        const F = CypherFixture;
        const edges: [string, string][] = [['a', 'b'], ['a', 'c'], ...extra.map(([x, y]) => [x, y] as [string, string])];
        const links = (id: string): [string, string][] => edges.filter(([from]) => from === id).map(([, to]) => ['calls', to]);
        return EngineHarness.Open(
            [F.Concept('Element', []), F.Concept('Service', [F.Text('name'), F.Rel('calls', ['Service'])], 'Element')],
            [F.Node('a', 'Service', { name: 'checkout' }, links('a')), F.Node('b', 'Service', { name: 'ledger' }, links('b')), F.Node('c', 'Service', { name: 'audit' }, links('c'))]);
    }

    public static async Scalars(h: EngineHarness, text: string): Promise<unknown[]>
    {
        return (await h.Execute(text)).Rows.map((r) => (r[0] as ScalarValue).Value);
    }
}

describe('cypher planner SP2 (segment pipeline)', () =>
{
    let e: EngineHarness;
    let extra: EngineHarness;
    before(async () => { e = await Sp2PlannerFixture.Open(); extra = await Sp2PlannerFixture.Open([['b', 'c']]); });
    after(async () => { await e.dispose(); await extra.dispose(); });

    test('WITH chain carries a projected variable into a later RETURN', async () =>
    {
        assert.deepEqual(await Sp2PlannerFixture.Scalars(e, 'MATCH (a:Service) WITH a AS svc RETURN svc.name AS n ORDER BY n'), ['audit', 'checkout', 'ledger']);
    });

    test('aggregating RETURN with grouping and count(*)', async () =>
    {
        const result = await e.Execute('MATCH (a:Service)-[:calls]->(b:Service) RETURN a.name AS caller, count(*) AS c');
        assert.deepEqual(result.Columns, ['caller', 'c']);
        assert.equal(result.Rows.length, 1);
        assert.equal((result.Rows[0]![0] as ScalarValue).Value, 'checkout');
        assert.equal((result.Rows[0]![1] as ScalarValue).Value, 2n);
    });

    test('bare count(*) aggregates all rows into a single group', async () =>
    {
        assert.deepEqual(await Sp2PlannerFixture.Scalars(e, 'MATCH (a:Service) RETURN count(*) AS c'), [3n]);
    });

    test('ORDER BY DESC then LIMIT truncates the sorted stream', async () =>
    {
        assert.deepEqual(await Sp2PlannerFixture.Scalars(e, 'MATCH (a:Service) RETURN a.name AS n ORDER BY n DESC LIMIT 1'), ['ledger']);
    });

    test('ORDER BY on a name that is not a projected column raises CypherSemanticError', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service) RETURN a.name AS n ORDER BY nope'), CypherSemanticError);
    });

    test('RETURN a.name ORDER BY a.name sorts without throwing', async () =>
    {
        assert.deepEqual(await Sp2PlannerFixture.Scalars(e, 'MATCH (a:Service) RETURN a.name ORDER BY a.name DESC'), ['ledger', 'checkout', 'audit']);
    });

    test('ORDER BY an unaliased projected aggregate sorts on the projected column', async () =>
    {
        // a(checkout) calls b(ledger) and c(audit); the extra edge b->c gives out-degrees 2 / 1 / 0.
        const query = 'MATCH (a:Service) OPTIONAL MATCH (a)-[:calls]->(b:Service) RETURN a.name AS n, count(b) AS c ORDER BY count(b)';
        const column = async (text: string, i: number) => (await extra.Execute(text)).Rows.map((r) => (r[i] as ScalarValue).Value);
        assert.deepEqual(await column(`${query} DESC`, 0), ['checkout', 'ledger', 'audit']);
        assert.deepEqual(await column(`${query} DESC`, 1), [2n, 1n, 0n]);
        assert.deepEqual(await column(`${query} ASC`, 0), ['audit', 'ledger', 'checkout']);
        assert.deepEqual(await column(`${query} ASC`, 1), [0n, 1n, 2n]);
    });

    test('ORDER BY a different aggregate than the projected one is rejected', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service) RETURN a.kind AS k, count(*) AS c ORDER BY count(a)'), CypherSemanticError);
    });

    test('aliased projection can ORDER BY the original property expression', async () =>
    {
        assert.deepEqual(await Sp2PlannerFixture.Scalars(e, 'MATCH (a:Service) RETURN a.name AS n ORDER BY a.name'), ['audit', 'checkout', 'ledger']);
    });

    test('ORDER BY a property of a projected variable works', async () =>
    {
        const result = await e.Execute('MATCH (a:Service) RETURN a AS a ORDER BY a.name');
        assert.equal(result.Rows.length, 3);
        assert.deepEqual(result.Rows.map((r) => (r[0] as NodeValue).Field('name')), ['audit', 'checkout', 'ledger']);
    });

    test('variable-length *..0 (min 1 > max 0) raises CypherSemanticError', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service)-[:calls*..0]->(b:Service) RETURN b.name AS n'), CypherSemanticError);
    });

    test('variable-length min greater than max raises CypherSemanticError', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service)-[:calls*3..1]->(b:Service) RETURN b.name AS n'), CypherSemanticError);
    });

    test('referencing a variable dropped by WITH raises CypherSemanticError', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service) WITH a.name AS n RETURN a'), CypherSemanticError);
    });

    test('WITH ... WHERE is not scope-checked against the pre-projection scope (references projected aliases)', async () =>
    {
        const r = await e.Execute("MATCH (a:Service) WITH a.name AS n WHERE n = 'checkout' RETURN n");
        assert.equal(r.Rows.length, 1);
        assert.equal((r.Rows[0]![0] as ScalarValue).Value, 'checkout');
    });
});
