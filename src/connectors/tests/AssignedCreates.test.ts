import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessScope } from '../../access/AccessScope.js';
import type { CellValue } from '../../columns/CellValue.js';
import { CypherFixture } from '../../cypher/tests/CypherFixture.js';
import { FederatedReads } from '../../FederatedReads.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { GraphEngine, type IEngineStorage, StorageKind } from '../../GraphEngine.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import type { ISchemaDescription } from '../../schema/SchemaDescription.js';
import { CommitError, CommitErrorCode } from '../../txn/CommitError.js';
import { ConnectorError, ConnectorPhase } from '../ConnectorError.js';
import type { IAssignedCreate } from '../GraphConnector.js';
import type { IFetchedRow, RowVersion } from '../FetchContract.js';
import { FakeExternalConnector } from './FakeExternalConnector.js';

/**
 * Source-assigned creates (ruling R136 E4) and the version ledger (R137 E5). `Order { id, total }` is external, bound
 * to connector `a` for model `ma` and `b` for model `mb`. `Account { orders -> Order }` is engine-stored; `e1` and
 * `eng1` are seeded engine Accounts. The fixture drives a GraphTransaction directly so CreateAssigned is exercised in
 * isolation, on MemoryStore and LMDB.
 */
class AssignFx
{
    private static readonly DirPrefix = 'pragmatic-graph-assigned-creates-';
    private static readonly Dirs: string[] = [];
    private static readonly Version = 'assigned-creates-v1';

    public static readonly Order = 'Order';
    public static readonly Account = 'Account';
    public static readonly Id = 'id';
    public static readonly Total = 'total';
    public static readonly Orders = 'orders';
    public static readonly ModelA = 'ma';
    public static readonly ModelB = 'mb';
    public static readonly A = 'a';
    public static readonly B = 'b';
    public static readonly Engine1 = 'e1';
    public static readonly EngineDup = 'eng1';

    private constructor(
        public readonly Engine: GraphEngine,
        public readonly A: FakeExternalConnector,
        public readonly B: FakeExternalConnector,
        public readonly Order: string[])
    {
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), AssignFx.DirPrefix));
        AssignFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of AssignFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    /** A fetched/created row of Order with the given id value and version. */
    public static Row(publicId: string, concept: string, values: ReadonlyMap<string, CellValue>, version?: RowVersion): IFetchedRow
    {
        return version === undefined
            ? { PublicId: publicId, Concept: concept, Values: values, Links: new Map() }
            : { PublicId: publicId, Concept: concept, Values: values, Links: new Map(), Version: version };
    }

    /** A CreateAssigned request for one Order held by `owner`, with no properties and no links. */
    public static Request(owner: string, properties: ReadonlyMap<string, CellValue> = new Map()): IAssignedCreate
    {
        return { Owner: owner, Concept: AssignFx.Order, Properties: properties, Links: [] };
    }

    public static async Open(storage: IEngineStorage): Promise<AssignFx>
    {
        const order: string[] = [];
        const a = new FakeExternalConnector(AssignFx.A, [[]], undefined, order);
        const b = new FakeExternalConnector(AssignFx.B, [[]], undefined, order);
        const engine = await GraphEngine.Open({ Description: AssignFx.Description(), Storage: storage, Connectors: [a, b] });
        return new AssignFx(engine, a, b, order);
    }

    public static Description(): ISchemaDescription
    {
        return {
            Version: AssignFx.Version,
            Definitions: [
                CypherFixture.Concept(AssignFx.Order, [CypherFixture.Int(AssignFx.Id), CypherFixture.Int(AssignFx.Total)]),
                CypherFixture.Concept(AssignFx.Account, [CypherFixture.Rel(AssignFx.Orders, [AssignFx.Order])]),
            ],
            Indexes: [],
            Seed: [CypherFixture.Node(AssignFx.Engine1, AssignFx.Account), CypherFixture.Node(AssignFx.EngineDup, AssignFx.Account)],
            Bindings: [
                { Model: AssignFx.ModelA, Concept: AssignFx.Order, Connector: AssignFx.A },
                { Model: AssignFx.ModelB, Concept: AssignFx.Order, Connector: AssignFx.B },
            ],
        };
    }

    public Begin(): Promise<GraphTransaction>
    {
        return this.Engine.Begin(AccessScope.System);
    }

    /** Fetches the external Order into the transaction's FetchSession, as a MATCH would. */
    public static async Fetch(t: GraphTransaction, publicId: string): Promise<void>
    {
        const channel = FederatedReads.Of(t);
        const setup = channel.Setup!;
        await channel.Session!.Lookup(publicId, setup.Bindings.ExternalTargets(AssignFx.Order, t.Catalog, setup.External));
    }

    public static async Rejection(work: Promise<unknown>): Promise<unknown>
    {
        try
        {
            await work;
        }
        catch (error)
        {
            return error;
        }
        assert.fail('expected a rejection');
    }

    public dispose(): Promise<void>
    {
        return this.Engine.dispose();
    }
}

type StorageFactory = () => IEngineStorage;

class AssignedCreatesSuite
{
    public static Register(name: string, storage: StorageFactory): void
    {
        describe(`Source-assigned creates (${name})`, () =>
        {
            it('assigned create returns the real id', async () =>
            {
                const fx = await AssignFx.Open(storage());
                fx.A.CreateOutcomes = [{ Row: AssignFx.Row('Order#ext.orders#41', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 41n]]), 1) }];
                const t = await fx.Begin();
                try
                {
                    const views = await t.CreateAssigned([AssignFx.Request(AssignFx.ModelA)]);
                    assert.equal(views.length, 1);
                    assert.equal(views[0]!.PublicId, 'Order#ext.orders#41');
                    assert.equal(views[0]!.External, true);
                    assert.equal(views[0]!.Properties.get(AssignFx.Id), 41n);
                    assert.equal(views[0]!.Version, 1);
                    await t.Commit();
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('later ops on an assigned create route external and are guarded', async () =>
            {
                const fx = await AssignFx.Open(storage());
                fx.A.CreateOutcomes = [{ Row: AssignFx.Row('ord1', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 1n]]), 5) }];
                const t = await fx.Begin();
                try
                {
                    await t.CreateAssigned([AssignFx.Request(AssignFx.ModelA)]);
                    t.SetProperty('ord1', AssignFx.Total, 9n);
                    await t.Flush();
                    assert.equal(fx.A.Executed.length, 1);
                    assert.equal(fx.A.Executed[0]!.Changes.Changes[0]!.ExpectedVersion, 5);
                    await t.Commit();
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('reported versions supersede fetched ones', async () =>
            {
                const fx = await AssignFx.Open(storage());
                fx.A.Pages = [[AssignFx.Row('o1', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 1n]]), 'v1')]];
                fx.A.Versions = new Map<string, RowVersion>([['o1', 'v2']]);
                const t = await fx.Begin();
                try
                {
                    await AssignFx.Fetch(t, 'o1');
                    t.SetProperty('o1', AssignFx.Total, 1n);
                    await t.Flush();
                    t.SetProperty('o1', AssignFx.Total, 2n);
                    await t.Flush();
                    assert.equal(fx.A.Executed.length, 2);
                    assert.equal(fx.A.Executed[0]!.Changes.Changes[0]!.ExpectedVersion, 'v1');
                    assert.equal(fx.A.Executed[1]!.Changes.Changes[0]!.ExpectedVersion, 'v2');
                    await t.Commit();
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('engine link to an assigned create is stored under the real id', async () =>
            {
                const fx = await AssignFx.Open(storage());
                fx.A.CreateOutcomes = [{ Row: AssignFx.Row('ord1', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 1n]]), 1) }];
                const t = await fx.Begin();
                try
                {
                    await t.CreateAssigned([AssignFx.Request(AssignFx.ModelA)]);
                    t.Link(AssignFx.Engine1, AssignFx.Orders, 'ord1', { ExternalTarget: { Concept: AssignFx.Order, Owner: AssignFx.ModelA } });
                    await t.Commit();
                }
                finally
                {
                    t.dispose();
                }
                const reader = await fx.Engine.BeginRead(AccessScope.System);
                try
                {
                    const links = await FederatedReads.Of(reader).Links(AssignFx.Engine1, EdgeDirection.Out, AssignFx.Orders);
                    assert.deepEqual(links.map(l => l.PublicId), ['ord1']);
                }
                finally
                {
                    reader.dispose();
                    await fx.dispose();
                }
            });

            it('invalid created row fails and compensates', async () =>
            {
                const fx = await AssignFx.Open(storage());
                // A returned row of another concept than the request's Order.
                fx.A.CreateOutcomes = [{ Row: AssignFx.Row('ord1', AssignFx.Account, new Map(), 1) }];
                const t = await fx.Begin();
                try
                {
                    const error = await AssignFx.Rejection(t.CreateAssigned([AssignFx.Request(AssignFx.ModelA)]));
                    assert.ok(error instanceof ConnectorError && error.Phase === ConnectorPhase.Write, String(error));
                    assert.ok(error.cause instanceof GraphError && error.cause.GraphCode === GraphErrorCode.SchemaViolation, String(error.cause));
                    assert.equal(fx.A.UndoCalls, 1);
                    assert.deepEqual(fx.A.Removed, ['ord1']);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('created id colliding with an engine node fails', async () =>
            {
                const fx = await AssignFx.Open(storage());
                fx.A.CreateOutcomes = [{ Row: AssignFx.Row(AssignFx.EngineDup, AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 1n]]), 1) }];
                const t = await fx.Begin();
                try
                {
                    const error = await AssignFx.Rejection(t.CreateAssigned([AssignFx.Request(AssignFx.ModelA)]));
                    assert.ok(error instanceof ConnectorError && error.Phase === ConnectorPhase.Write, String(error));
                    assert.ok(error.cause instanceof CommitError && error.cause.Code === CommitErrorCode.DuplicatePublicId, String(error.cause));
                    assert.equal(fx.A.UndoCalls, 1);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('connector without Create refuses', async () =>
            {
                const fx = await AssignFx.Open(storage());
                fx.A.SupportsCreate = false;
                const t = await fx.Begin();
                try
                {
                    const error = await AssignFx.Rejection(t.CreateAssigned([AssignFx.Request(AssignFx.ModelA)]));
                    assert.ok(error instanceof ConnectorError && error.Phase === ConnectorPhase.Write, String(error));
                    assert.ok(error.cause instanceof GraphError && error.cause.GraphCode === GraphErrorCode.Unsupported, String(error.cause));
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('assigned create flushes pending ops first', async () =>
            {
                const fx = await AssignFx.Open(storage());
                fx.A.Pages = [[AssignFx.Row('o1', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 1n]]), 'v1')]];
                fx.A.CreateOutcomes = [{ Row: AssignFx.Row('ord1', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 2n]]), 1) }];
                const t = await fx.Begin();
                try
                {
                    await AssignFx.Fetch(t, 'o1');
                    t.SetProperty('o1', AssignFx.Total, 7n);
                    await t.CreateAssigned([AssignFx.Request(AssignFx.ModelA)]);
                    // The pending SetProperty executed (Apply) before the Create (both steps on `a`, in that order).
                    assert.equal(fx.A.Executed.length, 1);
                    assert.equal(fx.A.CreateCalls.length, 1);
                    assert.deepEqual(fx.Order, [AssignFx.A, AssignFx.A]);
                    await t.Commit();
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('batched creates map outcomes by position', async () =>
            {
                const good = await AssignFx.Open(storage());
                good.A.CreateOutcomes = [
                    { Row: AssignFx.Row('ord1', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 1n]]), 1) },
                    { Row: AssignFx.Row('ord2', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 2n]]), 1) },
                    { Row: AssignFx.Row('ord3', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 3n]]), 1) },
                ];
                const t = await good.Begin();
                try
                {
                    const views = await t.CreateAssigned([AssignFx.Request(AssignFx.ModelA), AssignFx.Request(AssignFx.ModelA), AssignFx.Request(AssignFx.ModelA)]);
                    assert.deepEqual(views.map(v => v.PublicId), ['ord1', 'ord2', 'ord3']);
                    await t.Commit();
                }
                finally
                {
                    t.dispose();
                    await good.dispose();
                }
                // A connector returning two outcomes for three requests fails with GraphError Internal, and Undo runs.
                const bad = await AssignFx.Open(storage());
                bad.A.CreateOutcomes = [
                    { Row: AssignFx.Row('ord1', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 1n]]), 1) },
                    { Row: AssignFx.Row('ord2', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 2n]]), 1) },
                ];
                const t2 = await bad.Begin();
                try
                {
                    const error = await AssignFx.Rejection(t2.CreateAssigned([AssignFx.Request(AssignFx.ModelA), AssignFx.Request(AssignFx.ModelA), AssignFx.Request(AssignFx.ModelA)]));
                    assert.ok(error instanceof ConnectorError && error.Phase === ConnectorPhase.Write, String(error));
                    assert.ok(error.cause instanceof GraphError && error.cause.GraphCode === GraphErrorCode.Internal, String(error.cause));
                    assert.equal(bad.A.UndoCalls, 1);
                }
                finally
                {
                    t2.dispose();
                    await bad.dispose();
                }
            });

            it('one error outcome fails the step and undoes the rest', async () =>
            {
                const fx = await AssignFx.Open(storage());
                fx.A.CreateOutcomes = [
                    { Row: AssignFx.Row('ord1', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 1n]]), 1) },
                    { Error: new Error('the source refused this row') },
                    { Row: AssignFx.Row('ord3', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 3n]]), 1) },
                ];
                const t = await fx.Begin();
                try
                {
                    const error = await AssignFx.Rejection(t.CreateAssigned([AssignFx.Request(AssignFx.ModelA), AssignFx.Request(AssignFx.ModelA), AssignFx.Request(AssignFx.ModelA)]));
                    assert.ok(error instanceof ConnectorError && error.Phase === ConnectorPhase.Write, String(error));
                    assert.equal(fx.A.UndoCalls, 1);
                    // The fake removed exactly the two rows it created.
                    assert.deepEqual([...fx.A.Removed].sort(), ['ord1', 'ord3']);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('requests group by connector', async () =>
            {
                const fx = await AssignFx.Open(storage());
                fx.A.CreateOutcomes = [{ Row: AssignFx.Row('oa', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 1n]]), 1) }];
                fx.B.CreateOutcomes = [
                    { Row: AssignFx.Row('ob1', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 2n]]), 1) },
                    { Row: AssignFx.Row('ob2', AssignFx.Order, new Map<string, CellValue>([[AssignFx.Id, 3n]]), 1) },
                ];
                const t = await fx.Begin();
                try
                {
                    const views = await t.CreateAssigned([AssignFx.Request(AssignFx.ModelB), AssignFx.Request(AssignFx.ModelA), AssignFx.Request(AssignFx.ModelB)]);
                    assert.equal(fx.A.CreateCalls.length, 1);
                    assert.equal(fx.B.CreateCalls.length, 1);
                    assert.equal(fx.B.CreateCalls[0]!.length, 2);
                    assert.deepEqual(fx.Order, [AssignFx.A, AssignFx.B]);
                    assert.deepEqual(views.map(v => v.PublicId), ['ob1', 'oa', 'ob2']);
                    await t.Commit();
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });
        });
    }
}

after(() => AssignFx.RemoveDirs());
AssignedCreatesSuite.Register('Memory', () => ({ Kind: StorageKind.Memory }));
AssignedCreatesSuite.Register('LMDB', () => ({ Kind: StorageKind.Lmdb, Path: AssignFx.Dir() }));
