import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ScalarValue, NullValue } from '../CypherValue.js';
import { ListValue, MapValue, RelValue, PathValue } from '../StructuredValues.js';

describe('structured values', () =>
{
    test('ListValue GroupKey', () =>
    {
        const l = new ListValue([new ScalarValue(1), new ScalarValue('x')]);
        assert.equal(l.GroupKey(), new ListValue([new ScalarValue(1), new ScalarValue('x')]).GroupKey());
        assert.notEqual(l.GroupKey(), new ListValue([new ScalarValue(1)]).GroupKey());
    });

    test('MapValue Get', () =>
    {
        const m = new MapValue(new Map<string, ScalarValue | NullValue>([['a', new ScalarValue(1)], ['b', NullValue.Instance]]));
        assert.equal((m.Get('a') as ScalarValue).Value, 1);
    });

    test('GroupKey is collision-safe for separator characters', () =>
    {
        assert.notEqual(
            new ListValue([new ScalarValue('a,string:b')]).GroupKey(),
            new ListValue([new ScalarValue('a'), new ScalarValue('b')]).GroupKey());
        assert.notEqual(new RelValue('a:b', 't', 'c').GroupKey(), new RelValue('a', 'b:t', 'c').GroupKey());
        assert.notEqual(
            new MapValue(new Map([['a', new ScalarValue('x,"b"=string:y')]])).GroupKey(),
            new MapValue(new Map([['a', new ScalarValue('x')], ['b', new ScalarValue('y')]])).GroupKey());
        assert.notEqual(
            new PathValue([], [new RelValue('a|b', 't', 'c')]).GroupKey(),
            new PathValue([], [new RelValue('a', 't', 'c'), new RelValue('b', 't', 'c')]).GroupKey());
        assert.equal(new RelValue('a', 't', 'b').GroupKey(), new RelValue('a', 't', 'b').GroupKey());
        assert.equal(
            new MapValue(new Map([['a', new ScalarValue(1)], ['b', new ScalarValue(2)]])).GroupKey(),
            new MapValue(new Map([['b', new ScalarValue(2)], ['a', new ScalarValue(1)]])).GroupKey());
        assert.equal(new PathValue([], [new RelValue('a', 't', 'b')]).GroupKey(), new PathValue([], [new RelValue('a', 't', 'b')]).GroupKey());
    });

    test('RelValue + PathValue', () =>
    {
        const rel = new RelValue('a', 'calls', 'b');
        // PathValue length uses rels count (node stand-ins built in integration tests)
        const p = new PathValue([], [rel]); // shape-only; real nodes exercised in integration
        assert.equal(p.Length(), 1);
    });
});
