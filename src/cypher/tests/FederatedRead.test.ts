import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Root from '../../index.js';
import {
    AccessDefault, AccessScope, Compare, CompareOp, ConnectorError, ConnectorPhase, ConnectorResidency, GraphEngine, GraphError, GraphErrorCode, In, IsNull, Not, PredicateKind, StorageKind,
    type GraphReader, type IConnectorCapabilities, type IConnectorTransaction, type IEngineStorage, type IExternalConnector, type IFetchPage, type IFetchRequest,
    type IFetchedRow, type IReadProbe, type Predicate,
} from '../../index.js';
import { FetchSession } from '../../connectors/FetchSession.js';
import { FederatedReads } from '../../FederatedReads.js';
import type { And, Or } from '../../predicate/Predicate.js';
import { NodeEvaluator } from '../../predicate/NodeEvaluator.js';
import { CypherCursor } from '../CypherCursor.js';
import { RelDirection } from '../CypherEnums.js';
import { CypherEngine } from '../CypherEngine.js';
import type { CypherResult } from '../CypherResult.js';
import { NodeValue, ScalarValue, type CypherValue } from '../CypherValue.js';
import { FederatedSource } from '../FederatedSource.js';
import { ReaderSource } from '../ReaderSource.js';
import { CypherFixture } from './CypherFixture.js';

/**
 * A scripted External connector holding Ticket rows. Requests are logged; with Honour it applies the node-local
 * request predicate (as a push-down connector would), else it ignores it. Pages hold two rows (Resume tokens).
 * Keys and Reverse requests are answered from the rows; Fail makes every Fetch reject, FailKeys every key lookup.
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
    public FailKeys = false;

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
        if (this.Fail || (this.FailKeys && request.Keys !== undefined))
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

interface IFedOptions
{
    readonly Reverse?: boolean;
    /** Rows the connector holds beyond FedFx.Rows. */
    readonly Extra?: readonly IFetchedRow[];
}

/**
 * Team { name, assigned -> Ticket* } held by the engine; Ticket { title, state, secret, rank, team -> Team*,
 * parent -> Ticket* } and its subtype Bug { severity }, with model jira's Tickets bound to the External connector ext.
 * Engine Teams a (core) and b (other) and an engine-held Ticket local (owner ''); the connector holds t1 (open, team a),
 * t2 (closed, team b, parent t1) and t3 (open, parent gone, which the connector does not have).
 */
class FedFx
{
    private static readonly DirPrefix = 'pragmatic-graph-federated-';
    private static readonly Dirs: string[] = [];
    private static readonly Version = 'federated-v1';
    public static readonly Team = 'Team';
    public static readonly Ticket = 'Ticket';
    public static readonly Bug = 'Bug';
    public static readonly Jira = 'jira';
    public static readonly Ext = 'ext';
    public static readonly NoOwner = '';
    public static readonly Assigned = 'assigned';
    public static readonly TeamRel = 'team';
    public static readonly Parent = 'parent';
    public static readonly Name = 'name';
    public static readonly Title = 'title';
    public static readonly State = 'state';
    public static readonly Secret = 'secret';
    public static readonly Rank = 'rank';
    public static readonly Severity = 'severity';
    public static readonly ByState = 'byState';
    public static readonly OpenState = 'open';
    public static readonly ClosedState = 'closed';
    public static readonly High = 'high';
    public static readonly Core = 'core';
    public static readonly Other = 'other';
    public static readonly A = 'a';
    public static readonly B = 'b';
    public static readonly Local = 'local';
    public static readonly T1 = 't1';
    public static readonly T2 = 't2';
    public static readonly T3 = 't3';
    public static readonly B1 = 'b1';
    public static readonly B2 = 'b2';
    public static readonly X = 'x';
    public static readonly Gone = 'gone';
    public static readonly Zero = 'zero';
    public static readonly One = 'one';
    public static readonly Two = 'two';
    public static readonly Three = 'three';
    public static readonly Dup = 'dup';
    public static readonly S1 = 's1';
    public static readonly S2 = 's2';
    public static readonly S3 = 's3';
    public static readonly StateParam = 's';
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

    public static Row(id: string, values: Readonly<Record<string, string | bigint>>, links: Readonly<Record<string, readonly string[]>> = {}, concept: string = FedFx.Ticket): IFetchedRow
    {
        return { PublicId: id, Concept: concept, Values: new Map(Object.entries(values)), Links: new Map(Object.entries(links)) };
    }

    public static Rows(): IFetchedRow[]
    {
        return [
            FedFx.Row(FedFx.T1, { title: FedFx.One, state: FedFx.OpenState, secret: FedFx.S1, rank: 1n }, { team: [FedFx.A] }),
            FedFx.Row(FedFx.T2, { title: FedFx.Two, state: FedFx.ClosedState, secret: FedFx.S2, rank: 2n }, { team: [FedFx.B], parent: [FedFx.T1] }),
            FedFx.Row(FedFx.T3, { title: FedFx.Three, state: FedFx.OpenState, secret: FedFx.S3, rank: 3n }, { parent: [FedFx.Gone] }),
        ];
    }

    public static async Open(storage: IEngineStorage, options: IFedOptions = {}): Promise<FedFx>
    {
        const connector = new TicketConnector(FedFx.Ext, [...FedFx.Rows(), ...(options.Extra ?? [])], options.Reverse ?? true);
        const engine = await GraphEngine.Open({
            Description: {
                Version: FedFx.Version,
                Definitions: [
                    CypherFixture.Concept(FedFx.Team, [CypherFixture.Text(FedFx.Name), CypherFixture.Rel(FedFx.Assigned, [FedFx.Ticket])]),
                    CypherFixture.Concept(FedFx.Ticket, [
                        CypherFixture.Text(FedFx.Title), CypherFixture.Text(FedFx.State), CypherFixture.Text(FedFx.Secret), CypherFixture.Int(FedFx.Rank),
                        CypherFixture.Rel(FedFx.TeamRel, [FedFx.Team]), CypherFixture.Rel(FedFx.Parent, [FedFx.Ticket]),
                    ]),
                    CypherFixture.Concept(FedFx.Bug, [CypherFixture.Text(FedFx.Severity)], FedFx.Ticket),
                ],
                Indexes: [{ Name: FedFx.ByState, On: FedFx.Ticket, Members: [FedFx.State], Unique: false }],
                Seed: [
                    CypherFixture.Node(FedFx.A, FedFx.Team, { name: FedFx.Core }),
                    CypherFixture.Node(FedFx.B, FedFx.Team, { name: FedFx.Other }),
                    CypherFixture.Node(FedFx.Local, FedFx.Ticket, { title: FedFx.Zero, state: FedFx.OpenState, rank: 0n }),
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

    /** The whole result as its DTO text (nodes with concept, owner, properties and links). */
    public async Dto(text: string, scope: AccessScope = AccessScope.System): Promise<string>
    {
        const dto = CypherEngine.ToDto(await this.Run(text, scope));
        return JSON.stringify(dto.Rows);
    }

    /** A FederatedSource over a System reader with its own session, as Execute builds it; the reader is disposed after. */
    public async WithSource<T>(work: (source: FederatedSource) => Promise<T>): Promise<T>
    {
        const reader = await this.Engine.BeginRead(AccessScope.System);
        try
        {
            const setup = FederatedReads.Of(reader).Setup!;
            const session = new FetchSession(setup.ExternalConnectors(), setup.Bindings, reader.Catalog);
            return await work(new FederatedSource(new ReaderSource(reader), reader, session, setup.Bindings));
        }
        finally
        {
            reader.dispose();
        }
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

    public static NodeAt(result: CypherResult, row: number, column = 0): NodeValue
    {
        return result.Rows[row]![column] as NodeValue;
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

    /** The scan requests (no Keys, no Reverse). */
    public ScanRequests(): IFetchRequest[]
    {
        return this.Connector.Requests.filter(r => r.Keys === undefined && r.Reverse === undefined);
    }

    public ScanPredicates(): Predicate[]
    {
        return this.ScanRequests().map(r => r.Predicate);
    }

    public dispose(): Promise<void>
    {
        return this.Engine.dispose();
    }
}

/** A probe that counts its ticks. */
class CountingProbe implements IReadProbe
{
    public Count = 0;

    public Tick(): void
    {
        this.Count++;
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

    /** Rows on a member the scope hides: only Tickets with no secret are visible. */
    private static readonly NoSecret = AccessScope.Build({
        Default: AccessDefault.Allow,
        Rows: new Map<string, Predicate>([[FedFx.Ticket, new IsNull(FedFx.Secret)]]),
        Hidden: new Map([[FedFx.Ticket, new Set([FedFx.Secret])]]),
    });

    /** Default Deny with a Rows entry on the subtype only: Tickets are invisible, open Bugs visible. */
    private static readonly OpenBugsOnly = AccessScope.Build({
        Default: AccessDefault.Deny,
        Rows: new Map<string, Predicate>([[FedFx.Bug, new Compare(FedFx.State, CompareOp.Eq, FedFx.OpenState)]]),
    });

    /** Team b is hidden. */
    private static readonly CoreTeamOnly = AccessScope.Build({
        Default: AccessDefault.Allow,
        Rows: new Map<string, Predicate>([[FedFx.Team, new Compare(FedFx.Name, CompareOp.Eq, FedFx.Core)]]),
    });

    /** Queries whose results must not change when the connector serves a row colliding with engine Team b. */
    private static readonly CollisionQueries = [
        'MATCH (n:Ticket) RETURN n ORDER BY n.title',
        'MATCH (n) RETURN n ORDER BY n.title, n.name',
        'MATCH (t:Ticket)-[:team]->(x) RETURN t, x ORDER BY t.title',
        'MATCH (x:Team)<-[:team]-(t) RETURN x, t ORDER BY x.name',
        'MATCH (t:Ticket) WITH count(t) AS c MATCH (x:Team)-[:team]-(y) RETURN c, x, y ORDER BY x.name',
        'MATCH (t:Ticket) WITH count(t) AS c MATCH (x:Team) RETURN c, x ORDER BY x.name',
        'MATCH (x:Team) WITH collect(x) AS xs MATCH (t:Ticket) RETURN size(xs), t ORDER BY t.title',
    ];

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
                    assert.deepEqual(FedFx.Col(r), [FedFx.T1, FedFx.T3, FedFx.T2, FedFx.Local]);
                    const owners = r.Rows.map(row => (row[0] as NodeValue).Node.Owner);
                    assert.deepEqual(owners, [FedFx.Jira, FedFx.Jira, FedFx.Jira, FedFx.NoOwner]);
                    assert.equal(FedFx.NodeAt(r, 0).Node.Properties.get(FedFx.Title), FedFx.One);
                    const reader = await fx.Engine.BeginRead(AccessScope.System);
                    try
                    {
                        const raw: string[] = [];
                        for await (const id of reader.ScanNodes(FedFx.Ticket)) raw.push(id);
                        assert.deepEqual(raw, [FedFx.Local]);
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
                    assert.deepEqual(FedFx.Col(r), [FedFx.One, FedFx.Three, FedFx.Zero]);
                    assert.deepEqual(FedFx.Col(r, 1), [null, null, null]);
                    assert.ok(fx.ScanPredicates().every(p => FedFx.HasCompare(p, FedFx.State, CompareOp.Eq, FedFx.OpenState)));
                    // The scope is enforced engine-side whatever the connector does with the predicate.
                    fx.Connector.Honour = true;
                    const honoured = await fx.Run('MATCH (n:Ticket) RETURN n.title ORDER BY n.title', FederatedSuite.OpenOnly);
                    assert.deepEqual(FedFx.Col(honoured), [FedFx.One, FedFx.Three, FedFx.Zero]);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('a scope ruling on a hidden member still rejects fetched rows', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    for (const honour of [false, true])
                    {
                        fx.Connector.Honour = honour;
                        const r = await fx.Run('MATCH (n:Ticket) RETURN n.title, n.secret ORDER BY n.title', FederatedSuite.NoSecret);
                        assert.deepEqual(FedFx.Col(r), [FedFx.Zero]);
                        assert.deepEqual(FedFx.Col(r, 1), [null]);
                    }
                    // The hidden member is fetched (the scope needs it) and removed before the row becomes a node.
                    assert.ok(fx.ScanRequests().every(q => q.Members.includes(FedFx.Secret)));
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('a subtype ruled differently from its parent is fetched under the Or of their scopes', async () =>
            {
                const bugs = [
                    FedFx.Row(FedFx.B1, { title: FedFx.B1, state: FedFx.OpenState, severity: FedFx.High }, {}, FedFx.Bug),
                    FedFx.Row(FedFx.B2, { title: FedFx.B2, state: FedFx.ClosedState }, {}, FedFx.Bug),
                ];
                const fx = await FedFx.Open(storage(), { Extra: bugs });
                try
                {
                    for (const honour of [false, true])
                    {
                        fx.Connector.Honour = honour;
                        const r = await fx.Run('MATCH (n:Ticket) RETURN n, n.severity', FederatedSuite.OpenBugsOnly);
                        assert.deepEqual(FedFx.Col(r), [FedFx.B1]);
                        assert.deepEqual(FedFx.Col(r, 1), [FedFx.High]);
                    }
                    const scope = FedFx.Terms(fx.ScanPredicates()[0]!)[0]!;
                    assert.equal(scope.Kind, PredicateKind.Or);
                    assert.deepEqual((scope as Or).Terms.map(t => t.Kind), [PredicateKind.False, PredicateKind.Compare]);
                    assert.ok(fx.ScanRequests().every(q => q.Members.includes(FedFx.Severity)));
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
                    assert.deepEqual(FedFx.Col(ignored), [FedFx.One, FedFx.Three, FedFx.Zero]);
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
                    assert.deepEqual(FedFx.Col(r), [FedFx.One]);
                    const p = fx.ScanPredicates()[0]!;
                    const terms = FedFx.Terms(p);
                    assert.ok(terms.some(t => t instanceof In && t.Member === FedFx.Title && t.Values.length === 2));
                    assert.ok(FedFx.HasCompare(p, FedFx.Rank, CompareOp.Lt, 2n));
                    assert.ok(FedFx.HasCompare(p, FedFx.Rank, CompareOp.Lt, 3n));
                    assert.ok(terms.some(t => t instanceof Not && t.Term instanceof IsNull && t.Term.Member === FedFx.Secret));
                    assert.ok(!terms.some(t => t.Kind === PredicateKind.Or), 'an OR is not translated');
                    fx.Connector.Honour = true;
                    assert.deepEqual(FedFx.Col(await fx.Run(query)), [FedFx.One]);
                    // A hidden member is never hinted: under the scope t.secret reads null, so IS NULL holds for every row.
                    fx.Connector.Requests.length = 0;
                    const hidden = await fx.Run('MATCH (t:Ticket) WHERE t.secret IS NULL RETURN t.title ORDER BY t.title', FederatedSuite.OpenOnly);
                    assert.deepEqual(FedFx.Col(hidden), [FedFx.One, FedFx.Three, FedFx.Zero]);
                    assert.ok(fx.ScanPredicates().every(q => !FedFx.Terms(q).some(t => t instanceof IsNull)));
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('index seek unions external rows, pushes the whole anchor hint and re-checks the equality', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    const query = 'MATCH (t:Ticket) WHERE t.state = $s AND t.rank > 0 RETURN t.title ORDER BY t.title';
                    const options = { Parameters: new Map([[FedFx.StateParam, FedFx.OpenState]]) };
                    assert.match(fx.Cypher.Explain(query, undefined, options), /IndexSeek\(byState\)/);
                    const r = await fx.Cypher.Execute(AccessScope.System, query, options);
                    assert.deepEqual(FedFx.Col(r), [FedFx.One, FedFx.Three]);
                    assert.ok(fx.ScanPredicates().length > 0);
                    assert.ok(fx.ScanPredicates().every(p => FedFx.HasCompare(p, FedFx.State, CompareOp.Eq, FedFx.OpenState) && FedFx.HasCompare(p, FedFx.Rank, CompareOp.Gt, 0n)));
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
                    assert.deepEqual(FedFx.Col(await fx.Run('MATCH (n:Team) RETURN n.name ORDER BY n.name')), [FedFx.Core, FedFx.Other]);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('a connector failure while filling result links rejects Execute', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    await fx.LinkStub(FedFx.A, FedFx.T1);
                    fx.Connector.FailKeys = true;
                    // The plan reads engine data only; the stub is resolved when the result node's links are filled.
                    await assert.rejects(fx.Run('MATCH (a:Team {name: \'core\'}) RETURN a'), (e: unknown) => e instanceof ConnectorError && e.Phase === ConnectorPhase.Fetch);
                    assert.ok(fx.Connector.Requests.some(r => r.Keys !== undefined));
                    assert.deepEqual(FedFx.Col(await fx.Run('MATCH (b:Team {name: \'other\'}) RETURN b')), [FedFx.B]);
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
                    assert.deepEqual(FedFx.Col(out), [FedFx.T1, FedFx.T2]);
                    assert.deepEqual(FedFx.Col(out, 1), [FedFx.Core, FedFx.Other]);
                    assert.deepEqual(FedFx.NodeAt(out, 0).Node.Links, [{ Relationship: FedFx.TeamRel, PublicId: FedFx.A }]);
                    const reverse = await fx.Run('MATCH (a:Team {name: \'core\'})<-[:team]-(t) RETURN t');
                    assert.deepEqual(FedFx.Col(reverse), [FedFx.T1]);
                    const undirected = await fx.Run('MATCH (a:Team {name: \'core\'})-[:team]-(t) RETURN t');
                    assert.deepEqual(FedFx.Col(undirected), [FedFx.T1]);
                }
                finally
                {
                    await fx.dispose();
                }
                const blind = await FedFx.Open(storage(), { Reverse: false });
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

            it('an external link to an id neither stored nor fetched resolves in the row\'s model, else is dangling', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    // Honoured push-down: the scan returns t2 only, so its parent t1 is not fetched before the expand.
                    fx.Connector.Honour = true;
                    const r = await fx.Run('MATCH (t:Ticket {title: \'two\'})-[:parent]->(p) RETURN p, p.title');
                    assert.deepEqual(FedFx.Col(r), [FedFx.T1]);
                    assert.deepEqual(FedFx.Col(r, 1), [FedFx.One]);
                    assert.equal(FedFx.NodeAt(r, 0).Node.Owner, FedFx.Jira);
                    const lookup = fx.Connector.Requests.find(q => q.Keys !== undefined)!;
                    assert.deepEqual(lookup.Keys, [FedFx.T1]);
                    assert.equal(lookup.Model, FedFx.Jira);
                    assert.deepEqual(FedFx.Col(await fx.Run('MATCH (t:Ticket {title: \'three\'})-[:parent]->(p) RETURN p')), []);
                    const three = await fx.Run('MATCH (t:Ticket {title: \'three\'}) RETURN t');
                    assert.deepEqual(FedFx.NodeAt(three, 0).Node.Links, []);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('a fetched row whose id names a stored engine node is dropped, visible or hidden', async () =>
            {
                const collision = [FedFx.Row(FedFx.B, { title: FedFx.Dup, state: FedFx.OpenState }, { team: [FedFx.A] })];
                const plain = await FedFx.Open(storage());
                const clash = await FedFx.Open(storage(), { Extra: collision });
                try
                {
                    for (const scope of [AccessScope.System, FederatedSuite.CoreTeamOnly])
                    {
                        for (const query of FederatedSuite.CollisionQueries)
                        {
                            assert.equal(await clash.Dto(query, scope), await plain.Dto(query, scope), query);
                        }
                    }
                    const tickets = await clash.Run('MATCH (n:Ticket) RETURN n');
                    assert.ok(!FedFx.Col(tickets).includes(FedFx.B));
                    assert.ok(clash.Connector.Requests.length > 0);
                }
                finally
                {
                    await plain.dispose();
                    await clash.dispose();
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
                    await fx.LinkStub(FedFx.A, FedFx.X);
                    assert.deepEqual(FedFx.Col(await fx.Run('MATCH (a:Team)-[:assigned]->(t) RETURN t')), []);
                    const a = await fx.Run('MATCH (a:Team {name: \'core\'}) RETURN a');
                    assert.deepEqual(FedFx.NodeAt(a, 0).Node.Links, []);
                    // A stub the connector has resolves through a key lookup.
                    await fx.LinkStub(FedFx.A, FedFx.T3);
                    const live = await fx.Run('MATCH (a:Team)-[:assigned]->(t) RETURN t, t.title');
                    assert.deepEqual(FedFx.Col(live), [FedFx.T3]);
                    assert.deepEqual(FedFx.Col(live, 1), [FedFx.Three]);
                    assert.equal(FedFx.NodeAt(live, 0).Node.Owner, FedFx.Jira);
                    const linked = await fx.Run('MATCH (a:Team {name: \'core\'}) RETURN a');
                    assert.deepEqual(FedFx.NodeAt(linked, 0).Node.Links, [{ Relationship: FedFx.Assigned, PublicId: FedFx.T3 }]);
                    // Stubs never surface as engine data.
                    assert.deepEqual(FedFx.Col(await fx.Run('MATCH (n:Ticket) RETURN n ORDER BY n.title')), [FedFx.T1, FedFx.T3, FedFx.T2, FedFx.Local]);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('reverse traversal through stub', async () =>
            {
                const fx = await FedFx.Open(storage(), { Reverse: false });
                try
                {
                    await fx.LinkStub(FedFx.A, FedFx.T1);
                    const r = await fx.Run('MATCH (t:Ticket)<-[:assigned]-(a) RETURN t, a');
                    assert.deepEqual(FedFx.Col(r), [FedFx.T1]);
                    assert.deepEqual(FedFx.Col(r, 1), [FedFx.A]);
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
                    await fx.LinkStub(FedFx.A, FedFx.T1);
                    await fx.LinkStub(FedFx.A, FedFx.T2);
                    const out = await fx.Run('MATCH (a:Team)-[:assigned]->(t) RETURN t.title, t.secret', FederatedSuite.OpenOnly);
                    assert.deepEqual(FedFx.Col(out), [FedFx.One]);
                    assert.deepEqual(FedFx.Col(out, 1), [null]);
                    const back = await fx.Run('MATCH (t:Ticket)<-[:assigned]-(a) RETURN t.title, a.name', FederatedSuite.OpenOnly);
                    assert.deepEqual(FedFx.Col(back), [FedFx.One]);
                    const a = await fx.Run('MATCH (a:Team {name: \'core\'}) RETURN a', FederatedSuite.OpenOnly);
                    assert.deepEqual(FedFx.NodeAt(a, 0).Node.Links, [{ Relationship: FedFx.Assigned, PublicId: FedFx.T1 }]);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('key lookups and reverse fetches tick the probe', async () =>
            {
                const fx = await FedFx.Open(storage());
                try
                {
                    await fx.LinkStub(FedFx.A, FedFx.T1);
                    await fx.WithSource(async source =>
                    {
                        const out = new CountingProbe();
                        const targets: string[] = [];
                        for await (const row of source.Expand(FedFx.A, FedFx.Assigned, RelDirection.Outgoing, out)) targets.push(row.Target.PublicId);
                        assert.deepEqual(targets, [FedFx.T1]);
                        // One adjacency entry, then the key lookup's page and row.
                        assert.equal(out.Count, 3);
                    });
                    await fx.WithSource(async source =>
                    {
                        const back = new CountingProbe();
                        const sources: string[] = [];
                        for await (const row of source.Expand(FedFx.A, FedFx.TeamRel, RelDirection.Incoming, back)) sources.push(row.Target.PublicId);
                        assert.deepEqual(sources, [FedFx.T1]);
                        // No engine edge; the reverse fetch's page and row.
                        assert.equal(back.Count, 2);
                    });
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
                    await fx.LinkStub(FedFx.A, FedFx.T1);
                    const r = await fx.Run('MATCH (t:Ticket) WITH count(t) AS c MATCH (a:Team)-[:assigned]->(u) RETURN c, u');
                    assert.deepEqual(FedFx.Col(r, 1), [FedFx.T1]);
                    assert.equal(fx.Connector.Requests.filter(q => q.Keys !== undefined).length, 0);
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

// Compile-time: GraphReader's type exposes no unscoped federated read (they live behind FederatedReads.Of). The guarantee
// is type- and entry-level only: in-process code bypassing TypeScript privacy is out of the threat model (R101).
class NoUnscopedSurface
{
    /** Public method names that must not exist on a reader (a TS-private field is not a public member and is not checked). */
    public static readonly Names = ['FederatedLinks', 'StubIdentity', 'Connectors', 'StoredNonStub', 'Setup'];

    public static Check(reader: GraphReader): void
    {
        // @ts-expect-error not on GraphReader's public surface
        void reader.FederatedLinks;
        // @ts-expect-error not on GraphReader's public surface
        void reader.StubIdentity;
        // @ts-expect-error not on GraphReader's public surface
        void reader.Connectors;
        // @ts-expect-error TS-private, not on GraphReader's public type
        void reader.federated;
    }
}

describe('Federated read channel', () =>
{
    it('no exported type, member or entry name gives an unscoped federated read', async () =>
    {
        assert.equal('FederatedReads' in Root, false);
        assert.equal('FederatedSource' in Root, false);
        const fx = await FedFx.Open({ Kind: StorageKind.Memory });
        try
        {
            const reader = await fx.Engine.BeginRead(AccessScope.System);
            NoUnscopedSurface.Check(reader);
            const names = new Set<string>([...Object.getOwnPropertyNames(reader), ...Object.getOwnPropertyNames(Object.getPrototypeOf(reader))]);
            for (const name of NoUnscopedSurface.Names)
            {
                assert.equal(names.has(name), false, name);
                assert.equal(name in reader, false, name);
            }
            // The channel exists for engine code only and is closed with its reader.
            assert.ok(FederatedReads.Of(reader).Setup !== undefined);
            reader.dispose();
            await assert.rejects(FederatedReads.Of(reader).StubIdentity(FedFx.A), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.Disposed);
        }
        finally
        {
            await fx.dispose();
        }
    });
});

after(() => FedFx.RemoveDirs());
FederatedSuite.Register('Memory', () => ({ Kind: StorageKind.Memory }));
FederatedSuite.Register('LMDB', () => ({ Kind: StorageKind.Lmdb, Path: FedFx.Dir() }));
