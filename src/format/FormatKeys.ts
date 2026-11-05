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
}

export enum CatalogTag
{
    Root = 1,
}

/** Tuple-encoded key builders: the one place that defines every key of the on-disk format. */
export class FormatKeys
{
    public static Meta(name: string, ...qualifiers: TupleElement[]): Uint8Array
    {
        return TupleCodec.Encode([name, ...qualifiers]);
    }

    public static CatalogRoot(): Uint8Array
    {
        return TupleCodec.Encode([CatalogTag.Root]);
    }

    public static PublicToInternal(publicId: string): Uint8Array
    {
        return TupleCodec.Encode([IdsTag.PublicToInternal, publicId]);
    }

    public static InternalToPublic(id: bigint): Uint8Array
    {
        return TupleCodec.Encode([IdsTag.InternalToPublic, id]);
    }

    public static RowBlock(partition: number, block: bigint): Uint8Array
    {
        return TupleCodec.Encode([partition, block]);
    }

    public static Column(partition: number, typeId: number, memberId: number, chunk: bigint): Uint8Array
    {
        return TupleCodec.Encode([partition, typeId, memberId, chunk]);
    }

    public static Delta(partition: number, typeId: number, memberId: number, chunk: bigint): Uint8Array
    {
        return TupleCodec.Encode([partition, typeId, memberId, chunk]);
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

    public static EdgeRange(partition: number, relationshipId: number, direction: EdgeDirection, node: bigint): IKeyRange
    {
        const prefix = FormatKeys.EdgePrefix(partition, relationshipId, direction, node);
        return { Start: prefix, End: TupleCodec.PrefixEnd(prefix) };
    }

    public static LogEntry(commit: bigint): Uint8Array
    {
        return TupleCodec.Encode([commit]);
    }
}
