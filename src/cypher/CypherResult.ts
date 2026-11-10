import type { CypherCursor } from './CypherCursor.js';
import type { CypherValueDto } from './CypherCellCodec.js';
import type { CypherValue } from './CypherValue.js';
import type { CypherWriteStats, CypherWriteStatsDto } from './write/CypherWriteStats.js';

/**
 * One query's result table. Truncated: RowCap cut the rows (no paging). HasMore: a page (Skip or After given) has a
 * further row. Stats: what a write query changed (absent for a read). Commit: for a write, the commit number it
 * committed (absent when it changed nothing, which commits nothing); for a read, the snapshot commit it ran at.
 * NextCursor: on a page with HasMore, the cursor of the last returned row (pass it as Limits.After for the next
 * page); none when the page's order is not over returned columns (an ORDER BY expression that is no column: page such
 * a query with Skip). Every node reachable in a row from CypherEngine.Execute has its links filled, so CypherEngine.ToDto is
 * synchronous.
 */
export class CypherResult
{
    constructor(
        public readonly Columns: readonly string[],
        public readonly Rows: readonly (readonly CypherValue[])[],
        public readonly Truncated: boolean = false,
        public readonly HasMore: boolean = false,
        public readonly Stats?: CypherWriteStats,
        public readonly Commit?: bigint,
        public readonly NextCursor?: CypherCursor,
    )
    {
    }
}

export interface CypherResultDto
{
    Columns: string[];
    Rows: CypherValueDto[][];
    Truncated: boolean;
    HasMore: boolean;
    Stats?: CypherWriteStatsDto;
    /** CypherResult.Commit as a decimal string (a commit number may exceed 2^53). */
    Commit?: string;
    /** CypherResult.NextCursor, encoded. */
    NextCursor?: string;
}
