import type { Binding } from '../Binding.js';
import { RelDirection } from '../CypherEnums.js';
import { CypherSemanticError } from '../CypherError.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue, NullValue } from '../CypherValue.js';
import type { NodePattern, PatternPath } from '../PatternPath.js';
import { RelOrientation } from '../operators/RelOrientation.js';
import type { ICypherSink } from './CypherSink.js';
import { WriteSupport } from './WriteSupport.js';

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
        const ids: string[] = [];
        for (const node of path.Nodes)
        {
            const existing = node.Variable === undefined ? undefined : current.Get(node.Variable);
            if (existing instanceof NullValue) throw new CypherSemanticError(`${WriteSupport.NullEndpoint}: "${node.Variable}"`);
            const existingId = WriteSupport.NodeId(existing);
            if (existingId !== undefined)
            {
                ids.push(existingId);
                continue;
            }
            const created = this.CreateNode(node);
            ids.push(created.Id);
            if (node.Variable !== undefined) current = current.With(node.Variable, created);
        }
        for (let i = 0; i < path.Rels.length; i++)
        {
            const rel = path.Rels[i]!;
            const left = ids[i]!;
            const right = ids[i + 1]!;
            if (rel.Direction === RelDirection.Outgoing) await this.sink.CreateRelationship(left, rel.RelType!, right);
            else await this.sink.CreateRelationship(right, rel.RelType!, left);
            if (rel.Variable !== undefined) current = current.With(rel.Variable, RelOrientation.Oriented(rel.Direction, rel.RelType!, left, right));
        }
        return current;
    }

    private CreateNode(node: NodePattern): NodeValue
    {
        if (node.Label === undefined) throw new CypherSemanticError(WriteSupport.LabelRequired);
        return new NodeValue(this.sink.CreateNode(this.source.ResolveLabel(node.Label), node.Properties));
    }
}
