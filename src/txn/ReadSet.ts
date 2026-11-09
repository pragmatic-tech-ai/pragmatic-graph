import { TupleCodec } from '../format/TupleCodec.js';
import type { IKeyRange } from '../kv/KeyValue.js';
import type { Keyspace } from '../kv/Keyspace.js';
import { ConflictKeys } from './ConflictKeys.js';

/**
 * The keys and ranges one keyspace's reads covered. Ranges are kept sorted by Start, disjoint and
 * coalesced (overlapping or touching ranges merge; ruling F7), so a key is checked by binary search.
 */
class SpaceReads
{
    public readonly Keys = new Set<string>();
    public readonly Ranges: IKeyRange[] = [];

    public Clone(): SpaceReads
    {
        const copy = new SpaceReads();
        for (const k of this.Keys)
        {
            copy.Keys.add(k);
        }
        copy.Ranges.push(...this.Ranges);
        return copy;
    }

    /**
     * Inserts the range, merging it with every range it overlaps or touches. Ranges added in key order cost O(log n).
     */
    public AddRange(range: IKeyRange): void
    {
        if (TupleCodec.Compare(range.Start, range.End) >= 0)
        {
            return;
        }
        let start = range.Start;
        let end = range.End;
        // First range whose End >= start: everything before it ends strictly before the new range.
        let lo = this.FirstEndingAtOrAfter(start);
        let hi = lo;
        while (hi < this.Ranges.length && TupleCodec.Compare((this.Ranges[hi] as IKeyRange).Start, end) <= 0)
        {
            const r = this.Ranges[hi] as IKeyRange;
            if (TupleCodec.Compare(r.Start, start) < 0)
            {
                start = r.Start;
            }
            if (TupleCodec.Compare(r.End, end) > 0)
            {
                end = r.End;
            }
            hi++;
        }
        this.Ranges.splice(lo, hi - lo, { Start: start, End: end });
    }

    /** True when the key lies inside one of the ranges (Start inclusive, End exclusive). */
    public InRange(key: Uint8Array): boolean
    {
        // Last range with Start <= key.
        let lo = 0;
        let hi = this.Ranges.length;
        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;
            if (TupleCodec.Compare((this.Ranges[mid] as IKeyRange).Start, key) <= 0)
            {
                lo = mid + 1;
            }
            else
            {
                hi = mid;
            }
        }
        const candidate = this.Ranges[lo - 1];
        return candidate !== undefined && TupleCodec.Compare(key, candidate.End) < 0;
    }

    private FirstEndingAtOrAfter(key: Uint8Array): number
    {
        let lo = 0;
        let hi = this.Ranges.length;
        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;
            if (TupleCodec.Compare((this.Ranges[mid] as IKeyRange).End, key) < 0)
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

/**
 * What a transaction read, as logical conflict keys and half-open key ranges (see ConflictKeys).
 * Filled by readers; the committer checks it against write sets committed after the reader's snapshot.
 * Keys and ranges are copied on add, so later mutation of the caller's buffers has no effect. A write key
 * is checked in O(1) against the keys and O(log ranges) against the sorted, coalesced ranges.
 */
export class ReadSet
{
    private readonly spaces = new Map<Keyspace, SpaceReads>();

    public get IsEmpty(): boolean
    {
        return this.spaces.size === 0;
    }

    /** Diagnostics: distinct keys recorded, over all keyspaces. */
    public get KeyCount(): number
    {
        let n = 0;
        for (const reads of this.spaces.values())
        {
            n += reads.Keys.size;
        }
        return n;
    }

    /** Diagnostics: disjoint ranges held after coalescing, over all keyspaces. */
    public get RangeCount(): number
    {
        let n = 0;
        for (const reads of this.spaces.values())
        {
            n += reads.Ranges.length;
        }
        return n;
    }

    public AddKey(space: Keyspace, key: Uint8Array): void
    {
        this.For(space).Keys.add(ConflictKeys.Hex(key));
    }

    public AddRange(space: Keyspace, range: IKeyRange): void
    {
        this.For(space).AddRange({ Start: range.Start.slice(), End: range.End.slice() });
    }

    /** True when the key was read directly or lies inside a read range (Start inclusive, End exclusive). */
    public Intersects(space: Keyspace, key: Uint8Array): boolean
    {
        return this.IntersectsEncoded(space, key, ConflictKeys.Hex(key));
    }

    /** Intersects for a caller that already holds the key's hex (`hex` must equal ConflictKeys.Hex(key)). */
    public IntersectsEncoded(space: Keyspace, key: Uint8Array, hex: string): boolean
    {
        const reads = this.spaces.get(space);
        if (reads === undefined)
        {
            return false;
        }
        return reads.Keys.has(hex) || reads.InRange(key);
    }

    /** Adds every key and range of `other` (ranges are immutable once stored, so they are shared). */
    public AddAll(other: ReadSet): void
    {
        for (const [space, reads] of other.spaces)
        {
            const mine = this.For(space);
            for (const k of reads.Keys)
            {
                mine.Keys.add(k);
            }
            for (const r of reads.Ranges)
            {
                mine.AddRange(r);
            }
        }
    }

    public Clone(): ReadSet
    {
        const copy = new ReadSet();
        for (const [space, reads] of this.spaces)
        {
            copy.spaces.set(space, reads.Clone());
        }
        return copy;
    }

    private For(space: Keyspace): SpaceReads
    {
        let reads = this.spaces.get(space);
        if (reads === undefined)
        {
            reads = new SpaceReads();
            this.spaces.set(space, reads);
        }
        return reads;
    }
}
