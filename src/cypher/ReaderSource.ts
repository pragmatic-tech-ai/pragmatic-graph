import type { CellValue } from '../columns/CellValue.js';
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

    private readonly labels: LabelResolver;
    private readonly relationships: ReadonlySet<string>;

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

    /** No index seeks yet (plan 2 Task 4): callers fall back to a label scan and a filter. */
    public SeekEqual(_label: string, _member: string, _value: CellValue): AsyncIterable<CypherNode> | undefined
    {
        return undefined;
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
