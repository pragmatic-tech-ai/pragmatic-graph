import { ConnectorOutcome } from '../connectors/ConnectorApplied.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';

/**
 * A GraphTransaction that had executed at least one immediate external write was disposed without a successful Commit
 * or an Abort (ruling R137 E6): a *dropped* transaction. The engine compensated it (best effort) and fails loudly.
 *
 * DisposeAsync rejects with this after compensation finished, its Outcome set. Sync dispose() throws it at once, its
 * Outcome undefined and its Compensation promise settling later. GraphEngine.TransactionDropped carries it, raised once
 * after compensation settles.
 */
export class TransactionDroppedError extends GraphError
{
    private static readonly ErrorName = 'TransactionDroppedError';
    private static readonly Message = 'Transaction dropped with executed external writes: ';
    private static readonly MessageSteps = ' external step(s)';

    public constructor(
        /** The dropped transaction's id (GraphTransaction.Id, a UUID assigned at Begin). */
        public readonly TransactionId: string,
        /** The number of external steps it had executed. */
        public readonly Steps: number,
        /** Settles when compensation ends (Compensated or CompensationFailed); never rejects. */
        public readonly Compensation: Promise<ConnectorOutcome>,
        /** Set when the error is thrown after compensation finished (DisposeAsync); undefined for the sync dispose() path. */
        public readonly Outcome?: ConnectorOutcome,
    )
    {
        super(GraphErrorCode.TransactionDropped, TransactionDroppedError.Message + TransactionId + ', ' + Steps + TransactionDroppedError.MessageSteps);
        this.name = TransactionDroppedError.ErrorName;
    }
}
