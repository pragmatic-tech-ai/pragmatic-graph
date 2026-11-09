import { GraphError, GraphErrorCode } from '../errors/GraphError.js';

/** What kind of failure a CypherError reports. Subclasses fix their own code; IntegerOverflow is raised as a plain CypherError. */
export enum CypherErrorCode
{
    Error = 1,
    Syntax,
    Semantic,
    Timeout,
    Write,
    IntegerOverflow,
}

/** Why a write query failed (CypherWriteError.WriteCode). */
export enum CypherWriteErrorCode
{
    /** The transaction conflicted with a concurrent commit; a retry may succeed. */
    Conflict = 1,
    /** The access scope does not allow the write. */
    Denied,
    /** The write does not fit the schema or a graph rule, or the query asked for an impossible write. */
    Invalid,
    /** A connector taking part in the write-through failed. */
    ConnectorFailed,
    /** A DELETE without DETACH hit a node that still has relationships (visible ones in the query, any at commit). */
    NodeHasRelationships,
}

/** Every Cypher failure is a GraphError with GraphCode QueryFailed; Code gives the Cypher category. */
export class CypherError extends GraphError
{
    constructor(message: string, public readonly Code: CypherErrorCode = CypherErrorCode.Error, cause?: unknown)
    {
        super(GraphErrorCode.QueryFailed, message, cause);
        this.name = new.target.name;
    }
}

export class CypherSyntaxError extends CypherError
{
    constructor(message: string, public readonly Line: number, public readonly Column: number)
    {
        super(`${message} (line ${Line}, column ${Column})`, CypherErrorCode.Syntax);
    }
}

export class CypherTimeout extends CypherError
{
    private static readonly Message = 'query exceeded its execution deadline';

    constructor()
    {
        super(CypherTimeout.Message, CypherErrorCode.Timeout);
    }
}

export class CypherSemanticError extends CypherError
{
    constructor(message: string)
    {
        super(message, CypherErrorCode.Semantic);
    }
}

// Write-time failure (distinct from CypherSemanticError so callers can classify it). WriteCode says why; cause
// carries the engine error (a GraphError) when the failure came from the storage engine.
export class CypherWriteError extends CypherError
{
    constructor(message: string, public readonly WriteCode: CypherWriteErrorCode = CypherWriteErrorCode.Invalid, cause?: Error)
    {
        super(message, CypherErrorCode.Write, cause);
    }
}
