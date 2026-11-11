import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessScope, ConnectorContext, GraphError, GraphErrorCode, type IFetchRequest, type IFetchedRow } from '../../index.js';
import { CypherEngine, type ICypherRunOptions } from '../../cypher/CypherEngine.js';
import { CypherFixture } from '../../cypher/tests/CypherFixture.js';
import { SequencePlacement } from '../../cypher/tests/WriteFixture.js';
import { FakeConnector } from './FakeConnector.js';
import { FakeExternalConnector } from './FakeExternalConnector.js';

/**
 * Ticket { title } bound to the External fake `ext` (model jira), Note { text } bound to the Mirrored fake `mirror`
 * (model wiki). The external fake answers every fetch with row `ta` for alice's context and `tb` for any other.
 */
class CtxFx
{
    private static readonly Jira = 'jira';
    public static readonly Wiki = 'wiki';
    private static readonly Ticket = 'Ticket';
    public static readonly Note = 'Note';
    private static readonly Title = 'title';
    private static readonly Text = 'text';
    private static readonly Ext = 'ext';
    private static readonly Mirror = 'mirror';
    private static readonly Delay = 5;
    public static readonly Alice = 'alice';
    public static readonly Bob = 'bob';
    public static readonly Carol = 'carol';
    public static readonly Dave = 'dave';
    public static readonly RowA = 'ta';
    public static readonly RowB = 'tb';
    public static readonly DaveNote = 'n-dave';
    public static readonly ReadTickets = 'MATCH (t:Ticket) RETURN t';
    public static readonly CreateNote = "MATCH (t:Ticket) CREATE (n:Note {text: 'x'})";

    private static readonly Opened: CtxFx[] = [];

    private inFlight = 0;
    /** The most fetches the external fake had running at once. */
    public Peak = 0;

    private constructor(public readonly Fixture: CypherFixture, public readonly External: FakeExternalConnector, public readonly Mirrored: FakeConnector, public readonly Cypher: CypherEngine)
    {
    }

    public static async Open(): Promise<CtxFx>
    {
        const external = new FakeExternalConnector(CtxFx.Ext, []);
        const mirrored = new FakeConnector(CtxFx.Mirror, []);
        const fixture = await CypherFixture.Open(
            [CypherFixture.Concept(CtxFx.Ticket, [CypherFixture.Text(CtxFx.Title)]), CypherFixture.Concept(CtxFx.Note, [CypherFixture.Text(CtxFx.Text)])],
            [],
            [],
            [{ Model: CtxFx.Jira, Concept: CtxFx.Ticket, Connector: CtxFx.Ext }, { Model: CtxFx.Wiki, Concept: CtxFx.Note, Connector: CtxFx.Mirror }],
            [external, mirrored],
        );
        const fx = new CtxFx(fixture, external, mirrored, new CypherEngine(fixture.Engine));
        external.Override = request => ({ Rows: [CtxFx.Row(request.Context.Key === CtxFx.Alice ? CtxFx.RowA : CtxFx.RowB)] });
        fx.Interleave();
        CtxFx.Opened.push(fx);
        return fx;
    }

    public static async Close(): Promise<void>
    {
        await Promise.all(CtxFx.Opened.map(f => f.Fixture.dispose()));
    }

    /** Every external fetch yields to the event loop before answering, so concurrent queries really overlap. */
    private Interleave(): void
    {
        const inner = this.External.Fetch.bind(this.External);
        this.External.Fetch = async (request: IFetchRequest) =>
        {
            this.Peak = Math.max(this.Peak, ++this.inFlight);
            await new Promise<void>(resolve => setTimeout(resolve, CtxFx.Delay));
            try
            {
                return await inner(request);
            }
            finally
            {
                this.inFlight--;
            }
        };
    }

    private static Row(id: string): IFetchedRow
    {
        return { PublicId: id, Concept: CtxFx.Ticket, Values: new Map([[CtxFx.Title, id]]), Links: new Map() };
    }

    public async Ids(text: string, options: ICypherRunOptions): Promise<unknown[]>
    {
        const result = await this.Cypher.Execute(AccessScope.System, text, options);
        return result.Rows.map(r => CypherFixture.Plain(r[0]));
    }

    public static Placement(): SequencePlacement
    {
        return new SequencePlacement(CtxFx.Wiki);
    }
}

describe('ConnectorContext (spec section 6)', () =>
{
    after(() => CtxFx.Close());

    test('concurrent reads keep their contexts and rows apart', async () =>
    {
        const fx = await CtxFx.Open();
        const alice = ConnectorContext.For(CtxFx.Alice);
        const bob = ConnectorContext.For(CtxFx.Bob);
        const [a, b] = await Promise.all([
            fx.Ids(CtxFx.ReadTickets, { Connector: alice }),
            fx.Ids(CtxFx.ReadTickets, { Connector: bob }),
        ]);
        assert.deepEqual(a, [CtxFx.RowA]);
        assert.deepEqual(b, [CtxFx.RowB]);
        assert.ok(fx.Peak > 1, 'the two reads overlapped');
        for (const request of fx.External.Requests)
        {
            assert.ok(request.Context === alice || request.Context === bob);
        }
        assert.ok(fx.External.Requests.some(r => r.Context === alice) && fx.External.Requests.some(r => r.Context === bob));
        assert.throws(() => ConnectorContext.For(''), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
        assert.ok(ConnectorContext.Anonymous.IsAnonymous && !alice.IsAnonymous);
    });

    test('a transaction fetches and begins connectors with its context', async () =>
    {
        const fx = await CtxFx.Open();
        // External writes are unsupported on this branch: the write transaction reads the external Ticket (federated) and creates a mirrored Note.
        await fx.Cypher.Execute(AccessScope.System, CtxFx.CreateNote, { Connector: ConnectorContext.For(CtxFx.Carol), Placement: CtxFx.Placement() });
        assert.ok(fx.External.Requests.length > 0);
        assert.ok(fx.External.Requests.every(r => r.Context.Key === CtxFx.Carol));
        assert.deepEqual(fx.Mirrored.Contexts.map(c => c.Key), [CtxFx.Carol]);
    });

    test('without a context every call carries Anonymous', async () =>
    {
        const fx = await CtxFx.Open();
        const reader = await fx.Fixture.Engine.BeginRead(AccessScope.System);
        assert.equal(reader.Connector, ConnectorContext.Anonymous);
        reader.dispose();
        await fx.Ids(CtxFx.ReadTickets, {});
        await fx.Cypher.Execute(AccessScope.System, CtxFx.CreateNote, { Placement: CtxFx.Placement() });
        assert.ok(fx.External.Requests.length > 0 && fx.External.Requests.every(r => r.Context === ConnectorContext.Anonymous));
        assert.deepEqual(fx.Mirrored.Contexts, [ConnectorContext.Anonymous]);
    });

    test('a transaction API commit begins connectors with the transaction context', async () =>
    {
        const fx = await CtxFx.Open();
        const transaction = await fx.Fixture.Engine.Begin(AccessScope.System, { Connector: ConnectorContext.For(CtxFx.Dave) });
        try
        {
            transaction.CreateNode(CtxFx.DaveNote, CtxFx.Note, { Owner: CtxFx.Wiki });
            await transaction.Commit();
        }
        finally
        {
            transaction.dispose();
        }
        assert.deepEqual(fx.Mirrored.Contexts.map(c => c.Key), [CtxFx.Dave]);
    });
});
