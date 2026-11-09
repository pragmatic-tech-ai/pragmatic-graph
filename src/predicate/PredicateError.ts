import { GraphError, GraphErrorCode } from '../errors/GraphError.js';

export enum PredicateErrorCode
{
    /** A JSON document is not a well-formed predicate. */
    Malformed = 1,
    /**
     * A predicate that needs the graph reader (Related, Reachable, Seeded, OwnerIs) was evaluated against a node alone.
     */
    NotNodeLocal,
}

/** A predicate could not be decoded or evaluated. Always a SchemaViolation at the engine level. */
export class PredicateError extends GraphError
{
    private static readonly ErrorName = 'PredicateError';

    public readonly Code: PredicateErrorCode;

    public constructor(code: PredicateErrorCode, message: string)
    {
        super(GraphErrorCode.SchemaViolation, message);
        this.name = PredicateError.ErrorName;
        this.Code = code;
    }
}
