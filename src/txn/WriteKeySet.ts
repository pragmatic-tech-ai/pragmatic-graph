import type { Keyspace } from '../kv/Keyspace.js';
import { ConflictKeys } from './ConflictKeys.js';
import type { ReadSet } from './ReadSet.js';

/** The distinct logical conflict keys one committed batch (or group prefix) wrote. */
export class WriteKeySet
{
    private static readonly Separator = ':';

    private readonly seen = new Set<string>();
    private readonly entries: Array<readonly [Keyspace, Uint8Array]> = [];

    public get Size(): number
    {
        return this.entries.length;
    }

    public Add(space: Keyspace, key: Uint8Array): void
    {
        const id = space + WriteKeySet.Separator + ConflictKeys.Hex(key);
        if (!this.seen.has(id))
        {
            this.seen.add(id);
            this.entries.push([space, key]);
        }
    }

    public AddAll(other: WriteKeySet): void
    {
        for (const [space, key] of other.entries)
        {
            this.Add(space, key);
        }
    }

    /** True when any written key lies in the read set (exact key or inside a read range). */
    public Intersects(reads: ReadSet): boolean
    {
        if (reads.IsEmpty)
        {
            return false;
        }
        for (const [space, key] of this.entries)
        {
            if (reads.Intersects(space, key))
            {
                return true;
            }
        }
        return false;
    }
}
