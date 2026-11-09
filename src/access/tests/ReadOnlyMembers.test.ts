import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccessError, AccessErrorCode } from '../AccessError.js';
import { AccessDefault, AccessScope } from '../AccessScope.js';
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
 * Item { title?, owner?, assignee -> Person* }; Ticket extends Item; Person { name? }. Seed: ticket k (owner u1,
 * title x) -assignee-> p; person q. The scope marks Item's owner and assignee read-only (ruling R92).
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

    public static Open(): Promise<F>
    {
        return F.Open(
            [
                F.Concept(RoFx.Person, [F.Text(RoFx.Name)]),
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
        return AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Item, { ReadOnly: new Set(readOnly) }]]) });
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
        assert.equal(await RoFx.Read(fx, AccessScope.System, 'c0', RoFx.Owner), RoFx.U2);
        // The query's own value still wins over the default, and is then a read-only write.
        await RoFx.DeniedQuery(fx, "CREATE (n:Ticket {title: 'a', owner: 'u1'})", RoFx.Owner, { Placement: new OwnerPlacement(RoFx.U2) });
    });

    test('an engine default is exempt only on a node the batch creates', async () =>
    {
        const t = await fx.Engine.Begin(RoFx.Scope());
        t.CreateNode('n', RoFx.Ticket);
        t.SetDefault('n', RoFx.Owner, RoFx.U2);
        await t.Commit();
        assert.equal(await RoFx.Read(fx, AccessScope.System, 'n', RoFx.Owner), RoFx.U2);
        await RoFx.DeniedCommit(fx, tx => tx.SetDefault(RoFx.K, RoFx.Owner, RoFx.U2), RoFx.Owner);
    });

    test('read-only names must be members of their key', async () =>
    {
        await assert.rejects(fx.Engine.Begin(RoFx.Scope(['nope'])),
            (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes('Item.nope'));
        // A subconcept's member is not a member of the parent key.
        await assert.rejects(fx.Engine.Begin(AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Person, { ReadOnly: new Set([RoFx.Owner]) }]]) })),
            (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
    });

    test('Build copies the read-only set', async () =>
    {
        const names = new Set([RoFx.Owner]);
        const scope = AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[RoFx.Item, { ReadOnly: names }]]) });
        names.clear();
        assert.deepEqual([...(scope.Writes.get(RoFx.Item)?.ReadOnly ?? [])], [RoFx.Owner]);
    });
});
