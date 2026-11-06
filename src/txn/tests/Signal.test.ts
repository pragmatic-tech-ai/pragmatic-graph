import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Signal } from '../Signal.js';

describe('Signal', () =>
{
    it('delivers to every subscriber in subscription order until disposed', () =>
    {
        const s = new Signal<number>();
        const seen: string[] = [];
        const a = s.Subscribe(v => seen.push('a' + v));
        s.Subscribe(v => seen.push('b' + v));
        s.Raise(1);
        a.dispose();
        a.dispose();
        s.Raise(2);
        assert.deepEqual(seen, ['a1', 'b1', 'b2']);
    });

    it('runs every handler even when one throws, then throws an AggregateError', () =>
    {
        const s = new Signal<number>();
        const seen: number[] = [];
        s.Subscribe(() =>
        {
            throw new Error('boom');
        });
        s.Subscribe(v => seen.push(v));
        assert.throws(() => s.Raise(5), AggregateError);
        assert.deepEqual(seen, [5]);
    });

    it('a handler subscribing or disposing during Raise does not affect the current delivery', () =>
    {
        const s = new Signal<number>();
        const seen: string[] = [];
        let late: { dispose(): void } | undefined;
        const first = s.Subscribe(v =>
        {
            seen.push('first' + v);
            late ??= s.Subscribe(w => seen.push('late' + w));
            first.dispose();
        });
        s.Raise(1);
        s.Raise(2);
        assert.deepEqual(seen, ['first1', 'late2']);
        late?.dispose();
    });

    it('dispose drops every handler, is idempotent, and later Subscribe throws', () =>
    {
        const s = new Signal<number>();
        const seen: number[] = [];
        s.Subscribe(v => seen.push(v));
        s.dispose();
        s.dispose();
        s.Raise(1);
        assert.equal(seen.length, 0);
        assert.throws(() => s.Subscribe(v => seen.push(v)));
    });
});
