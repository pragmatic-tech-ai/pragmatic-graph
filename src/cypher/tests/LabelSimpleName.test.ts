import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { CypherNode } from '../CypherNode.js';
import { CypherSemanticError } from '../CypherError.js';
import type { ICypherSource } from '../CypherSource.js';
import { CypherFixture } from './CypherFixture.js';

/** TODL ran these on GraphQueryAdapter (NodesByLabel / IsInstanceOf); here they run on ReaderSource (ScanLabel / IsA). */
class NamespacedFixture
{
    public static Open(): Promise<CypherFixture>
    {
        const F = CypherFixture;
        return F.Open(
            [
                F.Concept('Element', []),
                F.Concept('Plain', [], 'Element'),
                F.Concept('acme.Service', [], 'Element'),
                F.Concept('acme.CoreService', [], 'acme.Service'),
                F.Concept('one.Dup', [], 'Element'),
                F.Concept('two.Dup', [], 'Element'),
            ],
            [F.Node('p', 'Plain'), F.Node('s', 'acme.Service'), F.Node('c', 'acme.CoreService')]);
    }

    public static async Ids(source: ICypherSource, label: string): Promise<string[]>
    {
        const out: string[] = [];
        for await (const node of source.ScanLabel(label))
        {
            out.push(node.PublicId);
        }
        return out;
    }
}

describe('ReaderSource label resolution by simple name', () =>
{
    let fx: CypherFixture;
    before(async () => { fx = await NamespacedFixture.Open(); });
    after(() => fx.dispose());

    test('simple name matches a namespaced concept (inheritance-aware)', async () =>
    {
        await fx.Read(async (s) =>
        {
            assert.deepEqual((await NamespacedFixture.Ids(s, 'Service')).sort(), ['c', 's']);
            assert.deepEqual(await NamespacedFixture.Ids(s, 'CoreService'), ['c']);
        });
    });

    // TODL: IsInstanceOf(c, "Nope") was false; an unknown label now fails loudly (R82 c), so that part asserts the error.
    test('IsA resolves by simple name', async () =>
    {
        await fx.Read(async (s) =>
        {
            const c = (await s.Node('c')) as CypherNode;
            assert.equal(s.IsA(c, 'Service'), true);
            assert.equal(s.IsA(c, 'Plain'), false);
            assert.throws(() => s.IsA(c, 'Nope'), (e: unknown) => e instanceof CypherSemanticError && /unknown label/.test(e.message));
        });
    });

    test('unqualified concept still matches', async () =>
    {
        await fx.Read(async (s) => assert.deepEqual(await NamespacedFixture.Ids(s, 'Plain'), ['p']));
    });

    test('unknown label still throws', async () =>
    {
        await fx.Read(async (s) => assert.rejects(NamespacedFixture.Ids(s, 'Nope'), /unknown label/));
    });

    test('ambiguous simple name throws', async () =>
    {
        await fx.Read(async (s) => assert.rejects(NamespacedFixture.Ids(s, 'Dup'), (e: unknown) => e instanceof CypherSemanticError && /ambiguous label/.test(e.message)));
    });
});
