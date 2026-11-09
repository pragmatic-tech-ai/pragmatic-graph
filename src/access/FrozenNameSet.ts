/**
 * Internal: a read-only view of a set of names that cannot be mutated, not even by a caller casting away the
 * ReadonlySet type (it has no add, delete or clear, and its backing Set is private and copied on construction).
 */
export class FrozenNameSet implements ReadonlySet<string>
{
    private readonly names: Set<string>;

    public constructor(names: Iterable<string>)
    {
        this.names = new Set(names);
        Object.freeze(this);
    }

    public get size(): number
    {
        return this.names.size;
    }

    public has(value: string): boolean
    {
        return this.names.has(value);
    }

    public forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void
    {
        for (const name of this.names)
        {
            callback.call(thisArg, name, name, this);
        }
    }

    public entries(): SetIterator<[string, string]>
    {
        return this.names.entries();
    }

    public keys(): SetIterator<string>
    {
        return this.names.keys();
    }

    public values(): SetIterator<string>
    {
        return this.names.values();
    }

    public [Symbol.iterator](): SetIterator<string>
    {
        return this.names.values();
    }
}
