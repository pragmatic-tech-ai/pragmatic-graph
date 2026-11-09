import type { ConnectorChangeSet } from './ConnectorChangeSet.js';

/**
 * The engine-declared write side of a connector (spec §5.3): the system that holds a binding's data.
 * A commit that writes nodes bound to the connector runs one connector transaction (WriteCoordinator):
 * Begin, Apply its change set, Commit, all before the engine finalizes. What Revert achieves remotely
 * is the connector author's responsibility; the engine guarantees it is called on every failure.
 * Changes are the batch ops as recorded (ConnectorChange), including DeleteNode's `Strict` flag.
 */
export interface IGraphConnector
{
    /** The name bindings refer to; unique among the installed connectors, never BindingTable.EngineStorage. */
    readonly Name: string;
    Begin(): Promise<IConnectorTransaction>;
}

export interface IConnectorTransaction
{
    Apply(changes: ConnectorChangeSet): Promise<void>;
    Commit(): Promise<void>;
    /** Legal before and after Commit; after Commit it means compensate. */
    Revert(): Promise<void>;
}
