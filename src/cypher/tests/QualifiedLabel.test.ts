import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CypherSemanticError } from '../CypherError.js';
import { NodeValue } from '../CypherValue.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

class QualifiedLabelFixture
{
    public static Open(): Promise<EngineHarness>
    {
        const F = CypherFixture;
        return EngineHarness.Open(
            [
                F.Concept('Element', []),
                F.Concept('shop.Customer', [F.Text('name')], 'Element'),
                F.Concept('crm.Customer', [F.Text('name')], 'Element'),
                F.Concept('a.b.C', [], 'Element'),
            ],
            [F.Node('s1', 'shop.Customer', { name: 'x' }), F.Node('c1', 'crm.Customer', { name: 'y' }), F.Node('abc', 'a.b.C')]);
    }

    public static async Concepts(h: EngineHarness, source: string): Promise<string[]>
    {
        return (await h.Execute(source)).Rows.map((r) => (r[0] as NodeValue).Concept);
    }
}

describe('qualified node labels', () =>
{
    let h: EngineHarness;
    before(async () => { h = await QualifiedLabelFixture.Open(); });
    after(() => h.dispose());

    test('a qualified label resolves to the exact namespaced concept', async () =>
    {
        assert.deepEqual(await QualifiedLabelFixture.Concepts(h, 'MATCH (c:shop.Customer) RETURN c'), ['shop.Customer']);
    });

    test('a bare label ambiguous across namespaces still throws CypherSemanticError', async () =>
    {
        await assert.rejects(
            h.Execute('MATCH (c:Customer) RETURN c'),
            (e: unknown) => e instanceof CypherSemanticError && /shop\.Customer, crm\.Customer|crm\.Customer, shop\.Customer/.test(e.message),
        );
    });

    test('a qualified label with no matching concept throws unknown label', async () =>
    {
        await assert.rejects(
            h.Execute('MATCH (c:shop.Nope) RETURN c'),
            (e: unknown) => e instanceof CypherSemanticError && /unknown label/.test(e.message) && /shop\.Nope/.test(e.message),
        );
    });

    test('property access a.name is unaffected', async () =>
    {
        assert.equal((await h.Execute("MATCH (c:shop.Customer) WHERE c.name = 'x' RETURN c.name")).Rows.length, 1);
    });

    test('a three-segment label joins fully', async () =>
    {
        assert.deepEqual(await QualifiedLabelFixture.Concepts(h, 'MATCH (c:a.b.C) RETURN c'), ['a.b.C']);
    });
});

describe('backtick-quoted qualified labels', () =>
{
    let h: EngineHarness;
    before(async () => { h = await QualifiedLabelFixture.Open(); });
    after(() => h.dispose());

    test('a backtick-quoted FQN resolves to the exact namespaced concept', async () =>
    {
        assert.deepEqual(await QualifiedLabelFixture.Concepts(h, 'MATCH (c:`crm.Customer`) RETURN c'), ['crm.Customer']);
    });

    test('a backtick-quoted multi-segment FQN resolves like its dotted spelling', async () =>
    {
        assert.deepEqual(await QualifiedLabelFixture.Concepts(h, 'MATCH (c:`a.b.C`) RETURN c'), ['a.b.C']);
    });
});
