import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CypherCellCodec } from '../CypherCellCodec.js';
import { CypherEngine } from '../CypherEngine.js';
import { BooleanOp, ComparisonOp } from '../CypherEnums.js';
import { CypherSemanticError } from '../CypherError.js';
import { CypherParser } from '../CypherParser.js';
import { CypherQuery, Expr, Fn, Hops, Pattern, Return, Sort, type NodeBuilder } from '../CypherQuery.js';
import { MatchClause } from '../CypherQueryModel.js';
import { CypherUnparser } from '../CypherUnparser.js';
import type { ParameterValue } from '../CypherValue.js';
import { BooleanExpression, Comparison, InExpression, IsNullExpression, Literal, PropertyAccess, VariableRef } from '../Expression.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

class RoundTripFixture
{
    public static Open(): Promise<EngineHarness>
    {
        const F = CypherFixture;
        const svc = (id: string, name: string, kind: string, age: number, calls: string[]) => F.Node(id, 'Service', { name, kind, age }, calls.map((to) => ['calls', to] as [string, string]));
        return EngineHarness.Open(
            [
                F.Concept('Element', []),
                F.Concept('Service', [F.Text('name'), F.Text('kind'), F.Float('age'), F.Rel('calls', ['Service'])], 'Element'),
                F.Concept('shop.Customer', [F.Text('name')], 'Element'),
            ],
            [
                svc('s1', 'checkout', 'api', 3, ['s2']), svc('s2', 'ledger', 'core', -2, ['s3']), svc('s3', 'billing', 'core', 7, ['s1', 's4']),
                svc('s4', 'audit', 'api', 10, []), F.Node('c1', 'shop.Customer', { name: 'acme' }),
            ]);
    }

    // Asserts execute-DTO parity between the fluent query and its text form, and that the text re-parses.
    public static async Check(h: EngineHarness, q: CypherQuery, params: ReadonlyMap<string, ParameterValue> = new Map()): Promise<string>
    {
        const text = q.ToCypherText();
        const viaFluent = CypherEngine.ToDto(await h.Execute(q, params));
        const viaText = CypherEngine.ToDto(await h.Execute(text, params));
        assert.deepEqual(viaText, viaFluent, text);
        assert.doesNotThrow(() => new CypherParser(text).Parse(), text);
        return text;
    }

    public static Svc(variable: string): NodeBuilder
    {
        return Pattern.Node(variable).Label('Service');
    }

    public static async FirstCell(h: EngineHarness, q: CypherQuery | string): Promise<unknown>
    {
        return CypherCellCodec.Encode((await h.Execute(q)).Rows[0]![0]!);
    }
}

describe('CypherQuery.ToCypherText round trip', () =>
{
    const S = (v: string): NodeBuilder => RoundTripFixture.Svc(v);
    let h: EngineHarness;
    before(async () => { h = await RoundTripFixture.Open(); });
    after(() => h.dispose());

    test('fixed-length MATCH + property predicate + RETURN alias', async () =>
    {
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a').Prop('kind', 'api')).Where(Expr.Prop('a', 'name').Eq('checkout')).Return(Return.Prop('a', 'name', 'n')));
    });

    test('qualified label emits :ns.Concept', async () =>
    {
        const text = await RoundTripFixture.Check(h, CypherQuery.Match(Pattern.Node('c').Label('shop.Customer')).Return(Return.Node('c')));
        assert.match(text, /:shop\.Customer/);
    });

    test('OPTIONAL MATCH', async () =>
    {
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a')).OptionalMatch(Pattern.Node('a').Out('calls', S('b').Prop('kind', 'api'))).Return(Return.Prop('a', 'name'), Return.Prop('b', 'name')));
    });

    test('relationship type + direction + rel variable', async () =>
    {
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a').Out('calls', S('b'), undefined, 'r')).Return(Return.Prop('a', 'name'), Return.Node('r'), Return.Prop('b', 'name')));
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a').In('calls', S('b'))).Return(Return.Prop('a', 'name'), Return.Prop('b', 'name')));
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a').Undirected('calls', S('b'))).Return(Return.Prop('a', 'name'), Return.Prop('b', 'name')));
    });

    test('variable-length hops and path variable', async () =>
    {
        for (const hops of [Hops.Range(1, 3), Hops.Any(), Hops.AtLeast(2), Hops.Exactly(2)])
        {
            await RoundTripFixture.Check(h, CypherQuery.Match(S('a').Out('calls', S('b'), hops).AsPath('p')).Return(Return.Node('p'), Return.Prop('b', 'name')));
        }
    });

    test('WHERE boolean, comparison, IN, IS NULL', async () =>
    {
        const a = Expr.Prop('a', 'kind').Eq('api');
        const b = Expr.Prop('a', 'age').Gt(2);
        const c = new Comparison(new PropertyAccess('a', 'name'), ComparisonOp.Neq, new Literal('audit'));
        const mixed = new BooleanExpression(BooleanOp.Or, [
            new BooleanExpression(BooleanOp.And, [a, new BooleanExpression(BooleanOp.Not, [b])]),
            new BooleanExpression(BooleanOp.And, [c, new BooleanExpression(BooleanOp.Or, [a, b])]),
        ]);
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a')).Where(mixed).Return(Return.Prop('a', 'name')));
        const inn = new InExpression(new PropertyAccess('a', 'age'), [new Literal(3), new Literal(-2), new Literal(10)]);
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a')).Where(inn).Return(Return.Prop('a', 'name')));
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a')).Where(new IsNullExpression(new PropertyAccess('a', 'zzz'), true)).Return(Return.Prop('a', 'name')));
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a')).Where(new IsNullExpression(new PropertyAccess('a', 'zzz'), false)).Return(Return.Prop('a', 'name')));
    });

    test('exponent-form and tiny/huge numbers expand to plain decimals', async () =>
    {
        for (const n of [1e-7, 0.0000001, 1.5e-9, -2.5e-8, 1e21, 1.5e22, -3e25])
        {
            const q = CypherQuery.Unwind(Expr.List(Expr.Lit(1)), 'x').Return(Return.Item(Expr.Lit(n), 'n'));
            await RoundTripFixture.Check(h, q);
            assert.equal(String(await RoundTripFixture.FirstCell(h, q.ToCypherText())), String(await RoundTripFixture.FirstCell(h, q)));
            await RoundTripFixture.Check(h, CypherQuery.Match(S('a').Prop('age', n)).Return(Return.Node('a')));
            await RoundTripFixture.Check(h, CypherQuery.Match(S('a')).Where(Expr.Prop('a', 'age').Eq(n)).Return(Return.Node('a')));
        }
    });

    test('negative literal as an index target is parenthesized', async () =>
    {
        const q = CypherQuery.Unwind(Expr.List(Expr.Lit(1)), 'x').Return(Return.Item(Expr.Lit(-2).At(Expr.Lit(0)), 'i'), Return.Item(Expr.Lit(-2).Add(Expr.Lit(1)), 'j'));
        assert.match(await RoundTripFixture.Check(h, q), /\(-2\)\[0\]/);
    });

    test('negative property-map literal', async () =>
    {
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a').Prop('age', -2)).Return(Return.Prop('a', 'name')));
    });

    test('arithmetic with precedence and list index', async () =>
    {
        const age = Expr.Prop('a', 'age');
        const sum = age.Add(Expr.Lit(1)).Mul(Expr.Lit(2));
        const diff = Expr.Lit(10).Sub(age.Sub(Expr.Lit(1)));
        const dm = age.Div(Expr.Lit(2)).Add(age.Mod(Expr.Lit(3)));
        const idx = Expr.List(Expr.Lit(5), Expr.Lit(6), age).At(Expr.Lit(2));
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a')).Return(Return.Item(sum, 's'), Return.Item(diff, 'd'), Return.Item(dm, 'dm'), Return.Item(idx, 'i')).OrderBy(Sort.By(Expr.Var('s'))));
    });

    test('list literal, map literal, map/list parameter values', async () =>
    {
        const q = CypherQuery.Unwind(Expr.Param('xs'), 'x').Return(
            Return.Item(Expr.Map({ k: Expr.Var('x'), l: Expr.List(Expr.Lit(1), Expr.Lit('two')) }), 'm'),
            Return.Item(Expr.Param('cfg').At(Expr.Lit('a')), 'a'),
        );
        await RoundTripFixture.Check(h, q, new Map<string, ParameterValue>([['xs', [1, 2, 3]], ['cfg', { a: 9 }]]));
    });

    test('parameter in predicate', async () =>
    {
        const q = CypherQuery.Match(S('a')).Where(new Comparison(new PropertyAccess('a', 'kind'), ComparisonOp.Eq, Expr.Param('k').Inner)).Return(Return.Prop('a', 'name'));
        assert.match(await RoundTripFixture.Check(h, q, new Map<string, ParameterValue>([['k', 'core']])), /\$k/);
    });

    test('WITH, WITH-WHERE, RETURN', async () =>
    {
        const q = CypherQuery.Match(S('a').Out('calls', S('b')))
            .With(Return.Node('b'), Fn.Count().As('c')).Where(new Comparison(new VariableRef('c'), ComparisonOp.Gte, new Literal(1)))
            .OrderBy(Expr.Var('c').Desc()).Limit(5)
            .Return(Return.Prop('b', 'name', 'n'), Return.Node('c'));
        await RoundTripFixture.Check(h, q);
    });

    test('DISTINCT, ORDER BY alias and expression, SKIP, LIMIT', async () =>
    {
        const q = CypherQuery.Match(S('a')).Return(Return.Prop('a', 'kind', 'k'), Return.Prop('a', 'name', 'n')).Distinct()
            .OrderBy(Sort.By(Expr.Var('k')), Sort.By(Expr.Var('n'), true)).Skip(1).Limit(3);
        await RoundTripFixture.Check(h, q);
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a')).Return(Return.Prop('a', 'name')).OrderBy(Expr.Prop('a', 'name').Asc()));
    });

    test('aggregates with grouping, coalesce, UNWIND', async () =>
    {
        const age = Expr.Prop('a', 'age');
        const q = CypherQuery.Match(S('a')).Return(
            Return.Prop('a', 'kind', 'k'), Fn.Count().As('c'), Fn.CountOf(age).As('co'), Fn.CountDistinct(Expr.Prop('a', 'kind')).As('cd'),
            Fn.Collect(Expr.Prop('a', 'name')).As('names'), Fn.Sum(age).As('s'), Fn.Avg(age).As('av'), Fn.Min(age).As('mn'), Fn.Max(age).As('mx'),
            Fn.Coalesce(Expr.Prop('a', 'zzz'), Expr.Lit('dflt')).As('co2'),
        ).OrderBy(Sort.By(Expr.Var('k')));
        await RoundTripFixture.Check(h, q);
        await RoundTripFixture.Check(h, CypherQuery.Unwind(Expr.List(Expr.Lit(1), Expr.Lit(2)), 'x').Return(Return.Node('x')));
    });

    test('string escaping round-trips quote, backslash, and newline', async () =>
    {
        const tricky = "it's a\\b\nc ''";
        const q = CypherQuery.Unwind(Expr.List(Expr.Lit(1)), 'x').Return(Return.Item(Expr.Lit(tricky), 's'));
        await RoundTripFixture.Check(h, q);
        assert.deepEqual(await RoundTripFixture.FirstCell(h, q.ToCypherText()), await RoundTripFixture.FirstCell(h, q));
        await RoundTripFixture.Check(h, CypherQuery.Match(S('a').Prop('name', "it's")).Return(Return.Node('a')));
    });

    test('non-finite number literals throw by design', () =>
    {
        for (const n of [Number.NaN, Number.POSITIVE_INFINITY])
        {
            const q = CypherQuery.Unwind(Expr.List(Expr.Lit(1)), 'x').Return(Return.Item(Expr.Lit(n), 'n'));
            assert.throws(() => q.ToCypherText(), CypherSemanticError);
        }
    });
});

describe('unparser quotes names that are not plain identifiers', () =>
{
    const roundTrip = (source: string): string => new CypherUnparser().Text(new CypherParser(source).Parse());

    test('spaced, keyword and escaped names re-parse to the same model', () =>
    {
        const source = "MATCH (`order`:`acme.Service` {`full name`: 'x'})-[`r`:`calls`]->(b) "
            + 'WHERE `order`.`a``b` IS NOT NULL '
            + 'RETURN `order`.`full name` AS `the name`, b.match AS `RETURN`';
        const once = roundTrip(source);
        assert.equal(roundTrip(once), once, 'unparse is a fixed point');
        const model = new CypherParser(once).Parse();
        const node = (model.Parts[0]!.Reading[0] as MatchClause).Paths[0]!.Nodes[0]!;
        assert.equal(node.Variable, 'order');
        assert.equal(node.Label, 'acme.Service');
        assert.deepEqual([...node.Properties.keys()], ['full name']);
        assert.deepEqual(model.FinalColumns(), ['the name', 'RETURN']);
    });

    test('a quoted label with an empty segment is quoted whole and re-parses to the same label', () =>
    {
        const once = roundTrip('MATCH (a:`a..b`) RETURN a');
        const node = (new CypherParser(once).Parse().Parts[0]!.Reading[0] as MatchClause).Paths[0]!.Nodes[0]!;
        assert.equal(node.Label, 'a..b');
    });

    test('plain names stay unquoted', () =>
    {
        assert.equal(roundTrip('MATCH (a:shop.Customer)-[:calls]->(b) RETURN a.name AS n'), 'MATCH (a:shop.Customer)-[:calls]->(b) RETURN a.name AS n');
    });
});
