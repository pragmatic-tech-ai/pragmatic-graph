import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { ConnectorError, ConnectorPhase } from './ConnectorError.js';

/**
 * @internal How a fetch by public id fails when a fetched row does not validate (rulings R121 F1, R133): the failure
 * must not reveal what the connector holds for an id the caller's scope may not admit, so a schema-validation failure
 * (a GraphError SchemaViolation, bare or as a ConnectorError Fetch's cause) becomes a ConnectorError Fetch whose cause
 * names neither the id nor the row. GraphTransaction.Fetch (TransactionFetch) and the Cypher by-id seek
 * (FederatedSource.NodesById) both run their fetch and admission steps through it. Every other failure passes unchanged.
 */
export class FetchFailure
{
    /** The connector a sanitized failure names when none is known: none. */
    public static readonly NoConnector = '';
    private static readonly ErrInvalidRow = 'A fetched row failed validation';

    /**
     * Runs a step that validates fetched rows, sanitizing a schema-validation failure (see the class comment). The
     * replacement names the wrapped error's connector, else `connector` (the one that returned the row, or NoConnector).
     */
    public static async Sanitized<T>(connector: string, step: () => Promise<T>): Promise<T>
    {
        try
        {
            return await step();
        }
        catch (error)
        {
            const fetch = error instanceof ConnectorError && error.Phase === ConnectorPhase.Fetch;
            const cause: unknown = fetch ? error.cause : error;
            if (cause instanceof GraphError && cause.GraphCode === GraphErrorCode.SchemaViolation)
            {
                throw new ConnectorError(fetch ? error.Connector : connector, ConnectorPhase.Fetch, new GraphError(GraphErrorCode.SchemaViolation, FetchFailure.ErrInvalidRow));
            }
            throw error;
        }
    }
}
