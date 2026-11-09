import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { VarLengthExpand } from '../operators/VarLengthExpand.js';
import { BindingRow } from '../operators/BindingRow.js';
import type { IOperator } from '../operators/IOperator.js';
import type { ICypherSource } from '../CypherSource.js';
import { NodeValue } from '../CypherValue.js';
import { PathValue } from '../StructuredValues.js';
import { Binding } from '../Binding.js';
import { RelDirection } from '../CypherEnums.js';
import { CypherFixture } from './CypherFixture.js';

/** A Service graph whose `r` edges are given as an adjacency literal (real, directed edges). */
class VarFixtures
{
    public static readonly Concept = 'Service';
    public static readonly Rel = 'r';
    public static readonly From = 'x';
    public static readonly To = 'y';
    public static readonly PathVar = 'p';

    public static Open(edges: Record<string, string[]>): Promise<CypherFixture>
    {
        const F = CypherFixture;
        const ids = new Set<string>(Object.keys(edges));
        for (const targets of Object.values(edges)) for (const t of targets) ids.add(t);
        const seed = [...ids].sort().map(id => F.Node(id, VarFixtures.Concept, {}, (edges[id] ?? []).map(t => [VarFixtures.Rel, t] as const)));
        return F.Open([F.Concept(VarFixtures.Concept, [F.Rel(VarFixtures.Rel, [VarFixtures.Concept])])], seed);
    }

    public static async Seed(source: ICypherSource, id: string): Promise<IOperator>
    {
        const node = await source.Node(id);
        return new BindingRow(new Binding().With(VarFixtures.From, new NodeValue(node!)));
    }

    public static async Run(edges: Record<string, string[]>, start: string, min: number, max: number, pathVar?: string, direction: RelDirection = RelDirection.Outgoing): Promise<Binding[]>
    {
        const fx = await VarFixtures.Open(edges);
        try
        {
            return await fx.Read(async s =>
            {
                const op = new VarLengthExpand(await VarFixtures.Seed(s, start), s, VarFixtures.From, VarFixtures.To,
                    VarFixtures.Rel, direction, min, max, undefined, pathVar);
                return CypherFixture.Collect(op);
            });
        }
        finally
        {
            await fx.dispose();
        }
    }

    public static Ends(rows: Binding[]): string[]
    {
        return rows.map(r => (r.Get(VarFixtures.To) as NodeValue).Id).sort();
    }
}

describe('VarLengthExpand', () =>
{
    const chain = { a: ['b'], b: ['c'] };

    test('*1..2 over a chain yields b and c', async () =>
    {
        assert.deepEqual(VarFixtures.Ends(await VarFixtures.Run(chain, 'a', 1, 2)), ['b', 'c']);
    });

    test('min=2 excludes the 1-hop endpoint', async () =>
    {
        assert.deepEqual(VarFixtures.Ends(await VarFixtures.Run(chain, 'a', 2, 2)), ['c']);
    });

    test('max caps depth', async () =>
    {
        assert.deepEqual(VarFixtures.Ends(await VarFixtures.Run(chain, 'a', 1, 1)), ['b']);
    });

    test('min=0 includes the start node itself', async () =>
    {
        assert.deepEqual(VarFixtures.Ends(await VarFixtures.Run(chain, 'a', 0, 2)), ['a', 'b', 'c']);
    });

    test('cycle a->b->a terminates via relationship-isomorphism', async () =>
    {
        const rows = await VarFixtures.Run({ a: ['b'], b: ['a'] }, 'a', 1, 1000);
        // a->b, b->a are two distinct steps; a->b may not repeat, so the walk stops: endpoints b (1 hop) and a (2 hops).
        assert.deepEqual(VarFixtures.Ends(rows), ['a', 'b']);
    });

    test('self loop terminates', async () =>
    {
        assert.deepEqual(VarFixtures.Ends(await VarFixtures.Run({ a: ['a'] }, 'a', 1, 1000)), ['a']);
    });

    test('undirected walk does not re-use the same physical edge back and forth', async () =>
    {
        // One physical edge a-b; an undirected Expand reports it from both ends (Out from a, In from b).
        const rows = await VarFixtures.Run({ a: ['b'] }, 'a', 1, 1000, undefined, RelDirection.Undirected);
        assert.deepEqual(VarFixtures.Ends(rows), ['b']);
    });

    test('incoming walk orients RelValue by the real edge direction', async () =>
    {
        // Real edge b->c; walking Incoming from c reaches b.
        const rows = await VarFixtures.Run({ b: ['c'] }, 'c', 1, 1, VarFixtures.PathVar, RelDirection.Incoming);
        assert.equal(rows.length, 1);
        const rel = (rows[0]!.Get(VarFixtures.PathVar) as PathValue).Rels[0]!;
        assert.equal(rel.FromId, 'b');
        assert.equal(rel.ToId, 'c');
    });

    test('binds PathValue with correct length', async () =>
    {
        const rows = await VarFixtures.Run(chain, 'a', 2, 2, VarFixtures.PathVar);
        assert.equal(rows.length, 1);
        const path = rows[0]!.Get(VarFixtures.PathVar) as PathValue;
        assert.ok(path instanceof PathValue);
        assert.equal(path.Length(), 2);
        assert.deepEqual(path.Nodes.map(n => n.Id), ['a', 'b', 'c']);
        assert.equal(path.Rels[0]!.FromId, 'a');
        assert.equal(path.Rels[1]!.ToId, 'c');
    });
});
