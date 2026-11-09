import type { GraphTransaction } from '../../GraphTransaction.js';
import { CypherWriteError } from '../CypherError.js';
import type { CypherQueryModel } from '../CypherQueryModel.js';
import { NullValue, type CypherValue } from '../CypherValue.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import { LogicalPlanner, type PlannerOptions } from '../LogicalPlanner.js';
import type { Binding } from '../Binding.js';
import { BindingRows } from '../operators/BindingRows.js';
import { ReaderSource } from '../ReaderSource.js';
import type { CypherWriteStats } from './CypherWriteStats.js';
import { GuidPlacement, type INodePlacement } from './NodePlacement.js';
import type { BatchOp } from '../../txn/WriteBatch.js';
import type { OverlaySource } from './OverlaySource.js';
import { TransactionSink } from './TransactionSink.js';

export interface IWriteQueryOptions
{
    /** Ids and owners of created nodes; GuidPlacement when absent. */
    readonly Placement?: INodePlacement;
    readonly Planner?: PlannerOptions;
}

/** The final columns and rows of a write query, as the query sees the graph after its own writes. */
export interface IWriteQueryRows
{
    readonly Columns: readonly string[];
    readonly Rows: CypherValue[][];
}

/**
 * Runs one write query on a caller-owned GraphTransaction, in two steps. Run plans the query over the
 * transaction's snapshot plus the query's own writes (OverlaySource), drains the whole mutation pipeline (never
 * paged or truncated), then runs the final projection over the drained rows, still through the overlay; nothing
 * has reached the transaction yet, so any error leaves it untouched (the caller disposes it). Commit then hands
 * the pending writes to the transaction and commits it, exactly once (TransactionSink.Commit). Between the two,
 * Source reads the graph as the result sees it (e.g. to load result nodes' links).
 */
export class WriteQueryRunner
{
    private static readonly AlreadyRan = 'a WriteQueryRunner runs one query';
    private static readonly NotRun = 'Commit needs a completed Run';

    private readonly sink: TransactionSink;
    private ran = false;
    private ready = false;

    constructor(transaction: GraphTransaction, private readonly options: IWriteQueryOptions = {})
    {
        this.sink = new TransactionSink(transaction, new ReaderSource(transaction), options.Placement ?? new GuidPlacement());
    }

    /** The graph as this query sees it: the snapshot with the query's pending writes. */
    public get Source(): OverlaySource
    {
        return this.sink.View;
    }

    public get Stats(): CypherWriteStats
    {
        return this.sink.Stats;
    }

    /** The pending writes, in order. */
    public Steps(): readonly BatchOp[]
    {
        return this.sink.Steps();
    }

    public async Run(model: CypherQueryModel, parameters: ReadonlyMap<string, CypherValue>, cancel?: ICancellation): Promise<IWriteQueryRows>
    {
        if (this.ran) throw new CypherWriteError(WriteQueryRunner.AlreadyRan);
        this.ran = true;
        const planner = new LogicalPlanner(this.sink.View, parameters, this.options.Planner, cancel, false, this.sink);
        const plan = planner.PlanForWrite(model);
        const probe = new CancelProbe(cancel);
        probe.Begin();
        const drained: Binding[] = [];
        for await (const row of plan.Mutations.Rows())
        {
            probe.Tick();
            drained.push(this.sink.View.RefreshRow(row));
        }
        const columns = plan.Projection === undefined ? [] : model.FinalColumns();
        const rows: CypherValue[][] = [];
        if (plan.Projection !== undefined)
        {
            for await (const row of planner.ProjectOver(new BindingRows(drained), plan.Projection).Rows())
            {
                probe.Tick();
                rows.push(columns.map(c => row.Get(c) ?? NullValue.Instance));
            }
        }
        this.ready = true;
        return { Columns: columns, Rows: rows };
    }

    /** Commits the query's writes (once, after a completed Run); resolves with the commit number. */
    public Commit(): Promise<bigint>
    {
        if (!this.ready) return Promise.reject(new CypherWriteError(WriteQueryRunner.NotRun));
        return this.sink.Commit();
    }
}
