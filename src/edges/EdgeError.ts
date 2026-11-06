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

export class EdgeError extends Error
{
    private static readonly ErrorName = 'EdgeError';

    public readonly Code: EdgeErrorCode;

    public constructor(code: EdgeErrorCode, message: string)
    {
        super(message);
        this.name = EdgeError.ErrorName;
        this.Code = code;
    }
}
