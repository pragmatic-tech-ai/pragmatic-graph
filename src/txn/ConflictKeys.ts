import { EdgeDirection } from '../format/FormatKeys.js';
import { TupleCodec } from '../format/TupleCodec.js';
import type { IKeyRange } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';

/**
 * Logical conflict keys (ruling R23): field-level keys that readers put in a ReadSet and the committer
 * records as a batch's write set. They are never physical storage keys (no chunk or delta keys), live
 * only in memory and are never persisted, so they carry no partition. Each family has one keyspace:
 *
 * - Cell(internalId, memberId) in Keyspace.Columns: one property cell (member 0 = existence of the row).
 * - Node(publicId) in Keyspace.Ids: a public id's binding (create, delete, resolve).
 * - Edge(relationshipId, direction, node, other) in Keyspace.Edges: one edge as seen from `node`; a
 *   link or unlink writes it under both endpoints (Out on the source, In on the target).
 * - Adjacency(relationshipId, direction, node): the prefix range over all Edge keys of one node and
 *   direction, for readers that enumerate neighbors (phantom protection).
 * - Extent(typeId) in Keyspace.Rows: the set of nodes of one concept; written by CreateNode and
 *   DeleteNode so readers that scan a concept's nodes see inserted or removed members as a conflict.
 * - Column(typeId, memberId) in Keyspace.Deltas (used here only as the family's namespace): one whole
 *   property column of a concept. A full-column scan records this one coarse key instead of a Cell key
 *   per row (ruling F7); every writer of a Cell also writes the Column key of the node's type.
 * - IndexEntry(key) in Keyspace.Index: one secondary-index entry, the stored key itself
 *   `(indexId, ...values, internalId)`; index maintenance writes it for every entry added or removed.
 * - IndexRange(range) in Keyspace.Index: the key range an index seek scanned (phantom protection).
 */
export class ConflictKeys
{
    public static readonly CellSpace = Keyspace.Columns;
    public static readonly NodeSpace = Keyspace.Ids;
    public static readonly EdgeSpace = Keyspace.Edges;
    public static readonly ExtentSpace = Keyspace.Rows;
    public static readonly ColumnSpace = Keyspace.Deltas;
    public static readonly IndexSpace = Keyspace.Index;

    public static Cell(internalId: bigint, memberId: number): Uint8Array
    {
        return TupleCodec.Encode([internalId, memberId]);
    }

    public static Node(publicId: string): Uint8Array
    {
        return TupleCodec.Encode([publicId]);
    }

    public static Edge(relationshipId: number, direction: EdgeDirection, node: bigint, other: bigint): Uint8Array
    {
        return TupleCodec.Encode([relationshipId, direction, node, other]);
    }

    public static Adjacency(relationshipId: number, direction: EdgeDirection, node: bigint): IKeyRange
    {
        return ConflictKeys.PrefixRange(TupleCodec.Encode([relationshipId, direction, node]));
    }

    public static Column(typeId: number, memberId: number): Uint8Array
    {
        return TupleCodec.Encode([typeId, memberId]);
    }

    public static Extent(typeId: number): Uint8Array
    {
        return TupleCodec.Encode([typeId]);
    }

    /** The range covering Extent(typeId); equivalent to AddKey(Extent(typeId)) but range-shaped for scans. */
    public static ExtentRange(typeId: number): IKeyRange
    {
        return ConflictKeys.PrefixRange(ConflictKeys.Extent(typeId));
    }

    /** A copy of the stored index-entry key: the logical key and the storage key coincide. */
    public static IndexEntry(key: Uint8Array): Uint8Array
    {
        return key.slice();
    }

    /** A copy of the scanned index key range. */
    public static IndexRange(range: IKeyRange): IKeyRange
    {
        return { Start: range.Start.slice(), End: range.End.slice() };
    }

    /** Lowercase hex of the key; a stable map key for byte strings. */
    public static Hex(key: Uint8Array): string
    {
        return Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString('hex');
    }

    private static PrefixRange(prefix: Uint8Array): IKeyRange
    {
        return { Start: prefix, End: TupleCodec.PrefixEnd(prefix) };
    }
}
