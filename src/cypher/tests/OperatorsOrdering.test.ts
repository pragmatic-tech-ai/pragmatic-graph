import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Sort } from '../operators/Sort.js';
import { Skip } from '../operators/Skip.js';
import { Limit } from '../operators/Limit.js';
import { Distinct } from '../operators/Distinct.js';
import type { IOperator } from '../operators/IOperator.js';
import { Binding } from '../Binding.js';
import { ScalarValue } from '../CypherValue.js';
import { SortItem } from '../CypherQueryModel.js';
import { VariableRef } from '../Expression.js';
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

    public static Of(col: string, vals: number[]): Rows
    {
        return new Rows(vals.map((v) => new Binding().With(col, new ScalarValue(v))));
    }

    public static async Values(op: IOperator): Promise<unknown[]>
    {
        return (await CypherFixture.Collect(op)).map((r) => (r.Get('x') as ScalarValue).Value);
    }
}

class MultiRows
{
    public static Make(pairs: number[][]): Binding[]
    {
        return pairs.map((p) => new Binding().With('x', new ScalarValue(p[0]!)).With('y', new ScalarValue(p[1]!)));
    }

    public static async Pairs(op: IOperator): Promise<number[][]>
    {
        return (await CypherFixture.Collect(op)).map((r) => [(r.Get('x') as ScalarValue).Value as number, (r.Get('y') as ScalarValue).Value as number]);
    }
}

describe('ordering operators', () =>
{
    test('Sort asc + desc', async () =>
    {
        const asc = new Sort(Rows.Of('x', [3, 1, 2]), [new SortItem(new VariableRef('x'), false)], new Map());
        assert.deepEqual(await Rows.Values(asc), [1, 2, 3]);
        const desc = new Sort(Rows.Of('x', [3, 1, 2]), [new SortItem(new VariableRef('x'), true)], new Map());
        assert.deepEqual(await Rows.Values(desc), [3, 2, 1]);
    });

    test('Skip + Limit window', async () =>
    {
        const op = new Limit(new Skip(Rows.Of('x', [0, 1, 2, 3, 4]), 1), 2);
        assert.deepEqual(await Rows.Values(op), [1, 2]);
    });

    test('Distinct dedups by column key', async () =>
    {
        const op = new Distinct(Rows.Of('x', [1, 1, 2, 2, 2, 3]), ['x']);
        assert.deepEqual(await Rows.Values(op), [1, 2, 3]);
    });

    test('Distinct keeps rows whose column keys differ only by the separator character', async () =>
    {
        const sep = String.fromCharCode(0);
        const row1 = new Binding().With('x', new ScalarValue('a' + sep + 'string:b')).With('y', new ScalarValue('c'));
        const row2 = new Binding().With('x', new ScalarValue('a')).With('y', new ScalarValue('b' + sep + 'string:c'));
        const out = await CypherFixture.Collect(new Distinct(new Rows([row1, row2]), ['x', 'y']));
        assert.equal(out.length, 2);
    });

    test('Skip(0) skips nothing; negative and NaN clamp to zero', async () =>
    {
        assert.deepEqual(await Rows.Values(new Skip(Rows.Of('x', [1, 2, 3]), 0)), [1, 2, 3]);
        assert.deepEqual(await Rows.Values(new Skip(Rows.Of('x', [1, 2, 3]), -5)), [1, 2, 3]);
        assert.deepEqual(await Rows.Values(new Skip(Rows.Of('x', [1, 2, 3]), Number.NaN)), [1, 2, 3]);
        assert.deepEqual(await Rows.Values(new Skip(Rows.Of('x', [1, 2, 3]), 1.9)), [2, 3]);
    });

    test('multi-key sort: later key breaks ties, per-key direction', async () =>
    {
        const src = new Rows(MultiRows.Make([[1, 2], [2, 1], [1, 1], [2, 2]]));
        const mixed = new Sort(src, [new SortItem(new VariableRef('x'), false), new SortItem(new VariableRef('y'), true)], new Map());
        assert.deepEqual(await MultiRows.Pairs(mixed), [[1, 2], [1, 1], [2, 2], [2, 1]]);
    });

    test('sort is stable: tied keys keep input order', async () =>
    {
        const src = new Rows(MultiRows.Make([[1, 10], [0, 11], [1, 12], [0, 13], [1, 14]]));
        const out = new Sort(src, [new SortItem(new VariableRef('x'), false)], new Map());
        assert.deepEqual(await MultiRows.Pairs(out), [[0, 11], [0, 13], [1, 10], [1, 12], [1, 14]]);
        const desc = new Sort(new Rows(MultiRows.Make([[1, 10], [0, 11], [1, 12], [0, 13], [1, 14]])), [new SortItem(new VariableRef('x'), true)], new Map());
        assert.deepEqual(await MultiRows.Pairs(desc), [[1, 10], [1, 12], [1, 14], [0, 11], [0, 13]]);
    });

    test('Limit(0) yields nothing; a large limit yields everything', async () =>
    {
        assert.deepEqual(await Rows.Values(new Limit(Rows.Of('x', [1, 2, 3]), 0)), []);
        assert.deepEqual(await Rows.Values(new Limit(Rows.Of('x', [1, 2, 3]), 10)), [1, 2, 3]);
    });

    test('Skip beyond the end yields nothing', async () =>
    {
        assert.deepEqual(await Rows.Values(new Skip(Rows.Of('x', [1, 2, 3]), 3)), []);
        assert.deepEqual(await Rows.Values(new Skip(Rows.Of('x', [1, 2, 3]), 99)), []);
    });

    test('multi-column Distinct dedups on the column tuple', async () =>
    {
        const src = new Rows(MultiRows.Make([[1, 1], [1, 2], [1, 1], [2, 1], [2, 1], [1, 2]]));
        assert.deepEqual(await MultiRows.Pairs(new Distinct(src, ['x', 'y'])), [[1, 1], [1, 2], [2, 1]]);
        assert.deepEqual(await MultiRows.Pairs(new Distinct(new Rows(MultiRows.Make([[1, 1], [1, 2], [2, 3]])), ['x'])), [[1, 1], [2, 3]]);
    });
});
