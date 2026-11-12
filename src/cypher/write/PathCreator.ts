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
interface IPatternRel
{
    readonly Rel: PatternPath['Rels'][number];
    readonly Left: number;
    readonly Right: number;
    readonly Source: number;
    readonly Target: number;
}

/**
 * Writes a pattern for one row: reuses its bound nodes, creates the rest (label required), creates every
 * relationship in its direction (an edge already present is not duplicated), and binds every node and
 * relationship variable. Shared by CREATE (always writes) and MERGE (writes when the pattern does not match).
 */
export class PathCreator
{
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
        const rels = path.Rels.map<IPatternRel>((rel, i) =>
        {
            const outgoing = rel.Direction === RelDirection.Outgoing;
            return { Rel: rel, Left: i, Right: i + 1, Source: outgoing ? i : i + 1, Target: outgoing ? i + 1 : i };
        });
        // A new external source's folded outgoing links need their targets' ids, so those targets are created first.
        for (const pos of PathCreator.CreationOrder(count, isNew, external, rels))
        {
            const links = external[pos] ? rels.filter(r => r.Source === pos).map<IAssignedLink>(r => ({ Relationship: r.Rel.RelType!, To: ids[r.Target]! })) : PathCreator.NoLinks;
            const created = new NodeValue(await this.sink.CreateNode(concepts[pos]!, path.Nodes[pos]!.Properties, links));
            ids[pos] = created.Id;
            const variable = path.Nodes[pos]!.Variable;
            if (variable !== undefined) current = current.With(variable, created);
        }
        // Every relationship not folded into an external source's create is made now; every relationship variable is bound.
        for (const r of rels)
        {
            const left = ids[r.Left]!;
            const right = ids[r.Right]!;
            if (!(isNew[r.Source] && external[r.Source])) await this.sink.CreateRelationship(ids[r.Source]!, r.Rel.RelType!, ids[r.Target]!);
            if (r.Rel.Variable !== undefined) current = current.With(r.Rel.Variable, RelOrientation.Oriented(r.Rel.Direction, r.Rel.RelType!, left, right));
        }
        return current;
    }

    private static readonly NoLinks: readonly IAssignedLink[] = [];

    /** The new-node positions in creation order: a new external source follows its new-node targets; others keep pattern order. */
    private static CreationOrder(count: number, isNew: readonly boolean[], external: readonly boolean[], rels: readonly IPatternRel[]): number[]
    {
        const deps = new Map<number, number[]>();
        for (const r of rels)
        {
            if (!external[r.Source] || !isNew[r.Target]) continue;
            const list = deps.get(r.Source);
            if (list === undefined) deps.set(r.Source, [r.Target]);
            else list.push(r.Target);
        }
        const order: number[] = [];
        const visited = new Set<number>();
        for (let i = 0; i < count; i++)
        {
            if (isNew[i]) PathCreator.Visit(i, deps, visited, order);
        }
        return order;
    }

    private static Visit(pos: number, deps: ReadonlyMap<number, number[]>, visited: Set<number>, order: number[]): void
    {
        if (visited.has(pos)) return;
        visited.add(pos);
        for (const dep of deps.get(pos) ?? []) PathCreator.Visit(dep, deps, visited, order);
        order.push(pos);
    }
}
