import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { ConflictError } from '../txn/ConflictError.js';

/** The step of a write-through that failed. */
export enum ConnectorPhase
{
    Begin = 'Begin',
    Apply = 'Apply',
    Commit = 'Commit',
    /** The engine's own Finalize after every connector committed (Connector is BindingTable.EngineStorage). */
    Finalize = 'Finalize',
    /**
     * The engine's Prepare did not return before the write-through deadline (Connector is BindingTable.EngineStorage).
     */
    Prepare = 'Prepare',
    /** A Fetch from an external connector failed. */
    Fetch = 'Fetch',
    /** An immediate external write step, or a source-keyed create, that failed (Wave 2, ruling R135). */
    Write = 'Write',
}

/**
 * A write-through failed (spec §6): a connector call threw or timed out, or the engine could not finalize
 * after the connectors committed. Every connector that began was reverted (a call still hanging at the
 * timeout is reverted once it returns). `cause` is the failure; when a revert also failed it is an
 * AggregateError holding the failure first, then each revert error. The engine is unchanged.
 *
 * Raised late on ConnectorRevertFailed (a revert that failed after the caller was answered): for the
 * connector whose call was hanging, Phase is that call's phase; for any other connector whose revert
 * finished late, Phase is the phase of the call that failed the write-through (the caller's
 * ConnectorError.Phase), not a phase of the reverting connector's own.
 */
export class ConnectorError extends GraphError
{
    private static readonly ErrorName = 'ConnectorError';
    private static readonly MessageStart = 'Connector ';
    private static readonly MessageMiddle = ' failed in ';

    public constructor(
        /** The connector whose call failed; BindingTable.EngineStorage for a Finalize failure or a Prepare timeout. */
        public readonly Connector: string,
        public readonly Phase: ConnectorPhase,
        cause: unknown,
    )
    {
        super(GraphErrorCode.ConnectorFailed, ConnectorError.MessageStart + Connector + ConnectorError.MessageMiddle + Phase, cause);
        this.name = ConnectorError.ErrorName;
    }

    /**
     * True when the connector reported a stale expected version: the cause is a ConflictError, or an
     * AggregateError (the failure plus failed reverts) whose first error is one.
     */
    public get IsConflict(): boolean
    {
        const cause = this.cause;
        if (cause instanceof AggregateError)
        {
            return cause.errors[0] instanceof ConflictError;
        }
        return cause instanceof ConflictError;
    }
}
