import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogError, CatalogErrorCode } from '../../catalog/CatalogError.js';
import type { MemberInput } from '../../catalog/CatalogTypes.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { DateTimeValue, DateValue, type CellValue } from '../../columns/CellValue.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { TupleCodec } from '../../format/TupleCodec.js';
import type { GraphContext } from '../../GraphContext.js';
import type { GraphReader } from '../../GraphReader.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { Compare, CompareOp, Related, TruePredicate } from '../../predicate/Predicate.js';
import type { IDefinitionDescription, IIndexDescription, ISchemaDescription, ISeedNode } from '../../schema/SchemaDescription.js';
import { CommitError, CommitErrorCode } from '../../txn/CommitError.js';
import { ConflictError } from '../../txn/ConflictError.js';
import type { IIndexRange } from '../IndexKey.js';

/**
 * Schema, store factories and probes for the secondary-index tests. Aspect Tagged { tag }; Person
 * (carries Tagged) { email, age, status, score, born }; Robot (carries Tagged) { serial }.
 */
class IndexFx
{
    private static readonly DirPrefix = 'pragmatic-graph-index-';
    private static readonly Dirs: string[] = [];
    private static readonly AnyKey = { Start: Uint8Array.of(0x00), End: Uint8Array.of(0xff) };

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), IndexFx.DirPrefix));
        IndexFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of IndexFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Prop(name: string, type: ValueType, nullable = true): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: type, Nullable: nullable };
    }

    public static Defs(ageType: ValueType = ValueType.Int64): IDefinitionDescription[]
    {
        return [
            { Name: 'Tagged', IsAspect: true, Parent: null, Aspects: [], Members: [IndexFx.Prop('tag', ValueType.String)] },
            {
                Name: 'Person', IsAspect: false, Parent: null, Aspects: ['Tagged'], Members: [
                    IndexFx.Prop('email', ValueType.String),
                    IndexFx.Prop('age', ageType),
                    IndexFx.Prop('status', ValueType.String),
                    IndexFx.Prop('score', ValueType.Float64),
                    IndexFx.Prop('born', ValueType.Date),
                    IndexFx.Prop('at', ValueType.DateTime),
                    IndexFx.Prop('span', ValueType.Duration),
                    { Name: 'knows', Kind: MemberKind.Relationship, Targets: ['Person'], Many: true },
                ],
            },
            { Name: 'Robot', IsAspect: false, Parent: null, Aspects: ['Tagged'], Members: [IndexFx.Prop('serial', ValueType.String)] },
        ];
    }

    public static Indexes(): IIndexDescription[]
    {
        return [
            { Name: 'byAge', On: 'Person', Members: ['age'] },
            { Name: 'byStatusAge', On: 'Person', Members: ['status', 'age'] },
            { Name: 'byTag', On: 'Tagged', Members: ['tag'] },
            { Name: 'uniqueEmail', On: 'Person', Members: ['email'], Unique: true },
            { Name: 'openByAge', On: 'Person', Members: ['age'], Where: new Compare('status', CompareOp.Eq, 'open') },
            { Name: 'byScore', On: 'Person', Members: ['score'] },
            { Name: 'byBorn', On: 'Person', Members: ['born'] },
            { Name: 'byAt', On: 'Person', Members: ['at'] },
        ];
    }

    public static Desc(version: string, indexes: IIndexDescription[] = IndexFx.Indexes(), defs = IndexFx.Defs(), seed: ISeedNode[] = []): ISchemaDescription
    {
        return { Version: version, Definitions: defs, Indexes: indexes, Seed: seed, Bindings: [] };
    }

    public static async Ready(open: () => Promise<GraphStore>, desc = IndexFx.Desc('v1')): Promise<GraphStore>
    {
        const g = await open();
        await g.Upgrade(desc);
        return g;
    }

    public static async Commit(g: GraphStore, build: (t: GraphTransaction) => void): Promise<bigint>
    {
        const t = await g.Begin();
        build(t);
        return t.Commit();
    }

    /** Creates Person nodes with the given properties, one batch. */
    public static async People(g: GraphStore, people: Record<string, Record<string, CellValue>>): Promise<void>
    {
        await IndexFx.Commit(g, t =>
        {
            for (const [id, props] of Object.entries(people))
            {
                t.CreateNode(id, 'Person');
                for (const [name, value] of Object.entries(props))
                {
                    t.SetProperty(id, name, value);
                }
            }
        });
    }

    public static async Seek(g: GraphStore, index: string, range: IIndexRange): Promise<string[]>
    {
        const r = await g.BeginRead();
        try
        {
            return await IndexFx.Collect(r, index, range);
        }
        finally
        {
            r.dispose();
        }
    }

    public static async Collect(r: GraphReader, index: string, range: IIndexRange): Promise<string[]>
    {
        const out: string[] = [];
        for await (const id of r.SeekIndex(index, range))
        {
            out.push(id);
        }
        return out;
    }

    public static Context(g: GraphStore): GraphContext
    {
        return (g as unknown as { context: GraphContext }).context;
    }

    /** Every key of the Index keyspace, decoded. */
    public static async IndexKeys(g: GraphStore): Promise<unknown[][]>
    {
        const txn = await IndexFx.Context(g).Store.BeginRead();
        try
        {
            const out: unknown[][] = [];
            for await (const [key] of txn.Scan(Keyspace.Index, IndexFx.AnyKey))
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

    /** Every key and value of every keyspace, hex-encoded. */
    public static async Snapshot(g: GraphStore): Promise<Record<string, string[]>>
    {
        const txn = await IndexFx.Context(g).Store.BeginRead();
        try
        {
            const out: Record<string, string[]> = {};
            for (const space of Object.values(Keyspace))
            {
                const rows: string[] = [];
                for await (const [k, v] of txn.Scan(space, IndexFx.AnyKey))
                {
                    rows.push(Buffer.from(k).toString('hex') + '=' + Buffer.from(v).toString('hex'));
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

    public static IndexId(g: GraphStore, name: string): number
    {
        return IndexFx.Context(g).Committer.Catalog.Indexes().find(i => i.Name === name)!.Id;
    }

    public static IsCommit(code: CommitErrorCode): (error: unknown) => boolean
    {
        return (error: unknown) => error instanceof CommitError && error.Code === code;
    }

    public static IsCatalog(code: CatalogErrorCode): (error: unknown) => boolean
    {
        return (error: unknown) => error instanceof CatalogError && error.Code === code;
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        describe('Secondary indexes on ' + name, () =>
        {
            it('seek by equality prefix', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { p1: { age: 30n }, p2: { age: 40n }, p3: { age: 30n }, p4: {} });
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [30n] }), ['p1', 'p3']);
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [41n] }), []);
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [null] }), ['p4'], 'nulls are indexed');
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [] }), ['p4', 'p1', 'p3', 'p2'], 'null sorts first, then by value then internal id');
                await g.dispose();
            });

            it('range with bounds inclusive/exclusive', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { a: { age: 10n }, b: { age: 20n }, c: { age: 30n }, d: { age: 40n }, e: { age: -5n } });
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [], Lower: { Value: 20n, Inclusive: true }, Upper: { Value: 40n, Inclusive: false } }), ['b', 'c']);
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [], Lower: { Value: 20n, Inclusive: false }, Upper: { Value: 40n, Inclusive: true } }), ['c', 'd']);
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [], Upper: { Value: 10n, Inclusive: true } }), ['e', 'a'], 'negative values order below positive');
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [], Lower: { Value: 35n, Inclusive: true } }), ['d']);
                await g.dispose();
            });

            it('reverse with limit', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { a: { age: 10n }, b: { age: 20n }, c: { age: 30n }, d: { age: 40n } });
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [], Reverse: true, Limit: 2 }), ['d', 'c']);
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [], Limit: 3 }), ['a', 'b', 'c']);
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [], Upper: { Value: 30n, Inclusive: false }, Reverse: true, Limit: 1 }), ['b']);
                await g.dispose();
            });

            it('composite index orders by second member within prefix', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { x: { status: 'a', age: 30n }, y: { status: 'a', age: 10n }, z: { status: 'b', age: 5n }, w: { status: 'a', age: 20n } });
                assert.deepEqual(await IndexFx.Seek(g, 'byStatusAge', { Prefix: ['a'] }), ['y', 'w', 'x']);
                assert.deepEqual(await IndexFx.Seek(g, 'byStatusAge', { Prefix: ['a'], Lower: { Value: 20n, Inclusive: true } }), ['w', 'x']);
                assert.deepEqual(await IndexFx.Seek(g, 'byStatusAge', { Prefix: ['a', 10n] }), ['y']);
                assert.deepEqual(await IndexFx.Seek(g, 'byStatusAge', { Prefix: [] }), ['y', 'w', 'x', 'z']);
                await g.dispose();
            });

            it('Float64, Date and DateTime values order numerically (FDB double, -0 = 0, zone ignored)', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, {
                    a: { score: 2, born: new DateValue(10), at: new DateTimeValue(5n, 'UTC') }, b: { score: -1.5, born: new DateValue(-3), at: new DateTimeValue(-7n, 'Europe/Paris') },
                    c: { score: -0, born: new DateValue(0), at: new DateTimeValue(5n, 'Asia/Tokyo') },
                    d: { score: Number.POSITIVE_INFINITY }, e: { score: 0.5 }, f: { score: Number.NEGATIVE_INFINITY },
                });
                assert.deepEqual(await IndexFx.Seek(g, 'byScore', { Prefix: [], Lower: { Value: Number.NEGATIVE_INFINITY, Inclusive: true } }), ['f', 'b', 'c', 'e', 'a', 'd']);
                assert.deepEqual(await IndexFx.Seek(g, 'byScore', { Prefix: [0] }), ['c'], '-0 is indexed as 0');
                assert.deepEqual(await IndexFx.Seek(g, 'byBorn', { Prefix: [], Lower: { Value: new DateValue(-100), Inclusive: true } }), ['b', 'c', 'a']);
                assert.deepEqual(await IndexFx.Seek(g, 'byAt', { Prefix: [], Lower: { Value: new DateTimeValue(-100n, 'UTC'), Inclusive: true } }), ['b', 'a', 'c']);
                assert.deepEqual(await IndexFx.Seek(g, 'byAt', { Prefix: [new DateTimeValue(5n, 'America/Lima')] }), ['a', 'c'], 'equal instants in any zone');
                await g.dispose();
            });

            it('aspect index covers carriers', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.Commit(g, t =>
                {
                    t.CreateNode('p1', 'Person');
                    t.SetProperty('p1', 'tag', 'x');
                    t.CreateNode('r1', 'Robot');
                    t.SetProperty('r1', 'tag', 'x');
                    t.CreateNode('r2', 'Robot');
                    t.SetProperty('r2', 'tag', 'y');
                });
                assert.deepEqual(await IndexFx.Seek(g, 'byTag', { Prefix: ['x'] }), ['p1', 'r1']);
                assert.deepEqual(await IndexFx.Seek(g, 'byTag', { Prefix: ['y'] }), ['r2']);
                await g.dispose();
            });

            it('partial index tracks predicate entry and exit', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { p1: { status: 'open', age: 5n }, p2: { status: 'closed', age: 6n }, p3: { age: 7n } });
                assert.deepEqual(await IndexFx.Seek(g, 'openByAge', { Prefix: [] }), ['p1']);
                await IndexFx.Commit(g, t => t.SetProperty('p1', 'status', 'closed'));
                assert.deepEqual(await IndexFx.Seek(g, 'openByAge', { Prefix: [] }), []);
                await IndexFx.Commit(g, t =>
                {
                    t.SetProperty('p2', 'status', 'open');
                    t.SetProperty('p2', 'age', 60n);
                });
                assert.deepEqual(await IndexFx.Seek(g, 'openByAge', { Prefix: [60n] }), ['p2'], 'evaluated on the post-batch values');
                assert.deepEqual(await IndexFx.Seek(g, 'openByAge', { Prefix: [6n] }), []);
                await g.dispose();
            });

            it('an indexed value change moves the entry; an unrelated set leaves it', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { p1: { age: 5n } });
                await IndexFx.Commit(g, t => t.SetProperty('p1', 'age', 9n));
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [5n] }), []);
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [9n] }), ['p1']);
                const before = await IndexFx.IndexKeys(g);
                await IndexFx.Commit(g, t => t.SetProperty('p1', 'span', null));
                assert.deepEqual(await IndexFx.IndexKeys(g), before);
                await g.dispose();
            });

            it('delete removes entry', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { p1: { age: 5n, email: 'a@x', status: 'open', tag: 't' }, p2: { age: 5n } });
                await IndexFx.Commit(g, t => t.DeleteNode('p1'));
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [5n] }), ['p2']);
                assert.deepEqual(await IndexFx.Seek(g, 'uniqueEmail', { Prefix: ['a@x'] }), []);
                assert.deepEqual(await IndexFx.Seek(g, 'byTag', { Prefix: ['t'] }), []);
                const p2Entries = (await IndexFx.IndexKeys(g)).length;
                assert.equal(p2Entries, IndexFx.Indexes().length - 1, 'p2 has one entry per index (not openByAge)');
                await IndexFx.Commit(g, t =>
                {
                    t.CreateNode('p3', 'Person');
                    t.SetProperty('p3', 'age', 1n);
                    t.DeleteNode('p3');
                });
                assert.equal((await IndexFx.IndexKeys(g)).length, p2Entries, 'created and deleted in one batch leaves nothing');
                await IndexFx.Commit(g, t => t.SetProperty('p2', 'email', 'a@x'));
                assert.deepEqual(await IndexFx.Seek(g, 'uniqueEmail', { Prefix: ['a@x'] }), ['p2'], 'a deleted node no longer holds its unique value');
                await g.dispose();
            });

            it('retype of indexed member drops index entries', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { p1: { age: 30n, status: 'open' }, p2: { age: 40n } });
                const oldIds = ['byAge', 'byStatusAge', 'openByAge'].map(n => IndexFx.IndexId(g, n));
                await g.Upgrade(IndexFx.Desc('v2', IndexFx.Indexes(), IndexFx.Defs(ValueType.String)));
                const keys = await IndexFx.IndexKeys(g);
                for (const id of oldIds)
                {
                    assert.ok(!keys.some(k => k[0] === BigInt(id)), 'no entry of the old index ' + id);
                }
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: ['30'] }), []);
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [null] }), ['p1', 'p2'], 'rebuilt over the dropped (null) values');
                assert.deepEqual(await IndexFx.Seek(g, 'openByAge', { Prefix: [null] }), ['p1']);
                await IndexFx.Commit(g, t => t.SetProperty('p2', 'age', '41'));
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: ['41'] }), ['p2']);
                await g.dispose();
            });

            it('removed concept and removed index drop their entries', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.Commit(g, t =>
                {
                    t.CreateNode('p1', 'Person');
                    t.SetProperty('p1', 'tag', 'x');
                    t.SetProperty('p1', 'age', 3n);
                    t.CreateNode('r1', 'Robot');
                    t.SetProperty('r1', 'tag', 'x');
                });
                const byAge = IndexFx.IndexId(g, 'byAge');
                const defs = IndexFx.Defs().filter(d => d.Name !== 'Robot');
                await g.Upgrade(IndexFx.Desc('v2', IndexFx.Indexes().filter(i => i.Name !== 'byAge'), defs));
                assert.deepEqual(await IndexFx.Seek(g, 'byTag', { Prefix: ['x'] }), ['p1']);
                assert.ok(!(await IndexFx.IndexKeys(g)).some(k => k[0] === BigInt(byAge)));
                await assert.rejects(IndexFx.Seek(g, 'byAge', { Prefix: [] }), IndexFx.IsCatalog(CatalogErrorCode.UnknownMember));
                await g.dispose();
            });

            it('a concept that stops carrying the aspect leaves the aspect index', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.Commit(g, t =>
                {
                    t.CreateNode('r1', 'Robot');
                    t.SetProperty('r1', 'tag', 'x');
                    t.CreateNode('p1', 'Person');
                    t.SetProperty('p1', 'tag', 'x');
                });
                const defs = IndexFx.Defs().map(d => d.Name !== 'Robot' ? d : { ...d, Aspects: [] });
                await g.Upgrade(IndexFx.Desc('v2', IndexFx.Indexes(), defs));
                assert.deepEqual(await IndexFx.Seek(g, 'byTag', { Prefix: ['x'] }), ['p1']);
                await g.dispose();
            });

            it('unique violation rejects batch', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { p1: { email: 'a@x' } });
                await assert.rejects(IndexFx.People(g, { p2: { email: 'a@x' } }), (e: unknown) => IndexFx.IsCommit(CommitErrorCode.UniqueViolation)(e) && (e as GraphError).GraphCode === GraphErrorCode.ConstraintViolation);
                await assert.rejects(IndexFx.People(g, { q1: { email: 'b@x' }, q2: { email: 'b@x' } }), IndexFx.IsCommit(CommitErrorCode.UniqueViolation), 'within one batch');
                await assert.rejects(IndexFx.Commit(g, t =>
                {
                    t.CreateNode('p3', 'Person');
                    t.SetProperty('p3', 'email', 'c@x');
                    t.SetProperty('p1', 'email', 'c@x');
                }), IndexFx.IsCommit(CommitErrorCode.UniqueViolation), 'an update collides too');
                assert.deepEqual(await IndexFx.Seek(g, 'uniqueEmail', { Prefix: [] }), ['p1']);
                await IndexFx.People(g, { p4: { email: 'd@x' } });
                await IndexFx.Commit(g, t =>
                {
                    t.SetProperty('p1', 'email', 'd@x');
                    t.SetProperty('p4', 'email', 'a@x');
                });
                assert.deepEqual(await IndexFx.Seek(g, 'uniqueEmail', { Prefix: ['d@x'] }), ['p1'], 'a swap in one batch is fine');
                assert.deepEqual(await IndexFx.Seek(g, 'uniqueEmail', { Prefix: ['a@x'] }), ['p4']);
                await IndexFx.Commit(g, t => t.SetProperty('p1', 'email', 'd@x'));
                assert.deepEqual(await IndexFx.Seek(g, 'uniqueEmail', { Prefix: ['d@x'] }), ['p1'], 'rewriting its own value is no violation');
                await g.dispose();
            });

            it('nulls never violate unique', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { p1: {}, p2: { email: null }, p3: {} });
                assert.deepEqual(await IndexFx.Seek(g, 'uniqueEmail', { Prefix: [null] }), ['p1', 'p2', 'p3']);
                await g.dispose();
            });

            it('concurrent unique inserts: one wins', async () =>
            {
                const g = await IndexFx.Ready(open);
                const t1 = await g.Begin();
                const t2 = await g.Begin();
                t1.CreateNode('a', 'Person');
                t1.SetProperty('a', 'email', 'same@x');
                t2.CreateNode('b', 'Person');
                t2.SetProperty('b', 'email', 'same@x');
                const results = await Promise.allSettled([t1.Commit(), t2.Commit()]);
                assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
                const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
                assert.ok(failed.reason instanceof ConflictError || IndexFx.IsCommit(CommitErrorCode.UniqueViolation)(failed.reason), String(failed.reason));
                assert.equal((await IndexFx.Seek(g, 'uniqueEmail', { Prefix: ['same@x'] })).length, 1);
                await g.dispose();
            });

            it('seek is phantom-safe', async () =>
            {
                const g = await IndexFx.Ready(open);
                await IndexFx.People(g, { a: { age: 10n }, b: { age: 50n }, w: {} });
                const t1 = await g.Begin();
                assert.deepEqual(await IndexFx.Collect(t1, 'byAge', { Prefix: [], Lower: { Value: 10n, Inclusive: true }, Upper: { Value: 50n, Inclusive: true } }), ['a', 'b']);
                await IndexFx.People(g, { c: { age: 25n } });
                t1.SetProperty('w', 'status', 'x');
                await assert.rejects(t1.Commit(), ConflictError);

                const t2 = await g.Begin();
                await IndexFx.Collect(t2, 'byAge', { Prefix: [], Lower: { Value: 10n, Inclusive: true }, Upper: { Value: 50n, Inclusive: true } });
                await IndexFx.People(g, { d: { age: 99n } });
                t2.SetProperty('w', 'status', 'y');
                await t2.Commit();

                const t3 = await g.Begin();
                assert.deepEqual(await IndexFx.Collect(t3, 'byAge', { Prefix: [], Lower: { Value: 10n, Inclusive: true }, Limit: 1 }), ['a']);
                await IndexFx.People(g, { e: { age: 60n } });
                t3.SetProperty('w', 'status', 'z');
                await t3.Commit();
                await g.dispose();
            });

            it('index added by upgrade is built over existing nodes', async () =>
            {
                const g = await IndexFx.Ready(open, IndexFx.Desc('v1', []));
                await IndexFx.People(g, { p1: { age: 30n, status: 'open', email: 'a' }, p2: { age: 20n }, p3: { email: 'b' } });
                await g.Upgrade(IndexFx.Desc('v2'));
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [] }), ['p3', 'p2', 'p1']);
                assert.deepEqual(await IndexFx.Seek(g, 'openByAge', { Prefix: [] }), ['p1']);
                assert.deepEqual(await IndexFx.Seek(g, 'uniqueEmail', { Prefix: ['b'] }), ['p3']);
                await g.dispose();
            });

            it('a unique index added over duplicate data fails the upgrade atomically', async () =>
            {
                const g = await IndexFx.Ready(open, IndexFx.Desc('v1', []));
                await IndexFx.People(g, { p1: { email: 'a' }, p2: { email: 'a' } });
                const before = await IndexFx.Snapshot(g);
                await assert.rejects(g.Upgrade(IndexFx.Desc('v2')), IndexFx.IsCommit(CommitErrorCode.UniqueViolation));
                assert.deepEqual(await IndexFx.Snapshot(g), before);
                assert.equal(await g.SchemaVersion(), 'v1');
                await g.dispose();
            });

            it('seed batch maintains indexes', async () =>
            {
                const seed: ISeedNode[] = [{ PublicId: 's1', Concept: 'Person', Owner: '', Properties: { age: 77n, email: 'seed' }, Links: [] }];
                const g = await IndexFx.Ready(open, IndexFx.Desc('v1', IndexFx.Indexes(), IndexFx.Defs(), seed));
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [77n] }), ['s1']);
                await assert.rejects(IndexFx.People(g, { p1: { email: 'seed' } }), IndexFx.IsCommit(CommitErrorCode.UniqueViolation));
                const reseed: ISeedNode[] = [{ PublicId: 's1', Concept: 'Person', Owner: '', Properties: { age: 78n, email: 'seed' }, Links: [] }];
                await g.Upgrade(IndexFx.Desc('v2', IndexFx.Indexes(), IndexFx.Defs(), reseed));
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [77n] }), []);
                assert.deepEqual(await IndexFx.Seek(g, 'byAge', { Prefix: [78n] }), ['s1']);
                await g.dispose();
            });

            it('plan-time rules: node-local Where, no Duration member', async () =>
            {
                const g = await IndexFx.Ready(open, IndexFx.Desc('v1', []));
                const related = new Related('knows', EdgeDirection.Out, TruePredicate.Instance);
                await assert.rejects(g.Upgrade(IndexFx.Desc('v2', [{ Name: 'bad', On: 'Person', Members: ['age'], Where: related }])), IndexFx.IsCatalog(CatalogErrorCode.InvalidMember));
                await assert.rejects(g.Upgrade(IndexFx.Desc('v2', [{ Name: 'bad', On: 'Person', Members: ['span'] }])), IndexFx.IsCatalog(CatalogErrorCode.InvalidMember));
                await g.dispose();
            });

            it('seek argument errors', async () =>
            {
                const g = await IndexFx.Ready(open);
                const invalid = (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument;
                await assert.rejects(IndexFx.Seek(g, 'nope', { Prefix: [] }), IndexFx.IsCatalog(CatalogErrorCode.UnknownMember));
                await assert.rejects(IndexFx.Seek(g, 'byAge', { Prefix: [1n, 2n] }), invalid, 'prefix longer than the index');
                await assert.rejects(IndexFx.Seek(g, 'byAge', { Prefix: [1n], Lower: { Value: 1n, Inclusive: true } }), invalid, 'bound after a full prefix');
                await assert.rejects(IndexFx.Seek(g, 'byAge', { Prefix: ['x'] }), invalid, 'value of the wrong type');
                await g.dispose();
            });

            it('indexes survive a reopen', async () =>
            {
                if (name !== 'lmdb')
                {
                    return;
                }
                const dir = IndexFx.Dir();
                const g = await IndexFx.Ready(() => GraphStore.OpenLmdb(dir));
                await IndexFx.People(g, { p1: { age: 1n } });
                await g.dispose();
                const again = await GraphStore.OpenLmdb(dir);
                assert.deepEqual(await IndexFx.Seek(again, 'byAge', { Prefix: [1n] }), ['p1']);
                await again.dispose();
            });
        });
    }
}

after(() => IndexFx.RemoveDirs());
IndexFx.Register('memory', () => GraphStore.OpenMemory());
IndexFx.Register('lmdb', () => GraphStore.OpenLmdb(IndexFx.Dir()));
