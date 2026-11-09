import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccessError, AccessErrorCode } from '../AccessError.js';
import { AccessDefault, AccessScope, type IWriteRules } from '../AccessScope.js';
import { CatalogError, CatalogErrorCode } from '../../catalog/CatalogError.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { Compare, CompareOp, ConceptIs, Not, Or, type Predicate, PredicateKind, Related } from '../../predicate/Predicate.js';
import { PredicateCodec } from '../../predicate/PredicateCodec.js';
import { CypherWriteError } from '../../cypher/CypherError.js';
import { CypherFixture as F } from '../../cypher/tests/CypherFixture.js';
import { WriteFixture as W } from '../../cypher/tests/WriteFixture.js';
import { GuidPlacement } from '../../cypher/write/NodePlacement.js';

/**
 * Aspect Tagged { tag? }; P { owner?, title?, ref -> Q, R }; C extends P; Q and R carry Tagged { name? }. Index
 * pByTitle on P(title). Seed: p1 (P, owner u1), p2 (P, owner u2) -ref-> q1, c1 (C, owner u2), all titled t; q1 (Q), r1 (R).
 */
class ConceptFx
{
    public static readonly Tagged = 'Tagged';
    public static readonly P = 'P';
    public static readonly C = 'C';
    public static readonly Q = 'Q';
    public static readonly R = 'R';
    public static readonly Tag = 'tag';
    public static readonly Owner = 'owner';
    public static readonly Title = 'title';
    public static readonly Name = 'name';
    public static readonly PByTitle = 'pByTitle';
    public static readonly Ref = 'ref';
    public static readonly AllP = 'MATCH (n:P) RETURN n';
    public static readonly CreateP1 = "CREATE (n:P {owner: 'u1'})";
    public static readonly CreateP2 = "CREATE (n:P {owner: 'u2'})";
    public static readonly CreateC2 = "CREATE (n:C {owner: 'u2'})";
    public static readonly DeleteU2 = "MATCH (n:P {owner: 'u2'}) DETACH DELETE n";
    public static readonly DeleteU1 = "MATCH (n:P {owner: 'u1'}) DETACH DELETE n";
    public static readonly DeleteC = 'MATCH (n:C) DETACH DELETE n';
    public static readonly WhereMessage = 'Index Where must be node-local';
    public static readonly P1 = 'p1';
    public static readonly P2 = 'p2';
    public static readonly C1 = 'c1';
    public static readonly Q1 = 'q1';
    public static readonly R1 = 'r1';
    public static readonly U1 = 'u1';
    public static readonly U2 = 'u2';
    public static readonly T = 't';
    public static readonly Created = 'n';
    public static readonly Unknown = 'Nope';
    public static readonly SeekQuery = "MATCH (n:P {title: 't'}) RETURN n";
    public static readonly SeekColumn = 'n';
    public static readonly All = [ConceptFx.P1, ConceptFx.P2, ConceptFx.C1, ConceptFx.Q1, ConceptFx.R1];

    public static Open(where?: Predicate): Promise<F>
    {
        return F.Open(
            [
                F.Aspect(ConceptFx.Tagged, [F.Text(ConceptFx.Tag)]),
                F.Concept(ConceptFx.P, [F.Text(ConceptFx.Owner), F.Text(ConceptFx.Title), F.Rel(ConceptFx.Ref, [ConceptFx.Q, ConceptFx.R])]),
                F.Concept(ConceptFx.C, [], ConceptFx.P),
                F.Concept(ConceptFx.Q, [F.Text(ConceptFx.Name)], null, [ConceptFx.Tagged]),
                F.Concept(ConceptFx.R, [F.Text(ConceptFx.Name)], null, [ConceptFx.Tagged]),
            ],
            [
                F.Node(ConceptFx.P1, ConceptFx.P, { owner: ConceptFx.U1, title: ConceptFx.T }),
                F.Node(ConceptFx.P2, ConceptFx.P, { owner: ConceptFx.U2, title: ConceptFx.T }, [[ConceptFx.Ref, ConceptFx.Q1]]),
                F.Node(ConceptFx.C1, ConceptFx.C, { owner: ConceptFx.U2, title: ConceptFx.T }),
                F.Node(ConceptFx.Q1, ConceptFx.Q),
                F.Node(ConceptFx.R1, ConceptFx.R),
            ],
            [{ Name: ConceptFx.PByTitle, On: ConceptFx.P, Members: [ConceptFx.Title], ...(where === undefined ? {} : { Where: where }) }]);
    }

    public static Rows(key: string, predicate: Predicate): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[key, predicate]]) });
    }

    public static Writes(key: string, rules: IWriteRules): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[key, rules]]) });
    }

    /** `Or(Not(ConceptIs P), owner = 'u1')`: the exact-concept guard a server compiles an entry on P to. */
    public static Guarded(): Predicate
    {
        return new Or([new Not(new ConceptIs(ConceptFx.P)), new Compare(ConceptFx.Owner, CompareOp.Eq, ConceptFx.U1)]);
    }

    /** The seed nodes visible under `scope`, in seed order. */
    public static async Visible(fx: F, scope: AccessScope): Promise<string[]>
    {
        const reader = await fx.Engine.BeginRead(scope);
        try
        {
            const out: string[] = [];
            for (const id of ConceptFx.All)
            {
                if ((await reader.ReadNode(id)) !== undefined)
                {
                    out.push(id);
                }
            }
            return out;
        }
        finally
        {
            reader.dispose();
        }
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
    public static async Query(fx: F, scope: AccessScope, text: string): Promise<AccessErrorCode | undefined>
    {
        try
        {
            await W.Write(fx, text, { Scope: scope, Placement: new GuidPlacement() });
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

    /** The guard on P's Create and Delete rules, as the server compiles them. */
    public static GuardedWrites(): AccessScope
    {
        return ConceptFx.Writes(ConceptFx.P, { Create: ConceptFx.Guarded(), Delete: ConceptFx.Guarded() });
    }

    public static async Seek(fx: F, scope: AccessScope): Promise<string[]>
    {
        const reader = await fx.Engine.BeginRead(scope);
        try
        {
            const out: string[] = [];
            for await (const id of reader.SeekIndex(ConceptFx.PByTitle, { Prefix: [ConceptFx.T] }))
            {
                out.push(id);
            }
            return out;
        }
        finally
        {
            reader.dispose();
        }
    }

    public static async Rejected(fx: F, scope: AccessScope, name: string): Promise<void>
    {
        await assert.rejects(fx.Engine.BeginRead(scope),
            (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes(name));
        await assert.rejects(fx.Engine.Begin(scope),
            (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes(name));
    }
}

describe('ConceptIs predicate (R93)', () =>
{
    let fx: F;
    beforeEach(async () => { fx = await ConceptFx.Open(); });
    afterEach(async () => { await fx.dispose(); });

    test('concept is matches only the exact concept', async () =>
    {
        const p = new ConceptIs(ConceptFx.P);
        assert.equal(p.Kind, PredicateKind.ConceptIs);
        assert.equal(p.Concept, ConceptFx.P);
        assert.equal(p.IsNodeLocal, false);
        assert.deepEqual(await ConceptFx.Visible(fx, ConceptFx.Rows(ConceptFx.P, p)), [ConceptFx.P1, ConceptFx.P2, ConceptFx.Q1, ConceptFx.R1]);
        assert.deepEqual(await ConceptFx.Visible(fx, ConceptFx.Rows(ConceptFx.P, new ConceptIs(ConceptFx.C))), [ConceptFx.C1, ConceptFx.Q1, ConceptFx.R1]);
        assert.deepEqual(await ConceptFx.Visible(fx, ConceptFx.Rows(ConceptFx.P, new Not(p))), [ConceptFx.C1, ConceptFx.Q1, ConceptFx.R1]);
    });

    test('concept is ignores aspects', async () =>
    {
        // Keyed on the aspect, the entry applies to Q and R; ConceptIs still sees each node's own concept only.
        assert.deepEqual(await ConceptFx.Visible(fx, ConceptFx.Rows(ConceptFx.Tagged, new ConceptIs(ConceptFx.Q))), [ConceptFx.P1, ConceptFx.P2, ConceptFx.C1, ConceptFx.Q1]);
        // An aspect is never a node's own concept: naming one is refused rather than always false.
        await ConceptFx.Rejected(fx, ConceptFx.Rows(ConceptFx.Tagged, new ConceptIs(ConceptFx.Tagged)), ConceptFx.Tagged);
    });

    test('guarded entry applies only to its own concept', async () =>
    {
        assert.deepEqual(await ConceptFx.Visible(fx, ConceptFx.Rows(ConceptFx.P, ConceptFx.Guarded())), [ConceptFx.P1, ConceptFx.C1, ConceptFx.Q1, ConceptFx.R1]);
    });

    test('concept is in a write predicate', async () =>
    {
        const scope = ConceptFx.Writes(ConceptFx.P, { Create: new ConceptIs(ConceptFx.C), Update: ConceptFx.Guarded(), Delete: new ConceptIs(ConceptFx.C) });
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.SetProperty(ConceptFx.P2, ConceptFx.Title, ConceptFx.U1)), AccessErrorCode.UpdateDenied);
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.SetProperty(ConceptFx.P1, ConceptFx.Title, ConceptFx.U1)), undefined);
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.SetProperty(ConceptFx.C1, ConceptFx.Title, ConceptFx.U1)), undefined);
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.CreateNode(ConceptFx.Created, ConceptFx.P)), AccessErrorCode.CreateDenied);
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.CreateNode(ConceptFx.Created, ConceptFx.C)), undefined);
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.DeleteNode(ConceptFx.P1)), AccessErrorCode.DeleteDenied);
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.DeleteNode(ConceptFx.C1)), undefined);
    });

    test('guarded Create and Delete rules through the engine', async () =>
    {
        const scope = ConceptFx.GuardedWrites();
        const create = (concept: string, owner: string) => (t: GraphTransaction) =>
        {
            t.CreateNode(ConceptFx.Created, concept);
            t.SetProperty(ConceptFx.Created, ConceptFx.Owner, owner);
        };
        assert.equal(await ConceptFx.Commit(fx, scope, create(ConceptFx.P, ConceptFx.U2)), AccessErrorCode.CreateDenied);
        assert.equal(await ConceptFx.Commit(fx, scope, create(ConceptFx.P, ConceptFx.U1)), undefined);
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.DeleteNode(ConceptFx.Created)), undefined);
        assert.equal(await ConceptFx.Commit(fx, scope, create(ConceptFx.C, ConceptFx.U2)), undefined);
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.DeleteNode(ConceptFx.P2)), AccessErrorCode.DeleteDenied);
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.DeleteNode(ConceptFx.P1)), undefined);
        assert.equal(await ConceptFx.Commit(fx, scope, t => t.DeleteNode(ConceptFx.C1)), undefined);
        assert.deepEqual(await ConceptFx.Visible(fx, AccessScope.System), [ConceptFx.P2, ConceptFx.Q1, ConceptFx.R1]);
    });

    test('guarded Create and Delete rules through Cypher', async () =>
    {
        const scope = ConceptFx.GuardedWrites();
        assert.equal(await ConceptFx.Query(fx, scope, ConceptFx.CreateP2), AccessErrorCode.CreateDenied);
        assert.equal(await ConceptFx.Query(fx, scope, ConceptFx.CreateP1), undefined);
        assert.equal(await ConceptFx.Query(fx, scope, ConceptFx.CreateC2), undefined);
        // Matches p2 (denied) and c1 and the created C: the whole write is refused.
        assert.equal(await ConceptFx.Query(fx, scope, ConceptFx.DeleteU2), AccessErrorCode.DeleteDenied);
        assert.equal(await ConceptFx.Query(fx, scope, ConceptFx.DeleteC), undefined);
        assert.equal(await ConceptFx.Query(fx, scope, ConceptFx.DeleteU1), undefined);
        assert.deepEqual(await fx.Column(ConceptFx.AllP, ConceptFx.SeekColumn), [ConceptFx.P2]);
    });

    test('concept is inside a Related target', async () =>
    {
        const toQ = ConceptFx.Rows(ConceptFx.P, new Related(ConceptFx.Ref, EdgeDirection.Out, new ConceptIs(ConceptFx.Q)));
        assert.deepEqual(await fx.Column(ConceptFx.AllP, ConceptFx.SeekColumn, toQ), [ConceptFx.P2]);
        const toR = ConceptFx.Rows(ConceptFx.P, new Related(ConceptFx.Ref, EdgeDirection.Out, new ConceptIs(ConceptFx.R)));
        assert.deepEqual(await fx.Column(ConceptFx.AllP, ConceptFx.SeekColumn, toR), []);
        await ConceptFx.Rejected(fx, ConceptFx.Rows(ConceptFx.P, new Related(ConceptFx.Ref, EdgeDirection.Out, new ConceptIs(ConceptFx.Unknown))), ConceptFx.Unknown);
    });

    test('unknown concept name is rejected by the validator', async () =>
    {
        await ConceptFx.Rejected(fx, ConceptFx.Rows(ConceptFx.P, new ConceptIs(ConceptFx.Unknown)), ConceptFx.Unknown);
        await ConceptFx.Rejected(fx, ConceptFx.Writes(ConceptFx.P, { Update: new Not(new ConceptIs(ConceptFx.Unknown)) }), ConceptFx.Unknown);
        await ConceptFx.Rejected(fx, ConceptFx.Writes(ConceptFx.P, { Create: new Or([new ConceptIs(ConceptFx.C), new ConceptIs(ConceptFx.Unknown)]) }), ConceptFx.Unknown);
    });

    test('concept is with an index seek', async () =>
    {
        assert.deepEqual(await ConceptFx.Seek(fx, AccessScope.System), [ConceptFx.P1, ConceptFx.P2, ConceptFx.C1]);
        assert.deepEqual(await ConceptFx.Seek(fx, ConceptFx.Rows(ConceptFx.P, ConceptFx.Guarded())), [ConceptFx.P1, ConceptFx.C1]);
        assert.deepEqual(await fx.Column(ConceptFx.SeekQuery, ConceptFx.SeekColumn, ConceptFx.Rows(ConceptFx.P, ConceptFx.Guarded())), [ConceptFx.P1, ConceptFx.C1]);
    });

    test('concept is in an index Where is refused, never dropped', async () =>
    {
        await assert.rejects(ConceptFx.Open(new ConceptIs(ConceptFx.C)),
            (e: unknown) => e instanceof CatalogError && e.Code === CatalogErrorCode.InvalidMember && e.message.includes(ConceptFx.WhereMessage) && e.message.includes(ConceptFx.PByTitle));
    });

    test('concept is round-trips through the codec', () =>
    {
        const json = PredicateCodec.ToJson(ConceptFx.Guarded());
        const back = PredicateCodec.FromJson(JSON.parse(JSON.stringify(json)));
        assert.deepEqual(PredicateCodec.ToJson(back), json);
        const concept = PredicateCodec.FromJson({ Kind: PredicateKind.ConceptIs, Concept: ConceptFx.P });
        assert.ok(concept instanceof ConceptIs);
        assert.equal(concept.Concept, ConceptFx.P);
        assert.throws(() => PredicateCodec.FromJson({ Kind: PredicateKind.ConceptIs }));
    });
});
