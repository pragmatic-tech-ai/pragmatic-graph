import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DateTimeValue, DateValue, DurationValue, type CellValue } from '../../columns/CellValue.js';
import { GraphErrorCode } from '../../errors/GraphError.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { NodeEvaluator } from '../NodeEvaluator.js';
import { And, Compare, CompareOp, IdIn, In, IsNull, Not, Or, OwnerIs, Predicate, Reachable, Related, Seeded } from '../Predicate.js';
import { PredicateCodec } from '../PredicateCodec.js';
import { PredicateError, PredicateErrorCode } from '../PredicateError.js';

class T
{
    public static Row(entries: Record<string, CellValue>): ReadonlyMap<string, CellValue>
    {
        return new Map(Object.entries(entries));
    }

    public static Matches(p: Predicate, entries: Record<string, CellValue> = {}, id = 'n1'): boolean
    {
        return NodeEvaluator.Matches(p, T.Row(entries), id);
    }
}

describe('NodeEvaluator', () =>
{
    it('compare null is false both ways', () =>
    {
        const eq = new Compare('x', CompareOp.Eq, 1n);
        assert.equal(T.Matches(eq, { x: null }), false);
        assert.equal(T.Matches(new Not(eq), { x: null }), false);
        assert.equal(T.Matches(new IsNull('x'), { x: null }), true);
        assert.equal(T.Matches(eq, {}), false);
        assert.equal(T.Matches(new Not(eq), {}), false);
        assert.equal(T.Matches(new IsNull('x'), {}), true);
        assert.equal(T.Matches(new IsNull('x'), { x: 1n }), false);
    });

    it('Kleene logic: False AND Unknown is False, True OR Unknown is True', () =>
    {
        const unknown = new Compare('x', CompareOp.Eq, 1n);
        assert.equal(T.Matches(new Not(new And([Predicate.False, unknown]))), true);
        assert.equal(T.Matches(new Not(new Or([Predicate.True, unknown]))), false);
        assert.equal(T.Matches(new Or([Predicate.True, unknown])), true);
        assert.equal(T.Matches(new Not(new And([Predicate.True, unknown]))), false);
        assert.equal(T.Matches(new Not(new Or([Predicate.False, unknown]))), false);
    });

    it('int and float compare numerically', () =>
    {
        assert.equal(T.Matches(new Compare('n', CompareOp.Lt, 2.5), { n: 2n }), true);
        assert.equal(T.Matches(new Compare('n', CompareOp.Eq, 2), { n: 2n }), true);
        assert.equal(T.Matches(new Compare('n', CompareOp.Gt, 2n), { n: 2.5 }), true);
        assert.equal(T.Matches(new Compare('n', CompareOp.Gt, 9007199254740992n), { n: 9007199254740992 }), false);
        assert.equal(T.Matches(new Compare('n', CompareOp.Lt, 9007199254740992), { n: 9007199254740991n }), true);
    });

    it('NaN never compares', () =>
    {
        for (const op of [CompareOp.Eq, CompareOp.Ne, CompareOp.Lt, CompareOp.Le, CompareOp.Gt, CompareOp.Ge])
        {
            assert.equal(T.Matches(new Compare('n', op, NaN), { n: 1.5 }), false);
            assert.equal(T.Matches(new Compare('n', op, 1n), { n: NaN }), false);
        }
    });

    it('mixed types never match', () =>
    {
        assert.equal(T.Matches(new Compare('s', CompareOp.Eq, 1n), { s: '1' }), false);
        assert.equal(T.Matches(new Compare('s', CompareOp.Ne, 1n), { s: '1' }), false);
        assert.equal(T.Matches(new Compare('b', CompareOp.Eq, 1n), { b: true }), false);
        assert.equal(T.Matches(new Compare('d', CompareOp.Eq, new DateTimeValue(0n, 'UTC')), { d: new DateValue(0) }), false);
    });

    it('string order is UTF-8 byte order', () =>
    {
        assert.equal(T.Matches(new Compare('s', CompareOp.Lt, 'a'), { s: 'Z' }), true);
        assert.equal(T.Matches(new Compare('s', CompareOp.Gt, 'z'), { s: 'é' }), true);
        // U+1F600 (astral) is below U+FF5E in UTF-16 code units but above it in UTF-8 bytes.
        assert.equal(T.Matches(new Compare('s', CompareOp.Gt, '～'), { s: '\u{1F600}' }), true);
        assert.equal(T.Matches(new Compare('s', CompareOp.Eq, 'abc'), { s: 'abc' }), true);
    });

    it('booleans order false before true', () =>
    {
        assert.equal(T.Matches(new Compare('b', CompareOp.Lt, true), { b: false }), true);
    });

    it('temporal values compare by instant; durations only Eq/Ne', () =>
    {
        assert.equal(T.Matches(new Compare('d', CompareOp.Lt, new DateValue(5)), { d: new DateValue(4) }), true);
        const a = new DateTimeValue(1_000n, 'UTC');
        const b = new DateTimeValue(1_000n, 'Europe/Paris');
        assert.equal(T.Matches(new Compare('t', CompareOp.Eq, b), { t: a }), true);
        assert.equal(T.Matches(new Compare('t', CompareOp.Lt, new DateTimeValue(2_000n, 'UTC')), { t: a }), true);
        const d = new DurationValue(1, 2, 3n);
        assert.equal(T.Matches(new Compare('u', CompareOp.Eq, new DurationValue(1, 2, 3n)), { u: d }), true);
        assert.equal(T.Matches(new Compare('u', CompareOp.Ne, new DurationValue(1, 2, 4n)), { u: d }), true);
        assert.equal(T.Matches(new Compare('u', CompareOp.Lt, new DurationValue(9, 9, 9n)), { u: d }), false);
        assert.equal(T.Matches(new Compare('u', CompareOp.Ge, new DurationValue(0, 0, 0n)), { u: d }), false);
    });

    it('In and IdIn', () =>
    {
        const p = new In('k', ['a', 'b']);
        assert.equal(T.Matches(p, { k: 'b' }), true);
        assert.equal(T.Matches(p, { k: 'c' }), false);
        assert.equal(T.Matches(p, { k: null }), false);
        assert.equal(T.Matches(new Not(p), { k: null }), false);
        assert.equal(T.Matches(new Not(p), { k: 'c' }), true);
        assert.equal(T.Matches(new In('k', ['a', null]), { k: 'c' }), false);
        assert.equal(T.Matches(new Not(new In('k', ['a', null])), { k: 'c' }), false);
        assert.equal(T.Matches(new IdIn(new Set(['n1', 'n2'])), {}, 'n2'), true);
        assert.equal(T.Matches(new IdIn(new Set(['n1'])), {}, 'zz'), false);
    });

    it('And/Or short-circuit and True/False', () =>
    {
        const needsReader = new Seeded();
        assert.equal(T.Matches(new And([]), {}), true);
        assert.equal(T.Matches(new Or([]), {}), false);
        assert.equal(T.Matches(Predicate.True), true);
        assert.equal(T.Matches(Predicate.False), false);
        assert.equal(T.Matches(new Not(Predicate.False)), true);
        assert.equal(T.Matches(new And([Predicate.True, new Compare('x', CompareOp.Eq, 1n)]), { x: 1n }), true);
        assert.equal(T.Matches(new And([Predicate.False, new Compare('x', CompareOp.Eq, 1n)]), { x: 1n }), false);
        assert.equal(T.Matches(new Or([Predicate.False, new Compare('x', CompareOp.Eq, 1n)]), { x: 1n }), true);
        // A non-local term is rejected up front, never silently skipped by short-circuiting.
        assert.throws(() => T.Matches(new Or([Predicate.True, needsReader])), (e: unknown) => e instanceof PredicateError && e.Code === PredicateErrorCode.NotNodeLocal);
    });

    it('non-node-local predicates throw NotNodeLocal', () =>
    {
        for (const p of [new Seeded(), new OwnerIs(new Set(['a'])), new Related('r', EdgeDirection.Out, Predicate.True), new Reachable(new Set(['a']), [], 1)])
        {
            assert.throws(() => T.Matches(p), (e: unknown) => e instanceof PredicateError && e.Code === PredicateErrorCode.NotNodeLocal && e.GraphCode === GraphErrorCode.SchemaViolation);
        }
    });
});

describe('Predicate', () =>
{
    it('IsNodeLocal is false when any term needs the reader', () =>
    {
        const compare = new Compare('x', CompareOp.Eq, 1n);
        const related = new Related('r', EdgeDirection.Out, Predicate.True);
        assert.equal(compare.IsNodeLocal, true);
        assert.equal(new And([compare, related]).IsNodeLocal, false);
        assert.equal(new Or([compare, new Not(new Seeded())]).IsNodeLocal, false);
        assert.equal(new And([compare, new Not(new IsNull('y'))]).IsNodeLocal, true);
        assert.equal(new OwnerIs(new Set()).IsNodeLocal, false);
        assert.equal(new Reachable(new Set(), [], 1).IsNodeLocal, false);
    });

    it('True and False are singletons', () =>
    {
        assert.equal(Predicate.True, Predicate.True);
        assert.notEqual(Predicate.True, Predicate.False);
    });
});

describe('PredicateCodec', () =>
{
    const Samples: Predicate[] = [
        Predicate.True,
        Predicate.False,
        new Compare('a', CompareOp.Ge, 5n),
        new Compare('a', CompareOp.Eq, -1.5),
        new Compare('a', CompareOp.Eq, NaN),
        new Compare('a', CompareOp.Eq, Infinity),
        new Compare('a', CompareOp.Eq, -0),
        new Compare('a', CompareOp.Ne, 'text'),
        new Compare('a', CompareOp.Ne, true),
        new Compare('a', CompareOp.Ne, null),
        new Compare('a', CompareOp.Lt, new DateValue(-3)),
        new Compare('a', CompareOp.Lt, new DateTimeValue(-123456789012345678n, 'Europe/Paris')),
        new Compare('a', CompareOp.Eq, new DurationValue(1, -2, 9007199254740993n)),
        new In('m', [1n, 'x', null, 2.5, false]),
        new IsNull('m'),
        new IdIn(new Set(['b', 'a'])),
        new Seeded(),
        new OwnerIs(new Set(['o2', 'o1'])),
        new And([Predicate.True, new Compare('a', CompareOp.Eq, 1n)]),
        new Or([new IsNull('a'), new Not(new IsNull('b'))]),
        new Not(Predicate.False),
        new Related('knows', EdgeDirection.In, new And([new IsNull('a'), new Related('r', EdgeDirection.Out, Predicate.True)])),
        new Reachable(new Set(['s1', 's2']), [{ Relationship: 'r', Direction: EdgeDirection.Out }, { Relationship: 'q', Direction: EdgeDirection.In }], 3),
    ];

    it('round-trips every kind through JSON text', () =>
    {
        for (const p of Samples)
        {
            const json = PredicateCodec.ToJson(p);
            const back = PredicateCodec.FromJson(JSON.parse(JSON.stringify(json)));
            assert.deepStrictEqual(back, p);
            assert.equal(back.Kind, p.Kind);
        }
    });

    it('serializes sets as sorted arrays and bigints as tagged strings', () =>
    {
        const json = PredicateCodec.ToJson(new IdIn(new Set(['b', 'a']))) as { Kind: number; Ids: string[] };
        assert.deepStrictEqual(json.Ids, ['a', 'b']);
        assert.equal(json.Kind, 9);
        const c = PredicateCodec.ToJson(new Compare('a', CompareOp.Eq, 5n)) as { Value: unknown };
        assert.deepStrictEqual(c.Value, { Int64: '5' });
    });

    it('rejects malformed documents with PredicateError Malformed', () =>
    {
        const bad: unknown[] = [
            { Kind: 99 },
            null,
            'x',
            [],
            {},
            { Kind: 3, Member: 'a', Op: 99, Value: null },
            { Kind: 3, Member: 1, Op: 1, Value: null },
            { Kind: 3, Member: 'a', Op: 1, Value: { Bogus: 1 } },
            { Kind: 3, Member: 'a', Op: 1, Value: { Int64: 'abc' } },
            { Kind: 3, Member: 'a', Op: 1, Value: {} },
            { Kind: 4, Member: 'a', Values: 'no' },
            { Kind: 6, Terms: [{ Kind: 99 }] },
            { Kind: 8, Term: 5 },
            { Kind: 9, Ids: [1] },
            { Kind: 10, Relationship: 'r', Direction: 7, Target: { Kind: 1 } },
            { Kind: 11, From: [], Steps: [{ Relationship: 'r', Direction: 0 }], MaxHops: 0 },
            { Kind: 11, From: [], Steps: [{ Relationship: 'r', Direction: 0 }], MaxHops: 1.5 },
            { Kind: 11, From: [], Steps: [{ Relationship: 1, Direction: 0 }], MaxHops: 1 },
        ];
        for (const json of bad)
        {
            assert.throws(
                () => PredicateCodec.FromJson(json),
                (e: unknown) => e instanceof PredicateError && e.Code === PredicateErrorCode.Malformed && e.GraphCode === GraphErrorCode.SchemaViolation,
                JSON.stringify(json));
        }
    });
});

class Bad
{
    public static Malformed(json: unknown): void
    {
        assert.throws(
            () => PredicateCodec.FromJson(json),
            (e: unknown) => e instanceof PredicateError && e.Code === PredicateErrorCode.Malformed && e.GraphCode === GraphErrorCode.SchemaViolation,
            typeof json);
    }

    public static Cmp(value: unknown): unknown
    {
        return { Kind: 3, Member: 'a', Op: 1, Value: value };
    }
}

describe('PredicateCodec strictness and limits', () =>
{
    it('Float64 text must be a strict number literal', () =>
    {
        for (const t of ['', ' ', '0x10', '1 ', 'abc', '1e', '--1', '1_0', 'nan', 'infinity'])
        {
            Bad.Malformed(Bad.Cmp({ Float64: t }));
        }
        for (const t of ['1', '-1.5', '.5', '2.', '1e10', '-1.5E-3', 'NaN', 'Infinity', '-Infinity'])
        {
            const p = PredicateCodec.FromJson(Bad.Cmp({ Float64: t })) as Compare;
            assert.ok(typeof p.Value === 'number');
        }
    });

    it('Int64 and Micros must fit in signed 64 bits', () =>
    {
        const max = (1n << 63n) - 1n;
        const min = -(1n << 63n);
        assert.equal((PredicateCodec.FromJson(Bad.Cmp({ Int64: max.toString() })) as Compare).Value, max);
        assert.equal((PredicateCodec.FromJson(Bad.Cmp({ Int64: min.toString() })) as Compare).Value, min);
        Bad.Malformed(Bad.Cmp({ Int64: (max + 1n).toString() }));
        Bad.Malformed(Bad.Cmp({ Int64: (min - 1n).toString() }));
        Bad.Malformed(Bad.Cmp({ DateTime: { Micros: (max + 1n).toString(), Zone: 'UTC' } }));
        Bad.Malformed(Bad.Cmp({ Duration: { Months: 0, Days: 0, Micros: (min - 1n).toString() } }));
    });

    it('Reachable validates MaxHops in the constructor', () =>
    {
        for (const hops of [0, -1, 1.5, NaN])
        {
            assert.throws(() => new Reachable(new Set(), [], hops), (e: unknown) => e instanceof PredicateError && e.Code === PredicateErrorCode.Malformed);
        }
        assert.equal(new Reachable(new Set(), [], 1).MaxHops, 1);
    });

    it('FromJson bounds nesting depth', () =>
    {
        let ok: unknown = { Kind: 1 };
        for (let i = 0; i < 200; i++)
        {
            ok = { Kind: 8, Term: ok };
        }
        assert.doesNotThrow(() => PredicateCodec.FromJson(ok));
        let deep: unknown = { Kind: 1 };
        for (let i = 0; i < 100_000; i++)
        {
            deep = { Kind: 8, Term: deep };
        }
        Bad.Malformed(deep);
    });

    it('IsNodeLocal is a precomputed value on each node', () =>
    {
        const p = new And([new Compare('x', CompareOp.Eq, 1n), new Not(new Related('r', EdgeDirection.Out, Predicate.True))]);
        assert.equal(Object.getOwnPropertyDescriptor(p, 'IsNodeLocal')?.value, false);
        assert.equal(Object.getOwnPropertyDescriptor(new Compare('x', CompareOp.Eq, 1n), 'IsNodeLocal')?.value, true);
    });

    it('lone surrogates order as U+FFFD, matching TupleCodec UTF-8 encoding', () =>
    {
        const lone = String.fromCharCode(0xD800);
        assert.equal(T.Matches(new Compare('s', CompareOp.Eq, String.fromCharCode(0xFFFD)), { s: lone }), true);
        assert.equal(T.Matches(new Compare('s', CompareOp.Lt, String.fromCharCode(0xFFFE)), { s: lone }), true);
    });
});

describe('Predicate.MemberNames', () =>
{
    it('lists the members read on the node itself, not through Related', () =>
    {
        const p = new And([
            new Compare('a', CompareOp.Eq, 1n),
            new Or([new In('b', ['x']), new Not(new IsNull('c'))]),
            new Related('r', EdgeDirection.Out, new Compare('far', CompareOp.Eq, 1n)),
            new IdIn(new Set(['n1'])),
        ]);
        assert.deepEqual([...Predicate.MemberNames(p)].sort(), ['a', 'b', 'c']);
        assert.equal(Predicate.MemberNames(Predicate.True).size, 0);
    });
});
