/** What kind of failure a CypherError reports. Subclasses fix their own code; IntegerOverflow is raised as a plain CypherError. */
export enum CypherErrorCode
{
    Error,
    Syntax,
    Semantic,
    Timeout,
    Write,
    IntegerOverflow,
}

export class CypherError extends Error
{
    constructor(message: string, public readonly Code: CypherErrorCode = CypherErrorCode.Error, cause?: unknown)
    {
        super(message, cause === undefined ? undefined : { cause });
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

// Write-time semantic failure (distinct from CypherSemanticError so callers can classify it). cause carries the
// engine error (a GraphError) when the failure came from the storage engine.
export class CypherWriteError extends CypherError
{
    constructor(message: string, cause?: Error)
    {
        super(message, CypherErrorCode.Write, cause);
    }
}
