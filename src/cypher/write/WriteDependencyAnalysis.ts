import type { CatalogSnapshot } from '../../catalog/CatalogSnapshot.js';
import { WriteMode } from '../CypherEnums.js';
import {
    CreateClause, DeleteClause, MatchClause, MergeClause, RemoveClause, SetClause, UnwindClause, WritingClause,
    type CypherQueryModel, type ProjectionClause, type ReadingClause,
} from '../CypherQueryModel.js';
import { LabelResolver } from '../LabelResolver.js';
import type { NodePattern, PatternPath } from '../PatternPath.js';

/** One clause of the model in execution order, with the global index the analysis keys its modes by. */
interface IFlatClause
{
    readonly Index: number;
    readonly Reading?: ReadingClause;
    readonly Projection?: ProjectionClause;
}

/**
 * Decides, per write clause, whether its external writes may be batched across the input rows (ruling R140 E10). A
 * clause is Batched only when it can reach an external binding and no later clause depends on the rows it writes:
 * none references a variable it binds, none anchors a pattern on one, none reads by a label that may overlap what it
 * wrote, and nothing uses a construct the analysis does not model (a path variable over a written node, a later
 * write over a variable with no known label). Every undecidable case is PerRow — when unsure, go per-row.
 *
 * `external(concept)` is true when a node that is, inherits from or carries the concept may resolve to an external
 * connector (BindingTable.MayResolveExternal); engine-only writes are never steps, so their mode is moot and reported
 * PerRow.
 */
export class WriteDependencyAnalysis
{
    private readonly labels: LabelResolver;

    public constructor(private readonly catalog: CatalogSnapshot, private readonly external: (concept: string) => boolean)
    {
        this.labels = new LabelResolver(catalog);
    }

    /** One mode per clause index of the model; non-write clauses are absent. Conservative (E10). */
    public Modes(model: CypherQueryModel): ReadonlyMap<number, WriteMode>
    {
        const sequence = WriteDependencyAnalysis.Sequence(model);
        const variableLabels = this.VariableLabels(sequence);
        const modes = new Map<number, WriteMode>();
        for (let i = 0; i < sequence.length; i++)
        {
            const clause = sequence[i]!.Reading;
            if (clause instanceof WritingClause)
            {
                modes.set(sequence[i]!.Index, this.Classify(clause, i, sequence, variableLabels));
            }
        }
        return modes;
    }

    /** The global index of every write clause of the model, numbered as Modes keys them (shared with the planner). */
    public static WriteIndices(model: CypherQueryModel): ReadonlyMap<WritingClause, number>
    {
        const indices = new Map<WritingClause, number>();
        for (const entry of WriteDependencyAnalysis.Sequence(model))
        {
            if (entry.Reading instanceof WritingClause)
            {
                indices.set(entry.Reading, entry.Index);
            }
        }
        return indices;
    }

    /** Every reading clause and projection of the model in execution order, each with its global clause index. */
    private static Sequence(model: CypherQueryModel): readonly IFlatClause[]
    {
        const flat: IFlatClause[] = [];
        let index = 0;
        for (const part of model.Parts)
        {
            for (const clause of part.Reading)
            {
                flat.push({ Index: index++, Reading: clause });
            }
            if (part.Projection !== undefined)
            {
                flat.push({ Index: index++, Projection: part.Projection });
            }
        }
        return flat;
    }

    /** The resolved concept each variable is bound with across the model; undefined for an unlabeled or unresolvable binding (⊤). */
    private VariableLabels(sequence: readonly IFlatClause[]): ReadonlyMap<string, string | undefined>
    {
        const labels = new Map<string, string | undefined>();
        for (const entry of sequence)
        {
            const clause = entry.Reading;
            if (clause instanceof MatchClause) for (const path of clause.Paths) this.CollectPatternLabels(path, labels);
            else if (clause instanceof CreateClause) for (const path of clause.Paths) this.CollectPatternLabels(path, labels);
            else if (clause instanceof MergeClause) this.CollectPatternLabels(clause.Pattern, labels);
            else if (clause instanceof UnwindClause) labels.set(clause.Variable, undefined);
        }
        return labels;
    }

    private CollectPatternLabels(path: PatternPath, into: Map<string, string | undefined>): void
    {
        for (const node of path.Nodes)
        {
            if (node.Variable === undefined) continue;
            const concept = node.Label === undefined ? undefined : this.Resolve(node.Label);
            if (!into.has(node.Variable) || into.get(node.Variable) === undefined)
            {
                into.set(node.Variable, concept);
            }
        }
    }

    /** The mode of one write clause at `position` in `sequence` (ruling R140 E10). */
    private Classify(clause: WritingClause, position: number, sequence: readonly IFlatClause[], variableLabels: ReadonlyMap<string, string | undefined>): WriteMode
    {
        // MERGE's per-row match-or-create is not batched (E10, conservative); an engine-only write is not a step.
        if (clause instanceof MergeClause || !this.Reaches(clause, variableLabels))
        {
            return WriteMode.PerRow;
        }
        const written = WriteDependencyAnalysis.Written(clause);
        const labels = this.WrittenLabels(clause, variableLabels);
        for (let i = position + 1; i < sequence.length; i++)
        {
            if (!this.Independent(sequence[i]!, written, labels, variableLabels))
            {
                return WriteMode.PerRow;
            }
        }
        return WriteMode.Batched;
    }

    /** True when `later` neither references, anchors on, nor reads by an overlapping label the rows the clause wrote. */
    private Independent(later: IFlatClause, written: ReadonlySet<string>, labels: ReadonlySet<string> | undefined, variableLabels: ReadonlyMap<string, string | undefined>): boolean
    {
        const projection = later.Projection;
        if (projection !== undefined)
        {
            return WriteDependencyAnalysis.Disjoint(WriteDependencyAnalysis.ProjectionVariables(projection), written);
        }
        const clause = later.Reading!;
        if (!WriteDependencyAnalysis.Disjoint(WriteDependencyAnalysis.UsedVariables(clause), written))
        {
            return false;
        }
        if ((clause instanceof SetClause || clause instanceof RemoveClause || clause instanceof DeleteClause) && this.WritesUnknownLabel(clause, variableLabels))
        {
            return false;
        }
        if (clause instanceof MatchClause) return !this.Overlaps(clause.Paths, labels);
        return true;
    }

    /** True when the clause may write a node bound to an external connector (so its mode is not moot). */
    private Reaches(clause: WritingClause, variableLabels: ReadonlyMap<string, string | undefined>): boolean
    {
        if (clause instanceof CreateClause)
        {
            for (const path of clause.Paths)
            {
                for (const node of path.Nodes)
                {
                    if (node.Label !== undefined && this.IsExternalLabel(node.Label)) return true;
                }
            }
            return false;
        }
        for (const variable of WriteDependencyAnalysis.Written(clause))
        {
            const concept = variableLabels.get(variable);
            if (concept !== undefined && this.external(concept)) return true;
        }
        return false;
    }

    /** The label set of the nodes the clause writes; undefined (⊤) when any written node has no known label. */
    private WrittenLabels(clause: WritingClause, variableLabels: ReadonlyMap<string, string | undefined>): ReadonlySet<string> | undefined
    {
        const labels = new Set<string>();
        if (clause instanceof CreateClause)
        {
            for (const path of clause.Paths)
            {
                for (const node of path.Nodes)
                {
                    if (node.Variable !== undefined && node.Label === undefined) continue;
                    if (node.Label === undefined) return undefined;
                    const concept = this.Resolve(node.Label);
                    if (concept === undefined) return undefined;
                    labels.add(concept);
                }
            }
            return labels;
        }
        for (const variable of WriteDependencyAnalysis.Written(clause))
        {
            const concept = variableLabels.get(variable);
            if (concept === undefined) return undefined;
            labels.add(concept);
        }
        return labels;
    }

    /** True when a later SET / REMOVE / DELETE writes a variable whose label the analysis does not know (E10 rule 4). */
    private WritesUnknownLabel(clause: SetClause | RemoveClause | DeleteClause, variableLabels: ReadonlyMap<string, string | undefined>): boolean
    {
        for (const variable of WriteDependencyAnalysis.Written(clause))
        {
            if (!variableLabels.has(variable) || variableLabels.get(variable) === undefined) return true;
        }
        return false;
    }

    /** True when a pattern of `paths` reads by a label that may hold the written nodes (E10 rule 3). */
    private Overlaps(paths: readonly PatternPath[], labels: ReadonlySet<string> | undefined): boolean
    {
        if (labels === undefined) return true;
        for (const path of paths)
        {
            for (const node of path.Nodes)
            {
                if (this.NodeOverlaps(node, labels)) return true;
            }
        }
        return false;
    }

    private NodeOverlaps(node: NodePattern, labels: ReadonlySet<string>): boolean
    {
        if (node.Label === undefined)
        {
            for (const label of labels) if (this.external(label)) return true;
            return false;
        }
        const read = this.Resolve(node.Label);
        if (read === undefined) return true;
        for (const label of labels)
        {
            if (this.IsAEither(read, label)) return true;
        }
        return false;
    }

    private IsAEither(a: string, b: string): boolean
    {
        if (a === b) return true;
        if (!this.catalog.Has(a) || !this.catalog.Has(b)) return false;
        return this.catalog.IsA(a, b) || this.catalog.IsA(b, a);
    }

    private IsExternalLabel(label: string): boolean
    {
        const concept = this.Resolve(label);
        return concept !== undefined && this.external(concept);
    }

    private Resolve(label: string): string | undefined
    {
        try
        {
            return this.labels.Resolve(label);
        }
        catch
        {
            return undefined;
        }
    }

    /** The variables a clause writes (CREATE/MERGE: the nodes and relationships it introduces; SET/REMOVE/DELETE: what it changes). */
    private static Written(clause: WritingClause): ReadonlySet<string>
    {
        const out = new Set<string>();
        if (clause instanceof CreateClause) for (const v of clause.DeclaredVariables()) out.add(v);
        else if (clause instanceof MergeClause) for (const v of clause.DeclaredVariables()) out.add(v);
        else if (clause instanceof SetClause) for (const item of clause.Items) out.add(item.Variable);
        else if (clause instanceof RemoveClause) for (const item of clause.Items) out.add(item.Variable);
        else if (clause instanceof DeleteClause) for (const target of clause.Targets) target.CollectVariables(out);
        return out;
    }

    /** Every variable a clause names, in patterns and expressions (a reference to, or an endpoint on, any of them). */
    private static UsedVariables(clause: ReadingClause): ReadonlySet<string>
    {
        const out = new Set<string>();
        if (clause instanceof MatchClause)
        {
            for (const path of clause.Paths) WriteDependencyAnalysis.CollectPatternVariables(path, out);
            clause.Where?.Predicate.CollectVariables(out);
        }
        else if (clause instanceof UnwindClause) clause.Expr.CollectVariables(out);
        else if (clause instanceof CreateClause) for (const path of clause.Paths) WriteDependencyAnalysis.CollectPatternVariables(path, out);
        else if (clause instanceof MergeClause)
        {
            WriteDependencyAnalysis.CollectPatternVariables(clause.Pattern, out);
            for (const item of [...clause.OnCreate, ...clause.OnMatch])
            {
                out.add(item.Variable);
                item.Value.CollectVariables(out);
            }
        }
        else if (clause instanceof SetClause) for (const item of clause.Items) { out.add(item.Variable); item.Value.CollectVariables(out); }
        else if (clause instanceof RemoveClause) for (const item of clause.Items) out.add(item.Variable);
        else if (clause instanceof DeleteClause) for (const target of clause.Targets) target.CollectVariables(out);
        return out;
    }

    private static ProjectionVariables(projection: ProjectionClause): ReadonlySet<string>
    {
        const out = new Set<string>();
        for (const item of projection.Items) item.Expr.CollectVariables(out);
        for (const item of projection.OrderBy ?? []) item.Expr.CollectVariables(out);
        projection.Where?.Predicate.CollectVariables(out);
        return out;
    }

    private static CollectPatternVariables(path: PatternPath, into: Set<string>): void
    {
        if (path.PathVariable !== undefined) into.add(path.PathVariable);
        for (const node of path.Nodes) if (node.Variable !== undefined) into.add(node.Variable);
        for (const rel of path.Rels) if (rel.Variable !== undefined) into.add(rel.Variable);
    }

    private static Disjoint(used: ReadonlySet<string>, written: ReadonlySet<string>): boolean
    {
        for (const v of written) if (used.has(v)) return false;
        return true;
    }
}
