import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogModel } from '../../catalog/CatalogModel.js';
import { CatalogSnapshot } from '../../catalog/CatalogSnapshot.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { CellValue } from '../../columns/CellValue.js';
import { ColumnStore } from '../../columns/ColumnStore.js';
import { EdgeError, EdgeErrorCode } from '../../edges/EdgeError.js';
import { EdgeStore } from '../../edges/EdgeStore.js';
import { EdgeDirection, FormatKeys } from '../../format/FormatKeys.js';
import { TupleCodec } from '../../format/TupleCodec.js';
import { IdAllocator } from '../../identity/IdAllocator.js';
import { PublicIdIndex } from '../../identity/PublicIdIndex.js';
import { RowIndex } from '../../identity/RowIndex.js';
import type { IKeyRange, IKeyValueStore, IReadTransaction, IWriteTransaction } from '../../kv/KeyValue.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { LmdbStore } from '../../kv/lmdb/LmdbStore.js';
import { MemoryStore } from '../../kv/memory/MemoryStore.js';
import { CommitError, CommitErrorCode } from '../CommitError.js';
import { CommitLog } from '../CommitLog.js';
import { Committer } from '../Committer.js';
import { ConflictError } from '../ConflictError.js';
import { ConflictKeys } from '../ConflictKeys.js';
import { ReadSet } from '../ReadSet.js';
import { WriteBatch } from '../WriteBatch.js';

/** Records which keyspaces a write transaction put into. */
class SpyTxn implements IWriteTransaction
{
    public readonly Spaces = new Set<Keyspace>();

    public constructor(private readonly inner: IWriteTransaction)
    {
    }

    public Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>
    {
        return this.inner.Get(space, key);
    }

    public Scan(space: Keyspace, range: IKeyRange, limit?: number): AsyncIterable<[Uint8Array, Uint8Array]>
    {
        return this.inner.Scan(space, range, limit);
    }

    public Put(space: Keyspace, key: Uint8Array, value: Uint8Array): void
    {
        this.Spaces.add(space);
        this.inner.Put(space, key, value);
    }

    public Delete(space: Keyspace, key: Uint8Array): void
    {
        this.Spaces.add(space);
        this.inner.Delete(space, key);
    }

    public dispose(): void
    {
        this.inner.dispose();
    }
}

/**
 * Counts storage writes. A Write started while another one's work is running is a nested Write (which
 * would deadlock the single-writer mutex): it is counted and rejected instead of queued.
 */
class CountingStore implements IKeyValueStore
{
    private static readonly ErrNested = 'nested Write';

    public Writes = 0;
    public Nested = 0;
    /** Committed writes that appended to the commit log (group writes). */
    public LogWrites = 0;
    /** Committed writes that did not touch the log (id block reservations and the like). */
    public OtherWrites = 0;
    private active = 0;

    public constructor(private readonly inner: IKeyValueStore)
    {
    }

    public BeginRead(): Promise<IReadTransaction>
    {
        return this.inner.BeginRead();
    }

    public async Write<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        this.Writes++;
        if (this.active > 0)
        {
            this.Nested++;
            throw new Error(CountingStore.ErrNested);
        }
        let spy: SpyTxn | undefined;
        const result = await this.inner.Write(async txn =>
        {
            this.active++;
            spy = new SpyTxn(txn);
            try
            {
                return await work(spy);
            }
            finally
            {
                this.active--;
            }
        });
        if (spy?.Spaces.has(Keyspace.Log) === true)
        {
            this.LogWrites++;
        }
        else
        {
            this.OtherWrites++;
        }
        return result;
    }

    public Reset(): void
    {
        this.Writes = 0;
        this.Nested = 0;
        this.LogWrites = 0;
        this.OtherWrites = 0;
    }

    public dispose(): Promise<void>
    {
        return this.inner.dispose();
    }
}

/** A committer whose first allocator open fails, to prove a failed open is not cached. */
class FlakyAllocatorCommitter extends Committer
{
    public Failures = 1;
    public Opens = 0;

    protected override OpenAllocator(): Promise<IdAllocator>
    {
        this.Opens++;
        if (this.Failures > 0)
        {
            this.Failures--;
            return Promise.reject(new Error('allocator open failed'));
        }
        return super.OpenAllocator();
    }
}

/** A read set whose validation throws, to inject a failure into a running group. */
class ExplodingReadSet extends ReadSet
{
    public override get IsEmpty(): boolean
    {
        throw new Error('read set exploded');
    }

    public override Clone(): ReadSet
    {
        return this;
    }
}

/** Reads graph state back through the storage building blocks. */
class Probe
{
    private readonly ids = new PublicIdIndex();
    private readonly rows = new RowIndex();
    private readonly columns = new ColumnStore();
    private readonly edges = new EdgeStore();

    public constructor(private readonly store: IKeyValueStore, private readonly catalog: CatalogSnapshot)
    {
    }

    public async Id(publicId: string): Promise<bigint | undefined>
    {
        return this.Read(txn => this.ids.Resolve(txn, publicId));
    }

    public async RequireId(publicId: string): Promise<bigint>
    {
        const id = await this.Id(publicId);
        assert.ok(id !== undefined, 'unknown ' + publicId);
        return id;
    }

    public async Cell(publicId: string, member: string): Promise<CellValue>
    {
        const id = await this.RequireId(publicId);
        return this.Read(async txn =>
        {
            const loc = await this.rows.Locate(txn, id);
            assert.ok(loc !== undefined);
            const concept = this.catalog.Definitions().find(d => d.TypeId === loc.TypeId)!.Name;
            return this.columns.ReadCell(txn, loc, this.catalog.Member(concept, member));
        });
    }

    public async Neighbors(publicId: string, concept: string, relationship: string, direction: EdgeDirection): Promise<string[]>
    {
        const id = await this.RequireId(publicId);
        const rel = this.catalog.Member(concept, relationship);
        return this.Read(async txn =>
        {
            const out: string[] = [];
            for await (const n of this.edges.Neighbors(txn, rel, id, direction))
            {
                out.push((await this.ids.PublicIdOf(txn, n.Node)) ?? ('#' + n.Node));
            }
            return out;
        });
    }

    public async RawNeighborCount(relationshipId: number, direction: EdgeDirection, node: bigint): Promise<number>
    {
        return this.Read(async txn =>
        {
            let n = 0;
            for await (const _ of txn.Scan(Keyspace.Edges, FormatKeys.EdgeRange(0, relationshipId, direction, node)))
            {
                n++;
            }
            return n;
        });
    }

    public async Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>
    {
        return this.Read(txn => txn.Get(space, key));
    }

    public async Read<T>(work: (txn: IReadTransaction) => Promise<T>): Promise<T>
    {
        const txn = await this.store.BeginRead();
        try
        {
            return await work(txn);
        }
        finally
        {
            txn.dispose();
        }
    }
}

class TxnFx
{
    private static readonly DirPrefix = 'pragmatic-graph-txn-';
    private static readonly Dirs: string[] = [];

    /** Person (carries aspect Party) and Company; relationships cover Many, one-valued, ordered and aspect targets. */
    public static Catalog(): CatalogSnapshot
    {
        const m = new CatalogModel();
        m.DefineAspect('Party', [], [{ Name: 'tag', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]);
        m.DefineConcept('Person', null, ['Party'], [
            { Name: 'name', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: 'age', Kind: MemberKind.Property, Type: ValueType.Int64, Nullable: true },
            { Name: 'knows', Kind: MemberKind.Relationship, Targets: ['Person'], Many: true },
            { Name: 'best', Kind: MemberKind.Relationship, Targets: ['Person'] },
            {
                Name: 'friends', Kind: MemberKind.Relationship, Targets: ['Person'], Many: true, Ordered: true,
                EdgeProperties: [{ Name: 'weight', Kind: MemberKind.Property, Type: ValueType.Int64, Nullable: true }],
            },
            { Name: 'employer', Kind: MemberKind.Relationship, Targets: ['Company'] },
        ]);
        m.DefineConcept('Company', null, [], [
            { Name: 'title', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: 'staff', Kind: MemberKind.Relationship, Targets: ['Person'], Many: true },
            { Name: 'clients', Kind: MemberKind.Relationship, Targets: ['Party'], Many: true },
        ]);
        m.DefineConcept('Badge', null, [], [
            { Name: 'code', Kind: MemberKind.Property, Type: ValueType.String, Nullable: false },
            { Name: 'note', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: 'holder', Kind: MemberKind.Relationship, Targets: ['Person'] },
        ]);
        return m.Seal();
    }

    public static async OpenLmdb(): Promise<IKeyValueStore>
    {
        const dir = mkdtempSync(join(tmpdir(), TxnFx.DirPrefix));
        TxnFx.Dirs.push(dir);
        return LmdbStore.Open(dir);
    }

    public static RemoveDirs(): void
    {
        for (const d of TxnFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Batch(build: (b: WriteBatch) => void): WriteBatch
    {
        const b = new WriteBatch();
        build(b);
        return b;
    }

    /** Commits one batch creating the given Person nodes. */
    public static async People(c: Committer, ...ids: string[]): Promise<bigint>
    {
        return c.Submit(TxnFx.Batch(b => ids.forEach(id => b.CreateNode(id, 'Person'))), new ReadSet(), c.LastCommit());
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

    public static async CommitCode(work: Promise<unknown>): Promise<CommitErrorCode | undefined>
    {
        const outcome = await TxnFx.Settle(work);
        assert.ok(outcome instanceof CommitError, 'expected CommitError, got ' + String(outcome));
        return outcome.Code;
    }

    public static ReadsCell(id: bigint, memberId: number): ReadSet
    {
        const r = new ReadSet();
        r.AddKey(ConflictKeys.CellSpace, ConflictKeys.Cell(id, memberId));
        return r;
    }

    public static async Register(name: string, open: () => Promise<IKeyValueStore>): Promise<void>
    {
        describe('committer on ' + name, () =>
        {
            it('a read of A.name racing a committed update of A.name is a ConflictError', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'a');
                const probe = new Probe(store, catalog);
                const a = await probe.RequireId('a');
                const name = catalog.Member('Person', 'name').Id;
                const snapshot = c.LastCommit();
                await c.Submit(TxnFx.Batch(b => b.SetProperty('a', 'name', 'Ann')), new ReadSet(), snapshot);
                const racing = TxnFx.Batch(b => b.SetProperty('a', 'age', 30n));
                const outcome = await TxnFx.Settle(c.Submit(racing, TxnFx.ReadsCell(a, name), snapshot));
                assert.ok(outcome instanceof ConflictError);
                assert.equal(await probe.Cell('a', 'age'), null);
                assert.equal(await probe.Cell('a', 'name'), 'Ann');
                await store.dispose();
            });

            it('transactions on disjoint nodes both commit', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'a', 'b');
                const probe = new Probe(store, catalog);
                const name = catalog.Member('Person', 'name').Id;
                const a = await probe.RequireId('a');
                const b = await probe.RequireId('b');
                const snapshot = c.LastCommit();
                const first = await c.Submit(TxnFx.Batch(x => x.SetProperty('a', 'name', 'A')), TxnFx.ReadsCell(a, name), snapshot);
                const second = await c.Submit(TxnFx.Batch(x => x.SetProperty('b', 'name', 'B')), TxnFx.ReadsCell(b, name), snapshot);
                assert.deepEqual([first, second], [snapshot + 1n, snapshot + 2n]);
                assert.equal(await probe.Cell('a', 'name'), 'A');
                assert.equal(await probe.Cell('b', 'name'), 'B');
                await store.dispose();
            });

            it('a range read over A\'s outgoing edges is invalidated by a later Link from A (phantom), on both endpoints', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'a', 'b', 'x');
                const probe = new Probe(store, catalog);
                const a = await probe.RequireId('a');
                const b = await probe.RequireId('b');
                const knows = catalog.Member('Person', 'knows').Id;
                const snapshot = c.LastCommit();
                await c.Submit(TxnFx.Batch(x => x.Link('a', 'knows', 'b')), new ReadSet(), snapshot);
                const outReader = new ReadSet();
                outReader.AddRange(ConflictKeys.EdgeSpace, ConflictKeys.Adjacency(knows, EdgeDirection.Out, a));
                const inReader = new ReadSet();
                inReader.AddRange(ConflictKeys.EdgeSpace, ConflictKeys.Adjacency(knows, EdgeDirection.In, b));
                const otherRel = new ReadSet();
                otherRel.AddRange(ConflictKeys.EdgeSpace, ConflictKeys.Adjacency(catalog.Member('Person', 'friends').Id, EdgeDirection.Out, a));
                const write = (): WriteBatch => TxnFx.Batch(x => x.SetProperty('x', 'age', 1n));
                assert.ok((await TxnFx.Settle(c.Submit(write(), outReader, snapshot))) instanceof ConflictError);
                assert.ok((await TxnFx.Settle(c.Submit(write(), inReader, snapshot))) instanceof ConflictError);
                await c.Submit(write(), otherRel, snapshot + 1n);
                await store.dispose();
            });

            it('five concurrent Submits commit 1..5 in submission order through one group Write; ids are allocated outside it', async () =>
            {
                const store = new CountingStore(await open());
                const c = await Committer.Open(store, TxnFx.Catalog());
                store.Reset();
                const submits = [1, 2, 3, 4, 5].map(i => c.Submit(TxnFx.Batch(b => b.CreateNode('n' + i, 'Person')), new ReadSet(), 0n));
                assert.deepEqual(await Promise.all(submits), [1n, 2n, 3n, 4n, 5n]);
                assert.equal(store.LogWrites, 1);
                assert.equal(store.Nested, 0);
                assert.equal(store.OtherWrites, 1, 'exactly one id block reservation, before the group Write');
                assert.equal(store.Writes, 2);
                const probe = new Probe(store, TxnFx.Catalog());
                const ids = await Promise.all([1, 2, 3, 4, 5].map(i => probe.RequireId('n' + i)));
                assert.deepEqual(ids, [...ids].sort((x, y) => (x < y ? -1 : 1)), 'ids follow submission order');
                assert.equal(c.LastCommit(), 5n);
                await store.dispose();
            });

            it('a Submit arriving while a group is writing joins the next group', async () =>
            {
                const store = new CountingStore(await open());
                const c = await Committer.Open(store, TxnFx.Catalog());
                await TxnFx.People(c, 'a');
                store.Reset();
                const first = c.Submit(TxnFx.Batch(b => b.SetProperty('a', 'age', 1n)), new ReadSet(), 1n);
                await Promise.resolve();
                await Promise.resolve();
                const rest = [2n, 3n].map(v => c.Submit(TxnFx.Batch(b => b.SetProperty('a', 'age', v)), new ReadSet(), 1n));
                assert.deepEqual(await Promise.all([first, ...rest]), [2n, 3n, 4n]);
                assert.ok(store.LogWrites >= 1 && store.LogWrites <= 2);
                assert.equal(await new Probe(store, TxnFx.Catalog()).Cell('a', 'age'), 3n);
                await store.dispose();
            });

            it('CommitApplied fires once per commit, in order, with a batch equal to the submitted one', async () =>
            {
                const store = await open();
                const c = await Committer.Open(store, TxnFx.Catalog());
                const seen: Array<{ Commit: bigint; Batch: WriteBatch }> = [];
                const sub = c.CommitApplied.Subscribe(e => seen.push(e));
                const batches = [
                    TxnFx.Batch(b => b.CreateNode('a', 'Person', 'h')),
                    TxnFx.Batch(b => { b.CreateNode('b', 'Person'); b.SetProperty('b', 'name', 'Bo'); }),
                    TxnFx.Batch(b => b.Link('a', 'friends', 'b', { Properties: new Map([['weight', 3n]]) })),
                ];
                const commits = await Promise.all(batches.map(b => c.Submit(b, new ReadSet(), 0n)));
                assert.deepEqual(commits, [1n, 2n, 3n]);
                assert.deepEqual(seen.map(e => e.Commit), [1n, 2n, 3n]);
                for (let i = 0; i < batches.length; i++)
                {
                    assert.deepEqual(seen[i]!.Batch, batches[i]);
                    assert.notEqual(seen[i]!.Batch, batches[i]);
                }
                sub.dispose();
                await TxnFx.People(c, 'z');
                assert.equal(seen.length, 3);
                await store.dispose();
            });

            it('a throwing CommitApplied subscriber does not fail the commit or starve other subscribers', async () =>
            {
                const store = await open();
                const c = await Committer.Open(store, TxnFx.Catalog());
                const seen: bigint[] = [];
                c.CommitApplied.Subscribe(() =>
                {
                    throw new Error('subscriber bug');
                });
                c.CommitApplied.Subscribe(e => seen.push(e.Commit));
                assert.equal(await TxnFx.People(c, 'a'), 1n);
                assert.deepEqual(seen, [1n]);
                await store.dispose();
            });

            it('the log entry for commit n deserializes to the batch; Meta("commit") holds the last commit', async () =>
            {
                const store = await open();
                const c = await Committer.Open(store, TxnFx.Catalog());
                const one = TxnFx.Batch(b => b.CreateNode('a', 'Person'));
                const two = TxnFx.Batch(b => b.SetProperty('a', 'name', 'x'));
                await c.Submit(one, new ReadSet(), 0n);
                await c.Submit(two, new ReadSet(), 1n);
                const log = new CommitLog();
                const probe = new Probe(store, TxnFx.Catalog());
                await probe.Read(async txn =>
                {
                    assert.deepEqual(await log.Read(txn, 1n), one);
                    assert.deepEqual(await log.Read(txn, 2n), two);
                    assert.equal(await log.Read(txn, 3n), undefined);
                    assert.equal(await CommitLog.ReadLastCommit(txn), 2n);
                    const scanned: bigint[] = [];
                    for await (const e of log.Scan(txn, 1n))
                    {
                        scanned.push(e.Commit);
                        assert.deepEqual(e.Batch, two);
                    }
                    assert.deepEqual(scanned, [2n]);
                });
                const raw = await probe.Get(Keyspace.Log, FormatKeys.LogEntry(2n));
                assert.deepEqual(raw, two.Serialize());
                assert.deepEqual(await probe.Get(Keyspace.Meta, FormatKeys.Meta('commit')), TupleCodec.Encode([2n]));
                await store.dispose();
            });

            it('in one group, a batch reading what an earlier batch writes is rejected; the others commit', async () =>
            {
                const store = new CountingStore(await open());
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'a', 'b', 'c');
                const probe = new Probe(store, catalog);
                const a = await probe.RequireId('a');
                const name = catalog.Member('Person', 'name').Id;
                store.Reset();
                const s = c.LastCommit();
                const p1 = c.Submit(TxnFx.Batch(b => b.SetProperty('a', 'name', 'one')), new ReadSet(), s);
                const p2 = c.Submit(TxnFx.Batch(b => b.SetProperty('b', 'name', 'two')), TxnFx.ReadsCell(a, name), s);
                const p3 = c.Submit(TxnFx.Batch(b => b.SetProperty('c', 'name', 'three')), new ReadSet(), s);
                const [r1, r2, r3] = await Promise.all([p1, p2, p3].map(p => TxnFx.Settle(p)));
                assert.equal(r1, s + 1n);
                assert.ok(r2 instanceof ConflictError);
                assert.equal(r3, s + 2n);
                assert.equal(store.LogWrites, 1);
                assert.equal(await probe.Cell('b', 'name'), null);
                assert.equal(await probe.Cell('c', 'name'), 'three');
                await store.dispose();
            });

            it('a batch failing semantically mid-group rejects alone, leaves no trace, and readers of its writes still commit', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'a', 'b', 'c');
                const probe = new Probe(store, catalog);
                const b = await probe.RequireId('b');
                const name = catalog.Member('Person', 'name').Id;
                const s = c.LastCommit();
                const seen: bigint[] = [];
                c.CommitApplied.Subscribe(e => seen.push(e.Commit));
                const good1 = TxnFx.Batch(x => x.SetProperty('a', 'name', 'A'));
                const bad = TxnFx.Batch(x =>
                {
                    x.SetProperty('b', 'name', 'B');
                    x.CreateNode('z', 'Person');
                    x.Link('b', 'knows', 'z');
                    x.Link('b', 'knows', 'nobody');
                });
                const reader = TxnFx.Batch(x => x.SetProperty('c', 'age', 9n));
                const good2 = TxnFx.Batch(x => x.SetProperty('c', 'name', 'C'));
                const outcomes = await Promise.all([
                    c.Submit(good1, new ReadSet(), s),
                    c.Submit(bad, new ReadSet(), s),
                    c.Submit(reader, TxnFx.ReadsCell(b, name), s),
                    c.Submit(good2, new ReadSet(), s),
                ].map(p => TxnFx.Settle(p)));
                assert.equal(outcomes[0], s + 1n);
                assert.ok(outcomes[1] instanceof CommitError);
                assert.equal(outcomes[1].Code, CommitErrorCode.UnknownNode);
                assert.equal(outcomes[2], s + 2n);
                assert.equal(outcomes[3], s + 3n);
                assert.deepEqual(seen, [s + 1n, s + 2n, s + 3n]);
                assert.equal(await probe.Cell('b', 'name'), null);
                assert.equal(await probe.Id('z'), undefined);
                assert.deepEqual(await probe.Neighbors('b', 'Person', 'knows', EdgeDirection.Out), []);
                assert.equal(await probe.Cell('a', 'name'), 'A');
                assert.equal(await probe.Cell('c', 'name'), 'C');
                const log = new CommitLog();
                await probe.Read(async txn =>
                {
                    assert.deepEqual(await log.Read(txn, s + 1n), good1);
                    assert.deepEqual(await log.Read(txn, s + 2n), reader);
                    assert.deepEqual(await log.Read(txn, s + 3n), good2);
                    assert.equal(await log.Read(txn, s + 4n), undefined);
                });
                await store.dispose();
            });

            it('DeleteNode removes Out and In edges (aspect targets too), nulls member 0, clears the row and frees the public id', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await c.Submit(TxnFx.Batch(b =>
                {
                    b.CreateNode('p', 'Person');
                    b.CreateNode('q', 'Person');
                    b.CreateNode('co', 'Company');
                    b.SetProperty('p', 'name', 'Pat');
                    b.Link('p', 'knows', 'q');
                    b.Link('p', 'knows', 'p');
                    b.Link('q', 'friends', 'p');
                    b.Link('p', 'employer', 'co');
                    b.Link('co', 'staff', 'p');
                    b.Link('co', 'clients', 'p');
                    b.Link('co', 'clients', 'q');
                }), new ReadSet(), 0n);
                const probe = new Probe(store, catalog);
                const p = await probe.RequireId('p');
                const knows = catalog.Member('Person', 'knows').Id;
                const snapshot = c.LastCommit();
                await c.Submit(TxnFx.Batch(b => b.DeleteNode('p')), new ReadSet(), snapshot);
                assert.equal(await probe.Id('p'), undefined);
                assert.deepEqual(await probe.Neighbors('q', 'Person', 'knows', EdgeDirection.In), []);
                assert.deepEqual(await probe.Neighbors('q', 'Person', 'friends', EdgeDirection.Out), []);
                assert.deepEqual(await probe.Neighbors('co', 'Company', 'staff', EdgeDirection.Out), []);
                assert.deepEqual(await probe.Neighbors('co', 'Company', 'clients', EdgeDirection.Out), ['q']);
                assert.deepEqual(await probe.Neighbors('co', 'Person', 'employer', EdgeDirection.In), []);
                for (const dir of [EdgeDirection.Out, EdgeDirection.In])
                {
                    assert.equal(await probe.RawNeighborCount(knows, dir, p), 0);
                }
                await probe.Read(async txn =>
                {
                    assert.equal(await new RowIndex().Locate(txn, p), undefined);
                    assert.equal(await new PublicIdIndex().PublicIdOf(txn, p), undefined);
                    const typeId = catalog.TypeId('Person');
                    const live: number[] = [];
                    for await (const cell of new ColumnStore().ScanColumn(txn, 0, typeId, CatalogSnapshot.NodeIdMember))
                    {
                        live.push(cell.Slot);
                    }
                    assert.equal(live.length, 1, 'only q is still live');
                });
                // The deletion conflicts with readers of the node, its cells and its edges.
                const nodeReader = new ReadSet();
                nodeReader.AddKey(ConflictKeys.NodeSpace, ConflictKeys.Node('p'));
                const cellReader = TxnFx.ReadsCell(p, catalog.Member('Person', 'name').Id);
                const q = await probe.RequireId('q');
                const edgeReader = new ReadSet();
                edgeReader.AddRange(ConflictKeys.EdgeSpace, ConflictKeys.Adjacency(catalog.Member('Person', 'friends').Id, EdgeDirection.Out, q));
                for (const r of [nodeReader, cellReader, edgeReader])
                {
                    assert.ok((await TxnFx.Settle(c.Submit(new WriteBatch(), r, snapshot))) instanceof ConflictError);
                }
                const again = await c.Submit(TxnFx.Batch(b => b.CreateNode('p', 'Person')), new ReadSet(), c.LastCommit());
                assert.equal(again, c.LastCommit());
                assert.notEqual(await probe.RequireId('p'), p);
                assert.equal(await probe.Cell('p', 'name'), null);
                await store.dispose();
            });

            it('CreateNode and DeleteNode conflict with readers of the concept extent', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                const s = c.LastCommit();
                await TxnFx.People(c, 'a');
                const people = new ReadSet();
                people.AddRange(ConflictKeys.ExtentSpace, ConflictKeys.ExtentRange(catalog.TypeId('Person')));
                const companies = new ReadSet();
                companies.AddRange(ConflictKeys.ExtentSpace, ConflictKeys.ExtentRange(catalog.TypeId('Company')));
                assert.ok((await TxnFx.Settle(c.Submit(new WriteBatch(), people, s))) instanceof ConflictError);
                await c.Submit(new WriteBatch(), companies, s);
                await store.dispose();
            });

            it('retains write sets back to the oldest registered snapshot, else only the latest commit', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'a', 'b');
                const pinned = c.RegisterSnapshot();
                assert.equal(pinned.Commit, 1n);
                for (const v of [1n, 2n, 3n])
                {
                    await c.Submit(TxnFx.Batch(b => b.SetProperty('a', 'age', v)), new ReadSet(), c.LastCommit());
                }
                const probe = new Probe(store, catalog);
                const a = await probe.RequireId('a');
                const b = await probe.RequireId('b');
                const age = catalog.Member('Person', 'age').Id;
                const touchB = (): WriteBatch => TxnFx.Batch(x => x.SetProperty('b', 'name', 'n'));
                assert.ok((await TxnFx.Settle(c.Submit(touchB(), TxnFx.ReadsCell(a, age), 1n))) instanceof ConflictError);
                assert.equal(await c.Submit(touchB(), TxnFx.ReadsCell(b, age), 1n), 5n);
                pinned.dispose();
                pinned.dispose();
                // Unpinned: only commit 5's write set is kept, so snapshot 4 still validates but 3 is too old.
                assert.ok((await TxnFx.Settle(c.Submit(touchB(), TxnFx.ReadsCell(b, age), 3n))) instanceof ConflictError);
                assert.equal(await c.Submit(touchB(), TxnFx.ReadsCell(a, age), 4n), 6n);
                const tooNew = await TxnFx.Settle(c.Submit(touchB(), new ReadSet(), 99n));
                assert.ok(tooNew instanceof RangeError);
                assert.ok(!(tooNew instanceof ConflictError));
                await store.dispose();
            });

            it('two registered snapshots: the window follows the oldest one still registered', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'a', 'b');
                const old = c.RegisterSnapshot();
                await c.Submit(TxnFx.Batch(x => x.SetProperty('a', 'age', 1n)), new ReadSet(), 1n);
                const mid = c.RegisterSnapshot();
                await c.Submit(TxnFx.Batch(x => x.SetProperty('a', 'age', 2n)), new ReadSet(), 2n);
                await c.Submit(TxnFx.Batch(x => x.SetProperty('a', 'age', 3n)), new ReadSet(), 3n);
                const b = await new Probe(store, catalog).RequireId('b');
                const age = catalog.Member('Person', 'age').Id;
                old.dispose();
                assert.ok((await TxnFx.Settle(c.Submit(new WriteBatch(), TxnFx.ReadsCell(b, age), 1n))) instanceof ConflictError);
                assert.equal(await c.Submit(new WriteBatch(), TxnFx.ReadsCell(b, age), mid.Commit), 5n);
                mid.dispose();
                await store.dispose();
            });

            it('rejects semantic errors with CommitError codes and keeps earlier batches intact', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await c.Submit(TxnFx.Batch(b =>
                {
                    b.CreateNode('a', 'Person');
                    b.CreateNode('b', 'Person');
                    b.CreateNode('co', 'Company');
                    b.Link('a', 'best', 'b');
                }), new ReadSet(), 0n);
                const cases: Array<[CommitErrorCode, (b: WriteBatch) => void]> = [
                    [CommitErrorCode.DuplicatePublicId, b => b.CreateNode('a', 'Person')],
                    [CommitErrorCode.DuplicatePublicId, b => { b.CreateNode('n', 'Person'); b.CreateNode('n', 'Company'); }],
                    [CommitErrorCode.UnknownType, b => b.CreateNode('n', 'Nope')],
                    [CommitErrorCode.NotInstantiable, b => b.CreateNode('n', 'Party')],
                    [CommitErrorCode.InvalidPublicId, b => b.CreateNode('', 'Person')],
                    [CommitErrorCode.InvalidPublicId, b => b.CreateNode('x'.repeat(401), 'Person')],
                    [CommitErrorCode.UnknownNode, b => b.SetProperty('ghost', 'name', 'x')],
                    [CommitErrorCode.UnknownNode, b => b.DeleteNode('ghost')],
                    [CommitErrorCode.UnknownNode, b => b.Unlink('a', 'knows', 'ghost')],
                    [CommitErrorCode.UnknownMember, b => b.SetProperty('a', 'title', 'x')],
                    [CommitErrorCode.UnknownMember, b => b.Link('a', 'staff', 'b')],
                    [CommitErrorCode.NotAProperty, b => b.SetProperty('a', 'knows', 'x')],
                    [CommitErrorCode.NotARelationship, b => b.Link('a', 'name', 'b')],
                    [CommitErrorCode.TargetTypeMismatch, b => b.Link('a', 'employer', 'b')],
                    [CommitErrorCode.TargetTypeMismatch, b => b.Link('co', 'staff', 'co')],
                    [CommitErrorCode.InvalidValue, b => b.SetProperty('a', 'age', 'old')],
                    [CommitErrorCode.InvalidEdge, b => b.Link('a', 'best', 'a')],
                    [CommitErrorCode.InvalidEdge, b => b.Unlink('a', 'knows', 'b')],
                    [CommitErrorCode.InvalidEdge, b => b.Link('a', 'knows', 'b', { Properties: new Map([['weight', 1n]]) })],
                    [CommitErrorCode.UnknownNode, b => b.Link('a', 'friends', 'b', { AfterSibling: 'ghost' })],
                    [CommitErrorCode.InvalidEdge, b => b.Link('a', 'friends', 'b', { AfterSibling: 'co' })],
                    [CommitErrorCode.UnknownNode, b => { b.DeleteNode('b'); b.SetProperty('b', 'age', 1n); }],
                ];
                for (const [code, build] of cases)
                {
                    assert.equal(await TxnFx.CommitCode(c.Submit(TxnFx.Batch(build), new ReadSet(), c.LastCommit())), code, CommitErrorCode[code]);
                }
                const unknownSibling = await TxnFx.Settle(c.Submit(TxnFx.Batch(b => b.Link('a', 'friends', 'b', { AfterSibling: 'co' })), new ReadSet(), 1n));
                assert.ok(unknownSibling instanceof CommitError && unknownSibling.cause instanceof EdgeError);
                assert.equal(unknownSibling.cause.Code, EdgeErrorCode.UnknownSibling);
                assert.equal(c.LastCommit(), 1n);
                const probe = new Probe(store, catalog);
                assert.ok((await probe.Id('b')) !== undefined);
                assert.deepEqual(await probe.Neighbors('a', 'Person', 'best', EdgeDirection.Out), ['b']);
                await store.dispose();
            });

            it('ordered links honour AfterSibling and BeforeSibling public ids, with edge properties', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'a', 'b', 'c', 'd', 'e');
                await c.Submit(TxnFx.Batch(x =>
                {
                    x.Link('a', 'friends', 'b');
                    x.Link('a', 'friends', 'c', { Properties: new Map([['weight', 5n]]) });
                    x.Link('a', 'friends', 'd', { AfterSibling: 'b' });
                    x.Link('a', 'friends', 'e', { BeforeSibling: 'b' });
                }), new ReadSet(), c.LastCommit());
                const probe = new Probe(store, catalog);
                assert.deepEqual(await probe.Neighbors('a', 'Person', 'friends', EdgeDirection.Out), ['e', 'b', 'd', 'c']);
                await c.Submit(TxnFx.Batch(x =>
                {
                    x.Unlink('a', 'friends', 'd');
                    x.Link('a', 'friends', 'd', { AfterSibling: 'e', BeforeSibling: 'b' });
                }), new ReadSet(), c.LastCommit());
                assert.deepEqual(await probe.Neighbors('a', 'Person', 'friends', EdgeDirection.Out), ['e', 'd', 'b', 'c']);
                await store.dispose();
            });

            it('compacts a chunk whose delta exceeds CompactThreshold within the same Write', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                const person = catalog.TypeId('Person');
                const company = catalog.TypeId('Company');
                await c.Submit(TxnFx.Batch(b =>
                {
                    for (let i = 0; i <= Committer.CompactThreshold; i++)
                    {
                        b.CreateNode('p' + i, 'Person');
                    }
                    for (let i = 0; i < 10; i++)
                    {
                        b.CreateNode('c' + i, 'Company');
                    }
                }), new ReadSet(), 0n);
                const probe = new Probe(store, catalog);
                assert.equal(await probe.Get(Keyspace.Deltas, FormatKeys.Delta(0, person, 0, 0n)), undefined);
                assert.ok((await probe.Get(Keyspace.Columns, FormatKeys.Column(0, person, 0, 0n))) !== undefined);
                assert.ok((await probe.Get(Keyspace.Deltas, FormatKeys.Delta(0, company, 0, 0n))) !== undefined);
                assert.equal(await probe.Get(Keyspace.Columns, FormatKeys.Column(0, company, 0, 0n)), undefined);
                const p7 = await probe.RequireId('p7');
                await probe.Read(async txn =>
                {
                    const loc = await new RowIndex().Locate(txn, p7);
                    assert.ok(loc !== undefined);
                    assert.equal(await new ColumnStore().ReadCell(txn, loc, CatalogSnapshot.NodeIdMember), p7);
                });
                await store.dispose();
            });

            it('Open resumes from the stored last commit; a stale constructor-built committer rejects instead of reusing numbers', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const first = await Committer.Open(store, catalog);
                await TxnFx.People(first, 'a');
                await TxnFx.People(first, 'b');
                const resumed = await Committer.Open(store, catalog);
                assert.equal(resumed.LastCommit(), 2n);
                assert.equal(await TxnFx.People(resumed, 'c'), 3n);
                const stale = new Committer(store, catalog);
                assert.equal(stale.LastCommit(), 0n);
                const outcome = await TxnFx.Settle(TxnFx.People(stale, 'd'));
                assert.ok(outcome instanceof Error && !(outcome instanceof CommitError) && !(outcome instanceof ConflictError));
                assert.equal(await new Probe(store, catalog).Id('d'), undefined);
                await store.dispose();
            });

            it('UpdateCatalog makes new definitions usable for later commits', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                assert.equal(await TxnFx.CommitCode(c.Submit(TxnFx.Batch(b => b.CreateNode('t', 'Team')), new ReadSet(), 0n)), CommitErrorCode.UnknownType);
                const model = CatalogModel.FromSnapshot(catalog);
                model.DefineConcept('Team', null, [], [{ Name: 'size', Kind: MemberKind.Property, Type: ValueType.Int64, Nullable: true }]);
                const next = model.Seal();
                c.UpdateCatalog(next);
                await c.Submit(TxnFx.Batch(b => { b.CreateNode('t', 'Team'); b.SetProperty('t', 'size', 4n); }), new ReadSet(), 0n);
                assert.equal(await new Probe(store, next).Cell('t', 'size'), 4n);
                await store.dispose();
            });

            it('R29: a node created in a batch must have every non-nullable property set by the end of that batch', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'p');
                assert.equal(await TxnFx.CommitCode(c.Submit(TxnFx.Batch(b => b.CreateNode('b1', 'Badge')), new ReadSet(), 1n)), CommitErrorCode.MissingRequired);
                assert.equal(await TxnFx.CommitCode(c.Submit(TxnFx.Batch(b =>
                {
                    b.CreateNode('b1', 'Badge');
                    b.SetProperty('b1', 'note', 'n');
                }), new ReadSet(), 1n)), CommitErrorCode.MissingRequired);
                await c.Submit(TxnFx.Batch(b =>
                {
                    b.CreateNode('b2', 'Badge');
                    b.Link('b2', 'holder', 'p');
                    b.SetProperty('b2', 'note', 'later');
                    b.SetProperty('b2', 'code', 'X-1');
                }), new ReadSet(), 1n);
                await c.Submit(TxnFx.Batch(b =>
                {
                    b.CreateNode('b3', 'Badge');
                    b.DeleteNode('b3');
                }), new ReadSet(), 2n);
                const probe = new Probe(store, catalog);
                assert.equal(await probe.Cell('b2', 'code'), 'X-1');
                assert.equal(await probe.Id('b1'), undefined);
                assert.equal(await probe.Id('b3'), undefined);
                assert.equal(await TxnFx.CommitCode(c.Submit(TxnFx.Batch(b => b.SetProperty('b2', 'code', null)), new ReadSet(), 3n)), CommitErrorCode.InvalidValue);
                await store.dispose();
            });

            it('a failed allocator open is not cached: the next group opens it again', async () =>
            {
                const store = await open();
                const c = new FlakyAllocatorCommitter(store, TxnFx.Catalog());
                const failed = await TxnFx.Settle(TxnFx.People(c, 'a'));
                assert.ok(failed instanceof Error && failed.message === 'allocator open failed');
                assert.equal(await TxnFx.People(c, 'a'), 1n);
                assert.equal(c.Opens, 2);
                assert.equal(await TxnFx.People(c, 'b'), 2n);
                assert.equal(c.Opens, 2);
                await store.dispose();
            });

            it('an unexpected failure inside a group rejects that group only; the queue keeps running', async () =>
            {
                const store = await open();
                const c = await Committer.Open(store, TxnFx.Catalog());
                const group = [
                    c.Submit(TxnFx.Batch(b => b.CreateNode('a', 'Person')), new ReadSet(), 0n),
                    c.Submit(TxnFx.Batch(b => b.CreateNode('b', 'Person')), new ExplodingReadSet(), 0n),
                    c.Submit(TxnFx.Batch(b => b.CreateNode('c', 'Person')), new ReadSet(), 0n),
                ];
                const outcomes = await Promise.all(group.map(p => TxnFx.Settle(p)));
                for (const o of outcomes)
                {
                    assert.ok(o instanceof Error && o.message === 'read set exploded', String(o));
                }
                assert.equal(c.LastCommit(), 0n);
                assert.equal(await TxnFx.People(c, 'd'), 1n);
                await store.dispose();
            });

            it('corrupt stored data surfaces as a storage error, not as a CommitError of the batch', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'a');
                const name = catalog.Member('Person', 'name').Id;
                const deltaKey = FormatKeys.Delta(0, catalog.TypeId('Person'), name, 0n);
                await store.Write(async txn => txn.Put(Keyspace.Deltas, deltaKey, Uint8Array.of(0, 0, 1)));
                const outcome = await TxnFx.Settle(c.Submit(TxnFx.Batch(b => b.SetProperty('a', 'name', 'x')), new ReadSet(), 1n));
                assert.ok(outcome instanceof Error);
                assert.ok(!(outcome instanceof CommitError), 'corruption is not the fault of the batch: ' + String(outcome));
                assert.equal(await c.Submit(TxnFx.Batch(b => b.SetProperty('a', 'age', 1n)), new ReadSet(), 1n), 2n);
                await store.dispose();
            });

            it('every CommitApplied subscriber gets a sealed, immutable batch', async () =>
            {
                const store = await open();
                const c = await Committer.Open(store, TxnFx.Catalog());
                const submitted = TxnFx.Batch(b =>
                {
                    b.CreateNode('a', 'Person');
                    b.CreateNode('b', 'Person');
                    b.Link('a', 'friends', 'b', { Properties: new Map([['weight', 1n]]) });
                });
                const attempts: string[] = [];
                c.CommitApplied.Subscribe(e =>
                {
                    assert.equal(e.Batch.IsSealed, true);
                    const tampering = [
                        (): void => e.Batch.DeleteNode('a'),
                        (): void => void (e.Batch.Ops() as unknown as unknown[]).pop(),
                        (): void => void ((e.Batch.Ops()[2] as unknown as { Options: { Properties: Map<string, unknown> } }).Options.Properties).set('weight', 9n),
                    ];
                    for (const tamper of tampering)
                    {
                        try
                        {
                            tamper();
                            attempts.push('mutated');
                        }
                        catch
                        {
                            attempts.push('blocked');
                        }
                    }
                });
                const seen: WriteBatch[] = [];
                c.CommitApplied.Subscribe(e => seen.push(e.Batch));
                await c.Submit(submitted, new ReadSet(), 0n);
                assert.deepEqual(attempts, ['blocked', 'blocked', 'blocked']);
                assert.deepEqual(seen[0], submitted);
                await store.dispose();
            });

            it('dispose rejects queued and later Submits, drops subscribers and is idempotent', async () =>
            {
                const store = await open();
                const c = await Committer.Open(store, TxnFx.Catalog());
                const events: bigint[] = [];
                c.CommitApplied.Subscribe(e => events.push(e.Commit));
                const queued = [TxnFx.People(c, 'a'), TxnFx.People(c, 'b')];
                c.dispose();
                c.dispose();
                for (const o of await Promise.all(queued.map(p => TxnFx.Settle(p))))
                {
                    assert.ok(o instanceof Error && !(o instanceof CommitError) && !(o instanceof ConflictError), String(o));
                }
                assert.ok((await TxnFx.Settle(c.Submit(new WriteBatch(), new ReadSet(), 0n))) instanceof Error);
                assert.deepEqual(events, []);
                assert.equal(c.LastCommit(), 0n);
                assert.equal(await new Probe(store, TxnFx.Catalog()).Id('a'), undefined);
                await store.dispose();
            });

            it('the batch and read set are captured at Submit: later caller mutation has no effect', async () =>
            {
                const store = await open();
                const catalog = TxnFx.Catalog();
                const c = await Committer.Open(store, catalog);
                await TxnFx.People(c, 'a');
                const batch = TxnFx.Batch(b => b.SetProperty('a', 'age', 1n));
                const pending = c.Submit(batch, new ReadSet(), 1n);
                batch.SetProperty('a', 'age', 2n);
                await pending;
                assert.equal(await new Probe(store, catalog).Cell('a', 'age'), 1n);
                await store.dispose();
            });
        });
    }
}

after(() => TxnFx.RemoveDirs());
await TxnFx.Register('memory', async () => new MemoryStore());
await TxnFx.Register('lmdb', () => TxnFx.OpenLmdb());
