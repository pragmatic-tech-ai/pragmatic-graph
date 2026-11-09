import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Aggregate } from '../operators/Aggregate.js';
import type { AggregateItem } from '../operators/Aggregate.js';
import type { IOperator } from '../operators/IOperator.js';
import { Binding } from '../Binding.js';
import { ScalarValue } from '../CypherValue.js';
import { ReturnItem } from '../CypherQueryModel.js';
import { VariableRef, FunctionCall } from '../Expression.js';
import { ListValue } from '../StructuredValues.js';
import { CypherFixture } from './CypherFixture.js';

class Rows implements IOperator
{
    constructor(private readonly rows: Binding[])
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        yield* this.rows;
    }

    public static Row(kind: string, x: number): Binding
    {
        return new Binding().With('k', new ScalarValue(kind)).With('x', new ScalarValue(x));
    }
}

class Fixtures
{
    public static readonly K = 'k';
    public static readonly X = 'x';
    public static readonly Count = 'c';
    public static readonly Xs = 'xs';

    public static Grouping(): ReturnItem[]
    {
        return [new ReturnItem(new VariableRef(Fixtures.K), Fixtures.K)];
    }

    public static CountStar(): AggregateItem
    {
        return { Column: Fixtures.Count, Call: new FunctionCall('count', [], false, true) };
    }

    public static Collect(distinct: boolean): AggregateItem
    {
        return { Column: Fixtures.Xs, Call: new FunctionCall('collect', [new VariableRef(Fixtures.X)], distinct, false) };
    }

    public static Run(op: IOperator): Promise<Binding[]>
    {
        return CypherFixture.Collect(op);
    }
}

describe('Aggregate operator', () =>
{
    test('group by k, count(*) and collect(x)', async () =>
    {
        const src = new Rows([Rows.Row('a', 1), Rows.Row('a', 2), Rows.Row('b', 3)]);
        const out = await Fixtures.Run(new Aggregate(src, Fixtures.Grouping(), [Fixtures.CountStar(), Fixtures.Collect(false)], new Map()));
        assert.equal(out.length, 2);
        assert.equal((out[0]!.Get('k') as ScalarValue).Value, 'a');
        const byK = new Map(out.map((r) => [(r.Get('k') as ScalarValue).Value, r]));
        // count is Int64 on the engine (R81 f): TODL asserted the JS numbers 2 and 1.
        assert.equal((byK.get('a')!.Get('c') as ScalarValue).Value, 2n);
        assert.equal((byK.get('b')!.Get('c') as ScalarValue).Value, 1n);
        assert.ok(byK.get('a')!.Get('xs') instanceof ListValue);
    });

    test('DISTINCT aggregate dedups within a group', async () =>
    {
        const src = new Rows([Rows.Row('a', 1), Rows.Row('a', 1), Rows.Row('a', 2), Rows.Row('b', 1)]);
        const out = await Fixtures.Run(new Aggregate(src, Fixtures.Grouping(), [Fixtures.Collect(true)], new Map()));
        const a = out[0]!.Get('xs') as ListValue;
        const b = out[1]!.Get('xs') as ListValue;
        assert.equal(a.Items.length, 2);
        assert.equal(b.Items.length, 1);
    });

    test('group keys are collision-safe', async () =>
    {
        const two = new ReturnItem(new VariableRef('x'), 'x');
        const src = new Rows([
            new Binding().With('k', new ScalarValue('a|b')).With('x', new ScalarValue('c')),
            new Binding().With('k', new ScalarValue('a')).With('x', new ScalarValue('b|c')),
        ]);
        const out = await Fixtures.Run(new Aggregate(src, [...Fixtures.Grouping(), two], [Fixtures.CountStar()], new Map()));
        assert.equal(out.length, 2);
    });

    test('empty input without grouping yields one row of empty results', async () =>
    {
        const out = await Fixtures.Run(new Aggregate(new Rows([]), [], [Fixtures.CountStar()], new Map()));
        assert.equal(out.length, 1);
        assert.equal((out[0]!.Get('c') as ScalarValue).Value, 0n);
    });

    test('empty input with grouping yields no rows', async () =>
    {
        const out = await Fixtures.Run(new Aggregate(new Rows([]), Fixtures.Grouping(), [Fixtures.CountStar()], new Map()));
        assert.equal(out.length, 0);
    });

    test('groups emit in first-seen order, not sorted order', async () =>
    {
        const src = new Rows([Rows.Row('z', 1), Rows.Row('a', 2), Rows.Row('m', 3), Rows.Row('a', 4), Rows.Row('z', 5)]);
        const out = await Fixtures.Run(new Aggregate(src, Fixtures.Grouping(), [Fixtures.CountStar(), Fixtures.Collect(false)], new Map()));
        assert.deepEqual(out.map((r) => (r.Get('k') as ScalarValue).Value), ['z', 'a', 'm']);
        assert.deepEqual(out.map((r) => (r.Get('c') as ScalarValue).Value), [2n, 2n, 1n]);
        const xs = (r: Binding) => (r.Get('xs') as ListValue).Items.map((i) => (i as ScalarValue).Value);
        assert.deepEqual(xs(out[0]!), [1, 5]);
        assert.deepEqual(xs(out[1]!), [2, 4]);
        assert.deepEqual(xs(out[2]!), [3]);
    });
});
