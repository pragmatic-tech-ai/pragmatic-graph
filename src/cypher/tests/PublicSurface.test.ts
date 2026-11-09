import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Root from '../../index.js';
import { Cypher } from '../../index.js';

/** Every runtime name the `Cypher` namespace exports; the type-only names are checked by the type assertions below. */
class Surface
{
    public static readonly Values = [
        'BooleanOp', 'ComparisonOp', 'CypherCellCodec', 'CypherEngine', 'CypherError', 'CypherErrorCode', 'CypherNode', 'CypherParser',
        'CypherQuery', 'CypherResult', 'CypherSemanticError', 'CypherSyntaxError', 'CypherTimeout', 'CypherUnparser', 'CypherValue',
        'CypherWriteError', 'CypherWriteErrorCode', 'CypherWriteStats', 'Deadline', 'Expr', 'ExprBuilder', 'Fn', 'GuidPlacement', 'Hops',
        'ListValue', 'MapValue', 'NodeBuilder', 'NodeValue', 'NullValue', 'PathValue', 'Pattern', 'ReferencedLabels', 'RelDirection',
        'RelValue', 'Return', 'ScalarValue', 'Sort',
    ];

    /** Internals that must not leak, and the TODL-only names retired with GraphQueryAdapter. */
    public static readonly Hidden = [
        'LogicalPlanner', 'ReaderSource', 'OverlaySource', 'PendingOverlay', 'TransactionSink', 'WriteQueryRunner', 'ExplainSink',
        'PlanSource', 'CatalogSource', 'ParameterBinder', 'EagerBarrier', 'LabelScan', 'Expand', 'IndexSeek', 'Project',
        'NodeRefValue', 'GraphQueryAdapter', 'CypherPushDown', 'CypherQueryFilterProvider', 'GraphQuerySchema', 'TemporalText',
        'ScalarSemantics', 'CypherLexer', 'FunctionRegistry', 'AggregatorFactory', 'Binding',
    ];
}

// Compile-time: the type-only exports exist under the namespace.
type TypeExports = [
    Cypher.ICypherRunOptions, Cypher.PlannerOptions, Cypher.CypherResultDto, Cypher.ExprArg, Cypher.ParameterValue, Cypher.CypherValueDto,
    Cypher.NodeCellDto, Cypher.RelDto, Cypher.ICypherSource, Cypher.ExecutionLimits, Cypher.ICancellation, Cypher.CypherWriteStatsDto,
    Cypher.INodePlacement, Cypher.IExpandRow,
];

describe('cypher public surface', () =>
{
    test('the Cypher namespace exports exactly the public runtime names', () =>
    {
        assert.deepEqual(Object.keys(Cypher).sort(), [...Surface.Values].sort());
        for (const name of Surface.Hidden)
        {
            assert.equal(name in Cypher, false, name);
            assert.equal(name in Root, false, name);
        }
        const types: TypeExports | undefined = undefined;
        assert.equal(types, undefined);
    });

    test('Fn, Sort, Hops and ExprArg build an aggregate + variable-length query through the package root', () =>
    {
        const { CypherQuery, Pattern, Expr, Return, Fn, Sort, Hops, CypherParser } = Cypher;
        const built = CypherQuery
            .Match(Pattern.Node('a').Label('Service').Out('calls', Pattern.Node('b').Label('Service'), Hops.Range(1, 3)))
            .Return(Return.Prop('b', 'name', 'n'), Fn.Count().As('c'), Fn.Collect(Expr.Prop('b', 'name')).As('names'))
            .OrderBy(Sort.By(Expr.Var('c'), true))
            .ToModel();
        const parsed = new CypherParser(
            'MATCH (a:Service)-[:calls*1..3]->(b:Service) RETURN b.name AS n, count(*) AS c, collect(b.name) AS names ORDER BY c DESC').Parse();
        assert.deepStrictEqual(built, parsed);
        const arg: Cypher.ExprArg = Expr.Var('c');
        assert.ok(Sort.By(arg) !== undefined);
    });
});
