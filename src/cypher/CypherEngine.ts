import type { AccessScope } from '../access/AccessScope.js';
import { FetchSession } from '../connectors/FetchSession.js';
import { FederatedReads } from '../FederatedReads.js';
import type { GraphEngine } from '../GraphEngine.js';
import type { GraphReader, ILinkView } from '../GraphReader.js';
import type { Binding } from './Binding.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { CypherCellCodec } from './CypherCellCodec.js';
import { CypherCursor } from './CypherCursor.js';
import { CypherSemanticError } from './CypherError.js';
import type { CypherNode } from './CypherNode.js';
import { CypherParser } from './CypherParser.js';
import type { CypherQuery } from './CypherQuery.js';
import type { CypherQueryModel } from './CypherQueryModel.js';
import { CypherResult, type CypherResultDto } from './CypherResult.js';
import type { ICypherSource } from './CypherSource.js';
import { CypherValue, NodeValue, NullValue, type ParameterValue } from './CypherValue.js';
import { CancelProbe, type ExecutionLimits, type ICancellation } from './ExecutionLimits.js';
import { FederatedSource } from './FederatedSource.js';
import { LogicalPlanner, type IKeyColumn, type PlannerOptions } from './LogicalPlanner.js';
import type { IOperator } from './operators/IOperator.js';
import { ParameterBinder } from './ParameterBinder.js';
import { PlanSource } from './PlanSource.js';
import { ReaderSource } from './ReaderSource.js';
import { ListValue, MapValue, PathValue } from './StructuredValues.js';
import type { INodePlacement } from './write/NodePlacement.js';
import { WriteQueryRunner } from './write/WriteQueryRunner.js';
import type { ConnectorContext } from '../connectors/ConnectorContext.js';
import type { IBeginOptions } from '../GraphStore.js';

interface IPageOutcome
{
    readonly Result: CypherResult;
    readonly Ties: number;
}

export interface ICypherRunOptions
{
    readonly Parameters?: ReadonlyMap<string, ParameterValue>;
    /** RowCap / Skip / Cancel; a write query is never paged or truncated (Cancel still applies). */
    readonly Limits?: ExecutionLimits;
    /** Ids and owners of nodes a write query creates; GuidPlacement when absent. */
    readonly Placement?: INodePlacement;
    /** On whose behalf the query's connector calls run (its reader's or transaction's ConnectorContext); Anonymous when absent. */
    readonly Connector?: ConnectorContext;
}

/**
 * Runs Cypher on a GraphEngine under an access scope. A read-only query runs on one GraphReader
 * (BeginRead(scope)); a query with write clauses on one GraphTransaction (Begin(scope)) that commits once at the
 * end: at most one CommitApplied (none when it changed nothing), its number in CypherResult.Commit. The reader or
 * transaction is disposed in every outcome. Before the result is returned
 * every node reachable in a row (inside lists, maps and paths too) gets its outgoing links filled, once per
 * distinct node, through the same scoped reader (for a write, the query's own view of the graph), so ToDto is
 * synchronous and sees exactly what the scope may see.
 */
export class CypherEngine
{
    private static readonly EmptyParams: ReadonlyMap<string, ParameterValue> = new Map();
    private static readonly InvalidSkip = 'paging Skip must be a non-negative integer';
    private static readonly AfterWithSkip = 'paging After cannot be combined with Skip';
    private static readonly AfterWidth = 'paging After does not match the result columns';
    private static readonly InvalidPageSize = 'paging RowCap must be a positive integer when Skip is supplied';
    private static readonly InvalidKeysetPageSize = 'paging RowCap must be a positive integer when After is supplied';

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
        const paging = limits?.Skip !== undefined || limits?.After !== undefined;
        if (paging) CypherEngine.ValidatePaging(limits!);
        const reader = await this.engine.BeginRead(scope, CypherEngine.BeginOptions(options));
        try
        {
            const view = CypherEngine.ReadSource(reader);
            const planner = new LogicalPlanner(view, parameters, this.options, limits?.Cancel, paging, undefined, limits?.After !== undefined);
            const plan = planner.Plan(model);
            const columns = model.FinalColumns();
            if (limits?.After !== undefined && limits.After.After.length !== columns.length) throw new GraphError(GraphErrorCode.InvalidArgument, CypherEngine.AfterWidth);
            const outcome = paging ? await CypherEngine.Page(plan, columns, limits!, planner.FinalOrder) : { Result: await CypherEngine.Collect(plan, columns, limits), Ties: 0 };
            await CypherEngine.FillLinks(outcome.Result.Rows, view, limits?.Cancel);
            return CypherEngine.WithSnapshot(outcome.Result, reader.SnapshotCommit, outcome.Ties, planner.FinalOrder !== undefined);
        }
        finally
        {
            reader.dispose();
        }
    }

    /**
     * The operator tree Execute(scope, source, options) would run, one line per operator (children indented), planned
     * over the engine's current catalog. The scope is used only for plan-time metadata (its hidden members rule out
     * indexes, as at Execute); without one nothing is hidden. Options supply the parameters (SKIP / LIMIT may use
     * them) and the limits: with paging (Skip) the implicit total-order Sort shows, and paging limits are validated as
     * Execute does. A write query is planned too, but nothing is read, written or begun.
     */
    public Explain(source: string | CypherQuery, scope?: AccessScope, options: ICypherRunOptions = {}): string
    {
        const model = typeof source === 'string' ? new CypherParser(source).Parse() : source.ToModel();
        const parameters = ParameterBinder.FromInputMap(options.Parameters ?? CypherEngine.EmptyParams);
        const limits = options.Limits;
        const paging = !model.HasWrites() && (limits?.Skip !== undefined || limits?.After !== undefined);
        if (paging) CypherEngine.ValidatePaging(limits!);
        const external = new Set(this.engine.ExternalConnectors().keys());
        return LogicalPlanner.Explain(new PlanSource(this.engine.Catalog, scope?.HiddenNames, this.engine.Bindings, external), model, parameters, this.options, paging);
    }

    /**
     * The source a read runs on (ruling R101): a FederatedSource over the reader with one FetchSession for this query
     * when the reader's connector setup has External connectors, else the plain ReaderSource. A ConnectorError from any
     * fetch rejects the read; no partial result is returned.
     */
    private static BeginOptions(options: ICypherRunOptions): IBeginOptions
    {
        return options.Connector === undefined ? {} : { Connector: options.Connector };
    }

    private static ReadSource(reader: GraphReader): ICypherSource
    {
        const base = new ReaderSource(reader);
        const setup = FederatedReads.Of(reader).Setup;
        if (setup === undefined || setup.External.size === 0)
        {
            return base;
        }
        return new FederatedSource(base, reader, new FetchSession(setup.ExternalConnectors(), setup.Bindings, reader.Catalog, reader.Connector), setup.Bindings);
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
        if (result.Commit !== undefined)
        {
            dto.Commit = result.Commit.toString();
        }
        if (result.NextCursor !== undefined)
        {
            dto.NextCursor = result.NextCursor.Encode();
        }
        return dto;
    }

    // Writes are never paged: limits.Skip / RowCap are ignored (the whole mutation pipeline drains); Cancel applies.
    private async ExecuteWrite(scope: AccessScope, model: CypherQueryModel, parameters: ReadonlyMap<string, CypherValue>, options: ICypherRunOptions): Promise<CypherResult>
    {
        const transaction = await this.engine.Begin(scope, CypherEngine.BeginOptions(options));
        try
        {
            const runOptions: { Placement?: INodePlacement; Planner?: PlannerOptions } = {};
            if (options.Placement !== undefined) runOptions.Placement = options.Placement;
            if (this.options !== undefined) runOptions.Planner = this.options;
            const runner = new WriteQueryRunner(transaction, runOptions);
            const outcome = await runner.Run(model, parameters, options.Limits?.Cancel);
            await CypherEngine.FillLinks(outcome.Rows, runner.Source, options.Limits?.Cancel);
            const commit = await runner.Commit();
            // A query that recorded no writes commits nothing (no commit number, no CommitApplied).
            return new CypherResult(outcome.Columns, outcome.Rows, false, false, runner.Stats, runner.Steps().length > 0 ? commit : undefined);
        }
        finally
        {
            transaction.dispose();
        }
    }

    // A read's result carries its snapshot commit; a page with more rows carries the cursor of its last row (cut at
    // that snapshot) when its order is over returned columns (`keyed`, the planner's FinalOrder): a cursor can only
    // compare returned columns, so a Skip page ordered otherwise has none (final review m2). Built after FillLinks so a
    // node key can be encoded.
    private static WithSnapshot(result: CypherResult, commit: bigint, ties: number, keyed: boolean): CypherResult
    {
        const last = result.HasMore && keyed ? result.Rows[result.Rows.length - 1] : undefined;
        const cursor = last === undefined ? undefined : new CypherCursor(commit, last, ties);
        return new CypherResult(result.Columns, result.Rows, result.Truncated, result.HasMore, undefined, commit, cursor);
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

    // Paging: walk the sorted stream, discarding the first Skip rows (or, with After, every row up to the cursor's key
    // and as many rows equal to it as it records in Ties), collect up to RowCap rows, then peek exactly one further row to
    // report HasMore. Truncated is never set on a page. Every row is materialized to track Ties: the number of rows
    // equal to the last returned row seen so far in the stream.
    private static async Page(plan: IOperator, columns: readonly string[], limits: ExecutionLimits, order: readonly IKeyColumn[] | undefined): Promise<IPageOutcome>
    {
        const skip = limits.Skip ?? 0;
        const after = limits.After;
        const keys = CypherEngine.KeyOrder(columns, order);
        const rows: CypherValue[][] = [];
        let skipped = 0;
        let tiesLeft = after?.Ties ?? 0;
        let hasMore = false;
        let previous: CypherValue[] | undefined;
        let run = 0;
        let ties = 0;
        const probe = new CancelProbe(limits.Cancel);
        probe.Begin();
        for await (const binding of plan.Rows())
        {
            probe.Tick();
            const row = CypherEngine.Materialize(binding, columns);
            run = previous !== undefined && CypherEngine.CompareKey(row, previous, keys) === 0 ? run + 1 : 1;
            previous = row;
            if (skipped < skip)
            {
                skipped++;
                continue;
            }
            if (after !== undefined)
            {
                const c = CypherEngine.CompareKey(row, after.After, keys);
                if (c < 0) continue;
                if (c === 0 && tiesLeft > 0)
                {
                    tiesLeft--;
                    continue;
                }
            }
            if (rows.length >= limits.RowCap!)
            {
                hasMore = true;
                break;
            }
            rows.push(row);
            ties = run;
        }
        return { Result: new CypherResult(columns, rows, false, hasMore), Ties: ties };
    }

    // Paging limits are fail-fast: a bad Skip must not silently act as 0, and Skip without a page size is a misuse.
    private static ValidatePaging(limits: ExecutionLimits): void
    {
        if (limits.After !== undefined && limits.Skip !== undefined) throw new GraphError(GraphErrorCode.InvalidArgument, CypherEngine.AfterWithSkip);
        if (limits.Skip === undefined)
        {
            if (!Number.isInteger(limits.RowCap) || limits.RowCap! <= 0) throw new CypherSemanticError(`${CypherEngine.InvalidKeysetPageSize}: ${limits.RowCap}`);
            return;
        }
        if (!Number.isInteger(limits.Skip) || limits.Skip! < 0) throw new CypherSemanticError(`${CypherEngine.InvalidSkip}: ${limits.Skip}`);
        if (!Number.isInteger(limits.RowCap) || limits.RowCap! <= 0) throw new CypherSemanticError(`${CypherEngine.InvalidPageSize}: ${limits.RowCap}`);
    }

    // The effective sort as (row index, direction) pairs; every column ascending when the plan recorded none.
    private static KeyOrder(columns: readonly string[], order: readonly IKeyColumn[] | undefined): readonly { Index: number; Descending: boolean }[]
    {
        if (order === undefined) return columns.map((_, i) => ({ Index: i, Descending: false }));
        return order.map((k) => ({ Index: columns.indexOf(k.Column), Descending: k.Descending }));
    }

    // Lexicographic in the effective order: negative when `row` sorts before `key`.
    private static CompareKey(row: readonly CypherValue[], key: readonly CypherValue[], order: readonly { Index: number; Descending: boolean }[]): number
    {
        for (const k of order)
        {
            const c = CypherValue.Compare(row[k.Index]!, key[k.Index]!);
            if (c !== 0) return k.Descending ? -c : c;
        }
        return 0;
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
