import type { IAssignedLink } from '../../connectors/GraphConnector.js';
import type { CypherNode } from '../CypherNode.js';
import type { CypherScalar } from '../CypherValue.js';
import type { OverlaySource } from './OverlaySource.js';

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
