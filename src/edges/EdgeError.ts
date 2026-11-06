import { GraphError, GraphErrorCode } from '../errors/GraphError.js';

export enum EdgeErrorCode
{
    DuplicateEdge,
    CardinalityExceeded,
    UnknownSibling,
    MissingEdge,
    InvalidProperty,
    NotARelationship,
    NotOrdered,
    CorruptEdge,
    NotAdjacent,
    InvalidOrder,
}

export class EdgeError extends GraphError
{
    private static readonly ErrorName = 'EdgeError';

    public readonly Code: EdgeErrorCode;

    public constructor(code: EdgeErrorCode, message: string)
    {
        super(EdgeError.Category(code), message);
        this.name = EdgeError.ErrorName;
        this.Code = code;
    }

    public static Category(code: EdgeErrorCode): GraphErrorCode
    {
        switch (code)
        {
            case EdgeErrorCode.CorruptEdge:
                return GraphErrorCode.Corrupt;
            case EdgeErrorCode.NotARelationship:
            case EdgeErrorCode.NotOrdered:
            case EdgeErrorCode.InvalidProperty:
                return GraphErrorCode.SchemaViolation;
            default:
                return GraphErrorCode.ConstraintViolation;
        }
    }
}
