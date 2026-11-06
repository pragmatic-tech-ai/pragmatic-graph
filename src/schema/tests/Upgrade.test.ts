import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogError, CatalogErrorCode } from '../../catalog/CatalogError.js';
import type { MemberInput } from '../../catalog/CatalogTypes.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { EdgeDirection, IdsTag } from '../../format/FormatKeys.js';
import { TupleCodec } from '../../format/TupleCodec.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import type { GraphContext } from '../../GraphContext.js';
import type { GraphReader } from '../../GraphReader.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { ColumnStore } from '../../columns/ColumnStore.js';
import { EdgeStore } from '../../edges/EdgeStore.js';
import { PublicIdIndex } from '../../identity/PublicIdIndex.js';
import { RowIndex } from '../../identity/RowIndex.js';
import { CatalogIndex } from '../../txn/CatalogIndex.js';
import { WriteKeySet } from '../../txn/WriteKeySet.js';
import { CatalogPlanner } from '../CatalogPlanner.js';
import { DataPurger, type IPurgeStats } from '../DataPurger.js';
import { CommitKind, type ICommitApplied } from '../../txn/LogEntry.js';
import { ConflictError } from '../../txn/ConflictError.js';
import { ConflictKeys } from '../../txn/ConflictKeys.js';
import { ReadSet } from '../../txn/ReadSet.js';
import { WriteBatch } from '../../txn/WriteBatch.js';
import type { IDefinitionDescription, ISchemaDescription } from '../SchemaDescription.js';

/** Descriptions, store factories and raw-keyspace probes for the upgrade tests. */
class UpgradeFx
{
    private static readonly DirPrefix = 'pragmatic-graph-upgrade-';
    private static readonly Dirs: string[] = [];
    private static readonly AnyKey = { Start: Uint8Array.of(0x00), End: Uint8Array.of(0xff) };
    public static readonly Abort = 'abort purge';
    private static readonly Equals = '=';
    private static readonly Probe = 'probe';

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), UpgradeFx.DirPrefix));
        UpgradeFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of UpgradeFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Prop(name: string, type: ValueType, nullable = true): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: type, Nullable: nullable };
    }

    public static Rel(name: string, targets: string[]): MemberInput
    {
        return { Name: name, Kind: MemberKind.Relationship, Targets: targets, Many: true };
    }

    public static Concept(name: string, members: MemberInput[], parent: string | null = null): IDefinitionDescription
    {
        return { Name: name, IsAspect: false, Parent: parent, Aspects: [], Members: members };
    }

    public static Desc(version: string, defs: IDefinitionDescription[]): ISchemaDescription
    {
        return { Version: version, Definitions: defs, Indexes: [], Seed: [], Bindings: [] };
    }

    /**
     * Person { name?, authored -> [Note, Doc], cites -> [Doc] }, Doc { title? }, Note { text? },
     * Memo : Doc, Item { size: Int64? }.
     */
    public static V1(): ISchemaDescription
    {
        return UpgradeFx.Desc('v1', UpgradeFx.V1Defs());
    }

    public static V1Defs(): IDefinitionDescription[]
    {
        return [
            UpgradeFx.Concept('Person', [UpgradeFx.Prop('name', ValueType.String), UpgradeFx.Rel('authored', ['Note', 'Doc']), UpgradeFx.Rel('cites', ['Doc'])]),
            UpgradeFx.Concept('Doc', [UpgradeFx.Prop('title', ValueType.String)]),
            UpgradeFx.Concept('Note', [UpgradeFx.Prop('text', ValueType.String)]),
            UpgradeFx.Concept('Memo', [UpgradeFx.Prop('body', ValueType.String)], 'Doc'),
            UpgradeFx.Concept('Item', [UpgradeFx.Prop('size', ValueType.Int64)]),
        ];
    }

    /** V1 with the named definition replaced (or removed when `def` is undefined). */
    public static Replace(version: string, name: string, def?: IDefinitionDescription): ISchemaDescription
    {
        const defs = UpgradeFx.V1Defs().flatMap(d => d.Name !== name ? [d] : def === undefined ? [] : [def]);
        return UpgradeFx.Desc(version, defs);
    }

    /** V1 without Note; authored then targets only Doc (a retarget: a new member id). */
    public static WithoutNote(version: string): ISchemaDescription
    {
        const defs = UpgradeFx.V1Defs().filter(d => d.Name !== 'Note').map(d => d.Name !== 'Person' ? d : UpgradeFx.Concept('Person', [
            UpgradeFx.Prop('name', ValueType.String), UpgradeFx.Rel('authored', ['Doc']), UpgradeFx.Rel('cites', ['Doc']),
        ]));
        return UpgradeFx.Desc(version, defs);
    }

    /** V1 data: p1 (Person), d1 (Doc), n1 (Note, owner 'm'), m1 (Memo, with title), i1/i2 (Item); p1 authored n1, d1; p1 cites d1, m1. */
    public static async Seed(g: GraphStore): Promise<void>
    {
        await UpgradeFx.Commit(g, t =>
        {
            t.CreateNode('p1', 'Person');
            t.SetProperty('p1', 'name', 'Ann');
            t.CreateNode('d1', 'Doc');
            t.SetProperty('d1', 'title', 'Spec');
            t.CreateNode('n1', 'Note', { Owner: 'm' });
            t.SetProperty('n1', 'text', 'hello');
            t.CreateNode('m1', 'Memo');
            t.SetProperty('m1', 'body', 'memo');
            t.SetProperty('m1', 'title', 'Inherited');
            t.CreateNode('i1', 'Item');
            t.SetProperty('i1', 'size', 10n);
            t.CreateNode('i2', 'Item');
            t.SetProperty('i2', 'size', 20n);
            t.Link('p1', 'authored', 'n1');
            t.Link('p1', 'authored', 'd1');
            t.Link('p1', 'cites', 'd1');
            t.Link('p1', 'cites', 'm1');
        });
    }

    public static async Ready(open: () => Promise<GraphStore>): Promise<GraphStore>
    {
        const g = await open();
        await g.Upgrade(UpgradeFx.V1());
        await UpgradeFx.Seed(g);
        return g;
    }

    public static async Commit(g: GraphStore, build: (t: GraphTransaction) => void): Promise<bigint>
    {
        const t = await g.Begin();
        build(t);
        return t.Commit();
    }

    public static Context(g: GraphStore): GraphContext
    {
        return (g as unknown as { context: GraphContext }).context;
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

    public static async Nodes(g: GraphStore, concept: string): Promise<string[]>
    {
        return UpgradeFx.Read(g, async r =>
        {
            const out: string[] = [];
            for await (const id of r.ScanNodes(concept))
            {
                out.push(id);
            }
            return out.sort();
        });
    }

    /** Every key of the keyspace, decoded as a tuple. */
    public static async RawKeys(g: GraphStore, space: Keyspace): Promise<unknown[][]>
    {
        const txn = await UpgradeFx.Context(g).Store.BeginRead();
        try
        {
            const out: unknown[][] = [];
            for await (const [key] of txn.Scan(space, UpgradeFx.AnyKey))
            {
                out.push(TupleCodec.Decode(key));
            }
            return out;
        }
        finally
        {
            txn.dispose();
        }
    }

    public static async InternalId(g: GraphStore, publicId: string): Promise<bigint>
    {
        const context = UpgradeFx.Context(g);
        const txn = await context.Store.BeginRead();
        try
        {
            return (await context.Ids.Resolve(txn, publicId)) as bigint;
        }
        finally
        {
            txn.dispose();
        }
    }

    public static async Located(g: GraphStore, id: bigint): Promise<boolean>
    {
        const context = UpgradeFx.Context(g);
        const txn = await context.Store.BeginRead();
        try
        {
            return (await context.Rows.Locate(txn, id)) !== undefined;
        }
        finally
        {
            txn.dispose();
        }
    }

    /** Asserts no stored key anywhere still mentions the removed node (ids, rows, edges). */
    public static async AssertNodeGone(g: GraphStore, publicId: string, id: bigint): Promise<void>
    {
        const ids = await UpgradeFx.RawKeys(g, Keyspace.Ids);
        assert.ok(!ids.some(k => k[0] === BigInt(IdsTag.PublicToInternal) && k[1] === publicId), 'public id binding of ' + publicId);
        assert.ok(!ids.some(k => (k[0] === BigInt(IdsTag.InternalToPublic) || k[0] === BigInt(IdsTag.Owner)) && k[1] === id), 'id/owner keys of ' + publicId);
        assert.equal(await UpgradeFx.Located(g, id), false, 'row of ' + publicId);
        const edges = await UpgradeFx.RawKeys(g, Keyspace.Edges);
        assert.ok(!edges.some(k => k[3] === id || k[5] === id), 'edges of ' + publicId);
    }

    /** The positive control of AssertNodeGone: every probed key exists while the node is live. */
    public static async AssertNodePresent(g: GraphStore, publicId: string, id: bigint): Promise<void>
    {
        const ids = await UpgradeFx.RawKeys(g, Keyspace.Ids);
        assert.ok(ids.some(k => k[0] === BigInt(IdsTag.PublicToInternal) && k[1] === publicId));
        assert.ok(ids.some(k => k[0] === BigInt(IdsTag.InternalToPublic) && k[1] === id));
        assert.ok(ids.some(k => k[0] === BigInt(IdsTag.Owner) && k[1] === id), 'owner key (create with an owner)');
        assert.equal(await UpgradeFx.Located(g, id), true);
        assert.ok((await UpgradeFx.RawKeys(g, Keyspace.Edges)).some(k => k[3] === id || k[5] === id));
    }

    /** Every key and value of every keyspace, hex-encoded, for before/after equality. */
    public static async Snapshot(g: GraphStore): Promise<Record<string, string[]>>
    {
        const txn = await UpgradeFx.Context(g).Store.BeginRead();
        try
        {
            const out: Record<string, string[]> = {};
            for (const space of Object.values(Keyspace))
            {
                const rows: string[] = [];
                for await (const [key, value] of txn.Scan(space, UpgradeFx.AnyKey))
                {
                    rows.push(ConflictKeys.Hex(key) + UpgradeFx.Equals + ConflictKeys.Hex(value));
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

    /**
     * Each (space, key) is in the write set of a commit after `snapshot`: a batch that read only that key
     * conflicts. A batch that read an untouched key (d1's binding) still commits.
     */
    public static async AssertWritten(g: GraphStore, snapshot: bigint, reads: Array<[Keyspace, Uint8Array]>): Promise<void>
    {
        const committer = UpgradeFx.Context(g).Committer;
        let n = 0;
        for (const [space, key] of reads)
        {
            const set = new ReadSet();
            set.AddKey(space, key);
            const batch = new WriteBatch();
            batch.CreateNode(UpgradeFx.Probe + n++, 'Doc');
            await assert.rejects(committer.Submit(batch, set, snapshot), ConflictError, space + UpgradeFx.Equals + ConflictKeys.Hex(key));
        }
        const untouched = new ReadSet();
        untouched.AddKey(ConflictKeys.NodeSpace, ConflictKeys.Node('d1'));
        const batch = new WriteBatch();
        batch.CreateNode(UpgradeFx.Probe + n, 'Doc');
        await committer.Submit(batch, untouched, snapshot);
    }

    public static Capture(g: GraphStore): ICommitApplied[]
    {
        const seen: ICommitApplied[] = [];
        g.CommitApplied.Subscribe(c => seen.push(c));
        return seen;
    }

    public static IsUnknownType(error: unknown): boolean
    {
        return error instanceof CatalogError && error.Code === CatalogErrorCode.UnknownType;
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        describe('Upgrade on ' + name, () =>
        {
            it('first upgrade on empty store defines catalog and version', async () =>
            {
                const g = await open();
                const seen = UpgradeFx.Capture(g);
                assert.equal(await g.SchemaVersion(), undefined);
                const result = await g.Upgrade(UpgradeFx.V1());
                assert.equal(result.Changed, true);
                assert.equal(result.Commit, 1n);
                assert.equal(result.Catalog.Version, 1);
                assert.equal(await g.SchemaVersion(), 'v1');
                assert.equal(seen.length, 1);
                assert.equal(seen[0]?.Kind, CommitKind.Upgrade);
                assert.equal(seen[0]?.SchemaVersion, 'v1');
                assert.equal(seen[0]?.CatalogVersion, 1);
                assert.deepEqual(seen[0]?.Catalog?.Definitions(), result.Catalog.Definitions());
                await g.dispose();
            });

            it('same version twice is a no-op; a new version with the same schema only rewrites the version', async () =>
            {
                const g = await open();
                await g.Upgrade(UpgradeFx.V1());
                const seen = UpgradeFx.Capture(g);
                const again = await g.Upgrade(UpgradeFx.V1());
                assert.equal(again.Changed, false);
                assert.equal(again.Commit, 1n);
                assert.equal(again.Catalog.Version, 1);
                const renamed = await g.Upgrade(UpgradeFx.Desc('v1b', UpgradeFx.V1Defs()));
                assert.equal(renamed.Changed, false);
                assert.equal(renamed.Commit, 1n);
                assert.equal(await g.SchemaVersion(), 'v1b');
                assert.equal(seen.length, 0);
                const entries: ICommitApplied[] = [];
                for await (const c of g.ReadChanges(0n))
                {
                    entries.push(c);
                }
                assert.equal(entries.length, 1, 'no log entry for a version-only change');
                await g.dispose();
            });

            it('a changed catalog with an empty diff (nullable false to true) is persisted and logged', async () =>
            {
                const g = await open();
                await g.Upgrade(UpgradeFx.Replace('a', 'Item', UpgradeFx.Concept('Item', [UpgradeFx.Prop('size', ValueType.Int64, false)])));
                await UpgradeFx.Commit(g, t =>
                {
                    t.CreateNode('i1', 'Item');
                    t.SetProperty('i1', 'size', 5n);
                });
                const result = await g.Upgrade(UpgradeFx.V1());
                assert.equal(result.Changed, true);
                assert.equal(result.Catalog.Version, 2);
                assert.equal(result.Catalog.Member('Item', 'size').Nullable, true);
                await UpgradeFx.Read(g, async r => assert.equal(await r.GetProperty('i1', 'size'), 5n));
                await g.dispose();
            });

            it('removed concept discards its nodes', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const noteType = UpgradeFx.Context(g).Committer.Catalog.TypeId('Note');
                const n1 = await UpgradeFx.InternalId(g, 'n1');
                await UpgradeFx.AssertNodePresent(g, 'n1', n1);
                assert.ok((await UpgradeFx.RawKeys(g, Keyspace.Deltas)).some(k => k[1] === BigInt(noteType)), 'probe: Note has cells before');
                assert.ok((await UpgradeFx.RawKeys(g, Keyspace.Meta)).some(k => k[0] === 'slots' && k[2] === BigInt(noteType)), 'probe: Note slot counter before');
                const v2 = UpgradeFx.WithoutNote('v2');
                const result = await g.Upgrade(v2);
                assert.equal(result.Changed, true);
                await UpgradeFx.Read(g, async r =>
                {
                    await assert.rejects(async () =>
                    {
                        for await (const _ of r.ScanNodes('Note'))
                        {
                            // drain
                        }
                    }, UpgradeFx.IsUnknownType);
                    assert.equal(await r.ConceptOf('n1'), undefined);
                    assert.equal(await r.GetProperty('d1', 'title'), 'Spec');
                });
                for (const space of [Keyspace.Columns, Keyspace.Deltas])
                {
                    assert.ok(!(await UpgradeFx.RawKeys(g, space)).some(k => k[1] === BigInt(noteType)), 'no ' + space + ' key of Note');
                }
                const meta = await UpgradeFx.RawKeys(g, Keyspace.Meta);
                assert.ok(!meta.some(k => k[0] === 'slots' && k[2] === BigInt(noteType)), 'Note slot counter removed');
                await UpgradeFx.AssertNodeGone(g, 'n1', n1);
                await g.dispose();
            });

            it('purge removes incoming edges on surviving nodes', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const n1 = await UpgradeFx.InternalId(g, 'n1');
                const m1 = await UpgradeFx.InternalId(g, 'm1');
                // authored retargets to [Doc] (a new member id): all its edges go. Memo is removed while
                // cites keeps its id: only the edge into m1 goes, stored under the surviving p1.
                const v2 = UpgradeFx.WithoutNote('v2');
                const v3 = UpgradeFx.Desc('v2', v2.Definitions.filter(d => d.Name !== 'Memo'));
                const before = UpgradeFx.Context(g).Committer.Catalog.Member('Person', 'cites').Id;
                const result = await g.Upgrade(v3);
                assert.equal(result.Catalog.Member('Person', 'cites').Id, before, 'cites kept its id');
                await UpgradeFx.Read(g, async r =>
                {
                    assert.deepEqual(await r.Neighbors('p1', 'authored', EdgeDirection.Out), []);
                    assert.deepEqual(await r.Neighbors('p1', 'cites', EdgeDirection.Out), ['d1']);
                    assert.deepEqual(await r.Neighbors('d1', 'cites', EdgeDirection.In), ['p1']);
                    assert.deepEqual(await r.Neighbors('d1', 'authored', EdgeDirection.In), []);
                });
                const edges = await UpgradeFx.RawKeys(g, Keyspace.Edges);
                assert.ok(!edges.some(k => k[3] === n1 || k[5] === n1 || k[3] === m1 || k[5] === m1));
                assert.equal(edges.length, 2, 'only p1 cites d1 remains (Out and In)');
                await UpgradeFx.AssertNodeGone(g, 'm1', m1);
                await g.dispose();
            });

            it('changed hierarchy keeps the nodes but drops edges whose targets no longer accept them', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const catalog = UpgradeFx.Context(g).Committer.Catalog;
                const before = catalog.Member('Person', 'cites').Id;
                const memo = BigInt(catalog.TypeId('Memo'));
                const titleId = BigInt(catalog.Member('Memo', 'title').Id);
                const titleKeys = async (): Promise<boolean> =>
                {
                    for (const space of [Keyspace.Columns, Keyspace.Deltas])
                    {
                        if ((await UpgradeFx.RawKeys(g, space)).some(k => k[1] === memo && k[2] === titleId))
                        {
                            return true;
                        }
                    }
                    return false;
                };
                assert.equal(await titleKeys(), true, 'probe: Memo.title cells before');
                const result = await g.Upgrade(UpgradeFx.Replace('v2', 'Memo', UpgradeFx.Concept('Memo', [UpgradeFx.Prop('body', ValueType.String)])));
                assert.ok(result.Catalog.Definitions().some(d => d.Name === 'Memo'));
                assert.equal(result.Catalog.Member('Person', 'cites').Id, before, 'cites kept its id: only the target rule removes the edge');
                await UpgradeFx.Read(g, async r =>
                {
                    assert.equal(await r.ConceptOf('m1'), 'Memo');
                    assert.equal(await r.GetProperty('m1', 'body'), 'memo');
                    assert.deepEqual(await r.Neighbors('p1', 'cites', EdgeDirection.Out), ['d1']);
                    assert.deepEqual((await r.Neighbors('p1', 'authored', EdgeDirection.Out)).sort(), ['d1', 'n1']);
                    // title was inherited from Doc: no longer on Memo.
                    await assert.rejects(r.GetProperty('m1', 'title'), CatalogError);
                });
                const m1 = await UpgradeFx.InternalId(g, 'm1');
                assert.ok(!(await UpgradeFx.RawKeys(g, Keyspace.Edges)).some(k => k[3] === m1 || k[5] === m1), 'no edge key of m1 left');
                assert.equal(await titleKeys(), false, 'the no longer inherited Memo.title column is dropped');
                await g.dispose();
            });

            it('retyped member drops values', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const old = UpgradeFx.Context(g).Committer.Catalog;
                const item = old.TypeId('Item');
                const sizeId = old.Member('Item', 'size').Id;
                assert.ok((await UpgradeFx.RawKeys(g, Keyspace.Deltas)).some(k => k[1] === BigInt(item) && k[2] === BigInt(sizeId)), 'probe: size delta before');
                await g.Upgrade(UpgradeFx.Replace('v2', 'Item', UpgradeFx.Concept('Item', [UpgradeFx.Prop('size', ValueType.String)])));
                await UpgradeFx.Read(g, async r =>
                {
                    assert.equal(await r.GetProperty('i1', 'size'), null);
                    assert.equal(await r.GetProperty('i2', 'size'), null);
                });
                assert.deepEqual(await UpgradeFx.Nodes(g, 'Item'), ['i1', 'i2']);
                for (const space of [Keyspace.Columns, Keyspace.Deltas])
                {
                    assert.ok(!(await UpgradeFx.RawKeys(g, space)).some(k => k[1] === BigInt(item) && k[2] === BigInt(sizeId)), 'old size column in ' + space);
                }
                await UpgradeFx.Commit(g, t => t.SetProperty('i1', 'size', 'big'));
                await UpgradeFx.Read(g, async r => assert.equal(await r.GetProperty('i1', 'size'), 'big'));
                await g.dispose();
            });

            it('new required member discards existing nodes', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const i1 = await UpgradeFx.InternalId(g, 'i1');
                await g.Upgrade(UpgradeFx.Replace('v2', 'Item', UpgradeFx.Concept('Item', [UpgradeFx.Prop('size', ValueType.Int64), UpgradeFx.Prop('code', ValueType.String, false)])));
                assert.deepEqual(await UpgradeFx.Nodes(g, 'Item'), []);
                assert.deepEqual(await UpgradeFx.Nodes(g, 'Person'), ['p1']);
                await UpgradeFx.AssertNodeGone(g, 'i1', i1);
                await UpgradeFx.Read(g, async r => assert.equal(await r.ConceptOf('i1'), undefined));
                // The public id is free again; the dropped slot stays dead.
                await UpgradeFx.Commit(g, t =>
                {
                    t.CreateNode('i1', 'Item');
                    t.SetProperty('i1', 'code', 'A');
                });
                await UpgradeFx.Read(g, async r =>
                {
                    assert.equal(await r.GetProperty('i1', 'code'), 'A');
                    assert.equal(await r.GetProperty('i1', 'size'), null);
                });
                await g.dispose();
            });

            it('a required member that becomes effective removes only the nodes that lack a value', async () =>
            {
                const g = await open();
                await g.Upgrade(UpgradeFx.Desc('a', [
                    UpgradeFx.Concept('A', [UpgradeFx.Prop('code', ValueType.String, false)]),
                    UpgradeFx.Concept('B', [UpgradeFx.Prop('note', ValueType.String)]),
                ]));
                await UpgradeFx.Commit(g, t =>
                {
                    t.CreateNode('a1', 'A');
                    t.SetProperty('a1', 'code', 'x');
                    t.CreateNode('b1', 'B');
                    t.SetProperty('b1', 'note', 'n');
                });
                // code hoists to a shared parent: A keeps its column (and id), B gains it without values.
                const result = await g.Upgrade(UpgradeFx.Desc('b', [
                    UpgradeFx.Concept('P', [UpgradeFx.Prop('code', ValueType.String, false)]),
                    UpgradeFx.Concept('A', [], 'P'),
                    UpgradeFx.Concept('B', [UpgradeFx.Prop('note', ValueType.String)], 'P'),
                ]));
                assert.equal(result.Changed, true);
                assert.deepEqual(await UpgradeFx.Nodes(g, 'A'), ['a1']);
                assert.deepEqual(await UpgradeFx.Nodes(g, 'B'), []);
                await UpgradeFx.Read(g, async r => assert.equal(await r.GetProperty('a1', 'code'), 'x'));
                await g.dispose();
            });

            it('purge reports what it removed', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const context = UpgradeFx.Context(g);
                const old = new CatalogIndex(context.Committer.Catalog);
                const desc = UpgradeFx.Desc('v2', UpgradeFx.WithoutNote('v2').Definitions.filter(d => d.Name !== 'Memo').map(d =>
                    d.Name === 'Item' ? UpgradeFx.Concept('Item', [UpgradeFx.Prop('size', ValueType.String)]) : d));
                const plan = CatalogPlanner.Plan(old.Catalog, desc);
                const purger = new DataPurger(new ColumnStore(), new EdgeStore(), new RowIndex(), new PublicIdIndex());
                let stats: IPurgeStats | undefined;
                // Purge then abort: the store must be unchanged.
                await assert.rejects(context.Store.Write(async txn =>
                {
                    stats = await purger.Purge(txn, old, new CatalogIndex(plan.Catalog), plan.Diff, new WriteKeySet());
                    throw new Error(UpgradeFx.Abort);
                }), new RegExp(UpgradeFx.Abort));
                // n1 and m1; n1.text, m1.body, m1.title, i1.size, i2.size; authored p1->n1, p1->d1 (retargeted), cites p1->m1.
                assert.deepEqual(stats, { NodesRemoved: 2, ValuesRemoved: 5, EdgesRemoved: 3 });
                assert.deepEqual(await UpgradeFx.Nodes(g, 'Note'), ['n1']);
                await g.dispose();
            });

            it('a purge that removes many nodes of a surviving concept compacts their deltas', async () =>
            {
                const g = await open();
                await g.Upgrade(UpgradeFx.V1());
                await UpgradeFx.Commit(g, t =>
                {
                    for (let i = 0; i < 600; i++)
                    {
                        t.CreateNode('i' + i, 'Item');
                        t.SetProperty('i' + i, 'size', BigInt(i));
                    }
                });
                await g.Upgrade(UpgradeFx.Replace('v2', 'Item', UpgradeFx.Concept('Item', [UpgradeFx.Prop('size', ValueType.Int64), UpgradeFx.Prop('code', ValueType.String, false)])));
                assert.deepEqual(await UpgradeFx.Nodes(g, 'Item'), []);
                const item = UpgradeFx.Context(g).Committer.Catalog.TypeId('Item');
                assert.ok(!(await UpgradeFx.RawKeys(g, Keyspace.Deltas)).some(k => k[1] === BigInt(item)), 'deltas over the threshold were folded into their chunks');
                await g.dispose();
            });

            it('open transaction conflicts after upgrade', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const t = await g.Begin();
                assert.equal(await t.GetProperty('d1', 'title'), 'Spec');
                t.SetProperty('d1', 'title', 'Changed');
                await g.Upgrade(UpgradeFx.Replace('v2', 'Item'));
                await assert.rejects(t.Commit(), ConflictError);
                await g.dispose();
            });

            it('purge records the write keys of everything it removes', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const committer = UpgradeFx.Context(g).Committer;
                const old = committer.Catalog;
                const snapshot = committer.LastCommit();
                const handle = committer.RegisterSnapshot();
                const i1 = await UpgradeFx.InternalId(g, 'i1');
                const p1 = await UpgradeFx.InternalId(g, 'p1');
                const m1 = await UpgradeFx.InternalId(g, 'm1');
                const cites = old.Member('Person', 'cites').Id;
                const sizeId = old.Member('Item', 'size').Id;
                await g.Upgrade(UpgradeFx.Desc('v2', UpgradeFx.V1Defs().filter(d => d.Name !== 'Memo').map(d =>
                    d.Name === 'Item' ? UpgradeFx.Concept('Item', [UpgradeFx.Prop('size', ValueType.String)]) : d)));
                await UpgradeFx.AssertWritten(g, snapshot, [
                    [ConflictKeys.NodeSpace, ConflictKeys.Node('m1')],
                    [ConflictKeys.ExtentSpace, ConflictKeys.Extent(old.TypeId('Memo'))],
                    [ConflictKeys.EdgeSpace, ConflictKeys.Edge(cites, EdgeDirection.Out, p1, m1)],
                    [ConflictKeys.EdgeSpace, ConflictKeys.Edge(cites, EdgeDirection.In, m1, p1)],
                    [ConflictKeys.CellSpace, ConflictKeys.Cell(i1, sizeId)],
                    [ConflictKeys.ColumnSpace, ConflictKeys.Column(old.TypeId('Item'), sizeId)],
                ]);
                handle.dispose();
                await g.dispose();
            });

            it('purge records the write keys of rejected-target edges and of nodes removed from a surviving concept', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const committer = UpgradeFx.Context(g).Committer;
                const old = committer.Catalog;
                const snapshot = committer.LastCommit();
                const handle = committer.RegisterSnapshot();
                const i1 = await UpgradeFx.InternalId(g, 'i1');
                const p1 = await UpgradeFx.InternalId(g, 'p1');
                const m1 = await UpgradeFx.InternalId(g, 'm1');
                const cites = old.Member('Person', 'cites').Id;
                const item = old.TypeId('Item');
                const sizeId = old.Member('Item', 'size').Id;
                // Memo leaves Doc (cites keeps its id but rejects Memo); Item gains a required member (i1, i2 go).
                await g.Upgrade(UpgradeFx.Desc('v2', UpgradeFx.V1Defs().map(d =>
                {
                    if (d.Name === 'Memo')
                    {
                        return UpgradeFx.Concept('Memo', [UpgradeFx.Prop('body', ValueType.String)]);
                    }
                    return d.Name !== 'Item' ? d : UpgradeFx.Concept('Item', [UpgradeFx.Prop('size', ValueType.Int64), UpgradeFx.Prop('code', ValueType.String, false)]);
                })));
                assert.equal(committer.Catalog.Member('Person', 'cites').Id, cites);
                await UpgradeFx.AssertWritten(g, snapshot, [
                    [ConflictKeys.EdgeSpace, ConflictKeys.Edge(cites, EdgeDirection.Out, p1, m1)],
                    [ConflictKeys.EdgeSpace, ConflictKeys.Edge(cites, EdgeDirection.In, m1, p1)],
                    [ConflictKeys.NodeSpace, ConflictKeys.Node('i1')],
                    [ConflictKeys.ExtentSpace, ConflictKeys.Extent(item)],
                    [ConflictKeys.CellSpace, ConflictKeys.Cell(i1, 0)],
                    [ConflictKeys.CellSpace, ConflictKeys.Cell(i1, sizeId)],
                    [ConflictKeys.ColumnSpace, ConflictKeys.Column(item, sizeId)],
                ]);
                handle.dispose();
                await g.dispose();
            });

            it('an upgrade whose write fails leaves the store, the catalog and the version unchanged', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const committer = UpgradeFx.Context(g).Committer;
                const last = committer.LastCommit();
                const catalog = committer.Catalog;
                const seen = UpgradeFx.Capture(g);
                const before = await UpgradeFx.Snapshot(g);
                // Test seam: the committer's private purger is replaced by one that purges, then fails,
                // so the Write aborts after the purge has written into its transaction.
                const host = committer as unknown as { purger: DataPurger };
                const real = host.purger;
                host.purger = {
                    Purge: async (...args: Parameters<DataPurger['Purge']>): Promise<IPurgeStats> =>
                    {
                        await real.Purge(...args);
                        throw new Error(UpgradeFx.Abort);
                    },
                } as unknown as DataPurger;
                await assert.rejects(g.Upgrade(UpgradeFx.WithoutNote('v2')), new RegExp(UpgradeFx.Abort));
                host.purger = real;
                assert.equal(committer.LastCommit(), last);
                assert.equal(committer.Catalog, catalog);
                assert.equal(await g.SchemaVersion(), 'v1');
                assert.equal(seen.length, 0);
                assert.deepEqual(await UpgradeFx.Snapshot(g), before, 'every keyspace unchanged');
                await UpgradeFx.Read(g, async r => assert.deepEqual((await r.Neighbors('p1', 'authored', EdgeDirection.Out)).sort(), ['d1', 'n1']));
                // The committer is still usable: the same upgrade now succeeds.
                const result = await g.Upgrade(UpgradeFx.WithoutNote('v2'));
                assert.equal(result.Commit, last + 1n);
                assert.deepEqual(await UpgradeFx.Nodes(g, 'Doc'), ['d1', 'm1']);
                await g.dispose();
            });

            it('changefeed replays upgrade', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const second = await g.Upgrade(UpgradeFx.Replace('v2', 'Item'));
                const entries: ICommitApplied[] = [];
                for await (const c of g.ReadChanges(0n))
                {
                    entries.push(c);
                }
                assert.deepEqual(entries.map(e => e.Kind), [CommitKind.Upgrade, CommitKind.Batch, CommitKind.Upgrade]);
                const first = entries[0] as ICommitApplied;
                assert.equal(first.SchemaVersion, 'v1');
                assert.equal(first.CatalogVersion, 1);
                const last = entries[2] as ICommitApplied;
                assert.equal(last.Commit, second.Commit);
                assert.equal(last.SchemaVersion, 'v2');
                assert.deepEqual(last.Catalog?.Definitions(), second.Catalog.Definitions());
                assert.equal(last.Batch.Count, 0);
                assert.deepEqual(last.CreatedIds, []);
                await g.dispose();
            });

            it('failed plan leaves store unchanged', async () =>
            {
                const g = await UpgradeFx.Ready(open);
                const last = UpgradeFx.Context(g).Committer.LastCommit();
                const bad = UpgradeFx.Desc('v2', [UpgradeFx.Concept('Orphan', [], 'NoSuchParent')]);
                await assert.rejects(g.Upgrade(bad), CatalogError);
                assert.equal(await g.SchemaVersion(), 'v1');
                assert.equal(UpgradeFx.Context(g).Committer.LastCommit(), last);
                assert.deepEqual(await UpgradeFx.Nodes(g, 'Note'), ['n1']);
                await g.dispose();
            });

            it('rejects a version that is not well-formed UTF-16', async () =>
            {
                const g = await open();
                await assert.rejects(g.Upgrade(UpgradeFx.Desc('\ud800', UpgradeFx.V1Defs())), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
                assert.equal(await g.SchemaVersion(), undefined);
                await g.dispose();
            });
        });
    }
}

after(() => UpgradeFx.RemoveDirs());
UpgradeFx.Register('memory', () => GraphStore.OpenMemory());
UpgradeFx.Register('lmdb', () => GraphStore.OpenLmdb(UpgradeFx.Dir()));

describe('Upgrade durability on LMDB', () =>
{
    it('the purged data, catalog and schema version survive a reopen', async () =>
    {
        const dir = UpgradeFx.Dir();
        const g = await UpgradeFx.Ready(() => GraphStore.OpenLmdb(dir));
        const n1 = await UpgradeFx.InternalId(g, 'n1');
        const v2 = UpgradeFx.WithoutNote('v2');
        const result = await g.Upgrade(v2);
        await g.dispose();
        const reopened = await GraphStore.OpenLmdb(dir);
        assert.equal(await reopened.SchemaVersion(), 'v2');
        assert.equal(UpgradeFx.Context(reopened).Committer.Catalog.Version, result.Catalog.Version);
        assert.equal(UpgradeFx.Context(reopened).Committer.LastCommit(), result.Commit);
        await UpgradeFx.AssertNodeGone(reopened, 'n1', n1);
        assert.deepEqual(await UpgradeFx.Nodes(reopened, 'Doc'), ['d1', 'm1']);
        const again = await reopened.Upgrade(v2);
        assert.equal(again.Changed, false);
        await reopened.dispose();
    });
});
