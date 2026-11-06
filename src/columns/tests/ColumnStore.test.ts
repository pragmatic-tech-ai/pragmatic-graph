import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogSnapshot } from '../../catalog/CatalogSnapshot.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import type { MemberDef } from '../../catalog/CatalogTypes.js';
import { FormatKeys } from '../../format/FormatKeys.js';
import type { Location } from '../../identity/Location.js';
import { InternalId } from '../../identity/InternalId.js';
import type { IKeyValueStore, IWriteTransaction } from '../../kv/KeyValue.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { LmdbStore } from '../../kv/lmdb/LmdbStore.js';
import { MemoryStore } from '../../kv/memory/MemoryStore.js';
import { CellValue, DateTimeValue } from '../CellValue.js';
import { ChunkCodec } from '../ChunkCodec.js';
import { ColumnStore } from '../ColumnStore.js';
import { Compactor } from '../Compactor.js';

class ColumnFx
{
    private static readonly DirPrefix = 'pragmatic-graph-columns-';
    private static readonly Dirs: string[] = [];
    public static readonly Type = 5;
    public static readonly NameMember: MemberDef = ColumnFx.Prop(1, 'name', ValueType.String);
    public static readonly AgeMember: MemberDef = ColumnFx.Prop(2, 'age', ValueType.Int64);
    public static readonly SeenMember: MemberDef = ColumnFx.Prop(3, 'seen', ValueType.DateTime);
    public static readonly RelMember: MemberDef = { Id: 4, Name: 'knows', Kind: MemberKind.Relationship, Nullable: true, DeclaredBy: 'P' };
    public static readonly Id = CatalogSnapshot.NodeIdMember;

    public static Prop(id: number, name: string, type: ValueType): MemberDef
    {
        return { Id: id, Name: name, Kind: MemberKind.Property, Type: type, Nullable: true, DeclaredBy: 'P' };
    }

    public static Loc(slot: number, typeId = ColumnFx.Type): Location
    {
        return { Partition: 0, TypeId: typeId, Slot: slot };
    }

    public static async OpenLmdb(): Promise<IKeyValueStore>
    {
        const dir = mkdtempSync(join(tmpdir(), ColumnFx.DirPrefix));
        ColumnFx.Dirs.push(dir);
        return LmdbStore.Open(dir);
    }

    public static RemoveDirs(): void
    {
        for (const d of ColumnFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    /** Runs work in a write txn and flushes the column store's pending deltas before commit, as the committer does. */
    public static Write<T>(store: IKeyValueStore, cs: ColumnStore, work: (txn: IWriteTransaction) => Promise<T>): Promise<T>
    {
        return store.Write(async txn =>
        {
            const result = await work(txn);
            cs.Flush(txn);
            return result;
        });
    }

    public static async Alloc(cs: ColumnStore, txn: IWriteTransaction, count: number, typeId = ColumnFx.Type): Promise<void>
    {
        for (let i = 0; i < count; i++)
        {
            await cs.AllocateSlot(txn, 0, typeId);
        }
    }

    public static async Scan(store: IKeyValueStore, cs: ColumnStore, member: MemberDef, typeId = ColumnFx.Type): Promise<Array<{ Slot: number; Value: CellValue }>>
    {
        const r = await store.BeginRead();
        const out: Array<{ Slot: number; Value: CellValue }> = [];
        for await (const e of cs.ScanColumn(r, 0, typeId, member))
        {
            out.push(e);
        }
        r.dispose();
        return out;
    }

    public static Register(name: string, open: () => Promise<IKeyValueStore>): void
    {
        describe('column store on ' + name, () =>
        {
            it('allocates slots densely from 0 per type, durable across transactions', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                await ColumnFx.Write(store, cs, async txn =>
                {
                    assert.equal(await cs.AllocateSlot(txn, 0, 5), 0);
                    assert.equal(await cs.AllocateSlot(txn, 0, 5), 1);
                    assert.equal(await cs.AllocateSlot(txn, 0, 6), 0);
                });
                await ColumnFx.Write(store, cs, async txn =>
                {
                    assert.equal(await cs.AllocateSlot(txn, 0, 5), 2);
                });
                await store.dispose();
            });

            it('reads the delta value before compaction and the chunk value after, delta key gone', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await ColumnFx.Alloc(cs, txn, 5);
                    await cs.WriteCell(txn, ColumnFx.Loc(3), ColumnFx.NameMember, 'alice');
                    assert.equal(await cs.ReadCell(txn, ColumnFx.Loc(3), ColumnFx.NameMember), 'alice');
                });
                const dKey = FormatKeys.Delta(0, ColumnFx.Type, 1, 0n);
                const cKey = FormatKeys.Column(0, ColumnFx.Type, 1, 0n);
                let r = await store.BeginRead();
                assert.ok((await r.Get(Keyspace.Deltas, dKey)) !== undefined);
                assert.equal(await r.Get(Keyspace.Columns, cKey), undefined);
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(3), ColumnFx.NameMember), 'alice');
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(4), ColumnFx.NameMember), null);
                r.dispose();
                await ColumnFx.Write(store, cs, async txn => new Compactor(cs).CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.NameMember, 0n));
                r = await store.BeginRead();
                assert.equal(await r.Get(Keyspace.Deltas, dKey), undefined);
                assert.ok((await r.Get(Keyspace.Columns, cKey)) !== undefined);
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(3), ColumnFx.NameMember), 'alice');
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(2), ColumnFx.NameMember), null);
                r.dispose();
                await store.dispose();
            });

            it('a delta null overrides a non-null chunk value; a delta value overrides the chunk; later write wins', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                const comp = new Compactor(cs);
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await ColumnFx.Alloc(cs, txn, 2);
                    await cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.NameMember, 'a');
                    await cs.WriteCell(txn, ColumnFx.Loc(1), ColumnFx.NameMember, 'b');
                    await comp.CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.NameMember, 0n);
                });
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.NameMember, null);
                    await cs.WriteCell(txn, ColumnFx.Loc(1), ColumnFx.NameMember, 'b2');
                    await cs.WriteCell(txn, ColumnFx.Loc(1), ColumnFx.NameMember, 'b3');
                });
                let r = await store.BeginRead();
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(0), ColumnFx.NameMember), null);
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(1), ColumnFx.NameMember), 'b3');
                r.dispose();
                await ColumnFx.Write(store, cs, async txn => comp.CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.NameMember, 0n));
                r = await store.BeginRead();
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(0), ColumnFx.NameMember), null);
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(1), ColumnFx.NameMember), 'b3');
                r.dispose();
                await store.dispose();
            });

            it('keeps delta entries sorted by slot with one per slot', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await ColumnFx.Alloc(cs, txn, 10);
                    for (const s of [9, 2, 9, 5])
                    {
                        await cs.WriteCell(txn, ColumnFx.Loc(s), ColumnFx.AgeMember, BigInt(s));
                    }
                });
                const r = await store.BeginRead();
                const raw = (await r.Get(Keyspace.Deltas, FormatKeys.Delta(0, ColumnFx.Type, 2, 0n))) as Uint8Array;
                const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
                const slots: number[] = [];
                for (let at = 0; at < raw.length; at += 2 + 1 + 8)
                {
                    slots.push(dv.getUint16(at, true));
                    assert.equal(raw[at + 2], 1);
                }
                assert.deepEqual(slots, [2, 5, 9]);
                r.dispose();
                await store.dispose();
            });

            it('compaction keeps cells across chunks independent and extends a chunk', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                const comp = new Compactor(cs);
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await ColumnFx.Alloc(cs, txn, 2050);
                    await cs.WriteCell(txn, ColumnFx.Loc(1), ColumnFx.AgeMember, 10n);
                    await cs.WriteCell(txn, ColumnFx.Loc(2049), ColumnFx.AgeMember, 20n);
                    await comp.CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.AgeMember, 0n);
                });
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await cs.WriteCell(txn, ColumnFx.Loc(100), ColumnFx.AgeMember, 11n);
                    await comp.CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.AgeMember, 0n);
                    await comp.CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.AgeMember, 1n);
                });
                const r = await store.BeginRead();
                const chunk = (await r.Get(Keyspace.Columns, FormatKeys.Column(0, ColumnFx.Type, 2, 0n))) as Uint8Array;
                assert.equal(ChunkCodec.ReadCell(ValueType.Int64, chunk, 1), 10n);
                assert.equal(ChunkCodec.ReadCell(ValueType.Int64, chunk, 100), 11n);
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(2049), ColumnFx.AgeMember), 20n);
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(5000), ColumnFx.AgeMember), null);
                r.dispose();
                await store.dispose();
            });

            it('round-trips DateTime cells through delta and chunk', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                const v = new DateTimeValue(123456789n, 'Europe/Kyiv');
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await ColumnFx.Alloc(cs, txn, 8);
                    await cs.WriteCell(txn, ColumnFx.Loc(7), ColumnFx.SeenMember, v);
                });
                let r = await store.BeginRead();
                assert.ok(((await cs.ReadCell(r, ColumnFx.Loc(7), ColumnFx.SeenMember)) as DateTimeValue).Equals(v));
                r.dispose();
                await ColumnFx.Write(store, cs, async txn => new Compactor(cs).CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.SeenMember, 0n));
                r = await store.BeginRead();
                assert.ok(((await cs.ReadCell(r, ColumnFx.Loc(7), ColumnFx.SeenMember)) as DateTimeValue).Equals(v));
                r.dispose();
                await store.dispose();
            });

            it('compacting a chunk with no delta is a no-op', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                await ColumnFx.Write(store, cs, async txn => new Compactor(cs).CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.NameMember, 0n));
                const r = await store.BeginRead();
                assert.equal(await r.Get(Keyspace.Columns, FormatKeys.Column(0, ColumnFx.Type, 1, 0n)), undefined);
                r.dispose();
                await store.dispose();
            });

            it('ScanColumn yields live slots in order with deltas applied, skipping null node ids', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                const comp = new Compactor(cs);
                await ColumnFx.Write(store, cs, async txn =>
                {
                    for (let i = 0; i < 5; i++)
                    {
                        const slot = await cs.AllocateSlot(txn, 0, ColumnFx.Type);
                        await cs.WriteCell(txn, ColumnFx.Loc(slot), ColumnFx.Id, BigInt(100 + slot));
                        await cs.WriteCell(txn, ColumnFx.Loc(slot), ColumnFx.NameMember, 'n' + slot);
                    }
                    await comp.CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.Id, 0n);
                    await comp.CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.NameMember, 0n);
                });
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await cs.WriteCell(txn, ColumnFx.Loc(1), ColumnFx.Id, null);
                    await cs.WriteCell(txn, ColumnFx.Loc(3), ColumnFx.NameMember, 'changed');
                });
                const names = await ColumnFx.Scan(store, cs, ColumnFx.NameMember);
                assert.deepEqual(names, [
                    { Slot: 0, Value: 'n0' },
                    { Slot: 2, Value: 'n2' },
                    { Slot: 3, Value: 'changed' },
                    { Slot: 4, Value: 'n4' },
                ]);
                const ids = await ColumnFx.Scan(store, cs, ColumnFx.Id);
                assert.deepEqual(ids.map(e => e.Slot), [0, 2, 3, 4]);
                await store.dispose();
            });

            it('ScanColumn handles zero slots, a partial last chunk and never-written chunks', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                assert.deepEqual(await ColumnFx.Scan(store, cs, ColumnFx.NameMember, 99), []);
                await ColumnFx.Write(store, cs, async txn =>
                {
                    for (let i = 0; i < 2050; i++)
                    {
                        await cs.AllocateSlot(txn, 0, ColumnFx.Type);
                    }
                    for (const slot of [0, 2046, 2048, 2049])
                    {
                        await cs.WriteCell(txn, ColumnFx.Loc(slot), ColumnFx.Id, BigInt(slot + 1));
                    }
                    await cs.WriteCell(txn, ColumnFx.Loc(2049), ColumnFx.NameMember, 'last');
                    await new Compactor(cs).CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.Id, 0n);
                });
                const names = await ColumnFx.Scan(store, cs, ColumnFx.NameMember);
                assert.deepEqual(names, [
                    { Slot: 0, Value: null },
                    { Slot: 2046, Value: null },
                    { Slot: 2048, Value: null },
                    { Slot: 2049, Value: 'last' },
                ]);
                const ids = await ColumnFx.Scan(store, cs, ColumnFx.Id);
                assert.deepEqual(ids.map(e => e.Slot), [0, 2046, 2048, 2049]);
                await store.dispose();
            });

            it('rejects relationship members, type mismatches and bad partitions', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await ColumnFx.Alloc(cs, txn, 1);
                    await assert.rejects(cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.RelMember, 1n));
                    await assert.rejects(cs.ReadCell(txn, ColumnFx.Loc(0), ColumnFx.RelMember));
                    await assert.rejects(cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.NameMember, 5n));
                    await assert.rejects(cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.AgeMember, 'x'));
                    await assert.rejects(cs.WriteCell(txn, { Partition: 1, TypeId: 5, Slot: 0 }, ColumnFx.NameMember, 'x'));
                    await assert.rejects(cs.AllocateSlot(txn, 1, 5));
                });
                await store.dispose();
            });

            it('rolls back slot allocation and cell writes with the transaction', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                await assert.rejects(ColumnFx.Write(store, cs, async txn =>
                {
                    await cs.AllocateSlot(txn, 0, 5);
                    await cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.NameMember, 'x');
                    cs.Flush(txn);
                    throw new Error('boom');
                }));
                await ColumnFx.Write(store, cs, async txn =>
                {
                    assert.equal(await cs.AllocateSlot(txn, 0, 5), 0);
                    assert.equal(await cs.ReadCell(txn, ColumnFx.Loc(0), ColumnFx.NameMember), null);
                });
                await store.dispose();
            });

            it('2,048 writes into one delta in one txn are fast (Int64 and String), and every value survives', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                await ColumnFx.Write(store, cs, async txn => ColumnFx.Alloc(cs, txn, 2048));
                const t0 = performance.now();
                await ColumnFx.Write(store, cs, async txn =>
                {
                    for (let i = 2047; i >= 0; i--)
                    {
                        await cs.WriteCell(txn, ColumnFx.Loc(i), ColumnFx.AgeMember, BigInt(i));
                        await cs.WriteCell(txn, ColumnFx.Loc(i), ColumnFx.NameMember, 'name-' + i);
                    }
                });
                const writeMs = performance.now() - t0;
                const r = await store.BeginRead();
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(2000), ColumnFx.NameMember), 'name-2000');
                const t1 = performance.now();
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(1500), ColumnFx.NameMember), 'name-1500');
                const readMs = performance.now() - t1;
                for (const i of [0, 777, 2047])
                {
                    assert.equal(await cs.ReadCell(r, ColumnFx.Loc(i), ColumnFx.AgeMember), BigInt(i));
                }
                r.dispose();
                console.log('[timing ' + name + '] 4096 writes (2048 Int64 + 2048 String): ' + writeMs.toFixed(0) + ' ms; ReadCell vs 2048-entry String delta: ' + readMs.toFixed(2) + ' ms');
                assert.ok(writeMs < 2000, 'writes took ' + writeMs);
                assert.ok(readMs < 25, 'read took ' + readMs);
                await store.dispose();
            });

            it('a same-txn write then compact through the shared cache loses nothing; same-txn reads and scans see pending writes', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                const comp = new Compactor(cs);
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await ColumnFx.Alloc(cs, txn, 4);
                    await cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.Id, 1n);
                    await cs.WriteCell(txn, ColumnFx.Loc(1), ColumnFx.Id, 2n);
                    await cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.NameMember, 'a');
                    await cs.WriteCell(txn, ColumnFx.Loc(1), ColumnFx.NameMember, 'b');
                    assert.equal(await cs.ReadCell(txn, ColumnFx.Loc(1), ColumnFx.NameMember), 'b');
                    const seen: CellValue[] = [];
                    for await (const e of cs.ScanColumn(txn, 0, ColumnFx.Type, ColumnFx.NameMember))
                    {
                        seen.push(e.Value);
                    }
                    assert.deepEqual(seen, ['a', 'b']);
                    await comp.CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.NameMember, 0n);
                    await cs.WriteCell(txn, ColumnFx.Loc(2), ColumnFx.NameMember, 'c');
                    assert.equal(await cs.ReadCell(txn, ColumnFx.Loc(0), ColumnFx.NameMember), 'a');
                });
                const r = await store.BeginRead();
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(0), ColumnFx.NameMember), 'a');
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(1), ColumnFx.NameMember), 'b');
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(2), ColumnFx.NameMember), 'c');
                r.dispose();
                await store.dispose();
            });

            it('Flush is what persists pending deltas', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                await store.Write(async txn =>
                {
                    await ColumnFx.Alloc(cs, txn, 1);
                    await cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.NameMember, 'x');
                });
                const r = await store.BeginRead();
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(0), ColumnFx.NameMember), null);
                r.dispose();
                await store.dispose();
            });

            it('enforces nullability except for member 0, and rejects never-allocated slots', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                const required: MemberDef = { ...ColumnFx.NameMember, Id: 9, Nullable: false };
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await ColumnFx.Alloc(cs, txn, 2);
                    await assert.rejects(cs.WriteCell(txn, ColumnFx.Loc(0), required, null));
                    await cs.WriteCell(txn, ColumnFx.Loc(0), required, 'ok');
                    await cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.Id, 7n);
                    await cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.Id, null);
                    await assert.rejects(cs.WriteCell(txn, ColumnFx.Loc(2), ColumnFx.NameMember, 'x'), RangeError);
                    await assert.rejects(cs.WriteCell(txn, ColumnFx.Loc(0, 77), ColumnFx.NameMember, 'x'), RangeError);
                });
                await store.dispose();
            });

            it('stores the largest internal id (2^63-1) in the node-id column', async () =>
            {
                const store = await open();
                const cs = new ColumnStore();
                await ColumnFx.Write(store, cs, async txn =>
                {
                    await ColumnFx.Alloc(cs, txn, 1);
                    await cs.WriteCell(txn, ColumnFx.Loc(0), ColumnFx.Id, InternalId.Max);
                });
                await ColumnFx.Write(store, cs, async txn => new Compactor(cs).CompactChunk(txn, 0, ColumnFx.Type, ColumnFx.Id, 0n));
                const r = await store.BeginRead();
                assert.equal(await cs.ReadCell(r, ColumnFx.Loc(0), ColumnFx.Id), (1n << 63n) - 1n);
                r.dispose();
                await store.dispose();
            });
        });
    }
}

after(() => ColumnFx.RemoveDirs());

ColumnFx.Register('memory', async () => new MemoryStore());
ColumnFx.Register('lmdb', () => ColumnFx.OpenLmdb());
