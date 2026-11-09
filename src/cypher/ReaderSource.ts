import type { IndexDef } from '../catalog/CatalogTypes.js';
import { ValueType } from '../catalog/ValueType.js';
import { DateTimeValue, DateValue, type CellValue } from '../columns/CellValue.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import type { GraphReader } from '../GraphReader.js';
import { RelDirection } from './CypherEnums.js';
import { CypherSemanticError } from './CypherError.js';
import { CypherNode } from './CypherNode.js';
import type { ICypherSource, IExpandRow } from './CypherSource.js';
import { LabelResolver } from './LabelResolver.js';

/**
 * ICypherSource over one scoped GraphReader (or a GraphTransaction, which reads its snapshot). Every read goes
 * through the reader, so invisible nodes never surface, hidden members are absent and every read is recorded.
 * Nodes are loaded whole (ReadNode) when yielded. The reader stays owned by the caller.
 */
export class ReaderSource implements ICypherSource
{
    private static readonly UnknownDirection = 'unknown relationship direction';
    private static readonly StepSeparator = '\u0000';

    private static readonly Int64Min = -(2n ** 63n);
    private static readonly Int64Limit = 2n ** 63n;

    private readonly labels: LabelResolver;
    private readonly relationships: ReadonlySet<string>;
    private readonly indexCache = new Map<string, IndexDef | undefined>();

    constructor(private readonly reader: GraphReader)
    {
        this.labels = new LabelResolver(reader.Catalog);
        this.relationships = new Set(reader.Catalog.Relationships());
    }

    public ResolveLabel(label: string): string
    {
        return this.labels.Resolve(label);
    }

    public HasRelationship(name: string): boolean
    {
        return this.relationships.has(name);
    }

    public IsA(node: CypherNode, label: string): boolean
    {
        return this.reader.Catalog.IsA(node.Concept, this.labels.Resolve(label));
    }

    public async *ScanLabel(label: string): AsyncIterable<CypherNode>
    {
        yield* this.Scan(this.labels.Resolve(label));
    }

    /** Root concepts in definition order, each with its subtypes (ScanNodes order): every concept exactly once. */
    public async *ScanAll(): AsyncIterable<CypherNode>
    {
        for (const def of this.reader.Catalog.Definitions())
        {
            if (!def.IsAspect && def.Parent === null)
            {
                yield* this.Scan(def.Name);
            }
        }
    }

    public async Node(publicId: string): Promise<CypherNode | undefined>
    {
        const view = await this.reader.ReadNode(publicId);
        return view === undefined ? undefined : CypherNode.FromView(view);
    }

    /**
     * Outgoing and Incoming map to the reader's Links (Out / In), narrowed to `relationship` when given (only
     * that relationship's edges are read and recorded).
     * Undirected walks Out then In and reports each (relationship, far node) pair once, so a self-loop, seen
     * from both ends, appears once (TODL deduplicated by far node).
     */
    public async *Expand(publicId: string, relationship: string | undefined, direction: RelDirection): AsyncIterable<IExpandRow>
    {
        switch (direction)
        {
            case RelDirection.Outgoing:
                yield* this.Walk(publicId, relationship, EdgeDirection.Out, undefined);
                return;
            case RelDirection.Incoming:
                yield* this.Walk(publicId, relationship, EdgeDirection.In, undefined);
                return;
            case RelDirection.Undirected:
            {
                const seen = new Set<string>();
                yield* this.Walk(publicId, relationship, EdgeDirection.Out, seen);
                yield* this.Walk(publicId, relationship, EdgeDirection.In, seen);
                return;
            }
        }
        throw new CypherSemanticError(`${ReaderSource.UnknownDirection} "${String(direction)}"`);
    }

    public IndexFor(label: string, member: string): string | undefined
    {
        return this.FindIndex(this.labels.Resolve(label), member)?.Name;
    }

    /**
     * Seeks the usable index for the label and member (see IndexFor) with the value converted to the member's
     * index element type, then keeps the nodes that are the label (an index on an ancestor or an aspect covers
     * more nodes than the label). Values that cannot equal any stored value seek nothing.
     */
    public SeekEqual(label: string, member: string, value: CellValue): AsyncIterable<CypherNode> | undefined
    {
        const name = this.labels.Resolve(label);
        const index = this.FindIndex(name, member);
        if (index === undefined)
        {
            return undefined;
        }
        const key = ReaderSource.SeekKey(this.reader.Catalog.IndexMembers(index)[0]!.Type, value);
        return key === undefined ? ReaderSource.NoNodes() : this.Seek(index.Name, name, key);
    }

    private FindIndex(label: string, member: string): IndexDef | undefined
    {
        const cacheKey = label + ReaderSource.StepSeparator + member;
        if (!this.indexCache.has(cacheKey))
        {
            const catalog = this.reader.Catalog;
            const candidates = catalog.IsAspect(label) ? catalog.Indexes().filter(i => i.On === label) : catalog.IndexesOn(label);
            this.indexCache.set(cacheKey, candidates.find(i => i.Where === undefined && catalog.IndexMembers(i)[0]?.Name === member));
        }
        return this.indexCache.get(cacheKey);
    }

    private async *Seek(index: string, label: string, key: CellValue): AsyncIterable<CypherNode>
    {
        for await (const publicId of this.reader.SeekIndex(index, { Prefix: [key] }))
        {
            const node = await this.Node(publicId);
            if (node !== undefined && this.reader.Catalog.IsA(node.Concept, label))
            {
                yield node;
            }
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
                return typeof value === 'number' && Number.isInteger(value) && value >= Number(ReaderSource.Int64Min) && value < Number(ReaderSource.Int64Limit) ? BigInt(value) : undefined;
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

    private async *Scan(name: string): AsyncIterable<CypherNode>
    {
        for await (const publicId of this.reader.ScanNodes(name))
        {
            const node = await this.Node(publicId);
            if (node !== undefined)
            {
                yield node;
            }
        }
    }

    private async *Walk(publicId: string, relationship: string | undefined, direction: EdgeDirection, seen: Set<string> | undefined): AsyncIterable<IExpandRow>
    {
        for (const link of await this.reader.Links(publicId, direction, relationship))
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
