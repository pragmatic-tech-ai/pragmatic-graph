import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTimeValue, DateValue, DurationValue } from '../../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { CypherCursor } from '../CypherCursor.js';
import { CypherEngine } from '../CypherEngine.js';
import type { CypherResult } from '../CypherResult.js';
import { CypherNode } from '../CypherNode.js';
import { NodeValue, ScalarValue } from '../CypherValue.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

class CursorFixture
{
    public static readonly Query = 'MATCH (a:Service) RETURN a.name';

    public static Open(count: number): Promise<EngineHarness>
    {
        const F = CypherFixture;
        const seed = [];
        for (let i = count - 1; i >= 0; i--) seed.push(F.Node(`id${i}`, 'Service', { name: CursorFixture.Name(i) }));
        return EngineHarness.Open([F.Concept('Element', []), F.Concept('Service', [F.Text('name')], 'Element')], seed);
    }

    public static Name(i: number): string
    {
        return `s${String(i).padStart(2, '0')}`;
    }

    public static async Chain(h: EngineHarness, size: number): Promise<CypherResult[]>
    {
        const pages: CypherResult[] = [];
        let cursor: CypherCursor | undefined;
        do
        {
            const limits = cursor === undefined ? { RowCap: size, Skip: 0 } : { RowCap: size, After: cursor };
            const page = await h.Execute(CursorFixture.Query, undefined, limits);
            pages.push(page);
            cursor = page.NextCursor;
        }
        while (cursor !== undefined);
        return pages;
    }
}

describe('CypherCursor keyset paging', () =>
{
    let h: EngineHarness;
    before(async () => { h = await CursorFixture.Open(25); });
    after(() => h.dispose());

    test('pages concatenate to the full result', async () =>
    {
        const full = EngineHarness.Col(await h.Execute(`${CursorFixture.Query} ORDER BY a.name`));
        const pages = await CursorFixture.Chain(h, 10);
        assert.deepEqual(pages.map((p) => p.Rows.length), [10, 10, 5]);
        assert.deepEqual(pages.flatMap((p) => EngineHarness.Col(p)), full);
        assert.equal(pages[2]!.NextCursor, undefined);
        assert.equal(pages[2]!.HasMore, false);
        assert.equal(pages[0]!.HasMore, true);
    });

    test('insert between pages neither repeats nor skips', async () =>
    {
        const local = await CursorFixture.Open(25);
        try
        {
            const first = await local.Execute(CursorFixture.Query, undefined, { RowCap: 10, Skip: 0 });
            await local.Execute("CREATE (n:Service {name: 's00a'})");
            const second = await local.Execute(CursorFixture.Query, undefined, { RowCap: 10, After: first.NextCursor! });
            assert.deepEqual(EngineHarness.Col(second), Array.from({ length: 10 }, (_, i) => CursorFixture.Name(i + 10)));
            assert.ok(second.Commit! > first.Commit!);
        }
        finally
        {
            await local.dispose();
        }
    });

    test('cursor round-trips, including temporal and node cells', () =>
    {
        const node = new CypherNode('n1', 'Service', 'o', new Map([['name', 'x']]));
        node.FillLinks([]);
        const values = [
            new ScalarValue('text'), new ScalarValue(5n), new ScalarValue(2.5),
            new ScalarValue(new DateValue(19000)), new ScalarValue(new DateTimeValue(1_700_000_000_000_000n, 'Europe/Paris')),
            new ScalarValue(new DurationValue(1, 2, 3n)), new NodeValue(node),
        ];
        const text = new CypherCursor(1n << 60n, values).Encode();
        assert.ok(text.startsWith('1.'));
        const back = CypherCursor.Decode(text);
        assert.equal(back.Commit, 1n << 60n);
        assert.equal(back.Encode(), text);
        assert.equal(back.After.length, values.length);
    });

    test('malformed cursor is InvalidArgument', () =>
    {
        for (const bad of ['', 'x', '2.abc', '1.!!!', '1.' + Buffer.from('{}').toString('base64url'), '1.' + Buffer.from('[1]').toString('base64url')])
        {
            assert.throws(() => CypherCursor.Decode(bad), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument, bad);
        }
    });

    test('After with Skip is InvalidArgument', async () =>
    {
        const cursor = new CypherCursor(0n, [new ScalarValue('s01')]);
        await assert.rejects(h.Execute(CursorFixture.Query, undefined, { RowCap: 5, Skip: 1, After: cursor }),
            (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
    });

    test('resume at a later commit is allowed', async () =>
    {
        const first = await h.Execute(CursorFixture.Query, undefined, { RowCap: 10, Skip: 0 });
        const stale = new CypherCursor(first.Commit! - 5n, first.NextCursor!.After);
        const second = await h.Execute(CursorFixture.Query, undefined, { RowCap: 10, After: stale });
        assert.equal(EngineHarness.Col(second)[0], CursorFixture.Name(10));
    });

    test('a read reports its snapshot commit and the cursor survives the DTO', async () =>
    {
        const page = await h.Execute(CursorFixture.Query, undefined, { RowCap: 3, Skip: 0 });
        const dto = CypherEngine.ToDto(page);
        assert.equal(dto.Commit, page.Commit!.toString());
        assert.equal(CypherCursor.Decode(dto.NextCursor!).After[0] instanceof ScalarValue, true);
    });
});
