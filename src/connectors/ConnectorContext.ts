import { GraphError, GraphErrorCode } from '../errors/GraphError.js';

/**
 * On whose behalf a reader's or transaction's connector calls run (spec section 6). Opaque: the engine compares and
 * forwards it to every connector call, and never interprets the key beyond equality and emptiness. A FetchSession, a
 * connector transaction and a WriteCoordinator each belong to exactly one reader or transaction and so to one context;
 * the engine never caches, pools, batches or compensates connector work across contexts.
 */
export class ConnectorContext
{
    private static readonly ErrKey = 'A connector context key must be a non-empty string';
    /** The key of the anonymous context. */
    private static readonly AnonymousKey = '';

    /** No caller identity: connectors with dedicated credentials accept it; connectors acting as the caller should refuse it. */
    public static readonly Anonymous: ConnectorContext = new ConnectorContext(ConnectorContext.AnonymousKey);

    private constructor(public readonly Key: string)
    {
        Object.freeze(this);
    }

    /** GraphError InvalidArgument for a non-string or empty key. */
    public static For(key: string): ConnectorContext
    {
        if (typeof key !== 'string' || key === ConnectorContext.AnonymousKey)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, ConnectorContext.ErrKey);
        }
        return new ConnectorContext(key);
    }

    public get IsAnonymous(): boolean
    {
        return this.Key === ConnectorContext.AnonymousKey;
    }
}
