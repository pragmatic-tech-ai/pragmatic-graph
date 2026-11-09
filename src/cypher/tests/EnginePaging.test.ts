import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CypherEngine } from '../CypherEngine.js';
import { CypherSemanticError } from '../CypherError.js';
import type { CypherResult } from '../CypherResult.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

class PagingFixture
{
    // Services s00..s(count-1), seeded in REVERSE name order so an ascending result proves a sort happened.
    public static Open(count: number): Promise<EngineHarness>
    {
        const F = CypherFixture;
        const seed = [];
        for (let i = count - 1; i >= 0; i--)
        {
            seed.push(F.Node(`id${i}`, 'Service', { name: PagingFixture.Name(i) }));
        }
        return EngineHarness.Open([F.Concept('Element', []), F.Concept('Service', [F.Text('name')], 'Element')], seed);
    }

    public static Name(i: number): string
    {
        return `s${String(i).padStart(2, '0')}`;
    }

    public static Names(from: number, to: number): string[]
    {
        const out: string[] = [];
        for (let i = from; i < to; i++) out.push(PagingFixture.Name(i));
        return out;
    }

    public static Col(result: CypherResult): unknown[]
    {
        return EngineHarness.Col(result, 0);
    }
}

class TieFixture
{
    private static readonly RunSize = 6;

    // The first column (tier) repeats across rows while the second (name) is distinct: the first RunSize names share
    // tier "t0", the rest "t1". Seeded in REVERSE name order so the (tier, name) order can only come from sorting.
    public static Open(count: number): Promise<EngineHarness>
    {
        const F = CypherFixture;
        const seed = [];
        for (let i = count - 1; i >= 0; i--)
        {
            seed.push(F.Node(`id${i}`, 'Service', { tier: `t${i < TieFixture.RunSize ? 0 : 1}`, name: PagingFixture.Name(i) }));
        }
        return EngineHarness.Open([F.Concept('Element', []), F.Concept('Service', [F.Text('tier'), F.Text('name')], 'Element')], seed);
    }
}

describe('Execute paging tiebreak', () =>
{
    const TwoColumn = 'MATCH (a:Service) RETURN a.tier, a.name';
    const Ordered = 'MATCH (a:Service) RETURN a.tier, a.name ORDER BY a.tier, a.name';
    let e: EngineHarness;
    before(async () => { e = await TieFixture.Open(10); });
    after(() => e.dispose());

    test('a non-unique first column pages as a stable total order across the boundary', async () =>
    {
        const single = EngineHarness.Pairs(await e.Execute(Ordered));
        const pages = await Promise.all([0, 4, 8].map((skip) => e.Execute(TwoColumn, undefined, { Skip: skip, RowCap: 4 })));
        const paged = pages.flatMap((p) => EngineHarness.Pairs(p));
        assert.deepEqual(paged, single);
        assert.equal(paged.length, 10);
        assert.equal(new Set(paged.map((pair) => pair[1])).size, 10);
        assert.deepEqual(pages.map((p) => p.HasMore), [true, true, false]);
    });
});

describe('Execute paging', () =>
{
    const Ordered = 'MATCH (a:Service) RETURN a.name ORDER BY a.name';
    const Unordered = 'MATCH (a:Service) RETURN a.name';
    const Limited = 'MATCH (a:Service) RETURN a.name ORDER BY a.name LIMIT 10';
    const Counted = 'MATCH (a:Service) RETURN count(a) AS c';
    const Distinct = 'MATCH (a:Service) RETURN DISTINCT a.name';
    const Chained = 'MATCH (a:Service) WITH a.name AS n RETURN n';
    let e: EngineHarness;
    let big: EngineHarness;
    before(async () => { e = await PagingFixture.Open(10); big = await PagingFixture.Open(50); });
    after(async () => { await e.dispose(); await big.dispose(); });

    test('pages by Skip/RowCap with HasMore and never Truncated', async () =>
    {
        const first = await e.Execute(Ordered, undefined, { Skip: 0, RowCap: 4 });
        assert.deepEqual(PagingFixture.Col(first), PagingFixture.Names(0, 4));
        assert.equal(first.HasMore, true);
        assert.equal(first.Truncated, false);
        const last = await e.Execute(Ordered, undefined, { Skip: 8, RowCap: 4 });
        assert.deepEqual(PagingFixture.Col(last), PagingFixture.Names(8, 10));
        assert.equal(last.HasMore, false);
        assert.equal(last.Truncated, false);
    });

    test('exact boundary has no more', async () =>
    {
        const r = await e.Execute(Ordered, undefined, { Skip: 6, RowCap: 4 });
        assert.deepEqual(PagingFixture.Col(r), PagingFixture.Names(6, 10));
        assert.equal(r.HasMore, false);
        assert.equal(r.Truncated, false);
    });

    test('implicit order by first column when paging an unordered query', async () =>
    {
        const r = await e.Execute(Unordered, undefined, { Skip: 0, RowCap: 10 });
        assert.deepEqual(PagingFixture.Col(r), PagingFixture.Names(0, 10));
        assert.equal(r.HasMore, false);
    });

    test('unordered query without Skip keeps current behavior', async () =>
    {
        const all = await e.Execute(Unordered);
        assert.equal(all.Rows.length, 10);
        assert.equal(all.HasMore, false);
        assert.equal(all.Truncated, false);
        // No Skip means no implicit order: rows arrive in source (seed, i.e. reverse-name) order.
        assert.deepEqual(PagingFixture.Col(all), PagingFixture.Names(0, 10).reverse());
        const capped = await e.Execute(Unordered, undefined, { RowCap: 2 });
        assert.equal(capped.Rows.length, 2);
        assert.equal(capped.Truncated, true);
        assert.equal(capped.HasMore, false);
    });

    test('user LIMIT bounds the total', async () =>
    {
        const pages = await Promise.all([0, 4, 8].map((skip) => big.Execute(Limited, undefined, { Skip: skip, RowCap: 4 })));
        assert.deepEqual(pages.map((p) => p.Rows.length), [4, 4, 2]);
        assert.deepEqual(pages.map((p) => p.HasMore), [true, true, false]);
        assert.deepEqual(PagingFixture.Col(pages[2]!), PagingFixture.Names(8, 10));
    });

    test('skipped rows are not materialized and the result never exceeds RowCap', async () =>
    {
        const r = await big.Execute(Unordered, undefined, { Skip: 40, RowCap: 4 });
        assert.equal(r.Rows.length, 4);
        assert.deepEqual(PagingFixture.Col(r), PagingFixture.Names(40, 44));
        assert.equal(r.HasMore, true);
    });

    test('ToDto carries HasMore', async () =>
    {
        const more = CypherEngine.ToDto(await e.Execute(Ordered, undefined, { Skip: 0, RowCap: 4 }));
        assert.equal(more.HasMore, true);
        assert.equal(more.Truncated, false);
        const done = CypherEngine.ToDto(await e.Execute(Ordered));
        assert.equal(done.HasMore, false);
    });

    test('rejects a negative or NaN Skip', async () =>
    {
        await assert.rejects(e.Execute(Ordered, undefined, { Skip: -1, RowCap: 4 }), CypherSemanticError);
        await assert.rejects(e.Execute(Ordered, undefined, { Skip: Number.NaN, RowCap: 4 }), CypherSemanticError);
        await assert.rejects(e.Execute(Ordered, undefined, { Skip: 1.5, RowCap: 4 }), CypherSemanticError);
    });

    test('rejects Skip with a missing or zero RowCap', async () =>
    {
        await assert.rejects(e.Execute(Ordered, undefined, { Skip: 0 }), CypherSemanticError);
        await assert.rejects(e.Execute(Ordered, undefined, { Skip: 0, RowCap: 0 }), CypherSemanticError);
    });

    test('pages over an aggregate', async () =>
    {
        const r = await e.Execute(Counted, undefined, { Skip: 0, RowCap: 2 });
        assert.deepEqual(PagingFixture.Col(r), [10n]);
        assert.equal(r.HasMore, false);
        assert.equal(r.Truncated, false);
    });

    test('pages over DISTINCT', async () =>
    {
        const first = await e.Execute(Distinct, undefined, { Skip: 0, RowCap: 4 });
        assert.deepEqual(PagingFixture.Col(first), PagingFixture.Names(0, 4));
        assert.equal(first.HasMore, true);
        const last = await e.Execute(Distinct, undefined, { Skip: 8, RowCap: 4 });
        assert.deepEqual(PagingFixture.Col(last), PagingFixture.Names(8, 10));
        assert.equal(last.HasMore, false);
    });

    test('pages over a WITH-chained query in ascending order', async () =>
    {
        const pages = await Promise.all([0, 4, 8].map((skip) => e.Execute(Chained, undefined, { Skip: skip, RowCap: 4 })));
        assert.deepEqual(pages.flatMap((p) => PagingFixture.Col(p)), PagingFixture.Names(0, 10));
        assert.deepEqual(pages.map((p) => p.Rows.length), [4, 4, 2]);
        assert.deepEqual(pages.map((p) => p.HasMore), [true, true, false]);
    });
});

// openCypher orderability: NaN equals NaN and sorts above every other number; = and < keep NaN incomparable.
describe('ORDER BY with NaN', () =>
{
    const Xs = new Map([['xs', [5, Number.NaN, 3, 1, 4, Number.NaN, 2, 0]]]);
    const Ascending = [0n, 1n, 2n, 3n, 4n, 5n, Number.NaN, Number.NaN];
    let e: EngineHarness;
    before(async () => { e = await PagingFixture.Open(1); });
    after(() => e.dispose());

    test('ascending puts NaN last, descending first', async () =>
    {
        assert.deepEqual(PagingFixture.Col(await e.Execute('UNWIND $xs AS x RETURN x ORDER BY x', Xs)), Ascending);
        assert.deepEqual(PagingFixture.Col(await e.Execute('UNWIND $xs AS x RETURN x ORDER BY x DESC', Xs)), [...Ascending].reverse());
    });

    test('the implicit paging order sorts NaN last', async () =>
    {
        const pages = await Promise.all([0, 3, 6].map((skip) => e.Execute('UNWIND $xs AS x RETURN x', Xs, { Skip: skip, RowCap: 3 })));
        assert.deepEqual(pages.flatMap((p) => PagingFixture.Col(p)), Ascending);
    });

    test('predicates keep NaN incomparable', async () =>
    {
        assert.deepEqual(PagingFixture.Col(await e.Execute('UNWIND $xs AS x WITH x WHERE x = x RETURN count(*) AS c', Xs)), [6n]);
        assert.deepEqual(PagingFixture.Col(await e.Execute('UNWIND $xs AS x WITH x WHERE x > 4 RETURN x', Xs)), [5n]);
    });
});
