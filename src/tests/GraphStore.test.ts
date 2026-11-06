import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FormatKeys } from '../format/FormatKeys.js';
import { TupleCodec } from '../format/TupleCodec.js';
import { Keyspace } from '../kv/Keyspace.js';
import { LmdbStore } from '../kv/lmdb/LmdbStore.js';
import type { GraphContext } from '../GraphContext.js';
import type { Committer } from '../txn/Committer.js';
import * as Api from '../index.js';
import {
    CatalogError,
    CatalogErrorCode,
    CatalogModel,
    CommitError,
    CommitErrorCode,
    ConflictError,
    DateValue,
    EdgeDirection,
    FormatVersionMismatchError,
    GraphError,
    GraphErrorCode,
    GraphReader,
    GraphStore,
    GraphTransaction,
    MemberKind,
    PublicIdTooLongError,
    ValueType,
    WriteBatch,
    WriteOp,
} from '../index.js';

/** Schema, store factories and read helpers shared by the GraphStore tests. */
class GraphFx
{
    private static readonly DirPrefix = 'pragmatic-graph-store-';
    private static readonly Dirs: string[] = [];
    public static readonly ChildScript = join(dirname(fileURLToPath(import.meta.url)), 'DurabilityChild.ts');

    /**
     * file { path: String }, sourceFile : file { language: String? }, aspect placed { in -> location },
     * component : placed { name: String? }, location {}, folder { items -> file (many, ordered) },
     * aspect tagged { tag: String? } (carried by nothing).
     */
    public static Define(m: CatalogModel): void
    {
        m.DefineConcept('file', null, [], [{ Name: 'path', Kind: MemberKind.Property, Type: ValueType.String }]);
        m.DefineConcept('sourceFile', 'file', [], [{ Name: 'language', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]);
        m.DefineAspect('placed', [], [{ Name: 'in', Kind: MemberKind.Relationship, Targets: ['location'] }]);
        m.DefineConcept('component', null, ['placed'], [
            { Name: 'name', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: 'since', Kind: MemberKind.Property, Type: ValueType.Date, Nullable: true },
        ]);
        m.DefineConcept('location', null, [], []);
        m.DefineConcept('folder', null, [], [{ Name: 'items', Kind: MemberKind.Relationship, Targets: ['file'], Many: true, Ordered: true }]);
        m.DefineAspect('tagged', [], [{ Name: 'tag', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]);
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), GraphFx.DirPrefix));
        GraphFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of GraphFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static async Defined(open: () => Promise<GraphStore>): Promise<GraphStore>
    {
        const g = await open();
        await g.DefineSchema(m => GraphFx.Define(m));
        return g;
    }

    /** Commits one transaction built by `build`. */
    public static async Commit(g: GraphStore, build: (t: GraphTransaction) => void | Promise<void>): Promise<bigint>
    {
        const t = await g.Begin();
        await build(t);
        return t.Commit();
    }

    /** f1 (file), s1 (sourceFile), c1 and c2 (components placed in loc). */
    public static async Seed(g: GraphStore): Promise<bigint>
    {
        return GraphFx.Commit(g, t =>
        {
            t.CreateNode('f1', 'file');
            t.SetProperty('f1', 'path', '/a.txt');
            t.CreateNode('s1', 'sourceFile');
            t.SetProperty('s1', 'path', '/main.ts');
            t.SetProperty('s1', 'language', 'ts');
            t.CreateNode('loc', 'location');
            t.CreateNode('c1', 'component');
            t.SetProperty('c1', 'name', 'Api');
            t.SetProperty('c1', 'since', new DateValue(19000));
            t.CreateNode('c2', 'component');
            t.Link('c1', 'in', 'loc');
            t.Link('c2', 'in', 'loc');
        });
    }

    /** The store's committer (internal), for conflict-window assertions. */
    public static Committer(g: GraphStore): Committer
    {
        return (g as unknown as { context: GraphContext }).context.Committer;
    }

    public static async Read<T>(g: GraphStore, work: (r: GraphReader) => Promise<T>): Promise<T>
    {
        const r = await g.BeginRead();
        try
        {
            return await work(r);
        }
        finally
        {
            r.dispose();
        }
    }

    public static async Scan(r: GraphReader, name: string, member: string): Promise<Array<[string, unknown]>>
    {
        const out: Array<[string, unknown]> = [];
        for await (const row of r.ScanConcept(name, member))
        {
            out.push([row.PublicId, row.Value]);
        }
        return out;
    }

    public static async Settle(work: Promise<unknown>): Promise<unknown>
    {
        try
        {
            return await work;
        }
        catch (error)
        {
            return error;
        }
    }

    /** Runs the durability child (see DurabilityChild.ts) to completion; it exits without disposing. */
    public static RunChild(mode: string, dir: string): void
    {
        const result = spawnSync(process.execPath, ['--import', 'tsx', GraphFx.ChildScript, mode, dir], { encoding: 'utf8', timeout: 60000 });
        assert.equal(result.status, 0, 'child failed: ' + result.stderr + result.stdout);
        assert.match(result.stdout, /ready/);
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        describe('GraphStore on ' + name, () =>
        {
            it('a new reader sees committed values, edges in both directions and nothing for unknown nodes', async () =>
            {
                const g = await GraphFx.Defined(open);
                assert.equal(await GraphFx.Seed(g), 1n);
                await GraphFx.Read(g, async r =>
                {
                    assert.equal(await r.GetProperty('f1', 'path'), '/a.txt');
                    assert.equal(await r.GetProperty('s1', 'language'), 'ts');
                    assert.equal(await r.GetProperty('c2', 'name'), null);
                    const since = await r.GetProperty('c1', 'since');
                    assert.ok(since instanceof DateValue && since.Days === 19000);
                    assert.equal(await r.GetProperty('nobody', 'path'), undefined);
                    assert.deepEqual(await r.Neighbors('c1', 'in', EdgeDirection.Out), ['loc']);
                    assert.deepEqual((await r.Neighbors('loc', 'in', EdgeDirection.In)).sort(), ['c1', 'c2']);
                    assert.deepEqual(await r.Neighbors('nobody', 'in', EdgeDirection.Out), []);
                    await assert.rejects(r.GetProperty('f1', 'nope'), CatalogError);
                    await assert.rejects(r.GetProperty('c1', 'in'), GraphError);
                });
                await g.dispose();
            });

            it('ScanConcept covers subtype instances and aspect carriers', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                await GraphFx.Read(g, async r =>
                {
                    assert.deepEqual(await GraphFx.Scan(r, 'file', 'path'), [['f1', '/a.txt'], ['s1', '/main.ts']]);
                    assert.deepEqual(await GraphFx.Scan(r, 'sourceFile', 'path'), [['s1', '/main.ts']]);
                    assert.deepEqual(await GraphFx.Scan(r, 'placed', 'in'), [['c1', 'loc'], ['c2', 'loc']]);
                    assert.deepEqual(await GraphFx.Scan(r, 'component', 'name'), [['c1', 'Api'], ['c2', null]]);
                    await assert.rejects(GraphFx.Scan(r, 'nothing', 'path'), CatalogError);
                });
                await g.dispose();
            });

            it('reads are snapshot reads: a reader does not see later commits, a transaction not its own writes', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                const before = await g.BeginRead();
                assert.equal(before.SnapshotCommit, 1n);
                await GraphFx.Commit(g, t => t.SetProperty('f1', 'path', '/b.txt'));
                assert.equal(await before.GetProperty('f1', 'path'), '/a.txt');
                before.dispose();
                const t = await g.Begin();
                t.SetProperty('f1', 'path', '/c.txt');
                t.CreateNode('f9', 'file');
                t.SetProperty('f9', 'path', '/9');
                assert.equal(await t.GetProperty('f1', 'path'), '/b.txt');
                assert.equal(await t.GetProperty('f9', 'path'), undefined);
                await t.Commit();
                await GraphFx.Read(g, async r => assert.equal(await r.GetProperty('f9', 'path'), '/9'));
                await g.dispose();
            });

            it('a read/write conflict is rejected with ConflictError; transactions on disjoint data both commit', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                const t1 = await g.Begin();
                const t2 = await g.Begin();
                assert.equal(await t1.GetProperty('f1', 'path'), '/a.txt');
                assert.equal(await t2.GetProperty('f1', 'path'), '/a.txt');
                t1.SetProperty('f1', 'path', '/t1');
                t2.SetProperty('s1', 'path', '/t2');
                await t1.Commit();
                assert.ok((await GraphFx.Settle(t2.Commit())) instanceof ConflictError);
                const d1 = await g.Begin();
                const d2 = await g.Begin();
                await d1.GetProperty('f1', 'path');
                await d2.GetProperty('s1', 'path');
                d1.SetProperty('f1', 'path', '/d1');
                d2.SetProperty('s1', 'path', '/d2');
                await d1.Commit();
                await d2.Commit();
                await GraphFx.Read(g, async r =>
                {
                    assert.equal(await r.GetProperty('f1', 'path'), '/d1');
                    assert.equal(await r.GetProperty('s1', 'path'), '/d2');
                });
                await g.dispose();
            });

            it('scans, neighbor reads and reads of missing nodes catch phantoms', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                const scan = await g.Begin();
                await GraphFx.Scan(scan, 'file', 'path');
                scan.SetProperty('c1', 'name', 'x');
                const edges = await g.Begin();
                await edges.Neighbors('loc', 'in', EdgeDirection.In);
                edges.SetProperty('c1', 'name', 'y');
                const missing = await g.Begin();
                assert.equal(await missing.GetProperty('f2', 'path'), undefined);
                missing.SetProperty('c1', 'name', 'z');
                const reader = await g.Begin();
                await reader.GetProperty('c1', 'name');
                await GraphFx.Commit(g, t =>
                {
                    t.CreateNode('f2', 'sourceFile');
                    t.SetProperty('f2', 'path', '/2');
                    t.CreateNode('c3', 'component');
                    t.Link('c3', 'in', 'loc');
                });
                for (const t of [scan, edges, missing])
                {
                    assert.ok((await GraphFx.Settle(t.Commit())) instanceof ConflictError);
                }
                await reader.Commit();
                await g.dispose();
            });

            it('a schema change between Begin and Commit is a ConflictError; evolved schemas keep data and ids', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                const t = await g.Begin();
                t.SetProperty('f1', 'path', '/late');
                await g.DefineSchema(m => m.DefineConcept('extra', 'file', [], []));
                assert.ok((await GraphFx.Settle(t.Commit())) instanceof ConflictError);
                await GraphFx.Commit(g, x =>
                {
                    x.CreateNode('e1', 'extra');
                    x.SetProperty('e1', 'path', '/e');
                });
                await GraphFx.Read(g, async r => assert.deepEqual(await GraphFx.Scan(r, 'file', 'path'), [['f1', '/a.txt'], ['s1', '/main.ts'], ['e1', '/e']]));
                await assert.rejects(g.DefineSchema(m => m.DefineConcept('bad', 'missing', [], [])), CatalogError);
                await GraphFx.Commit(g, x => x.SetProperty('f1', 'path', '/after-failed-schema'));
                await g.dispose();
            });

            it('CommitApplied is raised once per commit with its number and batch', async () =>
            {
                const g = await GraphFx.Defined(open);
                const seen: Array<{ Commit: bigint; Batch: WriteBatch }> = [];
                const sub = g.CommitApplied.Subscribe(e => seen.push(e));
                await GraphFx.Seed(g);
                await GraphFx.Commit(g, t => t.SetProperty('f1', 'path', '/x'));
                assert.deepEqual(seen.map(e => e.Commit), [1n, 2n]);
                assert.deepEqual(seen[1]!.Batch.Ops(), [{ Op: WriteOp.SetProperty, PublicId: 'f1', Member: 'path', Value: '/x' }]);
                sub.dispose();
                await g.dispose();
            });

            it('CommitApplied is subscribe-only: subscribers can neither raise nor dispose it; Signal is not exported', async () =>
            {
                const g = await GraphFx.Defined(open);
                const surface = g.CommitApplied as unknown as Record<string, unknown>;
                assert.equal(typeof surface['Subscribe'], 'function');
                assert.equal(surface['Raise'], undefined);
                assert.equal(surface['dispose'], undefined);
                assert.equal('Signal' in Api, false);
                const seen: bigint[] = [];
                g.CommitApplied.Subscribe(e => seen.push(e.Commit));
                await GraphFx.Seed(g);
                assert.deepEqual(seen, [1n]);
                await g.dispose();
            });

            it('an empty transaction commits nothing: it returns its snapshot commit and raises no CommitApplied', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                const seen: bigint[] = [];
                g.CommitApplied.Subscribe(e => seen.push(e.Commit));
                const t = await g.Begin();
                await t.GetProperty('f1', 'path');
                assert.equal(await t.Commit(), t.SnapshotCommit);
                assert.equal(t.SnapshotCommit, 1n);
                await assert.rejects(t.Commit());
                assert.deepEqual(seen, []);
                assert.equal(await GraphFx.Commit(g, x => x.SetProperty('f1', 'path', '/n')), 2n, 'no commit number was consumed');
                await g.dispose();
            });

            it('a long-lived reader does not pin conflict history; an open transaction does (F3)', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                const committer = GraphFx.Committer(g);
                const reader = await g.BeginRead();
                for (let i = 0; i < 3; i++)
                {
                    await GraphFx.Commit(g, x => x.SetProperty('f1', 'path', '/r' + i));
                }
                assert.equal(committer.HistoryFloor, committer.LastCommit() - 1n, 'reader must not hold the window open');
                const t = await g.Begin();
                const pinned = committer.LastCommit();
                await GraphFx.Commit(g, x => x.SetProperty('f1', 'path', '/pinned'));
                await GraphFx.Commit(g, x => x.SetProperty('f1', 'path', '/pinned2'));
                assert.equal(committer.HistoryFloor, pinned, 'a transaction pins the window to its snapshot');
                t.dispose();
                assert.equal(await reader.GetProperty('f1', 'path'), '/a.txt');
                reader.dispose();
                await g.dispose();
            });

            it('a reader disposed during ScanConcept stops yielding', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                for (const [name, member] of [['file', 'path'], ['placed', 'in']] as const)
                {
                    const r = await g.BeginRead();
                    const rows = r.ScanConcept(name, member)[Symbol.asyncIterator]();
                    assert.equal((await rows.next()).done, false);
                    r.dispose();
                    await assert.rejects(rows.next(), /Reader has been disposed/);
                }
                await g.dispose();
            });

            it('ScanConcept validates the member against the named concept or aspect, even without carriers', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                await GraphFx.Read(g, async r =>
                {
                    assert.deepEqual(await GraphFx.Scan(r, 'tagged', 'tag'), []);
                    for (const [name, member] of [['tagged', 'bogus'], ['placed', 'bogus'], ['file', 'name']] as const)
                    {
                        const error = await GraphFx.Settle(GraphFx.Scan(r, name, member));
                        assert.ok(error instanceof CatalogError && error.Code === CatalogErrorCode.UnknownMember, name + '.' + member + ': ' + String(error));
                    }
                });
                await g.dispose();
            });

            it('semantic errors reject Commit with CommitError and leave no trace', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                const t = await g.Begin();
                t.CreateNode('f5', 'file');
                assert.equal((await GraphFx.Settle(t.Commit()) as CommitError).Code, CommitErrorCode.MissingRequired);
                const u = await g.Begin();
                u.CreateNode('f5', 'file');
                u.SetProperty('f5', 'path', '/5');
                u.Link('c1', 'in', 'f5');
                assert.equal((await GraphFx.Settle(u.Commit()) as CommitError).Code, CommitErrorCode.TargetTypeMismatch);
                await GraphFx.Read(g, async r => assert.equal(await r.GetProperty('f5', 'path'), undefined));
                await g.dispose();
            });

            it('reads and writes raise the same GraphErrorCode for the same mistake; every engine error is a GraphError (F8)', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                const long = 'x'.repeat(401);
                const cases: Array<[string, GraphErrorCode, (r: GraphReader) => Promise<unknown>, (t: GraphTransaction) => void]> = [
                    ['relationship read as a property', GraphErrorCode.SchemaViolation, r => r.GetProperty('c1', 'in'), t => t.SetProperty('c1', 'in', 'x')],
                    ['unknown member', GraphErrorCode.SchemaViolation, r => r.GetProperty('f1', 'nope'), t => t.SetProperty('f1', 'nope', 'x')],
                    ['property followed as a relationship', GraphErrorCode.SchemaViolation, r => r.Neighbors('f1', 'path', EdgeDirection.Out), t => t.Link('f1', 'path', 'loc')],
                    ['public id over 400 bytes', GraphErrorCode.InvalidArgument, r => r.GetProperty(long, 'path'), t => t.SetProperty(long, 'path', 'x')],
                    ['empty public id', GraphErrorCode.InvalidArgument, r => r.GetProperty('', 'path'), t => t.SetProperty('', 'path', 'x')],
                ];
                for (const [label, code, read, write] of cases)
                {
                    const readError = await GraphFx.Read(g, r => GraphFx.Settle(read(r)));
                    const t = await g.Begin();
                    write(t);
                    const writeError = await GraphFx.Settle(t.Commit());
                    assert.ok(readError instanceof GraphError && readError.GraphCode === code, label + ' (read): ' + String(readError));
                    assert.ok(writeError instanceof GraphError && writeError.GraphCode === code, label + ' (write): ' + String(writeError));
                }
                const reader = await g.BeginRead();
                reader.dispose();
                const disposed = await GraphFx.Settle(reader.GetProperty('f1', 'path'));
                assert.ok(disposed instanceof GraphError && disposed.GraphCode === GraphErrorCode.Disposed, String(disposed));
                await g.dispose();
                const closed = await GraphFx.Settle(g.BeginRead());
                assert.ok(closed instanceof GraphError && closed.GraphCode === GraphErrorCode.Disposed, String(closed));
                for (const type of [CommitError, CatalogError, ConflictError, Api.EdgeError, PublicIdTooLongError, FormatVersionMismatchError])
                {
                    assert.ok(type.prototype instanceof GraphError, type.name);
                }
            });

            it('a 401-byte public id is a clear error on read and on commit, never a storage crash; 400 bytes works', async () =>
            {
                const g = await GraphFx.Defined(open);
                const long = 'x'.repeat(401);
                const max = 'é'.repeat(200);
                await GraphFx.Read(g, async r =>
                {
                    await assert.rejects(r.GetProperty(long, 'path'), PublicIdTooLongError);
                    await assert.rejects(r.Neighbors(long, 'in', EdgeDirection.Out), PublicIdTooLongError);
                });
                const t = await g.Begin();
                t.CreateNode(long, 'file');
                t.SetProperty(long, 'path', '/long');
                const failed = await GraphFx.Settle(t.Commit());
                assert.ok(failed instanceof CommitError && failed.Code === CommitErrorCode.InvalidPublicId, String(failed));
                await GraphFx.Commit(g, x =>
                {
                    x.CreateNode(max, 'file');
                    x.SetProperty(max, 'path', '/max');
                });
                await GraphFx.Read(g, async r => assert.equal(await r.GetProperty(max, 'path'), '/max'));
                await g.dispose();
            });

            it('reads a pending delta, then the same cells after compaction', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Commit(g, t =>
                {
                    for (let i = 0; i < 10; i++)
                    {
                        t.CreateNode('p' + i, 'file');
                        t.SetProperty('p' + i, 'path', '/p' + i);
                    }
                });
                await GraphFx.Read(g, async r => assert.equal(await r.GetProperty('p3', 'path'), '/p3'));
                await GraphFx.Commit(g, t =>
                {
                    for (let i = 10; i < 600; i++)
                    {
                        t.CreateNode('p' + i, 'file');
                        t.SetProperty('p' + i, 'path', '/p' + i);
                    }
                });
                await GraphFx.Read(g, async r =>
                {
                    assert.equal(await r.GetProperty('p3', 'path'), '/p3');
                    assert.equal(await r.GetProperty('p599', 'path'), '/p599');
                    const rows = await GraphFx.Scan(r, 'file', 'path');
                    assert.equal(rows.length, 600);
                    assert.deepEqual(rows[42], ['p42', '/p42']);
                });
                await g.dispose();
            });

            it('1,000 inserts between the same two ordered siblings keep their order', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Commit(g, t =>
                {
                    t.CreateNode('dir', 'folder');
                    for (const id of ['left', 'right'])
                    {
                        t.CreateNode(id, 'file');
                        t.SetProperty(id, 'path', '/' + id);
                        t.Link('dir', 'items', id);
                    }
                });
                const expected: string[] = [];
                for (let chunk = 0; chunk < 10; chunk++)
                {
                    await GraphFx.Commit(g, t =>
                    {
                        for (let i = chunk * 100; i < (chunk + 1) * 100; i++)
                        {
                            const id = 'm' + i;
                            t.CreateNode(id, 'file');
                            t.SetProperty(id, 'path', '/' + id);
                            // Always between `left` and the item inserted just before: the same gap, narrowed 1,000 times.
                            t.Link('dir', 'items', id, { AfterSibling: 'left' });
                            expected.unshift(id);
                        }
                    });
                }
                await GraphFx.Read(g, async r => assert.deepEqual(await r.Neighbors('dir', 'items', EdgeDirection.Out), ['left', ...expected, 'right']));
                await g.dispose();
            });

            it('DeleteNode removes the node, its cells and its edges', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                await GraphFx.Commit(g, t => t.DeleteNode('c1'));
                await GraphFx.Read(g, async r =>
                {
                    assert.equal(await r.GetProperty('c1', 'name'), undefined);
                    assert.deepEqual(await r.Neighbors('loc', 'in', EdgeDirection.In), ['c2']);
                    assert.deepEqual(await GraphFx.Scan(r, 'placed', 'in'), [['c2', 'loc']]);
                });
                await g.dispose();
            });

            it('Commit ends the transaction; dispose ends readers and the store, idempotently', async () =>
            {
                const g = await GraphFx.Defined(open);
                await GraphFx.Seed(g);
                const t = await g.Begin();
                t.SetProperty('f1', 'path', '/1');
                await t.Commit();
                assert.throws(() => t.SetProperty('f1', 'path', '/2'));
                await assert.rejects(t.Commit());
                await assert.rejects(t.GetProperty('f1', 'path'));
                const open1 = await g.BeginRead();
                const open2 = await g.Begin();
                await Promise.all([g.dispose(), g.dispose()]);
                await g.dispose();
                await assert.rejects(open1.GetProperty('f1', 'path'));
                await assert.rejects(open2.Commit());
                await assert.rejects(g.BeginRead());
                await assert.rejects(g.Begin());
                await assert.rejects(g.DefineSchema(m => GraphFx.Define(m)));
                open1.dispose();
            });
        });
    }
}

after(() => GraphFx.RemoveDirs());
GraphFx.Register('memory', () => GraphStore.OpenMemory());
GraphFx.Register('lmdb', () => GraphStore.OpenLmdb(GraphFx.Dir()));

describe('GraphStore durability on LMDB', () =>
{
    it('dispose and reopen returns every committed value; a transaction that never committed leaves nothing', async () =>
    {
        const dir = GraphFx.Dir();
        const g = await GraphFx.Defined(() => GraphStore.OpenLmdb(dir));
        await GraphFx.Seed(g);
        await GraphFx.Commit(g, t => t.SetProperty('f1', 'path', '/committed'));
        const pending = await g.Begin();
        pending.CreateNode('ghost', 'file');
        pending.SetProperty('ghost', 'path', '/ghost');
        pending.SetProperty('f1', 'path', '/uncommitted');
        await g.dispose();
        const reopened = await GraphStore.OpenLmdb(dir);
        await GraphFx.Read(reopened, async r =>
        {
            assert.equal(await r.GetProperty('f1', 'path'), '/committed');
            assert.equal(await r.GetProperty('s1', 'language'), 'ts');
            assert.equal(await r.GetProperty('ghost', 'path'), undefined);
            assert.deepEqual(await GraphFx.Scan(r, 'placed', 'in'), [['c1', 'loc'], ['c2', 'loc']]);
        });
        assert.equal(await GraphFx.Commit(reopened, t => t.SetProperty('f1', 'path', '/next')), 3n, 'commit numbers resume');
        await assert.rejects(reopened.DefineSchema(m => GraphFx.Define(m)), CatalogError, 'the schema persisted');
        await reopened.dispose();
    });

    it('a process that commits and exits without dispose keeps the commit; one that exits before Commit leaves nothing', async () =>
    {
        const dir = GraphFx.Dir();
        GraphFx.RunChild('commit', dir);
        GraphFx.RunChild('abandon', dir);
        const g = await GraphStore.OpenLmdb(dir);
        await GraphFx.Read(g, async r =>
        {
            assert.equal(await r.GetProperty('child', 'path'), '/from-child');
            assert.equal(await r.GetProperty('orphan', 'path'), undefined);
            assert.deepEqual(await GraphFx.Scan(r, 'file', 'path'), [['child', '/from-child']]);
        });
        await g.dispose();
    });

    it('the compacted chunk is on disk after a large commit', async () =>
    {
        const dir = GraphFx.Dir();
        const g = await GraphFx.Defined(() => GraphStore.OpenLmdb(dir));
        await GraphFx.Commit(g, t =>
        {
            for (let i = 0; i < 600; i++)
            {
                t.CreateNode('p' + i, 'file');
                t.SetProperty('p' + i, 'path', '/p' + i);
            }
        });
        await g.dispose();
        const kv = await LmdbStore.Open(dir);
        const r = await kv.BeginRead();
        const fileType = 1;
        const pathMember = 1;
        assert.ok((await r.Get(Keyspace.Columns, FormatKeys.Column(0, fileType, pathMember, 0n))) !== undefined);
        assert.equal(await r.Get(Keyspace.Deltas, FormatKeys.Delta(0, fileType, pathMember, 0n)), undefined);
        r.dispose();
        await kv.dispose();
        const again = await GraphStore.OpenLmdb(dir);
        await GraphFx.Read(again, async x => assert.equal(await x.GetProperty('p17', 'path'), '/p17'));
        await again.dispose();
    });

    it('a store with another format version is refused', async () =>
    {
        const dir = GraphFx.Dir();
        const kv = await LmdbStore.Open(dir);
        await kv.Write(async txn => txn.Put(Keyspace.Meta, FormatKeys.Meta('format'), TupleCodec.Encode([2n])));
        await kv.dispose();
        await assert.rejects(GraphStore.OpenLmdb(dir), FormatVersionMismatchError);
        const foreign = GraphFx.Dir();
        const other = await LmdbStore.Open(foreign);
        await other.Write(async txn => txn.Put(Keyspace.Ids, Uint8Array.of(1), Uint8Array.of(1)));
        await other.dispose();
        await assert.rejects(GraphStore.OpenLmdb(foreign), FormatVersionMismatchError, 'non-empty store without a format marker');
    });
});
