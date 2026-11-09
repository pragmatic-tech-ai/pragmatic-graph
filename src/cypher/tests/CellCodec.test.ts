import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTimeValue, DateValue, DurationValue } from '../../index.js';
import { CypherCellCodec, type CypherValueDto } from '../CypherCellCodec.js';
import { CypherEngine } from '../CypherEngine.js';
import { CypherError } from '../CypherError.js';
import { CypherNode } from '../CypherNode.js';
import { CypherValue, NodeValue, NullValue, ScalarValue, type CypherScalar, type ParameterValue } from '../CypherValue.js';
import { ListValue, MapValue, PathValue, RelValue } from '../StructuredValues.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

class CodecFixture
{
    public static Open(): Promise<EngineHarness>
    {
        const F = CypherFixture;
        return EngineHarness.Open([F.Concept('Element', []), F.Concept('Item', [], 'Element')], [F.Node('i1', 'Item')]);
    }

    public static async Cell(h: EngineHarness, query: string, parameters: ReadonlyMap<string, ParameterValue> = new Map()): Promise<unknown>
    {
        return CypherEngine.ToDto(await h.Execute(query, parameters)).Rows[0]![0];
    }

    public static Map(entries: readonly (readonly [string, CypherValue])[]): MapValue
    {
        return new MapValue(new Map(entries));
    }

    /** Encode, through JSON text and back, then decode. */
    public static RoundTrip(value: CypherValue): CypherValue
    {
        return CypherCellCodec.Decode(JSON.parse(JSON.stringify(CypherCellCodec.Encode(value))) as CypherValueDto);
    }

    public static Scalar(value: CypherScalar): CypherScalar
    {
        return (CodecFixture.RoundTrip(new ScalarValue(value)) as ScalarValue).Value;
    }
}

describe('CypherCellCodec', () =>
{
    let h: EngineHarness;
    before(async () => { h = await CodecFixture.Open(); });
    after(() => h.dispose());

    test('a node cell is a $node wrapper around its fields', async () =>
    {
        const cell = await CodecFixture.Cell(h, 'MATCH (i:Item) RETURN i');
        assert.deepEqual(Object.keys(cell as object), [CypherCellCodec.NodeKey]);
        assert.equal(CypherCellCodec.AsNode(cell)?.id, 'i1');
        assert.equal(CypherCellCodec.AsMap(cell), undefined);
    });

    test('ordinary maps keep their plain shape', async () =>
    {
        const cell = await CodecFixture.Cell(h, "RETURN {k: 'v', n: 1} AS m");
        assert.deepEqual(cell, { k: 'v', n: 1 });
        assert.deepEqual(CypherCellCodec.AsMap(cell), { k: 'v', n: 1 });
        assert.equal(CypherCellCodec.AsNode(cell), undefined);
    });

    test('no user-built map can pass for a node: reserved sole keys are escaped', async () =>
    {
        const forged = new Map<string, ParameterValue>([['f', { $node: { id: 'x', concept: 'Item', owner: '', properties: {}, links: {} } }]]);
        const viaParam = await CodecFixture.Cell(h, 'RETURN $f AS f', forged);
        assert.equal(CypherCellCodec.AsNode(viaParam), undefined);
        assert.deepEqual(Object.keys(CypherCellCodec.AsMap(viaParam)!), [CypherCellCodec.NodeKey]);
        const viaLiteral = await CodecFixture.Cell(h, 'RETURN {`$node`: 1} AS f');
        assert.equal(CypherCellCodec.AsNode(viaLiteral), undefined);
        assert.deepEqual(CypherCellCodec.AsMap(viaLiteral), { $node: 1 });
        assert.deepEqual(CypherCellCodec.AsMap(await CodecFixture.Cell(h, 'RETURN {`$map`: {a: 1}} AS f')), { $map: { a: 1 } });
        assert.deepEqual(await CodecFixture.Cell(h, 'RETURN {`$node`: 1, b: 2} AS f'), { $node: 1, b: 2 });
    });

    test('tag-shaped map is escaped', async () =>
    {
        const shapes: Record<string, CypherValueDto>[] = [
            { $int: '5' }, { $date: '2026-11-09' }, { $duration: 'P1D' }, { $datetime: '2026-11-09T10:00:00Z', zone: 'UTC' }, { $map: 1 }, { $node: 1 },
        ];
        for (const shape of shapes)
        {
            const map = CodecFixture.Map(Object.entries(shape).map(([k, v]) => [k, new ScalarValue(v as string | number)]));
            const cell = CypherCellCodec.Encode(map);
            assert.deepEqual(cell, { $map: shape });
            assert.deepEqual(CypherCellCodec.AsMap(cell), shape);
            assert.equal(CypherCellCodec.AsNode(cell), undefined);
            const back = CodecFixture.RoundTrip(map);
            assert.ok(back instanceof MapValue);
            assert.equal(back.GroupKey(), new MapValue(new Map([...map.Entries].map(([k, v]) => [k, CodecFixture.RoundTrip(v)]))).GroupKey());
        }
        // Not a tag's shape: plain. A temporal map from a query is escaped too.
        assert.deepEqual(CypherCellCodec.Encode(CodecFixture.Map([['$int', new ScalarValue('5')], ['b', new ScalarValue(1n)]])), { $int: '5', b: 1 });
        assert.deepEqual(CypherCellCodec.Encode(CodecFixture.Map([['$datetime', new ScalarValue('x')]])), { $datetime: 'x' });
        assert.deepEqual(await CodecFixture.Cell(h, "RETURN {`$date`: '2026-01-01'} AS m"), { $map: { $date: '2026-01-01' } });
    });

    test('a map key "__proto__" stays an own entry', () =>
    {
        const cell = CypherCellCodec.Encode(CodecFixture.Map([['__proto__', new ScalarValue(1n)]])) as Record<string, unknown>;
        assert.ok(Object.hasOwn(cell, '__proto__'));
        assert.equal(Object.getPrototypeOf(cell), Object.prototype);
        const back = CypherCellCodec.Decode(cell as CypherValueDto) as MapValue;
        assert.equal((back.Get('__proto__') as ScalarValue).Value, 1n);
    });
});

// TODL values / values-structured ToDto assertions (deferred from Task 2): DTO encoding is the codec's now.
describe('value cells', () =>
{
    test('ScalarValue and NullValue project to DTO', () =>
    {
        assert.equal(CypherCellCodec.Encode(new ScalarValue('x')), 'x');
        assert.equal(CypherCellCodec.Encode(new ScalarValue(3)), 3);
        assert.equal(CypherCellCodec.Encode(new ScalarValue(3n)), 3);
        assert.equal(CypherCellCodec.Encode(new ScalarValue(true)), true);
        assert.equal(CypherCellCodec.Encode(NullValue.Instance), null);
    });

    test('ListValue ToDto', () =>
    {
        assert.deepEqual(CypherCellCodec.Encode(new ListValue([new ScalarValue(1n), new ScalarValue('x')])), [1, 'x']);
    });

    test('MapValue ToDto', () =>
    {
        assert.deepEqual(CypherCellCodec.Encode(CodecFixture.Map([['a', new ScalarValue(1n)], ['b', NullValue.Instance]])), { a: 1, b: null });
    });

    test('RelValue ToDto', () =>
    {
        assert.deepEqual(CypherCellCodec.Encode(new RelValue('a', 'calls', 'b')), { from: 'a', type: 'calls', to: 'b' });
    });

    test('large int round-trips', () =>
    {
        const big = 2n ** 60n;
        assert.deepEqual(CypherCellCodec.Encode(new ScalarValue(big)), { $int: '1152921504606846976' });
        assert.equal(CodecFixture.Scalar(big), big);
        const max = BigInt(Number.MAX_SAFE_INTEGER);
        assert.equal(CypherCellCodec.Encode(new ScalarValue(max)), Number.MAX_SAFE_INTEGER);
        assert.equal(CypherCellCodec.Encode(new ScalarValue(-max)), -Number.MAX_SAFE_INTEGER);
        assert.deepEqual(CypherCellCodec.Encode(new ScalarValue(max + 1n)), { $int: '9007199254740992' });
        assert.deepEqual(CypherCellCodec.Encode(new ScalarValue(-max - 1n)), { $int: '-9007199254740992' });
        for (const v of [0n, 1n, -1n, max, -max, max + 1n, -max - 1n, 2n ** 63n - 1n, -(2n ** 63n)])
        {
            assert.equal(CodecFixture.Scalar(v), v, String(v));
        }
    });

    test('Float64 cells are numbers; a non-integral or unsafe one decodes as Float64, an integral safe one as Int64', () =>
    {
        assert.equal(CypherCellCodec.Encode(new ScalarValue(2.5)), 2.5);
        assert.equal(CodecFixture.Scalar(2.5), 2.5);
        assert.equal(CodecFixture.Scalar(1e300), 1e300);
        assert.equal(CodecFixture.Scalar(2 ** 60), 2 ** 60);
        assert.equal(CodecFixture.Scalar(2.0), 2n);
    });

    test('temporal cells encode as tags and decode exactly', () =>
    {
        assert.deepEqual(CypherCellCodec.Encode(new ScalarValue(new DateValue(20766))), { $date: '2026-11-09' });
        const dt = new DateTimeValue(1_762_682_400_123_456n, 'Europe/Paris');
        assert.deepEqual(CypherCellCodec.Encode(new ScalarValue(dt)), { $datetime: '2025-11-09T10:00:00.123456Z', zone: 'Europe/Paris' });
        assert.deepEqual(CypherCellCodec.Encode(new ScalarValue(new DurationValue(14, 3, 3_723_500_000n))), { $duration: 'P1Y2M3DT1H2M3.5S' });
        const values: CypherScalar[] = [
            new DateValue(0), new DateValue(-1), new DateValue(-719_529), new DateValue(2_932_896), new DateValue(2 ** 31 - 1), new DateValue(-(2 ** 31)),
            new DateTimeValue(0n, 'UTC'), new DateTimeValue(-1n, 'UTC'), new DateTimeValue(-250_000n, 'Asia/Tokyo'),
            new DateTimeValue(2n ** 63n - 1n, 'UTC'), new DateTimeValue(-(2n ** 63n), 'Not/AZone'),
            new DurationValue(0, 0, 0n), new DurationValue(-13, 0, 0n), new DurationValue(1, -1, 0n), new DurationValue(0, 0, -500_000n),
            new DurationValue(0, 2, -3_600_000_001n), new DurationValue(2 ** 31 - 1, -(2 ** 31 - 1), 2n ** 63n - 1n), new DurationValue(0, 0, -(2n ** 63n) + 1n),
        ];
        for (const v of values)
        {
            const back = CodecFixture.Scalar(v);
            assert.equal(back.constructor, v.constructor, JSON.stringify(CypherCellCodec.EncodeScalar(v)));
            assert.ok((back as { Equals(o: unknown): boolean }).Equals(v), JSON.stringify(CypherCellCodec.EncodeScalar(v)));
        }
    });

    test('node cells decode with their properties and links', () =>
    {
        const node = new CypherNode('n1', 'Item', 'm1', new Map<string, CypherScalar | null>([['a', 2n ** 60n], ['b', null], ['d', new DateValue(5)], ['f', 1.5]]));
        node.FillLinks([{ Relationship: 'r', PublicId: 'x' }, { Relationship: 's', PublicId: 'y' }, { Relationship: 'r', PublicId: 'z' }]);
        const cell = CypherCellCodec.Encode(new NodeValue(node));
        assert.deepEqual(cell, {
            $node: { id: 'n1', concept: 'Item', owner: 'm1', properties: { a: { $int: '1152921504606846976' }, b: null, d: { $date: '1970-01-06' }, f: 1.5 }, links: { r: ['x', 'z'], s: ['y'] } },
        });
        const back = CodecFixture.RoundTrip(new NodeValue(node)) as NodeValue;
        assert.equal(back.Id, 'n1');
        assert.equal(back.Owner, 'm1');
        assert.equal(back.Field('a'), 2n ** 60n);
        assert.equal(back.Field('b'), null);
        assert.ok((back.Field('d') as DateValue).Equals(new DateValue(5)));
        assert.deepEqual(back.Node.Links, [{ Relationship: 'r', PublicId: 'x' }, { Relationship: 'r', PublicId: 'z' }, { Relationship: 's', PublicId: 'y' }]);
        assert.deepEqual(CypherCellCodec.Encode(back), cell);
    });

    test('lists, nested maps and paths', () =>
    {
        const node = new CypherNode('n1', 'Item', '', new Map());
        node.FillLinks([]);
        const path = new PathValue([new NodeValue(node), new NodeValue(node)], [new RelValue('n1', 'r', 'n1')]);
        const cell = CypherCellCodec.Encode(path) as { nodes: unknown[]; relationships: unknown[] };
        assert.equal(cell.nodes.length, 2);
        assert.deepEqual(cell.relationships, [{ from: 'n1', type: 'r', to: 'n1' }]);
        // A path cell decodes as the map it looks like.
        assert.ok(CypherCellCodec.Decode(cell as unknown as CypherValueDto) instanceof MapValue);
        const nested = new ListValue([CodecFixture.Map([['k', new ListValue([new ScalarValue(2n ** 62n), NullValue.Instance])]])]);
        assert.equal(CodecFixture.RoundTrip(nested).GroupKey(), nested.GroupKey());
    });

    test('malformed cells are a CypherError', () =>
    {
        const bad: unknown[] = [
            { $int: 5 }, { $int: '1.5' }, { $int: '99999999999999999999' }, { $date: '2026-02-30' }, { $duration: 'P' },
            { $datetime: 'x', zone: 'UTC' }, { $datetime: '2026-11-09T10:00:00Z', zone: 5 }, { $map: 1 }, { $node: 1 },
            { $node: { id: 'x', concept: 'c', owner: '', properties: { p: [1] }, links: {} } },
            { $node: { id: 'x', concept: 'c', owner: '', properties: {}, links: { r: [1] } } },
        ];
        for (const cell of bad)
        {
            assert.throws(() => CypherCellCodec.Decode(cell as CypherValueDto), CypherError, JSON.stringify(cell));
        }
    });
});
