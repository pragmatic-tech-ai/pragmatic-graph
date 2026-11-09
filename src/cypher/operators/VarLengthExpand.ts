import type { Binding } from '../Binding.js';
import { RelDirection } from '../CypherEnums.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import { ListValue, PathValue, type RelValue } from '../StructuredValues.js';
import type { IOperator } from './IOperator.js';
import { RelOrientation } from './RelOrientation.js';

/**
 * Variable-length expand. Walks repeated single-hop source.Expand calls, never repeating a relationship step
 * (fromId, relationship, toId) within one path (Cypher relationship-isomorphism), which also guarantees
 * termination on cyclic graphs. RelValue.Type is the relationship walked (TODL: relType, or "" when untyped).
 */
export class VarLengthExpand implements IOperator
{
    private static readonly StepSeparator = '\u0000';

    constructor(
        private readonly child: IOperator,
        private readonly source: ICypherSource,
        private readonly fromVar: string,
        private readonly toVar: string,
        private readonly relType: string | undefined,
        private readonly direction: RelDirection,
        private readonly min: number,
        private readonly max: number,
        private readonly toLabel: string | undefined,
        private readonly pathVar: string | undefined,
        private readonly relVar: string | undefined = undefined,
        private readonly cancel?: ICancellation,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        for await (const row of this.child.Rows())
        {
            probe.Tick();
            const from = row.Get(this.fromVar);
            if (!(from instanceof NodeValue)) continue;
            yield* this.Walk(probe, row, from, [from], [], new Set<string>());
        }
    }

    private async *Walk(probe: CancelProbe, row: Binding, current: NodeValue, nodes: NodeValue[], rels: RelValue[], used: Set<string>): AsyncIterable<Binding>
    {
        probe.Tick();
        const depth = rels.length;
        if (depth >= this.min && this.LabelOk(current))
        {
            let out = row.With(this.toVar, current);
            if (this.pathVar !== undefined)
            {
                out = out.With(this.pathVar, new PathValue([...nodes], [...rels]));
            }
            if (this.relVar !== undefined)
            {
                out = out.With(this.relVar, new ListValue([...rels]));
            }
            yield out;
        }
        if (depth >= this.max) return;

        for await (const step of this.source.Expand(current.Id, this.relType, this.direction))
        {
            const next = new NodeValue(step.Target);
            const key = this.StepKey(current.Id, step.Relationship, next.Id);
            if (used.has(key)) continue;
            used.add(key);
            nodes.push(next);
            rels.push(RelOrientation.Oriented(this.direction, step.Relationship, current.Id, next.Id));
            yield* this.Walk(probe, row, next, nodes, rels, used);
            rels.pop();
            nodes.pop();
            used.delete(key);
        }
    }

    // Undirected: canonicalize endpoints so A-B and B-A are the same physical edge within one path.
    // As with directed steps, parallel edges of one relationship between the same two nodes collapse to one step.
    private StepKey(currentId: string, relationship: string, nextId: string): string
    {
        const ends = this.direction === RelDirection.Undirected ? [currentId, nextId].sort() : [currentId, nextId];
        return [ends[0], relationship, ends[1]].join(VarLengthExpand.StepSeparator);
    }

    private LabelOk(node: NodeValue): boolean
    {
        return this.toLabel === undefined || this.source.IsA(node.Node, this.toLabel);
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
