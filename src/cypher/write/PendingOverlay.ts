import type { CellValue } from '../../columns/CellValue.js';
import { CypherNode } from '../CypherNode.js';

/** One (from)-[relationship]->(to) edge written by the query. */
export class OverlayEdge
{
    private static readonly Separator = '\u0000';

    constructor(public readonly From: string, public readonly Relationship: string, public readonly To: string)
    {
    }

    public static Key(from: string, relationship: string, to: string): string
    {
        return from + OverlayEdge.Separator + relationship + OverlayEdge.Separator + to;
    }

    public Key(): string
    {
        return OverlayEdge.Key(this.From, this.Relationship, this.To);
    }
}

/**
 * The writes one Cypher query has recorded so far, as the query itself must see them (replaces TODL's
 * WriteOverlay): created nodes, the current state of every pre-query node it changed, deleted nodes, and the
 * edges it added and removed relative to the transaction's snapshot. Synchronous and in memory; it never
 * touches storage. Nodes are held as whole CypherNodes (current state), so a refreshed binding is a plain copy.
 */
export class PendingOverlay
{
    /** Current state of every node this query created (still including those it deleted again). */
    private readonly created = new Map<string, CypherNode>();
    /** Current state of every pre-query node this query changed. */
    private readonly changed = new Map<string, CypherNode>();
    private readonly deleted = new Set<string>();
    private readonly added = new Map<string, OverlayEdge>();
    private readonly removed = new Map<string, OverlayEdge>();

    public RecordCreate(node: CypherNode): void
    {
        this.created.set(node.PublicId, node);
    }

    /**
     * The property's new value on the node. `base` is the node as the query last saw it (needed for the first
     * change of a pre-query node). A member the node does not show (hidden by the scope) changes nothing visible.
     */
    public RecordSet(base: CypherNode, member: string, value: CellValue): void
    {
        const id = base.PublicId;
        const current = this.created.get(id) ?? this.changed.get(id) ?? base;
        if (!current.Properties.has(member))
        {
            return;
        }
        const properties = new Map(current.Properties);
        properties.set(member, value);
        const next = new CypherNode(id, current.Concept, current.Owner, properties);
        if (this.created.has(id)) this.created.set(id, next);
        else this.changed.set(id, next);
    }

    public RecordDelete(id: string): void
    {
        this.deleted.add(id);
    }

    public RecordLink(from: string, relationship: string, to: string): void
    {
        const edge = new OverlayEdge(from, relationship, to);
        // Re-adding a pre-query edge this query removed only cancels the removal.
        if (!this.removed.delete(edge.Key())) this.added.set(edge.Key(), edge);
    }

    public RecordUnlink(from: string, relationship: string, to: string): void
    {
        const edge = new OverlayEdge(from, relationship, to);
        if (!this.added.delete(edge.Key())) this.removed.set(edge.Key(), edge);
    }

    public IsDeleted(id: string): boolean
    {
        return this.deleted.has(id);
    }

    public IsCreated(id: string): boolean
    {
        return this.created.has(id);
    }

    /** The node's current state when this query created or changed it and has not deleted it; else undefined. */
    public Touched(id: string): CypherNode | undefined
    {
        if (this.deleted.has(id)) return undefined;
        return this.created.get(id) ?? this.changed.get(id);
    }

    /** True when the query created, changed or deleted the node (its snapshot state is not current). */
    public IsTouched(id: string): boolean
    {
        return this.deleted.has(id) || this.created.has(id) || this.changed.has(id);
    }

    /** Created nodes not deleted again, in creation order (a copy: safe to iterate while the query writes). */
    public CreatedNodes(): CypherNode[]
    {
        return [...this.created.values()].filter(n => !this.deleted.has(n.PublicId));
    }

    /** Created or changed nodes not deleted, in a stable order (a copy). */
    public TouchedNodes(): CypherNode[]
    {
        return [...this.created.values(), ...this.changed.values()].filter(n => !this.deleted.has(n.PublicId));
    }

    public IsRemoved(from: string, relationship: string, to: string): boolean
    {
        return this.removed.has(OverlayEdge.Key(from, relationship, to));
    }

    /** Edges this query added, in order (a copy). */
    public AddedEdges(): OverlayEdge[]
    {
        return [...this.added.values()];
    }
}
