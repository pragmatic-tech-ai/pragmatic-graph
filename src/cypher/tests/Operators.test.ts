import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LabelScan } from '../operators/LabelScan.js';
import { Expand } from '../operators/Expand.js';
import { Filter } from '../operators/Filter.js';
import { Project } from '../operators/Project.js';
import { ScalarValue, NodeValue } from '../CypherValue.js';
import { RelDirection, ComparisonOp } from '../CypherEnums.js';
import { Comparison, PropertyAccess, Literal } from '../Expression.js';
import { ReturnItem } from '../CypherQueryModel.js';
import { CypherFixture } from './CypherFixture.js';

/** Service a (name checkout) -calls-> Service b (name ledger). */
class OperatorFixtures
{
    public static readonly Service = 'Service';
    public static readonly Calls = 'calls';
    public static readonly Name = 'name';

    public static Open(): Promise<CypherFixture>
    {
        const F = CypherFixture;
        return F.Open(
            [F.Concept(OperatorFixtures.Service, [F.Text(OperatorFixtures.Name), F.Rel(OperatorFixtures.Calls, [OperatorFixtures.Service])])],
            [
                F.Node('a', OperatorFixtures.Service, { name: 'checkout' }, [[OperatorFixtures.Calls, 'b']]),
                F.Node('b', OperatorFixtures.Service, { name: 'ledger' }),
            ]);
    }
}

describe('cypher operators', () =>
{
    let fx: CypherFixture;
    before(async () => { fx = await OperatorFixtures.Open(); });
    after(async () => { await fx.dispose(); });

    test('LabelScan yields one binding per labelled node', async () =>
    {
        const rows = await fx.Read(s => CypherFixture.Collect(new LabelScan(s, 'x', OperatorFixtures.Service)));
        assert.deepEqual(rows.map((r) => (r.Get('x') as NodeValue).Id).sort(), ['a', 'b']);
    });

    test('Expand extends bindings along edges', async () =>
    {
        const rows = await fx.Read(s =>
        {
            const child = new LabelScan(s, 'x', OperatorFixtures.Service);
            return CypherFixture.Collect(new Expand(child, s, 'x', 'y', OperatorFixtures.Calls, RelDirection.Outgoing, undefined));
        });
        const pairs = rows.map((r) => [(r.Get('x') as NodeValue).Id, (r.Get('y') as NodeValue).Id]);
        assert.deepEqual(pairs, [['a', 'b']]);
    });

    test('Filter drops rows failing the predicate', async () =>
    {
        const rows = await fx.Read(s =>
        {
            const child = new LabelScan(s, 'x', OperatorFixtures.Service);
            const pred = new Comparison(new PropertyAccess('x', OperatorFixtures.Name), ComparisonOp.Eq, new Literal('checkout'));
            return CypherFixture.Collect(new Filter(child, pred, new Map()));
        });
        assert.deepEqual(rows.map((r) => (r.Get('x') as NodeValue).Id), ['a']);
    });

    test('Project evaluates return items into named columns', async () =>
    {
        const rows = await fx.Read(s =>
        {
            const child = new LabelScan(s, 'x', OperatorFixtures.Service);
            const items = [new ReturnItem(new PropertyAccess('x', OperatorFixtures.Name), 'n')];
            return CypherFixture.Collect(new Project(child, items, new Map()));
        });
        assert.deepEqual(rows.map((r) => (r.Get('n') as ScalarValue).Value).sort(), ['checkout', 'ledger']);
    });
});
