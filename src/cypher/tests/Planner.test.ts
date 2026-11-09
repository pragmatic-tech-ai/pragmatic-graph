import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LogicalPlanner } from '../LogicalPlanner.js';
import { CypherParser } from '../CypherParser.js';
import { CypherSemanticError } from '../CypherError.js';
import { CypherFixture } from './CypherFixture.js';

/** Service a (checkout) -calls-> Service b (ledger). */
class PlannerHarness
{
    public static readonly Service = 'Service';
    public static readonly Calls = 'calls';

    public static Open(): Promise<CypherFixture>
    {
        const F = CypherFixture;
        return F.Open(
            [F.Concept(PlannerHarness.Service, [F.Text('name'), F.Rel(PlannerHarness.Calls, [PlannerHarness.Service])])],
            [F.Node('a', PlannerHarness.Service, { name: 'checkout' }, [[PlannerHarness.Calls, 'b']]), F.Node('b', PlannerHarness.Service, { name: 'ledger' })]);
    }

    /** Plans only (Plan is synchronous and raises every planning error) without running the plan; the reader is async, so callers use assert.rejects. */
    public static Plan(fx: CypherFixture, text: string): Promise<void>
    {
        return fx.Read(async s =>
        {
            new LogicalPlanner(s, new Map()).Plan(new CypherParser(text).Parse());
        });
    }
}

describe('cypher planner', () =>
{
    let fx: CypherFixture;
    before(async () => { fx = await PlannerHarness.Open(); });
    after(async () => { await fx.dispose(); });

    test('plans a scan + expand + where + project end to end', async () =>
    {
        const rows = await fx.Rows("MATCH (a:Service)-[:calls]->(b:Service) WHERE a.name = 'checkout' RETURN b.name AS n");
        assert.deepEqual(rows.map((r) => r.get('n')), ['ledger']);
    });

    test('unbound RETURN variable raises CypherSemanticError', async () =>
    {
        await assert.rejects(PlannerHarness.Plan(fx, 'MATCH (a:Service) RETURN b'), CypherSemanticError);
    });

    test('multiple comma paths cartesian-join into one segment (SP2)', async () =>
    {
        const rows = await fx.Rows('MATCH (a:Service), (b:Service) RETURN a');
        assert.deepEqual(rows.map((r) => r.get('a')).sort(), ['a', 'a', 'b', 'b']);
    });

    test('unknown relationship type raises CypherSemanticError', async () =>
    {
        await assert.rejects(PlannerHarness.Plan(fx, 'MATCH (a:Service)-[:ghost]->(b:Service) RETURN a'), CypherSemanticError);
    });
});
