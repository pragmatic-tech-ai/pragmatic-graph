import type { IAssignedLink } from '../../connectors/GraphConnector.js';
import type { Binding } from '../Binding.js';
import { RelDirection } from '../CypherEnums.js';
import { CypherSemanticError } from '../CypherError.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue, NullValue } from '../CypherValue.js';
import type { PatternPath } from '../PatternPath.js';
import { RelOrientation } from '../operators/RelOrientation.js';
import type { ICypherSink } from './CypherSink.js';
import { WriteSupport } from './WriteSupport.js';

/** One relationship of a pattern, with the node positions it links and the source → target its direction gives. */
export interface IPatternRel
{
    readonly Rel: PatternPath['Rels'][number];
    readonly Left: number;
    readonly Right: number;
    readonly Source: number;
    readonly Target: number;
}

/**
 * The stage plan of one pattern (ruling R140 E10), shared by the per-row PathCreator and the batched operator: the
 * creation order of its new nodes (a new external source follows its new-node targets), the stages of new external
 * nodes (targets first, one connector step per stage), and the relationship indices folded into an external source's
 * create. A relationship not folded is created loosely after all nodes — this is where a link-cycle among new
 * external nodes defers its closing link, so a folded link never points at a node that is not created yet.
 */
export interface IStagePlan
{
    readonly Order: readonly number[];
    readonly Stages: readonly (readonly number[])[];
    readonly Folded: ReadonlySet<number>;
}

/**
 * Writes a pattern for one row: reuses its bound nodes, creates the rest (label required), creates every
 * relationship in its direction (an edge already present is not duplicated), and binds every node and
 * relationship variable. Shared by CREATE (always writes) and MERGE (writes when the pattern does not match).
 */
export class PathCreator
{
    private static readonly NoLinks: readonly IAssignedLink[] = [];

    constructor(private readonly source: ICypherSource, private readonly sink: ICypherSink)
    {
    }

    /**
     * Fail fast, before any write: every created relationship needs a type and a direction, and cannot be
     * variable-length.
     */
    public static ValidateRels(path: PatternPath): void
    {
        for (const rel of path.Rels)
        {
            if (rel.IsVariableLength) throw new CypherSemanticError(WriteSupport.VarLengthCreate);
            if (rel.RelType === undefined) throw new CypherSemanticError(WriteSupport.RelTypeRequired);
            if (rel.Direction === RelDirection.Undirected) throw new CypherSemanticError(WriteSupport.RelDirectionRequired);
        }
    }

    /** Resolves the label of every node the pattern may create, so an unknown label fails at planning. */
    public static ValidateLabels(source: ICypherSource, path: PatternPath, bound: ReadonlySet<string>): void
    {
        for (const node of path.Nodes)
        {
            const reused = node.Variable !== undefined && bound.has(node.Variable);
            if (node.Label !== undefined && !reused) source.ResolveLabel(node.Label);
        }
    }

    /** The pattern's relationships as source → target positions by direction (shared with the batched operator). */
    public static Rels(path: PatternPath): readonly IPatternRel[]
    {
        return path.Rels.map<IPatternRel>((rel, i) =>
        {
            const outgoing = rel.Direction === RelDirection.Outgoing;
            return { Rel: rel, Left: i, Right: i + 1, Source: outgoing ? i : i + 1, Target: outgoing ? i + 1 : i };
        });
    }

    public async Create(row: Binding, path: PatternPath): Promise<Binding>
    {
        let current = row;
        const count = path.Nodes.length;
        const ids: (string | undefined)[] = new Array<string | undefined>(count).fill(undefined);
        const concepts: (string | undefined)[] = new Array<string | undefined>(count).fill(undefined);
        const isNew: boolean[] = new Array<boolean>(count).fill(false);
        // A new node whose concept binds to an External connector: its targets are created first and its outgoing
        // links are folded into its create (ruling R136 E4). An engine (or bound) node keeps its pattern order.
        const external: boolean[] = new Array<boolean>(count).fill(false);
        for (let i = 0; i < count; i++)
        {
            const node = path.Nodes[i]!;
            const existing = node.Variable === undefined ? undefined : current.Get(node.Variable);
            if (existing instanceof NullValue) throw new CypherSemanticError(`${WriteSupport.NullEndpoint}: "${node.Variable}"`);
            const existingId = WriteSupport.NodeId(existing);
            if (existingId !== undefined)
            {
                ids[i] = existingId;
            }
            else
            {
                if (node.Label === undefined) throw new CypherSemanticError(WriteSupport.LabelRequired);
                isNew[i] = true;
                concepts[i] = this.source.ResolveLabel(node.Label);
                external[i] = this.sink.IsExternalConcept(concepts[i]!);
            }
        }
        const rels = PathCreator.Rels(path);
        const plan = PathCreator.StagePlan(count, isNew, external, rels);
        // A new external source's folded outgoing links need their targets' ids, so those targets are created first.
        for (const pos of plan.Order)
        {
            const links = rels.filter((_, i) => plan.Folded.has(i) && rels[i]!.Source === pos).map<IAssignedLink>(r => ({ Relationship: r.Rel.RelType!, To: ids[r.Target]! }));
            const created = new NodeValue(await this.sink.CreateNode(concepts[pos]!, path.Nodes[pos]!.Properties, links));
            ids[pos] = created.Id;
            const variable = path.Nodes[pos]!.Variable;
            if (variable !== undefined) current = current.With(variable, created);
        }
        // Every relationship not folded into an external source's create is made now; every relationship variable is bound.
        for (let i = 0; i < rels.length; i++)
        {
            const r = rels[i]!;
            const left = ids[r.Left]!;
            const right = ids[r.Right]!;
            if (!plan.Folded.has(i)) await this.sink.CreateRelationship(ids[r.Source]!, r.Rel.RelType!, ids[r.Target]!);
            if (r.Rel.Variable !== undefined) current = current.With(r.Rel.Variable, RelOrientation.Oriented(r.Rel.Direction, r.Rel.RelType!, left, right));
        }
        return current;
    }

    /**
     * The creation order, stages and folded links for a pattern whose new/external positions are known (ruling R140
     * E10). A new external source folds a relationship to a target whose id is known by the time it is created (a
     * reused node, or a new node created earlier); a relationship among new external nodes that would close a cycle is
     * left loose, created after every node, so no folded link ever points at a node not created yet.
     */
    public static StagePlan(count: number, isNew: readonly boolean[], external: readonly boolean[], rels: readonly IPatternRel[]): IStagePlan
    {
        const deps = new Map<number, number[]>();
        for (const r of rels)
        {
            if (!(isNew[r.Source] && external[r.Source]) || !isNew[r.Target]) continue;
            const list = deps.get(r.Source);
            if (list === undefined) deps.set(r.Source, [r.Target]);
            else list.push(r.Target);
        }
        const order: number[] = [];
        const rank = new Array<number>(count).fill(-1);
        const state = new Array<number>(count).fill(0);
        for (let i = 0; i < count; i++)
        {
            if (isNew[i]) PathCreator.Visit(i, deps, state, order, rank);
        }
        const folded = new Set<number>();
        for (let i = 0; i < rels.length; i++)
        {
            const r = rels[i]!;
            if (!(isNew[r.Source] && external[r.Source])) continue;
            // Fold only when the target id is known at the source's creation: a reused node, or a new node ranked
            // earlier. A cycle back-edge (target created later) stays loose (M2 cycle guard).
            if (!isNew[r.Target] || rank[r.Target]! < rank[r.Source]!) folded.add(i);
        }
        return { Order: order, Stages: PathCreator.Levels(order, external, folded, rels), Folded: folded };
    }

    // Depth-first post-order (targets before their source), skipping a back-edge to a node still on the stack so a
    // cycle does not loop; `rank` is the position of each node in the emitted order.
    private static Visit(pos: number, deps: ReadonlyMap<number, number[]>, state: number[], order: number[], rank: number[]): void
    {
        if (state[pos] !== 0) return;
        state[pos] = 1;
        for (const dep of deps.get(pos) ?? [])
        {
            if (state[dep] !== 1) PathCreator.Visit(dep, deps, state, order, rank);
        }
        state[pos] = 2;
        rank[pos] = order.length;
        order.push(pos);
    }

    // The stages of new external nodes (targets first): a node's stage is one past the latest stage of a new external
    // target it folds a link to, else stage 0. Non-external new nodes are created individually, not in a stage.
    private static Levels(order: readonly number[], external: readonly boolean[], folded: ReadonlySet<number>, rels: readonly IPatternRel[]): number[][]
    {
        const level = new Map<number, number>();
        const stages: number[][] = [];
        for (const pos of order)
        {
            if (!external[pos]) continue;
            let lvl = 0;
            for (let i = 0; i < rels.length; i++)
            {
                const r = rels[i]!;
                if (folded.has(i) && r.Source === pos && external[r.Target] && level.has(r.Target))
                {
                    lvl = Math.max(lvl, level.get(r.Target)! + 1);
                }
            }
            level.set(pos, lvl);
            (stages[lvl] ??= []).push(pos);
        }
        return stages;
    }
}
