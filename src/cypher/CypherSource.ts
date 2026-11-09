import type { CellValue } from '../columns/CellValue.js';
import type { RelDirection } from './CypherEnums.js';
import type { CypherNode } from './CypherNode.js';

/** One step of an expand: the relationship walked and the fully loaded node at its far end. */
export interface IExpandRow
{
    readonly Relationship: string;
    readonly Target: CypherNode;
}

/**
 * The graph as the Cypher operators read it (replaces TODL's ICypherGraph). Every node it yields is fully
 * loaded (identity and every visible property), so expressions over it stay synchronous. Implementations
 * enforce their access scope: an invisible node never surfaces and a hidden member is absent.
 */
export interface ICypherSource
{
    /** The catalog name for a label: an exact name wins, else a unique simple-name match; CypherSemanticError if unknown or ambiguous. */
    ResolveLabel(label: string): string;
    /** True when any concept or aspect declares a relationship of that name. */
    HasRelationship(name: string): boolean;
    /** True when the node's concept is, inherits from, or carries the label (a label or a resolved name). */
    IsA(node: CypherNode, label: string): boolean;
    /** Nodes that are the label (subtypes and aspect carriers included), per matching concept then slot order. */
    ScanLabel(label: string): AsyncIterable<CypherNode>;
    /** Every visible node, per concept then slot order. */
    ScanAll(): AsyncIterable<CypherNode>;
    /** The node, or undefined when no visible node has the public id. */
    Node(publicId: string): Promise<CypherNode | undefined>;
    /** The node's edges in `direction`, of `relationship` or of every relationship when undefined. */
    Expand(publicId: string, relationship: string | undefined, direction: RelDirection): AsyncIterable<IExpandRow>;
    /** Nodes of the label whose member equals the value, through an index; undefined when no usable index exists. */
    SeekEqual(label: string, member: string, value: CellValue): AsyncIterable<CypherNode> | undefined;
}
