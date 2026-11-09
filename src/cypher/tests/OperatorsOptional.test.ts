import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { IOptionalPlan } from '../operators/OptionalApply.js';
import { OptionalApply } from '../operators/OptionalApply.js';
import type { IOperator } from '../operators/IOperator.js';
import { Binding } from '../Binding.js';
import { ScalarValue, NullValue } from '../CypherValue.js';
import { CypherFixture } from './CypherFixture.js';

class RowSource implements IOperator
{
    constructor(private readonly rows: Binding[])
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        yield* this.rows;
    }
}

class OptionalFixture implements IOptionalPlan
{
    public static readonly A = 'a';
    public static readonly B = 'b';

    public Build(row: Binding): IOperator
    {
        const a = (row.Get(OptionalFixture.A) as ScalarValue).Value;
        return a === 1 ? new RowSource([row.With(OptionalFixture.B, new ScalarValue(10))]) : new RowSource([]);
    }
}

describe('OptionalApply', () =>
{
    test('passes matches; nulls the optional vars when none', async () =>
    {
        const inputs = new RowSource([
            new Binding().With(OptionalFixture.A, new ScalarValue(1)),
            new Binding().With(OptionalFixture.A, new ScalarValue(2)),
        ]);
        const out = await CypherFixture.Collect(new OptionalApply(inputs, new OptionalFixture(), [OptionalFixture.B]));
        assert.equal(out.length, 2);
        assert.equal((out[0]!.Get(OptionalFixture.B) as ScalarValue).Value, 10);
        assert.ok(out[1]!.Get(OptionalFixture.B) instanceof NullValue);
        assert.equal((out[1]!.Get(OptionalFixture.A) as ScalarValue).Value, 2);
    });

    test('every match row is emitted; no padding when any row matched', async () =>
    {
        const plan: IOptionalPlan = {
            Build: (row) => new RowSource([row.With('b', new ScalarValue(1)), row.With('b', new ScalarValue(2)), row.With('b', new ScalarValue(3))]),
        };
        const inputs = new RowSource([new Binding().With('a', new ScalarValue(1)), new Binding().With('a', new ScalarValue(2))]);
        const out = await CypherFixture.Collect(new OptionalApply(inputs, plan, ['b']));
        assert.deepEqual(out.map((r) => [(r.Get('a') as ScalarValue).Value, (r.Get('b') as ScalarValue).Value]), [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]]);
    });

    test('all optional variables are nulled when nothing matches; input bindings preserved', async () =>
    {
        const plan: IOptionalPlan = { Build: () => new RowSource([]) };
        const inputs = new RowSource([new Binding().With('a', new ScalarValue(5))]);
        const out = await CypherFixture.Collect(new OptionalApply(inputs, plan, ['b', 'c', 'd']));
        assert.equal(out.length, 1);
        assert.equal((out[0]!.Get('a') as ScalarValue).Value, 5);
        for (const v of ['b', 'c', 'd'])
        {
            assert.ok(out[0]!.Get(v) instanceof NullValue, v);
        }
    });
});
