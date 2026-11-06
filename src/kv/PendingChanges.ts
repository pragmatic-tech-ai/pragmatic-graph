import { TupleCodec } from '../format/TupleCodec.js';
import type { IKeyRange, ScanCounter } from './KeyValue.js';

/** One staged change of a write transaction; a null value is a delete. */
export interface IPendingChange
{
    readonly Key: Uint8Array;
    readonly Value: Uint8Array | null;
}

/**
 * A write transaction's staged changes in one keyspace, kept in key order (binary-searched inserts)
 * so a scan can merge them lazily with the stored entries instead of filtering and sorting them all.
 */
export class PendingChanges
{
    private readonly sorted: IPendingChange[] = [];

    public get Size(): number
    {
        return this.sorted.length;
    }

    /** Stages the change; `key` and `value` must already be private copies. A later change to the same key replaces it. */
    public Set(key: Uint8Array, value: Uint8Array | null): void
    {
        const at = this.LowerBound(key);
        const change = { Key: key, Value: value };
        const hit = this.sorted[at];
        if (hit !== undefined && TupleCodec.Compare(hit.Key, key) === 0)
        {
            this.sorted[at] = change;
        }
        else
        {
            this.sorted.splice(at, 0, change);
        }
    }

    public Get(key: Uint8Array): IPendingChange | undefined
    {
        const hit = this.sorted[this.LowerBound(key)];
        return hit !== undefined && TupleCodec.Compare(hit.Key, key) === 0 ? hit : undefined;
    }

    /** Every change, in key order. */
    public Values(): readonly IPendingChange[]
    {
        return this.sorted;
    }

    /** Changes with Start <= key < End, in key order, produced lazily from the binary-searched start. */
    public *InRange(range: IKeyRange): Iterable<IPendingChange>
    {
        for (let i = this.LowerBound(range.Start); i < this.sorted.length; i++)
        {
            const change = this.sorted[i] as IPendingChange;
            if (TupleCodec.Compare(change.Key, range.End) >= 0)
            {
                return;
            }
            yield change;
        }
    }

    /**
     * Lazily merges stored entries with staged changes (both in key order and restricted to one range):
     * a change replaces or (null value) hides the stored entry with the same key. Stops pulling from
     * either side as soon as `limit` entries were produced. Yields the source buffers uncopied; every
     * entry pulled from either side is counted.
     */
    public static *Merge(
        base: Iterable<readonly [Uint8Array, Uint8Array]>,
        changes: Iterable<IPendingChange>,
        counter: ScanCounter,
        limit?: number,
    ): Iterable<readonly [Uint8Array, Uint8Array]>
    {
        const max = limit ?? Number.POSITIVE_INFINITY;
        if (max <= 0)
        {
            return;
        }
        const stored = base[Symbol.iterator]();
        const staged = changes[Symbol.iterator]();
        try
        {
            let produced = 0;
            let b = PendingChanges.Pull(stored, counter);
            let c = PendingChanges.Pull(staged, counter);
            while (b !== undefined || c !== undefined)
            {
                const order = b === undefined ? 1 : c === undefined ? -1 : TupleCodec.Compare(b[0], c.Key);
                if (order < 0)
                {
                    yield b as readonly [Uint8Array, Uint8Array];
                    produced++;
                    if (produced >= max)
                    {
                        return;
                    }
                    b = PendingChanges.Pull(stored, counter);
                    continue;
                }
                const change = c as IPendingChange;
                if (order === 0)
                {
                    b = undefined;
                }
                if (change.Value !== null)
                {
                    yield [change.Key, change.Value];
                    produced++;
                    if (produced >= max)
                    {
                        return;
                    }
                }
                if (order === 0)
                {
                    b = PendingChanges.Pull(stored, counter);
                }
                c = PendingChanges.Pull(staged, counter);
            }
        }
        finally
        {
            stored.return?.();
            staged.return?.();
        }
    }

    private static Pull<T>(iterator: Iterator<T>, counter: ScanCounter): T | undefined
    {
        const next = iterator.next();
        if (next.done === true)
        {
            return undefined;
        }
        counter.Count++;
        return next.value;
    }

    private LowerBound(key: Uint8Array): number
    {
        let lo = 0;
        let hi = this.sorted.length;
        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;
            if (TupleCodec.Compare((this.sorted[mid] as IPendingChange).Key, key) < 0)
            {
                lo = mid + 1;
            }
            else
            {
                hi = mid;
            }
        }
        return lo;
    }
}
