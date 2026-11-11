import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessDefault, AccessScope } from '../../access/AccessScope.js';
import { AccessError, AccessErrorCode } from '../../access/AccessError.js';
import type { CellValue } from '../../columns/CellValue.js';
import { CypherFixture } from '../../cypher/tests/CypherFixture.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { GraphEngine, type IEngineStorage, StorageKind } from '../../GraphEngine.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { And, Compare, CompareOp, IdIn, type Predicate } from '../../predicate/Predicate.js';
import type { ISchemaDescription } from '../../schema/SchemaDescription.js';
import { WriteOp } from '../../txn/WriteBatch.js';
import type { ConnectorChange } from '../ConnectorChangeSet.js';
import { ConnectorError, ConnectorPhase } from '../ConnectorError.js';
import type { IConnectorCapabilities, IFetchedRow, RowVersion } from '../FetchContract.js';
import type { IConnectorTransaction } from '../GraphConnector.js';
import { FakeConnector, FakeStep } from './FakeConnector.js';
import { FakeExternalConnector } from './FakeExternalConnector.js';

/** An External connector that also takes writes: fetches as FakeExternalConnector, writes through a recording FakeConnector. */
class CrmSystem extends FakeExternalConnector
{
    private static readonly BeginEntry = '.' + FakeStep.Begin;
    public readonly Log: string[] = [];
    public readonly Writes: FakeConnector;

    public constructor(name: string, rows: readonly IFetchedRow[], capabilities: IConnectorCapabilities)
    {
        super(name, [rows], capabilities);
        this.Writes = new FakeConnector(name, this.Log);
    }

    public override Begin(): Promise<IConnectorTransaction>
    {
        return this.Writes.Begin();
    }

    public get BeginCount(): number
    {
        return this.Log.filter(entry => entry === this.Name + CrmSystem.BeginEntry).length;
    }

    public Changes(): readonly ConnectorChange[]
    {
        return this.Writes.Applied.flatMap(set => set.Changes);
    }
}

/**
 * Customer { name, region, secret } of model crm is bound to the External connector ext; Account { name, customer ->
 * Customer* } is engine data. Engine: Account a1, Customers e1 (eu) and e2 (us). The connector holds c1 (eu, v7), c2
 * (us), c3, c4, c5 (eu) and a row for e1. The scope sees eu Customers only and hides `secret`.
 */
class FetchFx
{
    private static readonly DirPrefix = 'pragmatic-graph-transaction-fetch-';
    private static readonly Dirs: string[] = [];
    private static readonly SchemaVersion = 'transaction-fetch-v1';
    public static readonly Customer = 'Customer';
    public static readonly Account = 'Account';
    public static readonly Crm = 'crm';
    public static readonly Ext = 'ext';
    public static readonly Name = 'name';
    public static readonly Region = 'region';
    public static readonly Secret = 'secret';
    public static readonly CustomerRel = 'customer';
    public static readonly Eu = 'eu';
    public static readonly Us = 'us';
    public static readonly Local = 'local';
    public static readonly Remote = 'remote';
    public static readonly Renamed = 'renamed';
    public static readonly A1 = 'a1';
    public static readonly C1 = 'c1';
    public static readonly C2 = 'c2';
    public static readonly C3 = 'c3';
    public static readonly C4 = 'c4';
    public static readonly C5 = 'c5';
    public static readonly E1 = 'e1';
    public static readonly E2 = 'e2';
    public static readonly Bad = 'bad-row-id';
    public static readonly Nobody = 'nobody';
    public static readonly V7 = 'v7';
    public static readonly V8 = 'v8';

    public static readonly Scope = AccessScope.Build({
        Default: AccessDefault.Allow,
        Rows: new Map<string, Predicate>([[FetchFx.Customer, new Compare(FetchFx.Region, CompareOp.Eq, FetchFx.Eu)]]),
        Hidden: new Map([[FetchFx.Customer, new Set([FetchFx.Secret])]]),
    });

    private constructor(public readonly Engine: GraphEngine, public readonly Connector: CrmSystem)
    {
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), FetchFx.DirPrefix));
        FetchFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of FetchFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Row(id: string, region: string, version?: RowVersion, name: string = id): IFetchedRow
    {
        const values = new Map<string, CellValue>([[FetchFx.Name, name], [FetchFx.Region, region], [FetchFx.Secret, FetchFx.Secret]]);
        const row = { PublicId: id, Concept: FetchFx.Customer, Values: values, Links: new Map() };
        return version === undefined ? row : { ...row, Version: version };
    }

    public static async Open(storage: IEngineStorage, keyLookup: boolean): Promise<FetchFx>
    {
        const capabilities = { KeyLookup: keyLookup, ReverseLookup: true, PushDown: new Set<never>() };
        const connector = new CrmSystem(FetchFx.Ext, [
            FetchFx.Row(FetchFx.C1, FetchFx.Eu, FetchFx.V7),
            FetchFx.Row(FetchFx.C2, FetchFx.Us),
            FetchFx.Row(FetchFx.C3, FetchFx.Eu),
            FetchFx.Row(FetchFx.C4, FetchFx.Eu),
            FetchFx.Row(FetchFx.C5, FetchFx.Eu),
            FetchFx.Row(FetchFx.E1, FetchFx.Eu, undefined, FetchFx.Remote),
            { ...FetchFx.Row(FetchFx.Bad, FetchFx.Eu), Values: new Map<string, CellValue>([[FetchFx.Region, 5]]) },
        ], capabilities);
        const engine = await GraphEngine.Open({ Description: FetchFx.Description(), Storage: storage, Connectors: [connector] });
        return new FetchFx(engine, connector);
    }

    private static Description(): ISchemaDescription
    {
        return {
            Version: FetchFx.SchemaVersion,
            Definitions: [
                CypherFixture.Concept(FetchFx.Customer, [CypherFixture.Text(FetchFx.Name), CypherFixture.Text(FetchFx.Region), CypherFixture.Text(FetchFx.Secret)]),
                CypherFixture.Concept(FetchFx.Account, [CypherFixture.Text(FetchFx.Name), CypherFixture.Rel(FetchFx.CustomerRel, [FetchFx.Customer])]),
            ],
            Indexes: [],
            Seed: [
                CypherFixture.Node(FetchFx.A1, FetchFx.Account, { name: FetchFx.A1 }),
                CypherFixture.Node(FetchFx.E1, FetchFx.Customer, { name: FetchFx.Local, region: FetchFx.Eu, secret: FetchFx.Secret }),
                CypherFixture.Node(FetchFx.E2, FetchFx.Customer, { name: FetchFx.Local, region: FetchFx.Us }),
            ],
            Bindings: [{ Model: FetchFx.Crm, Concept: FetchFx.Customer, Connector: FetchFx.Ext }],
        };
    }

    /** A Customer key of the crm model. */
    public static Key(publicId: string): { PublicId: string; Concept: string }
    {
        return { PublicId: publicId, Concept: FetchFx.Customer };
    }

    /** Runs `work` on a transaction under the fixture's scope, then disposes it. */
    public async With<T>(work: (t: GraphTransaction) => Promise<T>, scope: AccessScope = FetchFx.Scope): Promise<T>
    {
        const t = await this.Engine.Begin(scope);
        try
        {
            return await work(t);
        }
        finally
        {
            t.dispose();
        }
    }

    public static IsInvisible(error: unknown): boolean
    {
        return error instanceof AccessError && error.Code === AccessErrorCode.InvisibleNode;
    }

    public dispose(): Promise<void>
    {
        return this.Engine.dispose();
    }
}

type StorageFactory = () => IEngineStorage;

class TransactionFetchSuite
{
    public static Register(name: string, storage: StorageFactory): void
    {
        describe(`GraphTransaction.Fetch (${name})`, () =>
        {
            const run = (work: (fx: FetchFx) => Promise<void>, keyLookup: boolean = true) => async () =>
            {
                const fx = await FetchFx.Open(storage(), keyLookup);
                try
                {
                    await work(fx);
                }
                finally
                {
                    await fx.dispose();
                }
            };

            it('fetch then update of an external node via the transaction API succeeds', run(async fx =>
            {
                await fx.With(async t =>
                {
                    const fetched = await t.Fetch([FetchFx.Key(FetchFx.C1)]);
                    assert.equal(fetched.get(FetchFx.C1)?.External, true);
                    t.SetProperty(FetchFx.C1, FetchFx.Name, FetchFx.Renamed);
                    await t.Commit();
                });
                const changes = fx.Connector.Changes();
                assert.equal(changes.length, 1);
                assert.ok(changes[0]!.Op === WriteOp.SetProperty && changes[0]!.PublicId === FetchFx.C1);
            }));

            it('write without a fetch is still refused', run(async fx =>
            {
                await assert.rejects(fx.With(async t =>
                {
                    t.SetProperty(FetchFx.C1, FetchFx.Name, FetchFx.Renamed);
                    await t.Commit();
                }), FetchFx.IsInvisible);
                assert.equal(fx.Connector.BeginCount, 0);
            }));

            it('out-of-scope id is not returned', run(async fx =>
            {
                await assert.rejects(fx.With(async t =>
                {
                    const fetched = await t.Fetch([FetchFx.Key(FetchFx.C1), FetchFx.Key(FetchFx.C2)]);
                    assert.deepEqual([...fetched.keys()], [FetchFx.C1]);
                    assert.equal(fetched.get(FetchFx.C1)!.Properties.has(FetchFx.Secret), false);
                    t.SetProperty(FetchFx.C2, FetchFx.Name, FetchFx.Renamed);
                    await t.Commit();
                }), FetchFx.IsInvisible);
                assert.equal(fx.Connector.BeginCount, 0);
            }));

            it('fetched version becomes ExpectedVersion and is memoised for the session', run(async fx =>
            {
                await fx.With(async t =>
                {
                    assert.equal((await t.Fetch([FetchFx.Key(FetchFx.C1)])).get(FetchFx.C1)!.Version, FetchFx.V7);
                    const requests = fx.Connector.Requests.length;
                    fx.Connector.Pages = [[FetchFx.Row(FetchFx.C1, FetchFx.Eu, FetchFx.V8)]];
                    assert.equal((await t.Fetch([FetchFx.Key(FetchFx.C1)])).get(FetchFx.C1)!.Version, FetchFx.V7);
                    assert.equal(fx.Connector.Requests.length, requests);
                    t.SetProperty(FetchFx.C1, FetchFx.Name, FetchFx.Renamed);
                    await t.Commit();
                });
                assert.equal(fx.Connector.Changes()[0]!.ExpectedVersion, FetchFx.V7);
            }));

            it('batch fetch makes one request per candidate', run(async fx =>
            {
                const fetched = await fx.With(t => t.Fetch([FetchFx.Key(FetchFx.C1), FetchFx.Key(FetchFx.C3), FetchFx.Key(FetchFx.C4)]));
                assert.deepEqual([...fetched.keys()], [FetchFx.C1, FetchFx.C3, FetchFx.C4]);
                assert.equal(fx.Connector.Requests.length, 1);
                assert.deepEqual(fx.Connector.Requests[0]!.Keys, [FetchFx.C1, FetchFx.C3, FetchFx.C4]);
            }));

            it('stub resolves through its identity, and its data is still not served by ReadNode', run(async fx =>
            {
                await fx.With(async t =>
                {
                    t.Link(FetchFx.A1, FetchFx.CustomerRel, FetchFx.C5, { ExternalTarget: { Concept: FetchFx.Customer, Owner: FetchFx.Crm } });
                    await t.Commit();
                }, AccessScope.System);
                await fx.With(async t =>
                {
                    const view = (await t.Fetch([FetchFx.C5])).get(FetchFx.C5);
                    assert.equal(view?.External, true);
                    assert.equal(view?.Owner, FetchFx.Crm);
                    assert.equal(await t.ReadNode(FetchFx.C5), undefined);
                });
            }));

            it('unstubbed id without concept is absent and fetches nothing', run(async fx =>
            {
                assert.equal((await fx.With(t => t.Fetch([FetchFx.C1]))).size, 0);
                assert.equal(fx.Connector.Requests.length, 0);
            }));

            it('engine node is served scoped and owns its id', run(async fx =>
            {
                const fetched = await fx.With(t => t.Fetch([{ ...FetchFx.Key(FetchFx.E1), Owner: FetchFx.Crm }, FetchFx.Key(FetchFx.E2)]));
                assert.deepEqual([...fetched.keys()], [FetchFx.E1]);
                const e1 = fetched.get(FetchFx.E1)!;
                assert.equal(e1.External, false);
                assert.equal(e1.Version, undefined);
                assert.equal(e1.Properties.get(FetchFx.Name), FetchFx.Local);
                assert.equal(e1.Properties.has(FetchFx.Secret), false);
                assert.equal(fx.Connector.Requests.length, 0);
            }));

            it('without KeyLookup the scope is pushed down and an Owner filters the candidates', run(async fx =>
            {
                const fetched = await fx.With(t => t.Fetch([{ ...FetchFx.Key(FetchFx.C1), Owner: FetchFx.Crm }, { ...FetchFx.Key(FetchFx.C3), Owner: FetchFx.Nobody }]));
                assert.deepEqual([...fetched.keys()], [FetchFx.C1]);
                assert.equal(fx.Connector.Requests.length, 1);
                const request = fx.Connector.Requests[0]!;
                assert.equal(request.Keys, undefined);
                const [scoped, ids] = (request.Predicate as And).Terms;
                assert.ok(scoped instanceof Compare && scoped.Member === FetchFx.Region && scoped.Value === FetchFx.Eu);
                assert.ok(ids instanceof IdIn && [...ids.Ids].join() === FetchFx.C1);
            }, false));

            it('identical keys collapse and different keys for one id are refused', run(async fx =>
            {
                await fx.With(async t =>
                {
                    assert.equal((await t.Fetch([FetchFx.Key(FetchFx.C1), FetchFx.Key(FetchFx.C1)])).size, 1);
                    assert.deepEqual(fx.Connector.Requests.map(r => r.Keys), [[FetchFx.C1]]);
                    await assert.rejects(t.Fetch([FetchFx.C1, FetchFx.Key(FetchFx.C1)]), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
                });
            }));

            it('an invalid fetched row fails the fetch without naming the id', run(async fx =>
            {
                const error = await fx.With(t => t.Fetch([FetchFx.Key(FetchFx.Bad)])).then(() => undefined, (e: unknown) => e);
                assert.ok(error instanceof ConnectorError && error.Phase === ConnectorPhase.Fetch, String(error));
                const cause = error.cause;
                assert.ok(cause instanceof GraphError && cause.GraphCode === GraphErrorCode.SchemaViolation && cause.cause === undefined);
                const text = error.message + cause.message;
                assert.ok(!text.includes(FetchFx.Bad) && !text.includes(FetchFx.Customer) && !text.includes(FetchFx.Region), text);
            }));

            it('fetch after commit is disposed', run(async fx =>
            {
                await fx.With(async t =>
                {
                    await t.Commit();
                    await assert.rejects(t.Fetch([FetchFx.C1]), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.Disposed);
                });
            }));
        });
    }
}

after(() => FetchFx.RemoveDirs());
TransactionFetchSuite.Register('Memory', () => ({ Kind: StorageKind.Memory }));
TransactionFetchSuite.Register('LMDB', () => ({ Kind: StorageKind.Lmdb, Path: FetchFx.Dir() }));
