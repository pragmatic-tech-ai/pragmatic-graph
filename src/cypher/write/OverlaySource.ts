import type { CellValue } from '../../columns/CellValue.js';
import { Binding, EvalContext } from '../Binding.js';
import { ComparisonOp, RelDirection } from '../CypherEnums.js';
import type { CypherNode } from '../CypherNode.js';
import type { ICypherSource, IExpandRow } from '../CypherSource.js';
import { NodeValue, NullValue, type CypherValue } from '../CypherValue.js';
import { BooleanExpression, Comparison, Literal, PropertyAccess } from '../Expression.js';
import { ListValue, MapValue, PathValue } from '../StructuredValues.js';
import type { PendingOverlay } from './PendingOverlay.js';

/**
 * The graph as one write query sees it: the transaction's snapshot (`base`, a ReaderSource over the
 * GraphTransaction, which reads its snapshot only, R30) with the query's own pending writes laid over it.
 * Created nodes appear in scans, expands and seeks of matching labels, changed properties override, deleted
 * nodes and removed edges disappear, and a deleted node is never the label (R82 d). Read-your-writes exists
 * only here, never in the transaction.
 *
 * Index seeks stay index seeks: SeekEqual merges the base seek (minus every node the query touched) with the
 * touched nodes re-checked by the equality filter itself, so a seek over the overlay returns exactly what a
 * filtered scan of the overlay would.
 */
export class OverlaySource implements ICypherSource
{
    private static readonly SeekVariable = 'n';
    private static readonly StepSeparator = '\u0000';

    constructor(private readonly base: ICypherSource, private readonly overlay: PendingOverlay)
    {
    }

    public ResolveLabel(label: string): string
    {
        return this.base.ResolveLabel(label);
    }

    public HasRelationship(name: string): boolean
    {
        return this.base.HasRelationship(name);
    }

    public IsA(node: CypherNode, label: string): boolean
    {
        return !this.overlay.IsDeleted(node.PublicId) && this.base.IsA(node, label);
    }

    public async *ScanLabel(label: string): AsyncIterable<CypherNode>
    {
        for await (const node of this.base.ScanLabel(label))
        {
            const current = this.Current(node);
            if (current !== undefined) yield current;
        }
        for (const node of this.overlay.CreatedNodes())
        {
            if (this.base.IsA(node, label)) yield node;
        }
    }

    public async *ScanAll(): AsyncIterable<CypherNode>
    {
        for await (const node of this.base.ScanAll())
        {
            const current = this.Current(node);
            if (current !== undefined) yield current;
        }
        yield* this.overlay.CreatedNodes();
    }

    public async Node(publicId: string): Promise<CypherNode | undefined>
    {
        if (this.overlay.IsTouched(publicId)) return this.overlay.Touched(publicId);
        return this.base.Node(publicId);
    }

    /** As ReaderSource.Expand (Undirected: Out then In, each (relationship, far node) once), over the overlay. */
    public async *Expand(publicId: string, relationship: string | undefined, direction: RelDirection): AsyncIterable<IExpandRow>
    {
        if (this.overlay.IsDeleted(publicId)) return;
        if (direction !== RelDirection.Undirected)
        {
            yield* this.Directed(publicId, relationship, direction);
            return;
        }
        const seen = new Set<string>();
        for (const way of [RelDirection.Outgoing, RelDirection.Incoming])
        {
            for await (const row of this.Directed(publicId, relationship, way))
            {
                const key = row.Relationship + OverlaySource.StepSeparator + row.Target.PublicId;
                if (seen.has(key)) continue;
                seen.add(key);
                yield row;
            }
        }
    }

    public IndexFor(label: string, member: string): string | undefined
    {
        return this.base.IndexFor(label, member);
    }

    public SeekEqual(label: string, member: string, value: CellValue): AsyncIterable<CypherNode> | undefined
    {
        const hits = this.base.SeekEqual(label, member, value);
        return hits === undefined ? undefined : this.MergedSeek(hits, label, member, value);
    }

    /**
     * The value as the query now sees it: a node it deleted becomes null (so is a path through one), a node it
     * touched its current state; lists and maps are refreshed element-wise. Untouched values are returned as is.
     */
    public Refresh(value: CypherValue): CypherValue
    {
        if (value instanceof NodeValue)
        {
            if (!this.overlay.IsTouched(value.Id)) return value;
            const current = this.overlay.Touched(value.Id);
            return current === undefined ? NullValue.Instance : new NodeValue(current);
        }
        if (value instanceof ListValue) return new ListValue(value.Items.map(i => this.Refresh(i)));
        if (value instanceof MapValue)
        {
            const entries = new Map<string, CypherValue>();
            for (const [k, v] of value.Entries) entries.set(k, this.Refresh(v));
            return new MapValue(entries);
        }
        if (value instanceof PathValue)
        {
            const nodes: NodeValue[] = [];
            for (const n of value.Nodes)
            {
                const current = this.Refresh(n);
                if (!(current instanceof NodeValue)) return NullValue.Instance;
                nodes.push(current);
            }
            return new PathValue(nodes, value.Rels);
        }
        return value;
    }

    public RefreshRow(row: Binding): Binding
    {
        return row.MapValues(v => this.Refresh(v));
    }

    private Current(node: CypherNode): CypherNode | undefined
    {
        return this.overlay.IsTouched(node.PublicId) ? this.overlay.Touched(node.PublicId) : node;
    }

    private async *Directed(publicId: string, relationship: string | undefined, direction: RelDirection): AsyncIterable<IExpandRow>
    {
        const outgoing = direction === RelDirection.Outgoing;
        if (!this.overlay.IsCreated(publicId))
        {
            for await (const row of this.base.Expand(publicId, relationship, direction))
            {
                const far = row.Target.PublicId;
                const removed = outgoing ? this.overlay.IsRemoved(publicId, row.Relationship, far) : this.overlay.IsRemoved(far, row.Relationship, publicId);
                if (removed) continue;
                const current = this.Current(row.Target);
                if (current !== undefined) yield { Relationship: row.Relationship, Target: current };
            }
        }
        for (const edge of this.overlay.AddedEdges())
        {
            if (relationship !== undefined && edge.Relationship !== relationship) continue;
            if ((outgoing ? edge.From : edge.To) !== publicId) continue;
            const target = await this.Node(outgoing ? edge.To : edge.From);
            if (target !== undefined) yield { Relationship: edge.Relationship, Target: target };
        }
    }

    private async *MergedSeek(hits: AsyncIterable<CypherNode>, label: string, member: string, value: CellValue): AsyncIterable<CypherNode>
    {
        for await (const node of hits)
        {
            if (!this.overlay.IsTouched(node.PublicId)) yield node;
        }
        const equality = new Comparison(new PropertyAccess(OverlaySource.SeekVariable, member), ComparisonOp.Eq, new Literal(value));
        for (const node of this.overlay.TouchedNodes())
        {
            if (!this.base.IsA(node, label)) continue;
            const row = new Binding().With(OverlaySource.SeekVariable, new NodeValue(node));
            if (BooleanExpression.Truthy(equality.Evaluate(new EvalContext(row, new Map())))) yield node;
        }
    }
}
