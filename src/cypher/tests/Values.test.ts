import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ScalarValue } from '../CypherValue.js';
import { Binding } from '../Binding.js';

describe('cypher values + binding', () =>
{
    test('Binding.With is immutable and overlays', () =>
    {
        const a = new Binding().With('x', new ScalarValue(1));
        const b = a.With('y', new ScalarValue(2));
        assert.equal(a.Get('y'), undefined);
        assert.equal((b.Get('x') as ScalarValue).Value, 1);
        assert.equal((b.Get('y') as ScalarValue).Value, 2);
    });
});
