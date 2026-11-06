import { TupleCodec } from '../format/TupleCodec.js';
import type { IKeyRange, ScanCounter } from './KeyValue.js';

/** One staged change of a write transaction; a null value is a delete. */
export interface IPendingChange
{
    readonly Key: Uint8Array;
    readonly Value: Uint8Array | null;
}

/**
 * A write transaction's staged changes in one keyspace, in key order, as a chunked sorted list:
 * sorted leaves of at most LeafCapacity changes, located by binary search on their first keys, so a
 * new key costs O(log n + LeafCapacity) and a scan merges them lazily from the binary-searched start.
 *
 * Every Set (a new key, a replacement or a delete) bumps the version (VersionOf); an InRange iteration that observes
 * a new Version throws instead of yielding a stale, skipped or repeated change.
 */
export class PendingChanges
{
    public static readonly LeafCapacity = 512;
    public static readonly ErrChanged = 'Staged changes of this keyspace changed during the scan: finish or abandon the scan before a Put or Delete in its keyspace';
    /** No staged changes, for a keyspace without a PendingChanges. */
    public static readonly None: readonly IPendingChange[] = [];

    private readonly leaves: IPendingChange[][] = [];
    private size = 0;
    /** Bumped by every Set; read through VersionOf. */
    private version = 0;

    public get Size(): number
    {
        return this.size;
    }

    /** Stages the change; `key` and `value` must already be private copies. A later change to the same key replaces it. */
    public Set(key: Uint8Array, value: Uint8Array | null): void
    {
        const change: IPendingChange = { Key: key, Value: value };
        this.version++;
        if (this.leaves.length === 0)
        {
            this.leaves.push([change]);
            this.size++;
            return;
        }
        const li = this.LeafFor(key);
        const leaf = this.leaves[li] as IPendingChange[];
        const at = PendingChanges.LowerBound(leaf, key);
        const hit = leaf[at];
        if (hit !== undefined && TupleCodec.Compare(hit.Key, key) === 0)
        {
            leaf[at] = change;
            return;
        }
        leaf.splice(at, 0, change);
        if (leaf.length > PendingChanges.LeafCapacity)
        {
            const half = leaf.length >> 1;
            this.leaves.splice(li, 1, leaf.slice(0, half), leaf.slice(half));
        }
        this.size++;
    }

    public Get(key: Uint8Array): IPendingChange | undefined
    {
        if (this.leaves.length === 0)
        {
            return undefined;
        }
        const leaf = this.leaves[this.LeafFor(key)] as IPendingChange[];
        const hit = leaf[PendingChanges.LowerBound(leaf, key)];
        return hit !== undefined && TupleCodec.Compare(hit.Key, key) === 0 ? hit : undefined;
    }

    /** Every change, in key order. Do not Set while iterating. */
    public *Values(): Iterable<IPendingChange>
    {
        for (const leaf of this.leaves)
        {
            yield* leaf;
        }
    }

    /**
     * Changes with Start <= key < End, in key order, walked lazily leaf by leaf from the
     * binary-searched start. Throws ErrChanged if anything is Set while the iteration is open.
     */
    public *InRange(range: IKeyRange): Iterable<IPendingChange>
    {
        if (this.leaves.length === 0)
        {
            return;
        }
        const version = this.version;
        let li = this.LeafFor(range.Start);
        let i = PendingChanges.LowerBound(this.leaves[li] as IPendingChange[], range.Start);
        while (li < this.leaves.length)
        {
            const leaf = this.leaves[li] as IPendingChange[];
            if (i >= leaf.length)
            {
                li++;
                i = 0;
                continue;
            }
            const change = leaf[i] as IPendingChange;
            if (TupleCodec.Compare(change.Key, range.End) >= 0)
            {
                return;
            }
            yield change;
            if (this.version !== version)
            {
                throw new Error(PendingChanges.ErrChanged);
            }
            i++;
        }
    }

    /** Version of a keyspace's staged changes; 0 while it has none (the first Set makes it 1). */
    public static VersionOf(changes: PendingChanges | undefined): number
    {
        return changes === undefined ? 0 : changes.version;
    }

    /** Throws ErrChanged unless VersionOf(changes) still equals `version`. */
    public static RequireVersion(changes: PendingChanges | undefined, version: number): void
    {
        if (PendingChanges.VersionOf(changes) !== version)
        {
            throw new Error(PendingChanges.ErrChanged);
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
                    if (++produced >= max)
                    {
                        return;
                    }
                    b = PendingChanges.Pull(stored, counter);
                    continue;
                }
                const change = c as IPendingChange;
                if (change.Value !== null)
                {
                    yield [change.Key, change.Value];
                    if (++produced >= max)
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

    /** Index of the last leaf whose first key is <= key (leaf 0 when key precedes every leaf). */
    private LeafFor(key: Uint8Array): number
    {
        let lo = 0;
        let hi = this.leaves.length - 1;
        while (lo < hi)
        {
            const mid = (lo + hi + 1) >> 1;
            const first = (this.leaves[mid] as IPendingChange[])[0] as IPendingChange;
            if (TupleCodec.Compare(first.Key, key) <= 0)
            {
                lo = mid;
            }
            else
            {
                hi = mid - 1;
            }
        }
        return lo;
    }

    private static LowerBound(leaf: readonly IPendingChange[], key: Uint8Array): number
    {
        let lo = 0;
        let hi = leaf.length;
        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;
            if (TupleCodec.Compare((leaf[mid] as IPendingChange).Key, key) < 0)
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
