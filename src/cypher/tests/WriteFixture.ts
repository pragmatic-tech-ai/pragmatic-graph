import { AccessScope, WriteOp, type BatchOp, type CellValue } from '../../index.js';
import { CypherParser } from '../CypherParser.js';
import type { CypherValue } from '../CypherValue.js';
import type { CypherWriteStats } from '../write/CypherWriteStats.js';
import type { INodePlace, INodePlacement } from '../write/NodePlacement.js';
import { WriteQueryRunner } from '../write/WriteQueryRunner.js';
import { CypherFixture } from './CypherFixture.js';

/** Deterministic placement for tests: n0, n1, ... with a fixed owner; `FailAt` makes that call (0-based) throw `Failure`. */
export class SequencePlacement implements INodePlacement
{
    private static readonly Prefix = 'n';
    private static readonly FailureText = 'boom';

    public FailAt = -1;
    public readonly Failure = new Error(SequencePlacement.FailureText);
    public readonly Calls: string[] = [];
    private count = 0;

    constructor(private readonly owner: string = '')
    {
    }

    public Place(concept: string): INodePlace
    {
        if (this.count === this.FailAt) throw this.Failure;
        this.Calls.push(concept);
        return { PublicId: `${SequencePlacement.Prefix}${this.count++}`, Owner: this.owner };
    }
}

export interface IWriteOutcome
{
    readonly Columns: readonly string[];
    /** Each row: the final columns mapped to CypherFixture.Plain values. */
    readonly Rows: Map<string, unknown>[];
    readonly Values: CypherValue[][];
    readonly Stats: CypherWriteStats;
    readonly Commit: bigint;
}

export interface IWriteOptions
{
    readonly Scope?: AccessScope;
    readonly Placement?: INodePlacement;
    readonly Parameters?: ReadonlyMap<string, CypherValue>;
}

/** Runs write queries through WriteQueryRunner on a CypherFixture engine. */
export class WriteFixture
{
    private static readonly Open = '(';
    private static readonly Close = ')';
    private static readonly Comma = ',';

    public static async Write(fx: CypherFixture, text: string, options: IWriteOptions = {}): Promise<IWriteOutcome>
    {
        const transaction = await fx.Engine.Begin(options.Scope ?? AccessScope.System);
        try
        {
            const runner = new WriteQueryRunner(transaction, { Placement: options.Placement ?? new SequencePlacement() });
            const result = await runner.Run(new CypherParser(text).Parse(), options.Parameters ?? new Map());
            const commit = await runner.Commit();
            const rows = result.Rows.map(r => new Map(result.Columns.map((c, i) => [c, CypherFixture.Plain(r[i])])));
            return { Columns: result.Columns, Rows: rows, Values: result.Rows, Stats: runner.Stats, Commit: commit };
        }
        finally
        {
            transaction.dispose();
        }
    }

    /** The column's Plain values of a write query. */
    public static async Column(fx: CypherFixture, text: string, column: string, options: IWriteOptions = {}): Promise<unknown[]>
    {
        return (await WriteFixture.Write(fx, text, options)).Rows.map(r => r.get(column));
    }

    /** Runs the mutation pipeline without committing; the pending writes in order, rendered, and the drained rows. */
    public static async Steps(fx: CypherFixture, text: string): Promise<{ Steps: string[]; Rows: Map<string, unknown>[]; Values: CypherValue[][] }>
    {
        const transaction = await fx.Engine.Begin(AccessScope.System);
        try
        {
            const runner = new WriteQueryRunner(transaction, { Placement: new SequencePlacement() });
            const result = await runner.Run(new CypherParser(text).Parse(), new Map());
            const rows = result.Rows.map(r => new Map(result.Columns.map((c, i) => [c, CypherFixture.Plain(r[i])])));
            return { Steps: runner.Steps().map(s => WriteFixture.Render(s)), Rows: rows, Values: result.Rows };
        }
        finally
        {
            transaction.dispose();
        }
    }

    /** The number of commits after `after`. */
    public static async CommitsAfter(fx: CypherFixture, after: bigint): Promise<number>
    {
        let n = 0;
        for await (const _ of fx.Engine.ReadChanges(after))
        {
            n++;
        }
        return n;
    }

    /** The latest commit number. */
    public static async Head(fx: CypherFixture): Promise<bigint>
    {
        const reader = await fx.Engine.BeginRead(AccessScope.System);
        try
        {
            return reader.SnapshotCommit;
        }
        finally
        {
            reader.dispose();
        }
    }

    public static Render(op: BatchOp): string
    {
        const o = WriteFixture.Open;
        const c = WriteFixture.Close;
        const s = WriteFixture.Comma;
        switch (op.Op)
        {
            case WriteOp.CreateNode:
                return `CreateNode${o}${op.PublicId}${s}${op.Concept}${c}`;
            case WriteOp.SetProperty:
                return `SetProperty${o}${op.PublicId}${s}${op.Member}${s}${WriteFixture.Cell(op.Value)}${c}`;
            case WriteOp.DeleteNode:
                return `DeleteNode${o}${op.PublicId}${c}`;
            case WriteOp.Link:
                return `Link${o}${op.From}${s}${op.Relationship}${s}${op.To}${c}`;
            case WriteOp.Unlink:
                return `Unlink${o}${op.From}${s}${op.Relationship}${s}${op.To}${c}`;
            case WriteOp.SetOwner:
                return `SetOwner${o}${op.PublicId}${s}${op.Owner}${c}`;
        }
    }

    private static Cell(value: CellValue): string
    {
        return typeof value === 'bigint' ? value.toString() : JSON.stringify(value);
    }
}
