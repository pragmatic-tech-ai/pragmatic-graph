import { GraphError, GraphErrorCode } from '../errors/GraphError.js';

/** Why the WriteGate refused a commit (ruling R68). */
export enum AccessErrorCode
{
    /** An applicable Create predicate does not hold on the new node's end-of-batch values, or is not node-local. */
    CreateDenied = 1,
    /** An applicable Update predicate does not hold on the node's pre-batch values. */
    UpdateDenied = 2,
    /** An applicable Delete predicate does not hold on the node's pre-batch values. */
    DeleteDenied = 3,
    /** The write sets a property or follows a relationship the scope hides on the node's concept. */
    HiddenMember = 4,
    /** The written node (or a Link/Unlink target) is not visible under the scope, or does not exist. */
    InvisibleNode = 5,
    /** The write sets, removes, links or unlinks a member the scope marks read-only on the node's concept (ruling R92). */
    MemberReadOnly = 6,
}

/**
 * A transaction's AccessScope does not allow one of the writes it recorded. Raised by Commit before
 * anything is submitted: the batch leaves no trace, consumes no commit number and raises no
 * CommitApplied. The message names the op index, the public id and (when the writer may see it) the
 * concept. GraphCode is always AccessDenied.
 */
export class AccessError extends GraphError
{
    private static readonly ErrorName = 'AccessError';

    public readonly Code: AccessErrorCode;

    public constructor(code: AccessErrorCode, message: string)
    {
        super(GraphErrorCode.AccessDenied, message);
        this.name = AccessError.ErrorName;
        this.Code = code;
    }
}
