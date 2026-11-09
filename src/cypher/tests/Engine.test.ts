import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessScope, FalsePredicate, IdIn, type GraphReader, type GraphTransaction, type ICommitApplied } from '../../index.js';
import { CypherCellCodec } from '../CypherCellCodec.js';
import { CypherEngine } from '../CypherEngine.js';
import { CypherSemanticError, CypherTimeout, CypherWriteError, CypherWriteErrorCode } from '../CypherError.js';
import { CypherNode } from '../CypherNode.js';
import { CypherQuery, Expr, Pattern, Return } from '../CypherQuery.js';
import { CypherResult } from '../CypherResult.js';
import { NodeValue, NullValue, ScalarValue } from '../CypherValue.js';
import type { ICancellation } from '../ExecutionLimits.js';
import { CypherWriteStats } from '../write/CypherWriteStats.js';
import { CypherFixture } from './CypherFixture.js';
import { EngineHarness } from './EngineHarness.js';
import { SequencePlacement } from './WriteFixture.js';

/** Element <- Service { name, owner tag, calls -> Service }: a (checkout, owned by 'm1') -calls-> b (ledger). */
class EngineFixture
{
    public static Open(): Promise<EngineHarness>
    {
        const F = CypherFixture;
        return EngineHarness.Open(
            [F.Concept('Element', []), F.Concept('Service', [F.Text('name'), F.Text('note'), F.Rel('calls', ['Service'])], 'Element')],
            [F.Node('a', 'Service', { name: 'checkout' }, [['calls', 'b']], 'm1'), F.Node('b', 'Service', { name: 'ledger' })]);
    }

    /** Records the readers / transactions the engine opens. */
    public static Spy(h: EngineHarness): { Readers: GraphReader[]; Transactions: GraphTransaction[] }
    {
        const engine = h.Fixture.Engine;
        const out = { Readers: [] as GraphReader[], Transactions: [] as GraphTransaction[] };
        const read = engine.BeginRead.bind(engine);
        const begin = engine.Begin.bind(engine);
        engine.BeginRead = async (scope: AccessScope) =>
        {
            const r = await read(scope);
            out.Readers.push(r);
            return r;
        };
        engine.Begin = async (scope: AccessScope) =>
        {
            const t = await begin(scope);
            out.Transactions.push(t);
            return t;
        };
        return out;
    }

    public static Commits(h: EngineHarness): ICommitApplied[]
    {
        const seen: ICommitApplied[] = [];
        h.Fixture.Engine.CommitApplied.Subscribe(c => seen.push(c));
        return seen;
    }

    public static Settle(): Promise<void>
    {
        return new Promise(resolve => setImmediate(resolve));
    }
}

/** Counts Expired() calls; expires once more than `budget` checks have passed. */
class CountingCancellation implements ICancellation
{
    public Calls = 0;

    constructor(private readonly budget: number = Number.POSITIVE_INFINITY)
    {
    }

    public Expired(): boolean
    {
        this.Calls++;
        return this.Calls > this.budget;
    }
}

describe('CypherEngine (integration)', () =>
{
    let h: EngineHarness;
    before(async () => { h = await EngineFixture.Open(); });
    after(() => h.dispose());

    test('end-to-end text query returns the expected table', async () =>
    {
        const result = await h.Execute("MATCH (a:Service)-[:calls]->(b:Service) WHERE a.name = 'checkout' RETURN b.name AS n");
        assert.deepEqual(result.Columns, ['n']);
        assert.deepEqual(result.Rows.map((r) => (r[0] as ScalarValue).Value), ['ledger']);
    });

    test('text and fluent front doors produce an identical result', async () =>
    {
        const text = await h.Execute("MATCH (a:Service)-[:calls]->(b:Service) WHERE a.name = 'checkout' RETURN b.name AS n");
        const fluent = await h.Execute(
            CypherQuery
                .Match(Pattern.Node('a').Label('Service').Out('calls', Pattern.Node('b').Label('Service')))
                .Where(Expr.Prop('a', 'name').Eq('checkout'))
                .Return(Return.Prop('b', 'name', 'n')),
        );
        assert.deepEqual(text.Columns, fluent.Columns);
        assert.deepEqual(text.Rows.map((r) => (r[0] as ScalarValue).Value), fluent.Rows.map((r) => (r[0] as ScalarValue).Value));
    });

    // TODL: "returned node projects to a ReflectedEntity through its reader"; the node now carries its properties.
    test('returned node carries its concept and properties', async () =>
    {
        const result = await h.Execute("MATCH (a:Service) WHERE a.name = 'checkout' RETURN a");
        const node = result.Rows[0]![0] as NodeValue;
        assert.equal(node.Concept, 'Service');
        assert.equal(node.Field('name'), 'checkout');
    });

    test('missing property reads as null in RETURN', async () =>
    {
        const result = await h.Execute("MATCH (a:Service) WHERE a.name = 'checkout' RETURN a.ghost AS g");
        assert.ok(result.Rows[0]![0] instanceof NullValue);
    });

    // TODL: "ToDto serializes node cells via the snapshot projector, under the $node discriminator".
    test('ToDto serializes node cells under the $node discriminator', async () =>
    {
        const dto = CypherEngine.ToDto(await h.Execute("MATCH (a:Service) WHERE a.name = 'checkout' RETURN a"));
        const cell = CypherCellCodec.AsNode(dto.Rows[0]![0])!;
        assert.equal(cell.id, 'a');
        assert.equal(cell.concept, 'Service');
    });

    test('inline property map folds into a filter end-to-end', async () =>
    {
        const result = await h.Execute("MATCH (a:Service {name: 'checkout'}) RETURN a.name AS n");
        assert.deepEqual(result.Rows.map((r) => (r[0] as ScalarValue).Value), ['checkout']);
    });

    test('relationship property maps are rejected', async () =>
    {
        await assert.rejects(h.Execute('MATCH (a:Service)-[:calls {weight: 1}]->(b:Service) RETURN a'), CypherSemanticError);
    });

    test('anonymous positional variables are not user-declared and are rejected', async () =>
    {
        await assert.rejects(h.Execute('MATCH (a:Service) RETURN __n0'), CypherSemanticError);
    });
});

describe('CypherEngine result nodes', () =>
{
    let h: EngineHarness;
    before(async () => { h = await EngineFixture.Open(); });
    after(() => h.dispose());

    test('node cell carries owner, properties, links', async () =>
    {
        const dto = CypherEngine.ToDto(await h.Execute("MATCH (a:Service {name: 'checkout'}) RETURN a"));
        assert.deepEqual(dto.Rows[0]![0], {
            $node: { id: 'a', concept: 'Service', owner: 'm1', properties: { name: 'checkout', note: null }, links: { calls: ['b'] } },
        });
        const b = CypherCellCodec.AsNode(CypherEngine.ToDto(await h.Execute("MATCH (b:Service {name: 'ledger'}) RETURN b")).Rows[0]![0])!;
        assert.equal(b.owner, '');
        assert.deepEqual(b.links, {});
    });

    test('links are read through the scoped reader: a hidden relationship is absent', async () =>
    {
        const scope = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([['Service', new Set(['calls'])]]) });
        const result = await h.Execute("MATCH (a:Service {name: 'checkout'}) RETURN a", undefined, undefined, scope);
        assert.deepEqual(CypherCellCodec.AsNode(CypherEngine.ToDto(result).Rows[0]![0])!.links, {});
    });

    test('nodes inside lists, maps and paths get their links, each distinct node read once', async () =>
    {
        const result = await h.Execute('MATCH p = (a:Service)-[:calls*1..1]->(b), (c:Service) RETURN a, [a, b] AS l, {k: c} AS m, p');
        assert.equal(result.Rows.length, 2);
        const dto = CypherEngine.ToDto(result);
        for (const row of dto.Rows)
        {
            const list = row[1] as unknown[];
            assert.deepEqual(CypherCellCodec.AsNode(list[0])!.links, { calls: ['b'] });
            assert.deepEqual(CypherCellCodec.AsNode(list[1])!.links, {});
            const path = row[3] as unknown as { nodes: unknown[] };
            assert.deepEqual(path.nodes.map((n) => CypherCellCodec.AsNode(n)!.links), [{ calls: ['b'] }, {}]);
            assert.ok(CypherCellCodec.AsNode(CypherCellCodec.AsMap(row[2])!['k']) !== undefined);
        }
    });

    test('Links is read once per distinct node per result', async () =>
    {
        const spy = EngineFixture.Spy(h);
        const calls: string[] = [];
        const engine = h.Fixture.Engine;
        const begin = engine.BeginRead;
        engine.BeginRead = async (scope: AccessScope) =>
        {
            const r = await begin(scope);
            const links = r.Links.bind(r);
            r.Links = (id, direction, relationship) =>
            {
                calls.push(id);
                return links(id, direction, relationship);
            };
            return r;
        };
        // A cartesian product: 4 rows, 8 node cells, 2 distinct nodes; the planner itself expands nothing.
        await h.Execute('MATCH (x:Service), (y:Service) RETURN x, y');
        assert.deepEqual(calls.sort(), ['a', 'b']);
        assert.equal(spy.Readers.length, 1);
    });

    test('result nodes come back filled; a node built outside the engine refuses to encode', async () =>
    {
        const result = await h.Execute("MATCH (a:Service {name: 'checkout'}) RETURN a");
        assert.throws(() => (result.Rows[0]![0] as NodeValue).Node.FillLinks([]), /already filled/);
        const loose = new CypherResult(['n'], [[new NodeValue(new CypherNode('z', 'Service', '', new Map()))]]);
        assert.throws(() => CypherEngine.ToDto(loose), /links filled/);
    });
});

describe('CypherEngine transactions', () =>
{
    test('a read query opens one reader and disposes it', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const spy = EngineFixture.Spy(h);
            await h.Execute('MATCH (a:Service) RETURN a');
            assert.equal(spy.Readers.length, 1);
            assert.equal(spy.Transactions.length, 0);
            await assert.rejects(spy.Readers[0]!.ReadNode('a'), /disposed/);
        }
        finally
        {
            await h.dispose();
        }
    });

    test('reader disposed after error', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const spy = EngineFixture.Spy(h);
            await assert.rejects(h.Execute('MATCH (a:Nope) RETURN a'), CypherSemanticError);
            await assert.rejects(h.Execute('MATCH (a:Service), (b:Service) RETURN a ORDER BY a.name', undefined, { Cancel: { Expired: () => true } }), CypherTimeout);
            assert.equal(spy.Readers.length, 2);
            for (const reader of spy.Readers)
            {
                await assert.rejects(reader.ReadNode('a'), /disposed/);
            }
        }
        finally
        {
            await h.dispose();
        }
    });

    test('write query commits once', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const spy = EngineFixture.Spy(h);
            const commits = EngineFixture.Commits(h);
            const result = await h.Cypher.Execute(AccessScope.System,
                "MATCH (a:Service {name: 'checkout'}) CREATE (a)-[:calls]->(n:Service {name: 'new'}) SET a.note = 'x' RETURN a, n",
                { Placement: new SequencePlacement('m2') });
            await EngineFixture.Settle();
            assert.equal(commits.length, 1);
            assert.equal(spy.Readers.length, 0);
            assert.equal(spy.Transactions.length, 1);
            await assert.rejects(spy.Transactions[0]!.ReadNode('a'), /disposed/);
            assert.equal(result.Stats?.NodesCreated, 1);
            assert.equal(result.Stats?.RelationshipsCreated, 1);
            // Links are filled through the query's own view: the new edge and the created node are there.
            const dto = CypherEngine.ToDto(result);
            assert.deepEqual(CypherCellCodec.AsNode(dto.Rows[0]![0])!.links, { calls: ['b', 'n0'] });
            assert.deepEqual(CypherCellCodec.AsNode(dto.Rows[0]![0])!.properties, { name: 'checkout', note: 'x' });
            assert.deepEqual(CypherCellCodec.AsNode(dto.Rows[0]![1])!, { id: 'n0', concept: 'Service', owner: 'm2', properties: { name: 'new', note: null }, links: {} });
            const after = await h.Execute("MATCH (a:Service {name: 'checkout'})-[:calls]->(x) RETURN x.name AS n ORDER BY n");
            assert.deepEqual(EngineHarness.Col(after), ['ledger', 'new']);
        }
        finally
        {
            await h.dispose();
        }
    });

    test('a failing write query commits nothing and disposes its transaction', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const spy = EngineFixture.Spy(h);
            const commits = EngineFixture.Commits(h);
            await assert.rejects(h.Execute('CREATE (n:Service {ghost: 1})'), CypherWriteError);
            await EngineFixture.Settle();
            assert.equal(commits.length, 0);
            assert.equal(spy.Transactions.length, 1);
            await assert.rejects(spy.Transactions[0]!.ReadNode('a'), /disposed/);
        }
        finally
        {
            await h.dispose();
        }
    });

    // TODL write-execute "RowCap/Skip do not truncate the apply drain" (deferred from Task 5).
    test('RowCap/Skip do not truncate the apply drain', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const r = await h.Execute("UNWIND [1,2,3,4,5] AS i CREATE (n:Service {name: 'x'})", undefined, { RowCap: 1, Skip: 1 });
            assert.equal(r.Stats?.NodesCreated, 5);
            assert.equal(r.Truncated, false);
            assert.equal(r.HasMore, false);
            assert.deepEqual(EngineHarness.Col(await h.Execute("MATCH (n:Service {name: 'x'}) RETURN count(n) AS c")), [5n]);
        }
        finally
        {
            await h.dispose();
        }
    });

    test('Explain renders read and write plans without reading, writing or beginning anything', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const spy = EngineFixture.Spy(h);
            const commits = EngineFixture.Commits(h);
            const read = h.Cypher.Explain("MATCH (a:Service)-[:calls]->(b) WHERE a.name = 'x' RETURN b");
            assert.match(read, /LabelScan/);
            assert.match(read, /Expand/);
            const write = h.Cypher.Explain("MATCH (a:Service) SET a.note = 'y' CREATE (a)-[:calls]->(:Service) RETURN a");
            assert.match(write, /SetOperator/);
            assert.match(write, /CreateOperator/);
            assert.match(write, /EagerBarrier/);
            assert.match(write, /LabelScan/);
            assert.match(h.Cypher.Explain(CypherQuery.Match(Pattern.Node('a').Label('Service')).Return(Return.Node('a'))), /LabelScan/);
            assert.throws(() => h.Cypher.Explain('MATCH (a:Nope) RETURN a'), CypherSemanticError);
            await EngineFixture.Settle();
            assert.equal(spy.Readers.length + spy.Transactions.length, 0);
            assert.equal(commits.length, 0);
        }
        finally
        {
            await h.dispose();
        }
    });
});

describe('CypherEngine under an access scope', () =>
{
    const OnlyA = (): AccessScope => AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([['Service', new IdIn(new Set(['a']))]]) });
    const NoNote = (): AccessScope => AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([['Service', new Set(['note'])]]) });

    // R85 (i) / R86 (b): a write query returns what it wrote even where the scope's Rows will hide it on later reads.
    test('a write result includes the nodes and links it created; later reads under the scope hide them', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const scope = OnlyA();
            const result = await h.Cypher.Execute(scope,
                "MATCH (a:Service {name: 'checkout'}) CREATE (a)-[:calls]->(n:Service {name: 'y'}) RETURN a, n", { Placement: new SequencePlacement() });
            const row = CypherEngine.ToDto(result).Rows[0]!;
            // b exists and a still calls it, but b is invisible: only the query-created n0 is in a's links.
            assert.deepEqual(CypherCellCodec.AsNode(row[0])!.links, { calls: ['n0'] });
            assert.equal(CypherCellCodec.AsNode(row[1])!.id, 'n0');
            const later = CypherEngine.ToDto(await h.Execute('MATCH (x:Service) RETURN x', undefined, undefined, scope));
            assert.deepEqual(later.Rows.map((r) => CypherCellCodec.AsNode(r[0])!.id), ['a']);
            assert.deepEqual(CypherCellCodec.AsNode(later.Rows[0]![0])!.links, {});
            assert.equal((await h.Execute("MATCH (x:Service {name: 'y'}) RETURN x", undefined, undefined, scope)).Rows.length, 0);
            const system = await h.Execute("MATCH (a:Service {name: 'checkout'})-[:calls]->(x) RETURN x.name AS n ORDER BY n");
            assert.deepEqual(EngineHarness.Col(system), ['ledger', 'y']);
        }
        finally
        {
            await h.dispose();
        }
    });

    test('a pre-existing invisible node never appears in a write result', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const scope = OnlyA();
            const matched = await h.Execute("MATCH (a:Service {name: 'checkout'}), (b:Service {name: 'ledger'}) CREATE (a)-[:calls]->(b) RETURN a, b", undefined, undefined, scope);
            assert.equal(matched.Rows.length, 0);
            assert.equal(matched.Stats?.RelationshipsCreated, 0);
            const set = CypherEngine.ToDto(await h.Execute("MATCH (a:Service {name: 'checkout'}) SET a.note = 'z' RETURN a, [a] AS l", undefined, undefined, scope));
            assert.deepEqual(CypherCellCodec.AsNode(set.Rows[0]![0])!.links, {});
            const merged = await h.Cypher.Execute(scope,
                "MATCH (a:Service {name: 'checkout'}) MERGE (a)-[:calls]->(x:Service {name: 'ledger'}) RETURN a, x", { Placement: new SequencePlacement() });
            const row = CypherEngine.ToDto(merged).Rows[0]!;
            assert.equal(CypherCellCodec.AsNode(row[1])!.id, 'n0');
            assert.deepEqual(CypherCellCodec.AsNode(row[0])!.links, { calls: ['n0'] });
        }
        finally
        {
            await h.dispose();
        }
    });

    test('a hidden property member is absent from node cells, on reads and writes', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const read = CypherEngine.ToDto(await h.Execute("MATCH (a:Service {name: 'checkout'}) RETURN a", undefined, undefined, NoNote()));
            assert.deepEqual(CypherCellCodec.AsNode(read.Rows[0]![0])!.properties, { name: 'checkout' });
            const write = await h.Cypher.Execute(NoNote(), "CREATE (n:Service {name: 'w'}) RETURN n", { Placement: new SequencePlacement() });
            assert.deepEqual(CypherCellCodec.AsNode(CypherEngine.ToDto(write).Rows[0]![0])!.properties, { name: 'w' });
        }
        finally
        {
            await h.dispose();
        }
    });

    test('a write the scope denies fails as Denied, commits nothing and disposes the transaction', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const spy = EngineFixture.Spy(h);
            const commits = EngineFixture.Commits(h);
            const scope = AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([['Service', { Create: FalsePredicate.Instance }]]) });
            await assert.rejects(h.Execute("CREATE (n:Service {name: 'no'})", undefined, undefined, scope),
                (e: unknown) => e instanceof CypherWriteError && e.WriteCode === CypherWriteErrorCode.Denied);
            await EngineFixture.Settle();
            assert.equal(commits.length, 0);
            await assert.rejects(spy.Transactions[0]!.ReadNode('a'), /disposed/);
            assert.equal((await h.Execute("MATCH (n:Service {name: 'no'}) RETURN n")).Rows.length, 0);
        }
        finally
        {
            await h.dispose();
        }
    });

    test('reader disposed after RowCap truncation', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const spy = EngineFixture.Spy(h);
            const r = await h.Execute('MATCH (a:Service) RETURN a', undefined, { RowCap: 1 });
            assert.equal(r.Truncated, true);
            assert.equal(CypherEngine.ToDto(r).Rows.length, 1);
            await assert.rejects(spy.Readers[0]!.ReadNode('a'), /disposed/);
        }
        finally
        {
            await h.dispose();
        }
    });

    test('an expired deadline aborts any query before it reads; the reader or transaction is disposed', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const spy = EngineFixture.Spy(h);
            const commits = EngineFixture.Commits(h);
            const expired = { Expired: () => true };
            // No buffering operator and no node cells: the scan and the collector still check the deadline.
            await assert.rejects(h.Execute('MATCH (a:Service) RETURN a.name AS n', undefined, { Cancel: expired }), CypherTimeout);
            await assert.rejects(h.Execute("CREATE (n:Service {name: 'late'}) RETURN n", undefined, { Cancel: expired }), CypherTimeout);
            await EngineFixture.Settle();
            assert.equal(commits.length, 0);
            await assert.rejects(spy.Readers[0]!.ReadNode('a'), /disposed/);
            await assert.rejects(spy.Transactions[0]!.ReadNode('a'), /disposed/);
        }
        finally
        {
            await h.dispose();
        }
    });

    test('the deadline applies to the link fill of a read; the reader is disposed', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const spy = EngineFixture.Spy(h);
            const scalars = new CountingCancellation();
            const nodes = new CountingCancellation();
            await h.Execute('MATCH (a:Service) RETURN a.name AS n', undefined, { Cancel: scalars });
            await h.Execute('MATCH (a:Service) RETURN a', undefined, { Cancel: nodes });
            // Node cells add exactly the fill's up-front check.
            assert.equal(nodes.Calls, scalars.Calls + 1);
            // A token that expires only after every check the query itself makes: only the fill can see it.
            await assert.rejects(h.Execute('MATCH (a:Service) RETURN a', undefined, { Cancel: new CountingCancellation(scalars.Calls) }), CypherTimeout);
            for (const reader of spy.Readers)
            {
                await assert.rejects(reader.ReadNode('a'), /disposed/);
            }
        }
        finally
        {
            await h.dispose();
        }
    });

    test('the deadline applies to the link fill of a write; nothing commits and the transaction is disposed', async () =>
    {
        const h = await EngineFixture.Open();
        try
        {
            const spy = EngineFixture.Spy(h);
            const scalars = new CountingCancellation();
            const nodes = new CountingCancellation();
            await h.Execute("CREATE (n:Service {name: 'one'}) RETURN n.name", undefined, { Cancel: scalars });
            await h.Execute("CREATE (n:Service {name: 'two'}) RETURN n", undefined, { Cancel: nodes });
            assert.equal(nodes.Calls, scalars.Calls + 1);
            await EngineFixture.Settle();
            const commits = EngineFixture.Commits(h);
            // Run's checks all pass; the fill's check (after Run, before Commit) expires.
            await assert.rejects(h.Execute("CREATE (n:Service {name: 'late'}) RETURN n", undefined, { Cancel: new CountingCancellation(scalars.Calls) }), CypherTimeout);
            await EngineFixture.Settle();
            assert.equal(commits.length, 0);
            await assert.rejects(spy.Transactions[2]!.ReadNode('a'), /disposed/);
            assert.equal((await h.Execute("MATCH (n:Service {name: 'late'}) RETURN n")).Rows.length, 0);
        }
        finally
        {
            await h.dispose();
        }
    });
});

// TODL write-stats "CypherResult stats" (deferred from Task 5).
describe('CypherResult stats', () =>
{
    test('a read result has no Stats key in its DTO', () =>
    {
        const dto = CypherEngine.ToDto(new CypherResult(['a'], []));
        assert.equal('Stats' in dto, false);
    });

    test('a write result carries Stats in its DTO', () =>
    {
        const dto = CypherEngine.ToDto(new CypherResult(['a'], [], false, false, new CypherWriteStats(1)));
        assert.equal(dto.Stats?.NodesCreated, 1);
    });
});
