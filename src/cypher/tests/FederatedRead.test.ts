import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    AccessDefault, AccessScope, Compare, CompareOp, ConnectorError, ConnectorPhase, ConnectorResidency, GraphEngine, In, IsNull, Not, PredicateKind, StorageKind,
    type IConnectorCapabilities, type IConnectorTransaction, type IEngineStorage, type IExternalConnector, type IFetchPage, type IFetchRequest, type IFetchedRow, type Predicate,
} from '../../index.js';
import type { And } from '../../predicate/Predicate.js';
import { NodeEvaluator } from '../../predicate/NodeEvaluator.js';
import { CypherCursor } from '../CypherCursor.js';
import { CypherEngine } from '../CypherEngine.js';
import type { CypherResult } from '../CypherResult.js';
import { NodeValue, ScalarValue, type CypherValue } from '../CypherValue.js';
import { CypherFixture } from './CypherFixture.js';

/**
 * A scripted External connector holding Ticket rows. Requests are logged; with Honour it applies the node-local
 * request predicate (as a push-down connector would), else it ignores it. Pages hold two rows (Resume tokens).
 * Keys and Reverse requests are answered from the rows; Fail makes every Fetch reject.
 */
class TicketConnector implements IExternalConnector
{
    private static readonly ReadOnly = 'read-only';
    private static readonly Boom = 'ticket source down';
    private static readonly PageSize = 2;

    public readonly Residency = ConnectorResidency.External as const;
    public readonly Requests: IFetchRequest[] = [];
    public readonly Capabilities: IConnectorCapabilities;
    public Honour = false;
    public Fail = false;

    public constructor(public readonly Name: string, public Rows: IFetchedRow[], reverse: boolean)
    {
        this.Capabilities = { KeyLookup: true, ReverseLookup: reverse, PushDown: new Set([PredicateKind.Compare, PredicateKind.In, PredicateKind.IsNull, PredicateKind.And]) };
    }

    public Begin(): Promise<IConnectorTransaction>
    {
        return Promise.reject(new Error(TicketConnector.ReadOnly));
    }

    public Fetch(request: IFetchRequest): Promise<IFetchPage>
    {
        this.Requests.push(request);
        if (this.Fail)
        {
            return Promise.reject(new Error(TicketConnector.Boom));
        }
        if (request.Keys !== undefined)
        {
            const keys = new Set(request.Keys);
            return Promise.resolve({ Rows: this.Rows.filter(r => keys.has(r.PublicId)) });
        }
        let rows = this.Rows;
        if (request.Reverse !== undefined)
        {
            const reverse = request.Reverse;
            rows = rows.filter(r => (r.Links.get(reverse.Relationship) ?? []).includes(reverse.Target));
        }
        if (this.Honour && request.Predicate.IsNodeLocal)
        {
            rows = rows.filter(r => NodeEvaluator.Matches(request.Predicate, r.Values, r.PublicId));
        }
        const start = request.Resume === undefined ? 0 : Number(request.Resume);
        const end = start + TicketConnector.PageSize;
        return Promise.resolve(end < rows.length ? { Rows: rows.slice(start, end), Resume: String(end) } : { Rows: rows.slice(start) });
    }
}

/**
 * Team { name, assigned -> Ticket* } held by the engine; Ticket { title, state, secret, rank, team -> Team* } with model
 * jira's Tickets bound to the External connector ext. Engine Teams a (core) and b (other) and an engine-held Ticket
 * local (owner ''); the connector holds t1 (open, team a), t2 (closed, team b) and t3 (open).
 */
class FedFx
{
    private static readonly DirPrefix = 'pragmatic-graph-federated-';
    private static readonly Dirs: string[] = [];
    private static readonly Version = 'federated-v1';
    public static readonly Team = 'Team';
    public static readonly Ticket = 'Ticket';
    public static readonly Jira = 'jira';
    public static readonly Ext = 'ext';
    public static readonly Assigned = 'assigned';
    public static readonly State = 'state';
    public static readonly OpenState = 'open';
    public static readonly Secret = 'secret';
    public static readonly ByState = 'byState';
    public static readonly Target = Object.freeze({ Concept: FedFx.Ticket, Owner: FedFx.Jira });

    private constructor(public readonly Engine: GraphEngine, public readonly Connector: TicketConnector, public readonly Cypher: CypherEngine)
    {
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), FedFx.DirPrefix));
        FedFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of FedFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Row(id: string, values: Readonly<Record<string, string | bigint>>, team: readonly string[] = []): IFetchedRow
    {
        const links = new Map<string, readonly string[]>();
        if (team.length > 0)
        {
            links.set('team', team);
        }
        return { PublicId: id, Concept: FedFx.Ticket, Values: new Map(Object.entries(values)), Links: links };
    }

    public static Rows(): IFetchedRow[]
    {
        return [
            FedFx.Row('t1', { title: 'one', state: FedFx.OpenState, secret: 's1', rank: 1n }, ['a']),
            FedFx.Row('t2', { title: 'two', state: 'closed', secret: 's2', rank: 2n }, ['b']),
            FedFx.Row('t3', { title: 'three', state: FedFx.OpenState, secret: 's3', rank: 3n }),
        ];
    }

    public static async Open(storage: IEngineStorage, reverse = true): Promise<FedFx>
    {
        const connector = new TicketConnector(FedFx.Ext, FedFx.Rows(), reverse);
        const engine = await GraphEngine.Open({
            Description: {
                Version: FedFx.Version,
                Definitions: [
                    CypherFixture.Concept(FedFx.Team, [CypherFixture.Text('name'), CypherFixture.Rel(FedFx.Assigned, [FedFx.Ticket])]),
                    CypherFixture.Concept(FedFx.Ticket, [
                        CypherFixture.Text('title'), CypherFixture.Text(FedFx.State), CypherFixture.Text(FedFx.Secret), CypherFixture.Int('rank'),
                        CypherFixture.Rel('team', [FedFx.Team]),
                    ]),
                ],
                Indexes: [{ Name: FedFx.ByState, On: FedFx.Ticket, Members: [FedFx.State], Unique: false }],
                Seed: [
                    CypherFixture.Node('a', FedFx.Team, { name: 'core' }),
                    CypherFixture.Node('b', FedFx.Team, { name: 'other' }),
                    CypherFixture.Node('local', FedFx.Ticket, { title: 'zero', state: FedFx.OpenState, rank: 0n }),
                ],
                Bindings: [{ Model: FedFx.Jira, Concept: FedFx.Ticket, Connector: FedFx.Ext }],
            },
            Storage: storage,
            Connectors: [connector],
        });
        return new FedFx(engine, connector, new CypherEngine(engine));
    }

    /** Links engine Team `from` to the external Ticket `to` (creating its stub). */
    public async LinkStub(from: string, to: string): Promise<void>
    {
        const t = await this.Engine.Begin(AccessScope.System);
        try
        {
            t.Link(from, FedFx.Assigned, to, { ExternalTarget: FedFx.Target });
            await t.Commit();
        }
        finally
        {
            t.dispose();
        }
    }

    public Run(text: string, scope: AccessScope = AccessScope.System): Promise<CypherResult>
    {
        return this.Cypher.Execute(scope, text);
    }

    /** Column `index` of every row as plain values (node → id). */
    public static Col(result: CypherResult, index = 0): unknown[]
    {
        return result.Rows.map(r => FedFx.Plain(r[index]!));
    }

    public static Plain(v: CypherValue): unknown
    {
        if (v instanceof NodeValue) return v.Id;
        if (v instanceof ScalarValue) return v.Value;
        return null;
    }

    /** Every predicate term of the request (And flattened, Or kept whole). */
    public static Terms(p: Predicate): Predicate[]
    {
        return p.Kind === PredicateKind.And ? (p as And).Terms.flatMap(t => FedFx.Terms(t)) : [p];
    }

    public static HasCompare(p: Predicate, member: string, op: CompareOp, value: unknown): boolean
    {
        return FedFx.Terms(p).some(t => t instanceof Compare && t.Member === member && t.Op === op && t.Value === value);
    }

    /** The predicates of the scan requests (no Keys, no Reverse). */
    public ScanPredicates(): Predicate[]
    {
        return this.Connector.Requests.filter(r => r.Keys === undefined && r.Reverse === undefined).map(r => r.Predicate);
    }

    public dispose(): Promise<void>
    {
        return this.Engine.dispose();
    }
}

type StorageFactory = () => IEngineStorage;

class FederatedSuite
{
    private static readonly OpenOnly = AccessScope.Build({
        Default: AccessDefault.Allow,
        Rows: new Map<string, Predicate>([[FedFx.Ticket, new Compare(FedFx.State, CompareOp.Eq, FedFx.OpenState)]]),
        Hidden: new Map([[FedFx.Ticket, new Set([FedFx.Secret])]]),
    });

    public static Register(name: string, storage: StorageFactory): void
    {
        describe(`Federated Cypher reads (${name})`, () =>
        {
            it('label scan unions engine and external rows', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    const r = await fx.Run('MATCH (n:Ticket) RETURN n ORDER BY n.title');
                    assert.deepEqual(FedFx.Col(r), ['t1', 't3', 't2', 'local']);
                    const owners = r.Rows.map(row => (row[0] as NodeValue).Node.Owner);
                    assert.deepEqual(owners, [FedFx.Jira, FedFx.Jira, FedFx.Jira, '']);
                    assert.equal((r.Rows[0]![0] as NodeValue).Node.Properties.get('title'), 'one');
                    const reader = await fx.Engine.BeginRead(AccessScope.System);
                    try
                    {
                        const raw: string[] = [];
                        for await (const id of reader.ScanNodes(FedFx.Ticket)) raw.push(id);
                        assert.deepEqual(raw, ['local']);
                    }
                    finally
                    {
                        reader.dispose();
                    }
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('scope filters fetched rows', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    const r = await fx.Run('MATCH (n:Ticket) RETURN n.title, n.secret ORDER BY n.title', FederatedSuite.OpenOnly);
                    assert.deepEqual(FedFx.Col(r), ['one', 'three', 'zero']);
                    assert.deepEqual(FedFx.Col(r, 1), [null, null, null]);
                    assert.ok(fx.ScanPredicates().every(p => FedFx.HasCompare(p, FedFx.State, CompareOp.Eq, FedFx.OpenState)));
                    // The scope is enforced engine-side whatever the connector does with the predicate.
                    fx.Connector.Honour = true;
                    const honoured = await fx.Run('MATCH (n:Ticket) RETURN n.title ORDER BY n.title', FederatedSuite.OpenOnly);
                    assert.deepEqual(FedFx.Col(honoured), ['one', 'three', 'zero']);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('match by property pushes a hint', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    const query = 'MATCH (t:Ticket {state: \'open\'}) RETURN t.title ORDER BY t.title';
                    const ignored = await fx.Run(query);
                    assert.ok(fx.ScanPredicates().length > 0);
                    assert.ok(fx.ScanPredicates().every(p => FedFx.HasCompare(p, FedFx.State, CompareOp.Eq, FedFx.OpenState)));
                    fx.Connector.Honour = true;
                    const honoured = await fx.Run(query);
                    assert.deepEqual(FedFx.Col(ignored), ['one', 'three', 'zero']);
                    assert.deepEqual(FedFx.Col(honoured), FedFx.Col(ignored));
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('WHERE conjuncts translate to hint predicates', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    const query = 'MATCH (t:Ticket) WHERE t.title IN [\'one\', \'two\'] AND t.rank < 2 AND t.secret IS NOT NULL AND 3 > t.rank AND (t.title = \'x\' OR t.rank = 1) RETURN t.title';
                    const r = await fx.Run(query);
                    assert.deepEqual(FedFx.Col(r), ['one']);
                    const p = fx.ScanPredicates()[0]!;
                    const terms = FedFx.Terms(p);
                    assert.ok(terms.some(t => t instanceof In && t.Member === 'title' && t.Values.length === 2));
                    assert.ok(FedFx.HasCompare(p, 'rank', CompareOp.Lt, 2n));
                    assert.ok(FedFx.HasCompare(p, 'rank', CompareOp.Lt, 3n));
                    assert.ok(terms.some(t => t instanceof Not && t.Term instanceof IsNull && t.Term.Member === FedFx.Secret));
                    assert.ok(!terms.some(t => t.Kind === PredicateKind.Or), 'an OR is not translated');
                    fx.Connector.Honour = true;
                    assert.deepEqual(FedFx.Col(await fx.Run(query)), ['one']);
                    // A hidden member is never hinted: under the scope t.secret reads null, so IS NULL holds for every row.
                    fx.Connector.Requests.length = 0;
                    const hidden = await fx.Run('MATCH (t:Ticket) WHERE t.secret IS NULL RETURN t.title ORDER BY t.title', FederatedSuite.OpenOnly);
                    assert.deepEqual(FedFx.Col(hidden), ['one', 'three', 'zero']);
                    assert.ok(fx.ScanPredicates().every(q => !FedFx.Terms(q).some(t => t instanceof IsNull)));
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('index seek unions external rows and re-checks the equality', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    const query = 'MATCH (t:Ticket) WHERE t.state = $s RETURN t.title ORDER BY t.title';
                    assert.match(fx.Cypher.Explain(query, undefined, { Parameters: new Map([['s', FedFx.OpenState]]) }), /IndexSeek\(byState\)/);
                    const r = await fx.Cypher.Execute(AccessScope.System, query, { Parameters: new Map([['s', FedFx.OpenState]]) });
                    assert.deepEqual(FedFx.Col(r), ['one', 'three', 'zero']);
                    assert.ok(fx.ScanPredicates().every(p => FedFx.HasCompare(p, FedFx.State, CompareOp.Eq, FedFx.OpenState)));
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('connector failure rejects Execute', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    fx.Connector.Fail = true;
                    await assert.rejects(fx.Run('MATCH (n:Ticket) RETURN n'), (e: unknown) => e instanceof ConnectorError && e.Phase === ConnectorPhase.Fetch && e.Connector === FedFx.Ext);
                    await assert.rejects(fx.Run('MATCH (n) RETURN count(n)'), ConnectorError);
                    // Engine-only labels do not fetch.
                    assert.deepEqual(FedFx.Col(await fx.Run('MATCH (n:Team) RETURN n.name ORDER BY n.name')), ['core', 'other']);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('external source links into an engine node', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    const out = await fx.Run('MATCH (t:Ticket)-[:team]->(a:Team) RETURN t, a.name ORDER BY a.name');
                    assert.deepEqual(FedFx.Col(out), ['t1', 't2']);
                    assert.deepEqual(FedFx.Col(out, 1), ['core', 'other']);
                    assert.deepEqual((out.Rows[0]![0] as NodeValue).Node.Links, [{ Relationship: 'team', PublicId: 'a' }]);
                    const reverse = await fx.Run('MATCH (a:Team {name: \'core\'})<-[:team]-(t) RETURN t');
                    assert.deepEqual(FedFx.Col(reverse), ['t1']);
                    const undirected = await fx.Run('MATCH (a:Team {name: \'core\'})-[:team]-(t) RETURN t');
                    assert.deepEqual(FedFx.Col(undirected), ['t1']);
                }
                finally
                {
                    await fx.dispose();
                }
                const blind = await FedFx.Open(storage(), false);
                try
                {
                    const reverse = await blind.Run('MATCH (a:Team {name: \'core\'})<-[:team]-(t) RETURN t');
                    assert.deepEqual(FedFx.Col(reverse), []);
                    assert.ok(blind.Connector.Requests.every(r => r.Reverse === undefined));
                }
                finally
                {
                    await blind.dispose();
                }
            });

            it('Explain shows the fetch', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    const plan = fx.Cypher.Explain('MATCH (n:Ticket) RETURN n');
                    assert.match(plan, /^\s*Fetch Ticket via ext$/m);
                    assert.doesNotMatch(fx.Cypher.Explain('MATCH (n:Team) RETURN n'), /Fetch/);
                    assert.match(fx.Cypher.Explain('MATCH (n) RETURN n'), /^\s*Fetch Ticket via ext$/m);
                    assert.equal(fx.Connector.Requests.length, 0);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('dangling external target is omitted', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    await fx.LinkStub('a', 'x');
                    assert.deepEqual(FedFx.Col(await fx.Run('MATCH (a:Team)-[:assigned]->(t) RETURN t')), []);
                    const a = await fx.Run('MATCH (a:Team {name: \'core\'}) RETURN a');
                    assert.deepEqual((a.Rows[0]![0] as NodeValue).Node.Links, []);
                    // A stub the connector has resolves through a key lookup.
                    await fx.LinkStub('a', 't3');
                    const live = await fx.Run('MATCH (a:Team)-[:assigned]->(t) RETURN t, t.title');
                    assert.deepEqual(FedFx.Col(live), ['t3']);
                    assert.deepEqual(FedFx.Col(live, 1), ['three']);
                    assert.equal((live.Rows[0]![0] as NodeValue).Node.Owner, FedFx.Jira);
                    const linked = await fx.Run('MATCH (a:Team {name: \'core\'}) RETURN a');
                    assert.deepEqual((linked.Rows[0]![0] as NodeValue).Node.Links, [{ Relationship: FedFx.Assigned, PublicId: 't3' }]);
                    // Stubs never surface as engine data.
                    assert.deepEqual(FedFx.Col(await fx.Run('MATCH (n:Ticket) RETURN n ORDER BY n.title')), ['t1', 't3', 't2', 'local']);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('reverse traversal through stub', async () =>
            {
                const fx = await FedFx.Open(storage(), false);
                try
                {
                    await fx.LinkStub('a', 't1');
                    const r = await fx.Run('MATCH (t:Ticket)<-[:assigned]-(a) RETURN t, a');
                    assert.deepEqual(FedFx.Col(r), ['t1']);
                    assert.deepEqual(FedFx.Col(r, 1), ['a']);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('stubs resolve under a scope that rules over the external concept', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    await fx.LinkStub('a', 't1');
                    await fx.LinkStub('a', 't2');
                    const out = await fx.Run('MATCH (a:Team)-[:assigned]->(t) RETURN t.title, t.secret', FederatedSuite.OpenOnly);
                    assert.deepEqual(FedFx.Col(out), ['one']);
                    assert.deepEqual(FedFx.Col(out, 1), [null]);
                    const back = await fx.Run('MATCH (t:Ticket)<-[:assigned]-(a) RETURN t.title, a.name', FederatedSuite.OpenOnly);
                    assert.deepEqual(FedFx.Col(back), ['one']);
                    const a = await fx.Run('MATCH (a:Team {name: \'core\'}) RETURN a', FederatedSuite.OpenOnly);
                    assert.deepEqual((a.Rows[0]![0] as NodeValue).Node.Links, [{ Relationship: FedFx.Assigned, PublicId: 't1' }]);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('federated pages', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    const query = 'MATCH (n:Ticket) RETURN n.title';
                    const full = FedFx.Col(await fx.Run(query)).sort();
                    const pages: unknown[] = [];
                    let cursor: CypherCursor | undefined;
                    let first = true;
                    for (let i = 0; i < 10; i++)
                    {
                        const limits = first ? { RowCap: 2, Skip: 0 } : { RowCap: 2, After: cursor! };
                        first = false;
                        const page = await fx.Cypher.Execute(AccessScope.System, query, { Limits: limits });
                        pages.push(...FedFx.Col(page));
                        if (!page.HasMore) break;
                        cursor = CypherCursor.Decode(page.NextCursor!.Encode());
                    }
                    assert.deepEqual(pages, full);
                    assert.equal(new Set(pages).size, 4);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('each Execute fetches afresh and a scan then a stub expand look the row up once', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    await fx.LinkStub('a', 't1');
                    const r = await fx.Run('MATCH (t:Ticket) WITH count(t) AS c MATCH (a:Team)-[:assigned]->(u) RETURN c, u');
                    assert.deepEqual(FedFx.Col(r, 1), ['t1']);
                    assert.equal(fx.Connector.Requests.filter(r => r.Keys !== undefined).length, 0);
                    const before = fx.Connector.Requests.length;
                    await fx.Run('MATCH (a:Team)-[:assigned]->(u) RETURN u');
                    assert.ok(fx.Connector.Requests.length > before);
                }
                finally
                {
                    await fx.dispose();
                }
            });
        });
    }
}

after(() => FedFx.RemoveDirs());
FederatedSuite.Register('Memory', () => ({ Kind: StorageKind.Memory }));
FederatedSuite.Register('LMDB', () => ({ Kind: StorageKind.Lmdb, Path: FedFx.Dir() }));
