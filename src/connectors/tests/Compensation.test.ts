import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessScope } from '../../access/AccessScope.js';
import type { CellValue } from '../../columns/CellValue.js';
import { CypherFixture } from '../../cypher/tests/CypherFixture.js';
import { GraphErrorCode } from '../../errors/GraphError.js';
import { GraphEngine, type IEngineStorage, StorageKind } from '../../GraphEngine.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import type { ISchemaDescription } from '../../schema/SchemaDescription.js';
import { ConflictError } from '../../txn/ConflictError.js';
import { TransactionDroppedError } from '../../txn/TransactionDroppedError.js';
import { ConnectorContext } from '../ConnectorContext.js';
import { ConnectorOutcome, type IConnectorApplied } from '../ConnectorApplied.js';
import { ConnectorError, ConnectorPhase } from '../ConnectorError.js';
import type { IFetchedRow } from '../FetchContract.js';
import { FakeConnector, FakeStep } from './FakeConnector.js';
import { FakeExternalConnector } from './FakeExternalConnector.js';

/**
 * Item { id (required), state, link -> Item* } with model `ma` bound to External connector `a`, `mb` to External `b`
 * and `mm` to Mirrored connector `m`; a node created with no owner is engine-stored. The fixture drives a
 * GraphTransaction directly and captures the ConnectorApplied, ConnectorRevertFailed and TransactionDropped signals, so
 * compensation, abort, outcomes and the dropped path can be asserted in isolation (ruling R137 E6, R138 E7).
 */
class CompFx
{
    private static readonly DirPrefix = 'pragmatic-graph-compensation-';
    private static readonly Dirs: string[] = [];
    private static readonly Version = 'compensation-v1';

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
    public static readonly OpenState = 'open';
    public static readonly Done = 'done';
    public static readonly Other = 'other';

    private constructor(
        public readonly Engine: GraphEngine,
        public readonly ConnA: FakeExternalConnector,
        public readonly ConnB: FakeExternalConnector,
        public readonly Mirror: FakeConnector,
        public readonly UndoOrder: string[],
        public readonly RevertOrder: string[],
        public readonly MirrorLog: string[],
        public readonly Applied: IConnectorApplied[],
        public readonly RevertFailed: ConnectorError[],
        public readonly Dropped: TransactionDroppedError[])
    {
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), CompFx.DirPrefix));
        CompFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of CompFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Row(id: string, state: string): IFetchedRow
    {
        return { PublicId: id, Concept: CompFx.Item, Values: new Map<string, CellValue>([[CompFx.Id, id], [CompFx.State, state]]), Links: new Map() };
    }

    public static async Open(storage: IEngineStorage, timeoutMs?: number): Promise<CompFx>
    {
        const undoOrder: string[] = [];
        const revertOrder: string[] = [];
        const mirrorLog: string[] = [];
        const a = new FakeExternalConnector(CompFx.A, [[CompFx.Row('x1', CompFx.OpenState)]]);
        const b = new FakeExternalConnector(CompFx.B, [[CompFx.Row('y1', CompFx.OpenState)]]);
        a.UndoOrder = undoOrder;
        b.UndoOrder = undoOrder;
        a.RevertOrder = revertOrder;
        b.RevertOrder = revertOrder;
        const m = new FakeConnector(CompFx.M, mirrorLog);
        const options = timeoutMs === undefined
            ? { Description: CompFx.Description(), Storage: storage, Connectors: [a, b, m] }
            : { Description: CompFx.Description(), Storage: storage, Connectors: [a, b, m], PrepareTimeoutMs: timeoutMs };
        const engine = await GraphEngine.Open(options);
        const applied: IConnectorApplied[] = [];
        const revertFailed: ConnectorError[] = [];
        const dropped: TransactionDroppedError[] = [];
        engine.ConnectorApplied.Subscribe(c => applied.push(c));
        engine.ConnectorRevertFailed.Subscribe(e => revertFailed.push(e));
        engine.TransactionDropped.Subscribe(e => dropped.push(e));
        return new CompFx(engine, a, b, m, undoOrder, revertOrder, mirrorLog, applied, revertFailed, dropped);
    }

    public static Description(): ISchemaDescription
    {
        return {
            Version: CompFx.Version,
            Definitions: [
                CypherFixture.Concept(CompFx.Item, [CypherFixture.Required(CompFx.Id), CypherFixture.Text(CompFx.State), CypherFixture.Rel(CompFx.Link, [CompFx.Item])]),
            ],
            Indexes: [],
            Seed: [],
            Bindings: [
                { Model: CompFx.ModelA, Concept: CompFx.Item, Connector: CompFx.A },
                { Model: CompFx.ModelB, Concept: CompFx.Item, Connector: CompFx.B },
                { Model: CompFx.ModelM, Concept: CompFx.Item, Connector: CompFx.M },
            ],
        };
    }

    public Begin(context?: ConnectorContext): Promise<GraphTransaction>
    {
        return context === undefined ? this.Engine.Begin(AccessScope.System) : this.Engine.Begin(AccessScope.System, { Connector: context });
    }

    /** Creates an engine-stored Item (no owner) and commits it. */
    public async EngineNode(id: string, state: string): Promise<void>
    {
        const t = await this.Engine.Begin(AccessScope.System);
        t.CreateNode(id, CompFx.Item);
        t.SetProperty(id, CompFx.Id, id);
        t.SetProperty(id, CompFx.State, state);
        await t.Commit();
        t.dispose();
    }

    /** Records a create of an external Item on `model` with id `id`; it executes at the next Flush/Commit. */
    public static External(t: GraphTransaction, model: string, id: string): void
    {
        t.CreateNode(id, CompFx.Item, { Owner: model });
        t.SetProperty(id, CompFx.Id, id);
    }

    public async StateOf(id: string): Promise<CellValue | undefined>
    {
        const r = await this.Engine.BeginRead(AccessScope.System);
        try
        {
            return await r.GetProperty(id, CompFx.State);
        }
        finally
        {
            r.dispose();
        }
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

class CompensationSuite
{
    public static Register(name: string, storage: StorageFactory): void
    {
        describe(`Compensation of immediate external writes (${name})`, () =>
        {
            it('abort compensates executed steps in reverse order', async () =>
            {
                const fx = await CompFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    CompFx.External(t, CompFx.ModelA, 'na1');
                    await t.Flush();
                    CompFx.External(t, CompFx.ModelB, 'nb');
                    await t.Flush();
                    CompFx.External(t, CompFx.ModelA, 'na2');
                    await t.Flush();
                    // Recorded but never flushed: it must not execute.
                    CompFx.External(t, CompFx.ModelA, 'nc');
                    await t.Abort();
                    assert.deepEqual(fx.UndoOrder, [CompFx.A, CompFx.B, CompFx.A]);
                    assert.equal(fx.ConnA.Executed.length, 2);
                    assert.equal(fx.ConnB.Executed.length, 1);
                    assert.equal(fx.Applied.length, 1);
                    assert.equal(fx.Applied[0]!.Outcome, ConnectorOutcome.Compensated);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('engine conflict at prepare compensates external steps', async () =>
            {
                const fx = await CompFx.Open(storage());
                await fx.EngineNode('e1', CompFx.OpenState);
                const t = await fx.Begin();
                try
                {
                    await t.GetProperty('e1', CompFx.State);
                    CompFx.External(t, CompFx.ModelA, 'na');
                    await t.Flush();
                    CompFx.External(t, CompFx.ModelB, 'nb');
                    await t.Flush();
                    t.SetProperty('e1', CompFx.State, CompFx.Done);
                    // A concurrent commit changes the key this transaction read.
                    const other = await fx.Begin();
                    other.SetProperty('e1', CompFx.State, CompFx.Other);
                    await other.Commit();
                    other.dispose();
                    const error = await CompFx.Rejection(t.Commit());
                    assert.ok(error instanceof ConflictError, String(error));
                    assert.equal(fx.ConnA.UndoCalls, 1);
                    assert.equal(fx.ConnB.UndoCalls, 1);
                    assert.equal(await fx.StateOf('e1'), CompFx.Other);
                    assert.equal(fx.Applied.length, 1);
                    assert.equal(fx.Applied[0]!.Outcome, ConnectorOutcome.Compensated);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('step failure compensates earlier steps', async () =>
            {
                const fx = await CompFx.Open(storage());
                fx.ConnA.ThrowAtStep = 2;
                const t = await fx.Begin();
                try
                {
                    CompFx.External(t, CompFx.ModelA, 'na1');
                    await t.Flush();
                    CompFx.External(t, CompFx.ModelB, 'nb');
                    await t.Flush();
                    CompFx.External(t, CompFx.ModelA, 'na2');
                    const error = await CompFx.Rejection(t.Flush());
                    assert.ok(error instanceof ConnectorError && error.Phase === ConnectorPhase.Write, String(error));
                    assert.deepEqual(fx.UndoOrder, [CompFx.A, CompFx.B, CompFx.A]);
                    // Later calls are disposed.
                    assert.throws(() => t.SetProperty('na1', CompFx.State, CompFx.Done), (e: unknown) => e instanceof Error && (e as { GraphCode?: GraphErrorCode }).GraphCode === GraphErrorCode.Disposed);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('failed compensation surfaces', async () =>
            {
                const fx = await CompFx.Open(storage());
                fx.ConnA.ThrowAtStep = 1;
                const undoFailure = new Error('A undo failed');
                fx.ConnA.UndoFailure = undoFailure;
                const t = await fx.Begin();
                try
                {
                    CompFx.External(t, CompFx.ModelB, 'nb');
                    await t.Flush();
                    CompFx.External(t, CompFx.ModelA, 'na');
                    const error = await CompFx.Rejection(t.Flush());
                    assert.ok(error instanceof ConnectorError, String(error));
                    assert.ok(error.cause instanceof AggregateError, String(error.cause));
                    assert.equal(error.cause.errors[0], fx.ConnA.Failure);
                    assert.equal(error.cause.errors[1], undoFailure);
                    assert.equal(fx.RevertFailed.length, 1);
                    assert.equal(fx.RevertFailed[0]!.Connector, CompFx.A);
                    assert.equal(fx.ConnB.UndoCalls, 1);
                    assert.equal(fx.Applied.length, 1);
                    assert.equal(fx.Applied[0]!.Outcome, ConnectorOutcome.CompensationFailed);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('connector without Undo is reverted after later steps', async () =>
            {
                const fx = await CompFx.Open(storage());
                fx.ConnA.SupportsUndo = false;
                const t = await fx.Begin();
                try
                {
                    CompFx.External(t, CompFx.ModelA, 'na');
                    await t.Flush();
                    CompFx.External(t, CompFx.ModelB, 'nb1');
                    await t.Flush();
                    CompFx.External(t, CompFx.ModelB, 'nb2');
                    await t.Flush();
                    await t.Abort();
                    // A has no Undo: one Revert, after B's two Undo of the later steps.
                    assert.equal(fx.ConnA.RevertCalls, 1);
                    assert.equal(fx.ConnA.UndoCalls, 0);
                    assert.deepEqual(fx.UndoOrder, [CompFx.B, CompFx.B]);
                    assert.deepEqual(fx.RevertOrder, [CompFx.A]);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('mirrored connectors are reverted on failure', async () =>
            {
                const fx = await CompFx.Open(storage());
                fx.Mirror.FailAt = FakeStep.Commit;
                const t = await fx.Begin();
                try
                {
                    CompFx.External(t, CompFx.ModelA, 'na');
                    await t.Flush();
                    CompFx.External(t, CompFx.ModelM, 'nm');
                    const error = await CompFx.Rejection(t.Commit());
                    assert.ok(error instanceof ConnectorError && error.Connector === CompFx.M, String(error));
                    assert.ok(fx.MirrorLog.includes('m.Revert'), fx.MirrorLog.join());
                    assert.equal(fx.ConnA.UndoCalls, 1);
                    assert.equal(fx.Applied[0]!.Outcome, ConnectorOutcome.Compensated);
                }
                finally
                {
                    t.dispose();
                    await fx.dispose();
                }
            });

            it('DisposeAsync of a dropped transaction compensates then rejects', async () =>
            {
                const fx = await CompFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    CompFx.External(t, CompFx.ModelA, 'na');
                    await t.Flush();
                    const error = await CompFx.Rejection(t.DisposeAsync());
                    assert.ok(error instanceof TransactionDroppedError, String(error));
                    assert.equal(error.GraphCode, GraphErrorCode.TransactionDropped);
                    assert.equal(error.TransactionId, t.Id);
                    assert.equal(error.Steps, 1);
                    assert.equal(error.Outcome, ConnectorOutcome.Compensated);
                    // Undone before the rejection.
                    assert.equal(fx.ConnA.UndoCalls, 1);
                    assert.equal(fx.Dropped.length, 1);
                    assert.equal(fx.Applied.length, 1);
                    assert.equal(fx.Applied[0]!.Outcome, ConnectorOutcome.Compensated);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('sync dispose of a dropped transaction throws at once', async () =>
            {
                const fx = await CompFx.Open(storage());
                const t = await fx.Begin();
                try
                {
                    CompFx.External(t, CompFx.ModelA, 'na');
                    await t.Flush();
                    let thrown: unknown;
                    try
                    {
                        t.dispose();
                    }
                    catch (error)
                    {
                        thrown = error;
                    }
                    assert.ok(thrown instanceof TransactionDroppedError, String(thrown));
                    assert.equal(thrown.Outcome, undefined);
                    const outcome = await thrown.Compensation;
                    assert.equal(outcome, ConnectorOutcome.Compensated);
                    assert.equal(fx.ConnA.UndoCalls, 1);
                    assert.equal(fx.Dropped.length, 1);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('dropped transaction with failed compensation', async () =>
            {
                const fx = await CompFx.Open(storage());
                fx.ConnA.UndoFailure = new Error('undo failed');
                const t = await fx.Begin();
                try
                {
                    CompFx.External(t, CompFx.ModelA, 'na');
                    await t.Flush();
                    const error = await CompFx.Rejection(t.DisposeAsync());
                    assert.ok(error instanceof TransactionDroppedError, String(error));
                    assert.equal(error.Outcome, ConnectorOutcome.CompensationFailed);
                    assert.equal(await error.Compensation, ConnectorOutcome.CompensationFailed);
                    assert.equal(fx.RevertFailed.length, 1);
                    assert.equal(fx.RevertFailed[0]!.Connector, CompFx.A);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('disposing a clean transaction does not throw', async () =>
            {
                const fx = await CompFx.Open(storage());
                try
                {
                    const nothing = await fx.Begin();
                    nothing.dispose();
                    const second = await fx.Begin();
                    await second.DisposeAsync();
                    const committed = await fx.Begin();
                    committed.CreateNode('e2', CompFx.Item);
                    committed.SetProperty('e2', CompFx.Id, 'e2');
                    await committed.Commit();
                    committed.dispose();
                    const aborted = await fx.Begin();
                    CompFx.External(aborted, CompFx.ModelA, 'na');
                    await aborted.Flush();
                    await aborted.Abort();
                    aborted.dispose();
                    assert.equal(fx.Dropped.length, 0);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('store dispose drops open transactions without throwing', async () =>
            {
                const fx = await CompFx.Open(storage());
                const t = await fx.Begin();
                CompFx.External(t, CompFx.ModelA, 'na');
                await t.Flush();
                // The transaction stays open; disposing the engine drops it.
                await fx.dispose();
                assert.equal(fx.ConnA.UndoCalls, 1);
                assert.equal(fx.Dropped.length, 1);
                assert.equal(fx.Dropped[0]!.Steps, 1);
                assert.equal(fx.Applied.length, 1);
                assert.equal(fx.Applied[0]!.Outcome, ConnectorOutcome.Compensated);
            });

            it('successful commit reports Committed once', async () =>
            {
                const fx = await CompFx.Open(storage());
                try
                {
                    const mixed = await fx.Begin();
                    CompFx.External(mixed, CompFx.ModelA, 'na');
                    mixed.CreateNode('e2', CompFx.Item);
                    mixed.SetProperty('e2', CompFx.Id, 'e2');
                    const commit = await mixed.Commit();
                    mixed.dispose();
                    assert.equal(fx.Applied.length, 1);
                    assert.equal(fx.Applied[0]!.Outcome, ConnectorOutcome.Committed);
                    assert.equal(fx.Applied[0]!.Commit, commit);
                    const allExternal = await fx.Begin();
                    CompFx.External(allExternal, CompFx.ModelA, 'nb');
                    await allExternal.Commit();
                    allExternal.dispose();
                    assert.equal(fx.Applied.length, 2);
                    assert.equal(fx.Applied[1]!.Outcome, ConnectorOutcome.Committed);
                    assert.equal(fx.Applied[1]!.Commit, undefined);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('no participation raises nothing', async () =>
            {
                const fx = await CompFx.Open(storage());
                try
                {
                    const t = await fx.Begin();
                    t.CreateNode('e3', CompFx.Item);
                    t.SetProperty('e3', CompFx.Id, 'e3');
                    await t.Commit();
                    t.dispose();
                    assert.equal(fx.Applied.length, 0);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('drop compensates each transaction on its own connector transactions', async () =>
            {
                const fx = await CompFx.Open(storage());
                const alice = ConnectorContext.For('alice');
                const bob = ConnectorContext.For('bob');
                const t1 = await fx.Begin(alice);
                const t2 = await fx.Begin(bob);
                try
                {
                    CompFx.External(t1, CompFx.ModelA, 'na1');
                    await t1.Flush();
                    CompFx.External(t2, CompFx.ModelA, 'na2');
                    await t2.Flush();
                    assert.deepEqual(fx.ConnA.Contexts.map(c => c.Key), ['alice', 'bob']);
                    // Dropping t1 compensates only its own connector transaction; t2 commits untouched.
                    await CompFx.Rejection(t1.DisposeAsync());
                    assert.equal(fx.ConnA.UndoCalls, 1);
                    await t2.Commit();
                    t2.dispose();
                    assert.equal(fx.ConnA.UndoCalls, 1);
                    assert.equal(fx.ConnA.CommitCalls, 1);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('a late revert re-arms the deadline across steps', async () =>
            {
                const fx = await CompFx.Open(storage(), 40);
                fx.ConnA.HoldUndo = true;
                fx.ConnA.UndoFailure = new Error('A undo failed late');
                const t = await fx.Begin();
                try
                {
                    CompFx.External(t, CompFx.ModelA, 'na');
                    await t.Flush();
                    CompFx.External(t, CompFx.ModelB, 'nb');
                    await t.Flush();
                    // Compensation arms a fresh deadline: B's Undo (later step) completes, A's (earlier step) hangs past it.
                    await t.Abort();
                    assert.equal(fx.ConnB.UndoCalls, 1);
                    assert.equal(fx.ConnA.UndoCalls, 1);
                    assert.equal(fx.RevertFailed.length, 0);
                    fx.ConnA.ReleaseUndo();
                    await new Promise(resolve => setTimeout(resolve, 20));
                    assert.equal(fx.RevertFailed.length, 1);
                    assert.equal(fx.RevertFailed[0]!.Connector, CompFx.A);
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

after(() => CompFx.RemoveDirs());
CompensationSuite.Register('Memory', () => ({ Kind: StorageKind.Memory }));
CompensationSuite.Register('LMDB', () => ({ Kind: StorageKind.Lmdb, Path: CompFx.Dir() }));
