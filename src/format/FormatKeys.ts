import type { IKeyRange } from '../kv/KeyValue.js';
import { TupleCodec, type TupleElement } from './TupleCodec.js';

export enum EdgeDirection
{
    Out = 0,
    In = 1,
}

/** Key tags that disambiguate key families sharing one keyspace. See docs/format/on-disk-format.md. */
export enum IdsTag
{
    PublicToInternal = 1,
    InternalToPublic = 2,
    Owner = 3,
}

export enum CatalogTag
{
    Root = 1,
}

/** Tuple-encoded key builders: the one place that defines every key of the on-disk format. */
export class FormatKeys
{
    private static readonly SeedName = 'seed';

    public static Meta(name: string, ...qualifiers: TupleElement[]): Uint8Array
    {
        return TupleCodec.Encode([name, ...qualifiers]);
    }

    /**
     * Keyspace.Meta: the seed marker of a node the schema's seed placed: Meta("seed", publicId) -> 32-byte SeedHash.
     */
    public static Seed(publicId: string): Uint8Array
    {
        return FormatKeys.Meta(FormatKeys.SeedName, publicId);
    }

    /** Keyspace.Meta: every seed marker. */
    public static SeedRange(): IKeyRange
    {
        return FormatKeys.PrefixRange(FormatKeys.Meta(FormatKeys.SeedName));
    }

    public static CatalogRoot(): Uint8Array
    {
        return TupleCodec.Encode([CatalogTag.Root]);
    }

    public static PublicToInternal(publicId: string): Uint8Array
    {
        return TupleCodec.Encode([IdsTag.PublicToInternal, publicId]);
    }

    /** Every InternalToPublic key (a scan of all stored nodes' public ids). */
    public static InternalToPublicRange(): IKeyRange
    {
        return FormatKeys.PrefixRange(TupleCodec.Encode([IdsTag.InternalToPublic]));
    }

    public static InternalToPublic(id: bigint): Uint8Array
    {
        return TupleCodec.Encode([IdsTag.InternalToPublic, id]);
    }

    /** The owner (model name, UTF-8) of the node; absent when the node was created without an owner. */
    public static NodeOwner(id: bigint): Uint8Array
    {
        return TupleCodec.Encode([IdsTag.Owner, id]);
    }

    /** The row index is global (ruling F5): keyed by row block number only; entries carry the partition. */
    public static RowBlock(block: bigint): Uint8Array
    {
        return TupleCodec.Encode([block]);
    }

    public static Column(partition: number, typeId: number, memberId: number, chunk: bigint): Uint8Array
    {
        return TupleCodec.Encode([partition, typeId, memberId, chunk]);
    }

    public static Delta(partition: number, typeId: number, memberId: number, chunk: bigint): Uint8Array
    {
        return TupleCodec.Encode([partition, typeId, memberId, chunk]);
    }

    /**
     * Every column chunk key (Columns) or delta key (Deltas) of one type, all members: same tuple prefix in both
     * keyspaces.
     */
    public static TypeCellsRange(partition: number, typeId: number): IKeyRange
    {
        return FormatKeys.PrefixRange(TupleCodec.Encode([partition, typeId]));
    }

    /** Every column chunk key (Columns) or delta key (Deltas) of one (type, member) column. */
    public static MemberCellsRange(partition: number, typeId: number, memberId: number): IKeyRange
    {
        return FormatKeys.PrefixRange(TupleCodec.Encode([partition, typeId, memberId]));
    }

    public static Edge(
        partition: number,
        relationshipId: number,
        direction: EdgeDirection,
        node: bigint,
        position: Uint8Array,
        other: bigint,
    ): Uint8Array
    {
        return TupleCodec.Encode([partition, relationshipId, direction, node, position, other]);
    }

    public static EdgePrefix(partition: number, relationshipId: number, direction: EdgeDirection, node: bigint): Uint8Array
    {
        return TupleCodec.Encode([partition, relationshipId, direction, node]);
    }

    /** Prefix of every edge key of the node at exactly this position (the other id follows). */
    public static EdgeAt(partition: number, relationshipId: number, direction: EdgeDirection, node: bigint, position: Uint8Array): Uint8Array
    {
        return TupleCodec.Encode([partition, relationshipId, direction, node, position]);
    }

    public static EdgeRange(partition: number, relationshipId: number, direction: EdgeDirection, node: bigint): IKeyRange
    {
        return FormatKeys.PrefixRange(FormatKeys.EdgePrefix(partition, relationshipId, direction, node));
    }

    public static LogEntry(commit: bigint): Uint8Array
    {
        return TupleCodec.Encode([commit]);
    }

    private static PrefixRange(prefix: Uint8Array): IKeyRange
    {
        return { Start: prefix, End: TupleCodec.PrefixEnd(prefix) };
    }
}
