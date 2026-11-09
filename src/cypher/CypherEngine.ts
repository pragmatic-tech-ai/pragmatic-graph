import type { AccessScope } from '../access/AccessScope.js';
import type { GraphEngine } from '../GraphEngine.js';
import type { ILinkView } from '../GraphReader.js';
import type { Binding } from './Binding.js';
import { CypherCellCodec } from './CypherCellCodec.js';
import { CypherSemanticError } from './CypherError.js';
import type { CypherNode } from './CypherNode.js';
import { CypherParser } from './CypherParser.js';
import type { CypherQuery } from './CypherQuery.js';
import type { CypherQueryModel } from './CypherQueryModel.js';
import { CypherResult, type CypherResultDto } from './CypherResult.js';
import type { ICypherSource } from './CypherSource.js';
import { NodeValue, NullValue, type CypherValue, type ParameterValue } from './CypherValue.js';
import { CancelProbe, type ExecutionLimits, type ICancellation } from './ExecutionLimits.js';
import { LogicalPlanner, type PlannerOptions } from './LogicalPlanner.js';
import type { IOperator } from './operators/IOperator.js';
import { ParameterBinder } from './ParameterBinder.js';
import { PlanSource } from './PlanSource.js';
import { ReaderSource } from './ReaderSource.js';
import { ListValue, MapValue, PathValue } from './StructuredValues.js';
import type { INodePlacement } from './write/NodePlacement.js';
import { WriteQueryRunner } from './write/WriteQueryRunner.js';

export interface ICypherRunOptions
{
    readonly Parameters?: ReadonlyMap<string, ParameterValue>;
    /** RowCap / Skip / Cancel; a write query is never paged or truncated (Cancel still applies). */
    readonly Limits?: ExecutionLimits;
    /** Ids and owners of nodes a write query creates; GuidPlacement when absent. */
    readonly Placement?: INodePlacement;
}

/**
 * Runs Cypher on a GraphEngine under an access scope. A read-only query runs on one GraphReader
 * (BeginRead(scope)); a query with write clauses on one GraphTransaction (Begin(scope)) that commits once at the
 * end (one CommitApplied). The reader or transaction is disposed in every outcome. Before the result is returned
 * every node reachable in a row (inside lists, maps and paths too) gets its outgoing links filled, once per
 * distinct node, through the same scoped reader (for a write, the query's own view of the graph), so ToDto is
 * synchronous and sees exactly what the scope may see.
 */
export class CypherEngine
{
    private static readonly EmptyParams: ReadonlyMap<string, ParameterValue> = new Map();
    private static readonly InvalidSkip = 'paging Skip must be a non-negative integer';
    private static readonly InvalidPageSize = 'paging RowCap must be a positive integer when Skip is supplied';

    constructor(private readonly engine: GraphEngine, private readonly options?: PlannerOptions)
    {
    }

    public async Execute(scope: AccessScope, source: string | CypherQuery, options: ICypherRunOptions = {}): Promise<CypherResult>
    {
        const model = typeof source === 'string' ? new CypherParser(source).Parse() : source.ToModel();
        const parameters = ParameterBinder.FromInputMap(options.Parameters ?? CypherEngine.EmptyParams);
        if (model.HasWrites())
        {
            return this.ExecuteWrite(scope, model, parameters, options);
        }
        const limits = options.Limits;
        const paging = limits?.Skip !== undefined;
        if (paging) CypherEngine.ValidatePaging(limits!);
        const reader = await this.engine.BeginRead(scope);
        try
        {
            const view = new ReaderSource(reader);
            const plan = new LogicalPlanner(view, parameters, this.options, limits?.Cancel, paging).Plan(model);
            const columns = model.FinalColumns();
            const result = paging ? await CypherEngine.Page(plan, columns, limits!) : await CypherEngine.Collect(plan, columns, limits);
            await CypherEngine.FillLinks(result.Rows, view, limits?.Cancel);
            return result;
        }
        finally
        {
            reader.dispose();
        }
    }

    /**
     * The operator tree the query would run, one line per operator (children indented), planned over the engine's
     * current catalog without a scope. A write query is planned too, but nothing is read, written or begun.
     */
    public Explain(source: string | CypherQuery): string
    {
        const model = typeof source === 'string' ? new CypherParser(source).Parse() : source.ToModel();
        return LogicalPlanner.Explain(new PlanSource(this.engine.Catalog), model, new Map(), this.options);
    }

    public static ToDto(result: CypherResult): CypherResultDto
    {
        const dto: CypherResultDto = {
            Columns: [...result.Columns],
            Rows: result.Rows.map((row) => row.map((v) => CypherCellCodec.Encode(v))),
            Truncated: result.Truncated,
            HasMore: result.HasMore,
        };
        if (result.Stats !== undefined)
        {
            dto.Stats = result.Stats.ToDto();
        }
        return dto;
    }

    // Writes are never paged: limits.Skip / RowCap are ignored (the whole mutation pipeline drains); Cancel applies.
    private async ExecuteWrite(scope: AccessScope, model: CypherQueryModel, parameters: ReadonlyMap<string, CypherValue>, options: ICypherRunOptions): Promise<CypherResult>
    {
        const transaction = await this.engine.Begin(scope);
        try
        {
            const runOptions: { Placement?: INodePlacement; Planner?: PlannerOptions } = {};
            if (options.Placement !== undefined) runOptions.Placement = options.Placement;
            if (this.options !== undefined) runOptions.Planner = this.options;
            const runner = new WriteQueryRunner(transaction, runOptions);
            const outcome = await runner.Run(model, parameters, options.Limits?.Cancel);
            await CypherEngine.FillLinks(outcome.Rows, runner.Source, options.Limits?.Cancel);
            await runner.Commit();
            return new CypherResult(outcome.Columns, outcome.Rows, false, false, runner.Stats);
        }
        finally
        {
            transaction.dispose();
        }
    }

    private static async Collect(plan: IOperator, columns: readonly string[], limits?: ExecutionLimits): Promise<CypherResult>
    {
        const rows: CypherValue[][] = [];
        let truncated = false;
        const probe = new CancelProbe(limits?.Cancel);
        probe.Begin();
        for await (const binding of plan.Rows())
        {
            probe.Tick();
            if (limits?.RowCap !== undefined && rows.length >= limits.RowCap)
            {
                truncated = true;
                break;
            }
            rows.push(CypherEngine.Materialize(binding, columns));
        }
        return new CypherResult(columns, rows, truncated);
    }

    // Paging: discard the first Skip bindings without materializing them, collect up to RowCap rows, then peek exactly
    // one further binding to report HasMore. Truncated is never set on a page.
    private static async Page(plan: IOperator, columns: readonly string[], limits: ExecutionLimits): Promise<CypherResult>
    {
        const skip = limits.Skip!;
        const rows: CypherValue[][] = [];
        let skipped = 0;
        let hasMore = false;
        const probe = new CancelProbe(limits.Cancel);
        probe.Begin();
        for await (const binding of plan.Rows())
        {
            probe.Tick();
            if (skipped < skip)
            {
                skipped++;
                continue;
            }
            if (rows.length >= limits.RowCap!)
            {
                hasMore = true;
                break;
            }
            rows.push(CypherEngine.Materialize(binding, columns));
        }
        return new CypherResult(columns, rows, false, hasMore);
    }

    // Paging limits are fail-fast: a bad Skip must not silently act as 0, and Skip without a page size is a misuse.
    private static ValidatePaging(limits: ExecutionLimits): void
    {
        if (!Number.isInteger(limits.Skip) || limits.Skip! < 0) throw new CypherSemanticError(`${CypherEngine.InvalidSkip}: ${limits.Skip}`);
        if (!Number.isInteger(limits.RowCap) || limits.RowCap! <= 0) throw new CypherSemanticError(`${CypherEngine.InvalidPageSize}: ${limits.RowCap}`);
    }

    private static Materialize(binding: Binding, columns: readonly string[]): CypherValue[]
    {
        return columns.map((c) => binding.Get(c) ?? NullValue.Instance);
    }

    // Each distinct node (by public id) is read once; every CypherNode instance of it is filled with that read.
    // When there is anything to read, the deadline is checked before the first read and then per read (CancelProbe).
    private static async FillLinks(rows: readonly (readonly CypherValue[])[], source: ICypherSource, cancel: ICancellation | undefined): Promise<void>
    {
        const probe = new CancelProbe(cancel);
        const nodes: CypherNode[] = [];
        for (const row of rows)
        {
            for (const value of row) CypherEngine.CollectNodes(value, nodes);
        }
        const read = new Map<string, readonly ILinkView[]>();
        if (nodes.length > 0)
        {
            probe.Begin();
        }
        for (const node of nodes)
        {
            if (node.Links !== undefined) continue;
            let links = read.get(node.PublicId);
            if (links === undefined)
            {
                probe.Tick();
                links = await source.OutLinks(node.PublicId);
                read.set(node.PublicId, links);
            }
            node.FillLinks(links);
        }
    }

    private static CollectNodes(value: CypherValue, into: CypherNode[]): void
    {
        if (value instanceof NodeValue)
        {
            into.push(value.Node);
        }
        else if (value instanceof ListValue || value instanceof MapValue || value instanceof PathValue)
        {
            const items: Iterable<CypherValue> = value instanceof ListValue ? value.Items : value instanceof MapValue ? value.Entries.values() : value.Nodes;
            for (const item of items)
            {
                CypherEngine.CollectNodes(item, into);
            }
        }
    }
}
