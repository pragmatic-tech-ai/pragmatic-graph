import type { BatchOp } from '../txn/WriteBatch.js';

/**
 * One recorded write handed to a connector, with the owner (model) and concept of the node it routes
 * by: the written node for CreateNode / SetProperty / DeleteNode, the SOURCE node for Link / Unlink
 * (spec §5.4). Owner is '' for a node created without one.
 */
export type ConnectorChange = BatchOp & { readonly Owner: string; readonly Concept: string };

/** The writes of one transaction that one connector owns, in batch op order. Immutable. */
export class ConnectorChangeSet
{
    public readonly Changes: readonly ConnectorChange[];

    /** @internal Built by the WriteCoordinator. */
    public constructor(changes: readonly ConnectorChange[])
    {
        this.Changes = Object.freeze(changes.map(c => Object.freeze({ ...c })));
        Object.freeze(this);
    }
}
