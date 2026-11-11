import { EdgeError, EdgeErrorCode } from '../edges/EdgeError.js';
import { CommitError, CommitErrorCode } from './CommitError.js';

/**
 * @internal Commit errors as a read-restricting scope may see them (security S2, spec section 5, program ruling PR10):
 * a conflict with a record the caller cannot read says only that something conflicts, never a value, public id,
 * internal id or far end. The codes whose message or cause can carry such text are rewritten; the rest pass through.
 */
export class CommitErrorRedactor
{
    private static readonly DuplicateText = 'Public id already exists';
    private static readonly HasEdgesText = 'Node still has relationships';
    private static readonly EdgePrefix = 'Edge rejected: ';
    private static readonly CardinalityText = 'the relationship allows one outgoing edge per node';
    private static readonly DuplicateEdgeText = 'the edge already exists';
    private static readonly RuleText = 'the edge breaks a graph rule';

    public static Redact(error: CommitError): CommitError
    {
        switch (error.Code)
        {
            case CommitErrorCode.DuplicatePublicId:
                return new CommitError(error.Code, CommitErrorRedactor.DuplicateText);
            case CommitErrorCode.NodeHasEdges:
                return new CommitError(error.Code, CommitErrorRedactor.HasEdgesText);
            case CommitErrorCode.InvalidEdge:
            {
                const code = error.cause instanceof EdgeError ? error.cause.Code : undefined;
                const text = CommitErrorRedactor.EdgeText(code);
                return new CommitError(error.Code, CommitErrorRedactor.EdgePrefix + text, code === undefined ? undefined : new EdgeError(code, text));
            }
            default:
                return error;
        }
    }

    private static EdgeText(code: EdgeErrorCode | undefined): string
    {
        switch (code)
        {
            case EdgeErrorCode.CardinalityExceeded:
                return CommitErrorRedactor.CardinalityText;
            case EdgeErrorCode.DuplicateEdge:
                return CommitErrorRedactor.DuplicateEdgeText;
            default:
                return CommitErrorRedactor.RuleText;
        }
    }
}
