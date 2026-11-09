import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccessError, AccessErrorCode } from '../AccessError.js';
import { AccessDefault, AccessScope, type IAccessScopeOptions, type IReadOnlyMembers, type IWriteRules } from '../AccessScope.js';
import type { CellValue } from '../../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import type { GraphReader } from '../../GraphReader.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { CypherEngine } from '../../cypher/CypherEngine.js';
import { CypherWriteError } from '../../cypher/CypherError.js';
import { CypherFixture as F } from '../../cypher/tests/CypherFixture.js';
import { WriteFixture as W } from '../../cypher/tests/WriteFixture.js';
import type { INodePlace, INodePlacement } from '../../cypher/write/NodePlacement.js';

/** A placement handing out c0, c1, ... with no owner and an `owner` property default (ruling R91). */
class OwnerDefaultPlacement implements INodePlacement
{
    private static readonly Prefix = 'c';
    private static readonly NoOwner = '';

    private count = 0;

    public Place(): INodePlace
    {
        return { PublicId: `${OwnerDefaultPlacement.Prefix}${this.count++}`, Owner: OwnerDefaultPlacement.NoOwner, Defaults: new Map<string, CellValue>([[ExactFx.Owner, ExactFx.U2]]) };
    }
}

/**
 * Aspect Tagged { tag? }; P { secret?, title?, owner?, ref -> Q }; C extends P; Q and R carry Tagged. Index pByTitle on
 * P(title). Seed: p1 (P) and c1 (C), both secret s and title t, owners u1 and u2, each -ref-> q1; q1 (Q) and r1 (R), both tag g.
 */
class ExactFx
{
    public static readonly Tagged = 'Tagged';
    public static readonly P = 'P';
    public static readonly C = 'C';
    public static readonly Q = 'Q';
    public static readonly R = 'R';
    public static readonly Tag = 'tag';
    public static readonly Secret = 'secret';
    public static readonly Title = 'title';
    public static readonly Owner = 'owner';
    public static readonly Ref = 'ref';
    public static readonly PByTitle = 'pByTitle';
    public static readonly P1 = 'p1';
    public static readonly C1 = 'c1';
    public static readonly Q1 = 'q1';
    public static readonly R1 = 'r1';
    public static readonly S = 's';
    public static readonly T = 't';
    public static readonly G = 'g';
    public static readonly U1 = 'u1';
    public static readonly U2 = 'u2';
    public static readonly X = 'x';
    public static readonly Created = 'n';
    public static readonly Other = 'm';
    public static readonly FirstPlaced = 'c0';
    public static readonly Unknown = 'Nope';
    public static readonly UnknownMember = 'nope';
    public static readonly Column = 'n';
    public static readonly ValueColumn = 'x';
    public static readonly ReturnSecret = 'MATCH (n:P) RETURN n, n.secret AS x';
    public static readonly WhereSecret = "MATCH (n:P) WHERE n.secret = 's' RETURN n";
    public static readonly SeekTitle = "MATCH (n:P) WHERE n.title = 't' RETURN n";
    public static readonly ReturnTag = 'MATCH (n:Tagged) RETURN n, n.tag AS x';
    public static readonly SetSecretP = "MATCH (n:P {owner: 'u1'}) SET n.secret = 'x'";
    public static readonly SetSecretC = "MATCH (n:C) SET n.secret = 'x'";
    public static readonly CreateTitled = "CREATE (n:P {title: 'a'})";
    public static readonly CreateOwned = "CREATE (n:P {title: 'a', owner: 'u1'})";
    public static readonly DetachTitled = "MATCH (n:P {title: 't'}) DETACH DELETE n";
    public static readonly IndexSeek = /IndexSeek\(pByTitle\)/;
    public static readonly LabelScan = /LabelScan/;

    public static Open(): Promise<F>
    {
        return F.Open(
            [
                F.Aspect(ExactFx.Tagged, [F.Text(ExactFx.Tag)]),
                F.Concept(ExactFx.Q, [], null, [ExactFx.Tagged]),
                F.Concept(ExactFx.R, [], null, [ExactFx.Tagged]),
                F.Concept(ExactFx.P, [F.Text(ExactFx.Secret), F.Text(ExactFx.Title), F.Text(ExactFx.Owner), F.Rel(ExactFx.Ref, [ExactFx.Q])]),
                F.Concept(ExactFx.C, [], ExactFx.P),
            ],
            [
                F.Node(ExactFx.Q1, ExactFx.Q, { tag: ExactFx.G }),
                F.Node(ExactFx.R1, ExactFx.R, { tag: ExactFx.G }),
                F.Node(ExactFx.P1, ExactFx.P, { secret: ExactFx.S, title: ExactFx.T, owner: ExactFx.U1 }, [[ExactFx.Ref, ExactFx.Q1]]),
                F.Node(ExactFx.C1, ExactFx.C, { secret: ExactFx.S, title: ExactFx.T, owner: ExactFx.U2 }, [[ExactFx.Ref, ExactFx.Q1]]),
            ],
            [{ Name: ExactFx.PByTitle, On: ExactFx.P, Members: [ExactFx.Title] }]);
    }

    public static Set(...members: string[]): ReadonlySet<string>
    {
        return new Set(members);
    }

    /** Hides `members` on instances of exactly `key` (and nothing inherited). */
    public static HiddenExact(key: string, ...members: string[]): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, HiddenExact: new Map([[key, ExactFx.Set(...members)]]) });
    }

    public static Writes(key: string, rules: IWriteRules, extra: Partial<IAccessScopeOptions> = {}): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[key, rules]]), ...extra });
    }

    public static Exact(readOnly: IReadOnlyMembers): AccessScope
    {
        return ExactFx.Writes(ExactFx.P, { ReadOnlyExact: readOnly });
    }

    public static async Reading<T>(fx: F, scope: AccessScope, work: (reader: GraphReader) => Promise<T>): Promise<T>
    {
        const reader = await fx.Engine.BeginRead(scope);
        try
        {
            return await work(reader);
        }
        finally
        {
            reader.dispose();
        }
    }

    /** Each id with its `x` column (Plain values), in row order. */
    public static async Pairs(fx: F, text: string, scope: AccessScope): Promise<[unknown, unknown][]>
    {
        return (await fx.Rows(text, scope)).map(r => [r.get(ExactFx.Column), r.get(ExactFx.ValueColumn)]);
    }

    /** Commits `build` under `scope`; resolves with the AccessError code, or undefined when it committed. */
    public static async Commit(fx: F, scope: AccessScope, build: (t: GraphTransaction) => void): Promise<AccessErrorCode | undefined>
    {
        const t = await fx.Engine.Begin(scope);
        try
        {
            build(t);
            await t.Commit();
            return undefined;
        }
        catch (error)
        {
            if (error instanceof AccessError)
            {
                return error.Code;
            }
            throw error;
        }
        finally
        {
            t.dispose();
        }
    }

    /** Runs the Cypher write under `scope`; resolves with the AccessError code it was denied with, or undefined. */
    public static async Query(fx: F, scope: AccessScope, text: string, placement: INodePlacement = new OwnerDefaultPlacement()): Promise<AccessErrorCode | undefined>
    {
        try
        {
            await W.Write(fx, text, { Scope: scope, Placement: placement });
            return undefined;
        }
        catch (error)
        {
            if (error instanceof CypherWriteError && error.cause instanceof AccessError)
            {
                return error.cause.Code;
            }
            throw error;
        }
    }

    public static async Rejected(fx: F, scope: AccessScope, name: string): Promise<void>
    {
        await assert.rejects(fx.Engine.BeginRead(scope),
            (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes(name));
        await assert.rejects(fx.Engine.Begin(scope),
            (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes(name));
    }

    public static CreateWith(concept: string, member: string, value: CellValue, publicId: string = ExactFx.Created): (t: GraphTransaction) => void
    {
        return t =>
        {
            t.CreateNode(publicId, concept);
            t.SetProperty(publicId, member, value);
        };
    }
}

describe('exact-concept Hidden and ReadOnly member sets (R94)', () =>
{
    let fx: F;
    beforeEach(async () => { fx = await ExactFx.Open(); });
    afterEach(async () => { await fx.dispose(); });

    test('exact hidden applies to the key concept only', async () =>
    {
        const scope = ExactFx.HiddenExact(ExactFx.P, ExactFx.Secret, ExactFx.Ref);
        assert.equal(scope.ReadsUnrestricted, false);
        await ExactFx.Reading(fx, scope, async reader =>
        {
            assert.deepEqual([...reader.HiddenMembers(ExactFx.P)].sort(), [ExactFx.Ref, ExactFx.Secret]);
            assert.equal(reader.HiddenMembers(ExactFx.C).size, 0);
            assert.equal(await reader.GetProperty(ExactFx.P1, ExactFx.Secret), null);
            assert.equal(await reader.GetProperty(ExactFx.C1, ExactFx.Secret), ExactFx.S);
            assert.equal((await reader.ReadNode(ExactFx.P1))!.Properties.has(ExactFx.Secret), false);
            assert.equal((await reader.ReadNode(ExactFx.C1))!.Properties.get(ExactFx.Secret), ExactFx.S);
            const scanned: string[] = [];
            for await (const row of reader.ScanConcept(ExactFx.P, ExactFx.Secret))
            {
                scanned.push(row.PublicId);
            }
            assert.deepEqual(scanned, [ExactFx.C1]);
            // The relationship is a member of its source: hidden on p1's edges only, in both directions.
            assert.deepEqual(await reader.Links(ExactFx.P1, EdgeDirection.Out), []);
            assert.deepEqual(await reader.Neighbors(ExactFx.P1, ExactFx.Ref, EdgeDirection.Out), []);
            assert.deepEqual(await reader.Neighbors(ExactFx.C1, ExactFx.Ref, EdgeDirection.Out), [ExactFx.Q1]);
            assert.deepEqual(await reader.Neighbors(ExactFx.Q1, ExactFx.Ref, EdgeDirection.In), [ExactFx.C1]);
            assert.deepEqual((await reader.Links(ExactFx.Q1, EdgeDirection.In)).map(l => l.PublicId), [ExactFx.C1]);
        });
    });

    test('exact hidden ignores aspects', async () =>
    {
        // Keyed on Q, the set applies to Q's own nodes: R carries the same aspect member and keeps it.
        assert.deepEqual(await ExactFx.Pairs(fx, ExactFx.ReturnTag, ExactFx.HiddenExact(ExactFx.Q, ExactFx.Tag)), [[ExactFx.Q1, null], [ExactFx.R1, ExactFx.G]]);
        // The inherited set on the aspect hides it on every carrier.
        const inherited = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[ExactFx.Tagged, ExactFx.Set(ExactFx.Tag)]]) });
        assert.deepEqual(await ExactFx.Pairs(fx, ExactFx.ReturnTag, inherited), [[ExactFx.Q1, null], [ExactFx.R1, null]]);
        // An aspect is never a node's own concept: an exact set keyed on one is refused rather than inert.
        await ExactFx.Rejected(fx, ExactFx.HiddenExact(ExactFx.Tagged, ExactFx.Tag), ExactFx.Tagged);
    });

    test('exact hidden through cypher return and where', async () =>
    {
        const scope = ExactFx.HiddenExact(ExactFx.P, ExactFx.Secret);
        assert.deepEqual(await ExactFx.Pairs(fx, ExactFx.ReturnSecret, scope), [[ExactFx.P1, null], [ExactFx.C1, ExactFx.S]]);
        assert.deepEqual(await fx.Column(ExactFx.WhereSecret, ExactFx.Column, scope), [ExactFx.C1]);
        assert.deepEqual(await fx.Column(ExactFx.WhereSecret, ExactFx.Column), [ExactFx.P1, ExactFx.C1]);
        // An index over an exactly hidden member is ruled out at plan time, as for Hidden, and the rows agree.
        const title = ExactFx.HiddenExact(ExactFx.P, ExactFx.Title);
        const cypher = new CypherEngine(fx.Engine);
        assert.match(cypher.Explain(ExactFx.SeekTitle), ExactFx.IndexSeek);
        assert.doesNotMatch(cypher.Explain(ExactFx.SeekTitle, title), ExactFx.IndexSeek);
        assert.match(cypher.Explain(ExactFx.SeekTitle, title), ExactFx.LabelScan);
        assert.deepEqual(await fx.Column(ExactFx.SeekTitle, ExactFx.Column, title), [ExactFx.C1]);
        await ExactFx.Reading(fx, title, async reader =>
        {
            const sought: string[] = [];
            for await (const id of reader.SeekIndex(ExactFx.PByTitle, { Prefix: [ExactFx.T] }))
            {
                sought.push(id);
            }
            assert.deepEqual(sought, [ExactFx.C1]);
        });
    });

    test('exact hidden write is HiddenMember', async () =>
    {
        const scope = ExactFx.HiddenExact(ExactFx.P, ExactFx.Secret, ExactFx.Ref);
        assert.equal(await ExactFx.Commit(fx, scope, t => t.SetProperty(ExactFx.P1, ExactFx.Secret, ExactFx.X)), AccessErrorCode.HiddenMember);
        assert.equal(await ExactFx.Commit(fx, scope, t => t.Unlink(ExactFx.P1, ExactFx.Ref, ExactFx.Q1)), AccessErrorCode.HiddenMember);
        assert.equal(await ExactFx.Commit(fx, scope, ExactFx.CreateWith(ExactFx.P, ExactFx.Secret, ExactFx.X)), AccessErrorCode.HiddenMember);
        assert.equal(await ExactFx.Query(fx, scope, ExactFx.SetSecretP), AccessErrorCode.HiddenMember);
        assert.equal(await ExactFx.Commit(fx, scope, t => t.SetProperty(ExactFx.C1, ExactFx.Secret, ExactFx.X)), undefined);
        assert.equal(await ExactFx.Commit(fx, scope, t => t.Unlink(ExactFx.C1, ExactFx.Ref, ExactFx.Q1)), undefined);
        assert.equal(await ExactFx.Commit(fx, scope, ExactFx.CreateWith(ExactFx.C, ExactFx.Secret, ExactFx.X)), undefined);
        assert.equal(await ExactFx.Query(fx, scope, ExactFx.SetSecretC), undefined);
    });

    test('exact read-only create vs update', async () =>
    {
        const scope = ExactFx.Exact({ Create: ExactFx.Set(ExactFx.Owner), Update: ExactFx.Set(ExactFx.Title) });
        assert.equal(scope.WritesUnrestricted, false);
        assert.equal(await ExactFx.Commit(fx, scope, ExactFx.CreateWith(ExactFx.P, ExactFx.Owner, ExactFx.U2)), AccessErrorCode.MemberReadOnly);
        assert.equal(await ExactFx.Commit(fx, scope, ExactFx.CreateWith(ExactFx.P, ExactFx.Title, ExactFx.X)), undefined);
        assert.equal(await ExactFx.Commit(fx, scope, ExactFx.CreateWith(ExactFx.C, ExactFx.Owner, ExactFx.U2, ExactFx.Other)), undefined);
        assert.equal(await ExactFx.Commit(fx, scope, t => t.SetProperty(ExactFx.P1, ExactFx.Title, ExactFx.X)), AccessErrorCode.MemberReadOnly);
        assert.equal(await ExactFx.Commit(fx, scope, t => t.SetProperty(ExactFx.P1, ExactFx.Owner, ExactFx.U2)), undefined);
        assert.equal(await ExactFx.Commit(fx, scope, t => t.SetProperty(ExactFx.C1, ExactFx.Title, ExactFx.X)), undefined);
        assert.equal(await ExactFx.Query(fx, scope, ExactFx.CreateOwned), AccessErrorCode.MemberReadOnly);
        // Read-only stays readable.
        await ExactFx.Reading(fx, scope, async reader => { assert.equal(await reader.GetProperty(ExactFx.P1, ExactFx.Title), ExactFx.T); });
    });

    test('inherited and exact union', async () =>
    {
        const hidden = AccessScope.Build({
            Default: AccessDefault.Allow,
            Hidden: new Map([[ExactFx.P, ExactFx.Set(ExactFx.Title)]]),
            HiddenExact: new Map([[ExactFx.P, ExactFx.Set(ExactFx.Secret)]]),
        });
        await ExactFx.Reading(fx, hidden, async reader =>
        {
            assert.deepEqual([...reader.HiddenMembers(ExactFx.P)].sort(), [ExactFx.Secret, ExactFx.Title]);
            assert.deepEqual([...reader.HiddenMembers(ExactFx.C)], [ExactFx.Title]);
            assert.deepEqual([...(await reader.ReadNode(ExactFx.P1))!.Properties.keys()], [ExactFx.Owner]);
            assert.deepEqual([...(await reader.ReadNode(ExactFx.C1))!.Properties.keys()], [ExactFx.Secret, ExactFx.Owner]);
        });
        const readOnly = ExactFx.Writes(ExactFx.P, { ReadOnly: { Update: ExactFx.Set(ExactFx.Title) }, ReadOnlyExact: { Update: ExactFx.Set(ExactFx.Owner) } });
        assert.equal(await ExactFx.Commit(fx, readOnly, t => t.SetProperty(ExactFx.P1, ExactFx.Title, ExactFx.X)), AccessErrorCode.MemberReadOnly);
        assert.equal(await ExactFx.Commit(fx, readOnly, t => t.SetProperty(ExactFx.P1, ExactFx.Owner, ExactFx.X)), AccessErrorCode.MemberReadOnly);
        assert.equal(await ExactFx.Commit(fx, readOnly, t => t.SetProperty(ExactFx.C1, ExactFx.Title, ExactFx.X)), AccessErrorCode.MemberReadOnly);
        assert.equal(await ExactFx.Commit(fx, readOnly, t => t.SetProperty(ExactFx.C1, ExactFx.Owner, ExactFx.X)), undefined);
        // An exact set on an ancestor's entry never reaches the subconcept, even beside the subconcept's own entry.
        const both = AccessScope.Build({
            Default: AccessDefault.Allow,
            Writes: new Map<string, IWriteRules>([[ExactFx.P, { ReadOnlyExact: { Update: ExactFx.Set(ExactFx.Owner) } }], [ExactFx.C, { ReadOnlyExact: { Update: ExactFx.Set(ExactFx.Secret) } }]]),
        });
        assert.equal(await ExactFx.Commit(fx, both, t => t.SetProperty(ExactFx.C1, ExactFx.Owner, ExactFx.X)), undefined);
        assert.equal(await ExactFx.Commit(fx, both, t => t.SetProperty(ExactFx.C1, ExactFx.Secret, ExactFx.X)), AccessErrorCode.MemberReadOnly);
        assert.equal(await ExactFx.Commit(fx, both, t => t.SetProperty(ExactFx.P1, ExactFx.Secret, ExactFx.X)), undefined);
    });

    test('validator rejects aspect and unknown keys for exact sets', async () =>
    {
        await ExactFx.Rejected(fx, ExactFx.HiddenExact(ExactFx.Tagged, ExactFx.Tag), ExactFx.Tagged);
        await ExactFx.Rejected(fx, ExactFx.HiddenExact(ExactFx.Unknown), ExactFx.Unknown);
        await ExactFx.Rejected(fx, ExactFx.HiddenExact(ExactFx.P, ExactFx.UnknownMember), ExactFx.UnknownMember);
        await ExactFx.Rejected(fx, ExactFx.Writes(ExactFx.Tagged, { ReadOnlyExact: { Create: ExactFx.Set(ExactFx.Tag) } }), ExactFx.Tagged);
        await ExactFx.Rejected(fx, ExactFx.Writes(ExactFx.P, { ReadOnlyExact: { Update: ExactFx.Set(ExactFx.UnknownMember) } }), ExactFx.UnknownMember);
        await ExactFx.Rejected(fx, ExactFx.Writes(ExactFx.P, { ReadOnlyExact: { Create: ExactFx.Set(ExactFx.UnknownMember) } }), ExactFx.UnknownMember);
        // The inherited ReadOnly on an aspect key stays valid.
        await ExactFx.Reading(fx, ExactFx.Writes(ExactFx.Tagged, { ReadOnly: { Create: ExactFx.Set(ExactFx.Tag) } }), async () => undefined);
        // Build checks the exact read-only shape as it does ReadOnly's.
        assert.throws(() => ExactFx.Exact(ExactFx.Set(ExactFx.Owner) as unknown as IReadOnlyMembers), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
        assert.throws(() => ExactFx.Exact({ Create: [ExactFx.Owner] as unknown as ReadonlySet<string> }), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
    });

    test('Build copies and freezes the exact sets', async () =>
    {
        const members = new Set([ExactFx.Secret]);
        const create = new Set([ExactFx.Owner]);
        const scope = AccessScope.Build({ Default: AccessDefault.Allow, HiddenExact: new Map([[ExactFx.P, members]]), Writes: new Map([[ExactFx.P, { ReadOnlyExact: { Create: create } }]]) });
        members.clear();
        create.clear();
        assert.deepEqual([...scope.HiddenExact.get(ExactFx.P)!], [ExactFx.Secret]);
        assert.deepEqual([...scope.Writes.get(ExactFx.P)!.ReadOnlyExact!.Create!], [ExactFx.Owner]);
        assert.ok(Object.isFrozen(scope.Writes.get(ExactFx.P)!.ReadOnlyExact));
        assert.equal(AccessScope.System.HiddenExact.size, 0);
        assert.equal(await ExactFx.Commit(fx, scope, t => t.SetProperty(ExactFx.P1, ExactFx.Secret, ExactFx.X)), AccessErrorCode.HiddenMember);
    });

    test('default exempt from exact read-only and exact hidden', async () =>
    {
        const scope = AccessScope.Build({
            Default: AccessDefault.Allow,
            HiddenExact: new Map([[ExactFx.P, ExactFx.Set(ExactFx.Owner)]]),
            Writes: new Map([[ExactFx.P, { ReadOnlyExact: { Create: ExactFx.Set(ExactFx.Owner), Update: ExactFx.Set(ExactFx.Owner, ExactFx.Ref) } }]]),
        });
        // Hidden and read-only together: the placed default is exempt, the query's own value is not.
        const placement = new OwnerDefaultPlacement();
        assert.equal(await ExactFx.Query(fx, scope, ExactFx.CreateTitled, placement), undefined);
        await ExactFx.Reading(fx, AccessScope.System, async reader => { assert.equal(await reader.GetProperty(ExactFx.FirstPlaced, ExactFx.Owner), ExactFx.U2); });
        assert.equal(await ExactFx.Query(fx, scope, ExactFx.CreateOwned, placement), AccessErrorCode.HiddenMember);
        // Read-only alone.
        const readOnly = ExactFx.Exact({ Create: ExactFx.Set(ExactFx.Owner) });
        assert.equal(await ExactFx.Query(fx, readOnly, ExactFx.CreateTitled, placement), undefined);
        assert.equal(await ExactFx.Query(fx, readOnly, ExactFx.CreateOwned, placement), AccessErrorCode.MemberReadOnly);
        assert.equal(await ExactFx.Commit(fx, scope, t =>
        {
            t.CreateNode(ExactFx.Created, ExactFx.P);
            t.SetDefault(ExactFx.Created, ExactFx.Owner, ExactFx.U2);
        }), undefined);
        assert.equal(await ExactFx.Commit(fx, scope, t => t.SetDefault(ExactFx.P1, ExactFx.Owner, ExactFx.U2)), AccessErrorCode.HiddenMember);
        // The unlink a DETACH DELETE implies is governed by the Delete rule, not by the exact read-only set.
        assert.equal(await ExactFx.Commit(fx, scope, t => t.Unlink(ExactFx.P1, ExactFx.Ref, ExactFx.Q1)), AccessErrorCode.MemberReadOnly);
        assert.equal(await ExactFx.Query(fx, scope, ExactFx.DetachTitled), undefined);
        await ExactFx.Reading(fx, AccessScope.System, async reader => { assert.equal(await reader.ReadNode(ExactFx.P1), undefined); });
    });
});
