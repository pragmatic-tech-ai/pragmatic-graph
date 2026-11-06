import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemberInput } from '../../catalog/CatalogTypes.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import type { CellValue } from '../../columns/CellValue.js';
import { DateValue } from '../../columns/CellValue.js';
import type { ColumnStore } from '../../columns/ColumnStore.js';
import type { EdgeStore } from '../../edges/EdgeStore.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { TupleCodec } from '../../format/TupleCodec.js';
import type { GraphContext } from '../../GraphContext.js';
import type { GraphReader } from '../../GraphReader.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import type { PublicIdIndex } from '../../identity/PublicIdIndex.js';
import type { RowIndex } from '../../identity/RowIndex.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { BatchApplier } from '../../txn/BatchApplier.js';
import { CommitError, CommitErrorCode } from '../../txn/CommitError.js';
import { ConflictError } from '../../txn/ConflictError.js';
import { CommitKind, type ICommitApplied } from '../../txn/LogEntry.js';
import type { IndexStore } from '../../indexes/IndexStore.js';
import { WriteBatch } from '../../txn/WriteBatch.js';
import type { DataPurger, IPurgeStats } from '../DataPurger.js';
import type { IDefinitionDescription, ISchemaDescription, ISeedLink, ISeedNode } from '../SchemaDescription.js';
import { SeedHash } from '../SeedHash.js';

/** The committer's private building blocks, reached by cast for the purge test seam (ruling R52). */
interface ICommitterInternals
{
    purger: DataPurger;
    readonly columns: ColumnStore;
    readonly edges: EdgeStore;
    readonly rows: RowIndex;
    readonly ids: PublicIdIndex;
    readonly indexes: IndexStore;
}

/**
 * Descriptions and probes for the seed tests. Schema: Server { name?, port: Int64?, hosts -> [App] many
 * ordered }, App { label? }, Box { code: String (required) }. Seed V1: s1 (owner base) hosts a1, a2;
 * a1, a2 (owner base); b1 (Box).
 */
class SeedFx
{
    private static readonly DirPrefix = 'pragmatic-graph-seed-';
    private static readonly Dirs: string[] = [];
    private static readonly AnyKey = { Start: Uint8Array.of(0x00), End: Uint8Array.of(0xff) };
    private static readonly Equals = '=';
    private static readonly SeedName = 'seed';
    public static readonly Base = 'base';
    public static readonly Hosts = 'hosts';
    public static readonly Uses = 'uses';
    public static readonly Abort = 'abort';

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), SeedFx.DirPrefix));
        SeedFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of SeedFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Prop(name: string, type: ValueType, nullable = true): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: type, Nullable: nullable };
    }

    public static Defs(extra: IDefinitionDescription[] = []): IDefinitionDescription[]
    {
        return [
            {
                Name: 'Server', IsAspect: false, Parent: null, Aspects: [], Members: [
                    SeedFx.Prop('name', ValueType.String),
                    SeedFx.Prop('port', ValueType.Int64),
                    { Name: SeedFx.Hosts, Kind: MemberKind.Relationship, Targets: ['App'], Many: true, Ordered: true },
                    { Name: SeedFx.Uses, Kind: MemberKind.Relationship, Targets: ['App', 'Server'], Many: true },
                ],
            },
            { Name: 'App', IsAspect: false, Parent: null, Aspects: [], Members: [SeedFx.Prop('label', ValueType.String)] },
            { Name: 'Box', IsAspect: false, Parent: null, Aspects: [], Members: [SeedFx.Prop('code', ValueType.String, false)] },
            ...extra,
        ];
    }

    /** A second catalog: V1 plus concept Extra. */
    public static ExtraDefs(): IDefinitionDescription[]
    {
        return SeedFx.Defs([{ Name: 'Extra', IsAspect: false, Parent: null, Aspects: [], Members: [] }]);
    }

    public static Node(publicId: string, concept: string, properties: Record<string, CellValue>, links: ISeedLink[] = [], owner = SeedFx.Base): ISeedNode
    {
        return { PublicId: publicId, Concept: concept, Owner: owner, Properties: properties, Links: links };
    }

    public static Hosting(...targets: string[]): ISeedLink[]
    {
        return targets.map(t => ({ Relationship: SeedFx.Hosts, To: t }));
    }

    /** s1 comes first and links forward to a1, a2. */
    public static Seed1(): ISeedNode[]
    {
        return [
            SeedFx.Node('s1', 'Server', { name: 'alpha' }, SeedFx.Hosting('a1', 'a2')),
            SeedFx.Node('a1', 'App', { label: 'one' }),
            SeedFx.Node('a2', 'App', { label: 'two' }),
            SeedFx.Node('b1', 'Box', { code: 'x' }),
        ];
    }

    /** Seed1 with the named node replaced (or removed when `node` is undefined). */
    public static With(publicId: string, node?: ISeedNode): ISeedNode[]
    {
        return SeedFx.Seed1().flatMap(n => n.PublicId !== publicId ? [n] : node === undefined ? [] : [node]);
    }

    public static Desc(version: string, seed: readonly ISeedNode[], defs: IDefinitionDescription[] = SeedFx.Defs()): ISchemaDescription
    {
        return { Version: version, Definitions: defs, Indexes: [], Seed: seed, Bindings: [] };
    }

    public static V1(): ISchemaDescription
    {
        return SeedFx.Desc('v1', SeedFx.Seed1());
    }

    public static async Ready(open: () => Promise<GraphStore>): Promise<GraphStore>
    {
        const g = await open();
        await g.Upgrade(SeedFx.V1());
        return g;
    }

    public static Context(g: GraphStore): GraphContext
    {
        return (g as unknown as { context: GraphContext }).context;
    }

    public static Internals(g: GraphStore): ICommitterInternals
    {
        return SeedFx.Context(g).Committer as unknown as ICommitterInternals;
    }

    public static async Commit(g: GraphStore, build: (t: GraphTransaction) => void): Promise<bigint>
    {
        const t = await g.Begin();
        build(t);
        return t.Commit();
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

    public static Hosted(g: GraphStore, server: string): Promise<string[]>
    {
        return SeedFx.Read(g, r => r.Neighbors(server, SeedFx.Hosts, EdgeDirection.Out));
    }

    public static async Changes(g: GraphStore, after: bigint = 0n): Promise<ICommitApplied[]>
    {
        const out: ICommitApplied[] = [];
        for await (const c of g.ReadChanges(after))
        {
            out.push(c);
        }
        return out;
    }

    public static Capture(g: GraphStore): ICommitApplied[]
    {
        const seen: ICommitApplied[] = [];
        g.CommitApplied.Subscribe(c => seen.push(c));
        return seen;
    }

    /** Public ids that have a raw Meta("seed", id) marker. */
    public static async Markers(g: GraphStore): Promise<string[]>
    {
        const txn = await SeedFx.Context(g).Store.BeginRead();
        try
        {
            const out: string[] = [];
            for await (const [key, value] of txn.Scan(Keyspace.Meta, SeedFx.AnyKey))
            {
                const tuple = TupleCodec.Decode(key);
                if (tuple[0] === SeedFx.SeedName)
                {
                    assert.equal(value.length, 32, 'marker value is a SHA-256 hash');
                    out.push(tuple[1] as string);
                }
            }
            return out.sort();
        }
        finally
        {
            txn.dispose();
        }
    }

    /** Every key and value of every keyspace, hex-encoded, for before/after equality. */
    public static async Snapshot(g: GraphStore): Promise<Record<string, string[]>>
    {
        const txn = await SeedFx.Context(g).Store.BeginRead();
        try
        {
            const out: Record<string, string[]> = {};
            for (const space of Object.values(Keyspace))
            {
                const rows: string[] = [];
                for await (const [key, value] of txn.Scan(space, SeedFx.AnyKey))
                {
                    rows.push(Buffer.from(key).toString('hex') + SeedFx.Equals + Buffer.from(value).toString('hex'));
                }
                out[space] = rows;
            }
            return out;
        }
        finally
        {
            txn.dispose();
        }
    }

    public static IsCommit(code: CommitErrorCode): (e: unknown) => boolean
    {
        return (e: unknown) => e instanceof CommitError && e.Code === code;
    }

    /**
     * Test seam: wraps the committer's purger so that, after the real purge, the n-th call (from 0)
     * deletes `victims[n]` inside the upgrade's write transaction (when there is one), as if the purge had
     * removed a node the seed pre-pass saw as present. Returns the call counter and a restore.
     */
    public static Sabotage(g: GraphStore, victims: string[]): { Calls: () => number; Restore: () => void }
    {
        const host = SeedFx.Internals(g);
        const real = host.purger;
        let calls = 0;
        host.purger = {
            Purge: async (...args: Parameters<DataPurger['Purge']>): Promise<IPurgeStats> =>
            {
                const stats = await real.Purge(...args);
                const victim = victims[calls++];
                if (victim !== undefined)
                {
                    const batch = new WriteBatch();
                    batch.DeleteNode(victim);
                    await new BatchApplier(args[2], host.columns, host.edges, host.rows, host.ids, host.indexes).Apply(args[0], batch.Seal(), []);
                }
                return stats;
            },
        } as unknown as DataPurger;
        return { Calls: () => calls, Restore: () => { host.purger = real; } };
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        describe('Seed on ' + name, () =>
        {
            it('first open loads seed', async () =>
            {
                const g = await open();
                const result = await g.Upgrade(SeedFx.V1());
                assert.equal(result.Changed, true);
                assert.equal(result.Commit, 1n);
                assert.equal(result.SeedCommit, 2n);
                await SeedFx.Read(g, async r =>
                {
                    assert.equal(await r.GetProperty('s1', 'name'), 'alpha');
                    assert.equal(await r.GetProperty('a2', 'label'), 'two');
                    assert.equal(await r.IsSeeded('s1'), true);
                    assert.equal(await r.IsSeeded('a1'), true);
                    assert.equal(await r.IsSeeded('nobody'), false);
                    assert.equal(await r.OwnerOf('s1'), SeedFx.Base);
                    assert.equal(await r.OwnerOf('a1'), SeedFx.Base);
                });
                assert.deepEqual(await SeedFx.Hosted(g, 's1'), ['a1', 'a2']);
                assert.deepEqual(await SeedFx.Markers(g), ['a1', 'a2', 'b1', 's1']);
                await g.dispose();
            });

            it('unchanged seed keeps runtime edit', async () =>
            {
                const g = await SeedFx.Ready(open);
                await SeedFx.Commit(g, t =>
                {
                    t.SetProperty('s1', 'name', 'edited');
                    t.CreateNode('a3', 'App');
                    t.Link('s1', SeedFx.Hosts, 'a3');
                });
                const last = SeedFx.Context(g).Committer.LastCommit();
                const seen = SeedFx.Capture(g);
                const result = await g.Upgrade(SeedFx.Desc('v1b', SeedFx.Seed1()));
                assert.equal(result.Changed, false);
                assert.equal(result.Commit, last);
                assert.equal(result.SeedCommit, undefined);
                assert.equal(await g.SchemaVersion(), 'v1b');
                assert.equal(seen.length, 0, 'an unchanged seed raises nothing');
                assert.equal((await SeedFx.Changes(g, last)).length, 0, 'and logs nothing');
                await SeedFx.Read(g, async r => assert.equal(await r.GetProperty('s1', 'name'), 'edited'));
                assert.deepEqual(await SeedFx.Hosted(g, 's1'), ['a1', 'a2', 'a3']);
                await g.dispose();
            });

            it('changed seed wins', async () =>
            {
                const g = await SeedFx.Ready(open);
                await SeedFx.Commit(g, t =>
                {
                    t.SetProperty('s1', 'name', 'edited');
                    t.SetProperty('s1', 'port', 8080n);
                    t.SetProperty('a1', 'label', 'runtime');
                    t.CreateNode('a3', 'App');
                    t.Link('s1', SeedFx.Hosts, 'a3');
                });
                const last = SeedFx.Context(g).Committer.LastCommit();
                const seen = SeedFx.Capture(g);
                const result = await g.Upgrade(SeedFx.Desc('v2', SeedFx.With('s1', SeedFx.Node('s1', 'Server', { name: 'beta' }, SeedFx.Hosting('a1', 'a2')))));
                assert.equal(result.Changed, false, 'the catalog is unchanged');
                assert.equal(result.Commit, last);
                assert.equal(result.SeedCommit, last + 1n);
                assert.equal(SeedFx.Context(g).Committer.LastCommit(), last + 1n);
                await SeedFx.Read(g, async r =>
                {
                    assert.equal(await r.GetProperty('s1', 'name'), 'beta');
                    assert.equal(await r.GetProperty('s1', 'port'), null, 'a property absent from the seed is nulled');
                    assert.equal(await r.GetProperty('a1', 'label'), 'runtime', 'a1 is unchanged in the seed');
                    assert.equal(await r.ConceptOf('a3'), 'App', 'runtime node untouched');
                });
                assert.deepEqual(await SeedFx.Hosted(g, 's1'), ['a1', 'a2'], 'out-edges replaced by the seed links');
                assert.deepEqual(seen.map(c => [c.Kind, c.Commit]), [[CommitKind.Batch, last + 1n]]);
                const entries = await SeedFx.Changes(g, last);
                assert.deepEqual(entries.map(e => e.Kind), [CommitKind.Batch]);
                assert.deepEqual(entries[0]?.CreatedIds, []);
                await g.dispose();
            });

            it('runtime node with seed id is taken over', async () =>
            {
                const g = await SeedFx.Ready(open);
                await SeedFx.Commit(g, t =>
                {
                    t.CreateNode('x1', 'App', { Owner: SeedFx.Base });
                    t.SetProperty('x1', 'label', 'rt');
                    t.CreateNode('x2', 'App');
                });
                await SeedFx.Read(g, async r => assert.equal(await r.IsSeeded('x1'), false));
                await g.Upgrade(SeedFx.Desc('v2', [...SeedFx.Seed1(), SeedFx.Node('x1', 'App', {})]));
                await SeedFx.Read(g, async r =>
                {
                    assert.equal(await r.IsSeeded('x1'), true);
                    assert.equal(await r.GetProperty('x1', 'label'), null);
                    assert.equal(await r.IsSeeded('x2'), false);
                });
                // A differing owner cannot be taken over: owner is create-time.
                const before = await SeedFx.Snapshot(g);
                await assert.rejects(g.Upgrade(SeedFx.Desc('v3', [...SeedFx.Seed1(), SeedFx.Node('x2', 'App', {})])), SeedFx.IsCommit(CommitErrorCode.InvalidValue));
                assert.deepEqual(await SeedFx.Snapshot(g), before);
                await g.dispose();
            });

            it('removed seed node is deleted; runtime nodes untouched', async () =>
            {
                const g = await SeedFx.Ready(open);
                await SeedFx.Commit(g, t =>
                {
                    t.CreateNode('r1', 'App');
                    t.SetProperty('r1', 'label', 'mine');
                });
                await g.Upgrade(SeedFx.Desc('v2', SeedFx.With('a2').map(n => n.PublicId !== 's1' ? n : SeedFx.Node('s1', 'Server', { name: 'alpha' }, SeedFx.Hosting('a1')))));
                await SeedFx.Read(g, async r =>
                {
                    assert.equal(await r.ConceptOf('a2'), undefined);
                    assert.equal(await r.IsSeeded('a2'), false);
                    assert.equal(await r.GetProperty('r1', 'label'), 'mine');
                    assert.equal(await r.IsSeeded('s1'), true);
                });
                assert.deepEqual(await SeedFx.Hosted(g, 's1'), ['a1']);
                assert.deepEqual(await SeedFx.Markers(g), ['a1', 'b1', 's1']);
                await g.dispose();
            });

            it('ordered links follow seed order', async () =>
            {
                const g = await open();
                await g.Upgrade(SeedFx.Desc('v1', SeedFx.With('s1', SeedFx.Node('s1', 'Server', {}, SeedFx.Hosting('a2', 'a1')))));
                assert.deepEqual(await SeedFx.Hosted(g, 's1'), ['a2', 'a1']);
                await g.Upgrade(SeedFx.Desc('v2', SeedFx.Seed1()));
                assert.deepEqual(await SeedFx.Hosted(g, 's1'), ['a1', 'a2']);
                await g.dispose();
            });

            it('seed failure aborts upgrade', async () =>
            {
                const g = await SeedFx.Ready(open);
                const committer = SeedFx.Context(g).Committer;
                const catalog = committer.Catalog;
                const last = committer.LastCommit();
                const seen = SeedFx.Capture(g);
                const before = await SeedFx.Snapshot(g);
                const bad = SeedFx.Desc('v2', SeedFx.With('s1', SeedFx.Node('s1', 'Server', {}, SeedFx.Hosting('ghost'))), SeedFx.ExtraDefs());
                await assert.rejects(g.Upgrade(bad), SeedFx.IsCommit(CommitErrorCode.UnknownNode));
                assert.equal(await g.SchemaVersion(), 'v1');
                assert.equal(committer.Catalog, catalog);
                assert.equal(committer.LastCommit(), last);
                assert.equal(seen.length, 0);
                assert.deepEqual(await SeedFx.Snapshot(g), before, 'every keyspace unchanged');
                // Also with an unchanged catalog (seed-only write).
                await assert.rejects(g.Upgrade(SeedFx.Desc('v2', bad.Seed)), SeedFx.IsCommit(CommitErrorCode.UnknownNode));
                assert.equal(await g.SchemaVersion(), 'v1');
                assert.deepEqual(await SeedFx.Snapshot(g), before);
                await g.dispose();
            });

            it('a non-nullable property absent from a changed seed is MissingRequired', async () =>
            {
                const g = await SeedFx.Ready(open);
                const before = await SeedFx.Snapshot(g);
                await assert.rejects(g.Upgrade(SeedFx.Desc('v2', SeedFx.With('b1', SeedFx.Node('b1', 'Box', {})))), SeedFx.IsCommit(CommitErrorCode.MissingRequired));
                await assert.rejects(g.Upgrade(SeedFx.Desc('v2', [...SeedFx.Seed1(), SeedFx.Node('b2', 'Box', {})])), SeedFx.IsCommit(CommitErrorCode.MissingRequired));
                assert.deepEqual(await SeedFx.Snapshot(g), before);
                await g.dispose();
            });

            it('changefeed has Upgrade then Batch', async () =>
            {
                const g = await open();
                const seen = SeedFx.Capture(g);
                await g.Upgrade(SeedFx.V1());
                const result = await g.Upgrade(SeedFx.Desc('v2', SeedFx.With('a1', SeedFx.Node('a1', 'App', { label: 'uno' })), SeedFx.ExtraDefs()));
                assert.equal(result.Commit, 3n);
                assert.equal(result.SeedCommit, 4n);
                const entries = await SeedFx.Changes(g);
                assert.deepEqual(entries.map(e => [e.Kind, e.Commit]), [[CommitKind.Upgrade, 1n], [CommitKind.Batch, 2n], [CommitKind.Upgrade, 3n], [CommitKind.Batch, 4n]]);
                assert.deepEqual(seen.map(e => [e.Kind, e.Commit]), entries.map(e => [e.Kind, e.Commit]));
                const first = entries[1] as ICommitApplied;
                assert.equal(first.CatalogVersion, 1);
                assert.equal(first.CreatedIds.length, 4);
                assert.equal(first.Batch.Ops().length, seen[1]?.Batch.Ops().length);
                assert.equal((entries[3] as ICommitApplied).CatalogVersion, 2);
                assert.equal((entries[3] as ICommitApplied).CreatedIds.length, 0);
                await g.dispose();
            });

            it('a purged seed node loses its marker; a runtime delete does too', async () =>
            {
                const g = await SeedFx.Ready(open);
                const noBox = SeedFx.Defs().filter(d => d.Name !== 'Box');
                const result = await g.Upgrade(SeedFx.Desc('v2', SeedFx.With('b1'), noBox));
                assert.equal(result.Changed, true);
                assert.equal(result.SeedCommit, undefined, 'the purge already removed b1: the seed changes nothing');
                assert.deepEqual(await SeedFx.Markers(g), ['a1', 'a2', 's1']);
                await SeedFx.Commit(g, t => t.DeleteNode('a1'));
                assert.deepEqual(await SeedFx.Markers(g), ['a2', 's1']);
                await SeedFx.Read(g, async r => assert.equal(await r.IsSeeded('a1'), false));
                // The next seed run recreates the deleted seed node.
                const again = await g.Upgrade(SeedFx.Desc('v3', SeedFx.With('b1'), noBox));
                assert.notEqual(again.SeedCommit, undefined);
                await SeedFx.Read(g, async r => assert.equal(await r.GetProperty('a1', 'label'), 'one'));
                assert.deepEqual(await SeedFx.Hosted(g, 's1'), ['a1', 'a2'], 'the unchanged s1 re-links the recreated a1 (ruling R55)');
                await g.dispose();
            });

            it('a seed node whose concept changed is recreated and keeps its seeded incoming links', async () =>
            {
                const g = await open();
                const uses = (): ISeedNode => SeedFx.Node('s1', 'Server', { name: 'alpha' }, [...SeedFx.Hosting('a1'), { Relationship: SeedFx.Uses, To: 'a2' }]);
                await g.Upgrade(SeedFx.Desc('v1', SeedFx.With('s1', uses())));
                await g.Upgrade(SeedFx.Desc('v2', [...SeedFx.With('s1', uses()).filter(n => n.PublicId !== 'a2'), SeedFx.Node('a2', 'Server', { name: 'was app' })]));
                await SeedFx.Read(g, async r =>
                {
                    assert.equal(await r.ConceptOf('a2'), 'Server');
                    assert.equal(await r.GetProperty('a2', 'name'), 'was app');
                    assert.equal(await r.IsSeeded('a2'), true);
                    assert.deepEqual(await r.Neighbors('s1', SeedFx.Uses, EdgeDirection.Out), ['a2'], 'the unchanged s1 re-links the recreated a2');
                });
                assert.deepEqual(await SeedFx.Hosted(g, 's1'), ['a1']);
                // A differing owner is InvalidValue even when the concept changes too.
                const before = await SeedFx.Snapshot(g);
                await assert.rejects(g.Upgrade(SeedFx.Desc('v3', [...SeedFx.With('s1', uses()).filter(n => n.PublicId !== 'a2'), SeedFx.Node('a2', 'App', {}, [], 'other')])), SeedFx.IsCommit(CommitErrorCode.InvalidValue));
                assert.deepEqual(await SeedFx.Snapshot(g), before);
                await g.dispose();
            });

            it('a seed with a repeated or malformed public id is rejected', async () =>
            {
                const g = await open();
                await assert.rejects(g.Upgrade(SeedFx.Desc('v1', [...SeedFx.Seed1(), SeedFx.Node('a1', 'App', {})])), SeedFx.IsCommit(CommitErrorCode.DuplicatePublicId));
                await assert.rejects(g.Upgrade(SeedFx.Desc('v1', [...SeedFx.Seed1(), SeedFx.Node('', 'App', {})])), SeedFx.IsCommit(CommitErrorCode.InvalidPublicId));
                await assert.rejects(g.Upgrade(SeedFx.Desc('v1', [...SeedFx.Seed1(), SeedFx.Node('a\u0000', 'App', {})])), SeedFx.IsCommit(CommitErrorCode.InvalidPublicId));
                assert.equal(await g.SchemaVersion(), undefined);
                await g.dispose();
            });

            it('a member hoisted to a parent: the seed restores the value the purge dropped from the losing sibling', async () =>
            {
                const g = await open();
                const tool = (members: MemberInput[], parent: string | null): IDefinitionDescription => ({ Name: 'Tool', IsAspect: false, Parent: parent, Aspects: [], Members: members });
                const label = SeedFx.Prop('label', ValueType.String);
                const seed = [...SeedFx.Seed1(), SeedFx.Node('t1', 'Tool', { label: 'tee' })];
                await g.Upgrade(SeedFx.Desc('v1', seed, SeedFx.Defs([tool([label], null)])));
                const hoisted = SeedFx.Defs([tool([], 'Labeled'), { Name: 'Labeled', IsAspect: false, Parent: null, Aspects: [], Members: [label] }])
                    .map(d => d.Name !== 'App' ? d : { ...d, Parent: 'Labeled', Members: [] });
                const result = await g.Upgrade(SeedFx.Desc('v2', seed, hoisted));
                assert.equal(result.Changed, true);
                assert.notEqual(result.SeedCommit, undefined, 'the losing sibling was re-seeded');
                await SeedFx.Read(g, async r =>
                {
                    assert.equal(await r.GetProperty('a1', 'label'), 'one');
                    assert.equal(await r.GetProperty('a2', 'label'), 'two');
                    assert.equal(await r.GetProperty('t1', 'label'), 'tee');
                });
                await g.dispose();
            });

            it('a relationship retargeted: the seed restores its edges, or fails when its target is no longer accepted', async () =>
            {
                const g = await SeedFx.Ready(open);
                const retarget = (targets: string[], extra: IDefinitionDescription[]): IDefinitionDescription[] => SeedFx.Defs(extra).map(d => d.Name !== 'Server' ? d : {
                    ...d, Members: d.Members.map(m => m.Name !== SeedFx.Hosts ? m : { ...m, Targets: targets }),
                });
                const extra: IDefinitionDescription = { Name: 'Extra', IsAspect: false, Parent: null, Aspects: [], Members: [] };
                const before = await SeedFx.Snapshot(g);
                await assert.rejects(g.Upgrade(SeedFx.Desc('v2', SeedFx.Seed1(), retarget(['Server'], []))), SeedFx.IsCommit(CommitErrorCode.TargetTypeMismatch));
                assert.equal(await g.SchemaVersion(), 'v1');
                assert.deepEqual(await SeedFx.Snapshot(g), before, 'store unchanged');
                await g.Upgrade(SeedFx.Desc('v2', SeedFx.Seed1(), retarget(['App', 'Extra'], [extra])));
                assert.deepEqual(await SeedFx.Hosted(g, 's1'), ['a1', 'a2']);
                await g.dispose();
            });

            it('an unchanged seed setting a property the new catalog removed fails the upgrade atomically', async () =>
            {
                const withoutName = SeedFx.Defs().map(d => d.Name !== 'Server' ? d : { ...d, Members: d.Members.filter(m => m.Name !== 'name') });
                // The purge dropped s1's value (s1 modified) ...
                const g = await SeedFx.Ready(open);
                const before = await SeedFx.Snapshot(g);
                await assert.rejects(g.Upgrade(SeedFx.Desc('v2', SeedFx.Seed1(), withoutName)), SeedFx.IsCommit(CommitErrorCode.UnknownMember));
                assert.deepEqual(await SeedFx.Snapshot(g), before);
                await g.dispose();
                // ... or the seed value was null, so the purge did not touch s1: validation against the new catalog catches it.
                const h = await open();
                const nullName = SeedFx.With('s1', SeedFx.Node('s1', 'Server', { name: null }, SeedFx.Hosting('a1', 'a2')));
                await h.Upgrade(SeedFx.Desc('v1', nullName));
                const hBefore = await SeedFx.Snapshot(h);
                await assert.rejects(h.Upgrade(SeedFx.Desc('v2', nullName, withoutName)), SeedFx.IsCommit(CommitErrorCode.UnknownMember));
                assert.equal(await h.SchemaVersion(), 'v1');
                assert.deepEqual(await SeedFx.Snapshot(h), hBefore);
                await h.dispose();
            });

            it('IsSeeded is a recorded read: a seed that rewrites the node conflicts the transaction', async () =>
            {
                const g = await SeedFx.Ready(open);
                const t = await g.Begin();
                assert.equal(await t.IsSeeded('a1'), true);
                t.CreateNode('z1', 'App');
                await g.Upgrade(SeedFx.Desc('v2', SeedFx.With('a1', SeedFx.Node('a1', 'App', { label: 'uno' }))));
                await assert.rejects(t.Commit(), ConflictError);
                await g.dispose();
            });

            it('a purge that removes a node the pre-pass saw is retried once with a fresh pre-pass', async () =>
            {
                const g = await SeedFx.Ready(open);
                const sabotage = SeedFx.Sabotage(g, ['a1']);
                const result = await g.Upgrade(SeedFx.Desc('v2', SeedFx.Seed1(), SeedFx.ExtraDefs()));
                sabotage.Restore();
                assert.equal(sabotage.Calls(), 2, 'the whole upgrade ran twice');
                assert.equal(result.Changed, true);
                assert.equal(result.SeedCommit, undefined, 'the retry saw a1 intact');
                await SeedFx.Read(g, async r => assert.equal(await r.GetProperty('a1', 'label'), 'one'));
                await g.dispose();
            });

            it('the retry succeeds only because it allocates the ids the first attempt missed', async () =>
            {
                const g = await SeedFx.Ready(open);
                // Both attempts' purges remove a1: the fresh pre-pass alone (a1 present, same hash) would miss again.
                const sabotage = SeedFx.Sabotage(g, ['a1', 'a1']);
                const result = await g.Upgrade(SeedFx.Desc('v2', SeedFx.Seed1(), SeedFx.ExtraDefs()));
                sabotage.Restore();
                assert.equal(sabotage.Calls(), 2);
                assert.notEqual(result.SeedCommit, undefined, 'a1 was recreated with the id allocated for the miss');
                await SeedFx.Read(g, async r => assert.equal(await r.GetProperty('a1', 'label'), 'one'));
                assert.deepEqual(await SeedFx.Hosted(g, 's1'), ['a1', 'a2']);
                await g.dispose();
            });

            it('a second id miss is GraphError Internal and changes nothing', async () =>
            {
                const g = await SeedFx.Ready(open);
                const before = await SeedFx.Snapshot(g);
                const sabotage = SeedFx.Sabotage(g, ['a1', 'a2']);
                await assert.rejects(g.Upgrade(SeedFx.Desc('v2', SeedFx.Seed1(), SeedFx.ExtraDefs())), (e: unknown) => e instanceof GraphError && !(e instanceof CommitError) && e.GraphCode === GraphErrorCode.Internal);
                sabotage.Restore();
                assert.equal(sabotage.Calls(), 2);
                assert.equal(await g.SchemaVersion(), 'v1');
                assert.deepEqual(await SeedFx.Snapshot(g), before);
                await g.dispose();
            });
        });
    }
}

describe('SeedHash', () =>
{
    it('is 32 bytes, independent of property order, dependent on link order and value types', () =>
    {
        const a = SeedHash.Of(SeedFx.Node('n', 'C', { x: 1n, y: 'v' }, SeedFx.Hosting('p', 'q')));
        const b = SeedHash.Of(SeedFx.Node('n', 'C', { y: 'v', x: 1n }, SeedFx.Hosting('p', 'q')));
        assert.equal(a.length, 32);
        assert.deepEqual(a, b);
        assert.notDeepEqual(a, SeedHash.Of(SeedFx.Node('n', 'C', { x: 1n, y: 'v' }, SeedFx.Hosting('q', 'p'))));
        assert.notDeepEqual(a, SeedHash.Of(SeedFx.Node('n', 'C', { x: 1, y: 'v' }, SeedFx.Hosting('p', 'q'))));
        assert.notDeepEqual(a, SeedHash.Of(SeedFx.Node('n', 'C', { x: 1n, y: 'v' }, SeedFx.Hosting('p', 'q'), 'other')));
        assert.notDeepEqual(
            SeedHash.Of(SeedFx.Node('n', 'C', { d: new DateValue(3) })),
            SeedHash.Of(SeedFx.Node('n', 'C', { d: 3n })),
        );
        const withProps = SeedHash.Of(SeedFx.Node('n', 'C', {}, [{ Relationship: 'r', To: 't', Properties: { w: 2n } }]));
        assert.notDeepEqual(withProps, SeedHash.Of(SeedFx.Node('n', 'C', {}, [{ Relationship: 'r', To: 't' }])));
    });
});

after(() => SeedFx.RemoveDirs());
SeedFx.Register('memory', () => GraphStore.OpenMemory());
SeedFx.Register('lmdb', () => GraphStore.OpenLmdb(SeedFx.Dir()));

describe('Seed durability on LMDB', () =>
{
    it('seed markers survive a reopen; the same version is a no-op', async () =>
    {
        const dir = SeedFx.Dir();
        const g = await SeedFx.Ready(() => GraphStore.OpenLmdb(dir));
        await g.dispose();
        const reopened = await GraphStore.OpenLmdb(dir);
        await SeedFx.Read(reopened, async r => assert.equal(await r.IsSeeded('s1'), true));
        const last = SeedFx.Context(reopened).Committer.LastCommit();
        const again = await reopened.Upgrade(SeedFx.V1());
        assert.equal(again.SeedCommit, undefined);
        assert.equal(SeedFx.Context(reopened).Committer.LastCommit(), last);
        await reopened.dispose();
    });
});
