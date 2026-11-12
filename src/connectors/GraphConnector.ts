import type { CellValue } from '../columns/CellValue.js';
import type { ConnectorChangeSet } from './ConnectorChangeSet.js';
import type { ConnectorContext } from './ConnectorContext.js';
import type { ConnectorResidency, IFetchedRow, RowVersion } from './FetchContract.js';

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

/**
 * One connector transaction serving one GraphTransaction (spec §6, rulings R135, R136). A write step executes
 * immediately: for an External connector `Apply` runs the step's ops now and reports what the source assigned; a
 * Mirrored connector stages them, as before, and executes at Commit. `Create` and `Undo` are optional and
 * External-only; their transaction-API drivers are source-assigned keys (ruling R136 E4) and compensation (E6).
 */
export interface IConnectorTransaction
{
    /** External: executes the step now and reports what the source assigned. Mirrored: stages, as before. */
    Apply(changes: ConnectorChangeSet): Promise<IConnectorApplyResult | void>;
    /**
     * External only, optional: executes source-keyed creates now, as one step. Resolves with one outcome per request,
     * index-aligned (outcomes[i] answers requests[i]). A per-request failure is an outcome, not a throw; a throw means
     * the whole call failed and the connector has logged, for Undo, whatever it applied before throwing.
     */
    Create?(requests: readonly IAssignedCreate[]): Promise<readonly IAssignedOutcome[]>;
    /** External only, optional: compensates the latest executed step not yet undone (a Create is a step). */
    Undo?(): Promise<void>;
    /** Mirrored: commits staged writes. External: finalize only (drops before-images); no remote effect. */
    Commit(): Promise<void>;
    /** Compensates (External) or discards / compensates (Mirrored) everything not yet undone. Legal before and after Commit. */
    Revert(): Promise<void>;
}

/** What an External connector's Apply reports back about the step it just executed (ruling R136 E3). */
export interface IConnectorApplyResult
{
    /** The source's version of each written row after the step, keyed by public id (R119 V1); absent when it reports none. */
    readonly Versions?: ReadonlyMap<string, RowVersion>;
}

/** One outgoing link of a source-keyed create: the relationship and the public id it points at (ruling R136 E3/E4). */
export interface IAssignedLink
{
    readonly Relationship: string;
    readonly To: string;
}

/** A request to create one record whose key the source assigns (ruling R136 E3/E4). */
export interface IAssignedCreate
{
    readonly Owner: string;
    readonly Concept: string;
    readonly Properties: ReadonlyMap<string, CellValue>;
    readonly Links: readonly IAssignedLink[];
}

/** Exactly one of Row / Error. Row: the created record as the source now holds it. Error: why this request did not apply. */
export interface IAssignedOutcome
{
    readonly Row?: IFetchedRow;
    readonly Error?: unknown;
}
