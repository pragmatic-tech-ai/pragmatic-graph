import type { BatchOp } from '../txn/WriteBatch.js';
import type { RowVersion } from './FetchContract.js';

/**
 * One recorded write handed to a connector, with the owner (model) and concept of the node it routes
 * by: the written node for CreateNode / SetProperty / DeleteNode, the SOURCE node for Link / Unlink
 * (spec §5.4). Owner is '' for a node created without one. A DeleteNode keeps its `Strict` flag (true
 * when the writer required the node to have no edges; the engine has already checked it when the
 * connector sees the change, but a connector may use it, e.g. to refuse a remote cascade).
 * ExpectedVersion (ruling R119 V2), on External connectors' changes only: the version of the row the transaction
 * fetched for the routing node, unless the transaction created that node earlier; absent (no key) otherwise. The
 * engine never compares it; the connector guards its write with it.
 */
export type ConnectorChange = BatchOp & { readonly Owner: string; readonly Concept: string; readonly ExpectedVersion?: RowVersion };

/**
 * The writes of one transaction that one connector owns, in batch op order. Immutable. A plain DeleteNode
 * is preceded, in the change set of each connector its edges' sources bind to, by one Unlink per edge
 * it removes (ruling R89), so every change set describes the storage effects, hidden edges included.
 */
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
