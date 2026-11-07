import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Api from '../index.js';
import {
    AccessDefault,
    AccessError,
    AccessScope,
    CatalogError,
    CommitKind,
    ConnectorError,
    ConnectorPhase,
    ConflictError,
    FalsePredicate,
    GraphEngine,
    GraphError,
    GraphErrorCode,
    StorageKind,
    type ConnectorChange,
    type IAccessScopeOptions,
    type IBindingDescription,
    type ICommitApplied,
    type IConnectorTransaction,
    type ICreateNodeOptions,
    type IDefinitionDescription,
    type IEngineStorage,
    type IGraphConnector,
    type IGraphEngineOptions,
    type IIndexBound,
    type IIndexDescription,
    type IIndexRange,
    type IndexDef,
    type ISchemaDescription,
    type ISeedLink,
    type ISeedNode,
    type IUpgradeCommit,
    type IWriteRules,
} from '../index.js';
import { FakeConnector, FakeStep } from '../connectors/tests/FakeConnector.js';
import { EngineDescriptions as D } from './EngineDescriptions.js';

/** Storage factories, the child process and read helpers for the GraphEngine tests. */
class EngineFx
{
    private static readonly DirPrefix = 'pragmatic-graph-engine-';
    private static readonly Dirs: string[] = [];
    private static readonly ChildScript = join(dirname(fileURLToPath(import.meta.url)), 'EngineChild.ts');
    public static readonly Crm = 'crm';
    public static readonly A = 'A';
    public static readonly B = 'B';
    private static readonly NodeOrigin = 'NodeOrigin';

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), EngineFx.DirPrefix));
        EngineFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of EngineFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    /** Runs EngineChild.ts `seed <dir>` to completion; it exits without disposing. */
    public static RunChild(dir: string): void
    {
        const result = spawnSync(process.execPath, ['--import', 'tsx', EngineFx.ChildScript, 'seed', dir], { encoding: 'utf8', timeout: 60000 });
        assert.equal(result.status, 0, 'child failed: ' + result.stderr + result.stdout);
        assert.match(result.stdout, /ready/);
    }

    public static async Changes(engine: GraphEngine, after = 0n): Promise<ICommitApplied[]>
    {
        const out: ICommitApplied[] = [];
        for await (const c of engine.ReadChanges(after))
        {
            out.push(c);
        }
        return out;
    }

    public static async Value(engine: GraphEngine, id: string, member: string, scope: AccessScope = AccessScope.System): Promise<unknown>
    {
        const r = await engine.BeginRead(scope);
        try
        {
            return await r.GetProperty(id, member);
        }
        finally
        {
            r.dispose();
        }
    }

    public static async Write(engine: GraphEngine, build: (t: Api.GraphTransaction) => void, scope: AccessScope = AccessScope.System): Promise<bigint>
    {
        const t = await engine.Begin(scope);
        try
        {
            build(t);
            return await t.Commit();
        }
        finally
        {
            t.dispose();
        }
    }

    public static IsCode(code: GraphErrorCode): (e: unknown) => boolean
    {
        return e => e instanceof GraphError && e.GraphCode === code;
    }

    public static CrmTo(connector: string): IBindingDescription[]
    {
        return [{ Model: EngineFx.Crm, Connector: connector }];
    }

    /**
     * Holds `t`'s commit routing at its first snapshot lookup (the async step between reading the
     * bindings and submitting) until Release(); Reached resolves once routing got there.
     */
    public static HoldRouting(t: Api.GraphTransaction): { readonly Reached: Promise<void>; Release(): void }
    {
        const target = t as unknown as Record<string, (id: string) => Promise<unknown>>;
        const original = target[EngineFx.NodeOrigin]!.bind(t);
        let reached: () => void = () => undefined;
        let release: () => void = () => undefined;
        const arrived = new Promise<void>(resolve => { reached = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        target[EngineFx.NodeOrigin] = async (id: string) =>
        {
            reached();
            await held;
            return original(id);
        };
        return { Reached: arrived, Release: () => release() };
    }

    public static Register(name: string, storage: () => IEngineStorage): void
    {
        describe('GraphEngine on ' + name, () =>
        {
            it('first run creates and seeds', async () =>
            {
                const engine = await GraphEngine.Open({ Description: D.V1, Storage: storage() });
                assert.equal(engine.SchemaVersion, D.V1Version);
                assert.ok(engine.Catalog.Definition(D.Note) !== undefined);
                assert.equal(await EngineFx.Value(engine, D.Root, D.Text), D.Seeded);
                const changes = await EngineFx.Changes(engine);
                assert.deepEqual(changes.map(c => c.Kind), [CommitKind.Upgrade, CommitKind.Batch], 'the upgrade, then the seed');
                await engine.dispose();
            });

            it('upgrading again with the same description does nothing', async () =>
            {
                const engine = await GraphEngine.Open({ Description: D.V1, Storage: storage() });
                const raised: ICommitApplied[] = [];
                const sub = engine.CommitApplied.Subscribe(c => raised.push(c));
                const result = await engine.Upgrade(D.V1);
                assert.equal(result.Changed, false);
                assert.equal(result.SeedCommit, undefined);
                assert.deepEqual(raised, []);
                assert.equal((await EngineFx.Changes(engine)).length, 2);
                sub.dispose();
                await engine.dispose();
            });

            it('hot upgrade with a changed description discards and updates SchemaVersion and Catalog', async () =>
            {
                const engine = await GraphEngine.Open({ Description: D.V1, Storage: storage() });
                await EngineFx.Write(engine, t =>
                {
                    t.CreateNode('n1', D.Note);
                    t.SetProperty('n1', D.Text, 'kept');
                    t.SetProperty('n1', D.Extra, 'dropped');
                });
                const raised: ICommitApplied[] = [];
                const sub = engine.CommitApplied.Subscribe(c => raised.push(c));
                const result = await engine.Upgrade(D.V2);
                assert.equal(result.Changed, true);
                assert.deepEqual(raised.map(c => c.Kind), [CommitKind.Upgrade]);
                assert.equal(engine.SchemaVersion, D.V2Version);
                assert.equal(engine.Catalog, result.Catalog);
                assert.equal(engine.Catalog.Definition(D.Note)!.Members.some(m => m.Name === D.Extra), false);
                assert.equal(await EngineFx.Value(engine, 'n1', D.Text), 'kept');
                await assert.rejects(EngineFx.Value(engine, 'n1', D.Extra), CatalogError);
                sub.dispose();
                await engine.dispose();
            });

            it('hot upgrade swaps bindings', async () =>
            {
                const log: string[] = [];
                const a = new FakeConnector(EngineFx.A, log);
                const b = new FakeConnector(EngineFx.B, log);
                const engine = await GraphEngine.Open({ Description: D.Desc(D.V1Version, true, EngineFx.CrmTo(EngineFx.A)), Storage: storage(), Connectors: [a, b] });
                await EngineFx.Write(engine, t => t.CreateNode('c1', D.Item, { Owner: EngineFx.Crm }));
                assert.equal(a.Applied.length, 1);
                assert.equal(b.Applied.length, 0);
                const result = await engine.Upgrade(D.Desc('v1b', true, EngineFx.CrmTo(EngineFx.B)));
                assert.equal(result.Changed, false, 'same catalog, new bindings');
                assert.equal(engine.SchemaVersion, 'v1b');
                await EngineFx.Write(engine, t => t.SetProperty('c1', D.Name, 'n'));
                assert.equal(a.Applied.length, 1);
                assert.equal(b.Applied.length, 1);
                assert.equal(b.Applied[0]!.Changes[0]!.Owner, EngineFx.Crm);
                assert.deepEqual(log, ['A.Begin', 'A.Apply', 'A.Commit', 'B.Begin', 'B.Apply', 'B.Commit']);
                await engine.dispose();
            });

            it('hot upgrade binding to an unknown connector rejects before upgrading', async () =>
            {
                const a = new FakeConnector(EngineFx.A, []);
                const engine = await GraphEngine.Open({ Description: D.Desc(D.V1Version, true, EngineFx.CrmTo(EngineFx.A)), Storage: storage(), Connectors: [a] });
                const before = (await EngineFx.Changes(engine)).length;
                await assert.rejects(engine.Upgrade(D.Desc(D.V2Version, false, EngineFx.CrmTo('Z'))), EngineFx.IsCode(GraphErrorCode.InvalidArgument));
                await assert.rejects(engine.Upgrade(D.Desc(D.V2Version, false, [], 'Z')), EngineFx.IsCode(GraphErrorCode.InvalidArgument));
                assert.equal(engine.SchemaVersion, D.V1Version);
                assert.equal((await EngineFx.Changes(engine)).length, before, 'nothing committed');
                await EngineFx.Write(engine, t => t.CreateNode('c1', D.Item, { Owner: EngineFx.Crm }));
                assert.equal(a.Applied.length, 1, 'the old bindings stay');
                await engine.dispose();
            });

            it('a failing hot upgrade keeps the schema and the bindings', async () =>
            {
                const a = new FakeConnector(EngineFx.A, []);
                const engine = await GraphEngine.Open({ Description: D.Desc(D.V1Version, true, EngineFx.CrmTo(EngineFx.A)), Storage: storage(), Connectors: [a] });
                const broken: ISchemaDescription = { ...D.Desc('broken', true, []), Definitions: [{ Name: 'orphan', IsAspect: false, Parent: 'missing', Aspects: [], Members: [] }] };
                await assert.rejects(engine.Upgrade(broken), CatalogError);
                assert.equal(engine.SchemaVersion, D.V1Version);
                await EngineFx.Write(engine, t => t.CreateNode('c1', D.Item, { Owner: EngineFx.Crm }));
                assert.equal(a.Applied.length, 1);
                await engine.dispose();
            });

            it('scoped read and gated write through the facade', async () =>
            {
                const engine = await GraphEngine.Open({ Description: D.V1, Storage: storage() });
                await EngineFx.Write(engine, t =>
                {
                    t.CreateNode('n1', D.Note);
                    t.SetProperty('n1', D.Text, 'secret');
                });
                const hidden = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[D.Note, new Set([D.Text])]]) });
                assert.equal(await EngineFx.Value(engine, 'n1', D.Text, hidden), null, 'a hidden member reads as null');
                const noNotes = AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[D.Note, { Create: FalsePredicate.Instance }]]) });
                await assert.rejects(EngineFx.Write(engine, t => t.CreateNode('n2', D.Note), noNotes), AccessError);
                await EngineFx.Write(engine, t => t.CreateNode('i1', D.Item), noNotes);
                const unknown = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([['nope', new Set<string>()]]) });
                await assert.rejects(engine.BeginRead(unknown), EngineFx.IsCode(GraphErrorCode.InvalidArgument));
                await engine.dispose();
            });

            it('connector write-through through the facade', async () =>
            {
                const log: string[] = [];
                const a = new FakeConnector(EngineFx.A, log);
                const engine = await GraphEngine.Open({ Description: D.Desc(D.V1Version, true, EngineFx.CrmTo(EngineFx.A)), Storage: storage(), Connectors: [a], PrepareTimeoutMs: 5000 });
                await EngineFx.Write(engine, t =>
                {
                    t.CreateNode('c1', D.Item, { Owner: EngineFx.Crm });
                    t.SetProperty('c1', D.Name, 'x');
                    t.CreateNode('local', D.Item);
                });
                assert.deepEqual(log, ['A.Begin', 'A.Apply', 'A.Commit']);
                assert.deepEqual(a.Applied[0]!.Changes.map(c => c.Op), [Api.WriteOp.CreateNode, Api.WriteOp.SetProperty], 'the unbound node is not written through');
                assert.equal(await EngineFx.Value(engine, 'c1', D.Name), 'x');
                a.FailAt = FakeStep.Apply;
                const e = await EngineFx.Write(engine, t => t.SetProperty('c1', D.Name, 'y')).catch((err: unknown) => err);
                assert.ok(e instanceof ConnectorError && e.Phase === ConnectorPhase.Apply && e.Connector === EngineFx.A);
                assert.equal(await EngineFx.Value(engine, 'c1', D.Name), 'x', 'the engine is unchanged');
                await engine.dispose();
            });

            it('a late revert failure reaches ConnectorRevertFailed', async () =>
            {
                const a = new FakeConnector(EngineFx.A, []);
                const engine = await GraphEngine.Open({ Description: D.Desc(D.V1Version, true, EngineFx.CrmTo(EngineFx.A)), Storage: storage(), Connectors: [a], PrepareTimeoutMs: 1000 });
                const raised: ConnectorError[] = [];
                let reported: (err: ConnectorError) => void = () => undefined;
                const first = new Promise<ConnectorError>(resolve => { reported = resolve; });
                const sub = engine.ConnectorRevertFailed.Subscribe(err =>
                {
                    raised.push(err);
                    reported(err);
                });
                a.HangAt = FakeStep.Apply;
                a.FailAt = FakeStep.Revert;
                await assert.rejects(EngineFx.Write(engine, t => t.CreateNode('c1', D.Item, { Owner: EngineFx.Crm })), ConnectorError);
                assert.deepEqual(raised, []);
                a.Release();
                const late = await first;
                assert.equal(late.Connector, EngineFx.A);
                assert.equal(late.Phase, ConnectorPhase.Apply);
                assert.equal(late.cause, a.Failure);
                assert.equal(raised.length, 1);
                sub.dispose();
                await engine.dispose();
            });

            it('Open checks connectors and the timeout', async () =>
            {
                const a = new FakeConnector(EngineFx.A, []);
                const invalid = EngineFx.IsCode(GraphErrorCode.InvalidArgument);
                await assert.rejects(GraphEngine.Open({ Description: D.V1, Storage: storage(), Connectors: [a, new FakeConnector(EngineFx.A, [])] }), invalid);
                await assert.rejects(GraphEngine.Open({ Description: D.V1, Storage: storage(), Connectors: [new FakeConnector(Api.BindingTable.EngineStorage, [])] }), invalid);
                await assert.rejects(GraphEngine.Open({ Description: D.V1, Storage: storage(), PrepareTimeoutMs: 0 }), invalid);
                const toEngine = await GraphEngine.Open({ Description: D.Desc(D.V1Version, true, [{ Model: EngineFx.Crm, Connector: Api.BindingTable.EngineStorage }]), Storage: storage() });
                await EngineFx.Write(toEngine, t => t.CreateNode('c1', D.Item, { Owner: EngineFx.Crm }));
                assert.equal(await EngineFx.Value(toEngine, 'c1', D.Name), null, 'binding to the engine itself is valid and engine-only');
                await toEngine.dispose();
            });

            it('a commit routed before a bindings-only upgrade never applies stale routing (newly bound)', async () =>
            {
                const a = new FakeConnector(EngineFx.A, []);
                const engine = await GraphEngine.Open({ Description: D.Desc(D.V1Version, true, []), Storage: storage(), Connectors: [a] });
                await EngineFx.Write(engine, t => t.CreateNode('c1', D.Item, { Owner: EngineFx.Crm }));
                const t = await engine.Begin(AccessScope.System);
                t.SetProperty('c1', D.Name, 'stale');
                const gate = EngineFx.HoldRouting(t);
                const commit = t.Commit();
                await gate.Reached;
                await engine.Upgrade(D.Desc('v1b', true, EngineFx.CrmTo(EngineFx.A)));
                gate.Release();
                await assert.rejects(commit, ConflictError, 'routed engine-only under the old bindings');
                assert.equal(await EngineFx.Value(engine, 'c1', D.Name), null);
                assert.equal(a.Applied.length, 0);
                await EngineFx.Write(engine, w => w.SetProperty('c1', D.Name, 'retried'));
                assert.equal(a.Applied.length, 1, 'the retry routes by the new bindings');
                await engine.dispose();
            });

            it('a commit routed before a bindings-only upgrade never applies stale routing (rebound)', async () =>
            {
                const a = new FakeConnector(EngineFx.A, []);
                const b = new FakeConnector(EngineFx.B, []);
                const engine = await GraphEngine.Open({ Description: D.Desc(D.V1Version, true, EngineFx.CrmTo(EngineFx.A)), Storage: storage(), Connectors: [a, b] });
                await EngineFx.Write(engine, t => t.CreateNode('c1', D.Item, { Owner: EngineFx.Crm }));
                const t = await engine.Begin(AccessScope.System);
                t.SetProperty('c1', D.Name, 'stale');
                const gate = EngineFx.HoldRouting(t);
                const commit = t.Commit();
                await gate.Reached;
                await engine.Upgrade(D.Desc('v1b', true, EngineFx.CrmTo(EngineFx.B)));
                gate.Release();
                await assert.rejects(commit, ConflictError, 'routed to A under the old bindings');
                assert.equal(a.Applied.length, 1, 'only the create reached A');
                assert.equal(b.Applied.length, 0);
                assert.equal(await EngineFx.Value(engine, 'c1', D.Name), null);
                await engine.dispose();
            });

            it('re-applying identical bindings keeps commits in flight valid', async () =>
            {
                const log: string[] = [];
                const a = new FakeConnector(EngineFx.A, log);
                const bound = (version: string): ISchemaDescription => D.Desc(version, true, [{ Model: EngineFx.Crm, Connector: EngineFx.A }, { Model: EngineFx.Crm, Concept: D.Item, Connector: EngineFx.A }], Api.BindingTable.EngineStorage);
                const engine = await GraphEngine.Open({ Description: bound(D.V1Version), Storage: storage(), Connectors: [a] });
                await EngineFx.Write(engine, t => t.CreateNode('c1', D.Item, { Owner: EngineFx.Crm }));
                for (const version of [D.V1Version, 'v1-saved-again'])
                {
                    const t = await engine.Begin(AccessScope.System);
                    t.SetProperty('c1', D.Name, version);
                    const gate = EngineFx.HoldRouting(t);
                    const commit = t.Commit();
                    await gate.Reached;
                    await engine.Upgrade(bound(version));
                    gate.Release();
                    await commit;
                    assert.equal(await EngineFx.Value(engine, 'c1', D.Name), version, 'identical bindings: the commit in flight succeeds');
                }
                assert.equal(a.Applied.length, 3);
                await engine.dispose();
            });

            it('a prepared write-through finalizing after a bindings-only upgrade is reverted', async () =>
            {
                const a = new FakeConnector(EngineFx.A, []);
                const b = new FakeConnector(EngineFx.B, []);
                const engine = await GraphEngine.Open({ Description: D.Desc(D.V1Version, true, EngineFx.CrmTo(EngineFx.A)), Storage: storage(), Connectors: [a, b] });
                let upgraded: Promise<unknown> = Promise.resolve();
                a.OnCommit = async () =>
                {
                    upgraded = engine.Upgrade(D.Desc('v1b', true, EngineFx.CrmTo(EngineFx.B)));
                    await upgraded;
                };
                const e = await EngineFx.Write(engine, t => t.CreateNode('c1', D.Item, { Owner: EngineFx.Crm })).catch((err: unknown) => err);
                await upgraded;
                assert.ok(e instanceof ConnectorError && e.Phase === ConnectorPhase.Finalize, String(e));
                assert.ok(e.cause instanceof ConflictError);
                await a.Reverted;
                assert.equal(await EngineFx.Value(engine, 'c1', D.Name), undefined, 'nothing was finalized');
                await engine.dispose();
            });

            it('dispose waits for a hot upgrade already called', async () =>
            {
                const engine = await GraphEngine.Open({ Description: D.V1, Storage: storage() });
                const upgrade = engine.Upgrade(D.V2);
                const closed = engine.dispose();
                const result = await upgrade;
                assert.equal(result.Changed, true);
                assert.equal(engine.SchemaVersion, D.V2Version);
                assert.equal(engine.Catalog, result.Catalog);
                await closed;
            });

            it('dispose is idempotent and later calls reject Disposed', async () =>
            {
                const engine = await GraphEngine.Open({ Description: D.V1, Storage: storage() });
                await Promise.all([engine.dispose(), engine.dispose()]);
                await engine.dispose();
                const disposed = EngineFx.IsCode(GraphErrorCode.Disposed);
                await assert.rejects(engine.Begin(AccessScope.System), disposed);
                await assert.rejects(engine.BeginRead(AccessScope.System), disposed);
                await assert.rejects(engine.Upgrade(D.V2), disposed);
                await assert.rejects(engine.Upgrade(D.Desc(D.V2Version, false, EngineFx.CrmTo('Z'))), disposed, 'liveness is checked before the bindings');
                await assert.rejects(EngineFx.Changes(engine), disposed);
            });
        });
    }
}

after(() => EngineFx.RemoveDirs());

EngineFx.Register('MemoryStore', () => ({ Kind: StorageKind.Memory }));
EngineFx.Register('LMDB', () => ({ Kind: StorageKind.Lmdb, Path: EngineFx.Dir() }));

describe('GraphEngine reopen (LMDB)', () =>
{
    it('reopen with same description does nothing', async () =>
    {
        const dir = EngineFx.Dir();
        EngineFx.RunChild(dir);
        const engine = await GraphEngine.Open({ Description: D.V1, Storage: { Kind: StorageKind.Lmdb, Path: dir } });
        const changes = await EngineFx.Changes(engine);
        assert.deepEqual(changes.map(c => c.Kind), [CommitKind.Upgrade, CommitKind.Batch, CommitKind.Batch], 'upgrade, seed, the child\'s write: nothing new');
        assert.equal(engine.SchemaVersion, D.V1Version);
        assert.equal(await EngineFx.Value(engine, 'n1', D.Extra), 'dropped');
        assert.equal(await EngineFx.Value(engine, D.Root, D.Text), D.Seeded);
        await engine.dispose();
    });

    it('reopen with changed description upgrades and discards', async () =>
    {
        const dir = EngineFx.Dir();
        EngineFx.RunChild(dir);
        const engine = await GraphEngine.Open({ Description: D.V2, Storage: { Kind: StorageKind.Lmdb, Path: dir } });
        const changes = await EngineFx.Changes(engine, 3n);
        assert.equal(changes.length, 1);
        assert.equal(changes[0]!.Kind, CommitKind.Upgrade);
        assert.equal(changes[0]!.SchemaVersion, D.V2Version);
        assert.equal(engine.SchemaVersion, D.V2Version);
        assert.equal(await EngineFx.Value(engine, 'n1', D.Text), 'kept');
        await assert.rejects(EngineFx.Value(engine, 'n1', D.Extra), CatalogError);
        await engine.dispose();
        const again = await GraphEngine.Open({ Description: D.V2, Storage: { Kind: StorageKind.Lmdb, Path: dir } });
        assert.equal((await EngineFx.Changes(again, 4n)).length, 0, 'the upgrade is durable');
        await again.dispose();
    });

    it('binding to unknown connector rejects before opening', async () =>
    {
        const dir = EngineFx.Dir();
        await assert.rejects(GraphEngine.Open({ Description: D.Desc(D.V1Version, true, EngineFx.CrmTo('Z')), Storage: { Kind: StorageKind.Lmdb, Path: dir } }), EngineFx.IsCode(GraphErrorCode.InvalidArgument));
        await assert.rejects(GraphEngine.Open({ Description: D.Desc(D.V1Version, true, [], 'Z'), Storage: { Kind: StorageKind.Lmdb, Path: dir } }), EngineFx.IsCode(GraphErrorCode.InvalidArgument));
        assert.deepEqual(readdirSync(dir), [], 'the store was never opened');
    });

    it('an upgrade failure at Open closes the store and rethrows', async () =>
    {
        const dir = EngineFx.Dir();
        const broken: ISchemaDescription = { ...D.V1, Definitions: [{ Name: 'orphan', IsAspect: false, Parent: 'missing', Aspects: [], Members: [] }] };
        await assert.rejects(GraphEngine.Open({ Description: broken, Storage: { Kind: StorageKind.Lmdb, Path: dir } }), CatalogError);
        const engine = await GraphEngine.Open({ Description: D.V1, Storage: { Kind: StorageKind.Lmdb, Path: dir } });
        assert.equal(engine.SchemaVersion, D.V1Version, 'the lock was released');
        await engine.dispose();
    });

    it('LMDB storage needs a Path; an unknown kind is rejected', async () =>
    {
        const invalid = EngineFx.IsCode(GraphErrorCode.InvalidArgument);
        await assert.rejects(GraphEngine.Open({ Description: D.V1, Storage: { Kind: StorageKind.Lmdb } }), invalid);
        await assert.rejects(GraphEngine.Open({ Description: D.V1, Storage: { Kind: 99 as StorageKind } }), invalid);
    });
});

describe('Public export surface', () =>
{
    /** Compile-time: every public type of Tasks 1–11 is importable from the package root. */
    type PublicTypes = [
        IGraphEngineOptions, IEngineStorage, IUpgradeCommit, ICreateNodeOptions, IndexDef, IIndexRange, IIndexBound,
        IAccessScopeOptions, IWriteRules, IGraphConnector, IConnectorTransaction, ConnectorChange,
        ISchemaDescription, IDefinitionDescription, IIndexDescription, ISeedNode, ISeedLink, IBindingDescription,
    ];

    it('exports the engine facade and every public runtime name', () =>
    {
        const names: (keyof typeof Api)[] = [
            'GraphEngine', 'StorageKind', 'GraphStore', 'GraphReader', 'GraphTransaction',
            'AccessScope', 'AccessDefault', 'AccessError', 'AccessErrorCode',
            'ConnectorChangeSet', 'ConnectorError', 'ConnectorPhase', 'BindingTable',
            'Predicate', 'PredicateKind', 'And', 'Or', 'Not', 'Compare', 'CompareOp', 'In', 'IsNull', 'IdIn', 'OwnerIs', 'Seeded', 'Related', 'Reachable', 'TruePredicate', 'FalsePredicate',
            'PredicateCodec', 'PredicateError', 'PredicateErrorCode',
            'CatalogPlanner', 'CatalogDiff', 'CommitKind', 'GraphError', 'GraphErrorCode',
        ];
        for (const name of names)
        {
            assert.notEqual(Api[name], undefined, name);
        }
        assert.equal(StorageKind.Memory, 1);
        assert.equal(StorageKind.Lmdb, 2);
        assert.equal(GraphErrorCode.AccessDenied, 12);
        assert.equal(GraphErrorCode.ConnectorFailed, 13);
        const types: PublicTypes | undefined = undefined;
        assert.equal(types, undefined);
    });

    it('exports no storage internal', () =>
    {
        for (const name of ['Committer', 'IndexStore', 'DataPurger', 'ScopeEvaluator', 'WriteCoordinator', 'ConnectorSetup', 'ScopeValidator', 'Reservations', 'GraphContext', 'WriteGate', 'SeedSynchronizer'])
        {
            assert.equal(name in Api, false, name);
        }
    });
});
