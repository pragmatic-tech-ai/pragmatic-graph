import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CypherSemanticError, CypherWriteError } from '../CypherError.js';
import { NodeRefValue, NodeValue } from '../CypherValue.js';
import { CypherWriteStats } from '../write/CypherWriteStats.js';
import { CypherFixture as F } from './CypherFixture.js';

/**
 * Port of TODL write-stats.test.ts. The two CypherResult DTO tests move to Task 6 (CypherResult and the codec
 * are ported there); NodeRefValue's ToDto refusal is now NodeRefValue.Unresolved() (R81 i); TODL's
 * GraphQueryAdapter.ResolveConcept cases run against the engine's label resolution (ReaderSource.ResolveLabel).
 */
class StatsFx
{
    public static Open(): Promise<F>
    {
        return F.Open([
            F.Concept('Element', []),
            F.Concept('shop.Customer', [F.Text('name')], 'Element'),
            F.Concept('crm.Customer', [F.Text('name')], 'Element'),
            F.Concept('a.b.C', [], 'Element'),
        ], []);
    }
}

describe('CypherWriteStats', () =>
{
    test('defaults to all zero and ToDto has the five numeric fields', () =>
    {
        const dto = new CypherWriteStats().ToDto();
        assert.deepEqual(dto, { NodesCreated: 0, NodesDeleted: 0, RelationshipsCreated: 0, RelationshipsDeleted: 0, PropertiesSet: 0 });
    });

    test('ToDto reflects mutated counters', () =>
    {
        const s = new CypherWriteStats();
        s.NodesCreated = 2;
        s.PropertiesSet = 5;
        assert.equal(s.ToDto().NodesCreated, 2);
        assert.equal(s.ToDto().PropertiesSet, 5);
    });
});

describe('NodeRefValue', () =>
{
    test('exposes id, groups like a node, and reports itself unresolved', () =>
    {
        const ref = new NodeRefValue('n1');
        assert.equal(ref.Id, 'n1');
        assert.equal(ref.GroupKey(), `${NodeValue.GroupKeyPrefix}n1`);
        assert.equal(new NodeRefValue('x').GroupKey(), 'node:x');
        const e = ref.Unresolved();
        assert.ok(e instanceof CypherWriteError && /unresolved node reference/.test(e.message));
    });
});

describe('label resolution for writes', () =>
{
    let fx: F;
    before(async () => { fx = await StatsFx.Open(); });
    after(async () => { await fx.dispose(); });

    test('exact qualified name returns the name', async () =>
    {
        await fx.Read(async s => { assert.equal(s.ResolveLabel('shop.Customer'), 'shop.Customer'); });
    });

    test('a unique simple name resolves to the qualified name', async () =>
    {
        await fx.Read(async s => { assert.equal(s.ResolveLabel('C'), 'a.b.C'); });
    });

    test('an ambiguous simple name throws listing candidates', async () =>
    {
        await fx.Read(async s =>
        {
            assert.throws(() => s.ResolveLabel('Customer'), (e: unknown) => e instanceof CypherSemanticError && /shop\.Customer/.test(e.message) && /crm\.Customer/.test(e.message));
        });
    });

    test('an unknown name throws CypherSemanticError', async () =>
    {
        await fx.Read(async s => { assert.throws(() => s.ResolveLabel('Nope'), CypherSemanticError); });
    });
});
