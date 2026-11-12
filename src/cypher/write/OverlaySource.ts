import type { CellValue } from '../../columns/CellValue.js';
import type { IFetchTarget } from '../../connectors/FetchContract.js';
import type { ILinkView, IReadProbe } from '../../GraphReader.js';
import type { Predicate } from '../../predicate/Predicate.js';
import { Binding, EvalContext } from '../Binding.js';
import { ComparisonOp, RelDirection } from '../CypherEnums.js';
import type { CypherNode } from '../CypherNode.js';
import type { ICypherSource, IExpandRow } from '../CypherSource.js';
import { NodeValue, NullValue, type CypherValue } from '../CypherValue.js';
import { BooleanExpression, Comparison, Literal, PropertyAccess } from '../Expression.js';
import { ListValue, MapValue, PathValue } from '../StructuredValues.js';
import type { PendingOverlay } from './PendingOverlay.js';
import type { WriteDependencyAnalysis } from './WriteDependencyAnalysis.js';

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

    public WriteDependencies(): WriteDependencyAnalysis
    {
        return this.base.WriteDependencies();
    }

    /** The hint goes to the base untouched: a created node is never fetched, and every node still passes the filters. */
    public async *ScanLabel(label: string, probe?: IReadProbe, hint?: Predicate): AsyncIterable<CypherNode>
    {
        for await (const node of this.base.ScanLabel(label, probe, hint))
        {
            const current = this.Current(node);
            if (current !== undefined) yield current;
        }
        for (const node of this.overlay.CreatedNodes())
        {
            probe?.Tick();
            if (this.base.IsA(node, label)) yield node;
        }
    }

    public async *ScanAll(probe?: IReadProbe): AsyncIterable<CypherNode>
    {
        for await (const node of this.base.ScanAll(probe))
        {
            const current = this.Current(node);
            if (current !== undefined) yield current;
        }
        for (const node of this.overlay.CreatedNodes())
        {
            probe?.Tick();
            yield node;
        }
    }

    /** The nodes with these ids as the query now sees them (base nodes refreshed, created nodes added), in the ids' order. */
    public async *NodesById(ids: readonly string[], label: string | undefined, probe?: IReadProbe): AsyncIterable<CypherNode>
    {
        const found = new Map<string, CypherNode>();
        for await (const node of this.base.NodesById(ids, label, probe))
        {
            const current = this.Current(node);
            if (current !== undefined) found.set(current.PublicId, current);
        }
        const wanted = new Set(ids);
        for (const node of this.overlay.CreatedNodes())
        {
            probe?.Tick();
            if (wanted.has(node.PublicId) && (label === undefined || this.base.IsA(node, label))) found.set(node.PublicId, node);
        }
        for (const id of new Set(ids))
        {
            const node = found.get(id);
            if (node !== undefined) yield node;
        }
    }

    public async Node(publicId: string): Promise<CypherNode | undefined>
    {
        if (this.overlay.IsTouched(publicId)) return this.overlay.Touched(publicId);
        return this.base.Node(publicId);
    }

    /** As ReaderSource.Expand (Undirected: Out then In, each (relationship, far node) once), over the overlay. */
    public async *Expand(publicId: string, relationship: string | undefined, direction: RelDirection, probe?: IReadProbe): AsyncIterable<IExpandRow>
    {
        if (this.overlay.IsDeleted(publicId)) return;
        if (direction !== RelDirection.Undirected)
        {
            yield* this.Directed(publicId, relationship, direction, probe);
            return;
        }
        const seen = new Set<string>();
        for (const way of [RelDirection.Outgoing, RelDirection.Incoming])
        {
            for await (const row of this.Directed(publicId, relationship, way, probe))
            {
                const key = row.Relationship + OverlaySource.StepSeparator + row.Target.PublicId;
                if (seen.has(key)) continue;
                seen.add(key);
                yield row;
            }
        }
    }

    /**
     * The snapshot's outgoing links minus the edges this query removed and the far nodes it deleted, then the
     * edges it added (each in recording order); none for a deleted node. Within one relationship that is the
     * order the commit will store them in.
     */
    public async OutLinks(publicId: string): Promise<readonly ILinkView[]>
    {
        if (this.overlay.IsDeleted(publicId)) return [];
        const links: ILinkView[] = [];
        if (!this.overlay.IsCreated(publicId))
        {
            for (const link of await this.base.OutLinks(publicId))
            {
                if (!this.overlay.IsRemoved(publicId, link.Relationship, link.PublicId) && !this.overlay.IsDeleted(link.PublicId)) links.push(link);
            }
        }
        for (const edge of this.overlay.AddedEdges())
        {
            if (edge.From === publicId && !this.overlay.IsDeleted(edge.To)) links.push({ Relationship: edge.Relationship, PublicId: edge.To });
        }
        return links;
    }

    public IndexFor(label: string, member: string): string | undefined
    {
        return this.base.IndexFor(label, member);
    }

    public FetchTargets(label: string | undefined): readonly IFetchTarget[]
    {
        return this.base.FetchTargets(label);
    }

    public SeekEqual(label: string, member: string, value: CellValue, probe?: IReadProbe, hint?: Predicate): AsyncIterable<CypherNode> | undefined
    {
        const hits = this.base.SeekEqual(label, member, value, probe, hint);
        return hits === undefined ? undefined : this.MergedSeek(hits, label, member, value, probe);
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

    private async *Directed(publicId: string, relationship: string | undefined, direction: RelDirection, probe: IReadProbe | undefined): AsyncIterable<IExpandRow>
    {
        const outgoing = direction === RelDirection.Outgoing;
        if (!this.overlay.IsCreated(publicId))
        {
            for await (const row of this.base.Expand(publicId, relationship, direction, probe))
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
            probe?.Tick();
            if (relationship !== undefined && edge.Relationship !== relationship) continue;
            if ((outgoing ? edge.From : edge.To) !== publicId) continue;
            const target = await this.Node(outgoing ? edge.To : edge.From);
            if (target !== undefined) yield { Relationship: edge.Relationship, Target: target };
        }
    }

    private async *MergedSeek(hits: AsyncIterable<CypherNode>, label: string, member: string, value: CellValue, probe: IReadProbe | undefined): AsyncIterable<CypherNode>
    {
        for await (const node of hits)
        {
            if (!this.overlay.IsTouched(node.PublicId)) yield node;
        }
        const equality = new Comparison(new PropertyAccess(OverlaySource.SeekVariable, member), ComparisonOp.Eq, new Literal(value));
        for (const node of this.overlay.TouchedNodes())
        {
            probe?.Tick();
            if (!this.base.IsA(node, label)) continue;
            const row = new Binding().With(OverlaySource.SeekVariable, new NodeValue(node));
            if (BooleanExpression.Truthy(equality.Evaluate(new EvalContext(row, new Map())))) yield node;
        }
    }
}
