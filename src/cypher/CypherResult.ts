import type { CypherCursor } from './CypherCursor.js';
import type { CypherValueDto } from './CypherCellCodec.js';
import type { CypherValue } from './CypherValue.js';
import type { CypherWriteStats, CypherWriteStatsDto } from './write/CypherWriteStats.js';

/**
 * One query's result table. Truncated: RowCap cut the rows (no paging). HasMore: a page (Skip given) has a further
 * row. Stats: what a write query changed (absent for a read). Commit: the commit number of a write query that
 * committed changes (for a read: the snapshot commit it ran at; absent for a write that changed nothing, which commits nothing). NextCursor: with HasMore on a keyset or Skip page, the cursor of the last returned row. Every node
 * reachable in a row from CypherEngine.Execute has its links filled, so CypherEngine.ToDto is synchronous.
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
