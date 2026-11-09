import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessScope } from '../AccessScope.js';
import type { CellValue } from '../../columns/CellValue.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { And, Compare, CompareOp, ConceptIs, IdIn, IsNull, Not, Or, OwnerIs, type Predicate, Reachable, Related, Seeded, TruePredicate } from '../../predicate/Predicate.js';
import { CypherFixture as F } from '../../cypher/tests/CypherFixture.js';

/**
 * Aspect Tagged { tag? }; P { owner?, title?, ref -> Q }; C extends P; Q carries Tagged { name? }.
 * Seed: p1 (P, owner u1) -ref-> q1 (Q), so stored nodes and edges exist that a hypothetical node must never borrow.
 */
class AdmitsFx
{
    public static readonly Tagged = 'Tagged';
    public static readonly P = 'P';
    public static readonly C = 'C';
    public static readonly Q = 'Q';
    public static readonly Tag = 'tag';
    public static readonly Owner = 'owner';
    public static readonly Title = 'title';
    public static readonly Name = 'name';
    public static readonly Ref = 'ref';
    public static readonly P1 = 'p1';
    public static readonly Q1 = 'q1';
    public static readonly U1 = 'u1';
    public static readonly U2 = 'u2';
    public static readonly T = 't';
    public static readonly Unknown = 'Nope';

    public static Open(): Promise<F>
    {
        return F.Open(
            [
                F.Aspect(AdmitsFx.Tagged, [F.Text(AdmitsFx.Tag)]),
                F.Concept(AdmitsFx.P, [F.Text(AdmitsFx.Owner), F.Text(AdmitsFx.Title), F.Rel(AdmitsFx.Ref, [AdmitsFx.Q])]),
                F.Concept(AdmitsFx.C, [], AdmitsFx.P),
                F.Concept(AdmitsFx.Q, [F.Text(AdmitsFx.Name)], null, [AdmitsFx.Tagged]),
            ],
            [
                F.Node(AdmitsFx.P1, AdmitsFx.P, { owner: AdmitsFx.U1 }, [[AdmitsFx.Ref, AdmitsFx.Q1]], AdmitsFx.U1),
                F.Node(AdmitsFx.Q1, AdmitsFx.Q, { name: AdmitsFx.T }),
            ]);
    }

    public static Rows(fallback: AccessDefault, entries: readonly (readonly [string, Predicate])[]): AccessScope
    {
        return AccessScope.Build({ Default: fallback, Rows: new Map(entries) });
    }

    public static Props(values: Readonly<Record<string, CellValue>> = {}): ReadonlyMap<string, CellValue>
    {
        return new Map(Object.entries(values));
    }

    public static OwnerU1(): Predicate
    {
        return new Compare(AdmitsFx.Owner, CompareOp.Eq, AdmitsFx.U1);
    }

    /** Admits on a reader opened under `scope`, for each `[concept, properties]` case. */
    public static async Admits(fx: F, scope: AccessScope, cases: readonly (readonly [string, ReadonlyMap<string, CellValue>])[]): Promise<boolean[]>
    {
        const reader = await fx.Engine.BeginRead(scope);
        try
        {
            return cases.map(([concept, properties]) => reader.Admits(concept, properties));
        }
        finally
        {
            reader.dispose();
        }
    }

    /** Admits of a hypothetical P `{ owner: u1 }` under a single Rows entry on P. */
    public static async OnP(fx: F, predicate: Predicate): Promise<boolean>
    {
        const [out] = await AdmitsFx.Admits(fx, AdmitsFx.Rows(AccessDefault.Allow, [[AdmitsFx.P, predicate]]), [[AdmitsFx.P, AdmitsFx.Props({ owner: AdmitsFx.U1 })]]);
        return out!;
    }
}

describe('GraphReader.Admits (R95)', () =>
{
    let fx: F;
    beforeEach(async () => { fx = await AdmitsFx.Open(); });
    afterEach(async () => { await fx.dispose(); });

    test('admits by property predicate', async () =>
    {
        const scope = AdmitsFx.Rows(AccessDefault.Deny, [[AdmitsFx.P, AdmitsFx.OwnerU1()]]);
        assert.deepEqual(await AdmitsFx.Admits(fx, scope, [
            [AdmitsFx.P, AdmitsFx.Props({ owner: AdmitsFx.U1 })],
            [AdmitsFx.P, AdmitsFx.Props({ owner: AdmitsFx.U2 })],
            [AdmitsFx.P, AdmitsFx.Props()],
        ]), [true, false, false]);
        // A missing property is null exactly as on a real node: IsNull holds, Not(IsNull) does not.
        assert.equal(await AdmitsFx.OnP(fx, new IsNull(AdmitsFx.Title)), true);
        assert.equal(await AdmitsFx.OnP(fx, new Not(new IsNull(AdmitsFx.Title))), false);
        // A value for a name that is not a property of the concept is not a value of the node.
        const [foreign] = await AdmitsFx.Admits(fx, AdmitsFx.Rows(AccessDefault.Allow, [[AdmitsFx.Tagged, new IsNull(AdmitsFx.Tag)]]),
            [[AdmitsFx.Q, AdmitsFx.Props({ tag: AdmitsFx.T })]]);
        assert.equal(foreign, false);
        const [ignored] = await AdmitsFx.Admits(fx, AdmitsFx.Rows(AccessDefault.Allow, [[AdmitsFx.Tagged, new IsNull(AdmitsFx.Tag)]]),
            [[AdmitsFx.Q, AdmitsFx.Props({ title: AdmitsFx.T })]]);
        assert.equal(ignored, true);
    });

    test('inherited and ConceptIs entries apply', async () =>
    {
        const guarded = new Or([new Not(new ConceptIs(AdmitsFx.P)), AdmitsFx.OwnerU1()]);
        const scope = AdmitsFx.Rows(AccessDefault.Allow, [[AdmitsFx.P, guarded]]);
        assert.deepEqual(await AdmitsFx.Admits(fx, scope, [
            [AdmitsFx.P, AdmitsFx.Props({ owner: AdmitsFx.U1 })],
            [AdmitsFx.P, AdmitsFx.Props({ owner: AdmitsFx.U2 })],
            [AdmitsFx.C, AdmitsFx.Props({ owner: AdmitsFx.U2 })],
        ]), [true, false, true]);
        // An unguarded entry on P reaches C (ancestor); an aspect entry reaches its carrier Q.
        const inherited = AdmitsFx.Rows(AccessDefault.Allow, [[AdmitsFx.P, AdmitsFx.OwnerU1()], [AdmitsFx.Tagged, new IsNull(AdmitsFx.Tag)]]);
        assert.deepEqual(await AdmitsFx.Admits(fx, inherited, [
            [AdmitsFx.C, AdmitsFx.Props({ owner: AdmitsFx.U1 })],
            [AdmitsFx.C, AdmitsFx.Props({ owner: AdmitsFx.U2 })],
            [AdmitsFx.Q, AdmitsFx.Props({ tag: AdmitsFx.T })],
            [AdmitsFx.Q, AdmitsFx.Props()],
        ]), [true, false, false, true]);
        // ConceptIs names exactly the hypothetical concept, never an ancestor.
        assert.deepEqual(await AdmitsFx.Admits(fx, AdmitsFx.Rows(AccessDefault.Allow, [[AdmitsFx.P, new ConceptIs(AdmitsFx.C)]]), [
            [AdmitsFx.P, AdmitsFx.Props()],
            [AdmitsFx.C, AdmitsFx.Props()],
        ]), [false, true]);
    });

    test('owner and seed predicates fail closed', async () =>
    {
        const owners = new Set([AdmitsFx.U1, '']);
        assert.equal(await AdmitsFx.OnP(fx, new OwnerIs(owners)), false);
        assert.equal(await AdmitsFx.OnP(fx, new Not(new OwnerIs(owners))), false);
        assert.equal(await AdmitsFx.OnP(fx, new Seeded()), false);
        assert.equal(await AdmitsFx.OnP(fx, new Not(new Seeded())), false);
        assert.equal(await AdmitsFx.OnP(fx, new Not(new Not(new Seeded()))), false);
        assert.equal(await AdmitsFx.OnP(fx, new Or([new Not(new Seeded()), new Not(new OwnerIs(owners))])), false);
        assert.equal(await AdmitsFx.OnP(fx, new Not(new And([new Seeded(), AdmitsFx.OwnerU1()]))), false);
        // IdIn needs a stored public id too.
        assert.equal(await AdmitsFx.OnP(fx, new IdIn(new Set([AdmitsFx.P1]))), false);
        assert.equal(await AdmitsFx.OnP(fx, new Not(new IdIn(new Set([AdmitsFx.P1])))), false);
        assert.equal(await AdmitsFx.OnP(fx, new Not(new And([AdmitsFx.OwnerU1(), new IdIn(new Set([AdmitsFx.P1]))]))), false);
        // A term that cannot be decided does not block what the node's own values decide (Kleene: sound for every owner).
        assert.equal(await AdmitsFx.OnP(fx, new Or([new Seeded(), AdmitsFx.OwnerU1()])), true);
        assert.equal(await AdmitsFx.OnP(fx, new Not(new And([new Seeded(), new Compare(AdmitsFx.Owner, CompareOp.Eq, AdmitsFx.U2)]))), true);
    });

    test('relationship predicates fail closed, including under Not', async () =>
    {
        const related = new Related(AdmitsFx.Ref, EdgeDirection.Out, TruePredicate.Instance);
        const reach = new Reachable(new Set([AdmitsFx.P1]), [{ Relationship: AdmitsFx.Ref, Direction: EdgeDirection.Out }], 1);
        const incoming = new Related(AdmitsFx.Ref, EdgeDirection.In, TruePredicate.Instance);
        for (const p of [related, reach])
        {
            assert.equal(await AdmitsFx.OnP(fx, p), false);
            assert.equal(await AdmitsFx.OnP(fx, new Not(p)), false);
            assert.equal(await AdmitsFx.OnP(fx, new Not(new Not(p))), false);
            assert.equal(await AdmitsFx.OnP(fx, new Or([new Not(p), new Not(AdmitsFx.OwnerU1())])), false);
        }
        // An aspect entry over an incoming edge on a hypothetical Q (q1 has one stored; a hypothetical has none).
        for (const p of [incoming, new Not(incoming), new Or([new Not(incoming), new Not(new IsNull(AdmitsFx.Tag))])])
        {
            const [q] = await AdmitsFx.Admits(fx, AdmitsFx.Rows(AccessDefault.Allow, [[AdmitsFx.Tagged, p]]), [[AdmitsFx.Q, AdmitsFx.Props()]]);
            assert.equal(q, false);
        }
    });

    test('unknown concept is not admitted', async () =>
    {
        const scope = AdmitsFx.Rows(AccessDefault.Allow, [[AdmitsFx.P, AdmitsFx.OwnerU1()]]);
        assert.deepEqual(await AdmitsFx.Admits(fx, scope, [
            [AdmitsFx.Unknown, AdmitsFx.Props({ owner: AdmitsFx.U1 })],
            [AdmitsFx.Tagged, AdmitsFx.Props()],
        ]), [false, false]);
        assert.deepEqual(await AdmitsFx.Admits(fx, AccessScope.System, [[AdmitsFx.Unknown, AdmitsFx.Props()], [AdmitsFx.Tagged, AdmitsFx.Props()]]), [false, false]);
    });

    test('system scope admits', async () =>
    {
        assert.deepEqual(await AdmitsFx.Admits(fx, AccessScope.System, [
            [AdmitsFx.P, AdmitsFx.Props()],
            [AdmitsFx.C, AdmitsFx.Props({ owner: AdmitsFx.U2 })],
            [AdmitsFx.Q, AdmitsFx.Props()],
        ]), [true, true, true]);
        // Unrestricted reads with Hidden entries still have an evaluator; no Rows entry and Default Allow still admit.
        const hidden = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[AdmitsFx.P, new Set([AdmitsFx.Title])]]) });
        assert.deepEqual(await AdmitsFx.Admits(fx, hidden, [[AdmitsFx.P, AdmitsFx.Props({ title: AdmitsFx.T })]]), [true]);
    });

    test('default deny without entry rejects', async () =>
    {
        const scope = AdmitsFx.Rows(AccessDefault.Deny, [[AdmitsFx.Q, TruePredicate.Instance]]);
        assert.deepEqual(await AdmitsFx.Admits(fx, scope, [[AdmitsFx.P, AdmitsFx.Props({ owner: AdmitsFx.U1 })], [AdmitsFx.Q, AdmitsFx.Props()]]), [false, true]);
    });

    test('default allow without entry admits', async () =>
    {
        const scope = AdmitsFx.Rows(AccessDefault.Allow, [[AdmitsFx.Q, new Seeded()]]);
        assert.deepEqual(await AdmitsFx.Admits(fx, scope, [[AdmitsFx.P, AdmitsFx.Props()], [AdmitsFx.Q, AdmitsFx.Props()]]), [true, false]);
    });

    test('admits is synchronous (no store access) and throws once disposed', async () =>
    {
        const reader = await fx.Engine.BeginRead(AdmitsFx.Rows(AccessDefault.Deny, [[AdmitsFx.P, AdmitsFx.OwnerU1()]]));
        assert.equal(reader.Admits(AdmitsFx.P, AdmitsFx.Props({ owner: AdmitsFx.U1 })), true);
        reader.dispose();
        assert.throws(() => reader.Admits(AdmitsFx.P, AdmitsFx.Props({ owner: AdmitsFx.U1 })));
    });
});
