import type { Keyspace } from '../kv/Keyspace.js';
import { ConflictKeys } from './ConflictKeys.js';
import type { ReadSet } from './ReadSet.js';

/** The distinct logical conflict keys one committed batch (or group prefix) wrote. */
export class WriteKeySet
{
    private static readonly Separator = ':';

    private readonly seen = new Set<string>();
    private readonly entries: Array<readonly [Keyspace, Uint8Array, string]> = [];

    public get Size(): number
    {
        return this.entries.length;
    }

    public Add(space: Keyspace, key: Uint8Array): void
    {
        this.AddEncoded(space, key, ConflictKeys.Hex(key));
    }

    public AddAll(other: WriteKeySet): void
    {
        for (const [space, key, hex] of other.entries)
        {
            this.AddEncoded(space, key, hex);
        }
    }

    /** Adds every written key to `reads` as an exact key, except keys of the `skip` keyspaces. */
    public AddTo(reads: ReadSet, skip?: ReadonlySet<Keyspace>): void
    {
        for (const [space, key] of this.entries)
        {
            if (skip?.has(space) !== true)
            {
                reads.AddKey(space, key);
            }
        }
    }

    /** True when any written key lies in the read set (exact key or inside a read range). */
    public Intersects(reads: ReadSet): boolean
    {
        if (reads.IsEmpty)
        {
            return false;
        }
        for (const [space, key, hex] of this.entries)
        {
            if (reads.IntersectsEncoded(space, key, hex))
            {
                return true;
            }
        }
        return false;
    }

    private AddEncoded(space: Keyspace, key: Uint8Array, hex: string): void
    {
        const id = space + WriteKeySet.Separator + hex;
        if (!this.seen.has(id))
        {
            this.seen.add(id);
            this.entries.push([space, key, hex]);
        }
    }
}
