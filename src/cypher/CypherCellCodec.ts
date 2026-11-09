import { DateTimeValue, DateValue, DurationValue, type CellValue } from '../columns/CellValue.js';
import type { ILinkView } from '../GraphReader.js';
import { CypherError } from './CypherError.js';
import { CypherNode } from './CypherNode.js';
import { CypherValue, NodeValue, NullValue, ScalarValue, type CypherScalar } from './CypherValue.js';
import { ScalarSemantics } from './ScalarSemantics.js';
import { ListValue, MapValue, PathValue, RelValue } from './StructuredValues.js';
import { TemporalText } from './TemporalText.js';

/** A relationship cell. */
export type RelDto = { from: string; type: string; to: string };

/** A node cell: identity, every visible property (null when unset) and the outgoing links by relationship. */
export interface NodeCellDto
{
    readonly $node: {
        readonly id: string;
        readonly concept: string;
        readonly owner: string;
        readonly properties: { readonly [member: string]: CypherValueDto };
        readonly links: { readonly [relationship: string]: readonly string[] };
    };
}

/** One result cell, JSON-shaped (see CypherCellCodec). */
export type CypherValueDto = NodeCellDto | boolean | number | string | null | CypherValueDto[] | { [k: string]: CypherValueDto };

/**
 * The engine-neutral, JSON-shaped encoding of result cells, and its inverse.
 *
 * Scalars: a boolean or string is itself; an Int64 within +-(2^53 - 1) and every finite Float64 is a JSON number; an
 * Int64 outside that range is `{ "$int": "<decimal>" }`; a NaN or infinite Float64 is
 * `{ "$float": "NaN" | "Infinity" | "-Infinity" }` (JSON has no such numbers); a Date `{ "$date": "YYYY-MM-DD" }`; a DateTime
 * `{ "$datetime": "<ISO instant, UTC>", "zone": "<IANA>" }`; a Duration `{ "$duration": "<ISO-8601>" }`. Null is
 * null, a list an array, a relationship `{ from, type, to }`, a path `{ nodes, relationships }`, a node
 * `{ "$node": { id, concept, owner, properties, links } }` (its links must have been filled). A map is a plain
 * object, except a map whose keys have the shape of a tag (a sole `$node`, `$map`, `$int`, `$float`, `$date` or
 * `$duration` key, or exactly `$datetime` and `zone`) is escaped as `{ "$map": entries }`, so nothing a query
 * builds can pass for a node or a typed scalar.
 *
 * Decode inverts Encode exactly for every cell except what JSON cannot tell apart: a JSON number decodes as an
 * Int64 when it is a safe integer and as a Float64 otherwise (so an integral Float64 such as 2.0 comes back as
 * the Int64 2, equal under Cypher `=`), and a relationship or path cell decodes as the map it looks like.
 */
export class CypherCellCodec
{
    public static readonly NodeKey = '$node';
    public static readonly MapKey = '$map';
    public static readonly IntKey = '$int';
    public static readonly FloatKey = '$float';
    public static readonly DateKey = '$date';
    public static readonly DateTimeKey = '$datetime';
    public static readonly ZoneKey = 'zone';
    public static readonly DurationKey = '$duration';

    private static readonly SafeMax = BigInt(Number.MAX_SAFE_INTEGER);
    private static readonly SoleTags: ReadonlySet<string> = new Set([
        CypherCellCodec.NodeKey, CypherCellCodec.MapKey, CypherCellCodec.IntKey, CypherCellCodec.FloatKey, CypherCellCodec.DateKey, CypherCellCodec.DurationKey,
    ]);
    private static readonly IntPattern = /^-?\d+$/;
    private static readonly LinksNotFilled = 'a result node must have its links filled before it is encoded: ';
    private static readonly Malformed = 'malformed result cell: ';
    private static readonly NotEncodable = 'value cannot be encoded as a result cell: ';

    /** The cell of a value; every node in it must have its links filled (CypherEngine does so). */
    public static Encode(value: CypherValue): CypherValueDto
    {
        if (value instanceof ScalarValue) return CypherCellCodec.EncodeScalar(value.Value);
        if (value instanceof NullValue) return null;
        if (value instanceof NodeValue) return CypherCellCodec.EncodeNode(value.Node);
        if (value instanceof ListValue) return value.Items.map(i => CypherCellCodec.Encode(i));
        if (value instanceof MapValue)
        {
            const entries: { [k: string]: CypherValueDto } = {};
            for (const [k, v] of value.Entries) CypherCellCodec.Put(entries, k, CypherCellCodec.Encode(v));
            return CypherCellCodec.EncodeMap(entries);
        }
        if (value instanceof RelValue) return CypherCellCodec.EncodeRel(value);
        if (value instanceof PathValue)
        {
            return { nodes: value.Nodes.map(n => CypherCellCodec.EncodeNode(n.Node)), relationships: value.Rels.map(r => CypherCellCodec.EncodeRel(r)) };
        }
        throw new CypherError(CypherCellCodec.NotEncodable + value.constructor.name);
    }

    /** The cell of an engine cell value (a scalar or null). */
    public static EncodeScalar(cell: CellValue): CypherValueDto
    {
        if (typeof cell === 'bigint')
        {
            const safe = cell <= CypherCellCodec.SafeMax && cell >= -CypherCellCodec.SafeMax;
            return safe ? Number(cell) : { [CypherCellCodec.IntKey]: cell.toString() };
        }
        if (typeof cell === 'number' && !Number.isFinite(cell)) return { [CypherCellCodec.FloatKey]: ScalarSemantics.NonFiniteText(cell) };
        if (cell instanceof DateValue) return { [CypherCellCodec.DateKey]: TemporalText.FormatDate(cell) };
        if (cell instanceof DateTimeValue)
        {
            return { [CypherCellCodec.DateTimeKey]: TemporalText.FormatInstant(cell), [CypherCellCodec.ZoneKey]: cell.Zone };
        }
        if (cell instanceof DurationValue) return { [CypherCellCodec.DurationKey]: TemporalText.FormatDuration(cell) };
        return cell;
    }

    public static EncodeNode(node: CypherNode): NodeCellDto
    {
        const links = node.Links;
        if (links === undefined) throw new CypherError(CypherCellCodec.LinksNotFilled + node.PublicId);
        const properties: { [member: string]: CypherValueDto } = {};
        for (const [member, cell] of node.Properties) CypherCellCodec.Put(properties, member, CypherCellCodec.EncodeScalar(cell));
        const byRelationship: { [relationship: string]: string[] } = {};
        for (const link of links)
        {
            const targets = Object.hasOwn(byRelationship, link.Relationship) ? byRelationship[link.Relationship]! : [];
            if (targets.length === 0) CypherCellCodec.Put(byRelationship, link.Relationship, targets);
            targets.push(link.PublicId);
        }
        return { $node: { id: node.PublicId, concept: node.Concept, owner: node.Owner, properties, links: byRelationship } };
    }

    /** A map cell from encoded entries: plain, or `$map`-escaped when its keys have a tag's shape. */
    public static EncodeMap(entries: { [k: string]: CypherValueDto }): CypherValueDto
    {
        return CypherCellCodec.IsTagShape(Object.keys(entries)) ? { [CypherCellCodec.MapKey]: entries } : entries;
    }

    /** The node cell's body when `cell` is a node cell; undefined for every other cell. */
    public static AsNode(cell: unknown): NodeCellDto['$node'] | undefined
    {
        if (!CypherCellCodec.IsObject(cell)) return undefined;
        const keys = Object.keys(cell);
        return keys.length === 1 && keys[0] === CypherCellCodec.NodeKey ? (cell as unknown as NodeCellDto).$node : undefined;
    }

    /** A map cell's entries (unwrapping the `$map` escape); undefined for a node, a tagged scalar, a list, a scalar or null. */
    public static AsMap(cell: unknown): { [k: string]: CypherValueDto } | undefined
    {
        if (!CypherCellCodec.IsObject(cell)) return undefined;
        const keys = Object.keys(cell);
        if (!CypherCellCodec.IsTagShape(keys)) return cell as { [k: string]: CypherValueDto };
        return keys[0] === CypherCellCodec.MapKey ? cell[CypherCellCodec.MapKey] as { [k: string]: CypherValueDto } : undefined;
    }

    /** The value a cell encodes (see the class comment for the two JSON-inherent ambiguities). CypherError when malformed. */
    public static Decode(cell: CypherValueDto): CypherValue
    {
        if (cell === null) return NullValue.Instance;
        if (typeof cell === 'number') return new ScalarValue(ScalarSemantics.FromNumber(cell));
        if (typeof cell === 'string' || typeof cell === 'boolean') return new ScalarValue(cell);
        if (Array.isArray(cell)) return new ListValue(cell.map(c => CypherCellCodec.Decode(c)));
        if (!CypherCellCodec.IsObject(cell)) throw new CypherError(CypherCellCodec.Malformed + String(cell));
        const keys = Object.keys(cell);
        if (!CypherCellCodec.IsTagShape(keys)) return CypherCellCodec.DecodeEntries(cell);
        const record = cell as { readonly [k: string]: unknown };
        if (keys.length === 2) return new ScalarValue(CypherCellCodec.DecodeDateTime(record));
        const key = keys[0]!;
        switch (key)
        {
            case CypherCellCodec.NodeKey:
                return new NodeValue(CypherCellCodec.DecodeNode(record[key]));
            case CypherCellCodec.MapKey:
                if (!CypherCellCodec.IsObject(record[key])) throw new CypherError(CypherCellCodec.Malformed + key);
                return CypherCellCodec.DecodeEntries(record[key] as { [k: string]: CypherValueDto });
            default:
                return new ScalarValue(CypherCellCodec.DecodeTagged(key, record[key]));
        }
    }

    private static EncodeRel(rel: RelValue): RelDto
    {
        return { from: rel.FromId, type: rel.Type, to: rel.ToId };
    }

    private static DecodeEntries(record: { readonly [k: string]: CypherValueDto }): MapValue
    {
        const entries = new Map<string, CypherValue>();
        for (const [k, v] of Object.entries(record)) entries.set(k, CypherCellCodec.Decode(v));
        return new MapValue(entries);
    }

    // A scalar property cell of a node: a scalar, a tagged scalar or null; never a list, map or node.
    private static DecodeCell(cell: unknown): CellValue
    {
        if (cell === null) return null;
        if (typeof cell === 'number' || typeof cell === 'string' || typeof cell === 'boolean')
        {
            return (CypherCellCodec.Decode(cell) as ScalarValue).Value;
        }
        if (CypherCellCodec.IsObject(cell))
        {
            const keys = Object.keys(cell);
            const value = CypherCellCodec.IsTagShape(keys) && keys[0] !== CypherCellCodec.NodeKey && keys[0] !== CypherCellCodec.MapKey
                ? CypherCellCodec.Decode(cell as CypherValueDto)
                : undefined;
            if (value instanceof ScalarValue) return value.Value;
        }
        throw new CypherError(CypherCellCodec.Malformed + CypherCellCodec.NodeKey);
    }

    private static DecodeTagged(key: string, text: unknown): CypherScalar
    {
        if (typeof text !== 'string') throw new CypherError(CypherCellCodec.Malformed + key);
        try
        {
            switch (key)
            {
                case CypherCellCodec.IntKey:
                    if (!CypherCellCodec.IntPattern.test(text)) break;
                    return ScalarSemantics.CheckInt64(BigInt(text));
                case CypherCellCodec.FloatKey:
                {
                    const value = ScalarSemantics.ParseNonFinite(text);
                    if (value === undefined) break;
                    return value;
                }
                case CypherCellCodec.DateKey:
                    return TemporalText.ParseDate(text);
                case CypherCellCodec.DurationKey:
                    return TemporalText.ParseDuration(text);
            }
        }
        catch (e)
        {
            throw new CypherError(CypherCellCodec.Malformed + key, undefined, e);
        }
        throw new CypherError(CypherCellCodec.Malformed + key);
    }

    // The zone is taken as stored (not validated), so every engine DateTime decodes back.
    private static DecodeDateTime(record: { readonly [k: string]: unknown }): DateTimeValue
    {
        const text = record[CypherCellCodec.DateTimeKey];
        const zone = record[CypherCellCodec.ZoneKey];
        if (typeof text !== 'string' || typeof zone !== 'string') throw new CypherError(CypherCellCodec.Malformed + CypherCellCodec.DateTimeKey);
        try
        {
            return new DateTimeValue(TemporalText.ParseInstant(text), zone);
        }
        catch (e)
        {
            throw new CypherError(CypherCellCodec.Malformed + CypherCellCodec.DateTimeKey, undefined, e);
        }
    }

    private static DecodeNode(body: unknown): CypherNode
    {
        const b = body as { id?: unknown; concept?: unknown; owner?: unknown; properties?: unknown; links?: unknown };
        if (!CypherCellCodec.IsObject(body) || typeof b.id !== 'string' || typeof b.concept !== 'string' || typeof b.owner !== 'string'
            || !CypherCellCodec.IsObject(b.properties) || !CypherCellCodec.IsObject(b.links))
        {
            throw new CypherError(CypherCellCodec.Malformed + CypherCellCodec.NodeKey);
        }
        const properties = new Map<string, CellValue>();
        for (const [member, cell] of Object.entries(b.properties)) properties.set(member, CypherCellCodec.DecodeCell(cell));
        const links: ILinkView[] = [];
        for (const [relationship, targets] of Object.entries(b.links))
        {
            if (!Array.isArray(targets) || targets.some(t => typeof t !== 'string')) throw new CypherError(CypherCellCodec.Malformed + CypherCellCodec.NodeKey);
            for (const target of targets as string[]) links.push({ Relationship: relationship, PublicId: target });
        }
        const node = new CypherNode(b.id, b.concept, b.owner, properties);
        node.FillLinks(links);
        return node;
    }

    // Keys of a tag: a sole $node, $map, $int, $float, $date or $duration key, or exactly $datetime and zone.
    private static IsTagShape(keys: readonly string[]): boolean
    {
        if (keys.length === 1) return CypherCellCodec.SoleTags.has(keys[0]!);
        return keys.length === 2 && keys.includes(CypherCellCodec.DateTimeKey) && keys.includes(CypherCellCodec.ZoneKey);
    }

    private static IsObject(cell: unknown): cell is Record<string, unknown>
    {
        return typeof cell === 'object' && cell !== null && !Array.isArray(cell);
    }

    // An own data property even for a key such as "__proto__", which plain assignment would not create.
    private static Put<T>(target: { [k: string]: T }, key: string, value: T): void
    {
        Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    }
}
