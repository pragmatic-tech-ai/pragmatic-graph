/**
 * Engine-wide error categories. Every error the engine raises on purpose is a GraphError carrying one
 * of these; reads and writes use the same code for the same mistake (ruling F8). Subclasses add their
 * own finer-grained `Code`.
 */
export enum GraphErrorCode
{
    /** A caller-supplied argument is malformed (empty or over-long public id, bad direction, misuse). */
    InvalidArgument = 1,
    /** A named node or sibling does not exist. */
    NotFound = 2,
    /** Optimistic conflict: the reads (or the schema) changed after the snapshot; retry may succeed. */
    Conflict = 3,
    /** The object (store, reader, transaction, committer) has been disposed or finished. */
    Disposed = 4,
    /** Stored data is damaged or not in the expected format. */
    Corrupt = 5,
    /** The request does not fit the schema: unknown type or member, wrong member kind, value type, target type, invalid definition. */
    SchemaViolation = 6,
    /** A storage key exceeds the portable maximum key size (511 bytes). */
    KeyTooLong = 7,
    /** A graph rule is broken: duplicate id or edge, cardinality, sibling placement, missing required value. */
    ConstraintViolation = 8,
    /** The stored format version is not supported by this engine. */
    Unsupported = 9,
    /** The store is already open for writing by another store instance or process. */
    Locked = 10,
    /** An engine invariant failed (an engine bug or misuse of internal building blocks). */
    Internal = 11,
    /** The transaction's AccessScope does not allow a write it recorded (AccessError). */
    AccessDenied = 12,
    /** A connector taking part in a write-through failed, timed out, or the engine could not finalize after it (ConnectorError). */
    ConnectorFailed = 13,
}

/** Base class of every error the engine raises on purpose. `cause` carries an underlying error when there is one. */
export class GraphError extends Error
{
    private static readonly GraphErrorName = 'GraphError';

    public readonly GraphCode: GraphErrorCode;

    public constructor(code: GraphErrorCode, message: string, cause?: unknown)
    {
        super(message, cause === undefined ? undefined : { cause });
        this.name = GraphError.GraphErrorName;
        this.GraphCode = code;
    }
}
