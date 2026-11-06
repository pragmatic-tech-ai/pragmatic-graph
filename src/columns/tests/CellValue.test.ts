import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DateTimeValue, DateValue, DurationValue } from '../CellValue.js';

describe('temporal cell values', () =>
{
    it('are frozen at runtime: fields cannot be reassigned or added', () =>
    {
        const values = [new DateValue(3), new DateTimeValue(5n, 'UTC'), new DurationValue(1, 2, 3n)];
        for (const v of values)
        {
            assert.ok(Object.isFrozen(v));
            assert.throws(() => { (v as unknown as Record<string, unknown>)['Days'] = 9; }, TypeError);
            assert.throws(() => { (v as unknown as Record<string, unknown>)['Extra'] = 1; }, TypeError);
        }
        assert.equal((values[0] as DateValue).Days, 3);
        assert.ok((values[2] as DurationValue).Equals(new DurationValue(1, 2, 3n)));
    });
});
