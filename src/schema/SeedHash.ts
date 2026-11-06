import { createHash } from 'node:crypto';
import { type CellValue, DateTimeValue, DateValue, DurationValue } from '../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { TupleCodec, type TupleElement } from '../format/TupleCodec.js';
import type { ISeedNode } from './SchemaDescription.js';

/** Type tag of a hashed cell value: the canonical encoding keeps 1n, 1, '1' and Date(1) apart. */
enum SeedValueTag
{
    Null = 0,
    Boolean = 1,
    Int64 = 2,
    Float64 = 3,
    String = 4,
    Date = 5,
    DateTime = 6,
    Duration = 7,
}

/**
 * The content hash of one seed node (spec 4.3): SHA-256 over a canonical encoding, stored as the node's
 * seed marker. The encoding is a sequence of TupleCodec tuples (each self-delimiting):
 * (PublicId, Concept, Owner, propertyCount, linkCount), then per property sorted by the UTF-8 bytes of
 * its name (name, tag, ...value), then per link in the given order (Relationship, To, edgePropertyCount)
 * followed by its edge properties sorted the same way, encoded like node properties. Floats are their
 * big-endian IEEE-754 bytes.
 */
export class SeedHash
{
    public static readonly Bytes = 32;
    private static readonly Algorithm = 'sha256';
    private static readonly ErrValue = 'Seed value is not a cell value: ';

    public static Of(node: ISeedNode): Uint8Array
    {
        const hash = createHash(SeedHash.Algorithm);
        const properties = SeedHash.Sorted(node.Properties);
        hash.update(TupleCodec.Encode([node.PublicId, node.Concept, node.Owner, properties.length, node.Links.length]));
        SeedHash.UpdateProperties(hash, properties);
        for (const link of node.Links)
        {
            const edge = SeedHash.Sorted(link.Properties ?? {});
            hash.update(TupleCodec.Encode([link.Relationship, link.To, edge.length]));
            SeedHash.UpdateProperties(hash, edge);
        }
        return new Uint8Array(hash.digest());
    }

    public static Equal(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean
    {
        if (a === undefined || b === undefined || a.length !== b.length)
        {
            return false;
        }
        return a.every((x, i) => x === b[i]);
    }

    private static UpdateProperties(hash: ReturnType<typeof createHash>, properties: ReadonlyArray<readonly [string, CellValue]>): void
    {
        for (const [name, value] of properties)
        {
            hash.update(TupleCodec.Encode([name, ...SeedHash.Value(value)]));
        }
    }

    /** Entries sorted by the UTF-8 bytes of the name (TupleCodec's string order, not UTF-16 code units). */
    private static Sorted(record: Readonly<Record<string, CellValue>>): Array<readonly [string, CellValue]>
    {
        return Object.keys(record).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(k => [k, record[k] as CellValue] as const);
    }

    private static Value(value: CellValue): TupleElement[]
    {
        if (value === null)
        {
            return [SeedValueTag.Null];
        }
        switch (typeof value)
        {
            case 'boolean':
                return [SeedValueTag.Boolean, value ? 1 : 0];
            case 'bigint':
                return [SeedValueTag.Int64, value];
            case 'number':
            {
                const bytes = new Uint8Array(8);
                new DataView(bytes.buffer).setFloat64(0, value, false);
                return [SeedValueTag.Float64, bytes];
            }
            case 'string':
                return [SeedValueTag.String, value];
        }
        if (value instanceof DateValue)
        {
            return [SeedValueTag.Date, BigInt(value.Days)];
        }
        if (value instanceof DateTimeValue)
        {
            return [SeedValueTag.DateTime, value.Micros, value.Zone];
        }
        if (value instanceof DurationValue)
        {
            return [SeedValueTag.Duration, BigInt(value.Months), BigInt(value.Days), value.Micros];
        }
        throw new GraphError(GraphErrorCode.InvalidArgument, SeedHash.ErrValue + String(value));
    }
}
