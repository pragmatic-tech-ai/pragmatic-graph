import { AccessScope, type IDefinitionDescription, type IIndexDescription, type ISeedNode } from '../../index.js';
import { CypherEngine, type ICypherRunOptions } from '../CypherEngine.js';
import type { CypherQuery } from '../CypherQuery.js';
import type { CypherResult } from '../CypherResult.js';
import { CypherValue, NodeValue, NullValue, ScalarValue, type ParameterValue } from '../CypherValue.js';
import type { ExecutionLimits } from '../ExecutionLimits.js';
import type { PlannerOptions } from '../LogicalPlanner.js';
import { ListValue } from '../StructuredValues.js';
import { CypherFixture } from './CypherFixture.js';

/**
 * A CypherEngine over a CypherFixture engine, for the ported TODL engine tests: Execute keeps TODL's
 * (source, parameters, limits) argument order and runs under AccessScope.System unless a scope is given.
 */
export class EngineHarness
{
    private static readonly UnexpectedCell = 'unexpected cell type in Plain()';

    private constructor(public readonly Fixture: CypherFixture, public readonly Cypher: CypherEngine)
    {
    }

    public static async Open(definitions: readonly IDefinitionDescription[], seed: readonly ISeedNode[], options?: PlannerOptions, indexes: readonly IIndexDescription[] = []): Promise<EngineHarness>
    {
        const fx = await CypherFixture.Open(definitions, seed, indexes);
        return new EngineHarness(fx, new CypherEngine(fx.Engine, options));
    }

    public Execute(source: string | CypherQuery, parameters?: ReadonlyMap<string, ParameterValue>, limits?: ExecutionLimits, scope: AccessScope = AccessScope.System): Promise<CypherResult>
    {
        const options: { Parameters?: ReadonlyMap<string, ParameterValue>; Limits?: ExecutionLimits } = {};
        if (parameters !== undefined) options.Parameters = parameters;
        if (limits !== undefined) options.Limits = limits;
        return this.Cypher.Execute(scope, source, options as ICypherRunOptions);
    }

    /** Scalars → value, null → null, lists → arrays, nodes → id; anything else is unexpected. */
    public static Plain(v: CypherValue): unknown
    {
        if (v instanceof ScalarValue) return v.Value;
        if (v instanceof NullValue) return null;
        if (v instanceof ListValue) return v.Items.map((i) => EngineHarness.Plain(i));
        if (v instanceof NodeValue) return v.Id;
        throw new Error(`${EngineHarness.UnexpectedCell}: ${v.constructor.name}`);
    }

    public static Col(result: CypherResult, index: number = 0): unknown[]
    {
        return result.Rows.map((r) => EngineHarness.Plain(r[index]!));
    }

    public static Pairs(result: CypherResult): unknown[][]
    {
        return result.Rows.map((r) => r.map((v) => EngineHarness.Plain(v)));
    }

    public dispose(): Promise<void>
    {
        return this.Fixture.dispose();
    }
}
