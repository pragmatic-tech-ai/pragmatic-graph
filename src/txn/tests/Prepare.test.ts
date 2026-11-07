import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogModel } from '../../catalog/CatalogModel.js';
import type { CatalogSnapshot } from '../../catalog/CatalogSnapshot.js';
import { CatalogStore } from '../../catalog/CatalogStore.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { AccessDefault, AccessScope } from '../../access/AccessScope.js';
import { AccessError } from '../../access/AccessError.js';
import { FalsePredicate } from '../../predicate/Predicate.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { GraphStore } from '../../GraphStore.js';
import { EngineInternals } from '../../tests/EngineInternals.js';
import { IdAllocator } from '../../identity/IdAllocator.js';
import { PublicIdIndex } from '../../identity/PublicIdIndex.js';
import type { IKeyValueStore, IReadTransaction, IWriteTransaction } from '../../kv/KeyValue.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { LmdbStore } from '../../kv/lmdb/LmdbStore.js';
import { MemoryStore } from '../../kv/memory/MemoryStore.js';
import type { ISchemaDescription } from '../../schema/SchemaDescription.js';
import { CommitError, CommitErrorCode } from '../CommitError.js';
import { Committer } from '../Committer.js';
import { ConflictError } from '../ConflictError.js';
import { ConflictKeys } from '../ConflictKeys.js';
import type { ICommitApplied } from '../LogEntry.js';
import { ReadSet } from '../ReadSet.js';
import { PreparedCommit } from '../PreparedCommit.js';
import { ReservationState, Reservations } from '../Reservations.js';
import { WriteBatch } from '../WriteBatch.js';

/** A committer whose allocator counts every id it hands out. */
class CountingCommitter extends Committer
{
    public Allocated = 0;

    protected override async OpenAllocator(): Promise<IdAllocator>
    {
        const allocator = await super.OpenAllocator();
        const next = allocator.Next.bind(allocator);
        allocator.Next = async (hint?: string) =>
        {
            this.Allocated++;
            return next(hint);
        };
        return allocator;
    }
}

/** A store whose next Write blocks inside its work (after the transaction began) until Release(). */
class GatedStore implements IKeyValueStore
{
    public Entered: Promise<void> = Promise.resolve();
    private gate: Promise<void> | undefined;
    private open: () => void = () => undefined;
    private entered: () => void = () => undefined;

    public constructor(private readonly inner: IKeyValueStore)
    {
    }

    public Hold(): void
    {
        this.gate = new Promise<void>(resolve => { this.open = resolve; });
        this.Entered = new Promise<void>(resolve => { this.entered = resolve; });
    }

    public Release(): void
    {
        this.open();
    }

    public BeginRead(): Promise<IReadTransaction>
    {
        return this.inner.BeginRead();
    }

    public Write<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        const gate = this.gate;
        this.gate = undefined;
        return this.inner.Write(async txn =>
        {
            if (gate !== undefined)
            {
                this.entered();
                await gate;
            }
            return work(txn);
        });
    }

    public dispose(): Promise<void>
    {
        return this.inner.dispose();
    }
}

/** A small deterministic generator (mulberry32), so a failing fuzz round can be replayed. */
class Rng
{
    public constructor(private state: number)
    {
    }

    public Next(): number
    {
        this.state = (this.state + 0x6d2b79f5) | 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    public Int(n: number): number
    {
        return Math.floor(this.Next() * n);
    }

    public Pick<T>(items: readonly T[]): T
    {
        return items[this.Int(items.length)] as T;
    }
}

class PrepFx
{
    private static readonly DirPrefix = 'pragmatic-graph-prepare-';
    private static readonly Dirs: string[] = [];
    public static readonly Person = 'Person';
    public static readonly Age = 'age';
    public static readonly Name = 'name';
    public static readonly Knows = 'knows';
    public static readonly Best = 'best';
    public static readonly ByName = 'byName';
    public static readonly Friends = 'friends';
    public static readonly Skipped = 'skipped';
    public static readonly Spaces: readonly Keyspace[] = Object.values(Keyspace);

    public static Catalog(): CatalogSnapshot
    {
        const m = new CatalogModel();
        m.DefineConcept(PrepFx.Person, null, [], [
            { Name: PrepFx.Name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: PrepFx.Age, Kind: MemberKind.Property, Type: ValueType.Int64, Nullable: true },
            { Name: PrepFx.Knows, Kind: MemberKind.Relationship, Targets: [PrepFx.Person], Many: true },
            { Name: PrepFx.Best, Kind: MemberKind.Relationship, Targets: [PrepFx.Person] },
            { Name: PrepFx.Friends, Kind: MemberKind.Relationship, Targets: [PrepFx.Person], Many: true, Ordered: true },
        ]);
        m.DefineIndex(PrepFx.ByName, PrepFx.Person, [PrepFx.Name], true);
        return m.Seal();
    }

    public static async OpenLmdb(): Promise<IKeyValueStore>
    {
        const dir = mkdtempSync(join(tmpdir(), PrepFx.DirPrefix));
        PrepFx.Dirs.push(dir);
        return LmdbStore.Open(dir);
    }

    public static RemoveDirs(): void
    {
        for (const d of PrepFx.Dirs)
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

    public static async Committer(store: IKeyValueStore): Promise<CountingCommitter>
    {
        const catalog = PrepFx.Catalog();
        await store.Write(txn => CatalogStore.Save(txn, catalog));
        const c = new CountingCommitter(store, catalog);
        await c.Submit(PrepFx.Batch(b => ['a', 'b', 'c', 'd'].forEach(id => b.CreateNode(id, PrepFx.Person))), new ReadSet(), 0n);
        return c;
    }

    public static async Id(store: IKeyValueStore, publicId: string): Promise<bigint | undefined>
    {
        const txn = await store.BeginRead();
        try
        {
            return await new PublicIdIndex().Resolve(txn, publicId);
        }
        finally
        {
            txn.dispose();
        }
    }

    /** A read set holding the Cell key of one property of a node. */
    public static async ReadsCell(store: IKeyValueStore, c: Committer, publicId: string, member: string): Promise<ReadSet>
    {
        const id = await PrepFx.Id(store, publicId);
        assert.ok(id !== undefined);
        const r = new ReadSet();
        r.AddKey(ConflictKeys.CellSpace, ConflictKeys.Cell(id, c.Catalog.Member(PrepFx.Person, member).Id));
        return r;
    }

    public static Set(c: Committer, publicId: string, member: string, value: string | bigint, reads = new ReadSet()): Promise<bigint>
    {
        return c.Submit(PrepFx.Batch(b => b.SetProperty(publicId, member, value)), reads, c.LastCommit(), c.Catalog.Version);
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

    public static async Conflicts(work: Promise<unknown>): Promise<void>
    {
        const outcome = await PrepFx.Settle(work);
        assert.ok(outcome instanceof ConflictError, 'expected ConflictError, got ' + String(outcome));
    }

    public static async Commits(work: Promise<unknown>): Promise<bigint>
    {
        const outcome = await PrepFx.Settle(work);
        assert.equal(typeof outcome, 'bigint', 'expected a commit, got ' + String(outcome));
        return outcome as bigint;
    }

    /** Every key and value of every keyspace, hex-encoded. */
    public static async Dump(store: IKeyValueStore): Promise<string[]>
    {
        const out: string[] = [];
        const txn = await store.BeginRead();
        try
        {
            for (const space of PrepFx.Spaces)
            {
                for await (const [k, v] of txn.Scan(space, { Start: new Uint8Array(0), End: Uint8Array.of(0xff, 0xff, 0xff, 0xff) }))
                {
                    out.push(space + ' ' + ConflictKeys.Hex(k) + ' ' + ConflictKeys.Hex(v));
                }
            }
        }
        finally
        {
            txn.dispose();
        }
        return out;
    }

    public static Wait(ms: number): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public static Description(version: string, extra: boolean, seed: ISchemaDescription['Seed'] = []): ISchemaDescription
    {
        const members = [
            { Name: PrepFx.Name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: PrepFx.Age, Kind: MemberKind.Property, Type: ValueType.Int64, Nullable: true },
            { Name: PrepFx.Knows, Kind: MemberKind.Relationship, Targets: [PrepFx.Person], Many: true },
            { Name: PrepFx.Best, Kind: MemberKind.Relationship, Targets: [PrepFx.Person] },
            { Name: PrepFx.Friends, Kind: MemberKind.Relationship, Targets: [PrepFx.Person], Many: true, Ordered: true },
        ] as const;
        const defs = [{ Name: PrepFx.Person, IsAspect: false, Parent: null, Aspects: [], Members: [...members] }];
        if (extra)
        {
            defs.push({ Name: 'Team', IsAspect: false, Parent: null, Aspects: [], Members: [] });
        }
        const indexes = [{ Name: PrepFx.ByName, On: PrepFx.Person, Members: [PrepFx.Name], Unique: true }];
        return { Version: version, Definitions: defs, Indexes: indexes, Seed: seed, Bindings: [] } as unknown as ISchemaDescription;
    }

    public static Register(name: string, open: () => Promise<IKeyValueStore>): void
    {
        describe('committer prepare / finalize on ' + name, () =>
        {
            it('prepare then finalize commits, CommitApplied raised once at finalize, ids reused', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const events: ICommitApplied[] = [];
                c.CommitApplied.Subscribe(e => events.push(e));
                const before = c.Allocated;
                const prepared = await c.Prepare(PrepFx.Batch(b =>
                {
                    b.CreateNode('n', PrepFx.Person);
                    b.SetProperty('a', PrepFx.Age, 5n);
                }), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                assert.equal(c.Allocated, before + 1, 'prepare allocates the create id');
                assert.equal(events.length, 0);
                assert.equal(prepared.Expired, false);
                assert.equal(prepared.Batch.Count, 2);
                assert.equal(await PrepFx.Id(store, 'n'), undefined, 'nothing applied at prepare');
                const commit = await prepared.Finalize();
                assert.equal(commit, c.LastCommit());
                assert.equal(c.Allocated, before + 1, 'finalize reuses the prepared ids');
                assert.equal(events.length, 1);
                assert.equal(events[0]?.Commit, commit);
                assert.deepEqual(events[0]?.CreatedIds, [await PrepFx.Id(store, 'n')]);
                await c.dispose();
                await store.dispose();
            });

            it('prepare rejects conflicts like submit', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const handle = c.RegisterSnapshot();
                const reads = await PrepFx.ReadsCell(store, c, 'a', PrepFx.Age);
                const snapshot = c.LastCommit();
                await PrepFx.Set(c, 'a', PrepFx.Age, 1n);
                await PrepFx.Conflicts(c.Prepare(PrepFx.Batch(b => b.SetProperty('b', PrepFx.Age, 2n)), reads, snapshot, c.Catalog.Version));
                handle.dispose();
                const invalid = await PrepFx.Settle(c.Prepare(PrepFx.Batch(b => b.SetProperty('ghost', PrepFx.Age, 2n)), new ReadSet(), c.LastCommit()));
                assert.ok(invalid instanceof CommitError && invalid.Code === CommitErrorCode.UnknownNode, String(invalid));
                await PrepFx.Conflicts(c.Prepare(PrepFx.Batch(b => b.SetProperty('b', PrepFx.Age, 2n)), new ReadSet(), c.LastCommit(), c.Catalog.Version - 1));
                await assert.rejects(c.Prepare(new WriteBatch(), new ReadSet(), c.LastCommit() + 1n), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
                // None of the failed prepares reserved anything.
                await PrepFx.Commits(PrepFx.Set(c, 'b', PrepFx.Age, 3n));
                await c.dispose();
                await store.dispose();
            });

            it('writer to reserved key conflicts', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const reads = await PrepFx.ReadsCell(store, c, 'b', PrepFx.Name);
                const prepared = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), reads, c.LastCommit(), c.Catalog.Version);
                await PrepFx.Conflicts(PrepFx.Set(c, 'a', PrepFx.Age, 6n));
                await PrepFx.Conflicts(PrepFx.Set(c, 'b', PrepFx.Name, 'x'));
                await PrepFx.Conflicts(c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 7n)), new ReadSet(), c.LastCommit(), c.Catalog.Version));
                // A grouped neighbour of a rejected batch still commits (the BatchFailure re-run).
                const both = [PrepFx.Set(c, 'a', PrepFx.Age, 8n), PrepFx.Set(c, 'c', PrepFx.Age, 9n)];
                await PrepFx.Conflicts(both[0] as Promise<bigint>);
                await PrepFx.Commits(both[1] as Promise<bigint>);
                await PrepFx.Commits(prepared.Finalize());
                await c.dispose();
                await store.dispose();
            });

            it('reader of prepared write key conflicts if it commits a write', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const prepared = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                const reads = await PrepFx.ReadsCell(store, c, 'a', PrepFx.Age);
                await PrepFx.Conflicts(PrepFx.Set(c, 'b', PrepFx.Age, 1n, reads));
                // A read-only submit writes nothing: it serializes before the prepared commit.
                await PrepFx.Commits(c.Submit(new WriteBatch(), reads, c.LastCommit(), c.Catalog.Version));
                // So does a reading prepare's dry-run.
                await PrepFx.Conflicts(c.Prepare(PrepFx.Batch(b => b.SetProperty('b', PrepFx.Age, 1n)), reads, c.LastCommit(), c.Catalog.Version));
                await PrepFx.Commits(prepared.Finalize());
                await c.dispose();
                await store.dispose();
            });

            it('unrelated writer proceeds', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const prepared = await c.Prepare(PrepFx.Batch(b =>
                {
                    b.CreateNode('n', PrepFx.Person);
                    b.SetProperty('a', PrepFx.Age, 5n);
                }), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                // Other cells of the same column and other creates of the same concept are not reserved.
                await PrepFx.Commits(PrepFx.Set(c, 'b', PrepFx.Age, 1n));
                await PrepFx.Commits(PrepFx.Set(c, 'a', PrepFx.Name, 'x'));
                await PrepFx.Commits(c.Submit(PrepFx.Batch(b => b.CreateNode('m', PrepFx.Person)), new ReadSet(), c.LastCommit(), c.Catalog.Version));
                const other = await c.Prepare(PrepFx.Batch(b => b.SetProperty('c', PrepFx.Age, 2n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                await PrepFx.Commits(other.Finalize());
                await PrepFx.Commits(prepared.Finalize());
                await c.dispose();
                await store.dispose();
            });

            it('finalize cannot conflict while reserved (fuzz: 50 random concurrent submits and prepares, sibling links)', async () =>
            {
                const people = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
                const members = [PrepFx.Age, PrepFx.Name];
                for (let seed = 1; seed <= 12; seed++)
                {
                    const rng = new Rng(seed);
                    const store = await open();
                    const c = new CountingCommitter(store, PrepFx.Catalog());
                    await c.Submit(PrepFx.Batch(b => people.forEach(p => b.CreateNode(p, PrepFx.Person))), new ReadSet(), 0n);
                    await c.Submit(PrepFx.Batch(b =>
                    {
                        b.Link('p4', PrepFx.Knows, 'p5');
                        b.Link('p0', PrepFx.Friends, 'p1');
                        b.Link('p0', PrepFx.Friends, 'p2');
                        b.Link('p4', PrepFx.Friends, 'p5');
                    }), new ReadSet(), c.LastCommit());
                    const reads = await PrepFx.ReadsCell(store, c, 'p5', PrepFx.Name);
                    const prepared = await c.Prepare(PrepFx.Batch(b =>
                    {
                        b.SetProperty('p0', PrepFx.Age, 1n);
                        b.Link('p1', PrepFx.Best, 'p2');
                        b.DeleteNode('p3');
                        b.Unlink('p4', PrepFx.Knows, 'p5');
                        b.Link('p0', PrepFx.Friends, 'p5', { AfterSibling: 'p1' });
                        b.CreateNode('fresh', PrepFx.Person);
                    }), reads, c.LastCommit(), c.Catalog.Version);
                    const work: Array<Promise<unknown>> = [];
                    const finals: Array<Promise<unknown>> = [];
                    let finalized: Promise<bigint> | undefined;
                    for (let i = 0; i < 50; i++)
                    {
                        if (i === 25)
                        {
                            finalized = prepared.Finalize();
                        }
                        const r = new ReadSet();
                        const readKind = rng.Int(3);
                        const readId = await PrepFx.Id(store, rng.Pick(people));
                        if (readId !== undefined && readKind === 0)
                        {
                            r.AddKey(ConflictKeys.CellSpace, ConflictKeys.Cell(readId, c.Catalog.Member(PrepFx.Person, rng.Pick(members)).Id));
                        }
                        else if (readId !== undefined && readKind === 1)
                        {
                            r.AddRange(ConflictKeys.EdgeSpace, ConflictKeys.Adjacency(c.Catalog.Member(PrepFx.Person, PrepFx.Friends).Id, EdgeDirection.Out, readId));
                        }
                        const batch = PrepFx.Batch(b =>
                        {
                            for (let n = 1 + rng.Int(3); n > 0; n--)
                            {
                                const from = rng.Pick(people);
                                const to = rng.Pick(people);
                                switch (rng.Int(9))
                                {
                                    case 0:
                                        b.SetProperty(from, rng.Pick(members), rng.Pick(members) === PrepFx.Age ? BigInt(i) : 'v' + i);
                                        break;
                                    case 1:
                                        b.Link(from, PrepFx.Knows, to);
                                        break;
                                    case 2:
                                        b.Link(from, PrepFx.Best, to);
                                        break;
                                    case 3:
                                        b.Unlink(from, PrepFx.Knows, to);
                                        break;
                                    case 4:
                                        b.DeleteNode(from);
                                        break;
                                    case 5:
                                        b.Link(from, PrepFx.Friends, to, rng.Int(2) === 0 ? { AfterSibling: rng.Pick(people) } : { BeforeSibling: rng.Pick(people) });
                                        break;
                                    case 6:
                                        b.Link(from, PrepFx.Friends, to);
                                        break;
                                    case 7:
                                        b.Unlink(from, PrepFx.Friends, to);
                                        break;
                                    default:
                                        // Never p3: a create after the finalize could bring it back.
                                        b.CreateNode(rng.Pick(['p0', 'p1', 'p2', 'p4', 'p5', 'fresh', 'x' + i]), PrepFx.Person);
                                        break;
                                }
                            }
                        });
                        if (rng.Int(2) === 0)
                        {
                            // A concurrent second prepare: when it prepares, its Finalize must commit too.
                            // Half of them are one op around p0's ordered friends (sibling placement,
                            // unlinking or deleting a sibling), so prepares depend on each other's writes.
                            const focused = PrepFx.Batch(b =>
                            {
                                const sibling = rng.Pick(['p1', 'p2', 'p5']);
                                switch (rng.Int(4))
                                {
                                    case 0:
                                        b.Link('p0', PrepFx.Friends, rng.Pick(['p3', 'p4', 'x' + i]), { AfterSibling: sibling });
                                        break;
                                    case 1:
                                        b.Link('p0', PrepFx.Friends, rng.Pick(['p3', 'p4']), { BeforeSibling: sibling });
                                        break;
                                    case 2:
                                        b.Unlink('p0', PrepFx.Friends, sibling);
                                        break;
                                    default:
                                        b.DeleteNode(sibling);
                                        break;
                                }
                            });
                            const delay = 1 + rng.Int(4);
                            const prep = PrepFx.Settle(c.Prepare(rng.Int(2) === 0 ? focused : batch, r, c.LastCommit(), c.Catalog.Version));
                            finals.push(prep.then(async o =>
                            {
                                if (!(o instanceof PreparedCommit))
                                {
                                    assert.ok(o instanceof ConflictError || o instanceof CommitError, 'seed ' + seed + ': prepare ' + String(o));
                                    return PrepFx.Skipped;
                                }
                                for (let k = 0; k < delay; k++)
                                {
                                    await PrepFx.Wait(1);
                                }
                                return PrepFx.Settle(o.Finalize());
                            }));
                        }
                        else
                        {
                            work.push(PrepFx.Settle(c.Submit(batch, r, c.LastCommit(), c.Catalog.Version)));
                        }
                        if (rng.Int(4) === 0)
                        {
                            await Promise.resolve();
                        }
                    }
                    const outcome = await PrepFx.Settle(finalized as Promise<bigint>);
                    assert.equal(typeof outcome, 'bigint', 'seed ' + seed + ': finalize failed with ' + String(outcome));
                    for (const o of await Promise.all(finals))
                    {
                        assert.ok(typeof o === 'bigint' || o === PrepFx.Skipped, 'seed ' + seed + ': a second finalize failed with ' + String(o));
                    }
                    for (const o of await Promise.all(work))
                    {
                        assert.ok(typeof o === 'bigint' || o instanceof ConflictError || o instanceof CommitError, 'seed ' + seed + ': ' + String(o));
                    }
                    assert.equal(c.ReservationCount, 0);
                    assert.equal(await PrepFx.Id(store, 'p3'), undefined);
                    assert.notEqual(await PrepFx.Id(store, 'fresh'), undefined);
                    await c.dispose();
                    await store.dispose();
                }
            });

            it('a prepare whose dependencies another prepared commit writes conflicts (sibling unlinked, sibling deleted)', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                await c.Submit(PrepFx.Batch(b => b.Link('a', PrepFx.Friends, 'b')), new ReadSet(), c.LastCommit());
                const prepare = (build: (b: WriteBatch) => void): Promise<PreparedCommit> => c.Prepare(PrepFx.Batch(build), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                const sibling = (b: WriteBatch): void => b.Link('a', PrepFx.Friends, 'c', { AfterSibling: 'b' });
                const unlink = await prepare(b => b.Unlink('a', PrepFx.Friends, 'b'));
                await PrepFx.Conflicts(prepare(sibling));
                unlink.Abort();
                const del = await prepare(b => b.DeleteNode('b'));
                await PrepFx.Conflicts(prepare(sibling));
                del.Abort();
                // And the other way round: the sibling link prepared first keeps both off.
                const linked = await prepare(sibling);
                await PrepFx.Conflicts(prepare(b => b.Unlink('a', PrepFx.Friends, 'b')));
                await PrepFx.Conflicts(prepare(b => b.DeleteNode('b')));
                await PrepFx.Commits(linked.Finalize());
                await c.dispose();
                await store.dispose();
            });

            it('an empty-batch prepare keeps its reads reserved', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const reads = await PrepFx.ReadsCell(store, c, 'a', PrepFx.Age);
                const writer = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                // Reads a key a prepared commit writes: rejected even though it writes nothing.
                await PrepFx.Conflicts(c.Prepare(new WriteBatch(), reads, c.LastCommit(), c.Catalog.Version));
                writer.Abort();
                const reader = await c.Prepare(new WriteBatch(), reads, c.LastCommit(), c.Catalog.Version);
                await PrepFx.Conflicts(PrepFx.Set(c, 'a', PrepFx.Age, 6n));
                await PrepFx.Conflicts(c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 7n)), new ReadSet(), c.LastCommit(), c.Catalog.Version));
                await PrepFx.Commits(reader.Finalize());
                await PrepFx.Commits(PrepFx.Set(c, 'a', PrepFx.Age, 6n));
                await c.dispose();
                await store.dispose();
            });

            it('a schema change or upgrade releases held reservations at once', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const prepared = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                await c.SubmitSchema(m => m.DefineConcept('Other', null, [], []));
                assert.equal(c.ReservationCount, 0);
                await PrepFx.Commits(PrepFx.Set(c, 'a', PrepFx.Age, 6n));
                await PrepFx.Conflicts(prepared.Finalize());
                const again = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                assert.equal((await c.SubmitUpgrade(PrepFx.Description('v2', true))).Changed, true);
                assert.equal(c.ReservationCount, 0);
                await PrepFx.Commits(PrepFx.Set(c, 'a', PrepFx.Age, 7n));
                await PrepFx.Conflicts(again.Finalize());
                await c.dispose();
                await store.dispose();
            });

            it('a finalize called before the deadline commits even when its group runs after it', async () =>
            {
                const inner = await open();
                const store = new GatedStore(inner);
                const c = await PrepFx.Committer(store);
                const prepared = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version, 100);
                store.Hold();
                const blocker = PrepFx.Set(c, 'b', PrepFx.Age, 1n);
                await store.Entered;
                const finalized = prepared.Finalize();
                await PrepFx.Wait(200);
                assert.equal(prepared.Expired, false, 'a finalizing reservation does not expire');
                store.Release();
                await PrepFx.Commits(blocker);
                await PrepFx.Commits(finalized);
                assert.equal(c.ReservationCount, 0);
                await c.dispose();
                await inner.dispose();
            });

            it('a PreparedCommit holder cannot end the reservation', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const prepared = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                const foreign = new Reservations();
                assert.throws(() => prepared.Reservation.End(foreign, ReservationState.Aborted), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.Internal);
                assert.throws(() => prepared.Reservation.Invalidate(foreign), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.Internal);
                assert.throws(() => prepared.Reservation.BeginFinalize(foreign), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.Internal);
                assert.equal(c.ReservationCount, 1);
                await PrepFx.Commits(prepared.Finalize());
                await c.dispose();
                await store.dispose();
            });

            it('what the dry-run depends on is reserved: resolved nodes, link adjacency, delete adjacency, unique ranges', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const prepared = await c.Prepare(PrepFx.Batch(b =>
                {
                    b.Link('a', PrepFx.Best, 'b');
                    b.DeleteNode('c');
                    b.SetProperty('d', PrepFx.Name, 'u');
                }), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                const submit = (build: (b: WriteBatch) => void): Promise<bigint> => c.Submit(PrepFx.Batch(build), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                // Would exceed best's cardinality at Finalize.
                await PrepFx.Conflicts(submit(b => b.Link('a', PrepFx.Best, 'd')));
                // Would add an edge the prepared DeleteNode must remove.
                await PrepFx.Conflicts(submit(b => b.Link('b', PrepFx.Knows, 'c')));
                // Would take the unique name first.
                await PrepFx.Conflicts(submit(b => b.SetProperty('a', PrepFx.Name, 'u')));
                // Would remove the Link's target.
                await PrepFx.Conflicts(submit(b => b.DeleteNode('b')));
                await PrepFx.Commits(submit(b => b.Link('b', PrepFx.Knows, 'a')));
                await PrepFx.Commits(submit(b => b.SetProperty('a', PrepFx.Name, 'w')));
                await PrepFx.Commits(prepared.Finalize());
                assert.equal(c.ReservationCount, 0);
                assert.equal(await PrepFx.Id(store, 'c'), undefined);
                await c.dispose();
                await store.dispose();
            });

            it('abort releases', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const prepared = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                assert.equal(c.ReservationCount, 1);
                prepared.Abort();
                prepared.Abort();
                assert.equal(c.ReservationCount, 0);
                await PrepFx.Commits(PrepFx.Set(c, 'a', PrepFx.Age, 6n));
                await PrepFx.Conflicts(prepared.Finalize());
                await c.dispose();
                await store.dispose();
            });

            it('expired reservation releases keys', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const prepared = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version, 20);
                assert.equal(prepared.Expired, false);
                await PrepFx.Wait(40);
                assert.equal(prepared.Expired, true);
                assert.equal(c.ReservationCount, 1, 'released lazily');
                await PrepFx.Commits(PrepFx.Set(c, 'a', PrepFx.Age, 6n));
                assert.equal(c.ReservationCount, 0);
                await PrepFx.Conflicts(prepared.Finalize());
                await c.dispose();
                await store.dispose();
            });

            it('finalize after expiry conflicts', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const last = c.LastCommit();
                const prepared = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version, 20);
                await PrepFx.Wait(40);
                await PrepFx.Conflicts(prepared.Finalize());
                assert.equal(c.LastCommit(), last, 'nothing committed');
                await PrepFx.Commits(PrepFx.Set(c, 'a', PrepFx.Age, 6n));
                assert.equal(Committer.DefaultPrepareTimeoutMs, 30000);
                await c.dispose();
                await store.dispose();
            });

            it('upgrade during reservation fails finalize', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const prepared = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                const upgrade = await c.SubmitUpgrade(PrepFx.Description('v2', true));
                assert.equal(upgrade.Changed, true);
                const last = c.LastCommit();
                await PrepFx.Conflicts(prepared.Finalize());
                assert.equal(c.LastCommit(), last);
                assert.equal(c.ReservationCount, 0, 'a failed finalize releases');
                // A schema change does the same.
                const again = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                await c.SubmitSchema(m => m.DefineConcept('Other', null, [], []));
                await PrepFx.Conflicts(again.Finalize());
                await PrepFx.Commits(PrepFx.Set(c, 'a', PrepFx.Age, 6n));
                await c.dispose();
                await store.dispose();
            });

            it('a seed commit of an unchanged catalog fails the finalize of a reservation it hits', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                assert.equal((await c.SubmitUpgrade(PrepFx.Description('v1', false))).Changed, false);
                const hit = await c.Prepare(PrepFx.Batch(b => b.CreateNode('s1', PrepFx.Person)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                const missed = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 1n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                const version = c.Catalog.Version;
                const upgrade = await c.SubmitUpgrade(PrepFx.Description('v2', false, [{ PublicId: 's1', Concept: PrepFx.Person, Owner: '', Properties: {}, Links: [] }]));
                assert.equal(upgrade.Changed, false);
                assert.notEqual(upgrade.SeedCommit, undefined);
                assert.equal(c.Catalog.Version, version, 'the catalog version alone would not catch it');
                await PrepFx.Conflicts(hit.Finalize());
                await PrepFx.Commits(missed.Finalize());
                assert.equal(c.ReservationCount, 0);
                await c.dispose();
                await store.dispose();
            });

            it('dry-run leaves no trace', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                await c.Submit(PrepFx.Batch(b => b.Link('c', PrepFx.Knows, 'd')), new ReadSet(), c.LastCommit());
                const before = await PrepFx.Dump(store);
                const batch = (): WriteBatch => PrepFx.Batch(b =>
                {
                    b.CreateNode('n', PrepFx.Person);
                    b.SetProperty('n', PrepFx.Name, 'new');
                    b.SetProperty('a', PrepFx.Age, 5n);
                    b.Link('a', PrepFx.Best, 'n');
                    b.Link('n', PrepFx.Knows, 'b');
                    b.DeleteNode('d');
                });
                const prepared = await c.Prepare(batch(), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                prepared.Abort();
                assert.deepEqual(await PrepFx.Dump(store), before);
                // No in-memory trace either: the same batch commits normally afterwards.
                await PrepFx.Commits(c.Submit(batch(), new ReadSet(), c.LastCommit(), c.Catalog.Version));
                assert.notEqual(await PrepFx.Id(store, 'n'), undefined);
                assert.equal(await PrepFx.Id(store, 'd'), undefined);
                await c.dispose();
                await store.dispose();
            });

            it('dispose rejects pending finalize and prepare and releases reservations', async () =>
            {
                const store = await open();
                const c = await PrepFx.Committer(store);
                const prepared = await c.Prepare(PrepFx.Batch(b => b.SetProperty('a', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                const other = await c.Prepare(PrepFx.Batch(b => b.SetProperty('b', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit(), c.Catalog.Version);
                const queuedFinalize = PrepFx.Settle(prepared.Finalize());
                const queuedPrepare = PrepFx.Settle(c.Prepare(PrepFx.Batch(b => b.SetProperty('c', PrepFx.Age, 5n)), new ReadSet(), c.LastCommit()));
                await c.dispose();
                assert.equal(c.ReservationCount, 0);
                for (const o of [await queuedFinalize, await queuedPrepare, await PrepFx.Settle(other.Finalize())])
                {
                    assert.ok(o instanceof GraphError && o.GraphCode === GraphErrorCode.Disposed, String(o));
                }
                assert.equal(await PrepFx.Id(store, 'a') !== undefined, true);
                await store.dispose();
            });
        });
    }
}

/** The engine side of a write-through (EngineInternals.Prepare): the write gate runs first, then the committer prepares the batch. */
class TxnPrepFx
{
    private static readonly Person = 'Person';
    private static readonly Name = 'name';

    public static Register(): void
    {
        describe('graph transaction prepare', () =>
        {
            it('prepares a transaction batch; finalize commits it', async () =>
            {
                const g = await GraphStore.OpenMemory();
                await g.DefineSchema(m => m.DefineConcept(TxnPrepFx.Person, null, [], [{ Name: TxnPrepFx.Name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]));
                const events: ICommitApplied[] = [];
                g.CommitApplied.Subscribe(e => events.push(e));
                const t = await g.Begin(AccessScope.System);
                t.CreateNode('p', TxnPrepFx.Person);
                assert.equal(Reflect.get(t, 'Prepare'), undefined, 'no public Prepare: nothing bypasses write-through routing');
                const prepared = await EngineInternals.Prepare(t);
                assert.throws(() => t.CreateNode('q', TxnPrepFx.Person), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.Disposed);
                assert.equal(events.length, 0);
                const commit = await prepared.Finalize();
                assert.equal(events.length, 1);
                assert.equal(events[0]?.Commit, commit);
                await g.dispose();
            });

            it('runs the write gate before preparing', async () =>
            {
                const g = await GraphStore.OpenMemory();
                await g.DefineSchema(m => m.DefineConcept(TxnPrepFx.Person, null, [], [{ Name: TxnPrepFx.Name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]));
                const scope = AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[TxnPrepFx.Person, { Create: FalsePredicate.Instance }]]) });
                const t = await g.Begin(scope);
                t.CreateNode('p', TxnPrepFx.Person);
                await assert.rejects(EngineInternals.Prepare(t), (e: unknown) => e instanceof AccessError);
                // Nothing was reserved: the same create commits.
                const s = await g.Begin(AccessScope.System);
                s.CreateNode('p', TxnPrepFx.Person);
                await s.Commit();
                await g.dispose();
            });
        });
    }
}

after(() => PrepFx.RemoveDirs());
PrepFx.Register('memory', async () => new MemoryStore());
PrepFx.Register('lmdb', () => PrepFx.OpenLmdb());
TxnPrepFx.Register();
