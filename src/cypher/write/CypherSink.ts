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
    CreateNode(concept: string, properties: ReadonlyMap<string, CypherScalar>): CypherNode;
    SetProperty(publicId: string, member: string, value: CypherScalar | null): Promise<void>;
    RemoveProperty(publicId: string, member: string): Promise<void>;
    ReplaceRelationship(publicId: string, member: string, targetId: string): Promise<void>;
    /** False (nothing written) when the edge already exists in the view. */
    CreateRelationship(from: string, relationship: string, to: string): Promise<boolean>;
    /** False when the edge does not exist in the view. */
    DeleteRelationship(from: string, relationship: string, to: string): Promise<boolean>;
    DeleteNode(publicId: string, detach: boolean): Promise<void>;
}
