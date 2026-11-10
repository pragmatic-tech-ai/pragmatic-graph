import { ValueCodec } from '../columns/ValueCodec.js';
import { ValueType } from '../catalog/ValueType.js';
import { DateTimeValue, DateValue, type CellValue } from '../columns/CellValue.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import type { GraphReader, ILinkView, IReadProbe } from '../GraphReader.js';
import { CatalogSource } from './CatalogSource.js';
import { RelDirection } from './CypherEnums.js';
import { CypherSemanticError } from './CypherError.js';
import { CypherNode } from './CypherNode.js';
import type { IExpandRow } from './CypherSource.js';

/**
 * ICypherSource over one scoped GraphReader (or a GraphTransaction, which reads its snapshot). Every read goes
 * through the reader, so invisible nodes never surface, hidden members are absent and every read is recorded.
 * Nodes are loaded whole (ReadNode) when yielded. The reader stays owned by the caller.
 */
export class ReaderSource extends CatalogSource
{
    private static readonly UnknownDirection = 'unknown relationship direction';
    private static readonly StepSeparator = '\u0000';

    private static readonly Int64Min = -(2n ** 63n);
    private static readonly Int64Limit = 2n ** 63n;
    private static readonly Int64MinNumber = Number(ReaderSource.Int64Min);
    private static readonly Int64LimitNumber = Number(ReaderSource.Int64Limit);

    constructor(private readonly reader: GraphReader)
    {
        super(reader.Catalog, reader.Scope.HiddenNames);
    }

    /** The engine's nodes of the label; a hint is for External connectors and is not used here. */
    public async *ScanLabel(label: string, probe?: IReadProbe): AsyncIterable<CypherNode>
    {
        yield* this.Scan(this.labels.Resolve(label), probe);
    }

    /** Root concepts in definition order, each with its subtypes (ScanNodes order): every concept exactly once. */
    public async *ScanAll(probe?: IReadProbe): AsyncIterable<CypherNode>
    {
        for (const root of this.RootConcepts())
        {
            yield* this.Scan(root, probe);
        }
    }

    public async Node(publicId: string): Promise<CypherNode | undefined>
    {
        const view = await this.reader.ReadNode(publicId);
        return view === undefined ? undefined : CypherNode.FromView(view);
    }

    /**
     * Outgoing and Incoming map to the reader's Links (Out / In), narrowed to `relationship` when given (only
     * that relationship's edges are read and recorded). Undirected walks Out then In and reports each (relationship,
     * far node) pair once, so a self-loop, seen from both ends, appears once (TODL deduplicated by far node).
     */
    public async *Expand(publicId: string, relationship: string | undefined, direction: RelDirection, probe?: IReadProbe): AsyncIterable<IExpandRow>
    {
        switch (direction)
        {
            case RelDirection.Outgoing:
                yield* this.Walk(publicId, relationship, EdgeDirection.Out, undefined, probe);
                return;
            case RelDirection.Incoming:
                yield* this.Walk(publicId, relationship, EdgeDirection.In, undefined, probe);
                return;
            case RelDirection.Undirected:
            {
                const seen = new Set<string>();
                yield* this.Walk(publicId, relationship, EdgeDirection.Out, seen, probe);
                yield* this.Walk(publicId, relationship, EdgeDirection.In, seen, probe);
                return;
            }
        }
        throw new CypherSemanticError(`${ReaderSource.UnknownDirection} "${String(direction)}"`);
    }

    /**
     * The node's outgoing links as the reader sees them (Links Out: hidden relationships and invisible targets
     * omitted).
     */
    public OutLinks(publicId: string): Promise<readonly ILinkView[]>
    {
        return this.reader.Links(publicId, EdgeDirection.Out);
    }

    /**
     * Seeks the usable index for the label and member (see IndexFor) with the value converted to the member's
     * index element type, then keeps the nodes that are the label (an index on an ancestor or an aspect covers
     * more nodes than the label). Values that cannot equal any stored value seek nothing.
     */
    public SeekEqual(label: string, member: string, value: CellValue, probe?: IReadProbe): AsyncIterable<CypherNode> | undefined
    {
        const name = this.labels.Resolve(label);
        const index = this.FindIndex(name, member);
        if (index === undefined)
        {
            return undefined;
        }
        const type = this.catalog.IndexMembers(index)[0]!.Type;
        const key = ReaderSource.SeekKey(type, value);
        return key === undefined || !ReaderSource.Encodable(type!, key) ? ReaderSource.NoNodes() : this.Seek(index.Name, name, key, probe);
    }

    private async *Seek(index: string, label: string, key: CellValue, probe: IReadProbe | undefined): AsyncIterable<CypherNode>
    {
        for await (const publicId of this.reader.SeekIndex(index, { Prefix: [key] }, probe))
        {
            const node = await this.Node(publicId);
            if (node !== undefined && this.catalog.IsA(node.Concept, label))
            {
                yield node;
            }
        }
    }

    /** True when the codec accepts the value (a lone-surrogate string, say, cannot be stored, so it equals nothing). */
    private static Encodable(type: ValueType, key: CellValue): boolean
    {
        try
        {
            ValueCodec.Check(type, key);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static async *NoNodes(): AsyncIterable<CypherNode>
    {
        // An equality that no stored value can satisfy.
    }

    /**
     * The index element that equals the value under the equality filter's numeric rules (exact mathematical
     * comparison: an Int64 against a Float64 member seeks the float only when it is exact; a Float64 against an
     * Int64 member seeks the integer only when integral and in range), or undefined when nothing can equal it.
     */
    private static SeekKey(type: ValueType | undefined, value: CellValue): CellValue | undefined
    {
        switch (type)
        {
            case ValueType.Int64:
                if (typeof value === 'bigint')
                {
                    return value;
                }
                return typeof value === 'number' && Number.isInteger(value) && value >= ReaderSource.Int64MinNumber && value < ReaderSource.Int64LimitNumber ? BigInt(value) : undefined;
            case ValueType.Float64:
                if (typeof value === 'number')
                {
                    return Number.isNaN(value) ? undefined : value === 0 ? 0 : value;
                }
                return typeof value === 'bigint' && BigInt(Number(value)) === value ? Number(value) : undefined;
            case ValueType.Boolean:
                return typeof value === 'boolean' ? value : undefined;
            case ValueType.String:
                return typeof value === 'string' ? value : undefined;
            case ValueType.Date:
                return value instanceof DateValue ? value : undefined;
            case ValueType.DateTime:
                return value instanceof DateTimeValue ? value : undefined;
            default:
                return undefined;
        }
    }

    private async *Scan(name: string, probe: IReadProbe | undefined): AsyncIterable<CypherNode>
    {
        for await (const publicId of this.reader.ScanNodes(name, probe))
        {
            const node = await this.Node(publicId);
            if (node !== undefined)
            {
                yield node;
            }
        }
    }

    private async *Walk(publicId: string, relationship: string | undefined, direction: EdgeDirection, seen: Set<string> | undefined, probe: IReadProbe | undefined): AsyncIterable<IExpandRow>
    {
        for (const link of await this.reader.Links(publicId, direction, relationship, probe))
        {
            if (seen !== undefined)
            {
                const key = link.Relationship + ReaderSource.StepSeparator + link.PublicId;
                if (seen.has(key))
                {
                    continue;
                }
                seen.add(key);
            }
            const target = await this.Node(link.PublicId);
            if (target !== undefined)
            {
                yield { Relationship: link.Relationship, Target: target };
            }
        }
    }
}
