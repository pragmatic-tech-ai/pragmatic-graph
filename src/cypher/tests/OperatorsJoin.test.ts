import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CartesianProduct } from '../operators/CartesianProduct.js';
import { SingleRow } from '../operators/SingleRow.js';
import type { IOperator } from '../operators/IOperator.js';
import { ListValue } from '../StructuredValues.js';
import { Binding } from '../Binding.js';
import { ScalarValue } from '../CypherValue.js';
import { CypherFixture } from './CypherFixture.js';

class FixedRows implements IOperator
{
    constructor(private readonly rows: Binding[])
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        yield* this.rows;
    }
}

class JoinFixture
{
    public static Row(entries: Record<string, number>): Binding
    {
        let b = new Binding();
        for (const key of Object.keys(entries))
        {
            b = b.With(key, new ScalarValue(entries[key]!));
        }
        return b;
    }

    public static Num(row: Binding, variable: string): number
    {
        return (row.Get(variable) as ScalarValue).Value as number;
    }

    public static Run(op: IOperator): Promise<Binding[]>
    {
        return CypherFixture.Collect(op);
    }
}

describe('CartesianProduct', () =>
{
    test('disjoint variables yield the cartesian product', async () =>
    {
        const left = new FixedRows([JoinFixture.Row({ a: 1 }), JoinFixture.Row({ a: 2 })]);
        const right = new FixedRows([JoinFixture.Row({ b: 10 }), JoinFixture.Row({ b: 20 })]);
        const out = (await JoinFixture.Run(new CartesianProduct(left, right))).map((r) => [JoinFixture.Num(r, 'a'), JoinFixture.Num(r, 'b')]);
        assert.deepEqual(out, [[1, 10], [1, 20], [2, 10], [2, 20]]);
    });

    test('shared variable joins and drops conflicting pairs', async () =>
    {
        const left = new FixedRows([JoinFixture.Row({ a: 1 }), JoinFixture.Row({ a: 2 })]);
        const right = new FixedRows([JoinFixture.Row({ a: 1, b: 9 })]);
        const out = await JoinFixture.Run(new CartesianProduct(left, right));
        assert.equal(out.length, 1);
        assert.equal(JoinFixture.Num(out[0]!, 'a'), 1);
        assert.equal(JoinFixture.Num(out[0]!, 'b'), 9);
    });

    test('multi-row cross product preserves input bindings on both sides', async () =>
    {
        const left = new FixedRows([JoinFixture.Row({ a: 1, p: 7 }), JoinFixture.Row({ a: 2, p: 8 }), JoinFixture.Row({ a: 3, p: 9 })]);
        const right = new FixedRows([JoinFixture.Row({ b: 10, q: 5 }), JoinFixture.Row({ b: 20, q: 6 })]);
        const out = await JoinFixture.Run(new CartesianProduct(left, right));
        assert.equal(out.length, 6);
        assert.deepEqual(out.map((r) => [JoinFixture.Num(r, 'a'), JoinFixture.Num(r, 'p'), JoinFixture.Num(r, 'b'), JoinFixture.Num(r, 'q')]), [
            [1, 7, 10, 5], [1, 7, 20, 6], [2, 8, 10, 5], [2, 8, 20, 6], [3, 9, 10, 5], [3, 9, 20, 6],
        ]);
    });

    test('an empty side yields no rows', async () =>
    {
        const some = new FixedRows([JoinFixture.Row({ a: 1 })]);
        assert.equal((await JoinFixture.Run(new CartesianProduct(some, new FixedRows([])))).length, 0);
        assert.equal((await JoinFixture.Run(new CartesianProduct(new FixedRows([]), some))).length, 0);
    });

    test('SingleRow joined with a source returns that source unchanged', async () =>
    {
        assert.equal((await JoinFixture.Run(new SingleRow())).length, 1);
        const right = new FixedRows([JoinFixture.Row({ b: 1 }), JoinFixture.Row({ b: 2 })]);
        const out = await JoinFixture.Run(new CartesianProduct(new SingleRow(), right));
        assert.deepEqual(out.map((r) => JoinFixture.Num(r, 'b')), [1, 2]);
    });

    test('shared non-scalar variable joins by structural identity', async () =>
    {
        const list = (...v: number[]) => new ListValue(v.map((x) => new ScalarValue(x)));
        const left = new FixedRows([new Binding().With('l', list(1, 2)).With('a', new ScalarValue(1)), new Binding().With('l', list(3)).With('a', new ScalarValue(2))]);
        const right = new FixedRows([new Binding().With('l', list(1, 2)).With('b', new ScalarValue(9)), new Binding().With('l', list(1)).With('b', new ScalarValue(8))]);
        const out = await JoinFixture.Run(new CartesianProduct(left, right));
        assert.equal(out.length, 1);
        assert.equal(JoinFixture.Num(out[0]!, 'a'), 1);
        assert.equal(JoinFixture.Num(out[0]!, 'b'), 9);
    });
});
