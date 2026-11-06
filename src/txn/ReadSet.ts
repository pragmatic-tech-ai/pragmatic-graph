import { TupleCodec } from '../format/TupleCodec.js';
import type { IKeyRange } from '../kv/KeyValue.js';
import type { Keyspace } from '../kv/Keyspace.js';
import { ConflictKeys } from './ConflictKeys.js';

/** The keys and ranges one keyspace's reads covered. */
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
}

/**
 * What a transaction read, as logical conflict keys and half-open key ranges (see ConflictKeys).
 * Filled by readers; the committer checks it against write sets committed after the reader's snapshot.
 * Keys and ranges are copied on add, so later mutation of the caller's buffers has no effect.
 */
export class ReadSet
{
    private readonly spaces = new Map<Keyspace, SpaceReads>();

    public get IsEmpty(): boolean
    {
        return this.spaces.size === 0;
    }

    public AddKey(space: Keyspace, key: Uint8Array): void
    {
        this.For(space).Keys.add(ConflictKeys.Hex(key));
    }

    public AddRange(space: Keyspace, range: IKeyRange): void
    {
        this.For(space).Ranges.push({ Start: range.Start.slice(), End: range.End.slice() });
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
        if (reads.Keys.has(hex))
        {
            return true;
        }
        for (const r of reads.Ranges)
        {
            if (TupleCodec.Compare(r.Start, key) <= 0 && TupleCodec.Compare(key, r.End) < 0)
            {
                return true;
            }
        }
        return false;
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
