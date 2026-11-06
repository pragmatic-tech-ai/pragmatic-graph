import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import { ValueCodec } from '../columns/ValueCodec.js';
import { EdgeDirection, FormatKeys } from '../format/FormatKeys.js';
import { FractionalPosition } from '../format/FractionalPosition.js';
import { TupleCodec } from '../format/TupleCodec.js';
import { InternalId } from '../identity/InternalId.js';
import { KeyLimits, type IReadTransaction, type IWriteTransaction } from '../kv/KeyValue.js';
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

/** A neighbour without its edge properties (Adjacent). */
export interface IAdjacent
{
    readonly Node: bigint;
    readonly Position: Uint8Array;
}

export interface INeighbor extends IAdjacent
{
    readonly Properties: ReadonlyMap<string, CellValue>;
}

interface ISibling
{
    readonly Position: Uint8Array;
    readonly Other: bigint;
}

/** A sibling with its Out value (edge properties), as a renumbering rewrites it. */
interface IStoredSibling extends ISibling
{
    readonly Value: Uint8Array;
}

/** An edge whose position a renumbering rewrote (both its keys changed). */
export interface IRenumberedEdge
{
    readonly Relationship: MemberDef;
    readonly From: bigint;
    readonly To: bigint;
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
 * the target's In range, O(in-degree of the target), for ordered relationships (In keys carry the
 * position; ruling R33; 1 for trees). An ordered insert After a sibling then reads the neighbour with
 * one bounded forward scan (limit 2) from that position; a plain append reads the last sibling and an
 * insert with only Before the preceding one with one reverse scan of limit 1 (ruling F1), so no ordered
 * insert depends on the out-degree.
 *
 * Positions are internal (ruling F1): when a between-insert would push an edge key past the portable
 * key limit (KeyLimits.MaxKeyBytes), the (source, relationship) list is renumbered evenly inside the
 * same transaction (every edge of it gets a new, short position). The rewritten edges are reported by
 * TakeRenumbered so the committer can record their conflict keys.
 */
export class EdgeStore
{
    private static readonly Partition = 0;
    private static readonly U32Bytes = 4;
    private static readonly EmptyPosition: Uint8Array = new Uint8Array(0);
    private static readonly LastOnly = { Reverse: true, Limit: 1 };
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

    /** Edges renumbered per write transaction, until TakeRenumbered collects them. */
    private readonly renumbered = new WeakMap<object, IRenumberedEdge[]>();

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
            if ((await this.FindPosition(txn, relationship, from, to)) !== undefined)
            {
                throw EdgeStore.Duplicate(relationship, from, to);
            }
            if (!many)
            {
                EdgeStore.RequireNew(relationship, await this.Siblings(txn, relationship, from, 1), to, many, from);
            }
            position = await this.OrderedPosition(txn, relationship, from, options?.After ?? null, options?.Before ?? null);
            if (EdgeStore.KeyLength(relationship, from, to, position) > KeyLimits.MaxKeyBytes)
            {
                const moved = await this.Renumber(txn, relationship, from);
                position = await this.OrderedPosition(txn, relationship, from, EdgeStore.Moved(moved, options?.After ?? null), EdgeStore.Moved(moved, options?.Before ?? null));
            }
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
     * Removes both keys of the edge from -> to at a position the caller already knows (for example from
     * Adjacent), without looking it up; MissingEdge when there is no such edge.
     */
    public async UnlinkAt(txn: IWriteTransaction, relationship: MemberDef, from: bigint, to: bigint, position: Uint8Array): Promise<void>
    {
        EdgeStore.RequireRelationship(relationship);
        InternalId.Require(from);
        InternalId.Require(to);
        const out = FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from, position, to);
        if ((await txn.Get(Keyspace.Edges, out)) === undefined)
        {
            throw new EdgeError(EdgeErrorCode.MissingEdge, EdgeStore.ErrMissing + EdgeStore.Label(relationship, from, to));
        }
        txn.Delete(Keyspace.Edges, out);
        txn.Delete(Keyspace.Edges, FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.In, to, position, from));
    }

    /** Streams the node's neighbours and edge positions in key order, without properties: one key per edge, no Gets. */
    public async *Adjacent(txn: IReadTransaction, relationship: MemberDef, node: bigint, direction: EdgeDirection): AsyncIterable<IAdjacent>
    {
        EdgeStore.RequireRelationship(relationship);
        InternalId.Require(node);
        const range = FormatKeys.EdgeRange(EdgeStore.Partition, relationship.Id, direction, node);
        for await (const [key] of txn.Scan(Keyspace.Edges, range))
        {
            const parts = TupleCodec.Decode(key);
            yield { Node: parts[5] as bigint, Position: parts[4] as Uint8Array };
        }
    }

    /**
     * Streams the node's edges in key order (position, then other id). `Node` is the node at the far
     * end. In direction costs one Get per neighbor to fetch the properties from the matching Out key;
     * use Adjacent when the properties are not needed.
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

    /** Position of the edge from -> to, or undefined when there is none. Cost depends on the relationship shape (see class comment). */
    public async PositionOf(txn: IReadTransaction, relationship: MemberDef, from: bigint, to: bigint): Promise<Uint8Array | undefined>
    {
        EdgeStore.RequireRelationship(relationship);
        InternalId.Require(from);
        InternalId.Require(to);
        return this.FindPosition(txn, relationship, from, to);
    }

    private async FindPosition(txn: IReadTransaction, relationship: MemberDef, from: bigint, to: bigint): Promise<Uint8Array | undefined>
    {
        if (relationship.Ordered === true)
        {
            // In keys carry the position: scan the target's In range, O(in-degree of `to`) (ruling R33).
            const range = FormatKeys.EdgeRange(EdgeStore.Partition, relationship.Id, EdgeDirection.In, to);
            for await (const [key] of txn.Scan(Keyspace.Edges, range))
            {
                const parts = TupleCodec.Decode(key);
                if (parts[5] === from)
                {
                    return parts[4] as Uint8Array;
                }
            }
            return undefined;
        }
        if (relationship.Many === true)
        {
            const key = FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from, EdgeStore.EmptyPosition, to);
            return (await txn.Get(Keyspace.Edges, key)) === undefined ? undefined : EdgeStore.EmptyPosition;
        }
        const first = (await this.Siblings(txn, relationship, from, 1))[0];
        return first !== undefined && first.Other === to ? first.Position : undefined;
    }

    /** The edges a renumbering in this write transaction rewrote since the last call; clears the record. */
    public TakeRenumbered(txn: IWriteTransaction): IRenumberedEdge[]
    {
        const moved = this.renumbered.get(txn) ?? [];
        this.renumbered.delete(txn);
        return moved;
    }

    /**
     * Position for a new edge of an ordered relationship. With After: one bounded scan (limit 2) from
     * that position gives the sibling itself and its neighbour; Before (when also given) must be that
     * neighbour. With only Before: the preceding sibling by one reverse scan of limit 1. With neither: an
     * append after the last sibling, also one reverse scan of limit 1.
     */
    private async OrderedPosition(txn: IReadTransaction, relationship: MemberDef, from: bigint, after: Uint8Array | null, before: Uint8Array | null): Promise<Uint8Array>
    {
        if (after === null)
        {
            if (before === null)
            {
                return FractionalPosition.Between((await this.Last(txn, relationship, from))?.Position ?? null, null);
            }
            const at = await this.Siblings(txn, relationship, from, 1, before);
            if (at[0] === undefined || TupleCodec.Compare(at[0].Position, before) !== 0)
            {
                throw new EdgeError(EdgeErrorCode.UnknownSibling, EdgeStore.ErrSibling);
            }
            return FractionalPosition.Between((await this.Last(txn, relationship, from, before))?.Position ?? null, before);
        }
        const window = await this.Siblings(txn, relationship, from, 2, after);
        if (window[0] === undefined || TupleCodec.Compare(window[0].Position, after) !== 0)
        {
            throw new EdgeError(EdgeErrorCode.UnknownSibling, EdgeStore.ErrSibling);
        }
        const next = window[1]?.Position ?? null;
        if (before === null)
        {
            return FractionalPosition.Between(after, next);
        }
        const at = await this.Siblings(txn, relationship, from, 1, before);
        if (at[0] === undefined || TupleCodec.Compare(at[0].Position, before) !== 0)
        {
            throw new EdgeError(EdgeErrorCode.UnknownSibling, EdgeStore.ErrSibling);
        }
        if (TupleCodec.Compare(after, before) >= 0)
        {
            throw new EdgeError(EdgeErrorCode.InvalidOrder, EdgeStore.ErrBounds);
        }
        if (next === null || TupleCodec.Compare(next, before) !== 0)
        {
            throw new EdgeError(EdgeErrorCode.NotAdjacent, EdgeStore.ErrNotAdjacent);
        }
        return FractionalPosition.Between(after, before);
    }

    /** The source's last Out edge (below position `below` when given), by one reverse scan of limit 1. */
    private async Last(txn: IReadTransaction, relationship: MemberDef, from: bigint, below?: Uint8Array): Promise<ISibling | undefined>
    {
        const all = FormatKeys.EdgeRange(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from);
        const range = below === undefined ? all : { Start: all.Start, End: FormatKeys.EdgeAt(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from, below) };
        for await (const [key] of txn.Scan(Keyspace.Edges, range, EdgeStore.LastOnly))
        {
            const parts = TupleCodec.Decode(key);
            return { Position: parts[4] as Uint8Array, Other: parts[5] as bigint };
        }
        return undefined;
    }

    /**
     * Rewrites every Out/In key pair of the (source, relationship) list with evenly spaced short
     * positions (FractionalPosition.Sequence), keeping order and edge values. Collects first, then
     * mutates (no write while a scan of the keyspace is open). Returns old position (hex) to new position.
     */
    private async Renumber(txn: IWriteTransaction, relationship: MemberDef, from: bigint): Promise<Map<string, Uint8Array>>
    {
        const range = FormatKeys.EdgeRange(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from);
        const siblings: IStoredSibling[] = [];
        for await (const [key, value] of txn.Scan(Keyspace.Edges, range))
        {
            const parts = TupleCodec.Decode(key);
            siblings.push({ Position: parts[4] as Uint8Array, Other: parts[5] as bigint, Value: value });
        }
        const positions = FractionalPosition.Sequence(siblings.length);
        const moved = new Map<string, Uint8Array>();
        for (const s of siblings)
        {
            txn.Delete(Keyspace.Edges, FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from, s.Position, s.Other));
            txn.Delete(Keyspace.Edges, FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.In, s.Other, s.Position, from));
        }
        let record = this.renumbered.get(txn);
        if (record === undefined)
        {
            record = [];
            this.renumbered.set(txn, record);
        }
        siblings.forEach((s, i) =>
        {
            const position = positions[i] as Uint8Array;
            txn.Put(Keyspace.Edges, FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from, position, s.Other), s.Value);
            txn.Put(Keyspace.Edges, FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.In, s.Other, position, from), new Uint8Array(0));
            moved.set(EdgeStore.Hex(s.Position), position);
            record.push({ Relationship: relationship, From: from, To: s.Other });
        });
        return moved;
    }

    /** The renumbered position of a sibling position (null stays null). */
    private static Moved(moved: ReadonlyMap<string, Uint8Array>, position: Uint8Array | null): Uint8Array | null
    {
        return position === null ? null : (moved.get(EdgeStore.Hex(position)) ?? position);
    }

    private static Hex(bytes: Uint8Array): string
    {
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
    }

    /** Encoded length of the longer of the edge's two keys. */
    private static KeyLength(relationship: MemberDef, from: bigint, to: bigint, position: Uint8Array): number
    {
        return Math.max(
            FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from, position, to).length,
            FormatKeys.Edge(EdgeStore.Partition, relationship.Id, EdgeDirection.In, to, position, from).length);
    }

    /** The source's Out edges in key order, starting at position `start` (inclusive) when given. */
    private async Siblings(txn: IReadTransaction, relationship: MemberDef, from: bigint, limit?: number, start?: Uint8Array): Promise<ISibling[]>
    {
        const all = FormatKeys.EdgeRange(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from);
        const range = start === undefined ? all : { Start: FormatKeys.EdgeAt(EdgeStore.Partition, relationship.Id, EdgeDirection.Out, from, start), End: all.End };
        const out: ISibling[] = [];
        for await (const [key] of txn.Scan(Keyspace.Edges, range, limit === undefined ? undefined : { Limit: limit }))
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
