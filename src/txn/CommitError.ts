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
    /** Cell value does not fit the member (type mismatch, null for a non-nullable property). */
    InvalidValue,
    /** Public id empty or longer than 400 UTF-8 bytes. */
    InvalidPublicId,
    /** A node created by the batch lacks a value for a non-nullable property at the end of the batch (ruling R29). */
    MissingRequired,
}

import { GraphError, GraphErrorCode } from '../errors/GraphError.js';

/**
 * A batch is semantically invalid against the graph state it was applied to. Only that batch is
 * rejected; its writes leave no trace. `cause` carries the underlying EdgeError, CatalogError or column
 * error when there is one.
 */
export class CommitError extends GraphError
{
    private static readonly ErrorName = 'CommitError';

    public readonly Code: CommitErrorCode;

    public constructor(code: CommitErrorCode, message: string, cause?: unknown)
    {
        super(CommitError.Category(code), message, cause);
        this.name = CommitError.ErrorName;
        this.Code = code;
    }

    /** The engine-wide category of a commit error code (the same code a read raises for the same mistake). */
    public static Category(code: CommitErrorCode): GraphErrorCode
    {
        switch (code)
        {
            case CommitErrorCode.UnknownNode:
                return GraphErrorCode.NotFound;
            case CommitErrorCode.InvalidPublicId:
                return GraphErrorCode.InvalidArgument;
            case CommitErrorCode.DuplicatePublicId:
            case CommitErrorCode.InvalidEdge:
            case CommitErrorCode.MissingRequired:
                return GraphErrorCode.ConstraintViolation;
            default:
                return GraphErrorCode.SchemaViolation;
        }
    }
}
