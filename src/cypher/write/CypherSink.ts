import type { IAssignedLink } from '../../connectors/GraphConnector.js';
import type { CypherNode } from '../CypherNode.js';
import type { CypherScalar } from '../CypherValue.js';
import type { OverlaySource } from './OverlaySource.js';

/**
 * One node of a batched CREATE stage (ruling R140 E10): the concept to create, the properties the query set and
 * the outgoing links whose targets already have a real id (an earlier stage's rows, or a bound node). A whole
 * stage's requests across every input row are created in one step by ICypherSink.CreateNodes.
 */
export interface IStagedCreate
{
    readonly Concept: string;
    readonly Properties: ReadonlyMap<string, CypherScalar>;
    readonly Links: readonly IAssignedLink[];
}

/**
 * Where the Cypher write operators write (TransactionSink for a run, ExplainSink for Explain). View is the
 * graph as the query sees it, its own writes included; the planner's source must be that View.
 */
export interface ICypherSink
{
    readonly View: OverlaySource;
    /**
     * Creates a node of the (resolved) concept with the given properties and, when it is a source-keyed place, the
     * outgoing links whose targets already exist (ruling R136 E4); returns it as the query now sees it. The write
     * reaches the external source now for a source-keyed place, or is recorded for the next step otherwise.
     */
    CreateNode(concept: string, properties: ReadonlyMap<string, CypherScalar>, links?: readonly IAssignedLink[]): Promise<CypherNode>;
    /**
     * Creates every node of one batched CREATE stage in a single step (ruling R140 E10), index-aligned with `stage`:
     * source-keyed nodes route through one GraphTransaction.CreateAssigned (one Create call per connector, in name
     * order), client-keyed and engine nodes are recorded then flushed once. Returns the created nodes with their real
     * ids, so the next stage's folded links and later clauses see them.
     */
    CreateNodes(stage: readonly IStagedCreate[]): Promise<readonly CypherNode[]>;
    SetProperty(publicId: string, member: string, value: CypherScalar | null): Promise<void>;
    RemoveProperty(publicId: string, member: string): Promise<void>;
    ReplaceRelationship(publicId: string, member: string, targetId: string): Promise<void>;
    /** False (nothing written) when the edge already exists in the view. */
    CreateRelationship(from: string, relationship: string, to: string): Promise<boolean>;
    /** False when the edge does not exist in the view. */
    DeleteRelationship(from: string, relationship: string, to: string): Promise<boolean>;
    DeleteNode(publicId: string, detach: boolean): Promise<void>;
    /** The members the scope's write gate refuses on this node (its stage: created in this query, or existing); scope metadata, nothing is read. */
    ReadOnlyMembers(publicId: string, concept: string): ReadonlySet<string>;
    /** True when the concept is bound to an External connector (its creates are source- or client-keyed external writes). */
    IsExternalConcept(concept: string): boolean;
    /** Ends the current write step: flushes the ops recorded since the previous step to their external sources (ruling R135 E1). A no-op for Explain. */
    EndStep(): Promise<void>;
}
