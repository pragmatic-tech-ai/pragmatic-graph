import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessDefault, AccessScope } from '../../access/AccessScope.js';
import { AccessError } from '../../access/AccessError.js';
import { CatalogModel } from '../../catalog/CatalogModel.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import type { GraphContext } from '../../GraphContext.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { FalsePredicate } from '../../predicate/Predicate.js';
import type { IBindingDescription } from '../../schema/SchemaDescription.js';
import { CommitError } from '../../txn/CommitError.js';
import { ConflictError } from '../../txn/ConflictError.js';
import type { PreparedCommit } from '../../txn/PreparedCommit.js';
import { WriteOp } from '../../txn/WriteBatch.js';
import { BindingTable } from '../BindingTable.js';
import { ConnectorError, ConnectorPhase } from '../ConnectorError.js';
import { FakeConnector, FakeStep } from './FakeConnector.js';

/**
 * Schema: item { name: String?, next -> item (many) }, doc : item, memo : doc, aspect tracked { tag },
 * ticket carries tracked, bug : ticket. Seeded before connectors are installed: x, y (item, crm),
 * h (item, hr), e (item, ext), t (bug, crm).
 */
class ThroughFx
{
    private static readonly DirPrefix = 'pragmatic-graph-connectors-';
    private static readonly Dirs: string[] = [];

    public static readonly Item = 'item';
    public static readonly Doc = 'doc';
    public static readonly Memo = 'memo';
    public static readonly Tracked = 'tracked';
    public static readonly Ticket = 'ticket';
    public static readonly Bug = 'bug';
    public static readonly Logged = 'logged';
    public static readonly Audited = 'audited';
    public static readonly Flagged = 'flagged';
    public static readonly Pinned = 'pinned';
    public static readonly Entry = 'entry';
    public static readonly SubEntry = 'subEntry';
    public static readonly Name = 'name';
    public static readonly Next = 'next';
    public static readonly Crm = 'crm';
    public static readonly Hr = 'hr';
    public static readonly Ext = 'ext';
    public static readonly A = 'A';
    public static readonly B = 'B';
    public static readonly C = 'C';
    public static readonly Written = 'v';
    public static readonly Changed = 'changed';
    /** Long enough for Prepare and the calls before the hanging one under load; the hang itself ends only on Release. */
    public static readonly TimeoutMs = 1000;

    public static Define(m: CatalogModel): void
    {
        m.DefineConcept(ThroughFx.Item, null, [], [
            { Name: ThroughFx.Name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: ThroughFx.Next, Kind: MemberKind.Relationship, Targets: [ThroughFx.Item], Many: true },
        ]);
        m.DefineConcept(ThroughFx.Doc, ThroughFx.Item, [], []);
        m.DefineConcept(ThroughFx.Memo, ThroughFx.Doc, [], []);
        m.DefineAspect(ThroughFx.Tracked, [], [{ Name: 'tag', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]);
        m.DefineConcept(ThroughFx.Ticket, null, [ThroughFx.Tracked], []);
        m.DefineConcept(ThroughFx.Bug, ThroughFx.Ticket, [], []);
        m.DefineAspect(ThroughFx.Logged, [], []);
        m.DefineAspect(ThroughFx.Audited, [ThroughFx.Logged], []);
        m.DefineAspect(ThroughFx.Flagged, [], []);
        m.DefineAspect(ThroughFx.Pinned, [], []);
        m.DefineConcept(ThroughFx.Entry, null, [ThroughFx.Audited, ThroughFx.Flagged], []);
        m.DefineConcept(ThroughFx.SubEntry, ThroughFx.Entry, [ThroughFx.Pinned], []);
    }

    public static Catalog(): ReturnType<CatalogModel['Seal']>
    {
        const m = new CatalogModel();
        ThroughFx.Define(m);
        return m.Seal();
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), ThroughFx.DirPrefix));
        ThroughFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of ThroughFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    /** A store with the schema and the seeded nodes, connectors not yet installed. */
    public static async Ready(open: () => Promise<GraphStore>): Promise<GraphStore>
    {
        const g = await open();
        await g.DefineSchema(m => ThroughFx.Define(m));
        await ThroughFx.Commit(g, t =>
        {
            t.CreateNode('x', ThroughFx.Item, { Owner: ThroughFx.Crm });
            t.CreateNode('y', ThroughFx.Item, { Owner: ThroughFx.Crm });
            t.CreateNode('h', ThroughFx.Item, { Owner: ThroughFx.Hr });
            t.CreateNode('e', ThroughFx.Item, { Owner: ThroughFx.Ext });
            t.CreateNode('t', ThroughFx.Bug, { Owner: ThroughFx.Crm });
            t.Link('x', ThroughFx.Next, 'y');
        });
        return g;
    }

    public static async Commit(g: GraphStore, build: (t: GraphTransaction) => void | Promise<void>, scope: AccessScope = AccessScope.System): Promise<bigint>
    {
        const t = await g.Begin(scope);
        try
        {
            await build(t);
            return await t.Commit();
        }
        finally
        {
            t.dispose();
        }
    }

    /** The rejection of `work`, which must reject. */
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

    public static async Value(g: GraphStore, id: string): Promise<unknown>
    {
        const r = await g.BeginRead(AccessScope.System);
        try
        {
            return await r.GetProperty(id, ThroughFx.Name);
        }
        finally
        {
            r.dispose();
        }
    }

    public static async Exists(g: GraphStore, id: string): Promise<boolean>
    {
        const r = await g.BeginRead(AccessScope.System);
        try
        {
            return (await r.ConceptOf(id)) !== undefined;
        }
        finally
        {
            r.dispose();
        }
    }

    /** The store's internal context. */
    public static Context(g: GraphStore): GraphContext
    {
        return (g as unknown as { context: GraphContext }).context;
    }

    /** The changes each connector received, flattened, as plain objects. */
    public static Changes(c: FakeConnector): object[]
    {
        return c.Applied.flatMap(set => set.Changes.map(ch => ({ ...ch })));
    }

    public static Wait(ms: number): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /** Connectors A, B, C over one shared log, installed with `bindings`. */
    public static Install(g: GraphStore, bindings: readonly IBindingDescription[], defaultConnector?: string, timeoutMs?: number): { Log: string[]; A: FakeConnector; B: FakeConnector; C: FakeConnector }
    {
        const log: string[] = [];
        const a = new FakeConnector(ThroughFx.A, log);
        const b = new FakeConnector(ThroughFx.B, log);
        const c = new FakeConnector(ThroughFx.C, log);
        g.SetConnectors(new BindingTable(bindings, defaultConnector), [b, a, c], timeoutMs);
        return { Log: log, A: a, B: b, C: c };
    }

    /** crm → A, hr → B. */
    public static readonly TwoModels: readonly IBindingDescription[] = [
        { Model: ThroughFx.Crm, Connector: ThroughFx.A },
        { Model: ThroughFx.Hr, Connector: ThroughFx.B },
    ];

    /** One write to a crm node (x) and one to an hr node (h). */
    public static WriteBoth(t: GraphTransaction): void
    {
        t.SetProperty('x', ThroughFx.Name, ThroughFx.Changed);
        t.SetProperty('h', ThroughFx.Name, ThroughFx.Changed);
    }

    public static IsConnectorError(e: unknown, connector: string, phase: ConnectorPhase): e is ConnectorError
    {
        return e instanceof ConnectorError && e instanceof GraphError && e.GraphCode === GraphErrorCode.ConnectorFailed && e.Connector === connector && e.Phase === phase;
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        describe('connector write-through on ' + name, () =>
        {
            it('engine-only bindings never call connectors', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, [{ Model: ThroughFx.Crm, Connector: BindingTable.EngineStorage }]);
                await ThroughFx.Commit(g, t =>
                {
                    t.SetProperty('x', ThroughFx.Name, ThroughFx.Written);
                    t.SetProperty('h', ThroughFx.Name, ThroughFx.Written);
                    t.CreateNode('n', ThroughFx.Item, { Owner: ThroughFx.Crm });
                    t.CreateNode('nobody', ThroughFx.Item);
                });
                assert.deepEqual(fx.Log, []);
                assert.equal(await ThroughFx.Value(g, 'x'), ThroughFx.Written);
                assert.equal(await ThroughFx.Value(g, 'h'), ThroughFx.Written);
                assert.equal(await ThroughFx.Exists(g, 'n'), true);
                const engineDefault = ThroughFx.Install(g, [], BindingTable.EngineStorage);
                await ThroughFx.Commit(g, t => t.SetProperty('h', ThroughFx.Name, ThroughFx.Changed));
                assert.deepEqual(engineDefault.Log, []);
                await g.dispose();
            });

            it('binding resolution: model+concept beats model beats default', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, [
                    { Model: ThroughFx.Crm, Concept: ThroughFx.Doc, Connector: ThroughFx.A },
                    { Model: ThroughFx.Crm, Connector: ThroughFx.B },
                ], ThroughFx.C);
                await ThroughFx.Commit(g, t =>
                {
                    t.CreateNode('m', ThroughFx.Memo, { Owner: ThroughFx.Crm });
                    t.CreateNode('i', ThroughFx.Item, { Owner: ThroughFx.Crm });
                    t.CreateNode('o', ThroughFx.Item, { Owner: ThroughFx.Hr });
                });
                const ids = (c: FakeConnector): string[] => c.Applied.flatMap(s => s.Changes.map(ch => (ch as { PublicId: string }).PublicId));
                assert.deepEqual(ids(fx.A), ['m']);
                assert.deepEqual(ids(fx.B), ['i']);
                assert.deepEqual(ids(fx.C), ['o']);
                await g.dispose();
            });

            it('aspect binding applies to carriers', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, [
                    { Model: ThroughFx.Crm, Concept: ThroughFx.Tracked, Connector: ThroughFx.A },
                    { Model: ThroughFx.Crm, Connector: ThroughFx.B },
                ]);
                await ThroughFx.Commit(g, t =>
                {
                    t.SetProperty('t', 'tag', ThroughFx.Written);
                    t.SetProperty('x', ThroughFx.Name, ThroughFx.Written);
                });
                assert.equal(fx.A.Applied.length, 1);
                assert.deepEqual(fx.A.Applied[0]!.Changes.map(c => (c as { PublicId: string }).PublicId), ['t']);
                assert.deepEqual(fx.B.Applied[0]!.Changes.map(c => (c as { PublicId: string }).PublicId), ['x']);
                await g.dispose();
            });

            it('change set carries owner, concept, op order', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, [{ Model: ThroughFx.Crm, Connector: ThroughFx.A }]);
                await ThroughFx.Commit(g, t =>
                {
                    t.CreateNode('n', ThroughFx.Doc, { Owner: ThroughFx.Crm });
                    t.SetProperty('n', ThroughFx.Name, ThroughFx.Written);
                    t.SetProperty('x', ThroughFx.Name, ThroughFx.Changed);
                    t.Link('n', ThroughFx.Next, 'x');
                    t.Unlink('x', ThroughFx.Next, 'y');
                    t.DeleteNode('y');
                    t.SetProperty('h', ThroughFx.Name, ThroughFx.Changed);
                });
                assert.equal(fx.A.Applied.length, 1);
                const changes = fx.A.Applied[0]!.Changes;
                assert.ok(Object.isFrozen(changes));
                assert.deepEqual(changes.map(c => ({ ...c })), [
                    { Op: WriteOp.CreateNode, PublicId: 'n', Concept: ThroughFx.Doc, Owner: ThroughFx.Crm },
                    { Op: WriteOp.SetProperty, PublicId: 'n', Member: ThroughFx.Name, Value: ThroughFx.Written, Owner: ThroughFx.Crm, Concept: ThroughFx.Doc },
                    { Op: WriteOp.SetProperty, PublicId: 'x', Member: ThroughFx.Name, Value: ThroughFx.Changed, Owner: ThroughFx.Crm, Concept: ThroughFx.Item },
                    { Op: WriteOp.Link, From: 'n', Relationship: ThroughFx.Next, To: 'x', Owner: ThroughFx.Crm, Concept: ThroughFx.Doc },
                    { Op: WriteOp.Unlink, From: 'x', Relationship: ThroughFx.Next, To: 'y', Owner: ThroughFx.Crm, Concept: ThroughFx.Item },
                    { Op: WriteOp.DeleteNode, PublicId: 'y', Owner: ThroughFx.Crm, Concept: ThroughFx.Item },
                ]);
                assert.deepEqual(fx.Log, ['A.Begin', 'A.Apply', 'A.Commit']);
                await g.dispose();
            });

            it('delete then re-create routes by the new owner and concept', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                await ThroughFx.Commit(g, t =>
                {
                    t.DeleteNode('x');
                    t.CreateNode('x', ThroughFx.Doc, { Owner: ThroughFx.Hr });
                    t.SetProperty('x', ThroughFx.Name, ThroughFx.Written);
                });
                assert.deepEqual(ThroughFx.Changes(fx.A), [
                    { Op: WriteOp.DeleteNode, PublicId: 'x', Owner: ThroughFx.Crm, Concept: ThroughFx.Item },
                ]);
                assert.deepEqual(ThroughFx.Changes(fx.B), [
                    { Op: WriteOp.CreateNode, PublicId: 'x', Concept: ThroughFx.Doc, Owner: ThroughFx.Hr },
                    { Op: WriteOp.SetProperty, PublicId: 'x', Member: ThroughFx.Name, Value: ThroughFx.Written, Owner: ThroughFx.Hr, Concept: ThroughFx.Doc },
                ]);
                const r = await g.BeginRead(AccessScope.System);
                assert.equal(await r.ConceptOf('x'), ThroughFx.Doc);
                assert.equal(await r.OwnerOf('x'), ThroughFx.Hr);
                r.dispose();
                await g.dispose();
            });

            it('create, delete, create in one batch routes each op by the latest create', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                await ThroughFx.Commit(g, t =>
                {
                    t.CreateNode('n', ThroughFx.Item, { Owner: ThroughFx.Crm });
                    t.DeleteNode('n');
                    t.CreateNode('n', ThroughFx.Doc, { Owner: ThroughFx.Hr });
                    t.SetProperty('n', ThroughFx.Name, ThroughFx.Written);
                });
                assert.deepEqual(ThroughFx.Changes(fx.A), [
                    { Op: WriteOp.CreateNode, PublicId: 'n', Concept: ThroughFx.Item, Owner: ThroughFx.Crm },
                    { Op: WriteOp.DeleteNode, PublicId: 'n', Owner: ThroughFx.Crm, Concept: ThroughFx.Item },
                ]);
                assert.deepEqual(ThroughFx.Changes(fx.B), [
                    { Op: WriteOp.CreateNode, PublicId: 'n', Concept: ThroughFx.Doc, Owner: ThroughFx.Hr },
                    { Op: WriteOp.SetProperty, PublicId: 'n', Member: ThroughFx.Name, Value: ThroughFx.Written, Owner: ThroughFx.Hr, Concept: ThroughFx.Doc },
                ]);
                assert.equal(await ThroughFx.Value(g, 'n'), ThroughFx.Written);
                await g.dispose();
            });

            it('link routed by source owner', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                await ThroughFx.Commit(g, t =>
                {
                    t.Link('h', ThroughFx.Next, 'x');
                });
                assert.equal(fx.A.Applied.length, 0, 'the target model is not a participant');
                assert.deepEqual(fx.B.Applied[0]!.Changes.map(c => ({ ...c })), [
                    { Op: WriteOp.Link, From: 'h', Relationship: ThroughFx.Next, To: 'x', Owner: ThroughFx.Hr, Concept: ThroughFx.Item },
                ]);
                await ThroughFx.Commit(g, t => t.Unlink('h', ThroughFx.Next, 'x'));
                assert.equal(fx.A.Applied.length, 0);
                assert.equal(fx.B.Applied[1]!.Changes[0]!.Op, WriteOp.Unlink);
                assert.equal(fx.B.Applied[1]!.Changes[0]!.Owner, ThroughFx.Hr);
                await g.dispose();
            });

            it('two connectors: both commit then engine finalizes', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                const seen: unknown[] = [];
                fx.B.OnCommit = async () =>
                {
                    seen.push(await ThroughFx.Value(g, 'x'), await ThroughFx.Value(g, 'h'));
                };
                const before = await ThroughFx.Commit(g, () => undefined);
                const commit = await ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t));
                assert.deepEqual(fx.Log, ['A.Begin', 'B.Begin', 'A.Apply', 'B.Apply', 'A.Commit', 'B.Commit']);
                assert.deepEqual(seen, [null, null], 'not visible to a new reader before every connector committed');
                assert.ok(commit > before);
                assert.equal(await ThroughFx.Value(g, 'x'), ThroughFx.Changed);
                assert.equal(await ThroughFx.Value(g, 'h'), ThroughFx.Changed);
                await g.dispose();
            });

            it('connector calls run outside the store write', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                fx.A.OnCommit = async () =>
                {
                    // e is engine-only (ext is unbound): an unrelated commit proceeds while A commits.
                    await ThroughFx.Commit(g, t => t.SetProperty('e', ThroughFx.Name, ThroughFx.Written));
                };
                await ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t));
                assert.equal(await ThroughFx.Value(g, 'e'), ThroughFx.Written);
                assert.equal(await ThroughFx.Value(g, 'x'), ThroughFx.Changed);
                await g.dispose();
            });

            it('apply failure reverts all and engine unchanged', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                fx.B.FailAt = FakeStep.Apply;
                const e = await ThroughFx.Rejection(ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t)));
                assert.ok(ThroughFx.IsConnectorError(e, ThroughFx.B, ConnectorPhase.Apply));
                assert.equal(e.cause, fx.B.Failure);
                assert.deepEqual(fx.Log, ['A.Begin', 'B.Begin', 'A.Apply', 'B.Apply', 'B.Revert', 'A.Revert']);
                assert.equal(await ThroughFx.Value(g, 'x'), null);
                assert.equal(await ThroughFx.Value(g, 'h'), null);
                // The prepared commit was aborted: its keys are free for the next writer.
                fx.B.FailAt = undefined;
                await ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t));
                assert.equal(await ThroughFx.Value(g, 'x'), ThroughFx.Changed);
                await g.dispose();
            });

            it('begin failure reverts the connectors that began', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                fx.B.FailAt = FakeStep.Begin;
                const e = await ThroughFx.Rejection(ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t)));
                assert.ok(ThroughFx.IsConnectorError(e, ThroughFx.B, ConnectorPhase.Begin));
                assert.deepEqual(fx.Log, ['A.Begin', 'B.Begin', 'A.Revert']);
                assert.equal(await ThroughFx.Value(g, 'x'), null);
                await g.dispose();
            });

            it('second commit failure reverts first (compensate)', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                fx.B.FailAt = FakeStep.Commit;
                const e = await ThroughFx.Rejection(ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t)));
                assert.ok(ThroughFx.IsConnectorError(e, ThroughFx.B, ConnectorPhase.Commit));
                assert.deepEqual(fx.Log, ['A.Begin', 'B.Begin', 'A.Apply', 'B.Apply', 'A.Commit', 'B.Commit', 'B.Revert', 'A.Revert']);
                assert.equal(await ThroughFx.Value(g, 'x'), null);
                assert.equal(await ThroughFx.Value(g, 'h'), null);
                await g.dispose();
            });

            it('engine conflict at prepare: no connector began', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                const t = await g.Begin(AccessScope.System);
                await t.GetProperty('x', ThroughFx.Name);
                t.SetProperty('x', ThroughFx.Name, ThroughFx.Written);
                await ThroughFx.Commit(g, other => other.SetProperty('x', ThroughFx.Name, ThroughFx.Changed));
                fx.Log.length = 0;
                const conflict = await ThroughFx.Rejection(t.Commit());
                assert.ok(conflict instanceof ConflictError, 'rethrown as-is');
                assert.deepEqual(fx.Log, []);
                const invalid = await ThroughFx.Rejection(ThroughFx.Commit(g, w => w.CreateNode('x', ThroughFx.Item, { Owner: ThroughFx.Crm })));
                assert.ok(invalid instanceof CommitError, 'rethrown as-is');
                assert.deepEqual(fx.Log, []);
                const denied = AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[ThroughFx.Item, { Update: FalsePredicate.Instance }]]) });
                const access = await ThroughFx.Rejection(ThroughFx.Commit(g, w => w.SetProperty('x', ThroughFx.Name, ThroughFx.Written), denied));
                assert.ok(access instanceof AccessError, 'rethrown as-is');
                assert.deepEqual(fx.Log, []);
                assert.equal(await ThroughFx.Value(g, 'x'), ThroughFx.Changed);
                await g.dispose();
            });

            it('finalize failure compensates every connector', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                // A schema change while prepared invalidates the reservation: Finalize then conflicts.
                fx.B.OnCommit = async () => { await g.DefineSchema(m => m.DefineConcept('extra', null, [], [])); };
                const e = await ThroughFx.Rejection(ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t)));
                assert.ok(ThroughFx.IsConnectorError(e, BindingTable.EngineStorage, ConnectorPhase.Finalize));
                assert.ok(e.cause instanceof ConflictError);
                assert.deepEqual(fx.Log, ['A.Begin', 'B.Begin', 'A.Apply', 'B.Apply', 'A.Commit', 'B.Commit', 'B.Revert', 'A.Revert']);
                assert.equal(await ThroughFx.Value(g, 'x'), null);
                await g.dispose();
            });

            it('timeout reverts connectors', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels, undefined, ThroughFx.TimeoutMs);
                fx.B.HangAt = FakeStep.Commit;
                const e = await ThroughFx.Rejection(ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t)));
                assert.ok(ThroughFx.IsConnectorError(e, ThroughFx.B, ConnectorPhase.Commit));
                assert.deepEqual(fx.Log, ['A.Begin', 'B.Begin', 'A.Apply', 'B.Apply', 'A.Commit', 'B.Commit', 'A.Revert'], 'answered at the timeout, while B still hangs');
                assert.equal(await ThroughFx.Value(g, 'x'), null);
                fx.B.Release();
                await fx.B.Reverted;
                assert.deepEqual(fx.Log.slice(-2), ['B.Commit.End', 'B.Revert'], 'the hanging transaction is reverted after its call returns');
                assert.equal(await ThroughFx.Value(g, 'x'), null);
                assert.equal(await ThroughFx.Value(g, 'h'), null);
                await g.dispose();
            });

            it('timeout in Begin reverts the transaction it returns late', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels, undefined, ThroughFx.TimeoutMs);
                fx.A.HangAt = FakeStep.Begin;
                const e = await ThroughFx.Rejection(ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t)));
                assert.ok(ThroughFx.IsConnectorError(e, ThroughFx.A, ConnectorPhase.Begin));
                assert.deepEqual(fx.Log, ['A.Begin']);
                fx.A.Release();
                await fx.A.Reverted;
                assert.deepEqual(fx.Log, ['A.Begin', 'A.Begin.End', 'A.Revert']);
                assert.equal(await ThroughFx.Value(g, 'x'), null);
                await g.dispose();
            });

            it('a timeout during Prepare is reported as the engine prepare and the late prepared commit is aborted', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels, undefined, ThroughFx.TimeoutMs);
                const committer = ThroughFx.Context(g).Committer;
                const prepare = committer.Prepare.bind(committer);
                let release: () => void = () => undefined;
                const gate = new Promise<void>(resolve => { release = resolve; });
                let late: Promise<PreparedCommit> | undefined;
                committer.Prepare = (...args: Parameters<typeof committer.Prepare>) =>
                {
                    late = gate.then(() => prepare(...args));
                    return late;
                };
                const e = await ThroughFx.Rejection(ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t)));
                assert.ok(ThroughFx.IsConnectorError(e, BindingTable.EngineStorage, ConnectorPhase.Prepare));
                assert.deepEqual(fx.Log, [], 'no connector began');
                committer.Prepare = prepare;
                release();
                const prepared = await (late as Promise<PreparedCommit>);
                await ThroughFx.Wait(10);
                assert.equal(committer.ReservationCount, 0, 'the late prepared commit was aborted');
                await ThroughFx.Rejection(prepared.Finalize());
                assert.equal(await ThroughFx.Value(g, 'x'), null);
                await ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t));
                assert.equal(await ThroughFx.Value(g, 'x'), ThroughFx.Changed);
                await g.dispose();
            });

            it('a revert hanging at the deadline finishes on the late path', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels, undefined, ThroughFx.TimeoutMs);
                const raised: ConnectorError[] = [];
                const sub = g.ConnectorRevertFailed.Subscribe(err => raised.push(err));
                fx.B.FailAt = FakeStep.Apply;
                fx.A.HangAt = FakeStep.Revert;
                const revertFailure = new Error('A revert failed late');
                fx.A.Failure = revertFailure;
                fx.A.FailAt = FakeStep.Revert;
                const e = await ThroughFx.Rejection(ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t)));
                assert.ok(ThroughFx.IsConnectorError(e, ThroughFx.B, ConnectorPhase.Apply));
                assert.equal(e.cause, fx.B.Failure, 'the pending revert is not awaited past the deadline');
                assert.deepEqual(fx.Log, ['A.Begin', 'B.Begin', 'A.Apply', 'B.Apply', 'B.Revert', 'A.Revert']);
                assert.deepEqual(raised, []);
                fx.A.Release();
                await fx.A.Reverted;
                await ThroughFx.Wait(10);
                assert.equal(raised.length, 1);
                const reported: unknown = raised[0];
                assert.ok(ThroughFx.IsConnectorError(reported, ThroughFx.A, ConnectorPhase.Apply));
                assert.equal(reported.cause, revertFailure);
                assert.equal(await ThroughFx.Value(g, 'x'), null);
                sub.dispose();
                await g.dispose();
            });

            it('revert failure surfaces', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels);
                fx.B.FailAt = FakeStep.Apply;
                const revertFailure = new Error('A revert failed');
                fx.A.FailAt = FakeStep.Revert;
                fx.A.Failure = revertFailure;
                const e = await ThroughFx.Rejection(ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t)));
                assert.ok(ThroughFx.IsConnectorError(e, ThroughFx.B, ConnectorPhase.Apply));
                assert.ok(e.cause instanceof AggregateError);
                assert.deepEqual(e.cause.errors, [fx.B.Failure, revertFailure]);
                assert.deepEqual(fx.Log, ['A.Begin', 'B.Begin', 'A.Apply', 'B.Apply', 'B.Revert', 'A.Revert']);
                await g.dispose();
            });

            it('a late revert failure is raised on ConnectorRevertFailed', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const fx = ThroughFx.Install(g, ThroughFx.TwoModels, undefined, ThroughFx.TimeoutMs);
                const raised: ConnectorError[] = [];
                const sub = g.ConnectorRevertFailed.Subscribe(err => raised.push(err));
                fx.A.HangAt = FakeStep.Apply;
                fx.A.FailAt = FakeStep.Revert;
                const e = await ThroughFx.Rejection(ThroughFx.Commit(g, t => ThroughFx.WriteBoth(t)));
                assert.ok(ThroughFx.IsConnectorError(e, ThroughFx.A, ConnectorPhase.Apply));
                assert.deepEqual(raised, []);
                fx.A.Release();
                await fx.A.Reverted;
                await ThroughFx.Wait(10);
                assert.equal(raised.length, 1);
                const late: unknown = raised[0];
                assert.ok(ThroughFx.IsConnectorError(late, ThroughFx.A, ConnectorPhase.Apply));
                assert.equal(late.cause, fx.A.Failure);
                sub.dispose();
                await g.dispose();
            });

            it('installing bindings checks connector names', async () =>
            {
                const g = await ThroughFx.Ready(open);
                const a = new FakeConnector(ThroughFx.A, []);
                const invalid = (e: unknown): boolean => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument;
                assert.throws(() => g.SetConnectors(new BindingTable([{ Model: ThroughFx.Crm, Connector: ThroughFx.B }]), [a]), invalid);
                assert.throws(() => g.SetConnectors(new BindingTable([], ThroughFx.B), [a]), invalid);
                assert.throws(() => g.SetConnectors(new BindingTable([]), [a, new FakeConnector(ThroughFx.A, [])]), invalid);
                assert.throws(() => g.SetConnectors(new BindingTable([]), [new FakeConnector(BindingTable.EngineStorage, [])]), invalid);
                assert.throws(() => g.SetConnectors(new BindingTable([]), [a], -1), invalid);
                assert.throws(() => g.SetConnectors(new BindingTable([]), [a], 0), invalid);
                assert.throws(() => g.SetConnectors(new BindingTable([]), [a], Number.POSITIVE_INFINITY), invalid);
                assert.throws(() => new BindingTable([{ Model: ThroughFx.Crm, Connector: ThroughFx.A }, { Model: ThroughFx.Crm, Connector: ThroughFx.B }]), invalid);
                g.SetConnectors(new BindingTable([{ Model: ThroughFx.Crm, Connector: ThroughFx.A }, { Model: ThroughFx.Hr, Connector: BindingTable.EngineStorage }]), [a]);
                await g.dispose();
            });
        });
    }
}

describe('BindingTable.Resolve', () =>
{
    const catalog = ThroughFx.Catalog();

    it('binding resolution: model+concept beats model beats default', () =>
    {
        const table = new BindingTable([
            { Model: ThroughFx.Crm, Concept: ThroughFx.Doc, Connector: ThroughFx.A },
            { Model: ThroughFx.Crm, Connector: ThroughFx.B },
        ], ThroughFx.C);
        assert.equal(table.Resolve(ThroughFx.Crm, ThroughFx.Doc, catalog), ThroughFx.A);
        assert.equal(table.Resolve(ThroughFx.Crm, ThroughFx.Memo, catalog), ThroughFx.A, 'an ancestor binding applies');
        assert.equal(table.Resolve(ThroughFx.Crm, ThroughFx.Item, catalog), ThroughFx.B);
        assert.equal(table.Resolve(ThroughFx.Hr, ThroughFx.Doc, catalog), ThroughFx.C);
        assert.equal(new BindingTable([]).Resolve(ThroughFx.Hr, ThroughFx.Doc, catalog), undefined);
        assert.equal(table.Resolve(ThroughFx.Crm, 'unknownConcept', catalog), ThroughFx.B, 'an unknown concept falls back to the model binding');
    });

    it('nearest first: own concept, then ancestors, then carried aspects', () =>
    {
        const table = new BindingTable([
            { Model: ThroughFx.Crm, Concept: ThroughFx.Tracked, Connector: ThroughFx.A },
            { Model: ThroughFx.Crm, Concept: ThroughFx.Ticket, Connector: ThroughFx.B },
            { Model: ThroughFx.Crm, Concept: ThroughFx.Memo, Connector: ThroughFx.C },
            { Model: ThroughFx.Crm, Concept: ThroughFx.Item, Connector: ThroughFx.A },
        ]);
        assert.equal(table.Resolve(ThroughFx.Crm, ThroughFx.Bug, catalog), ThroughFx.B, 'an ancestor beats a carried aspect');
        assert.equal(table.Resolve(ThroughFx.Crm, ThroughFx.Memo, catalog), ThroughFx.C, 'the own concept beats an ancestor');
        assert.equal(table.Resolve(ThroughFx.Crm, ThroughFx.Doc, catalog), ThroughFx.A);
        const aspectOnly = new BindingTable([{ Model: ThroughFx.Crm, Concept: ThroughFx.Tracked, Connector: ThroughFx.A }]);
        assert.equal(aspectOnly.Resolve(ThroughFx.Crm, ThroughFx.Bug, catalog), ThroughFx.A, 'aspect binding applies to carriers');
        assert.equal(aspectOnly.Resolve(ThroughFx.Crm, ThroughFx.Item, catalog), undefined);
    });

    it('an aspect declared by an ancestor applies; own aspects come before the ancestors\' aspects', () =>
    {
        const ancestorDeclared = new BindingTable([{ Model: ThroughFx.Crm, Concept: ThroughFx.Flagged, Connector: ThroughFx.A }]);
        assert.equal(ancestorDeclared.Resolve(ThroughFx.Crm, ThroughFx.SubEntry, catalog), ThroughFx.A);
        const ownFirst = new BindingTable([
            { Model: ThroughFx.Crm, Concept: ThroughFx.Audited, Connector: ThroughFx.A },
            { Model: ThroughFx.Crm, Concept: ThroughFx.Pinned, Connector: ThroughFx.B },
        ]);
        assert.equal(ownFirst.Resolve(ThroughFx.Crm, ThroughFx.SubEntry, catalog), ThroughFx.B);
        assert.equal(ownFirst.Resolve(ThroughFx.Crm, ThroughFx.Entry, catalog), ThroughFx.A);
    });

    it('an included aspect follows its includer depth-first, before the next declared aspect', () =>
    {
        const table = new BindingTable([
            { Model: ThroughFx.Crm, Concept: ThroughFx.Flagged, Connector: ThroughFx.B },
            { Model: ThroughFx.Crm, Concept: ThroughFx.Logged, Connector: ThroughFx.A },
        ]);
        assert.equal(table.Resolve(ThroughFx.Crm, ThroughFx.Entry, catalog), ThroughFx.A, 'audited → logged precede flagged');
        assert.equal(table.Resolve(ThroughFx.Crm, ThroughFx.SubEntry, catalog), ThroughFx.A, 'also through an ancestor');
        const includerFirst = new BindingTable([
            { Model: ThroughFx.Crm, Concept: ThroughFx.Logged, Connector: ThroughFx.A },
            { Model: ThroughFx.Crm, Concept: ThroughFx.Audited, Connector: ThroughFx.C },
        ]);
        assert.equal(includerFirst.Resolve(ThroughFx.Crm, ThroughFx.Entry, catalog), ThroughFx.C, 'the includer precedes what it includes');
    });
});

ThroughFx.Register('memory', () => GraphStore.OpenMemory());
ThroughFx.Register('lmdb', () => GraphStore.OpenLmdb(ThroughFx.Dir()));

after(() => ThroughFx.RemoveDirs());
