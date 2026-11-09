import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessScope, Compare, CompareOp, DateTimeValue, IdIn, MemberKind, ValueType, type CellValue, type IDefinitionDescription, type IIndexDescription, type ISeedNode } from '../../index.js';
import { CypherParser } from '../CypherParser.js';
import type { CypherNode } from '../CypherNode.js';
import type { Binding } from '../Binding.js';
import type { GraphReader } from '../../GraphReader.js';
import { ReaderSource } from '../ReaderSource.js';
import { ScalarValue, type CypherValue } from '../CypherValue.js';
import { LogicalPlanner } from '../LogicalPlanner.js';
import { CypherQuery, Expr, Pattern, Return } from '../CypherQuery.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

/** Service { name, tier, ratio(Float64), count(Int64) } with and without indexes over the same data. */
class SeekHarness
{
    public static readonly Service = 'Service';
    public static readonly ByName = 'by_name';
    public static readonly PartialTier = 'partial_tier';
    public static readonly ByRatio = 'by_ratio';
    public static readonly ByCount = 'by_count';
    public static readonly SeekMark = 'IndexSeek(';
    public static readonly ScanMark = 'LabelScan(';
    public static readonly FilterMark = 'Filter';

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
        assert.ok(plan.includes(`${SeekHarness.SeekMark}${SeekHarness.ByName})`), plan);
        assert.deepEqual(await SeekHarness.Ids(indexed, text), ['a', 'c']);
    });

    test('where equality uses index and keeps the remaining filters', async () =>
    {
        const text = "MATCH (n:Service) WHERE n.name = 'checkout' AND n.tier = 'gold' RETURN n";
        const plan = await SeekHarness.Explain(indexed, text);
        assert.ok(plan.includes(SeekHarness.SeekMark), plan);
        assert.ok(plan.includes(SeekHarness.FilterMark), plan);
        assert.deepEqual(await SeekHarness.Ids(indexed, text), ['a']);
        assert.deepEqual(await SeekHarness.Ids(indexed, "MATCH (n:Service) WHERE 'ledger' = n.name RETURN n"), ['b']);
    });

    test('a lone where equality leaves no filter', async () =>
    {
        const plan = await SeekHarness.Explain(indexed, "MATCH (n:Service) WHERE n.name = 'ledger' RETURN n");
        assert.ok(plan.includes(SeekHarness.SeekMark) && !plan.includes(SeekHarness.FilterMark), plan);
    });

    test('parameter equality seeks with the run-time value', async () =>
    {
        const text = 'MATCH (n:Service) WHERE n.name = $x RETURN n';
        assert.ok((await SeekHarness.Explain(indexed, text)).includes(SeekHarness.SeekMark));
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
        assert.ok(!(await SeekHarness.Explain(indexed, "MATCH (n) WHERE n.name = 'x' RETURN n")).includes(SeekHarness.SeekMark));
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
        assert.ok((await SeekHarness.Explain(indexed, 'MATCH (n:Service {ratio: 2}) RETURN n')).includes(SeekHarness.SeekMark));
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

/** A source whose index answers are withdrawn at run time: IndexFor still names an index, SeekEqual returns undefined. */
class NoSeekSource extends ReaderSource
{
    public override SeekEqual(_label: string, _member: string, _value: CellValue): undefined
    {
        return undefined;
    }
}

/** Shapes beyond the flat Service: composite and hidden members, parent/child, aspects, DateTime. */
class ShapeHarness
{
    public static readonly Secret = 'secret';
    public static readonly LoneSurrogate = String.fromCharCode(0xD800);
    private static readonly Base = 'Base';
    private static readonly Child = 'Child';
    private static readonly Tagged = 'Tagged';
    private static readonly Event = 'Event';
    private static readonly Wire = 'Wire';

    private static Prop(name: string, type: ValueType): { Name: string; Kind: MemberKind.Property; Type: ValueType; Nullable: boolean }
    {
        return { Name: name, Kind: MemberKind.Property, Type: type, Nullable: true };
    }

    public static Open(): Promise<CypherFixture>
    {
        const F = CypherFixture;
        const P = ShapeHarness.Prop;
        const defs: IDefinitionDescription[] = [
            F.Aspect(ShapeHarness.Tagged, [P('tag', ValueType.String)]),
            F.Concept(ShapeHarness.Base, [P('name', ValueType.String), P(ShapeHarness.Secret, ValueType.String)], null, [ShapeHarness.Tagged]),
            F.Concept(ShapeHarness.Child, [], ShapeHarness.Base),
            F.Concept(ShapeHarness.Event, [P('at', ValueType.DateTime)]),
        ];
        const seed: ISeedNode[] = [
            F.Node('p1', ShapeHarness.Base, { name: 'x', secret: 's', tag: 't' }),
            F.Node('c1', ShapeHarness.Child, { name: 'x', secret: 's', tag: 't' }),
            F.Node('c2', ShapeHarness.Child, { name: 'y', secret: 's', tag: 'u' }),
            F.Node('e1', ShapeHarness.Event, { at: new DateTimeValue(1_000_000n, 'UTC') }),
        ];
        const indexes: IIndexDescription[] = [
            { Name: 'base_composite', On: ShapeHarness.Base, Members: ['name', ShapeHarness.Secret] },
            { Name: 'tagged_tag', On: ShapeHarness.Tagged, Members: ['tag'] },
            { Name: 'event_at', On: ShapeHarness.Event, Members: ['at'] },
        ];
        return F.Open(defs, seed, indexes);
    }

    public static Hiding(): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[ShapeHarness.Base, new Set([ShapeHarness.Secret])]]) });
    }

    public static async Run(fx: CypherFixture, text: string, make: (reader: GraphReader) => ReaderSource): Promise<string[]>
    {
        const model = new CypherParser(text).Parse();
        const reader = await fx.Engine.BeginRead(AccessScope.System);
        try
        {
            const rows: Binding[] = await CypherFixture.Collect(new LogicalPlanner(make(reader), new Map()).Plan(model));
            return rows.map(r => CypherFixture.Plain(r.Get('n')) as string).sort();
        }
        finally
        {
            reader.dispose();
        }
    }
}

describe('cypher index seek shapes', () =>
{
    let fx: CypherFixture;
    before(async () => { fx = await ShapeHarness.Open(); });
    after(async () => { await fx.dispose(); });

    test('composite index leading member seeks', async () =>
    {
        const text = "MATCH (n:Base {name: 'x'}) RETURN n";
        assert.ok((await fx.Read(async s => LogicalPlanner.Explain(s, text))).includes(SeekHarness.SeekMark));
        assert.deepEqual((await fx.Rows(text)).map(r => r.get('n')).sort(), ['c1', 'p1']);
    });

    test('a scope hiding a composite index member disables the index', async () =>
    {
        const text = "MATCH (n:Base {name: 'x'}) RETURN n";
        const scope = ShapeHarness.Hiding();
        const plan = await fx.Read(async s => LogicalPlanner.Explain(s, text), scope);
        assert.ok(plan.includes(SeekHarness.ScanMark) && !plan.includes(SeekHarness.SeekMark), plan);
        assert.deepEqual((await fx.Rows(text, scope)).map(r => r.get('n')).sort(), ['c1', 'p1']);
    });

    test('an index on the parent queried through the child excludes the parent instances', async () =>
    {
        const text = "MATCH (n:Child {name: 'x'}) RETURN n";
        assert.ok((await fx.Read(async s => LogicalPlanner.Explain(s, text))).includes(SeekHarness.SeekMark));
        assert.deepEqual((await fx.Rows(text)).map(r => r.get('n')), ['c1']);
    });

    test('aspect label seeks through the aspect index', async () =>
    {
        const text = "MATCH (n:Tagged {tag: 't'}) RETURN n";
        assert.ok((await fx.Read(async s => LogicalPlanner.Explain(s, text))).includes(SeekHarness.SeekMark));
        assert.deepEqual((await fx.Rows(text)).map(r => r.get('n')).sort(), ['c1', 'p1']);
    });

    test('lone surrogate parameter matches nothing, as the scan does', async () =>
    {
        const params = new Map([['x', new ScalarValue(ShapeHarness.LoneSurrogate)]]);
        const text = 'MATCH (n:Base) WHERE n.name = $x RETURN n';
        assert.deepEqual(await fx.Rows(text, AccessScope.System, params), []);
    });

    test('DateTime equality ignores the zone, as the scan does', async () =>
    {
        const zoned = new DateTimeValue(1_000_000n, 'Europe/Paris');
        const text = 'MATCH (n:Event) WHERE n.at = $t RETURN n';
        assert.ok((await fx.Read(async s => LogicalPlanner.Explain(s, text, new Map([['t', new ScalarValue(zoned)]])))).includes(SeekHarness.SeekMark));
        assert.deepEqual((await fx.Rows(text, AccessScope.System, new Map([['t', new ScalarValue(zoned)]]))).map(r => r.get('n')), ['e1']);
    });

    test('Explain renders the value as Cypher', async () =>
    {
        const plan = await fx.Read(async s => LogicalPlanner.Explain(s, "MATCH (n:Base {name: 'x'}) RETURN n"));
        assert.ok(plan.includes("n.name = 'x'"), plan);
        assert.ok((await fx.Read(async s => LogicalPlanner.Explain(s, 'MATCH (n:Base) WHERE n.name = $x RETURN n'))).includes('n.name = $x'));
    });

    test('IndexSeek falls back to a filtered scan when the source declines the seek', async () =>
    {
        const text = "MATCH (n:Child {name: 'x'}) RETURN n";
        const seeking = await ShapeHarness.Run(fx, text, r => new ReaderSource(r));
        const declined = await ShapeHarness.Run(fx, text, r => new NoSeekSource(r));
        assert.deepEqual(declined, seeking);
        assert.deepEqual(declined, ['c1']);
    });
});

// R87 (d): every string entering a query (parameters, literals, fluent values) is made well-formed (toWellFormed), so
// a lone surrogate is U+FFFD everywhere: the seek, the scan and grouping keys agree.
describe('lone surrogates are normalised on entry', () =>
{
    const Lone = String.fromCharCode(0xD800);
    const Replacement = '�';
    let indexed: EngineHarness;
    let plain: EngineHarness;
    before(async () =>
    {
        const seed = [CypherFixture.Node('w', SeekHarness.Service, { name: Replacement }), ...SeekHarness.Seed()];
        indexed = await EngineHarness.Open(SeekHarness.Definitions(), seed, undefined, SeekHarness.Indexes());
        plain = await EngineHarness.Open(SeekHarness.Definitions(), seed);
    });
    after(async () =>
    {
        await indexed.dispose();
        await plain.dispose();
    });

    test('seek and scan agree for a lone-surrogate parameter, literal and fluent value', async () =>
    {
        const byParam = 'MATCH (n:Service) WHERE n.name = $x RETURN n';
        const byLiteral = `MATCH (n:Service {name: '${Lone}'}) RETURN n`;
        const fluent = CypherQuery.Match(Pattern.Node('n').Label(SeekHarness.Service)).Where(Expr.Prop('n', 'name').Eq(Lone)).Return(Return.Node('n'));
        assert.ok(indexed.Cypher.Explain(byParam).includes(SeekHarness.SeekMark));
        assert.ok(indexed.Cypher.Explain(byLiteral).includes(SeekHarness.SeekMark));
        for (const h of [indexed, plain])
        {
            assert.deepEqual(EngineHarness.Col(await h.Execute(byParam, new Map([['x', Lone]]))), ['w']);
            assert.deepEqual(EngineHarness.Col(await h.Execute(byLiteral)), ['w']);
            assert.deepEqual(EngineHarness.Col(await h.Execute(fluent)), ['w']);
        }
    });

    test('count(DISTINCT) folds a lone surrogate with U+FFFD', async () =>
    {
        assert.deepEqual(EngineHarness.Col(await plain.Execute('UNWIND $xs AS x RETURN count(DISTINCT x) AS c', new Map([['xs', [Lone, Replacement]]]))), [1n]);
        assert.deepEqual(EngineHarness.Col(await plain.Execute(`UNWIND ['${Lone}', '${Replacement}'] AS x RETURN count(DISTINCT x) AS c`)), [1n]);
        assert.deepEqual(EngineHarness.Col(await plain.Execute('MATCH (n:Service) WHERE n.name = $x RETURN count(DISTINCT n.name) AS c', new Map([['x', Lone]]))), [1n]);
        assert.deepEqual(EngineHarness.Col(await plain.Execute('RETURN $x AS x', new Map([['x', `a${Lone}b`]]))), [`a${Replacement}b`]);
    });
});
