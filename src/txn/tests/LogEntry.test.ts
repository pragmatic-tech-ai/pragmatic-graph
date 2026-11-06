import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogModel } from '../../catalog/CatalogModel.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { CommitKind, LogEntry } from '../LogEntry.js';
import { WriteBatch } from '../WriteBatch.js';

class LogEntryFx
{
    public static Corrupt(error: unknown): boolean
    {
        return error instanceof GraphError && error.GraphCode === GraphErrorCode.Corrupt;
    }
}

describe('LogEntry (F4)', () =>
{
    it('round-trips a batch with its catalog version and created ids, and a schema change with its catalog', () =>
    {
        const batch = new WriteBatch();
        batch.CreateNode('a', 'T');
        batch.SetProperty('a', 'x', 1n);
        batch.CreateNode('b', 'T', { ClusterHint: 'hint' });
        const bytes = LogEntry.EncodeBatch(7, [5n, 4097n], batch.Serialize());
        assert.deepEqual([...bytes.subarray(0, 5)], [1, 7, 0, 0, 0]);
        const decoded = LogEntry.Decode(3n, bytes);
        assert.equal(decoded.Kind, CommitKind.Batch);
        assert.equal(decoded.Commit, 3n);
        assert.equal(decoded.CatalogVersion, 7);
        assert.deepEqual(decoded.CreatedIds, [5n, 4097n]);
        assert.deepEqual(decoded.Batch.Ops(), batch.Ops());
        assert.ok(decoded.Batch.IsSealed);

        const m = new CatalogModel();
        m.DefineConcept('T', null, [], [{ Name: 'x', Kind: MemberKind.Property, Type: ValueType.Int64 }]);
        const catalog = m.Seal();
        const schema = LogEntry.Decode(4n, LogEntry.EncodeSchema(catalog));
        assert.equal(schema.Kind, CommitKind.SchemaChange);
        assert.equal(schema.CatalogVersion, 1);
        assert.deepEqual(schema.CreatedIds, []);
        assert.equal(schema.Batch.Count, 0);
        assert.deepEqual(schema.Catalog?.Definitions(), catalog.Definitions());
    });

    it('rejects corrupt entries: unknown kind, truncation, id count mismatch, id 0, bad batch or catalog', () =>
    {
        const batch = new WriteBatch();
        batch.CreateNode('a', 'T');
        const good = LogEntry.EncodeBatch(1, [9n], batch.Serialize());
        const unknown = good.slice();
        unknown[0] = 4;
        assert.throws(() => LogEntry.Decode(1n, unknown), LogEntryFx.Corrupt);
        assert.throws(() => LogEntry.Decode(1n, good.subarray(0, 7)), LogEntryFx.Corrupt);
        assert.throws(() => LogEntry.Decode(1n, LogEntry.EncodeBatch(1, [], batch.Serialize())), LogEntryFx.Corrupt);
        assert.throws(() => LogEntry.Decode(1n, LogEntry.EncodeBatch(1, [0n], batch.Serialize())), LogEntryFx.Corrupt);
        assert.throws(() => LogEntry.Decode(1n, LogEntry.EncodeBatch(1, [], Uint8Array.of(9))), LogEntryFx.Corrupt);
        assert.throws(() => LogEntry.Decode(1n, Uint8Array.of(2, 1, 0, 0, 0, 0x7b)), LogEntryFx.Corrupt);
    });

    it('round-trips an upgrade with its schema version and catalog', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('T', null, [], [{ Name: 'x', Kind: MemberKind.Property, Type: ValueType.Int64 }]);
        const catalog = m.Seal();
        const bytes = LogEntry.EncodeUpgrade(catalog, 'hé');
        assert.deepEqual([...bytes.subarray(0, 12)], [3, 1, 0, 0, 0, 3, 0, 0, 0, 0x68, 0xc3, 0xa9]);
        const decoded = LogEntry.Decode(5n, bytes);
        assert.equal(decoded.Kind, CommitKind.Upgrade);
        assert.equal(decoded.Commit, 5n);
        assert.equal(decoded.CatalogVersion, 1);
        assert.equal(decoded.SchemaVersion, 'hé');
        assert.deepEqual(decoded.CreatedIds, []);
        assert.equal(decoded.Batch.Count, 0);
        assert.deepEqual(decoded.Catalog?.Definitions(), catalog.Definitions());
        assert.equal(LogEntry.Decode(6n, LogEntry.EncodeUpgrade(catalog, '')).SchemaVersion, '');
        assert.equal(LogEntry.Decode(6n, LogEntry.EncodeSchema(catalog)).SchemaVersion, undefined);
    });

    it('rejects corrupt upgrade entries: truncated length or version, invalid UTF-8, bad catalog', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('T', null, [], []);
        const good = LogEntry.EncodeUpgrade(m.Seal(), 'v1');
        assert.throws(() => LogEntry.Decode(1n, good.subarray(0, 8)), LogEntryFx.Corrupt);
        assert.throws(() => LogEntry.Decode(1n, good.subarray(0, 10)), LogEntryFx.Corrupt);
        const long = good.slice();
        long[5] = 0xff;
        assert.throws(() => LogEntry.Decode(1n, long), LogEntryFx.Corrupt);
        const badUtf8 = good.slice();
        badUtf8[9] = 0xff;
        assert.throws(() => LogEntry.Decode(1n, badUtf8), LogEntryFx.Corrupt);
        assert.throws(() => LogEntry.Decode(1n, Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0, 0x7b)), LogEntryFx.Corrupt);
    });
});
