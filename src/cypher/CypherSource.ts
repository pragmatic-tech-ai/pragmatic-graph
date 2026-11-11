import type { CellValue } from '../columns/CellValue.js';
import type { IFetchTarget } from '../connectors/FetchContract.js';
import type { ILinkView, IReadProbe } from '../GraphReader.js';
import type { Predicate } from '../predicate/Predicate.js';
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
 * enforce their access scope: an invisible node never surfaces and a hidden member is absent. A `probe` passed
 * to a scan, expand or seek ticks once per stored entry examined, including those the scope filters out, so a
 * deadline holds even when almost nothing is visible.
 */
export interface ICypherSource
{
    /**
     * The catalog name for a label: an exact name wins, else a unique simple-name match; CypherSemanticError if unknown
     * or ambiguous.
     */
    ResolveLabel(label: string): string;
    /** True when any concept or aspect declares a relationship of that name. */
    HasRelationship(name: string): boolean;
    /** True when the node's concept is, inherits from, or carries the label (a label or a resolved name). */
    IsA(node: CypherNode, label: string): boolean;
    /**
     * Nodes that are the label (subtypes and aspect carriers included), per matching concept then slot order. `hint`
     * (ruling R101) is a node-local predicate every node the query keeps satisfies: a source may pass it to an External
     * connector as push-down, never use it to drop a node itself (the query's filters stay in the plan).
     */
    ScanLabel(label: string, probe?: IReadProbe, hint?: Predicate): AsyncIterable<CypherNode>;
    /**
     * The External fetches a scan of the label (every concept when undefined) adds to the engine's rows (ruling
     * R101), in fetch order; none for a source that reads the engine only. Plan-time metadata: nothing is read.
     */
    FetchTargets(label: string | undefined): readonly IFetchTarget[];
    /** Every visible node, per concept then slot order. */
    ScanAll(probe?: IReadProbe): AsyncIterable<CypherNode>;
    /** The node, or undefined when no visible node has the public id. */
    Node(publicId: string): Promise<CypherNode | undefined>;
    /**
     * The visible nodes with these public ids that are the label (any node when undefined), in the ids' order, each once
     * (ruling R121 F2). An id no visible node has is skipped, exactly as a label scan would not surface it. A federated
     * source answers an id the engine does not store with one keyed fetch of the label's External targets; with no label
     * it finds only engine nodes, stubs and rows already fetched in the query.
     */
    NodesById(ids: readonly string[], label: string | undefined, probe?: IReadProbe): AsyncIterable<CypherNode>;
    /** The node's edges in `direction`, of `relationship` or of every relationship when undefined. */
    Expand(publicId: string, relationship: string | undefined, direction: RelDirection, probe?: IReadProbe): AsyncIterable<IExpandRow>;
    /**
     * The node's outgoing links (relationship, far node's public id), in relationship declaration then edge order
     * as GraphReader.Links Out: relationships the scope hides and invisible far nodes are omitted. The result
     * encoder fills each result node's links from it.
     */
    OutLinks(publicId: string): Promise<readonly ILinkView[]>;
    /**
     * The name of an index SeekEqual would use for the label and member: a non-partial index whose leading member
     * is the property and whose scope is the label itself, an ancestor or a carried aspect; undefined when none.
     */
    IndexFor(label: string, member: string): string | undefined;
    /**
     * Nodes of the label whose member equals the value, through an index; undefined when IndexFor finds none. A value
     * that can equal no stored value of the member (null, another type, a non-integral float against an Int64
     * member) yields an empty iterable, as the equality filter would. `hint` is the seek anchor's push-down hint, as for
     * ScanLabel.
     */
    SeekEqual(label: string, member: string, value: CellValue, probe?: IReadProbe, hint?: Predicate): AsyncIterable<CypherNode> | undefined;
}
