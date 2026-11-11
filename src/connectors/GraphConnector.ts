import type { ConnectorContext } from './ConnectorContext.js';
import type { ConnectorChangeSet } from './ConnectorChangeSet.js';
import type { ConnectorResidency } from './FetchContract.js';

/**
 * The engine-declared write side of a connector (spec §5.3): the system that holds a binding's data.
 * A commit that writes nodes bound to the connector runs one connector transaction (WriteCoordinator):
 * Begin, Apply its change set, Commit, all before the engine finalizes. What Revert achieves remotely
 * is the connector author's responsibility; the engine guarantees it is called on every failure.
 * Changes are the batch ops as recorded (ConnectorChange), including DeleteNode's `Strict` flag, plus
 * one Unlink before a plain DeleteNode for every edge the delete removes whose source binds to the
 * connector (ruling R89).
 *
 * Context (spec section 6): Begin receives the ConnectorContext of the one transaction whose commit is writing through, and
 * every call on the returned connector transaction belongs to that context. A connector transaction and its WriteCoordinator
 * serve exactly one GraphTransaction; the engine never caches, pools, batches or compensates connector work across readers
 * or transactions, and group commit merges engine batches only. A connector that acts as the caller uses this context's
 * connection or token, never another's.
 */
export interface IGraphConnector
{
    /** The name bindings refer to; unique among the installed connectors, never BindingTable.EngineStorage. */
    readonly Name: string;
    /** Absent means Mirrored (ruling R96); External connectors implement IExternalConnector. */
    readonly Residency?: ConnectorResidency;
    Begin(context: ConnectorContext): Promise<IConnectorTransaction>;
}

export interface IConnectorTransaction
{
    Apply(changes: ConnectorChangeSet): Promise<void>;
    Commit(): Promise<void>;
    /** Legal before and after Commit; after Commit it means compensate. */
    Revert(): Promise<void>;
}
