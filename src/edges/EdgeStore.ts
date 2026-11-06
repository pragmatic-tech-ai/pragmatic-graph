import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import { ValueCodec } from '../columns/ValueCodec.js';
import { EdgeDirection, FormatKeys } from '../format/FormatKeys.js';
import { FractionalPosition } from '../format/FractionalPosition.js';
import { TupleCodec } from '../format/TupleCodec.js';
import { InternalId } from '../identity/InternalId.js';
import type { IReadTransaction, IWriteTransaction } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { EdgeError, EdgeErrorCode } from './EdgeError.js';

export interface ILinkOptions
{
    /** Insert right after the edge at this position (ordered relationships only). */
    readonly After?: Uint8Array | null;
    /** Insert right before the edge at this position (ordered relationships only). */
    readonly Before?: Uint8Array | null;
    readonly Properties?: ReadonlyMap<string, CellValue>;
}

export interface INeighbor
{
    readonly Node: bigint;
    readonly Position: Uint8Array;
    readonly Properties: ReadonlyMap<string, CellValue>;
}

interface ISibling
{
    readonly Position: Uint8Array;
    readonly Other: bigint;
}

/**
 * Bidirectional adjacency. Every link is two keys: Out on the source (value = edge properties) and In
 * on the target (empty value), both carrying the same position. See docs/format/on-disk-format.md.
 * Edge semantics are ruling R21: one edge per (from, relationship, to); non-Many relationships allow
 * one outgoing edge per source; unordered relationships use the empty position. Target type checking
 * belongs to the committer. Only partition 0 exists in v1.
 *
 * Cost: finding an existing edge by (from, to) is O(1) for unordered Many relationships (the pair key
 * is directly addressable), a single-key scan for unordered one-valued relationships, and a scan of
 * the source's Out range, O(out-degree), for ordered relationships (the position is part of the key).
 * Appending to an ordered relationship also scans to find the last sibling. A future (from, to) to
 * position pair index would make ordered lookups O(1).
 */
export class EdgeStore
{
    private static readonly Partition = 0;
    private static readonly U32Bytes = 4;
    private static readonly EmptyPosition: Uint8Array = new Uint8Array(0);
    private static readonly ErrNotRelationship = 'Member is not a relationship: ';
    private static readonly ErrDuplicate = 'Edge already exists: ';
    private static readonly ErrNotOrdered = 'After/Before require an ordered relationship: ';
    private static readonly ErrNotAdjacent = 'After and Before are not adjacent siblings';
    private static readonly ErrBounds = 'After position must sort before the Before position';
    private static readonly ErrRequired = 'Missing required edge property: ';
    private static readonly ArrowSeparator = '->';
    private static readonly SpaceSeparator = ' ';
    private static readonly ErrCardinality = 'Relationship allows one outgoing edge per node: ';
    private static readonly ErrSibling = 'Position does not belong to an edge of this node and relationship';
    private static readonly ErrMissing = 'Edge does not exist: ';
    private static readonly ErrUnknownProperty = 'Unknown edge property: ';
    private static readonly ErrInvalidValue = 'Invalid edge property value: ';
    private static readonly ErrNull = 'Edge property does not accept null: ';
    private static readonly ErrCorrupt = 'Corrupt edge property bytes';

    /** Creates the edge and returns its position (empty for unordered relationships). */
    public async Link(txn: IWriteTransaction, relationship: MemberDef, from: bigint, to: bigint, options?: ILinkOptions): Promise<Uint8Array>
    {
        EdgeStore.RequireRelationship(relationship);
        InternalId.Require(from);
        InternalId.Require(to);
        const value = EdgeStore.EncodeProperties(relationship, options?.Properties);
        const ordered = relationship.Ordered === true;
        if (!ordered && ((options?.After ?? null) !== null || (options?.Before ?? null) !== null))
        {
            throw new EdgeError(EdgeErrorCode.NotOrdered, EdgeStore.ErrNotOrdered + relationship.Name);
        }
        const many = relationship.Many === true;
        let position = EdgeStore.EmptyPosition;
        if (ordered)
        {
            const siblings = await this.Siblings(txn, relationship, from);
            EdgeStore.RequireNew(relationship, siblings, to, many, from);
            position = EdgeStore.ChoosePosition(siblings, options);
        }
        else if (many)
        {
            if ((await this.FindPosition(txn, relationship, from, to)) !== undefined)
            {
                throw EdgeStore.Duplicate(relationship, from, to);
            }
        }
        else
        {
            EdgeStore.RequireNew(relationship, await this.Siblings(txn, relationship, from, 1), to, many, from);
        }
        txn.Put(Keyspace.Edges, FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from, position, to), value);
        txn.Put(Keyspace.Edges, FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.In, to, position, from), new Uint8Array(0));
        return position;
    }

    /** Removes both keys of the edge; MissingEdge when there is none. */
    public async Unlink(txn: IWriteTransaction, relationship: MemberDef, from: bigint, to: bigint): Promise<void>
    {
        EdgeStore.RequireRelationship(relationship);
        InternalId.Require(from);
        InternalId.Require(to);
        const position = await this.FindPosition(txn, relationship, from, to);
        if (position === undefined)
        {
            throw new EdgeError(EdgeErrorCode.MissingEdge, EdgeStore.ErrMissing + EdgeStore.Label(relationship, from, to));
        }
        txn.Delete(Keyspace.Edges, FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from, position, to));
        txn.Delete(Keyspace.Edges, FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.In, to, position, from));
    }

    /**
     * Streams the node's edges in key order (position, then other id). `Node` is the node at the far
     * end. In direction costs one Get per neighbor to fetch the properties from the matching Out key.
     */
    public async *Neighbors(txn: IReadTransaction, relationship: MemberDef, node: bigint, direction: EdgeDirection): AsyncIterable<INeighbor>
    {
        EdgeStore.RequireRelationship(relationship);
        InternalId.Require(node);
        const range = FormatKeys.EdgeRange(EdgeStore.Partition, relationship.Id, direction, node);
        for await (const [key, value] of txn.Scan(Keyspace.Edges, range))
        {
            const parts = TupleCodec.Decode(key);
            const position = parts[4] as Uint8Array;
            const other = parts[5] as bigint;
            let bytes: Uint8Array | undefined = value;
            if (direction === EdgeDirection.In)
            {
                bytes = await txn.Get(Keyspace.Edges, FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, other, position, node));
            }
            yield { Node: other, Position: position, Properties: EdgeStore.DecodeProperties(relationship, bytes) };
        }
    }

    /** Position of the edge from -> to, or undefined. Cost depends on the relationship shape (see class comment). */
    private async FindPosition(txn: IReadTransaction, relationship: MemberDef, from: bigint, to: bigint): Promise<Uint8Array | undefined>
    {
        if (relationship.Ordered === true)
        {
            return (await this.Siblings(txn, relationship, from)).find(s => s.Other === to)?.Position;
        }
        if (relationship.Many === true)
        {
            const key = FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from, EdgeStore.EmptyPosition, to);
            return (await txn.Get(Keyspace.Edges, key)) === undefined ? undefined : EdgeStore.EmptyPosition;
        }
        const first = (await this.Siblings(txn, relationship, from, 1))[0];
        return first !== undefined && first.Other === to ? first.Position : undefined;
    }

    private async Siblings(txn: IReadTransaction, relationship: MemberDef, from: bigint, limit?: number): Promise<ISibling[]>
    {
        const range = FormatKeys.EdgeRange(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from);
        const out: ISibling[] = [];
        for await (const [key] of txn.Scan(Keyspace.Edges, range, limit))
        {
            const parts = TupleCodec.Decode(key);
            out.push({ Position: parts[4] as Uint8Array, Other: parts[5] as bigint });
        }
        return out;
    }

    private static RequireNew(relationship: MemberDef, siblings: readonly ISibling[], to: bigint, many: boolean, from: bigint): void
    {
        if (siblings.some(s => s.Other === to))
        {
            throw EdgeStore.Duplicate(relationship, from, to);
        }
        if (!many && siblings.length > 0)
        {
            throw new EdgeError(EdgeErrorCode.CardinalityExceeded, EdgeStore.ErrCardinality + EdgeStore.Label(relationship, from, to));
        }
    }

    private static Label(relationship: MemberDef, from: bigint, to: bigint): string
    {
        return relationship.Name + EdgeStore.SpaceSeparator + from + EdgeStore.ArrowSeparator + to;
    }

    private static Duplicate(relationship: MemberDef, from: bigint, to: bigint): EdgeError
    {
        return new EdgeError(EdgeErrorCode.DuplicateEdge, EdgeStore.ErrDuplicate + EdgeStore.Label(relationship, from, to));
    }

    /** Position for a new edge among `siblings` (already in key order). */
    private static ChoosePosition(siblings: readonly ISibling[], options: ILinkOptions | undefined): Uint8Array
    {
        const after = options?.After ?? null;
        const before = options?.Before ?? null;
        if (after !== null)
        {
            EdgeStore.RequireSibling(siblings, after);
        }
        if (before !== null)
        {
            EdgeStore.RequireSibling(siblings, before);
        }
        if (after !== null && before !== null)
        {
            if (TupleCodec.Compare(after, before) >= 0)
            {
                throw new EdgeError(EdgeErrorCode.InvalidOrder, EdgeStore.ErrBounds);
            }
            if (siblings.some(x => TupleCodec.Compare(x.Position, after) > 0 && TupleCodec.Compare(x.Position, before) < 0))
            {
                throw new EdgeError(EdgeErrorCode.NotAdjacent, EdgeStore.ErrNotAdjacent);
            }
            return FractionalPosition.Between(after, before);
        }
        if (after !== null)
        {
            const next = siblings.find(s => TupleCodec.Compare(s.Position, after) > 0);
            return FractionalPosition.Between(after, next === undefined ? null : next.Position);
        }
        if (before !== null)
        {
            let prev: Uint8Array | null = null;
            for (const s of siblings)
            {
                if (TupleCodec.Compare(s.Position, before) < 0)
                {
                    prev = s.Position;
                }
            }
            return FractionalPosition.Between(prev, before);
        }
        const last = siblings.length === 0 ? null : (siblings[siblings.length - 1] as ISibling).Position;
        return FractionalPosition.Between(last, null);
    }

    private static RequireSibling(siblings: readonly ISibling[], position: Uint8Array): void
    {
        if (!siblings.some(s => TupleCodec.Compare(s.Position, position) === 0))
        {
            throw new EdgeError(EdgeErrorCode.UnknownSibling, EdgeStore.ErrSibling);
        }
    }

    private static RequireRelationship(member: MemberDef): void
    {
        if (member.Kind !== MemberKind.Relationship)
        {
            throw new EdgeError(EdgeErrorCode.NotARelationship, EdgeStore.ErrNotRelationship + member.Name);
        }
    }

    /** Out value: for each non-null property sorted by member id, u32 LE id, u32 LE value length, single-value bytes. */
    private static EncodeProperties(relationship: MemberDef, properties: ReadonlyMap<string, CellValue> | undefined): Uint8Array
    {
        const declared = relationship.EdgeProperties ?? [];
        for (const member of declared)
        {
            if (!member.Nullable && (properties?.get(member.Name) ?? null) === null)
            {
                throw new EdgeError(EdgeErrorCode.InvalidProperty, EdgeStore.ErrRequired + member.Name);
            }
        }
        if (properties === undefined || properties.size === 0)
        {
            return new Uint8Array(0);
        }
        const parts: Array<{ Id: number; Bytes: Uint8Array }> = [];
        for (const [name, value] of properties)
        {
            const member = declared.find(m => m.Name === name);
            if (member === undefined || member.Type === undefined)
            {
                throw new EdgeError(EdgeErrorCode.InvalidProperty, EdgeStore.ErrUnknownProperty + name);
            }
            if (value === null)
            {
                if (!member.Nullable)
                {
                    throw new EdgeError(EdgeErrorCode.InvalidProperty, EdgeStore.ErrNull + name);
                }
                continue;
            }
            try
            {
                ValueCodec.Check(member.Type, value);
                parts.push({ Id: member.Id, Bytes: ValueCodec.Encode(member.Type, value) });
            }
            catch
            {
                throw new EdgeError(EdgeErrorCode.InvalidProperty, EdgeStore.ErrInvalidValue + name);
            }
        }
        parts.sort((a, b) => a.Id - b.Id);
        const size = EdgeStore.U32Bytes;
        const out = new Uint8Array(parts.reduce((n, p) => n + 2 * size + p.Bytes.length, 0));
        const view = new DataView(out.buffer);
        let at = 0;
        for (const p of parts)
        {
            view.setUint32(at, p.Id, true);
            view.setUint32(at + size, p.Bytes.length, true);
            out.set(p.Bytes, at + 2 * size);
            at += 2 * size + p.Bytes.length;
        }
        return out;
    }

    private static DecodeProperties(relationship: MemberDef, bytes: Uint8Array | undefined): ReadonlyMap<string, CellValue>
    {
        const result = new Map<string, CellValue>();
        if (bytes === undefined || bytes.length === 0)
        {
            return result;
        }
        const declared = relationship.EdgeProperties ?? [];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        const size = EdgeStore.U32Bytes;
        let at = 0;
        while (at < bytes.length)
        {
            if (at + 2 * size > bytes.length)
            {
                throw new EdgeError(EdgeErrorCode.CorruptEdge, EdgeStore.ErrCorrupt);
            }
            const id = view.getUint32(at, true);
            const length = view.getUint32(at + size, true);
            const start = at + 2 * size;
            const member = declared.find(m => m.Id === id);
            if (member === undefined || member.Type === undefined || start + length > bytes.length)
            {
                throw new EdgeError(EdgeErrorCode.CorruptEdge, EdgeStore.ErrCorrupt);
            }
            try
            {
                result.set(member.Name, ValueCodec.Decode(member.Type, bytes.slice(start, start + length)));
            }
            catch
            {
                throw new EdgeError(EdgeErrorCode.CorruptEdge, EdgeStore.ErrCorrupt);
            }
            at = start + length;
        }
        return result;
    }
}
