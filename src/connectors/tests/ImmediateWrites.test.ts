import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessDefault, AccessScope } from '../../access/AccessScope.js';
import { AccessError } from '../../access/AccessError.js';
import type { CellValue } from '../../columns/CellValue.js';
import { CypherFixture } from '../../cypher/tests/CypherFixture.js';
import { FederatedReads } from '../../FederatedReads.js';
import { GraphEngine, type IEngineStorage, StorageKind } from '../../GraphEngine.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { Compare, CompareOp, type Predicate } from '../../predicate/Predicate.js';
import type { ISchemaDescription } from '../../schema/SchemaDescription.js';
import { CommitError, CommitErrorCode } from '../../txn/CommitError.js';
import type { IFetchedRow } from '../FetchContract.js';
import { ConnectorError, ConnectorPhase } from '../ConnectorError.js';
import { FakeConnector } from './FakeConnector.js';
import { FakeExternalConnector } from './FakeExternalConnector.js';

/**
 * Item { id (required), state, link -> Item* } with model `ma` bound to external connector `a`, `mb` to external
 * `b` and `mm` to Mirrored connector `m`. Connector `a` holds x1 (open) and x2 (closed); `b` holds y1 (open). The
 * fixture drives a GraphTransaction directly so Flush and the final flush at Commit are exercised in isolation.
 */
class ImmFx
{
    private static readonly DirPrefix = 'pragmatic-graph-immediate-writes-';
    private static readonly Dirs: string[] = [];
    private static readonly Version = 'immediate-writes-v1';

    public static readonly Item = 'Item';
    public static readonly Id = 'id';
    public static readonly State = 'state';
    public static readonly Link = 'link';
    public static readonly ModelA = 'ma';
    public static readonly ModelB = 'mb';
    public static readonly ModelM = 'mm';
    public static readonly A = 'a';
    public static readonly B = 'b';
    public static readonly M = 'm';
    public static readonly X1 = 'x1';
    public static readonly X2 = 'x2';
    public static readonly Y1 = 'y1';
    public static readonly OpenState = 'open';
    public static readonly ClosedState = 'closed';
    public static readonly DoneState = 'done';

    private constructor(
        public readonly Engine: GraphEngine,
        public readonly ConnA: FakeExternalConnector,
        public readonly ConnB: FakeExternalConnector,
        public readonly Mirror: FakeConnector,
        public readonly Order: string[],
        public readonly MirrorLog: string[])
    {
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), ImmFx.DirPrefix));
        ImmFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of ImmFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Row(id: string, state: string): IFetchedRow
    {
        return { PublicId: id, Concept: ImmFx.Item, Values: new Map<string, CellValue>([[ImmFx.Id, id], [ImmFx.State, state]]), Links: new Map() };
    }

    public static async Open(storage: IEngineStorage): Promise<ImmFx>
    {
        const order: string[] = [];
        const log: string[] = [];
        const a = new FakeExternalConnector(ImmFx.A, [[ImmFx.Row(ImmFx.X1, ImmFx.OpenState), ImmFx.Row(ImmFx.X2, ImmFx.ClosedState)]], undefined, order);
        const b = new FakeExternalConnector(ImmFx.B, [[ImmFx.Row(ImmFx.Y1, ImmFx.OpenState)]], undefined, order);
        const m = new FakeConnector(ImmFx.M, log);
        const engine = await GraphEngine.Open({ Description: ImmFx.Description(), Storage: storage, Connectors: [a, b, m] });
        return new ImmFx(engine, a, b, m, order, log);
    }

    public static Description(): ISchemaDescription
    {
        return {
            Version: ImmFx.Version,
            Definitions: [
                CypherFixture.Concept(ImmFx.Item, [CypherFixture.Required(ImmFx.Id), CypherFixture.Text(ImmFx.State), CypherFixture.Rel(ImmFx.Link, [ImmFx.Item])]),
            ],
            Indexes: [],
            Seed: [],
            Bindings: [
                { Model: ImmFx.ModelA, Concept: ImmFx.Item, Connector: ImmFx.A },
                { Model: ImmFx.ModelB, Concept: ImmFx.Item, Connector: ImmFx.B },
                { Model: ImmFx.ModelM, Concept: ImmFx.Item, Connector: ImmFx.M },
            ],
        };
    }

    public Begin(scope: AccessScope = AccessScope.System): Promise<GraphTransaction>
    {
        return this.Engine.Begin(scope);
    }

    /** Fetches the external Item into the transaction's FetchSession, as a MATCH would. */
    public static async Fetch(t: GraphTransaction, publicId: string): Promise<void>
    {
        const channel = FederatedReads.Of(t);
        const setup = channel.Setup!;
        await channel.Session!.Lookup(publicId, setup.Bindings.ExternalTargets(ImmFx.Item, t.Catalog, setup.External));
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

class ImmediateWritesSuite
{
    /** Only open Items are visible. */
    private static readonly OpenOnly = AccessScope.Build({
        Default: AccessDefault.Allow,
        Rows: new Map<string, Predicate>([[ImmFx.Item, new Compare(ImmFx.State, CompareOp.Eq, ImmFx.OpenState)]]),
    });

    public static Register(name: string, storage: StorageFactory): void
    {
        describe(`Immediate external writes (${name})`, () =>
        {
            it('flush executes external ops now', async () =>
            {
                const fx = await ImmFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    await ImmFx.Fetch(t, ImmFx.X1);
                    t.SetProperty(ImmFx.X1, ImmFx.State, ImmFx.DoneState);
                    await t.Flush();
                    assert.equal(fx.ConnA.Executed.length, 1);
                    assert.equal(fx.ConnA.CommitCalls, 0);
                    await t.Commit();
                    assert.equal(fx.ConnA.Executed.length, 1);
                    assert.equal(fx.ConnA.CommitCalls, 1);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('ops on one id merge within a step', async () =>
            {
                const fx = await ImmFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    t.CreateNode('n1', ImmFx.Item, { Owner: ImmFx.ModelA });
                    t.SetProperty('n1', ImmFx.Id, 'n1');
                    t.SetProperty('n1', ImmFx.State, ImmFx.OpenState);
                    t.SetProperty('n1', ImmFx.State, ImmFx.DoneState);
                    await t.Flush();
                    assert.equal(fx.ConnA.Executed.length, 1);
                    assert.equal(fx.ConnA.Executed[0]!.Changes.Changes.length, 4);
                    await t.Commit();
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('commit flushes remaining ops', async () =>
            {
                const fx = await ImmFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    t.CreateNode('n1', ImmFx.Item, { Owner: ImmFx.ModelA });
                    t.SetProperty('n1', ImmFx.Id, 'n1');
                    await t.Commit();
                    assert.equal(fx.ConnA.Executed.length, 1);
                    assert.equal(fx.ConnA.CommitCalls, 1);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('steps are routed by connector in name order', async () =>
            {
                const fx = await ImmFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    t.CreateNode('nb', ImmFx.Item, { Owner: ImmFx.ModelB });
                    t.SetProperty('nb', ImmFx.Id, 'nb');
                    t.CreateNode('na', ImmFx.Item, { Owner: ImmFx.ModelA });
                    t.SetProperty('na', ImmFx.Id, 'na');
                    await t.Flush();
                    assert.deepEqual(fx.Order, [ImmFx.A, ImmFx.B]);
                    await t.Commit();
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('mirrored connectors still stage until commit', async () =>
            {
                const fx = await ImmFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    t.CreateNode('nm', ImmFx.Item, { Owner: ImmFx.ModelM });
                    t.SetProperty('nm', ImmFx.Id, 'nm');
                    await t.Flush();
                    assert.equal(fx.Mirror.Applied.length, 0);
                    assert.equal(fx.MirrorLog.includes('m.Begin'), false);
                    await t.Commit();
                    assert.equal(fx.Mirror.Applied.length, 1);
                    assert.deepEqual(fx.MirrorLog, ['m.Begin', 'm.Apply', 'm.Commit']);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('external commit only finalizes', async () =>
            {
                const fx = await ImmFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    await ImmFx.Fetch(t, ImmFx.X1);
                    t.SetProperty(ImmFx.X1, ImmFx.State, ImmFx.DoneState);
                    await t.Flush();
                    assert.equal(fx.ConnA.Executed.length, 1);
                    assert.equal(fx.ConnA.CommitCalls, 0);
                    await t.Commit();
                    // Commit called once after Prepare; it recorded no new remote effect.
                    assert.equal(fx.ConnA.CommitCalls, 1);
                    assert.equal(fx.ConnA.Executed.length, 1);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('required members are judged per create step', async () =>
            {
                const fx = await ImmFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    t.CreateNode('n1', ImmFx.Item, { Owner: ImmFx.ModelA });
                    t.SetProperty('n1', ImmFx.State, ImmFx.OpenState);
                    const error = await ImmFx.Rejection(t.Flush());
                    assert.ok(error instanceof CommitError && error.Code === CommitErrorCode.MissingRequired, String(error));
                    assert.equal(fx.ConnA.Executed.length, 0);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('gate runs per step', async () =>
            {
                const fx = await ImmFx.Open(storage());
                const t = await fx.Begin(ImmediateWritesSuite.OpenOnly);
                try
                {
                    await ImmFx.Fetch(t, ImmFx.X1);
                    t.SetProperty(ImmFx.X1, ImmFx.State, ImmFx.OpenState);
                    await t.Flush();
                    assert.equal(fx.ConnA.Executed.length, 1);
                    // x2 is closed, so invisible under OpenOnly: a write to it is denied in its own step.
                    t.SetProperty(ImmFx.X2, ImmFx.State, ImmFx.DoneState);
                    const error = await ImmFx.Rejection(t.Flush());
                    assert.ok(error instanceof AccessError, String(error));
                    assert.equal(fx.ConnA.Executed.length, 1);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('deleted id stays deleted across steps', async () =>
            {
                const fx = await ImmFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    await ImmFx.Fetch(t, ImmFx.X1);
                    t.DeleteNode(ImmFx.X1);
                    await t.Flush();
                    assert.equal(fx.ConnA.Executed.length, 1);
                    t.SetProperty(ImmFx.X1, ImmFx.State, ImmFx.DoneState);
                    const error = await ImmFx.Rejection(t.Flush());
                    assert.ok(error instanceof CommitError && error.Code === CommitErrorCode.UnknownNode, String(error));
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('step failure is ConnectorError Write', async () =>
            {
                const fx = await ImmFx.Open(storage());
                fx.ConnA.ThrowAtStep = 2;
                const t = await fx.Begin();
                try
                {
                    await ImmFx.Fetch(t, ImmFx.X1);
                    t.SetProperty(ImmFx.X1, ImmFx.State, ImmFx.OpenState);
                    await t.Flush();
                    t.SetProperty(ImmFx.X1, ImmFx.State, ImmFx.DoneState);
                    const error = await ImmFx.Rejection(t.Flush());
                    assert.ok(error instanceof ConnectorError && error.Phase === ConnectorPhase.Write, String(error));
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

after(() => ImmFx.RemoveDirs());
ImmediateWritesSuite.Register('Memory', () => ({ Kind: StorageKind.Memory }));
ImmediateWritesSuite.Register('LMDB', () => ({ Kind: StorageKind.Lmdb, Path: ImmFx.Dir() }));
