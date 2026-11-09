import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessScope, Compare, CompareOp, IdIn, type IDefinitionDescription, type IIndexDescription, type ISeedNode } from '../../index.js';
import { ScalarValue, type CypherValue } from '../CypherValue.js';
import { LogicalPlanner } from '../LogicalPlanner.js';
import { CypherFixture } from './CypherFixture.js';

/** Service { name, tier, ratio(Float64), count(Int64) } with and without indexes over the same data. */
class SeekHarness
{
    public static readonly Service = 'Service';
    public static readonly ByName = 'by_name';
    public static readonly PartialTier = 'partial_tier';
    public static readonly ByRatio = 'by_ratio';
    public static readonly ByCount = 'by_count';
    private static readonly SeekMark = 'IndexSeek(';
    private static readonly ScanMark = 'LabelScan(';

    public static Definitions(): IDefinitionDescription[]
    {
        const F = CypherFixture;
        return [F.Concept(SeekHarness.Service, [F.Text('name'), F.Text('tier'), F.Float('ratio'), F.Int('count')])];
    }

    public static Seed(): ISeedNode[]
    {
        const F = CypherFixture;
        return [
            F.Node('a', SeekHarness.Service, { name: 'checkout', tier: 'gold', ratio: 2, count: 2n }),
            F.Node('b', SeekHarness.Service, { name: 'ledger', tier: 'gold', ratio: 2.5, count: 3n }),
            F.Node('c', SeekHarness.Service, { name: 'checkout', tier: 'bronze', ratio: 3, count: 2n }),
            F.Node('d', SeekHarness.Service, { name: 'search' }),
        ];
    }

    public static Indexes(): IIndexDescription[]
    {
        return [
            { Name: SeekHarness.ByName, On: SeekHarness.Service, Members: ['name'] },
            { Name: SeekHarness.PartialTier, On: SeekHarness.Service, Members: ['tier'], Where: new Compare('name', CompareOp.Eq, 'checkout') },
            { Name: SeekHarness.ByRatio, On: SeekHarness.Service, Members: ['ratio'] },
            { Name: SeekHarness.ByCount, On: SeekHarness.Service, Members: ['count'] },
        ];
    }

    public static Open(indexed: boolean): Promise<CypherFixture>
    {
        return CypherFixture.Open(SeekHarness.Definitions(), SeekHarness.Seed(), indexed ? SeekHarness.Indexes() : []);
    }

    public static Explain(fx: CypherFixture, text: string): Promise<string>
    {
        return fx.Read(async s => LogicalPlanner.Explain(s, text));
    }

    public static async Ids(fx: CypherFixture, text: string, parameters: ReadonlyMap<string, CypherValue> = new Map()): Promise<string[]>
    {
        return (await fx.Rows(text, AccessScope.System, parameters)).map(r => r.get('n') as string).sort();
    }

    public static IsSeek(plan: string): boolean
    {
        return plan.includes(SeekHarness.SeekMark) && !plan.includes(SeekHarness.ScanMark);
    }

    public static IsScan(plan: string): boolean
    {
        return plan.includes(SeekHarness.ScanMark) && !plan.includes(SeekHarness.SeekMark);
    }
}

describe('cypher index seek', () =>
{
    let indexed: CypherFixture;
    let plain: CypherFixture;
    before(async () =>
    {
        indexed = await SeekHarness.Open(true);
        plain = await SeekHarness.Open(false);
    });
    after(async () =>
    {
        await indexed.dispose();
        await plain.dispose();
    });

    test('inline property uses index', async () =>
    {
        const text = "MATCH (n:Service {name: 'checkout'}) RETURN n";
        const plan = await SeekHarness.Explain(indexed, text);
        assert.ok(SeekHarness.IsSeek(plan), plan);
        assert.ok(plan.includes(`IndexSeek(${SeekHarness.ByName})`), plan);
        assert.deepEqual(await SeekHarness.Ids(indexed, text), ['a', 'c']);
    });

    test('where equality uses index and keeps the remaining filters', async () =>
    {
        const text = "MATCH (n:Service) WHERE n.name = 'checkout' AND n.tier = 'gold' RETURN n";
        const plan = await SeekHarness.Explain(indexed, text);
        assert.ok(plan.includes('IndexSeek('), plan);
        assert.ok(plan.includes('Filter'), plan);
        assert.deepEqual(await SeekHarness.Ids(indexed, text), ['a']);
        assert.deepEqual(await SeekHarness.Ids(indexed, "MATCH (n:Service) WHERE 'ledger' = n.name RETURN n"), ['b']);
    });

    test('a lone where equality leaves no filter', async () =>
    {
        const plan = await SeekHarness.Explain(indexed, "MATCH (n:Service) WHERE n.name = 'ledger' RETURN n");
        assert.ok(plan.includes('IndexSeek(') && !plan.includes('Filter'), plan);
    });

    test('parameter equality seeks with the run-time value', async () =>
    {
        const text = 'MATCH (n:Service) WHERE n.name = $x RETURN n';
        assert.ok((await SeekHarness.Explain(indexed, text)).includes('IndexSeek('));
        assert.deepEqual(await SeekHarness.Ids(indexed, text, new Map([['x', new ScalarValue('ledger')]])), ['b']);
        assert.deepEqual(await SeekHarness.Ids(indexed, text, new Map([['x', new ScalarValue('nobody')]])), []);
    });

    test('partial index never used', async () =>
    {
        const text = "MATCH (n:Service {tier: 'gold'}) RETURN n";
        assert.ok(SeekHarness.IsScan(await SeekHarness.Explain(indexed, text)));
        assert.deepEqual(await SeekHarness.Ids(indexed, text), ['a', 'b']);
    });

    test('no index falls back to scan', async () =>
    {
        const text = "MATCH (n:Service {name: 'checkout'}) RETURN n";
        assert.ok(SeekHarness.IsScan(await SeekHarness.Explain(plain, text)));
        assert.deepEqual(await SeekHarness.Ids(plain, text), ['a', 'c']);
    });

    test('only freshly bound labelled equality seeks', async () =>
    {
        assert.ok(SeekHarness.IsScan(await SeekHarness.Explain(indexed, "MATCH (n:Service) WHERE n.name <> 'x' RETURN n")));
        assert.ok(SeekHarness.IsScan(await SeekHarness.Explain(indexed, "MATCH (n:Service) WHERE n.name = 'x' OR n.name = 'y' RETURN n")));
        assert.ok(!(await SeekHarness.Explain(indexed, "MATCH (n) WHERE n.name = 'x' RETURN n")).includes('IndexSeek('));
    });

    test('seek and scan agree', async () =>
    {
        const queries = [
            "MATCH (n:Service {name: 'checkout'}) RETURN n",
            "MATCH (n:Service) WHERE n.name = 'checkout' AND n.count = 2 RETURN n",
            "MATCH (n:Service {name: 'missing'}) RETURN n",
            'MATCH (n:Service {ratio: 2}) RETURN n',
            'MATCH (n:Service {ratio: 2.5}) RETURN n',
            'MATCH (n:Service {count: 2}) RETURN n',
            'MATCH (n:Service) WHERE n.count = 2.0 RETURN n',
            'MATCH (n:Service) WHERE n.count = 2.5 RETURN n',
            'MATCH (n:Service) WHERE n.ratio = 3 RETURN n',
            'MATCH (n:Service) WHERE n.ratio = 9007199254740993 RETURN n',
            'MATCH (n:Service) WHERE n.count = 9223372036854775807 RETURN n',
            'MATCH (n:Service) WHERE n.count = 100000000000000000000.0 RETURN n',
            "MATCH (n:Service) WHERE n.count = 'two' RETURN n",
            'MATCH (n:Service) WHERE n.name = null RETURN n',
            'MATCH (n:Service) WHERE n.name = 2 RETURN n',
        ];
        for (const q of queries)
        {
            assert.deepEqual(await SeekHarness.Ids(indexed, q), await SeekHarness.Ids(plain, q), q);
        }
    });

    test('mixed numeric types seek exactly', async () =>
    {
        assert.ok((await SeekHarness.Explain(indexed, 'MATCH (n:Service {ratio: 2}) RETURN n')).includes('IndexSeek('));
        assert.deepEqual(await SeekHarness.Ids(indexed, 'MATCH (n:Service {ratio: 2}) RETURN n'), ['a']);
        assert.deepEqual(await SeekHarness.Ids(indexed, 'MATCH (n:Service) WHERE n.count = 2.0 RETURN n'), ['a', 'c']);
        assert.deepEqual(await SeekHarness.Ids(indexed, 'MATCH (n:Service) WHERE n.count = 2.5 RETURN n'), []);
        assert.deepEqual(await SeekHarness.Ids(indexed, 'MATCH (n:Service) WHERE n.ratio = 3 RETURN n'), ['c']);
    });

    test('seek respects scope', async () =>
    {
        const scope = AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[SeekHarness.Service, new IdIn(new Set(['a', 'b']))]]) });
        const rows = await indexed.Rows("MATCH (n:Service {name: 'checkout'}) RETURN n", scope);
        assert.deepEqual(rows.map(r => r.get('n')), ['a']);
    });
});
