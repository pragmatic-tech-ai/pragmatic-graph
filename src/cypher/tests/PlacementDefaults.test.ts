import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessError, AccessErrorCode, AccessScope, Compare, CompareOp, type CellValue } from '../../index.js';
import { CypherWriteError, CypherWriteErrorCode } from '../CypherError.js';
import type { INodePlace, INodePlacement } from '../write/NodePlacement.js';
import { CypherFixture as F } from './CypherFixture.js';
import { WriteFixture as W } from './WriteFixture.js';

/** A placement handing out t0, t1, ... with no owner and the given defaults (ruling R91). */
class DefaultsPlacement implements INodePlacement
{
    private static readonly Prefix = 't';
    private static readonly NoOwner = '';

    private count = 0;

    public constructor(private readonly defaults: ReadonlyMap<string, CellValue>)
    {
    }

    public Place(): INodePlace
    {
        return { PublicId: `${DefaultsPlacement.Prefix}${this.count++}`, Owner: DefaultsPlacement.NoOwner, Defaults: this.defaults };
    }
}

/** Ticket { title?, owner?, rank: Int64? }. */
class DefaultsFx
{
    public static readonly Ticket = 'Ticket';
    public static readonly Title = 'title';
    public static readonly Owner = 'owner';
    public static readonly Rank = 'rank';
    public static readonly U1 = 'u1';
    public static readonly U2 = 'u2';
    public static readonly First = 't0';
    public static readonly A = 'a';
    public static readonly Unknown = 'nope';

    public static Open(): Promise<F>
    {
        return F.Open([F.Concept(DefaultsFx.Ticket, [F.Text(DefaultsFx.Title), F.Text(DefaultsFx.Owner), F.Int(DefaultsFx.Rank)])], []);
    }

    public static OwnerDefault(owner: string = DefaultsFx.U1): DefaultsPlacement
    {
        return new DefaultsPlacement(new Map<string, CellValue>([[DefaultsFx.Owner, owner]]));
    }

    public static async Property(fx: F, publicId: string, member: string): Promise<unknown>
    {
        const reader = await fx.Engine.BeginRead(AccessScope.System);
        try
        {
            return (await reader.ReadNode(publicId))?.Properties.get(member);
        }
        finally
        {
            reader.dispose();
        }
    }

    /** Creates are allowed only for owner = u1. */
    public static OwnerScope(): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[DefaultsFx.Ticket, { Create: new Compare(DefaultsFx.Owner, CompareOp.Eq, DefaultsFx.U1) }]]) });
    }
}

describe('placement defaults (R91)', () =>
{
    let fx: F;
    beforeEach(async () => { fx = await DefaultsFx.Open(); });
    afterEach(async () => { await fx.dispose(); });

    test('defaults fill unset properties', async () =>
    {
        const r = await W.Write(fx, "CREATE (n:Ticket {title: 'a'}) RETURN n.owner AS o", { Placement: DefaultsFx.OwnerDefault() });
        assert.deepEqual(r.Rows.map(row => row.get('o')), [DefaultsFx.U1]);
        assert.equal(await DefaultsFx.Property(fx, DefaultsFx.First, DefaultsFx.Owner), DefaultsFx.U1);
        assert.equal(await DefaultsFx.Property(fx, DefaultsFx.First, DefaultsFx.Title), DefaultsFx.A);
    });

    test('query value wins over default', async () =>
    {
        await W.Write(fx, "CREATE (n:Ticket {title: 'a', owner: 'u2'})", { Placement: DefaultsFx.OwnerDefault() });
        assert.equal(await DefaultsFx.Property(fx, DefaultsFx.First, DefaultsFx.Owner), DefaultsFx.U2);
    });

    test('defaults count for the create predicate', async () =>
    {
        await W.Write(fx, "CREATE (n:Ticket {title: 'a'})", { Placement: DefaultsFx.OwnerDefault(), Scope: DefaultsFx.OwnerScope() });
        assert.equal(await DefaultsFx.Property(fx, DefaultsFx.First, DefaultsFx.Owner), DefaultsFx.U1);
        // A default the predicate rejects, and a query value overriding an accepted default, are both denied.
        for (const [text, placement] of [["CREATE (n:Ticket {title: 'a'})", DefaultsFx.OwnerDefault(DefaultsFx.U2)], ["CREATE (n:Ticket {owner: 'u2'})", DefaultsFx.OwnerDefault()]] as const)
        {
            await assert.rejects(W.Write(fx, text, { Placement: placement, Scope: DefaultsFx.OwnerScope() }),
                (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Denied && e.cause instanceof AccessError && e.cause.Code === AccessErrorCode.CreateDenied);
        }
    });

    test('a default must name a property of the concept and fit its type', async () =>
    {
        await assert.rejects(W.Write(fx, "CREATE (n:Ticket {title: 'a'})", { Placement: new DefaultsPlacement(new Map([[DefaultsFx.Unknown, 'x']])) }),
            (e: unknown) => e instanceof CypherWriteError && e.message.includes(`unknown member ${DefaultsFx.Ticket}.${DefaultsFx.Unknown}`));
        await assert.rejects(W.Write(fx, "CREATE (n:Ticket {title: 'a'})", { Placement: new DefaultsPlacement(new Map([[DefaultsFx.Rank, 'x']])) }),
            (e: unknown) => e instanceof CypherWriteError && /Ticket\.rank/.test(e.message));
    });

    test('MERGE that creates applies defaults too', async () =>
    {
        await W.Write(fx, "MERGE (n:Ticket {title: 'm'})", { Placement: DefaultsFx.OwnerDefault() });
        assert.equal(await DefaultsFx.Property(fx, DefaultsFx.First, DefaultsFx.Owner), DefaultsFx.U1);
    });
});
