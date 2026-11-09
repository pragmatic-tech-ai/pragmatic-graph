import type { CypherScalar } from './CypherValue.js';
import { RelDirection } from './CypherEnums.js';
import { CypherSemanticError } from './CypherError.js';

export class NodePattern
{
    constructor(
        public readonly Variable: string | undefined,
        public readonly Label: string | undefined,
        public readonly Properties: ReadonlyMap<string, CypherScalar>,
    )
    {
    }
}

export class RelPattern
{
    private static readonly InvalidHopRange = 'variable-length minimum exceeds maximum';

    constructor(
        public readonly Variable: string | undefined,
        public readonly RelType: string | undefined,
        public readonly Direction: RelDirection,
        public readonly Properties: ReadonlyMap<string, CypherScalar>,
        // Both undefined = fixed single hop. Variable-length: MinHops defaults to 1 when only the star is given;
        // MaxHops undefined with MinHops defined = unbounded (planner applies MaxVarLength).
        public readonly MinHops: number | undefined = undefined,
        public readonly MaxHops: number | undefined = undefined,
    )
    {
        if (MinHops !== undefined && MaxHops !== undefined && MinHops > MaxHops)
        {
            throw new CypherSemanticError(`${RelPattern.InvalidHopRange}: *${MinHops}..${MaxHops}`);
        }
    }

    public get IsVariableLength(): boolean
    {
        return this.MinHops !== undefined || this.MaxHops !== undefined;
    }
}

export class PatternPath
{
    // Invariant: Nodes.length === Rels.length + 1.
    constructor(
        public readonly Nodes: readonly NodePattern[],
        public readonly Rels: readonly RelPattern[],
        public readonly PathVariable: string | undefined = undefined,
    )
    {
    }
}
