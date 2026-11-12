import type { Binding } from '../Binding.js';
import { WriteMode } from '../CypherEnums.js';
import { CypherSemanticError } from '../CypherError.js';
import type { CreateClause } from '../CypherQueryModel.js';
import type { CypherNode } from '../CypherNode.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue, NullValue } from '../CypherValue.js';
import type { PatternPath } from '../PatternPath.js';
import type { IOperator } from '../operators/IOperator.js';
import { RelOrientation } from '../operators/RelOrientation.js';
import type { IAssignedLink } from '../../connectors/GraphConnector.js';
import type { IStagedCreate } from './CypherSink.js';
import type { ICypherSink } from './CypherSink.js';
import { PathCreator, type IPatternRel } from './PathCreator.js';
import { WriteSupport } from './WriteSupport.js';

/** The structural plan of one CREATE path, computed once for the whole clause and reused for every input row. */
interface IPathPlan
{
    readonly Path: PatternPath;
    readonly Rels: readonly IPatternRel[];
    readonly New: readonly boolean[];
    readonly External: readonly boolean[];
    readonly Concepts: readonly (string | undefined)[];
    readonly Order: readonly number[];
    readonly Stages: readonly (readonly number[])[];
    readonly Folded: ReadonlySet<number>;
}

/** Where a staged request came from: a row and the pattern position it creates, so the created node maps back. */
interface IRequestOrigin
{
    readonly Row: number;
    readonly Position: number;
}

/**
 * A batched CREATE (ruling R140 E10): drains every input row, then creates the clause's nodes one stage at a time
 * across all rows at once (new external targets first, each stage one connector step via ICypherSink.CreateNodes),
 * records engine nodes and the relationships not folded into an external source, flushes once, and yields the rows
 * in input order holding the real created nodes. Used only when WriteDependencyAnalysis found no later clause
 * depends on what this CREATE writes; a dependent CREATE stays per-row (CreateOperator).
 */
export class BatchedWriteOperator implements IOperator
{
    private readonly plans: readonly IPathPlan[];

    constructor(private readonly child: IOperator, clause: CreateClause, private readonly source: ICypherSource, private readonly sink: ICypherSink, private readonly bound: ReadonlySet<string>)
    {
        const plans: IPathPlan[] = [];
        for (const path of clause.Paths)
        {
            PathCreator.ValidateRels(path);
            PathCreator.ValidateLabels(source, path, bound);
            plans.push(this.PlanPath(path));
        }
        this.plans = plans;
    }

    private PlanPath(path: PatternPath): IPathPlan
    {
        const count = path.Nodes.length;
        const isNew = new Array<boolean>(count).fill(false);
        const external = new Array<boolean>(count).fill(false);
        const concepts = new Array<string | undefined>(count).fill(undefined);
        for (let i = 0; i < count; i++)
        {
            const node = path.Nodes[i]!;
            const reused = node.Variable !== undefined && this.bound.has(node.Variable);
            if (reused) continue;
            if (node.Label === undefined) throw new CypherSemanticError(WriteSupport.LabelRequired);
            isNew[i] = true;
            concepts[i] = this.source.ResolveLabel(node.Label);
            external[i] = this.sink.IsExternalConcept(concepts[i]!);
        }
        const rels = PathCreator.Rels(path);
        const plan = PathCreator.StagePlan(count, isNew, external, rels);
        return { Path: path, Rels: rels, New: isNew, External: external, Concepts: concepts, Order: plan.Order, Stages: plan.Stages, Folded: plan.Folded };
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const current: Binding[] = [];
        for await (const row of this.child.Rows()) current.push(row);
        for (const plan of this.plans)
        {
            const ids = current.map(() => new Array<string | undefined>(plan.Path.Nodes.length).fill(undefined));
            this.FillReused(plan, current, ids);
            await this.CreateEngineNodes(plan, current, ids);
            await this.CreateStages(plan, current, ids);
            await this.LinkLoose(plan, current, ids);
        }
        // One closing step for the engine nodes, loose links and any client-keyed records; the staged external
        // creates already flushed themselves (ruling R140 E10).
        await this.sink.EndStep();
        for (const row of current) yield row;
    }

    private FillReused(plan: IPathPlan, current: Binding[], ids: (string | undefined)[][]): void
    {
        for (let r = 0; r < current.length; r++)
        {
            for (let pos = 0; pos < plan.Path.Nodes.length; pos++)
            {
                if (plan.New[pos]) continue;
                const variable = plan.Path.Nodes[pos]!.Variable!;
                const value = current[r]!.Get(variable);
                if (value instanceof NullValue) throw new CypherSemanticError(`${WriteSupport.NullEndpoint}: "${variable}"`);
                ids[r]![pos] = WriteSupport.NodeId(value);
            }
        }
    }

    private async CreateEngineNodes(plan: IPathPlan, current: Binding[], ids: (string | undefined)[][]): Promise<void>
    {
        for (const pos of plan.Order)
        {
            if (!plan.New[pos] || plan.External[pos]) continue;
            for (let r = 0; r < current.length; r++)
            {
                this.Bind(plan, current, ids, r, pos, await this.sink.CreateNode(plan.Concepts[pos]!, plan.Path.Nodes[pos]!.Properties));
            }
        }
    }

    private async CreateStages(plan: IPathPlan, current: Binding[], ids: (string | undefined)[][]): Promise<void>
    {
        for (const stage of plan.Stages)
        {
            const requests: IStagedCreate[] = [];
            const origins: IRequestOrigin[] = [];
            for (let r = 0; r < current.length; r++)
            {
                for (const pos of stage)
                {
                    requests.push({ Concept: plan.Concepts[pos]!, Properties: plan.Path.Nodes[pos]!.Properties, Links: this.FoldedLinks(plan, ids[r]!, pos) });
                    origins.push({ Row: r, Position: pos });
                }
            }
            const created = await this.sink.CreateNodes(requests);
            for (let k = 0; k < origins.length; k++)
            {
                this.Bind(plan, current, ids, origins[k]!.Row, origins[k]!.Position, created[k]!);
            }
        }
    }

    private FoldedLinks(plan: IPathPlan, ids: (string | undefined)[], pos: number): readonly IAssignedLink[]
    {
        const links: IAssignedLink[] = [];
        for (let i = 0; i < plan.Rels.length; i++)
        {
            const rel = plan.Rels[i]!;
            if (plan.Folded.has(i) && rel.Source === pos) links.push({ Relationship: rel.Rel.RelType!, To: ids[rel.Target]! });
        }
        return links;
    }

    private async LinkLoose(plan: IPathPlan, current: Binding[], ids: (string | undefined)[][]): Promise<void>
    {
        for (let r = 0; r < current.length; r++)
        {
            for (let i = 0; i < plan.Rels.length; i++)
            {
                const rel = plan.Rels[i]!;
                if (!plan.Folded.has(i)) await this.sink.CreateRelationship(ids[r]![rel.Source]!, rel.Rel.RelType!, ids[r]![rel.Target]!);
                if (rel.Rel.Variable !== undefined)
                {
                    current[r] = current[r]!.With(rel.Rel.Variable, RelOrientation.Oriented(rel.Rel.Direction, rel.Rel.RelType!, ids[r]![rel.Left]!, ids[r]![rel.Right]!));
                }
            }
        }
    }

    private Bind(plan: IPathPlan, current: Binding[], ids: (string | undefined)[][], row: number, pos: number, node: CypherNode): void
    {
        ids[row]![pos] = node.PublicId;
        const variable = plan.Path.Nodes[pos]!.Variable;
        if (variable !== undefined) current[row] = current[row]!.With(variable, new NodeValue(node));
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }

    public Details(): readonly string[]
    {
        return [WriteSupport.ModeLabel(WriteMode.Batched)];
    }
}
