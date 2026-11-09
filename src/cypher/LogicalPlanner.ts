import { Binding, EvalContext } from './Binding.js';
import { ComparisonOp } from './CypherEnums.js';
import { CypherSemanticError } from './CypherError.js';
import {
    CreateClause, DeleteClause, MatchClause, MergeClause, RemoveClause, SetClause, SortItem, UnwindClause, WritingClause,
    type CypherQueryModel, type ProjectionClause, type QueryPart, type ReturnItem, type SetItem,
} from './CypherQueryModel.js';
import type { ICypherSource } from './CypherSource.js';
import { ScalarValue, type CypherValue } from './CypherValue.js';
import type { ICancellation } from './ExecutionLimits.js';
import { Comparison, FunctionCall, Literal, PropertyAccess, VariableRef, type Expression } from './Expression.js';
import { OperatorPrinter } from './OperatorPrinter.js';
import { OptionalMatchPlan } from './OptionalMatchPlan.js';
import { CypherParser } from './CypherParser.js';
import { SeekEquality } from './SeekEquality.js';
import type { NodePattern, PatternPath } from './PatternPath.js';
import { Aggregate, type AggregateItem } from './operators/Aggregate.js';
import { AllNodesScan } from './operators/AllNodesScan.js';
import { BindingRow } from './operators/BindingRow.js';
import { CartesianProduct } from './operators/CartesianProduct.js';
import { Distinct } from './operators/Distinct.js';
import { Expand } from './operators/Expand.js';
import { ExpandInto } from './operators/ExpandInto.js';
import { Filter } from './operators/Filter.js';
import { IndexSeek } from './operators/IndexSeek.js';
import type { IOperator } from './operators/IOperator.js';
import { LabelFilter } from './operators/LabelFilter.js';
import { LabelScan } from './operators/LabelScan.js';
import { Limit } from './operators/Limit.js';
import { OptionalApply } from './operators/OptionalApply.js';
import { Project } from './operators/Project.js';
import { SingleRow } from './operators/SingleRow.js';
import { Skip } from './operators/Skip.js';
import { Sort } from './operators/Sort.js';
import { Unwind } from './operators/Unwind.js';
import { VarLengthExpand } from './operators/VarLengthExpand.js';
import { CreateOperator } from './write/CreateOperator.js';
import { DeleteOperator } from './write/DeleteOperator.js';
import { EagerBarrier } from './write/EagerBarrier.js';
import { MergeOperator } from './write/MergeOperator.js';
import { RemoveOperator } from './write/RemoveOperator.js';
import { SetApplier } from './write/SetApplier.js';
import { SetOperator } from './write/SetOperator.js';
import type { ICypherSink } from './write/CypherSink.js';
import { ExplainSink } from './write/ExplainSink.js';

interface ISeekChoice
{
    readonly Op: IOperator;
    readonly InlineKey: string | undefined;
    readonly Source: Expression | undefined;
}

/** A write query's plan: the whole mutating pipeline, and the final RETURN projection to run over its drained rows. */
export interface IWritePlan
{
    readonly Mutations: IOperator;
    readonly Projection: ProjectionClause | undefined;
}

export interface PlannerOptions
{
    readonly MaxVarLength?: number;
    // Opt-in: reusing the name of a variable dropped by an earlier WITH as a new pattern variable throws.
    readonly StrictWithScope?: boolean;
}

/**
 * Compiles a CypherQueryModel into an async operator tree over an ICypherSource. Planning is synchronous and
 * raises every semantic error (scope, labels, relationship types, SKIP/LIMIT) before any row is read: labels are
 * resolved here (exact name, else unique simple name). Write clauses compile only with an ICypherSink (whose
 * View must be the planner's source): each is fenced by EagerBarriers (clause-at-a-time, rows refreshed through
 * the overlay); without a sink they fail planning.
 */
export class LogicalPlanner
{
    private static readonly WritesNotExecutable = 'write clauses require a writer';
    private static readonly AnonPrefix = '__n';
    private static readonly RelPropsUnsupported = 'relationship properties are not supported';
    private static readonly UnknownRelType = 'unknown relationship type';
    private static readonly UnknownOrderByColumn = 'unknown ORDER BY column';
    private static readonly UnknownWhereColumn = 'unknown WITH ... WHERE column';
    private static readonly UnboundVariable = 'variable not in scope';
    private static readonly NonNumericLimit = 'SKIP/LIMIT must evaluate to a number';
    private static readonly NestedAggregate = 'aggregate functions must be a direct call in a projection item';
    private static readonly DefaultMaxVarLength = 15;
    private static readonly PathVarNeedsVarLength = 'a path variable requires a variable-length relationship';
    private static readonly VarLengthIntoBoundUnsupported = 'variable-length expansion into an already-bound node is not yet supported';
    private static readonly StrictScopeReuse = 'variable reused after being dropped by an earlier WITH';
    private static readonly DuplicateColumn = 'multiple result columns with the same name are not supported';

    private readonly maxVarLength: number;
    private readonly strictWithScope: boolean;

    constructor(
        private readonly source: ICypherSource,
        private readonly parameters: ReadonlyMap<string, CypherValue>,
        options?: PlannerOptions,
        private readonly cancel?: ICancellation,
        // Paging needs a stable order: when set, an unordered final RETURN is sorted by all its columns (ascending).
        private readonly ensureOrder: boolean = false,
        // Only write-capable plans (PlanForWrite) supply one; read planning omits it.
        private readonly sink?: ICypherSink,
    )
    {
        this.maxVarLength = options?.MaxVarLength ?? LogicalPlanner.DefaultMaxVarLength;
        this.strictWithScope = options?.StrictWithScope ?? false;
    }

    /**
     * The operator tree for a query over the source, one line per operator, children indented. Planning only:
     * nothing is read. A write query is planned with an ExplainSink (its writes compile against an empty overlay
     * and would refuse to run), and its final projection is shown over the mutation pipeline. Parameters are
     * needed only when SKIP/LIMIT use them; `paging` adds the implicit total-order Sort a paged read gets (ignored
     * for a write, which is never paged). CypherEngine.Explain delegates here.
     */
    public static Explain(source: ICypherSource, query: string | CypherQueryModel, parameters: ReadonlyMap<string, CypherValue> = new Map(), options?: PlannerOptions, paging: boolean = false): string
    {
        const model = typeof query === 'string' ? new CypherParser(query).Parse() : query;
        if (!model.HasWrites())
        {
            return OperatorPrinter.Print(new LogicalPlanner(source, parameters, options, undefined, paging).Plan(model));
        }
        const sink = new ExplainSink(source);
        const planner = new LogicalPlanner(sink.View, parameters, options, undefined, false, sink);
        const plan = planner.PlanForWrite(model);
        return OperatorPrinter.Print(plan.Projection === undefined ? plan.Mutations : planner.ProjectOver(plan.Mutations, plan.Projection));
    }

    public Plan(model: CypherQueryModel): IOperator
    {
        let inScope = new Set<string>();
        const everBound = new Set<string>();
        let op: IOperator | undefined = undefined;
        for (const part of model.Parts)
        {
            this.ensureUniqueColumns(part);
            if (this.strictWithScope) this.checkStrictScope(part, inScope, everBound);
            op = this.compilePart(part, op, inScope, part === model.Parts[model.Parts.length - 1]);
            for (const v of this.readingVariables(part)) everBound.add(v);
            if (part.Projection === undefined) continue;
            for (const item of part.Projection.Items) everBound.add(item.ColumnName());
            if (!part.Projection.IsReturn)
            {
                inScope = new Set<string>(part.Projection.Items.map((i) => i.ColumnName()));
            }
        }
        // Parse/fluent invariants guarantee at least one part, so op is always assigned.
        return op!;
    }

    /**
     * Builds the full clause pipeline across all parts, but returns the FINAL part's projection separately so the
     * caller runs it over the drained mutation rows (ProjectOver). Intermediate WITH projections stay inline.
     */
    public PlanForWrite(model: CypherQueryModel): IWritePlan
    {
        let inScope = new Set<string>();
        const everBound = new Set<string>();
        let op: IOperator | undefined = undefined;
        let projection: ProjectionClause | undefined = undefined;
        const last = model.Parts[model.Parts.length - 1];
        for (const part of model.Parts)
        {
            const isFinal = part === last;
            this.ensureUniqueColumns(part);
            if (this.strictWithScope) this.checkStrictScope(part, inScope, everBound);
            op = this.compilePart(part, op, inScope, isFinal, isFinal);
            if (isFinal) projection = part.Projection;
            for (const v of this.readingVariables(part)) everBound.add(v);
            if (part.Projection === undefined) continue;
            for (const item of part.Projection.Items) everBound.add(item.ColumnName());
            if (!part.Projection.IsReturn)
            {
                inScope = new Set<string>(part.Projection.Items.map((i) => i.ColumnName()));
            }
        }
        return { Mutations: op!, Projection: projection };
    }

    public ProjectOver(source: IOperator, projection: ProjectionClause): IOperator
    {
        return this.buildProjection(source, projection, this.ensureOrder);
    }

    // Planner-internal entry for OptionalMatchPlan (TypeScript has no friend access); not part of the planner API.
    public CompileInner(row: Binding, inner: MatchClause, outerBound: ReadonlySet<string>): IOperator
    {
        return this.compileMatch(new BindingRow(row), inner, new Set<string>(outerBound));
    }

    private readingVariables(part: QueryPart): Set<string>
    {
        const out = new Set<string>();
        for (const clause of part.Reading)
        {
            if (clause instanceof MatchClause) for (const v of clause.DeclaredVariables()) out.add(v);
            else if (clause instanceof UnwindClause) out.add(clause.Variable);
            else if (clause instanceof CreateClause || clause instanceof MergeClause) for (const v of clause.DeclaredVariables()) out.add(v);
        }
        return out;
    }

    // openCypher: projection column names must be unique. A Binding-keyed row would otherwise keep only the last
    // duplicate silently, and a duplicate WITH name makes the downstream variable ambiguous.
    private ensureUniqueColumns(part: QueryPart): void
    {
        if (part.Projection === undefined) return;
        const seen = new Set<string>();
        for (const item of part.Projection.Items)
        {
            const name = item.ColumnName();
            if (seen.has(name)) throw new CypherSemanticError(`${LogicalPlanner.DuplicateColumn}: "${name}"`);
            seen.add(name);
        }
    }

    // Strict mode: a MATCH/UNWIND variable bound in a PRIOR segment but not carried into this segment's inScope is
    // a dropped-then-reused name; reject it.
    private checkStrictScope(part: QueryPart, inScope: ReadonlySet<string>, everBound: ReadonlySet<string>): void
    {
        for (const v of this.readingVariables(part))
        {
            if (!inScope.has(v) && everBound.has(v))
            {
                throw new CypherSemanticError(`${LogicalPlanner.StrictScopeReuse}: "${v}"`);
            }
        }
    }

    private compilePart(part: QueryPart, input: IOperator | undefined, inScope: ReadonlySet<string>, isFinal: boolean, deferProjection: boolean = false): IOperator
    {
        const declared = new Set<string>(inScope);
        for (const v of this.readingVariables(part)) declared.add(v);
        this.validateScope(part, declared);

        const pipelineBound = new Set<string>(inScope);
        let op = input;
        for (const clause of part.Reading)
        {
            if (clause instanceof MatchClause)
            {
                op = this.compileMatch(op, clause, pipelineBound);
            }
            else if (clause instanceof UnwindClause)
            {
                op = new Unwind(op ?? new SingleRow(), clause.Expr, clause.Variable, this.parameters);
                pipelineBound.add(clause.Variable);
            }
            else if (clause instanceof WritingClause)
            {
                op = this.compileWrite(op, clause, pipelineBound);
            }
        }
        if (op === undefined) op = new SingleRow();
        if (part.Projection === undefined || deferProjection) return op;
        return this.buildProjection(op, part.Projection, isFinal && this.ensureOrder);
    }

    // Reads feeding a write finish before it starts and the write finishes before anything above reads (EagerBarrier).
    private compileWrite(input: IOperator | undefined, clause: WritingClause, bound: Set<string>): IOperator
    {
        const sink = this.sink;
        if (sink === undefined) throw new CypherSemanticError(LogicalPlanner.WritesNotExecutable);
        const view = sink.View;
        const source = input === undefined ? new SingleRow() : input instanceof EagerBarrier ? input : new EagerBarrier(input, view, this.cancel);
        let op: IOperator;
        if (clause instanceof CreateClause)
        {
            op = new CreateOperator(source, clause, this.source, sink, bound);
            for (const v of clause.DeclaredVariables()) bound.add(v);
        }
        else if (clause instanceof MergeClause)
        {
            const before = new Set<string>(bound);
            const matcher = new OptionalMatchPlan(this, new MatchClause([clause.Pattern], undefined, false), before);
            op = new MergeOperator(source, clause, this.source, sink, new SetApplier(sink, this.parameters), matcher, before);
            for (const v of clause.DeclaredVariables()) bound.add(v);
        }
        else if (clause instanceof SetClause) op = new SetOperator(source, clause, new SetApplier(sink, this.parameters));
        else if (clause instanceof DeleteClause) op = new DeleteOperator(source, clause, sink, this.parameters);
        else if (clause instanceof RemoveClause) op = new RemoveOperator(source, clause, sink);
        else throw new CypherSemanticError(LogicalPlanner.WritesNotExecutable);
        return new EagerBarrier(op, view, this.cancel);
    }

    private static CollectSetItems(items: readonly SetItem[], referenced: Set<string>): void
    {
        for (const item of items)
        {
            referenced.add(item.Variable);
            item.Value.CollectVariables(referenced);
        }
    }

    private validateScope(part: QueryPart, available: ReadonlySet<string>): void
    {
        const referenced = new Set<string>();
        for (const clause of part.Reading)
        {
            if (clause instanceof MatchClause) clause.Where?.Predicate.CollectVariables(referenced);
            else if (clause instanceof UnwindClause) clause.Expr.CollectVariables(referenced);
            else if (clause instanceof SetClause) LogicalPlanner.CollectSetItems(clause.Items, referenced);
            else if (clause instanceof MergeClause)
            {
                LogicalPlanner.CollectSetItems(clause.OnCreate, referenced);
                LogicalPlanner.CollectSetItems(clause.OnMatch, referenced);
            }
            else if (clause instanceof DeleteClause) for (const t of clause.Targets) t.CollectVariables(referenced);
            else if (clause instanceof RemoveClause) for (const i of clause.Items) referenced.add(i.Variable);
        }
        for (const item of part.Projection?.Items ?? []) item.Expr.CollectVariables(referenced);
        // ORDER BY / SKIP / LIMIT may refer to projection aliases, so they are not scope-checked here.
        for (const v of referenced)
        {
            if (!available.has(v)) throw new CypherSemanticError(`${LogicalPlanner.UnboundVariable}: "${v}"`);
        }
    }

    private compileMatch(input: IOperator | undefined, match: MatchClause, bound: Set<string>): IOperator
    {
        if (match.Optional)
        {
            return this.compileOptionalMatch(input, match, bound);
        }
        const conjuncts = match.Where === undefined ? [] : SeekEquality.Conjuncts(match.Where.Predicate);
        const seeks = conjuncts.map(c => SeekEquality.TryParse(c)).filter((e): e is SeekEquality => e !== undefined);
        const consumed = new Set<Expression>();
        let op = input;
        for (const path of match.Paths)
        {
            op = this.compilePath(op, path, bound, seeks, consumed);
        }
        if (op === undefined) op = new SingleRow();
        if (match.Where !== undefined)
        {
            const predicate = consumed.size === 0 ? match.Where.Predicate : SeekEquality.Join(conjuncts.filter(c => !consumed.has(c)));
            if (predicate !== undefined) op = new Filter(op, predicate, this.parameters);
        }
        return op;
    }

    private compileOptionalMatch(input: IOperator | undefined, match: MatchClause, bound: Set<string>): IOperator
    {
        const source = input ?? new SingleRow();
        const outerBound = new Set<string>(bound);
        const optionalVars = [...match.DeclaredVariables()].filter((v) => !outerBound.has(v));
        const inner = new MatchClause(match.Paths, match.Where, false);
        // Resolve the inner labels now, so an unknown label fails at planning even if no outer row arrives.
        this.validateLabels(inner);
        const plan = new OptionalMatchPlan(this, inner, outerBound);
        for (const v of optionalVars) bound.add(v);
        return new OptionalApply(source, plan, optionalVars);
    }

    private compilePath(input: IOperator | undefined, path: PatternPath, bound: Set<string>, seeks: readonly SeekEquality[], consumed: Set<Expression>): IOperator
    {
        this.validateRels(path);
        const names = path.Nodes.map((n, i) => n.Variable ?? `${LogicalPlanner.AnonPrefix}${i}`);
        const anchor = path.Nodes[0]!;
        const anchorReused = anchor.Variable !== undefined && bound.has(anchor.Variable) && input !== undefined;

        let op: IOperator;
        if (anchorReused)
        {
            op = this.foldReusedConstraints(input, anchor, names[0]!);
        }
        else
        {
            const seek = this.trySeek(anchor, names[0]!, seeks);
            const scan = seek?.Op ?? this.anchor(anchor, names[0]!);
            if (seek?.Source !== undefined) consumed.add(seek.Source);
            op = input === undefined ? scan : new CartesianProduct(input, scan, this.cancel);
            op = this.foldNodeProperties(op, anchor, names[0]!, seek?.InlineKey);
            if (anchor.Variable !== undefined) bound.add(anchor.Variable);
        }

        // Limitation: a path variable binds the PathValue of the LAST variable-length rel in the path
        // (exact for the common single-rel case); fixed-only paths cannot bind one yet.
        let pathVarRel = -1;
        for (let i = 0; i < path.Rels.length; i++) if (path.Rels[i]!.IsVariableLength) pathVarRel = i;
        if (path.PathVariable !== undefined && pathVarRel < 0)
        {
            throw new CypherSemanticError(LogicalPlanner.PathVarNeedsVarLength);
        }

        for (let i = 0; i < path.Rels.length; i++)
        {
            const rel = path.Rels[i]!;
            const toNode = path.Nodes[i + 1]!;
            const toLabel = this.resolve(toNode.Label);
            const targetBound = toNode.Variable !== undefined && bound.has(toNode.Variable);
            if (rel.IsVariableLength)
            {
                // Var-length into an already-bound target (depth ranges + optional path variable) is a harder
                // case not yet implemented; a loud error beats silently clobbering the bound node.
                if (targetBound) throw new CypherSemanticError(LogicalPlanner.VarLengthIntoBoundUnsupported);
                const pathVar = i === pathVarRel ? path.PathVariable : undefined;
                op = new VarLengthExpand(op, this.source, names[i]!, names[i + 1]!, rel.RelType, rel.Direction,
                    rel.MinHops ?? 1, rel.MaxHops ?? this.maxVarLength, toLabel, pathVar, rel.Variable, this.cancel);
            }
            else if (targetBound)
            {
                // Reusing a variable reached by expansion: constrain the hop to the bound node (equality by
                // identity) instead of rebinding it. Any label/property written on this reused occurrence is
                // applied as a filter after the join; no re-bind here.
                op = new ExpandInto(op, this.source, names[i]!, names[i + 1]!, rel.RelType, rel.Direction, rel.Variable, this.cancel);
                op = this.foldReusedConstraints(op, toNode, names[i + 1]!);
                continue;
            }
            else
            {
                op = new Expand(op, this.source, names[i]!, names[i + 1]!, rel.RelType, rel.Direction, toLabel, rel.Variable, this.cancel);
            }
            op = this.foldNodeProperties(op, toNode, names[i + 1]!);
            if (toNode.Variable !== undefined) bound.add(toNode.Variable);
        }
        return op;
    }

    private validateRels(path: PatternPath): void
    {
        for (const r of path.Rels)
        {
            if (r.Properties.size > 0)
            {
                throw new CypherSemanticError(LogicalPlanner.RelPropsUnsupported);
            }
            if (r.RelType !== undefined && !this.source.HasRelationship(r.RelType))
            {
                throw new CypherSemanticError(`${LogicalPlanner.UnknownRelType} "${r.RelType}"`);
            }
        }
    }

    private validateLabels(match: MatchClause): void
    {
        for (const path of match.Paths)
        {
            this.validateRels(path);
            for (const node of path.Nodes) this.resolve(node.Label);
        }
    }

    private resolve(label: string | undefined): string | undefined
    {
        return label === undefined ? undefined : this.source.ResolveLabel(label);
    }

    private buildProjection(input: IOperator, projection: ProjectionClause, implicitOrder: boolean): IOperator
    {
        const groupingItems: ReturnItem[] = [];
        const aggregateItems: AggregateItem[] = [];
        for (const item of projection.Items)
        {
            if (item.Expr.ContainsAggregate())
            {
                aggregateItems.push({ Column: item.ColumnName(), Call: this.aggregateCall(item) });
            }
            else
            {
                groupingItems.push(item);
            }
        }

        let op: IOperator = aggregateItems.length > 0
            ? new Aggregate(input, groupingItems, aggregateItems, this.parameters, this.cancel)
            : new Project(input, projection.Items, this.parameters);

        if (projection.Distinct) op = new Distinct(op, projection.Items.map((i) => i.ColumnName()), this.cancel);
        // HAVING-style: WITH ... WHERE filters the projected/aggregated rows, then ORDER BY/SKIP/LIMIT paginate the
        // filtered set.
        if (projection.Where !== undefined) op = new Filter(op, this.resolveWithWhere(projection), this.parameters);
        if (projection.OrderBy !== undefined)
        {
            op = new Sort(op, this.resolveOrderBy(projection), this.parameters, this.cancel);
        }
        else if (implicitOrder)
        {
            op = new Sort(op, this.implicitOrder(projection), this.parameters, this.cancel);
        }
        if (projection.Skip !== undefined) op = new Skip(op, this.evalCount(projection.Skip));
        if (projection.Limit !== undefined) op = new Limit(op, this.evalCount(projection.Limit));
        return op;
    }

    // Projected expression StructuralKey -> output column name. First projected item wins for duplicate projections
    // (identical values). Shared by WITH ... WHERE and ORDER BY resolution so the two stay in lockstep.
    private projectedColumnsByKey(projection: ProjectionClause): Map<string, string>
    {
        const byKey = new Map<string, string>();
        for (const item of projection.Items)
        {
            const key = item.Expr.StructuralKey();
            if (!byKey.has(key)) byKey.set(key, item.ColumnName());
        }
        return byKey;
    }

    // WITH ... WHERE runs over the projected rows. Symmetric with ORDER BY: any predicate sub-expression structurally
    // equal to a projected expression (WITH a.name AS n WHERE a.name = 'x') is rewritten to read that output column.
    // Whatever remains must reference projected output columns by NAME/alias, else it is an unknown WHERE column.
    private resolveWithWhere(projection: ProjectionClause): Expression
    {
        const columns = new Set<string>(projection.Items.map((i) => i.ColumnName()));
        const byKey = this.projectedColumnsByKey(projection);
        const rewritten = projection.Where!.Predicate.Rewrite((e) =>
        {
            const column = byKey.get(e.StructuralKey());
            return column === undefined ? undefined : new VariableRef(column);
        });
        const referenced = new Set<string>();
        rewritten.CollectVariables(referenced);
        for (const v of referenced)
        {
            if (!columns.has(v)) throw new CypherSemanticError(`${LogicalPlanner.UnknownWhereColumn}: "${v}"`);
        }
        return rewritten;
    }

    // Sort runs over the projected rows. A sort expression structurally equal to ANY projected expression
    // (RETURN a.x + 1 ORDER BY a.x + 1) is rewritten to read that output column; any other sort expression may only
    // reference projected output columns, else it is an unknown ORDER BY column.
    private resolveOrderBy(projection: ProjectionClause, orderBy: readonly SortItem[] = projection.OrderBy!): SortItem[]
    {
        const columns = new Set<string>(projection.Items.map((i) => i.ColumnName()));
        const byKey = this.projectedColumnsByKey(projection);
        return orderBy.map((sort) =>
        {
            const matched = byKey.get(sort.Expr.StructuralKey());
            if (matched !== undefined) return new SortItem(new VariableRef(matched), sort.Descending);
            const referenced = new Set<string>();
            sort.Expr.CollectVariables(referenced);
            for (const v of referenced)
            {
                if (!columns.has(v)) throw new CypherSemanticError(`${LogicalPlanner.UnknownOrderByColumn}: "${v}"`);
            }
            return sort;
        });
    }

    // Implicit paging order: ORDER BY all projected columns, ascending, resolved exactly as explicit alias references.
    // Ordering on every projected column makes this a total order so ties can't reorder a page split; rows equal in
    // every column are indistinguishable on the wire.
    private implicitOrder(projection: ProjectionClause): SortItem[]
    {
        const order = projection.Items.map((item) => new SortItem(new VariableRef(item.ColumnName()), false));
        return this.resolveOrderBy(projection, order);
    }

    private aggregateCall(item: ReturnItem): FunctionCall
    {
        if (item.Expr instanceof FunctionCall) return item.Expr;
        throw new CypherSemanticError(LogicalPlanner.NestedAggregate);
    }

    // SKIP/LIMIT counts: an Int64 (the integer literal type, R81 a) or a Float64; Skip and Limit clamp/truncate.
    private evalCount(expr: Expression): number
    {
        const value = expr.Evaluate(new EvalContext(new Binding(), this.parameters));
        if (value instanceof ScalarValue && typeof value.Value === 'bigint') return Number(value.Value);
        if (value instanceof ScalarValue && typeof value.Value === 'number') return value.Value;
        throw new CypherSemanticError(LogicalPlanner.NonNumericLimit);
    }

    private anchor(node: NodePattern, name: string): IOperator
    {
        const label = this.resolve(node.Label);
        return label === undefined ? new AllNodesScan(this.source, name, this.cancel) : new LabelScan(this.source, name, label, this.cancel);
    }

    // An index seek for a freshly bound labelled anchor: an inline property first, then a top-level WHERE equality on
    // the anchor's variable, whichever has a usable index. The consumed inline key or WHERE conjunct is not filtered
    // again.
    private trySeek(node: NodePattern, name: string, seeks: readonly SeekEquality[]): ISeekChoice | undefined
    {
        const label = this.resolve(node.Label);
        if (label === undefined) return undefined;
        for (const [key, value] of node.Properties)
        {
            const index = this.source.IndexFor(label, key);
            if (index !== undefined)
            {
                return { Op: new IndexSeek(this.source, name, label, key, index, new Literal(value), this.parameters, this.cancel), InlineKey: key, Source: undefined };
            }
        }
        if (node.Variable === undefined) return undefined;
        for (const seek of seeks)
        {
            const index = seek.Variable === node.Variable ? this.source.IndexFor(label, seek.Property) : undefined;
            if (index !== undefined)
            {
                return { Op: new IndexSeek(this.source, name, label, seek.Property, index, seek.Value, this.parameters, this.cancel), InlineKey: undefined, Source: seek.Source };
            }
        }
        return undefined;
    }

    private foldReusedConstraints(op: IOperator, node: NodePattern, name: string): IOperator
    {
        let result = op;
        const label = this.resolve(node.Label);
        if (label !== undefined) result = new LabelFilter(result, this.source, name, label);
        return this.foldNodeProperties(result, node, name);
    }

    private foldNodeProperties(op: IOperator, node: NodePattern, name: string, skipKey?: string): IOperator
    {
        let result = op;
        for (const [key, value] of node.Properties)
        {
            if (key === skipKey) continue;
            result = new Filter(result, new Comparison(new PropertyAccess(name, key), ComparisonOp.Eq, new Literal(value)), this.parameters);
        }
        return result;
    }
}
