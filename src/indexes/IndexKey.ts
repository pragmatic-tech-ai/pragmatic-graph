import type { MemberDef } from '../catalog/CatalogTypes.js';
import { ValueType } from '../catalog/ValueType.js';
import { DateTimeValue, DateValue, type CellValue } from '../columns/CellValue.js';
import { ChunkCodecError } from '../columns/ChunkCodecError.js';
import { ValueCodec } from '../columns/ValueCodec.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { TupleCodec, TupleDouble, type TupleElement } from '../format/TupleCodec.js';
import { KeyLimits, type IKeyRange } from '../kv/KeyValue.js';
import { CommitError, CommitErrorCode } from '../txn/CommitError.js';

/** One end of an index seek range: applies to the index member right after the prefix. */
export interface IIndexBound
{
    readonly Value: CellValue;
    readonly Inclusive: boolean;
}

/**
 * An index seek: entries whose first `Prefix.length` members equal `Prefix`, optionally bounded on the
 * next member, in index order (descending with Reverse), at most Limit (no limit when absent, 0 or less).
 */
export interface IIndexRange
{
    readonly Prefix: readonly CellValue[];
    readonly Lower?: IIndexBound;
    readonly Upper?: IIndexBound;
    readonly Reverse?: boolean;
    readonly Limit?: number;
}

/**
 * Keys of the Index keyspace (docs/format/on-disk-format.md, Index): `(indexId, ...values, internalId)`
 * with an empty value. A value is its member's tuple element: null as tuple null, Boolean as tuple
 * false/true, Int64 as an integer, Float64 as a tuple double (-0 stored as 0, every NaN as the one
 * quiet NaN), String as a UTF-8 string, Date as its days, DateTime as its UTC micros (zone ignored).
 * Duration is never indexed (rejected at plan time).
 */
export class IndexKey
{
    private static readonly ErrDuration = 'Duration values are not indexable';
    private static readonly ErrTooLong = 'Indexed values make the index key longer than 511 bytes: index ';
    private static readonly ErrPrefix = 'Index seek prefix is longer than the index: ';
    private static readonly ErrBound = 'Index seek bounds need a member after the prefix: ';
    private static readonly ErrValue = 'Index seek value does not fit member ';
    private static readonly ErrNoId = 'Index key does not end with an internal id';
    private static readonly ErrLimit = 'Index seek Limit must be an integer';
    private static readonly Colon = ': ';
    /** The smallest byte, appended to a key to form its immediate successor. */
    private static readonly Smallest = 0x00;

    /** The tuple element of a value of `type` (the value already fits the type). */
    public static Element(type: ValueType, value: CellValue): TupleElement
    {
        if (value === null)
        {
            return null;
        }
        switch (type)
        {
            case ValueType.Float64:
            {
                const n = value as number;
                return new TupleDouble(Number.isNaN(n) ? Number.NaN : n === 0 ? 0 : n);
            }
            case ValueType.Date:
                return BigInt((value as DateValue).Days);
            case ValueType.DateTime:
                return (value as DateTimeValue).Micros;
            case ValueType.Duration:
                throw new GraphError(GraphErrorCode.Internal, IndexKey.ErrDuration);
            default:
                return value as boolean | bigint | string;
        }
    }

    /** The entry key of one node; CommitError InvalidValue when it exceeds the portable key limit. */
    public static Entry(indexName: string, indexId: number, elements: readonly TupleElement[], internalId: bigint): Uint8Array
    {
        const key = TupleCodec.Encode([indexId, ...elements, internalId]);
        if (key.length > KeyLimits.MaxKeyBytes)
        {
            throw new CommitError(CommitErrorCode.InvalidValue, IndexKey.ErrTooLong + indexName);
        }
        return key;
    }

    /** Every entry whose leading elements equal `elements` (a unique check reads it). */
    public static PrefixRange(indexId: number, elements: readonly TupleElement[]): IKeyRange
    {
        const prefix = TupleCodec.Encode([indexId, ...elements]);
        return { Start: prefix, End: TupleCodec.PrefixEnd(prefix) };
    }

    /** Every entry of one index. */
    public static IndexRange(indexId: number): IKeyRange
    {
        return IndexKey.PrefixRange(indexId, []);
    }

    /** The internal id an entry key ends with. */
    public static InternalId(key: Uint8Array): bigint
    {
        const id = TupleCodec.Decode(key).at(-1);
        if (typeof id !== 'bigint')
        {
            throw new GraphError(GraphErrorCode.Corrupt, IndexKey.ErrNoId);
        }
        return id;
    }

    /** The smallest key greater than `key`: `key` followed by 0x00 (a seek that stopped at its Limit records up to it). */
    public static After(key: Uint8Array): Uint8Array
    {
        const out = new Uint8Array(key.length + 1);
        out.set(key);
        out[key.length] = IndexKey.Smallest;
        return out;
    }

    /**
     * The key range of a seek over the index with these members. GraphError InvalidArgument when the
     * prefix is longer than the index, a bound has no member after the prefix, a value does not fit its
     * member's type, or Limit is not an integer.
     */
    public static SeekRange(indexName: string, indexId: number, members: readonly MemberDef[], range: IIndexRange): IKeyRange
    {
        if (range.Prefix.length > members.length)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, IndexKey.ErrPrefix + indexName);
        }
        if (range.Limit !== undefined && !Number.isInteger(range.Limit))
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, IndexKey.ErrLimit);
        }
        const prefix = range.Prefix.map((v, i) => IndexKey.SeekElement(members[i] as MemberDef, v));
        const whole = IndexKey.PrefixRange(indexId, prefix);
        if (range.Lower === undefined && range.Upper === undefined)
        {
            return whole;
        }
        const next = members[range.Prefix.length];
        if (next === undefined)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, IndexKey.ErrBound + indexName);
        }
        let start = whole.Start;
        let end = whole.End;
        if (range.Lower !== undefined)
        {
            const bound = IndexKey.PrefixRange(indexId, [...prefix, IndexKey.SeekElement(next, range.Lower.Value)]);
            start = range.Lower.Inclusive ? bound.Start : bound.End;
        }
        if (range.Upper !== undefined)
        {
            const bound = IndexKey.PrefixRange(indexId, [...prefix, IndexKey.SeekElement(next, range.Upper.Value)]);
            end = range.Upper.Inclusive ? bound.End : bound.Start;
        }
        return { Start: start, End: end };
    }

    private static SeekElement(member: MemberDef, value: CellValue): TupleElement
    {
        if (value !== null)
        {
            try
            {
                ValueCodec.Check(member.Type as ValueType, value);
            }
            catch (error)
            {
                if (error instanceof ChunkCodecError)
                {
                    throw new GraphError(GraphErrorCode.InvalidArgument, IndexKey.ErrValue + member.Name + IndexKey.Colon + error.message, error);
                }
                throw error;
            }
        }
        return IndexKey.Element(member.Type as ValueType, value);
    }
}
