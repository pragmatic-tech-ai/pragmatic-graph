import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTimeValue, DateValue, DurationValue } from '../../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { Binding, EvalContext } from '../Binding.js';
import { ArithmeticOp, ComparisonOp } from '../CypherEnums.js';
import { CypherError, CypherErrorCode, CypherSemanticError, CypherSyntaxError, CypherWriteError, CypherWriteErrorCode } from '../CypherError.js';
import { CypherNode } from '../CypherNode.js';
import { CypherParser } from '../CypherParser.js';
import { CypherQuery, Expr, Pattern, Return } from '../CypherQuery.js';
import { CypherUnparser } from '../CypherUnparser.js';
import { CypherValue, NodeValue, NullValue, ScalarValue, type CypherScalar, type ParameterValue } from '../CypherValue.js';
import { ArithmeticExpression, Comparison, FunctionCall, InExpression, Literal, PropertyAccess, UnaryMinus, ValueLiteral } from '../Expression.js';
import { ParameterBinder } from '../ParameterBinder.js';
import { AggregatorFactory } from '../AggregatorFactory.js';
import { ListValue, MapValue } from '../StructuredValues.js';

class V
{
    public static Ctx(binding: Binding = new Binding()): EvalContext
    {
        return new EvalContext(binding, new Map());
    }

    public static Cmp(l: CypherScalar, op: ComparisonOp, r: CypherScalar): unknown
    {
        return (new Comparison(new Literal(l), op, new Literal(r)).Evaluate(V.Ctx()) as ScalarValue).Value;
    }

    public static Arith(l: CypherScalar, op: ArithmeticOp, r: CypherScalar): unknown
    {
        const v = new ArithmeticExpression(new Literal(l), op, new Literal(r)).Evaluate(V.Ctx());
        return v instanceof ScalarValue ? v.Value : null;
    }

    public static Eval(query: string): unknown
    {
        const v = new CypherParser(query).Parse().Parts[0]!.Projection!.Items[0]!.Expr.Evaluate(V.Ctx());
        return v instanceof ScalarValue ? v.Value : v;
    }

    public static Bind(value: ParameterValue): unknown
    {
        return (ParameterBinder.FromInput(value) as ScalarValue).Value;
    }

    public static Structural(query: string): string
    {
        return new CypherParser(query).Parse().Parts[0]!.Projection!.Items[0]!.Expr.StructuralKey();
    }

    public static IsOverflow(e: unknown): boolean
    {
        return e instanceof CypherError && e.Code === CypherErrorCode.IntegerOverflow;
    }
}

describe('cypher engine values: numbers', () =>
{
    test('int and float compare numerically', () =>
    {
        assert.equal(V.Cmp(2n, ComparisonOp.Eq, 2.0), true);
        assert.equal(V.Cmp(2n, ComparisonOp.Lt, 2.5), true);
        assert.equal(V.Cmp(2.5, ComparisonOp.Gt, 2n), true);
        assert.equal(V.Cmp(2n, ComparisonOp.Neq, 2.0), false);
        assert.equal(V.Eval('RETURN 2 = 2.0'), true);
        assert.equal(V.Eval('RETURN 2 < 2.5'), true);
        assert.equal((new InExpression(new Literal(2n), [new Literal(2.0)]).Evaluate(V.Ctx()) as ScalarValue).Value, true);
        // A JSON parameter 2 binds as an Int64 and matches a Float64 member 2.0.
        assert.equal(V.Cmp(V.Bind(2) as bigint, ComparisonOp.Eq, 2.0), true);
    });

    test('integer literal is bigint', () =>
    {
        assert.equal(V.Eval('RETURN 2'), 2n);
        assert.equal(V.Eval('RETURN 2.0'), 2);
        assert.equal(typeof V.Eval('RETURN 2.0'), 'number');
        assert.equal(V.Eval('RETURN 9223372036854775807'), 9223372036854775807n);
        const props = (new CypherParser('MATCH (n {a: 1, b: -2, c: 1.5}) RETURN n').Parse().Parts[0]!.Reading[0] as { Paths: { Nodes: { Properties: ReadonlyMap<string, unknown> }[] }[] }).Paths[0]!.Nodes[0]!.Properties;
        assert.deepEqual([...props.values()], [1n, -2n, 1.5]);
        assert.throws(() => new CypherParser('RETURN 9223372036854775808').Parse(), CypherSyntaxError);
        assert.equal((new CypherParser('MATCH (n {a: -9223372036854775808}) RETURN n').Parse().Parts.length), 1);
    });

    test('int overflow raises IntegerOverflow', () =>
    {
        assert.throws(() => V.Eval('RETURN 9223372036854775807 + 1'), (e: unknown) => V.IsOverflow(e));
        assert.throws(() => V.Arith(-(2n ** 63n), ArithmeticOp.Sub, 1n), (e: unknown) => V.IsOverflow(e));
        assert.throws(() => V.Arith(2n ** 62n, ArithmeticOp.Mul, 2n), (e: unknown) => V.IsOverflow(e));
        assert.throws(() => V.Arith(-(2n ** 63n), ArithmeticOp.Div, -1n), (e: unknown) => V.IsOverflow(e));
        assert.throws(() => new UnaryMinus(new Literal(-(2n ** 63n))).Evaluate(V.Ctx()), (e: unknown) => V.IsOverflow(e));
        assert.throws(() => V.Bind(2n ** 63n), (e: unknown) => V.IsOverflow(e));
        const sum = AggregatorFactory.Create('sum', false);
        sum.Accept(new ScalarValue(2n ** 62n));
        assert.throws(() => sum.Accept(new ScalarValue(2n ** 62n)), (e: unknown) => V.IsOverflow(e));
        // Float64 arithmetic never overflows.
        assert.equal(V.Arith(9223372036854775807n, ArithmeticOp.Add, 1.0), 9223372036854775808);
    });

    test('int with int stays int, any float makes a float', () =>
    {
        assert.equal(V.Arith(7n, ArithmeticOp.Div, 2n), 3n);
        assert.equal(V.Arith(-7n, ArithmeticOp.Div, 2n), -3n);
        assert.equal(V.Arith(-7n, ArithmeticOp.Mod, 2n), -1n);
        assert.equal(V.Arith(7n, ArithmeticOp.Div, 2.0), 3.5);
        assert.equal(V.Arith(1n, ArithmeticOp.Add, 0.5), 1.5);
        assert.equal(V.Arith(1n, ArithmeticOp.Div, 0n), null);
        assert.equal(V.Eval('RETURN 7 / 2'), 3n);
        assert.equal(V.Eval('RETURN 7 / 2.0'), 3.5);
        const sum = AggregatorFactory.Create('sum', false);
        sum.Accept(new ScalarValue(1n));
        sum.Accept(new ScalarValue(2.5));
        assert.equal((sum.Result() as ScalarValue).Value, 3.5);
        const avg = AggregatorFactory.Create('avg', false);
        avg.Accept(new ScalarValue(1n));
        avg.Accept(new ScalarValue(2n));
        assert.equal((avg.Result() as ScalarValue).Value, 1.5);
    });

    test('ordering and grouping across Int64 and Float64', () =>
    {
        assert.ok(CypherValue.Compare(new ScalarValue(1n), new ScalarValue(1.5)) < 0);
        assert.ok(CypherValue.Compare(new ScalarValue(2n), new ScalarValue(1.5)) > 0);
        assert.equal(CypherValue.Compare(new ScalarValue(2n), new ScalarValue(2.0)), 0);
        // openCypher equivalence: 2 and 2.0 group together (as 2 = 2.0); expression identity stays typed.
        assert.equal(new ScalarValue(2n).GroupKey(), new ScalarValue(2.0).GroupKey());
        assert.equal(new ScalarValue(-0).GroupKey(), new ScalarValue(0n).GroupKey());
        assert.notEqual(new ScalarValue(2n).GroupKey(), new ScalarValue(2.5).GroupKey());
        assert.notEqual(new ScalarValue(2n).GroupKey(), new ScalarValue('2').GroupKey());
        assert.equal(new ScalarValue(Number.NaN).GroupKey(), new ScalarValue(Number.NaN).GroupKey());
        assert.equal(new ScalarValue(2n ** 60n).GroupKey(), new ScalarValue(2 ** 60).GroupKey());
        const list = (v: CypherScalar) => new ListValue([new ScalarValue(v)]);
        const map = (v: CypherScalar) => new MapValue(new Map([['k', new ScalarValue(v)]]));
        assert.equal(list(2n).GroupKey(), list(2.0).GroupKey());
        assert.equal(map(2n).GroupKey(), map(2.0).GroupKey());
        assert.notEqual(list(2n).TypedKey(), list(2.0).TypedKey());
        assert.notEqual(map(2n).TypedKey(), map(2.0).TypedKey());
        assert.notEqual(new Literal(2n).StructuralKey(), new Literal(2.0).StructuralKey());
        assert.notEqual(new ValueLiteral(list(2n)).StructuralKey(), new ValueLiteral(list(2.0)).StructuralKey());
        assert.notEqual(V.Structural('RETURN 7 / 2'), V.Structural('RETURN 7 / 2.0'));
        assert.equal(new Literal(2n).DefaultName(), '2');
        assert.equal(new Literal(2.0).DefaultName(), '2.0');
    });

    test('integer-valued functions return Int64', () =>
    {
        const call = (name: string, ...args: CypherScalar[]) => (new FunctionCall(name, args.map((a) => new Literal(a)), false, false).Evaluate(V.Ctx()) as ScalarValue).Value;
        assert.equal(call('toInteger', '9007199254740993'), 9007199254740993n);
        assert.equal(call('toInteger', 2.7), 2n);
        assert.ok(new FunctionCall('toInteger', [new Literal('99999999999999999999')], false, false).Evaluate(V.Ctx()) instanceof NullValue);
        assert.equal(call('toFloat', 3n), 3);
        assert.equal(call('toString', 3n), '3');
        assert.equal(call('toString', 2.0), '2.0');
        assert.equal(call('toString', 2.5), '2.5');
        assert.equal(call('toString', 1e21), '1e+21');
        assert.equal(call('substring', 'hello', 1n, 3n), 'ell');
        const range = new FunctionCall('range', [new Literal(1n), new Literal(3n)], false, false).Evaluate(V.Ctx()) as ListValue;
        assert.deepEqual(range.Items.map((i) => (i as ScalarValue).Value), [1n, 2n, 3n]);
        const rangeOf = (...args: CypherScalar[]) => new FunctionCall('range', args.map((a) => new Literal(a)), false, false).Evaluate(V.Ctx());
        assert.ok(rangeOf(0, 1, 0.5) instanceof NullValue);
        // TODL's check order: a zero step (or non-numeric argument) is null before a non-finite bound throws.
        assert.ok(rangeOf(0, Number.POSITIVE_INFINITY, 0) instanceof NullValue);
        assert.ok(rangeOf('a', Number.POSITIVE_INFINITY) instanceof NullValue);
        assert.throws(() => rangeOf(0.5, Number.POSITIVE_INFINITY), CypherSemanticError);
        assert.ok(new FunctionCall('substring', [new Literal('hello'), new Literal(0.5)], false, false).Evaluate(V.Ctx()) instanceof NullValue);
        assert.equal((AggregatorFactory.Create('count', true).Result() as ScalarValue).Value, 0n);
    });

    test('Int64 minimum round-trips through the unparser', () =>
    {
        const min = -(2n ** 63n);
        assert.equal(V.Eval('RETURN -9223372036854775808'), min);
        const parsed = new CypherParser('RETURN -9223372036854775808 AS m, -5 AS n').Parse();
        const text = new CypherUnparser().Text(parsed);
        assert.equal(text, 'RETURN -9223372036854775808 AS m, -5 AS n');
        assert.deepStrictEqual(new CypherParser(text).Parse(), parsed);
        assert.ok(parsed.Parts[0]!.Projection!.Items[1]!.Expr instanceof UnaryMinus);
        const q = CypherQuery.Unwind(Expr.List(), 'x').Return(Return.Item(Expr.Lit(min), 'm'), Return.Item(Expr.Lit(1n).Sub(Expr.Lit(min)), 'd'));
        assert.equal(q.ToCypherText(), 'UNWIND [] AS x RETURN -9223372036854775808 AS m, 1 - -9223372036854775808 AS d');
        assert.deepStrictEqual(new CypherParser(q.ToCypherText()).Parse(), q.ToModel());
        assert.throws(() => V.Eval('RETURN - 9223372036854775809'), CypherSyntaxError);
    });

    test('unparser keeps Int64 and Float64 apart', () =>
    {
        const q = CypherQuery.Match(Pattern.Node('n').Prop('a', 2).Prop('b', 2.5)).Where(Expr.Prop('n', 'x').Eq(3)).Return(Return.Item(Expr.Lit(1.5).Add(Expr.Lit(4))));
        assert.equal(q.ToCypherText(), 'MATCH (n {a: 2, b: 2.5}) WHERE n.x = 3 RETURN 1.5 + 4');
        const text = 'RETURN 2.0 AS f, 0.5 AS g, -3 AS i';
        assert.equal(new CypherUnparser().Text(new CypherParser(text).Parse()), text);
        const big = CypherQuery.Unwind(Expr.List(), 'x').Return(Return.Item(Expr.Lit(1e21), 'b')).ToCypherText();
        assert.equal(big, 'UNWIND [] AS x RETURN 1000000000000000000000.0 AS b');
        assert.equal(V.Eval('RETURN 1000000000000000000000.0'), 1e21);
        // Expr.Float keeps an integral value a Float64.
        const flt = CypherQuery.Unwind(Expr.List(), 'x').Return(Return.Item(Expr.Float(2), 'f'), Return.Item(Expr.Lit(2), 'i'));
        assert.equal(flt.ToCypherText(), 'UNWIND [] AS x RETURN 2.0 AS f, 2 AS i');
        assert.deepStrictEqual(new CypherParser(flt.ToCypherText()).Parse(), flt.ToModel());
        assert.throws(() => Expr.Lit(2n ** 63n), (e: unknown) => V.IsOverflow(e));
        assert.throws(() => Pattern.Node('n').Prop('a', -(2n ** 63n) - 1n), (e: unknown) => V.IsOverflow(e));
    });
});

describe('cypher engine values: temporals', () =>
{
    test('date parameter binds', () =>
    {
        const date = V.Bind({ $date: '2026-11-09' });
        assert.ok(date instanceof DateValue);
        assert.equal(date.Days, Date.UTC(2026, 10, 9) / 86_400_000);
        const dt = V.Bind({ $datetime: '2026-11-09T10:00:00.123456+01:00', zone: 'Europe/Paris' });
        assert.ok(dt instanceof DateTimeValue);
        assert.equal(dt.Micros, BigInt(Date.UTC(2026, 10, 9, 9, 0, 0)) * 1000n + 123456n);
        assert.equal(dt.Zone, 'Europe/Paris');
        assert.equal((V.Bind({ $datetime: '2026-11-09T10:00Z' }) as DateTimeValue).Zone, 'UTC');
        const dur = V.Bind({ $duration: 'P1Y2M3W4DT5H6M7.5S' });
        assert.ok(dur instanceof DurationValue);
        assert.deepEqual([dur.Months, dur.Days, dur.Micros], [14, 25, 5n * 3_600_000_000n + 6n * 60_000_000n + 7_500_000n]);
        assert.deepEqual([(V.Bind({ $duration: '-P1D' }) as DurationValue).Days], [-1]);
        assert.equal((V.Bind({ $datetime: '2026-11-09T10:00:00-18:00' }) as DateTimeValue).Micros, BigInt(Date.UTC(2026, 10, 10, 4, 0, 0)) * 1000n);
        assert.equal(V.Bind(2.5), 2.5);
        assert.equal(V.Bind(2 ** 53), 2 ** 53);
        assert.equal(V.Bind(7), 7n);
        assert.ok(ParameterBinder.FromInput({ date: '2026-11-09' }) instanceof MapValue);
        for (const bad of [{ $date: '2026-02-30' }, { $date: 5 }, { $date: '2026-11-09', x: 1 }, { $datetime: '2026-11-09T10:00:00' },
            { $datetime: '2026-11-09T10:00:00Z', zone: 'Nowhere/Land' }, { $datetime: '2026-11-09T10:00:00Z', zone: null },
            { $datetime: '2026-11-09T10:00:00Z', zone: 5 }, { $datetime: '2026-11-09T10:00:00+19:00' }, { $datetime: '2026-11-09T10:00:00+01:60' },
            { $duration: 'P' }, { $duration: 'PT' }, { $duration: '1D' }])
        {
            assert.throws(() => ParameterBinder.FromInput(bad), CypherSemanticError, JSON.stringify(bad));
        }
    });

    test('temporal comparison follows the engine predicate rules', () =>
    {
        const d1 = new DateValue(1);
        const d2 = new DateValue(2);
        assert.equal(V.Cmp(d1, ComparisonOp.Lt, d2), true);
        assert.equal(V.Cmp(d1, ComparisonOp.Eq, new DateTimeValue(86_400_000_000n, 'UTC')), false);
        assert.equal(V.Cmp(new DateTimeValue(5n, 'UTC'), ComparisonOp.Eq, new DateTimeValue(5n, 'Europe/Paris')), true);
        assert.equal(V.Cmp(new DateTimeValue(5n, 'UTC'), ComparisonOp.Lt, new DateTimeValue(6n, 'UTC')), true);
        const p1 = new DurationValue(1, 0, 0n);
        assert.equal(V.Cmp(p1, ComparisonOp.Eq, new DurationValue(1, 0, 0n)), true);
        assert.equal(V.Cmp(p1, ComparisonOp.Neq, new DurationValue(0, 30, 0n)), true);
        assert.equal(V.Cmp(p1, ComparisonOp.Lt, new DurationValue(2, 0, 0n)), false);
        assert.equal(V.Cmp(p1, ComparisonOp.Eq, 1n), false);
        assert.ok(CypherValue.Compare(new ScalarValue(true), new ScalarValue(d1)) < 0);
        assert.ok(CypherValue.Compare(new ScalarValue(d1), new ScalarValue(new DateTimeValue(0n, 'UTC'))) < 0);
        assert.ok(CypherValue.Compare(new ScalarValue(p1), new ScalarValue(new DurationValue(1, 1, 0n))) < 0);
        assert.notEqual(new ScalarValue(d1).GroupKey(), new ScalarValue(1n).GroupKey());
    });

    test('toString renders temporals as ISO-8601', () =>
    {
        const call = (v: CypherScalar) => (new FunctionCall('toString', [new Literal(v)], false, false).Evaluate(V.Ctx()) as ScalarValue).Value;
        assert.equal(call(V.Bind({ $date: '2026-11-09' }) as DateValue), '2026-11-09');
        assert.equal(call(V.Bind({ $datetime: '2026-11-09T10:00:00.5+01:00', zone: 'Europe/Paris' }) as DateTimeValue), '2026-11-09T09:00:00.5Z[Europe/Paris]');
        assert.equal(call(V.Bind({ $datetime: '1969-12-31T23:59:59.25Z' }) as DateTimeValue), '1969-12-31T23:59:59.25Z[UTC]');
        assert.equal(call(V.Bind({ $duration: 'P1Y2M3DT4H5M6.5S' }) as DurationValue), 'P1Y2M3DT4H5M6.5S');
        assert.equal(call(new DurationValue(0, 0, 0n)), 'PT0S');
        assert.equal(call(new DurationValue(0, 0, -1_500_000n)), 'PT-1.5S');
        assert.throws(() => CypherQuery.Match(Pattern.Node('n').Prop('d', new DateValue(1))).Return(Return.Node('n')).ToCypherText(), CypherSemanticError);
    });
});

describe('cypher engine values: nodes and errors', () =>
{
    test('NodeValue wraps a CypherNode and reads its properties', () =>
    {
        const node = new CypherNode('n1', 'shop.Customer', 'o1', new Map<string, CypherScalar | null>([['name', 'Ada'], ['tier', null], ['age', 36n]]));
        const value = new NodeValue(node);
        assert.equal(value.Id, 'n1');
        assert.equal(value.Concept, 'shop.Customer');
        assert.equal(value.Owner, 'o1');
        assert.equal(value.Node, node);
        const ctx = V.Ctx(new Binding().With('n', value));
        assert.equal((new PropertyAccess('n', 'name').Evaluate(ctx) as ScalarValue).Value, 'Ada');
        assert.equal((new PropertyAccess('n', 'age').Evaluate(ctx) as ScalarValue).Value, 36n);
        assert.ok(new PropertyAccess('n', 'tier').Evaluate(ctx) instanceof NullValue);
        assert.ok(new PropertyAccess('n', 'missing').Evaluate(ctx) instanceof NullValue);
        assert.equal(value.GroupKey(), new NodeValue(new CypherNode('n1', 'x', 'y', new Map())).GroupKey());
    });

    test('CypherNode links fill exactly once', () =>
    {
        const viewProps = new Map<string, CypherScalar | null>([['a', 1n]]);
        const node = CypherNode.FromView({ PublicId: 'n1', Concept: 'C', Owner: 'o', Properties: viewProps });
        viewProps.set('a', 2n);
        assert.equal(node.Properties.get('a'), 1n);
        assert.equal(node.Links, undefined);
        node.FillLinks([{ Relationship: 'r', PublicId: 'n2' }]);
        assert.deepEqual(node.Links, [{ Relationship: 'r', PublicId: 'n2' }]);
        assert.throws(() => node.FillLinks([]), CypherError);
    });

    test('error codes and write-error cause', () =>
    {
        assert.equal(new CypherSemanticError('x').Code, CypherErrorCode.Semantic);
        assert.equal(new CypherSyntaxError('x', 1, 1).Code, CypherErrorCode.Syntax);
        const cause = new Error('engine');
        const e = new CypherWriteError('w', CypherWriteErrorCode.Conflict, cause);
        assert.equal(e.Code, CypherErrorCode.Write);
        assert.equal(e.WriteCode, CypherWriteErrorCode.Conflict);
        assert.equal(new CypherWriteError('w').WriteCode, CypherWriteErrorCode.Invalid);
        assert.ok(e instanceof GraphError);
        assert.equal(e.GraphCode, GraphErrorCode.QueryFailed);
        assert.equal(new CypherSemanticError('x').GraphCode, GraphErrorCode.QueryFailed);
        assert.equal(e.cause, cause);
        assert.equal(e.name, 'CypherWriteError');
        assert.ok(new ListValue([]) instanceof CypherValue);
    });
});
