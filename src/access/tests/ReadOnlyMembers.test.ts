import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccessError, AccessErrorCode } from '../AccessError.js';
import { AccessDefault, AccessScope, type IReadOnlyMembers } from '../AccessScope.js';
import { FalsePredicate } from '../../predicate/Predicate.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import type { CellValue } from '../../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { CypherWriteError, CypherWriteErrorCode } from '../../cypher/CypherError.js';
import { CypherFixture as F } from '../../cypher/tests/CypherFixture.js';
import { WriteFixture as W, type IWriteOptions } from '../../cypher/tests/WriteFixture.js';
import type { INodePlace, INodePlacement } from '../../cypher/write/NodePlacement.js';

/** A placement handing out c0, c1, ... with no owner and an owner default (ruling R91). */
class OwnerPlacement implements INodePlacement
{
    private static readonly Prefix = 'c';
    private static readonly NoOwner = '';

    private count = 0;

    public constructor(private readonly owner: string)
    {
    }

    public Place(): INodePlace
    {
        return { PublicId: `${OwnerPlacement.Prefix}${this.count++}`, Owner: OwnerPlacement.NoOwner, Defaults: new Map<string, CellValue>([[RoFx.Owner, this.owner]]) };
    }
}

/**
 * Aspect Tagged { tag? }; Item { title?, owner?, assignee -> Person* }; Ticket extends Item; Person (carries
 * Tagged) { name? }. Seed: ticket k (owner u1, title x) -assignee-> p; person q. The scope marks Item's owner
 * and assignee read-only (ruling R92).
 */
class RoFx
{
    public static readonly Item = 'Item';
    public static readonly Ticket = 'Ticket';
    public static readonly Person = 'Person';
    public static readonly Title = 'title';
    public static readonly Owner = 'owner';
    public static readonly Assignee = 'assignee';
    public static readonly Name = 'name';
    public static readonly K = 'k';
    public static readonly P = 'p';
    public static readonly Q = 'q';
    public static readonly U1 = 'u1';
    public static readonly U2 = 'u2';
    public static readonly X = 'x';
    public static readonly Tagged = 'Tagged';
    public static readonly Tag = 'tag';
    public static readonly FirstPlaced = 'c0';
    public static readonly Created = 'n';
    public static readonly FirstSequenced = 'n0';
    public static readonly Unknown = 'nope';
    public static readonly MergeOnMatchOwner = "MERGE (k:Ticket {title: 'x'}) ON MATCH SET k.owner = 'u2'";
    public static readonly MergeOnCreateOwner = "MERGE (k:Ticket {title: 'new'}) ON CREATE SET k.owner = 'u2'";
    public static readonly DetachPerson = "MATCH (:Ticket {title: 'x'})-[:assignee]->(p:Person) DETACH DELETE p";

    public static Open(): Promise<F>
    {
        return F.Open(
            [
                F.Aspect(RoFx.Tagged, [F.Text(RoFx.Tag)]),
                F.Concept(RoFx.Person, [F.Text(RoFx.Name)], null, [RoFx.Tagged]),
                F.Concept(RoFx.Item, [F.Text(RoFx.Title), F.Text(RoFx.Owner), F.Rel(RoFx.Assignee, [RoFx.Person])]),
                F.Concept(RoFx.Ticket, [], RoFx.Item),
            ],
            [
                F.Node(RoFx.K, RoFx.Ticket, { title: RoFx.X, owner: RoFx.U1 }, [[RoFx.Assignee, RoFx.P]]),
                F.Node(RoFx.P, RoFx.Person),
                F.Node(RoFx.Q, RoFx.Person),
            ]);
    }

    public static Scope(readOnly: readonly string[] = [RoFx.Owner, RoFx.Assignee]): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Item, { ReadOnly: RoFx.Both(readOnly) }]]) });
    }

    /** The same members read-only at create and at update. */
    public static Both(members: readonly string[]): IReadOnlyMembers
    {
        return { Create: new Set(members), Update: new Set(members) };
    }

    /** Item's read-only members: `create` checked on nodes the batch creates, `update` on existing nodes. */
    public static StageScope(create: readonly string[], update: readonly string[]): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Item, { ReadOnly: { Create: new Set(create), Update: new Set(update) } }]]) });
    }

    /** Item nodes may not be updated or appended to (ruling F-a: a delete-implied unlink ignores the source's Update and Append rules). */
    public static NoUpdateScope(): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Item, { Update: FalsePredicate.Instance, Append: FalsePredicate.Instance }]]) });
    }

    /** Item's owner and assignee read-only, and Item nodes may not be deleted. */
    public static NoDeleteScope(): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Item, { ReadOnly: RoFx.Both([RoFx.Owner, RoFx.Assignee]), Delete: FalsePredicate.Instance }]]) });
    }

    public static async Exists(fx: F, publicId: string): Promise<boolean>
    {
        const reader = await fx.Engine.BeginRead(AccessScope.System);
        try
        {
            return (await reader.ReadNode(publicId)) !== undefined;
        }
        finally
        {
            reader.dispose();
        }
    }

    /** Asserts the Cypher write is denied with MemberReadOnly naming `member` and committed nothing. */
    public static async DeniedQuery(fx: F, text: string, member: string, options: IWriteOptions = {}): Promise<void>
    {
        const head = await W.Head(fx);
        await assert.rejects(W.Write(fx, text, { Scope: RoFx.Scope(), ...options }),
            (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Denied
                && e.cause instanceof AccessError && e.cause.Code === AccessErrorCode.MemberReadOnly && e.cause.message.includes(member));
        assert.equal(await W.CommitsAfter(fx, head), 0);
    }

    /** Asserts the engine commit is denied with MemberReadOnly naming `member`. */
    public static async DeniedCommit(fx: F, build: (t: GraphTransaction) => void, member: string): Promise<void>
    {
        const t = await fx.Engine.Begin(RoFx.Scope());
        try
        {
            build(t);
            await assert.rejects(t.Commit(), (e: unknown) => e instanceof AccessError && e.Code === AccessErrorCode.MemberReadOnly && e.message.includes(member));
        }
        finally
        {
            t.dispose();
        }
    }

    public static async Read(fx: F, scope: AccessScope, publicId: string, member: string): Promise<unknown>
    {
        const reader = await fx.Engine.BeginRead(scope);
        try
        {
            return (await reader.ReadNode(publicId))?.Properties.get(member);
        }
        finally
        {
            reader.dispose();
        }
    }
}

describe('read-only write members (R92)', () =>
{
    let fx: F;
    beforeEach(async () => { fx = await RoFx.Open(); });
    afterEach(async () => { await fx.dispose(); });

    test('read-only member set is denied', async () =>
    {
        await RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}) SET k.owner = 'u2'", RoFx.Owner);
        await RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}) SET k.title = 'y', k.owner = 'u2'", RoFx.Owner);
        await RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}) REMOVE k.owner", RoFx.Owner);
        await RoFx.DeniedQuery(fx, "CREATE (n:Ticket {title: 'a', owner: 'u2'})", RoFx.Owner);
        await RoFx.DeniedQuery(fx, "CREATE (n:Ticket {title: 'a'}) SET n.owner = 'u2'", RoFx.Owner);
        await RoFx.DeniedCommit(fx, t => t.SetProperty(RoFx.K, RoFx.Owner, RoFx.U2), RoFx.Owner);
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.K, RoFx.Owner), RoFx.U1);
    });

    test('read-only relationship link denied', async () =>
    {
        await RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}), (q:Person) CREATE (k)-[:assignee]->(q)", RoFx.Assignee);
        await RoFx.DeniedQuery(fx, "CREATE (n:Ticket {title: 'a'})-[:assignee]->(m:Person)", RoFx.Assignee);
        // Relationship DELETE is not in the dialect; REMOVE / SET of a relationship member unlink (and relink).
        await RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}) REMOVE k.assignee", RoFx.Assignee);
        await RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}), (q:Person) SET k.assignee = q", RoFx.Assignee);
        await RoFx.DeniedCommit(fx, t => t.Link(RoFx.K, RoFx.Assignee, RoFx.Q), RoFx.Assignee);
        await RoFx.DeniedCommit(fx, t => t.Unlink(RoFx.K, RoFx.Assignee, RoFx.P), RoFx.Assignee);
        // A detach unlink is exempt only when the batch then deletes one of its ends.
        await RoFx.DeniedCommit(fx, t => t.DetachUnlink(RoFx.K, RoFx.Assignee, RoFx.P), RoFx.Assignee);
    });

    test('DETACH DELETE of the source of a read-only relationship is governed by Delete', async () =>
    {
        await assert.rejects(W.Write(fx, "MATCH (k:Ticket {title: 'x'}) DETACH DELETE k", { Scope: RoFx.NoDeleteScope() }),
            (e: unknown) => e instanceof CypherWriteError && e.cause instanceof AccessError && e.cause.Code === AccessErrorCode.DeleteDenied);
        await W.Write(fx, "MATCH (k:Ticket {title: 'x'}) DETACH DELETE k", { Scope: RoFx.Scope() });
        assert.equal(await RoFx.Exists(fx, RoFx.K), false);
    });

    test('DETACH DELETE of the target of a read-only relationship is governed by Delete', async () =>
    {
        await W.Write(fx, "MATCH (:Ticket {title: 'x'})-[:assignee]->(p:Person) DETACH DELETE p", { Scope: RoFx.NoDeleteScope() });
        assert.equal(await RoFx.Exists(fx, RoFx.P), false);
        assert.equal(await RoFx.Exists(fx, RoFx.K), true);
    });

    test('DETACH DELETE unlinks ignore the visible source Update rule (F-a)', async () =>
    {
        await W.Write(fx, RoFx.DetachPerson, { Scope: RoFx.NoUpdateScope() });
        assert.equal(await RoFx.Exists(fx, RoFx.P), false);
        assert.equal(await RoFx.Exists(fx, RoFx.K), true);
        const reader = await fx.Engine.BeginRead(AccessScope.System);
        try
        {
            assert.deepEqual(await reader.Neighbors(RoFx.K, RoFx.Assignee, EdgeDirection.Out), []);
        }
        finally
        {
            reader.dispose();
        }
        // An explicit unlink from the same source is still an append, and refused.
        const t = await fx.Engine.Begin(RoFx.NoUpdateScope());
        try
        {
            t.Unlink(RoFx.K, RoFx.Assignee, RoFx.Q);
            t.DetachUnlink(RoFx.K, RoFx.Assignee, RoFx.Q);
            await assert.rejects(t.Commit(), (e: unknown) => e instanceof AccessError && e.Code === AccessErrorCode.AppendDenied);
        }
        finally
        {
            t.dispose();
        }
    });

    test('read-only keyed on an aspect applies to the concepts carrying it', async () =>
    {
        const scope = AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Tagged, { ReadOnly: RoFx.Both([RoFx.Tag]) }]]) });
        await RoFx.DeniedQuery(fx, "MATCH (p:Person) SET p.tag = 't'", RoFx.Tag, { Scope: scope });
        await W.Write(fx, "MATCH (p:Person) SET p.name = 'n'", { Scope: scope });
    });

    test('read-only member still readable', async () =>
    {
        assert.equal(await RoFx.Read(fx, RoFx.Scope(), RoFx.K, RoFx.Owner), RoFx.U1);
        const r = await W.Write(fx, "MATCH (k:Ticket {title: 'x'})-[:assignee]->(p) SET k.title = 'y' RETURN k.owner AS o, count(p) AS c", { Scope: RoFx.Scope() });
        assert.deepEqual(r.Rows.map(row => [row.get('o'), row.get('c')]), [[RoFx.U1, 1n]]);
        assert.equal(await RoFx.Read(fx, RoFx.Scope(), RoFx.K, RoFx.Title), 'y');
    });

    test('default on a read-only member is allowed', async () =>
    {
        await W.Write(fx, "CREATE (n:Ticket {title: 'a'})", { Scope: RoFx.Scope(), Placement: new OwnerPlacement(RoFx.U2) });
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.FirstPlaced, RoFx.Owner), RoFx.U2);
        // The query's own value still wins over the default, and is then a read-only write.
        await RoFx.DeniedQuery(fx, "CREATE (n:Ticket {title: 'a', owner: 'u1'})", RoFx.Owner, { Placement: new OwnerPlacement(RoFx.U2) });
    });

    test('default on a hidden member is allowed', async () =>
    {
        const scope = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[RoFx.Item, new Set([RoFx.Owner])]]) });
        await W.Write(fx, "CREATE (n:Ticket {title: 'a'})", { Scope: scope, Placement: new OwnerPlacement(RoFx.U2) });
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.FirstPlaced, RoFx.Owner), RoFx.U2);
    });

    test('an engine default is exempt only on a node the batch creates', async () =>
    {
        const t = await fx.Engine.Begin(RoFx.Scope());
        t.CreateNode(RoFx.Created, RoFx.Ticket);
        t.SetDefault(RoFx.Created, RoFx.Owner, RoFx.U2);
        await t.Commit();
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.Created, RoFx.Owner), RoFx.U2);
        await RoFx.DeniedCommit(fx, tx => tx.SetDefault(RoFx.K, RoFx.Owner, RoFx.U2), RoFx.Owner);
    });

    test('read-only names must be members of their key', async () =>
    {
        await assert.rejects(fx.Engine.Begin(RoFx.Scope([RoFx.Unknown])),
            (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes(`${RoFx.Item}.${RoFx.Unknown}`));
        // A subconcept's member is not a member of the parent key.
        await assert.rejects(fx.Engine.Begin(AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Person, { ReadOnly: RoFx.Both([RoFx.Owner]) }]]) })),
            (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
    });

    test('Build copies the read-only sets', async () =>
    {
        const create = new Set([RoFx.Owner]);
        const update = new Set([RoFx.Title]);
        const scope = AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Item, { ReadOnly: { Create: create, Update: update } }]]) });
        create.clear();
        update.clear();
        const readOnly = scope.Writes.get(RoFx.Item)?.ReadOnly;
        assert.deepEqual([...(readOnly?.Create ?? [])], [RoFx.Owner]);
        assert.deepEqual([...(readOnly?.Update ?? [])], [RoFx.Title]);
        assert.ok(Object.isFrozen(readOnly));
    });

    test('Build refuses a read-only value of the wrong shape', () =>
    {
        const invalid = (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes(RoFx.Item);
        const build = (readOnly: unknown) => () => AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Item, { ReadOnly: readOnly as IReadOnlyMembers }]]) });
        // The pre-amendment shape: a bare Set.
        assert.throws(build(new Set([RoFx.Owner])), invalid);
        assert.throws(build({ Create: [RoFx.Owner] }), invalid);
        assert.throws(build({ Update: RoFx.Owner }), invalid);
        assert.throws(build(null), invalid);
        assert.doesNotThrow(build({}));
    });

    test('MERGE ON MATCH SET of an update-only read-only member is refused', async () =>
    {
        const scope = RoFx.StageScope([], [RoFx.Owner]);
        await RoFx.DeniedQuery(fx, RoFx.MergeOnMatchOwner, RoFx.Owner, { Scope: scope });
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.K, RoFx.Owner), RoFx.U1);
        // ON CREATE SET of the same member is a create: allowed.
        await W.Write(fx, RoFx.MergeOnCreateOwner, { Scope: scope });
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.FirstSequenced, RoFx.Owner), RoFx.U2);
    });

    test('delete then recreate in one batch is judged as a create', async () =>
    {
        const t = await fx.Engine.Begin(RoFx.StageScope([], [RoFx.Owner, RoFx.Assignee]));
        try
        {
            t.DeleteNode(RoFx.K);
            t.CreateNode(RoFx.K, RoFx.Ticket);
            t.SetProperty(RoFx.K, RoFx.Owner, RoFx.U2);
            await t.Commit();
        }
        finally
        {
            t.dispose();
        }
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.K, RoFx.Owner), RoFx.U2);
        // The same write without the recreate is an update, and refused.
        await RoFx.DeniedCommit(fx, tx => tx.SetProperty(RoFx.K, RoFx.Owner, RoFx.U1), RoFx.Owner);
    });

    test('read-only names on either stage must be members of their key', async () =>
    {
        for (const scope of [RoFx.StageScope([RoFx.Unknown], []), RoFx.StageScope([], [RoFx.Unknown])])
        {
            await assert.rejects(fx.Engine.Begin(scope),
                (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes(`${RoFx.Item}.${RoFx.Unknown}`));
        }
    });

    test('create-only member is settable on create', async () =>
    {
        const scope = RoFx.StageScope([], [RoFx.Owner, RoFx.Assignee]);
        await W.Write(fx, "CREATE (n:Ticket {title: 'a', owner: 'u2'})-[:assignee]->(m:Person)", { Scope: scope });
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.FirstSequenced, RoFx.Owner), RoFx.U2);
        const t = await fx.Engine.Begin(scope);
        try
        {
            t.CreateNode(RoFx.Created, RoFx.Ticket);
            t.SetProperty(RoFx.Created, RoFx.Owner, RoFx.U1);
            t.Link(RoFx.Created, RoFx.Assignee, RoFx.Q);
            await t.Commit();
        }
        finally
        {
            t.dispose();
        }
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.Created, RoFx.Owner), RoFx.U1);
    });

    test('create-only member is refused on update', async () =>
    {
        const scope = RoFx.StageScope([], [RoFx.Owner, RoFx.Assignee]);
        await RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}) SET k.owner = 'u2'", RoFx.Owner, { Scope: scope });
        await RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}) REMOVE k.assignee", RoFx.Assignee, { Scope: scope });
        await RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}), (q:Person) CREATE (k)-[:assignee]->(q)", RoFx.Assignee, { Scope: scope });
        // Other members of an existing node stay writable.
        await W.Write(fx, "MATCH (k:Ticket {title: 'x'}) SET k.title = 'y'", { Scope: scope });
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.K, RoFx.Owner), RoFx.U1);
    });

    test('update-only read-only member is refused on create but default still allowed', async () =>
    {
        const scope = RoFx.StageScope([RoFx.Owner], []);
        await RoFx.DeniedQuery(fx, "CREATE (n:Ticket {title: 'a', owner: 'u2'})", RoFx.Owner, { Scope: scope });
        await W.Write(fx, "CREATE (n:Ticket {title: 'a'})", { Scope: scope, Placement: new OwnerPlacement(RoFx.U2) });
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.FirstPlaced, RoFx.Owner), RoFx.U2);
        // Not read-only on update: an existing node's owner may change.
        await W.Write(fx, "MATCH (k:Ticket {title: 'x'}) SET k.owner = 'u2'", { Scope: scope });
        assert.equal(await RoFx.Read(fx, AccessScope.System, RoFx.K, RoFx.Owner), RoFx.U2);
    });
});
