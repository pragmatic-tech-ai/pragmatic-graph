import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CypherParser } from '../CypherParser.js';
import { CypherSemanticError } from '../CypherError.js';
import { MatchClause } from '../CypherQueryModel.js';
import { ScalarValue } from '../CypherValue.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

class VarLengthFixture
{
    public static FirstRel(text: string): { Min: number | undefined; Max: number | undefined; Path: string | undefined }
    {
        const match = new CypherParser(text).Parse().Parts[0]!.Reading[0] as MatchClause;
        const path = match.Paths[0]!;
        return { Min: path.Rels[0]!.MinHops, Max: path.Rels[0]!.MaxHops, Path: path.PathVariable };
    }

    // Chain a -> b -> c -> d.
    public static Open(): Promise<EngineHarness>
    {
        const F = CypherFixture;
        const next: Record<string, string> = { a: 'b', b: 'c', c: 'd' };
        return EngineHarness.Open(
            [F.Concept('Element', []), F.Concept('Service', [F.Text('name'), F.Rel('calls', ['Service'])], 'Element')],
            ['a', 'b', 'c', 'd'].map((id) => F.Node(id, 'Service', { name: id }, next[id] === undefined ? [] : [['calls', next[id]!]])));
    }
}

describe('variable-length rels + path variables', () =>
{
    let e: EngineHarness;
    before(async () => { e = await VarLengthFixture.Open(); });
    after(() => e.dispose());

    test('bare star is 1..unbounded', () =>
    {
        assert.deepEqual(VarLengthFixture.FirstRel('MATCH (a)-[*]->(b) RETURN b'), { Min: 1, Max: undefined, Path: undefined });
    });

    test('*n is exactly n', () =>
    {
        assert.deepEqual(VarLengthFixture.FirstRel('MATCH (a)-[:calls*3]->(b) RETURN b'), { Min: 3, Max: 3, Path: undefined });
    });

    test('*n.. is min n, unbounded', () =>
    {
        assert.deepEqual(VarLengthFixture.FirstRel('MATCH (a)-[*2..]->(b) RETURN b'), { Min: 2, Max: undefined, Path: undefined });
    });

    test('*..m is 1..m', () =>
    {
        assert.deepEqual(VarLengthFixture.FirstRel('MATCH (a)-[*..5]->(b) RETURN b'), { Min: 1, Max: 5, Path: undefined });
    });

    test('*n..m', () =>
    {
        assert.deepEqual(VarLengthFixture.FirstRel('MATCH (a)-[r:calls*2..5]->(b) RETURN b'), { Min: 2, Max: 5, Path: undefined });
    });

    test('fixed rel has undefined hops', () =>
    {
        assert.deepEqual(VarLengthFixture.FirstRel('MATCH (a)-[:calls]->(b) RETURN b'), { Min: undefined, Max: undefined, Path: undefined });
    });

    test('path variable + hop bounds', () =>
    {
        assert.deepEqual(VarLengthFixture.FirstRel('MATCH p = (a)-[*1..2]->(b) RETURN p'), { Min: 1, Max: 2, Path: 'p' });
    });

    test('end-to-end: var-length returns reachable endpoints', async () =>
    {
        const result = await e.Execute("MATCH (a:Service)-[:calls*1..2]->(b) WHERE a.name = 'a' RETURN b.name AS n");
        assert.deepEqual(result.Rows.map((r) => (r[0] as ScalarValue).Value).sort(), ['b', 'c']);
    });

    test('end-to-end: unbounded star reaches the whole chain', async () =>
    {
        const result = await e.Execute("MATCH (a:Service)-[:calls*]->(b) WHERE a.name = 'a' RETURN b.name AS n");
        assert.deepEqual(result.Rows.map((r) => (r[0] as ScalarValue).Value).sort(), ['b', 'c', 'd']);
    });

    test('end-to-end: path variable binds a PathValue (length)', async () =>
    {
        const result = await e.Execute("MATCH p = (a:Service)-[:calls*1..2]->(b) WHERE a.name = 'a' RETURN b.name AS n, length(p) AS len");
        const rows = result.Rows.map((r) => [(r[0] as ScalarValue).Value, (r[1] as ScalarValue).Value]);
        rows.sort((x, y) => String(x[0]).localeCompare(String(y[0])));
        assert.deepEqual(rows, [['b', 1n], ['c', 2n]]);
    });

    test('path variable without a var-length rel is rejected', async () =>
    {
        await assert.rejects(e.Execute('MATCH p = (a:Service)-[:calls]->(b) RETURN p'), CypherSemanticError);
    });
});
