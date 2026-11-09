import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessScope, ConflictError, IdIn, type GraphTransaction } from '../../index.js';
import { ReaderSource } from '../ReaderSource.js';
import { CypherSemanticError } from '../CypherError.js';
import { RelDirection } from '../CypherEnums.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';

/**
 * aspect Asset { tag, peers -> Server }; Server carries Asset { name, secret, hosts -> Server };
 * Blade : Server; Laptop carries Asset { name }; Person { name, owns -> Server|Laptop };
 * infra.Switch, infra.Rack, net.Rack (dotted names for label resolution).
 * Seed: s1 hosts s2, b1 and peers s2; s2 peers itself; p1 owns s1, l1.
 */
class SourceFx
{
    public static readonly Asset = 'Asset';
    public static readonly Server = 'Server';
    public static readonly Blade = 'Blade';
    public static readonly Laptop = 'Laptop';
    public static readonly Person = 'Person';
    public static readonly Name = 'name';
    public static readonly Secret = 'secret';
    public static readonly Hosts = 'hosts';
    public static readonly Peers = 'peers';
    public static readonly Owns = 'owns';
    public static readonly ScanOrder = ['s1', 's2', 'b1', 'l1', 'p1', 'w1', 'r1', 'r2'];

    public static Open(): Promise<CypherFixture>
    {
        const F = CypherFixture;
        const X = SourceFx;
        return F.Open(
            [
                F.Aspect(X.Asset, [F.Text('tag'), F.Rel(X.Peers, [X.Server])]),
                F.Concept(X.Server, [F.Text(X.Name), F.Text(X.Secret), F.Rel(X.Hosts, [X.Server])], null, [X.Asset]),
                F.Concept(X.Blade, [], X.Server),
                F.Concept(X.Laptop, [F.Text(X.Name)], null, [X.Asset]),
                F.Concept(X.Person, [F.Text(X.Name), F.Rel(X.Owns, [X.Server, X.Laptop])]),
                F.Concept('infra.Switch', [F.Text(X.Name)]),
                F.Concept('infra.Rack', []),
                F.Concept('net.Rack', []),
            ],
            [
                F.Node('s1', X.Server, { name: 'alpha', secret: 'x1', tag: 't1' }, [[X.Hosts, 's2'], [X.Hosts, 'b1'], [X.Peers, 's2']]),
                F.Node('s2', X.Server, { name: 'beta', secret: 'x2' }, [[X.Peers, 's2']]),
                F.Node('b1', X.Blade, { name: 'blade' }),
                F.Node('l1', X.Laptop, { name: 'lap' }),
                F.Node('p1', X.Person, { name: 'ada' }, [[X.Owns, 's1'], [X.Owns, 'l1']]),
                F.Node('w1', 'infra.Switch', { name: 'sw' }),
                F.Node('r1', 'infra.Rack'),
                F.Node('r2', 'net.Rack'),
            ]);
    }

    /** Hides s2 (Server rows other than s1 and b1). */
    public static WithoutS2(): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[SourceFx.Server, new IdIn(new Set(['s1', 'b1']))]]) });
    }

    public static HidingHosts(): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[SourceFx.Server, new Set([SourceFx.Hosts])]]) });
    }

    public static HidingSecret(): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[SourceFx.Server, new Set([SourceFx.Secret])]]) });
    }
}

describe('ReaderSource and read queries over the engine', () =>
{
    let fx: CypherFixture;
    before(async () => { fx = await SourceFx.Open(); });
    after(async () => { await fx.dispose(); });

    test('aspect label scans carriers', async () =>
    {
        // Server (and its subtype Blade) and Laptop carry Asset; Person does not.
        assert.deepEqual(await fx.Column('MATCH (a:Asset) RETURN a', 'a'), ['s1', 's2', 'b1', 'l1']);
        assert.deepEqual(await fx.Column('MATCH (s:Server) RETURN s', 's'), ['s1', 's2', 'b1']);
    });

    test('simple-name label resolves', async () =>
    {
        assert.deepEqual(await fx.Column('MATCH (w:Switch) RETURN w', 'w'), ['w1']);
        assert.deepEqual(await fx.Column('MATCH (w:infra.Switch) RETURN w', 'w'), ['w1']);
        assert.deepEqual(await fx.Column('MATCH (r:net.Rack) RETURN r', 'r'), ['r2']);
        assert.equal(await fx.Read(async s => s.ResolveLabel('Switch')), 'infra.Switch');
    });

    test('ambiguous simple name throws', async () =>
    {
        await assert.rejects(fx.Rows('MATCH (r:Rack) RETURN r'), (e: unknown) =>
            e instanceof CypherSemanticError && e.message === 'ambiguous label "Rack": infra.Rack, net.Rack');
        await assert.rejects(fx.Rows('MATCH (g:Ghost) RETURN g'), (e: unknown) =>
            e instanceof CypherSemanticError && e.message === 'unknown label "Ghost"');
    });

    test('expand skips invisible targets', async () =>
    {
        const typed = "MATCH (a:Server {name: 'alpha'})-[:hosts]->(b) RETURN b";
        const untyped = "MATCH (a:Server {name: 'alpha'})-->(b) RETURN b";
        assert.deepEqual(await fx.Column(typed, 'b'), ['s2', 'b1']);
        assert.deepEqual(await fx.Column(typed, 'b', SourceFx.WithoutS2()), ['b1']);
        assert.deepEqual(await fx.Column(untyped, 'b', SourceFx.WithoutS2()), ['b1']);
        assert.deepEqual(await fx.Column('MATCH (s:Server) RETURN s', 's', SourceFx.WithoutS2()), ['s1', 'b1']);
        assert.equal(await fx.Read(s => s.Node('s2'), SourceFx.WithoutS2()), undefined);
    });

    test('count excludes invisible', async () =>
    {
        const q = 'MATCH (a:Server)-[:hosts]->(b) RETURN count(b) AS c';
        assert.deepEqual(await fx.Column(q, 'c'), [2n]);
        assert.deepEqual(await fx.Column(q, 'c', SourceFx.WithoutS2()), [1n]);
        assert.deepEqual(await fx.Column('MATCH (a:Asset) RETURN count(*) AS c', 'c', SourceFx.WithoutS2()), [3n]);
    });

    test('hidden member reads null in RETURN', async () =>
    {
        const q = "MATCH (s:Server {name: 'alpha'}) RETURN s.secret AS x, s.name AS n";
        assert.deepEqual(await fx.Rows(q), [new Map<string, unknown>([['x', 'x1'], ['n', 'alpha']])]);
        assert.deepEqual(await fx.Rows(q, SourceFx.HidingSecret()), [new Map<string, unknown>([['x', null], ['n', 'alpha']])]);
        // A predicate over the hidden member sees null too, so it matches nothing.
        assert.deepEqual(await fx.Rows("MATCH (s:Server) WHERE s.secret = 'x1' RETURN s", SourceFx.HidingSecret()), []);
    });

    test('expand target label matches by IsA including aspects', async () =>
    {
        assert.deepEqual(await fx.Column('MATCH (p:Person)-[:owns]->(a:Asset) RETURN a', 'a'), ['s1', 'l1']);
        assert.deepEqual(await fx.Column('MATCH (p:Person)-[:owns]->(a:Server) RETURN a', 'a'), ['s1']);
    });

    test('label filter on a reused variable matches by IsA including aspects', async () =>
    {
        assert.deepEqual(await fx.Column('MATCH (p:Person)-[:owns]->(a), (a:Asset) RETURN a', 'a'), ['s1', 'l1']);
        assert.deepEqual(await fx.Column('MATCH (p:Person)-[:owns]->(a), (a:Laptop) RETURN a', 'a'), ['l1']);
    });

    test('variable-length target label matches by IsA including aspects', async () =>
    {
        assert.deepEqual(await fx.Column('MATCH (p:Person)-[*1..2]->(x:Blade) RETURN x', 'x'), ['b1']);
        assert.deepEqual((await fx.Column('MATCH (p:Person)-[*1..2]->(x:Asset) RETURN DISTINCT x', 'x')).sort(), ['b1', 'l1', 's1', 's2']);
    });

    test('untyped expand walks every relationship in declaration order and names it', async () =>
    {
        // Effective member order: the carried aspect's peers before Server's own hosts; edge order within each.
        assert.deepEqual(await fx.Column("MATCH (a:Server {name: 'alpha'})-[r]->(b) RETURN r", 'r'),
            ['s1-peers->s2', 's1-hosts->s2', 's1-hosts->b1']);
        assert.deepEqual(await fx.Column('MATCH (b:Blade)<-[r]-(x) RETURN r', 'r'), ['s1-hosts->b1']);
    });

    test('undirected expand walks out then in and reports a self-loop once', async () =>
    {
        assert.deepEqual(await fx.Column("MATCH (a:Server {name: 'beta'})-[:peers]-(b) RETURN b", 'b'), ['s2', 's1']);
        const rows = await fx.Read(async s =>
        {
            const out: string[] = [];
            for await (const row of s.Expand('s2', SourceFx.Peers, RelDirection.Undirected))
            {
                out.push(`${row.Relationship}:${row.Target.PublicId}`);
            }
            return out;
        });
        assert.deepEqual(rows, ['peers:s2', 'peers:s1']);
    });

    test('result order without ORDER BY follows scan order and is stable', async () =>
    {
        const first = await fx.Column('MATCH (n) RETURN n', 'n');
        assert.deepEqual(first, SourceFx.ScanOrder);
        assert.deepEqual(await fx.Column('MATCH (n) RETURN n', 'n'), first);
    });

    test('integer SKIP and LIMIT window the scan order', async () =>
    {
        // Integer literals are Int64 (bigint, R81 a); the planner accepts them as counts.
        assert.deepEqual(await fx.Column('MATCH (n) RETURN n SKIP 1 LIMIT 2', 'n'), ['s2', 'b1']);
        await assert.rejects(fx.Rows("MATCH (n) RETURN n LIMIT 'x'"), CypherSemanticError);
    });

    test('optional match pads with null and expand-into constrains a reused target', async () =>
    {
        assert.deepEqual(await fx.Rows('MATCH (p:Person) OPTIONAL MATCH (p)<-[:hosts]-(x) RETURN p, x'), [new Map<string, unknown>([['p', 'p1'], ['x', null]])]);
        assert.deepEqual(await fx.Rows('MATCH (a)-[:hosts]->(b), (a)-[:peers]->(b) RETURN a, b'), [new Map<string, unknown>([['a', 's1'], ['b', 's2']])]);
        await assert.rejects(fx.Rows('MATCH (p:Person) OPTIONAL MATCH (p)-->(x:Ghost) RETURN x'), CypherSemanticError);
    });

    test('aggregation and ORDER BY run over engine rows', async () =>
    {
        assert.deepEqual(await fx.Rows('MATCH (a:Server)-[:hosts]->(b) RETURN a.name AS n, count(b) AS c ORDER BY c DESC'),
            [new Map<string, unknown>([['n', 'alpha'], ['c', 2n]])]);
        assert.deepEqual(await fx.Rows('MATCH (a:Asset)-[:peers]->(b) RETURN a.name AS n, count(b) AS c ORDER BY n DESC'),
            [new Map<string, unknown>([['n', 'beta'], ['c', 1n]]), new Map<string, unknown>([['n', 'alpha'], ['c', 1n]])]);
    });

    test('a hidden relationship is absent from typed, untyped, incoming and variable-length expands', async () =>
    {
        const scope = SourceFx.HidingHosts();
        assert.deepEqual(await fx.Column("MATCH (a:Server {name: 'alpha'})-[:hosts]->(b) RETURN b", 'b', scope), []);
        assert.deepEqual(await fx.Column("MATCH (a:Server {name: 'alpha'})-[r]->(b) RETURN r", 'r', scope), ['s1-peers->s2']);
        assert.deepEqual(await fx.Column('MATCH (b:Blade)<-[:hosts]-(x) RETURN x', 'x', scope), []);
        assert.deepEqual(await fx.Column("MATCH (a:Server {name: 'alpha'})-[:hosts*1..3]->(x) RETURN x", 'x', scope), []);
    });

    test('variable-length expand does not pass through an invisible node', async () =>
    {
        // With s2 invisible, s1's peers and hosts edges to s2 are gone; only s1 -hosts-> b1 continues the walk.
        assert.deepEqual(await fx.Column('MATCH (p:Person)-[*1..4]->(x:Server) RETURN x', 'x', SourceFx.WithoutS2()), ['s1', 'b1']);
        assert.deepEqual(await fx.Column('MATCH (p:Person)-[*1..4]->(x) RETURN x', 'x', SourceFx.WithoutS2()), ['s1', 'b1', 'l1']);
    });

    test('optional match to an invisible target pads with null', async () =>
    {
        const q = "MATCH (a:Server {name: 'alpha'}) OPTIONAL MATCH (a)-[:peers]->(x) RETURN a, x";
        assert.deepEqual(await fx.Rows(q), [new Map<string, unknown>([['a', 's1'], ['x', 's2']])]);
        assert.deepEqual(await fx.Rows(q, SourceFx.WithoutS2()), [new Map<string, unknown>([['a', 's1'], ['x', null]])]);
    });

    test('source surface: relationships, IsA, nodes and no index seek yet', async () =>
    {
        await fx.Read(async s =>
        {
            assert.equal(s.HasRelationship(SourceFx.Hosts), true);
            assert.equal(s.HasRelationship(SourceFx.Peers), true);
            assert.equal(s.HasRelationship(SourceFx.Name), false);
            const blade = await s.Node('b1');
            assert.ok(blade !== undefined);
            assert.equal(blade.Concept, SourceFx.Blade);
            assert.equal(s.IsA(blade, SourceFx.Asset), true);
            assert.equal(s.IsA(blade, SourceFx.Server), true);
            assert.equal(s.IsA(blade, SourceFx.Laptop), false);
            assert.equal(await s.Node('nope'), undefined);
            assert.equal(s.SeekEqual(SourceFx.Server, SourceFx.Name, 'alpha'), undefined);
        });
    });
});

describe('ReaderSource read recording', () =>
{
    test('a typed expand records only that relationship', async () =>
    {
        const fx = await SourceFx.Open();
        try
        {
            const engine = fx.Engine;
            const commit = async (work: (t: GraphTransaction) => void): Promise<void> =>
            {
                const t = await engine.Begin(AccessScope.System);
                work(t);
                await t.Commit();
            };
            const expandHosts = async (t: GraphTransaction): Promise<string[]> =>
            {
                const out: string[] = [];
                for await (const row of new ReaderSource(t).Expand('s1', SourceFx.Hosts, RelDirection.Outgoing))
                {
                    out.push(row.Target.PublicId);
                }
                return out;
            };

            // A concurrent link on another relationship of the same node does not conflict...
            const t1 = await engine.Begin(AccessScope.System);
            assert.deepEqual(await expandHosts(t1), ['s2', 'b1']);
            await commit(t => t.Link('s1', SourceFx.Peers, 'b1'));
            t1.SetProperty('l1', SourceFx.Name, 'lap2');
            await t1.Commit();

            // ...one on the same relationship does.
            const t2 = await engine.Begin(AccessScope.System);
            assert.deepEqual(await expandHosts(t2), ['s2', 'b1']);
            await commit(t => t.Link('s1', SourceFx.Hosts, 's1'));
            t2.SetProperty('l1', SourceFx.Name, 'lap3');
            await assert.rejects(t2.Commit(), ConflictError);
        }
        finally
        {
            await fx.dispose();
        }
    });
});

// A relationship name declared by several concepts: A.r -> P and B.r -> [T, P], with T : P. Incoming edges of t come
// from both declarations; every In-shaped expand must find each source exactly once.
describe('a relationship declared by several concepts', () =>
{
    let h: EngineHarness;
    before(async () =>
    {
        const F = CypherFixture;
        h = await EngineHarness.Open(
            [F.Concept('P', []), F.Concept('T', [], 'P'), F.Concept('A', [F.Rel('r', ['P'])]), F.Concept('B', [F.Rel('r', ['T', 'P'])])],
            [F.Node('t', 'T'), F.Node('p', 'P'), F.Node('a', 'A', {}, [['r', 't']]), F.Node('b', 'B', {}, [['r', 't'], ['r', 'p']])]);
    });
    after(() => h.dispose());

    test('In, undirected and var-length In expands from t return exactly a and b', async () =>
    {
        const queries = [
            'MATCH (t:T)<-[:r]-(x) RETURN x',
            'MATCH (t:T)-[:r]-(x) RETURN x',
            'MATCH (t:T)<-[:r*1..2]-(x) RETURN x',
            'MATCH (t:T)<-[:r*1]-(x) RETURN x',
        ];
        for (const q of queries)
        {
            assert.deepEqual(EngineHarness.Col(await h.Execute(q)).sort(), ['a', 'b'], q);
        }
        assert.equal((await h.Execute('MATCH (p:P)<-[:r]-(x) RETURN p, x')).Rows.length, 3);
        assert.deepEqual(EngineHarness.Col(await h.Execute('MATCH (x)-[:r]->(t:T) RETURN x')).sort(), ['a', 'b']);
    });

    test('the write overlay agrees: the In expand sees both declarations plus the edge the query adds', async () =>
    {
        const q = 'MATCH (t:T) CREATE (:A)-[:r]->(t) WITH t MATCH (t)<-[:r]-(x) RETURN count(x) AS c, count(DISTINCT x) AS d';
        assert.deepEqual(EngineHarness.Pairs(await h.Execute(q)), [[3n, 3n]]);
        for (const shape of ['MATCH (t:T)<-[:r]-(x) RETURN x', 'MATCH (t:T)-[:r]-(x) RETURN x', 'MATCH (t:T)<-[:r*1..2]-(x) RETURN x'])
        {
            assert.equal((await h.Execute(shape)).Rows.length, 3, shape);
        }
    });
});
