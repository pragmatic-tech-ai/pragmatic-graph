import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessDefault, AccessScope } from '../../access/AccessScope.js';
import { Compare, CompareOp, type Predicate } from '../../predicate/Predicate.js';
import type { CellValue } from '../../columns/CellValue.js';
import type { ConnectorChange } from '../../connectors/ConnectorChangeSet.js';
import { ConnectorContext } from '../../connectors/ConnectorContext.js';
import { ConnectorError, ConnectorPhase } from '../../connectors/ConnectorError.js';
import { PredicateKind } from '../../predicate/Predicate.js';
import { NodeEvaluator } from '../../predicate/NodeEvaluator.js';
import type { IFetchPage, IFetchRequest, IFetchedRow } from '../../connectors/FetchContract.js';
import type { IConnectorTransaction } from '../../connectors/GraphConnector.js';
import { FakeConnector } from '../../connectors/tests/FakeConnector.js';
import { FakeExternalConnector } from '../../connectors/tests/FakeExternalConnector.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { GraphEngine, StorageKind } from '../../GraphEngine.js';
import { CypherEngine } from '../CypherEngine.js';
import { CypherError } from '../CypherError.js';
import type { CypherResult } from '../CypherResult.js';
import { ScalarValue } from '../CypherValue.js';
import { CypherFixture } from './CypherFixture.js';

/** An External connector that records its writes (fetches as FakeExternalConnector). */
class TicketSystem extends FakeExternalConnector
{
    public readonly Log: string[] = [];
    public readonly Writes: FakeConnector;

    /** True: scans apply the pushed node-local predicate, as a push-down connector would. */
    public Honour = false;

    public constructor(name: string, rows: readonly IFetchedRow[])
    {
        super(name, [rows], { KeyLookup: true, ReverseLookup: true, PushDown: new Set([PredicateKind.Compare, PredicateKind.In, PredicateKind.And]) });
        this.Writes = new FakeConnector(name, this.Log);
    }

    public override async Fetch(request: IFetchRequest): Promise<IFetchPage>
    {
        const page = await super.Fetch(request);
        if (!this.Honour || request.Keys !== undefined || !request.Predicate.IsNodeLocal)
        {
            return page;
        }
        return { ...page, Rows: page.Rows.filter(r => NodeEvaluator.Matches(request.Predicate, r.Values, r.PublicId)) };
    }

    public override Begin(context: ConnectorContext): Promise<IConnectorTransaction>
    {
        return this.Writes.Begin(context);
    }

    public Changes(): readonly ConnectorChange[]
    {
        return this.Writes.Applied.flatMap(set => set.Changes);
    }

    /** The ids the applied changes name. */
    public ChangedIds(): string[]
    {
        return this.Changes().map(c => ('PublicId' in c ? c.PublicId : '')).sort();
    }
}

/** Customer { name, friend -> Customer* } bound to the External connector ext (rows c1, c2, and c3 named locked); engine Customers e1 -> e2. */
class IdFx
{
    private static readonly DirPrefix = 'pragmatic-graph-element-id-';
    private static readonly Dirs: string[] = [];
    public static readonly Customer = 'Customer';
    public static readonly Ids = 'ids';
    public static readonly Seek = 'IdSeek(';
    public static readonly Scan = 'LabelScan(';
    public static readonly Hidden = 'c3';
    public static readonly Invalid = 'bad';
    public static readonly Caller = 'alice';
    public static readonly SanitizedText = 'A fetched row failed validation';
    public static readonly ReadNames = 'MATCH (c:Customer) WHERE elementId(c) IN $ids RETURN c.name';
    public static readonly Rename = "MATCH (c:Customer) WHERE elementId(c) IN $ids SET c.name = 'x' RETURN elementId(c)";
    public static readonly HideEngine = AccessScope.Build({
        Default: AccessDefault.Allow,
        Rows: new Map<string, Predicate>([[IdFx.Customer, new Compare('name', CompareOp.Ne, 'engine')]]),
    });
    public static readonly OpenOnly = AccessScope.Build({
        Default: AccessDefault.Allow,
        Rows: new Map<string, Predicate>([[IdFx.Customer, new Compare('name', CompareOp.Ne, 'locked')]]),
    });

    private constructor(public readonly Engine: GraphEngine, public readonly Connector: TicketSystem, public readonly Cypher: CypherEngine)
    {
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), IdFx.DirPrefix));
        IdFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of IdFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    private static Row(id: string, name: string): IFetchedRow
    {
        return { PublicId: id, Concept: IdFx.Customer, Values: new Map<string, CellValue>([['name', name]]), Links: new Map() };
    }

    public static async Open(kind: StorageKind): Promise<IdFx>
    {
        const connector = new TicketSystem('ext', [IdFx.Row('c1', 'one'), IdFx.Row('c2', 'two'), IdFx.Row(IdFx.Hidden, 'locked')]);
        const engine = await GraphEngine.Open({
            Description: {
                Version: 'element-id-v1',
                Definitions: [CypherFixture.Concept(IdFx.Customer, [CypherFixture.Text('name'), CypherFixture.Rel('friend', [IdFx.Customer])])],
                Indexes: [],
                Seed: [CypherFixture.Node('e1', IdFx.Customer, { name: 'engine' }, [['friend', 'e2']]), CypherFixture.Node('e2', IdFx.Customer, { name: 'other' })],
                Bindings: [{ Model: 'crm', Concept: IdFx.Customer, Connector: 'ext' }],
            },
            Storage: kind === StorageKind.Lmdb ? { Kind: StorageKind.Lmdb, Path: IdFx.Dir() } : { Kind: StorageKind.Memory },
            Connectors: [connector],
        });
        return new IdFx(engine, connector, new CypherEngine(engine));
    }

    public Run(text: string, scope: AccessScope = AccessScope.System, ids?: string[]): Promise<CypherResult>
    {
        return this.Cypher.Execute(scope, text, ids === undefined ? {} : { Parameters: new Map([[IdFx.Ids, ids]]) });
    }

    /** A Customer row that fails validation: a value for the relationship friend. */
    public static InvalidRow(): IFetchedRow
    {
        return { PublicId: IdFx.Invalid, Concept: IdFx.Customer, Values: new Map<string, CellValue>([['friend', 'x']]), Links: new Map() };
    }

    public static Col(result: CypherResult): unknown[]
    {
        return result.Rows.map(r => (r[0] as ScalarValue).Value);
    }

    public dispose(): Promise<void>
    {
        return this.Engine.dispose();
    }
}

after(() => IdFx.RemoveDirs());

for (const kind of [StorageKind.Memory, StorageKind.Lmdb])
{
    describe(`Cypher elementId and by-id seek (${StorageKind[kind]})`, () =>
    {
        it('elementId returns the public id', async () =>
        {
            const fx = await IdFx.Open(kind);
            try
            {
                const result = await fx.Run("MATCH (c:Customer) WHERE c.name = 'engine' RETURN elementId(c)");
                assert.deepEqual(IdFx.Col(result), ['e1']);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('by-id match seeks engine nodes', async () =>
        {
            const fx = await IdFx.Open(kind);
            try
            {
                const plan = fx.Cypher.Explain('MATCH (c:Customer) WHERE elementId(c) IN $ids RETURN c.name');
                assert.ok(plan.includes(IdFx.Seek) && !plan.includes(IdFx.Scan), plan);
                const result = await fx.Run('MATCH (c:Customer) WHERE elementId(c) IN $ids RETURN c.name', AccessScope.System, ['e1', 'nope', 'e1']);
                assert.deepEqual(IdFx.Col(result), ['engine']);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('by-id match looks up external rows', async () =>
        {
            const fx = await IdFx.Open(kind);
            try
            {
                const before = fx.Connector.Requests.length;
                await fx.Run(IdFx.Rename, AccessScope.System, ['c1', 'c2']);
                const requests = fx.Connector.Requests.slice(before);
                assert.equal(requests.length, 1);
                assert.deepEqual(requests[0]!.Keys, ['c1', 'c2']);
                assert.deepEqual(fx.Connector.ChangedIds(), ['c1', 'c2']);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('by-id match is scoped', async () =>
        {
            const fx = await IdFx.Open(kind);
            try
            {
                const result = await fx.Run(IdFx.Rename, IdFx.OpenOnly, ['c1', IdFx.Hidden]);
                assert.deepEqual(IdFx.Col(result), ['c1']);
                assert.deepEqual(fx.Connector.ChangedIds(), ['c1']);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('by-id match never sends an engine id to a connector', async () =>
        {
            const fx = await IdFx.Open(kind);
            try
            {
                const result = await fx.Run(IdFx.Rename, IdFx.HideEngine, ['e1', 'c1']);
                assert.deepEqual(IdFx.Col(result), ['c1']);
                assert.ok(fx.Connector.Requests.every(r => !(r.Keys ?? []).includes('e1')));
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('property IN a parameter list survives a pushed filter', async () =>
        {
            const fx = await IdFx.Open(kind);
            try
            {
                fx.Connector.Honour = true;
                const query = "MATCH (c:Customer) WHERE c.name IN $ids SET c.name = 'x' RETURN elementId(c)";
                const result = await fx.Run(query, AccessScope.System, ['one', 'two']);
                assert.deepEqual(IdFx.Col(result).sort(), ['c1', 'c2']);
                assert.deepEqual(fx.Connector.ChangedIds(), ['c1', 'c2']);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('IN a parameter is null for null and a type error for a non-list', async () =>
        {
            const fx = await IdFx.Open(kind);
            try
            {
                const query = "RETURN 'a' IN $p AS r";
                const nullResult = await fx.Cypher.Execute(AccessScope.System, query, { Parameters: new Map([['p', null]]) });
                assert.equal(nullResult.Rows[0]![0]!.constructor.name, 'NullValue');
                const nullLhs = await fx.Cypher.Execute(AccessScope.System, 'RETURN null IN $p AS r', { Parameters: new Map([['p', 5n]]) }).catch((e: unknown) => e);
                assert.ok(nullLhs instanceof CypherError);
                await assert.rejects(fx.Cypher.Execute(AccessScope.System, query, { Parameters: new Map([['p', 5n]]) }), CypherError);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('by-id seek fetches with the caller context and fails without naming the row (R133)', async () =>
        {
            const fx = await IdFx.Open(kind);
            try
            {
                const context = ConnectorContext.For(IdFx.Caller);
                const run = (ids: string[]) => fx.Cypher.Execute(IdFx.OpenOnly, IdFx.ReadNames, { Parameters: new Map([[IdFx.Ids, ids]]), Connector: context });
                const before = fx.Connector.Requests.length;
                assert.deepEqual(IdFx.Col(await run(['c1', IdFx.Hidden])), ['one']);
                assert.ok(fx.Connector.Requests.slice(before).every(r => r.Context === context));
                fx.Connector.Pages = [[...fx.Connector.Pages.flat(), IdFx.InvalidRow()]];
                const error = await run([IdFx.Invalid]).catch((e: unknown) => e);
                assert.ok(error instanceof ConnectorError && error.Phase === ConnectorPhase.Fetch, String(error));
                assert.ok(error.cause instanceof GraphError && error.cause.GraphCode === GraphErrorCode.SchemaViolation);
                assert.equal(error.cause.message, IdFx.SanitizedText);
                assert.equal(error.cause.cause, undefined);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('elementId of a relationship is a type error', async () =>
        {
            const fx = await IdFx.Open(kind);
            try
            {
                await assert.rejects(fx.Run('MATCH (a:Customer)-[r:friend]->(b) RETURN elementId(r)'), CypherError);
            }
            finally
            {
                await fx.dispose();
            }
        });
    });
}
