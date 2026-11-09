import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Unwind } from '../operators/Unwind.js';
import { SingleRow } from '../operators/SingleRow.js';
import { ScalarValue, NullValue } from '../CypherValue.js';
import { ListValue } from '../StructuredValues.js';
import { ValueLiteral } from '../Expression.js';
import { CypherFixture } from './CypherFixture.js';

class UnwindFixture
{
    public static readonly Variable = 'x';

    public static async Run(value: ScalarValue | ListValue | NullValue): Promise<number[]>
    {
        const op = new Unwind(new SingleRow(), new ValueLiteral(value), UnwindFixture.Variable, new Map());
        return (await CypherFixture.Collect(op)).map((r) => (r.Get(UnwindFixture.Variable) as ScalarValue).Value as number);
    }
}

describe('Unwind', () =>
{
    test('list yields one row per element', async () =>
    {
        assert.deepEqual(await UnwindFixture.Run(new ListValue([new ScalarValue(1), new ScalarValue(2)])), [1, 2]);
    });

    test('null yields zero rows', async () =>
    {
        assert.equal((await UnwindFixture.Run(NullValue.Instance)).length, 0);
    });

    test('scalar yields one row', async () =>
    {
        assert.deepEqual(await UnwindFixture.Run(new ScalarValue(7)), [7]);
    });
});
