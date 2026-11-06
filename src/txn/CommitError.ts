export enum CommitErrorCode
{
    UnknownNode,
    DuplicatePublicId,
    UnknownMember,
    NotAProperty,
    NotARelationship,
    TargetTypeMismatch,
    /** Unknown concept name (wraps CatalogError UnknownType). */
    UnknownType,
    /** CreateNode of an aspect (wraps CatalogError AspectNotInstantiable). */
    NotInstantiable,
    /** Edge rule violation (wraps EdgeError: duplicate, cardinality, sibling, missing edge, edge property). */
    InvalidEdge,
    /** Cell value rejected by the column store (type mismatch, null for a non-nullable property). */
    InvalidValue,
    /** Public id empty or longer than 400 UTF-8 bytes. */
    InvalidPublicId,
}

/**
 * A batch is semantically invalid against the graph state it was applied to. Only that batch is
 * rejected; its writes leave no trace. `cause` carries the underlying EdgeError, CatalogError or column
 * error when there is one.
 */
export class CommitError extends Error
{
    private static readonly ErrorName = 'CommitError';

    public readonly Code: CommitErrorCode;

    public constructor(code: CommitErrorCode, message: string, cause?: unknown)
    {
        super(message, cause === undefined ? undefined : { cause });
        this.name = CommitError.ErrorName;
        this.Code = code;
    }
}
