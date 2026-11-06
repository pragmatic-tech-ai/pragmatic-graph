import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import type { MemberDef } from '../../catalog/CatalogTypes.js';
import { CellValue } from '../../columns/CellValue.js';
import { EdgeDirection, FormatKeys } from '../../format/FormatKeys.js';
import { TupleCodec } from '../../format/TupleCodec.js';
import type { IKeyValueStore, IReadTransaction } from '../../kv/KeyValue.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { LmdbStore } from '../../kv/lmdb/LmdbStore.js';
import { MemoryStore } from '../../kv/memory/MemoryStore.js';
import { EdgeError, EdgeErrorCode } from '../EdgeError.js';
import { EdgeStore } from '../EdgeStore.js';

interface INeighbor
{
    Node: bigint;
    Position: Uint8Array;
    Properties: ReadonlyMap<string, CellValue>;
}

class EdgeFx
{
    private static readonly DirPrefix = 'pragmatic-graph-edges-';
    private static readonly Dirs: string[] = [];
    public static readonly Weight: MemberDef = { Id: 20, Name: 'weight', Kind: MemberKind.Property, Type: ValueType.Int64, Nullable: true, DeclaredBy: 'R' };
    public static readonly Label: MemberDef = { Id: 21, Name: 'label', Kind: MemberKind.Property, Type: ValueType.String, Nullable: false, DeclaredBy: 'R' };
    public static readonly Many: MemberDef = EdgeFx.Rel(10, true, false, []);
    public static readonly ManyOrdered: MemberDef = EdgeFx.Rel(11, true, true, []);
    public static readonly One: MemberDef = EdgeFx.Rel(12, false, false, []);
    public static readonly WithProps: MemberDef = EdgeFx.Rel(13, true, false, [EdgeFx.Weight, EdgeFx.Label]);
    public static readonly NotRel: MemberDef = { Id: 14, Name: 'p', Kind: MemberKind.Property, Type: ValueType.Int64, Nullable: true, DeclaredBy: 'R' };

    public static Rel(id: number, many: boolean, ordered: boolean, props: MemberDef[]): MemberDef
    {
        return { Id: id, Name: 'rel' + id, Kind: MemberKind.Relationship, Nullable: true, Targets: ['T'], Many: many, Ordered: ordered, EdgeProperties: props, DeclaredBy: 'R' };
    }

    public static async OpenLmdb(): Promise<IKeyValueStore>
    {
        const dir = mkdtempSync(join(tmpdir(), EdgeFx.DirPrefix));
        EdgeFx.Dirs.push(dir);
        return LmdbStore.Open(dir);
    }

    public static RemoveDirs(): void
    {
        for (const d of EdgeFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static async List(es: EdgeStore, txn: IReadTransaction, rel: MemberDef, node: bigint, dir: EdgeDirection): Promise<INeighbor[]>
    {
        const out: INeighbor[] = [];
        for await (const n of es.Neighbors(txn, rel, node, dir))
        {
            out.push(n);
        }
        return out;
    }

    public static async Nodes(store: IKeyValueStore, es: EdgeStore, rel: MemberDef, node: bigint, dir: EdgeDirection): Promise<bigint[]>
    {
        const r = await store.BeginRead();
        const list = await EdgeFx.List(es, r, rel, node, dir);
        r.dispose();
        return list.map(n => n.Node);
    }

    public static async Code(work: Promise<unknown>): Promise<EdgeErrorCode | undefined>
    {
        try
        {
            await work;
        }
        catch (e)
        {
            return e instanceof EdgeError ? e.Code : undefined;
        }
        return undefined;
    }

    public static Register(name: string, open: () => Promise<IKeyValueStore>): void
    {
        describe('edge store on ' + name, () =>
        {
            it('a link is visible from both ends, with In/Out keys on the right nodes', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                await store.Write(txn => es.Link(txn, EdgeFx.Many, 1n, 2n));
                assert.deepEqual(await EdgeFx.Nodes(store, es, EdgeFx.Many, 1n, EdgeDirection.Out), [2n]);
                assert.deepEqual(await EdgeFx.Nodes(store, es, EdgeFx.Many, 2n, EdgeDirection.In), [1n]);
                assert.deepEqual(await EdgeFx.Nodes(store, es, EdgeFx.Many, 2n, EdgeDirection.Out), []);
                assert.deepEqual(await EdgeFx.Nodes(store, es, EdgeFx.Many, 1n, EdgeDirection.In), []);
                const r = await store.BeginRead();
                const empty = new Uint8Array(0);
                assert.ok((await r.Get(Keyspace.Edges, FormatKeys.Edge(0, 10, EdgeDirection.Out, 1n, empty, 2n))) !== undefined);
                const inValue = await r.Get(Keyspace.Edges, FormatKeys.Edge(0, 10, EdgeDirection.In, 2n, empty, 1n));
                assert.equal(inValue?.length, 0);
                r.dispose();
                await store.dispose();
            });

            it('Unlink removes both keys and a missing pair is MissingEdge', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                await store.Write(async txn =>
                {
                    await es.Link(txn, EdgeFx.ManyOrdered, 1n, 2n);
                    await es.Link(txn, EdgeFx.ManyOrdered, 1n, 3n);
                });
                await store.Write(txn => es.Unlink(txn, EdgeFx.ManyOrdered, 1n, 2n));
                assert.deepEqual(await EdgeFx.Nodes(store, es, EdgeFx.ManyOrdered, 1n, EdgeDirection.Out), [3n]);
                assert.deepEqual(await EdgeFx.Nodes(store, es, EdgeFx.ManyOrdered, 2n, EdgeDirection.In), []);
                const r = await store.BeginRead();
                let keys = 0;
                for await (const _ of r.Scan(Keyspace.Edges, FormatKeys.EdgeRange(0, 11, EdgeDirection.In, 2n)))
                {
                    keys++;
                }
                assert.equal(keys, 0);
                r.dispose();
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Unlink(txn, EdgeFx.ManyOrdered, 1n, 2n))), EdgeErrorCode.MissingEdge);
                await store.dispose();
            });

            it('ordered: c linked between a and b lists a, c, b; append, After and Before work', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                const rel = EdgeFx.ManyOrdered;
                const pos = await store.Write(async txn =>
                {
                    const a = await es.Link(txn, rel, 1n, 10n);
                    const b = await es.Link(txn, rel, 1n, 20n);
                    const c = await es.Link(txn, rel, 1n, 30n, { After: a, Before: b });
                    await es.Link(txn, rel, 1n, 40n, { Before: a });
                    await es.Link(txn, rel, 1n, 50n, { After: b });
                    await es.Link(txn, rel, 1n, 60n, { After: a });
                    return { a, b, c };
                });
                assert.ok(TupleCodec.Compare(pos.a, pos.c) < 0 && TupleCodec.Compare(pos.c, pos.b) < 0);
                assert.deepEqual(await EdgeFx.Nodes(store, es, rel, 1n, EdgeDirection.Out), [40n, 10n, 60n, 30n, 20n, 50n]);
                assert.deepEqual(await EdgeFx.Nodes(store, es, rel, 30n, EdgeDirection.In), [1n]);
                await store.dispose();
            });

            it('unknown siblings are rejected, including positions of another source', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                const rel = EdgeFx.ManyOrdered;
                const bogus = Uint8Array.of(0x33);
                await store.Write(async txn =>
                {
                    await es.Link(txn, rel, 1n, 9n);
                    const second = await es.Link(txn, rel, 2n, 9n);
                    await es.Link(txn, rel, 2n, 8n, { After: second });
                    await es.Link(txn, rel, 2n, 7n, { After: second });
                });
                const r = await store.BeginRead();
                const ins = await EdgeFx.List(es, r, rel, 9n, EdgeDirection.In);
                assert.equal(ins.length, 2);
                const otherPositions = (await EdgeFx.List(es, r, rel, 2n, EdgeDirection.Out)).map(n => n.Position);
                const mine = (await EdgeFx.List(es, r, rel, 1n, EdgeDirection.Out))[0]!.Position;
                r.dispose();
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, rel, 1n, 5n, { After: bogus }))), EdgeErrorCode.UnknownSibling);
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, rel, 1n, 5n, { Before: bogus }))), EdgeErrorCode.UnknownSibling);
                const foreign = otherPositions.find(p => TupleCodec.Compare(p, mine) !== 0) as Uint8Array;
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, rel, 1n, 5n, { After: foreign }))), EdgeErrorCode.UnknownSibling);
                await store.dispose();
            });

            it('rejects duplicates, exceeded cardinality and non-relationships; unordered uses the empty position', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                const p = await store.Write(txn => es.Link(txn, EdgeFx.One, 1n, 2n));
                assert.equal(p.length, 0);
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, EdgeFx.One, 1n, 2n))), EdgeErrorCode.DuplicateEdge);
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, EdgeFx.One, 1n, 3n))), EdgeErrorCode.CardinalityExceeded);
                await store.Write(txn => es.Link(txn, EdgeFx.One, 4n, 2n));
                await store.Write(async txn =>
                {
                    await es.Link(txn, EdgeFx.Many, 1n, 2n);
                    await es.Link(txn, EdgeFx.Many, 1n, 3n);
                });
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, EdgeFx.Many, 1n, 3n))), EdgeErrorCode.DuplicateEdge);
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, EdgeFx.NotRel, 1n, 3n))), EdgeErrorCode.NotARelationship);
                await assert.rejects(store.Write(txn => es.Link(txn, EdgeFx.Many, 0n, 3n)), RangeError);
                await store.dispose();
            });

            it('edge properties round-trip on Out and In, and are validated', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                const rel = EdgeFx.WithProps;
                await store.Write(txn => es.Link(txn, rel, 1n, 2n, { Properties: new Map<string, CellValue>([['weight', 7n], ['label', 'x']]) }));
                await store.Write(txn => es.Link(txn, rel, 1n, 3n, { Properties: new Map<string, CellValue>([['label', 'y'], ['weight', null]]) }));
                const r = await store.BeginRead();
                const out = await EdgeFx.List(es, r, rel, 1n, EdgeDirection.Out);
                assert.deepEqual([...out[0]!.Properties.entries()].sort(), [['label', 'x'], ['weight', 7n]]);
                assert.deepEqual([...out[1]!.Properties.entries()], [['label', 'y']]);
                const inn = await EdgeFx.List(es, r, rel, 2n, EdgeDirection.In);
                assert.deepEqual([...inn[0]!.Properties.entries()].sort(), [['label', 'x'], ['weight', 7n]]);
                r.dispose();
                const bad = (p: Array<[string, CellValue]>) => EdgeFx.Code(store.Write(txn => es.Link(txn, rel, 5n, 6n, { Properties: new Map(p) })));
                assert.equal(await bad([['nope', 1n]]), EdgeErrorCode.InvalidProperty);
                assert.equal(await bad([['weight', 'str'], ['label', 'z']]), EdgeErrorCode.InvalidProperty);
                assert.equal(await bad([['label', null]]), EdgeErrorCode.InvalidProperty);
                await store.dispose();
            });

            it('requires every non-nullable edge property, even when no properties are given', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                const rel = EdgeFx.WithProps;
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, rel, 1n, 2n))), EdgeErrorCode.InvalidProperty);
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, rel, 1n, 2n, { Properties: new Map<string, CellValue>([['weight', 1n]]) }))), EdgeErrorCode.InvalidProperty);
                await store.Write(txn => es.Link(txn, rel, 1n, 2n, { Properties: new Map<string, CellValue>([['label', 'ok']]) }));
                await store.dispose();
            });

            it('After/Before on an unordered relationship is NotOrdered; After >= Before is rejected', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                const some = Uint8Array.of(0x80);
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, EdgeFx.Many, 1n, 2n, { After: some }))), EdgeErrorCode.NotOrdered);
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, EdgeFx.Many, 1n, 2n, { Before: some }))), EdgeErrorCode.NotOrdered);
                const rel = EdgeFx.ManyOrdered;
                const pos = await store.Write(async txn => ({ a: await es.Link(txn, rel, 1n, 10n), b: await es.Link(txn, rel, 1n, 20n) }));
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, rel, 1n, 30n, { After: pos.b, Before: pos.a }))), EdgeErrorCode.InvalidOrder);
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, rel, 1n, 30n, { After: pos.a, Before: pos.a }))), EdgeErrorCode.InvalidOrder);
                await store.dispose();
            });

            it('garbage under an Out key is CorruptEdge', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                const rel = EdgeFx.WithProps;
                const key = FormatKeys.Edge(0, rel.Id, EdgeDirection.Out, 1n, new Uint8Array(0), 2n);
                for (const bytes of [Uint8Array.of(1, 2, 3), Uint8Array.of(99, 0, 0, 0, 1, 0, 0, 0, 7), Uint8Array.of(20, 0, 0, 0, 3, 0, 0, 0, 1, 2, 3)])
                {
                    await store.Write(async txn => txn.Put(Keyspace.Edges, key, bytes));
                    const r = await store.BeginRead();
                    assert.equal(await EdgeFx.Code(EdgeFx.List(es, r, rel, 1n, EdgeDirection.Out)), EdgeErrorCode.CorruptEdge);
                    r.dispose();
                }
                await store.dispose();
            });

            it('After and Before that are not adjacent are NotAdjacent; adjacent ones work', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                const rel = EdgeFx.ManyOrdered;
                const pos = await store.Write(async txn => ({ a: await es.Link(txn, rel, 1n, 10n), b: await es.Link(txn, rel, 1n, 20n), c: await es.Link(txn, rel, 1n, 30n) }));
                assert.equal(await EdgeFx.Code(store.Write(txn => es.Link(txn, rel, 1n, 40n, { After: pos.a, Before: pos.c }))), EdgeErrorCode.NotAdjacent);
                await store.Write(txn => es.Link(txn, rel, 1n, 40n, { After: pos.b, Before: pos.c }));
                assert.deepEqual(await EdgeFx.Nodes(store, es, rel, 1n, EdgeDirection.Out), [10n, 20n, 40n, 30n]);
                await store.dispose();
            });

            it('a valid member id with corrupt value bytes is CorruptEdge', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                const rel = EdgeFx.WithProps;
                const key = FormatKeys.Edge(0, rel.Id, EdgeDirection.Out, 1n, new Uint8Array(0), 2n);
                const weightShort = Uint8Array.of(20, 0, 0, 0, 3, 0, 0, 0, 1, 2, 3);
                const labelBadUtf8 = Uint8Array.of(21, 0, 0, 0, 2, 0, 0, 0, 0xff, 0xfe);
                for (const bytes of [weightShort, labelBadUtf8])
                {
                    await store.Write(async txn => txn.Put(Keyspace.Edges, key, bytes));
                    const r = await store.BeginRead();
                    assert.equal(await EdgeFx.Code(EdgeFx.List(es, r, rel, 1n, EdgeDirection.Out)), EdgeErrorCode.CorruptEdge);
                    r.dispose();
                }
                await store.dispose();
            });

            it('duplicate messages are consistent and Unlink works on every relationship shape', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                const messages: string[] = [];
                for (const rel of [EdgeFx.Many, EdgeFx.ManyOrdered, EdgeFx.One])
                {
                    await store.Write(txn => es.Link(txn, rel, 1n, 2n));
                    try
                    {
                        await store.Write(txn => es.Link(txn, rel, 1n, 2n));
                    }
                    catch (e)
                    {
                        messages.push((e as Error).message.replace(rel.Name, 'REL'));
                    }
                    assert.equal(await EdgeFx.Code(store.Write(txn => es.Unlink(txn, rel, 1n, 3n))), EdgeErrorCode.MissingEdge);
                    await store.Write(txn => es.Unlink(txn, rel, 1n, 2n));
                    assert.deepEqual(await EdgeFx.Nodes(store, es, rel, 1n, EdgeDirection.Out), []);
                    assert.deepEqual(await EdgeFx.Nodes(store, es, rel, 2n, EdgeDirection.In), []);
                }
                assert.equal(messages.length, 3);
                assert.equal(new Set(messages).size, 1);
                await store.dispose();
            });

            it('neighbors never include other nodes or other relationships', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                await store.Write(async txn =>
                {
                    await es.Link(txn, EdgeFx.Many, 1n, 100n);
                    await es.Link(txn, EdgeFx.Many, 2n, 200n);
                    await es.Link(txn, EdgeFx.Many, 10n, 300n);
                    await es.Link(txn, EdgeFx.ManyOrdered, 1n, 400n);
                });
                assert.deepEqual(await EdgeFx.Nodes(store, es, EdgeFx.Many, 1n, EdgeDirection.Out), [100n]);
                assert.deepEqual(await EdgeFx.Nodes(store, es, EdgeFx.Many, 2n, EdgeDirection.Out), [200n]);
                await store.dispose();
            });

            it('Neighbors streams: stopping early works', async () =>
            {
                const store = await open();
                const es = new EdgeStore();
                await store.Write(async txn =>
                {
                    for (let i = 1n; i <= 20n; i++)
                    {
                        await es.Link(txn, EdgeFx.Many, 1n, i + 100n);
                    }
                });
                const r = await store.BeginRead();
                let seen = 0;
                for await (const _ of es.Neighbors(r, EdgeFx.Many, 1n, EdgeDirection.Out))
                {
                    if (++seen === 3)
                    {
                        break;
                    }
                }
                assert.equal(seen, 3);
                r.dispose();
                await store.dispose();
            });
        });
    }
}

after(() => EdgeFx.RemoveDirs());

EdgeFx.Register('memory', async () => new MemoryStore());
EdgeFx.Register('lmdb', () => EdgeFx.OpenLmdb());
