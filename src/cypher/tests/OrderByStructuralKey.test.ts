import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CypherSemanticError } from '../CypherError.js';
import { ArithmeticOp, BooleanOp, ComparisonOp } from '../CypherEnums.js';
import { NodeValue, ScalarValue } from '../CypherValue.js';
import {
    ArithmeticExpression, BooleanExpression, Comparison, FunctionCall, IndexAccess, InExpression, IsNullExpression,
    ListLiteral, Literal, MapLiteral, Parameter, PropertyAccess, UnaryMinus, ValueLiteral, VariableRef, type Expression,
} from '../Expression.js';
import { ListValue } from '../StructuredValues.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

class OrderByFixture
{
    public static Open(): Promise<EngineHarness>
    {
        const F = CypherFixture;
        return EngineHarness.Open(
            [F.Concept('Element', []), F.Concept('Service', [F.Text('name')], 'Element')],
            [F.Node('a', 'Service', { name: 'checkout' }), F.Node('b', 'Service', { name: 'ledger' }), F.Node('c', 'Service', { name: 'audit' })]);
    }

    public static async Col(h: EngineHarness, text: string, col: number): Promise<unknown[]>
    {
        return (await h.Execute(text)).Rows.map((r) => (r[col] as ScalarValue).Value);
    }

    public static AX(): Expression
    {
        return new PropertyAccess('a', 'x');
    }

    public static Lit(n: number): Expression
    {
        return new Literal(n);
    }
}

describe('Expression.StructuralKey', () =>
{
    test('structurally equal arithmetic keys match; different operand differs', () =>
    {
        const a1 = new ArithmeticExpression(OrderByFixture.AX(), ArithmeticOp.Add, OrderByFixture.Lit(1));
        const a2 = new ArithmeticExpression(OrderByFixture.AX(), ArithmeticOp.Add, OrderByFixture.Lit(1));
        const a3 = new ArithmeticExpression(OrderByFixture.AX(), ArithmeticOp.Add, OrderByFixture.Lit(2));
        const a4 = new ArithmeticExpression(OrderByFixture.AX(), ArithmeticOp.Sub, OrderByFixture.Lit(1));
        assert.equal(a1.StructuralKey(), a2.StructuralKey());
        assert.notEqual(a1.StructuralKey(), a3.StructuralKey());
        assert.notEqual(a1.StructuralKey(), a4.StructuralKey());
    });

    test('count(*) differs from count(a); distinct and name case behave', () =>
    {
        const star = new FunctionCall('count', [], false, true);
        const arg = new FunctionCall('count', [new VariableRef('a')], false, false);
        const upper = new FunctionCall('COUNT', [], false, true);
        const distinct = new FunctionCall('count', [new VariableRef('a')], true, false);
        assert.notEqual(star.StructuralKey(), arg.StructuralKey());
        assert.equal(star.StructuralKey(), upper.StructuralKey());
        assert.notEqual(arg.StructuralKey(), distinct.StructuralKey());
    });

    test('structurally equal lists match; order and content matter', () =>
    {
        const l1 = new ListLiteral([OrderByFixture.Lit(1), OrderByFixture.AX()]);
        const l2 = new ListLiteral([OrderByFixture.Lit(1), OrderByFixture.AX()]);
        const l3 = new ListLiteral([OrderByFixture.AX(), OrderByFixture.Lit(1)]);
        assert.equal(l1.StructuralKey(), l2.StructuralKey());
        assert.notEqual(l1.StructuralKey(), l3.StructuralKey());
    });

    test('map keys are order-insensitive', () =>
    {
        const m1 = new MapLiteral(new Map<string, Expression>([['p', OrderByFixture.Lit(1)], ['q', OrderByFixture.Lit(2)]]));
        const m2 = new MapLiteral(new Map<string, Expression>([['q', OrderByFixture.Lit(2)], ['p', OrderByFixture.Lit(1)]]));
        const m3 = new MapLiteral(new Map<string, Expression>([['p', OrderByFixture.Lit(2)], ['q', OrderByFixture.Lit(1)]]));
        assert.equal(m1.StructuralKey(), m2.StructuralKey());
        assert.notEqual(m1.StructuralKey(), m3.StructuralKey());
    });

    test('literal types and variable-vs-property are distinguished', () =>
    {
        assert.notEqual(new Literal(1).StructuralKey(), new Literal('1').StructuralKey());
        assert.notEqual(new Literal(null).StructuralKey(), new Literal('null').StructuralKey());
        assert.notEqual(new VariableRef('a').StructuralKey(), new PropertyAccess('a', 'name').StructuralKey());
        assert.notEqual(new VariableRef('a').StructuralKey(), new Parameter('a').StructuralKey());
        assert.notEqual(new ValueLiteral(new ScalarValue(1)).StructuralKey(), new ValueLiteral(new ScalarValue(2)).StructuralKey());
    });

    test('dotted names cannot forge a colliding property key', () =>
    {
        assert.notEqual(new PropertyAccess('a.b', 'c').StructuralKey(), new PropertyAccess('a', 'b.c').StructuralKey());
        assert.notEqual(
            new Comparison(new VariableRef('b,var:c'), ComparisonOp.Eq, OrderByFixture.Lit(1)).StructuralKey(),
            new Comparison(new VariableRef('b'), ComparisonOp.Eq, new VariableRef('c')).StructuralKey(),
        );
    });

    test('non-finite number literals do not collide with null or each other', () =>
    {
        const keys = [new Literal(null), new Literal(NaN), new Literal(Infinity), new Literal(-Infinity)].map((l) => l.StructuralKey());
        assert.equal(new Set(keys).size, 4);
    });

    test('remaining subtypes produce recursive, discriminating keys', () =>
    {
        const x = OrderByFixture.AX();
        assert.notEqual(new IsNullExpression(x, true).StructuralKey(), new IsNullExpression(x, false).StructuralKey());
        assert.notEqual(new UnaryMinus(x).StructuralKey(), x.StructuralKey());
        assert.notEqual(
            new IndexAccess(new ListLiteral([x]), OrderByFixture.Lit(0)).StructuralKey(),
            new IndexAccess(new ListLiteral([x]), OrderByFixture.Lit(1)).StructuralKey(),
        );
        assert.notEqual(new InExpression(x, [OrderByFixture.Lit(1)]).StructuralKey(), new InExpression(x, [OrderByFixture.Lit(2)]).StructuralKey());
        assert.notEqual(
            new Comparison(x, ComparisonOp.Lt, OrderByFixture.Lit(1)).StructuralKey(),
            new Comparison(x, ComparisonOp.Gt, OrderByFixture.Lit(1)).StructuralKey(),
        );
        assert.notEqual(new BooleanExpression(BooleanOp.And, [x, x]).StructuralKey(), new BooleanExpression(BooleanOp.Or, [x, x]).StructuralKey());
    });
});

describe('ORDER BY matches any projected expression', () =>
{
    let e: EngineHarness;
    before(async () => { e = await OrderByFixture.Open(); });
    after(() => e.dispose());

    test('arithmetic expression identical to a projected one is rewritten, not rejected', async () =>
    {
        const asc = await OrderByFixture.Col(e, "MATCH (a:Service) RETURN a.name AS nm, a.name + '!' AS tag ORDER BY a.name + '!'", 1);
        assert.deepEqual(asc, ['audit!', 'checkout!', 'ledger!']);
        const desc = await OrderByFixture.Col(e, "MATCH (a:Service) RETURN a.name + '!' ORDER BY a.name + '!' DESC", 0);
        assert.deepEqual(desc, ['ledger!', 'checkout!', 'audit!']);
    });

    test('constant arithmetic projected and ordered by the same expression', async () =>
    {
        assert.deepEqual(await OrderByFixture.Col(e, 'MATCH (a:Service) RETURN a.name AS nm, (1 + 1) AS two ORDER BY (1 + 1)', 1), [2n, 2n, 2n]);
    });

    test('list and index expressions identical to projected ones are rewritten', async () =>
    {
        assert.deepEqual(await OrderByFixture.Col(e, 'MATCH (a:Service) RETURN [a.name, 1][0] AS first ORDER BY [a.name, 1][0]', 0), ['audit', 'checkout', 'ledger']);
        const r = await e.Execute('MATCH (a:Service) RETURN [a.name, 1] AS l ORDER BY [a.name, 1]');
        assert.deepEqual(r.Rows.map((row) => ((row[0] as ListValue).Items[0] as ScalarValue).Value), ['audit', 'checkout', 'ledger']);
    });

    test('must not regress: a.name projected and ordered', async () =>
    {
        assert.deepEqual(await OrderByFixture.Col(e, 'MATCH (a:Service) RETURN a.name ORDER BY a.name', 0), ['audit', 'checkout', 'ledger']);
        assert.deepEqual(await OrderByFixture.Col(e, 'MATCH (a:Service) RETURN a.name AS n ORDER BY a.name DESC', 0), ['ledger', 'checkout', 'audit']);
    });

    test('must not regress: RETURN a AS a ORDER BY a.name still sorts via the projected variable', async () =>
    {
        const result = await e.Execute('MATCH (a:Service) RETURN a AS a ORDER BY a.name');
        assert.deepEqual(result.Rows.map((row) => (row[0] as NodeValue).Field('name')), ['audit', 'checkout', 'ledger']);
    });

    test('must not regress: unknown ORDER BY column still throws', async () =>
    {
        await assert.rejects(e.Execute('MATCH (a:Service) RETURN a.name AS n ORDER BY nope'), CypherSemanticError);
    });

    test('must not regress: count(*) matches itself, count(a) does not match count(*)', async () =>
    {
        assert.deepEqual(await OrderByFixture.Col(e, 'MATCH (a:Service) RETURN count(*) AS c ORDER BY count(*)', 0), [3n]);
        await assert.rejects(e.Execute('MATCH (a:Service) RETURN a.name AS k, count(*) AS c ORDER BY count(a)'), CypherSemanticError);
    });
});
