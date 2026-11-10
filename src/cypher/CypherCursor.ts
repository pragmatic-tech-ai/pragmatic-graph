import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { CypherCellCodec, type CypherValueDto } from './CypherCellCodec.js';
import type { CypherValue } from './CypherValue.js';

/**
 * A keyset position in a paged Cypher read: the total-order key (every result column, ascending) of the last row of
 * a page, and the snapshot commit the page was cut at. Opaque on the wire: Encode() / Decode(). Resuming at a later
 * commit is legal; the host decides whether a stale Commit is acceptable. Ties: how many rows equal to After (in
 * the full key) earlier pages already returned; a resume skips exactly that many equal rows, so duplicate rows
 * across a page boundary are neither repeated nor lost.
 */
export class CypherCursor
{
    private static readonly Version = '1.';
    private static readonly Malformed = 'malformed cursor';
    private static readonly Base64Url = 'base64url';
    private static readonly Utf8 = 'utf8';
    private static readonly CommitPattern = /^\d+$/;

    constructor(public readonly Commit: bigint, public readonly After: readonly CypherValue[], public readonly Ties: number = 0)
    {
    }

    public Encode(): string
    {
        const body: CypherValueDto[] = [this.Commit.toString(), this.Ties, ...this.After.map((v) => CypherCellCodec.Encode(v))];
        return CypherCursor.Version + Buffer.from(JSON.stringify(body), CypherCursor.Utf8).toString(CypherCursor.Base64Url);
    }

    public static Decode(text: string): CypherCursor
    {
        if (typeof text !== 'string' || !text.startsWith(CypherCursor.Version)) throw CypherCursor.Fail();
        try
        {
            const body: unknown = JSON.parse(Buffer.from(text.slice(CypherCursor.Version.length), CypherCursor.Base64Url).toString(CypherCursor.Utf8));
            if (!Array.isArray(body) || typeof body[0] !== 'string' || !CypherCursor.CommitPattern.test(body[0])) throw CypherCursor.Fail();
            const ties: unknown = body[1];
            if (typeof ties !== 'number' || !Number.isInteger(ties) || ties < 0) throw CypherCursor.Fail();
            const cells = body.slice(2) as CypherValueDto[];
            return new CypherCursor(BigInt(body[0]), cells.map((c) => CypherCellCodec.Decode(c)), ties);
        }
        catch (e)
        {
            throw e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument ? e : CypherCursor.Fail(e);
        }
    }

    private static Fail(cause?: unknown): GraphError
    {
        return new GraphError(GraphErrorCode.InvalidArgument, CypherCursor.Malformed, cause);
    }
}
