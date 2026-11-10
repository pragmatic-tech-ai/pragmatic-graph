import { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { CatalogStore } from '../catalog/CatalogStore.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { WriteBatch, WriteOp } from './WriteBatch.js';

/** What a commit did: applied a write batch, extended the schema, or upgraded it to a description. */
export enum CommitKind
{
    Batch = 1,
    SchemaChange = 2,
    /** A schema upgrade (GraphStore.Upgrade): a new catalog plus the discard of data that no longer fits. */
    Upgrade = 3,
}

/**
 * One applied commit, as raised by CommitApplied and replayed by GraphStore.ReadChanges (ruling F4):
 * self-sufficient for deterministic replay.
 */
export interface ICommitApplied
{
    readonly Commit: bigint;
    readonly Kind: CommitKind;
    /**
     * Batch: the catalog version the batch was validated and applied against. SchemaChange, Upgrade: the resulting
     * version.
     */
    readonly CatalogVersion: number;
    /** The sealed, immutable batch; empty for a schema change or upgrade. */
    readonly Batch: WriteBatch;
    /**
     * The internal ids allocated for the batch's CreateNode ops, in op order (empty for a schema change or upgrade).
     */
    readonly CreatedIds: readonly bigint[];
    /** SchemaChange and Upgrade: the complete catalog after the change. */
    readonly Catalog?: CatalogSnapshot;
    /**
     * Upgrade only: the description's opaque version. Replaying an Upgrade installs Catalog; the data it
     * discarded follows from the previous catalog and Catalog (DataPurger), so it is not listed.
     */
    readonly SchemaVersion?: string;
}

/**
 * Log entry value codec (docs/format/on-disk-format.md, Log). All integers little-endian:
 *
 *   Batch:        kind u8 = 1, catalogVersion u32, idCount u32, ids idCount x u64, then the serialized WriteBatch
 *   SchemaChange: kind u8 = 2, catalogVersion u32 (resulting), then the catalog root JSON (UTF-8)
 *   Upgrade:      kind u8 = 3, catalogVersion u32 (resulting), versionLength u32, version UTF-8, then the catalog root
 * JSON
 */
export class LogEntry
{
    private static readonly HeaderBytes = 5;
    private static readonly U32Bytes = 4;
    private static readonly U64Bytes = 8;
    private static readonly MaxU32 = 0xffffffff;
    private static readonly ErrTruncated = 'Corrupt log entry: truncated';
    private static readonly ErrKind = 'Corrupt log entry: unknown kind ';
    private static readonly ErrIds = 'Corrupt log entry: created id count does not match the CreateNode ops';
    private static readonly ErrZeroId = 'Corrupt log entry: created id 0';
    private static readonly ErrVersion = 'Catalog version out of u32 range: ';
    private static readonly ErrSchemaVersion = 'Corrupt log entry: schema version is not valid UTF-8';
    private static readonly EmptyBatch = new WriteBatch().Seal();
    private static readonly Encoder = new TextEncoder();
    private static readonly Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

    public static EncodeBatch(catalogVersion: number, createdIds: readonly bigint[], batchBytes: Uint8Array): Uint8Array
    {
        const idsAt = LogEntry.HeaderBytes + LogEntry.U32Bytes;
        const out = new Uint8Array(idsAt + createdIds.length * LogEntry.U64Bytes + batchBytes.length);
        const view = new DataView(out.buffer);
        LogEntry.Header(view, CommitKind.Batch, catalogVersion);
        view.setUint32(LogEntry.HeaderBytes, createdIds.length, true);
        createdIds.forEach((id, i) => view.setBigUint64(idsAt + i * LogEntry.U64Bytes, id, true));
        out.set(batchBytes, idsAt + createdIds.length * LogEntry.U64Bytes);
        return out;
    }

    public static EncodeSchema(catalog: CatalogSnapshot): Uint8Array
    {
        const json = CatalogStore.Serialize(catalog);
        const out = new Uint8Array(LogEntry.HeaderBytes + json.length);
        LogEntry.Header(new DataView(out.buffer), CommitKind.SchemaChange, catalog.Version);
        out.set(json, LogEntry.HeaderBytes);
        return out;
    }

    /** `schemaVersion` must be well-formed (no lone surrogates) so its UTF-8 round-trips exactly. */
    public static EncodeUpgrade(catalog: CatalogSnapshot, schemaVersion: string): Uint8Array
    {
        const version = LogEntry.Encoder.encode(schemaVersion);
        const json = CatalogStore.Serialize(catalog);
        const versionAt = LogEntry.HeaderBytes + LogEntry.U32Bytes;
        const out = new Uint8Array(versionAt + version.length + json.length);
        const view = new DataView(out.buffer);
        LogEntry.Header(view, CommitKind.Upgrade, catalog.Version);
        view.setUint32(LogEntry.HeaderBytes, version.length, true);
        out.set(version, versionAt);
        out.set(json, versionAt + version.length);
        return out;
    }

    /** Parses an entry; any malformed input is a GraphError Corrupt. */
    public static Decode(commit: bigint, bytes: Uint8Array): ICommitApplied
    {
        if (bytes.length < LogEntry.HeaderBytes)
        {
            throw LogEntry.Corrupt(LogEntry.ErrTruncated);
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const kind = view.getUint8(0);
        const version = view.getUint32(1, true);
        if (kind === CommitKind.SchemaChange)
        {
            const catalog = LogEntry.DecodeCatalog(version, bytes.subarray(LogEntry.HeaderBytes));
            return Object.freeze({ Commit: commit, Kind: CommitKind.SchemaChange, CatalogVersion: version, Batch: LogEntry.EmptyBatch, CreatedIds: Object.freeze([]), Catalog: catalog });
        }
        if (kind === CommitKind.Upgrade)
        {
            return LogEntry.DecodeUpgrade(commit, version, view, bytes);
        }
        if (kind !== CommitKind.Batch)
        {
            throw LogEntry.Corrupt(LogEntry.ErrKind + kind);
        }
        if (bytes.length < LogEntry.HeaderBytes + LogEntry.U32Bytes)
        {
            throw LogEntry.Corrupt(LogEntry.ErrTruncated);
        }
        const count = view.getUint32(LogEntry.HeaderBytes, true);
        const idsAt = LogEntry.HeaderBytes + LogEntry.U32Bytes;
        const batchAt = idsAt + count * LogEntry.U64Bytes;
        if (batchAt > bytes.length)
        {
            throw LogEntry.Corrupt(LogEntry.ErrTruncated);
        }
        const ids: bigint[] = [];
        for (let i = 0; i < count; i++)
        {
            const id = view.getBigUint64(idsAt + i * LogEntry.U64Bytes, true);
            if (id === 0n)
            {
                throw LogEntry.Corrupt(LogEntry.ErrZeroId);
            }
            ids.push(id);
        }
        let batch: WriteBatch;
        try
        {
            batch = WriteBatch.Deserialize(bytes.subarray(batchAt)).Seal();
        }
        catch (error)
        {
            throw new GraphError(GraphErrorCode.Corrupt, String(error), error);
        }
        if (batch.Ops().filter(op => WriteBatch.TakesId(op)).length !== count)
        {
            throw LogEntry.Corrupt(LogEntry.ErrIds);
        }
        return Object.freeze({ Commit: commit, Kind: CommitKind.Batch, CatalogVersion: version, Batch: batch, CreatedIds: Object.freeze(ids) });
    }

    private static DecodeUpgrade(commit: bigint, version: number, view: DataView, bytes: Uint8Array): ICommitApplied
    {
        const versionAt = LogEntry.HeaderBytes + LogEntry.U32Bytes;
        if (bytes.length < versionAt)
        {
            throw LogEntry.Corrupt(LogEntry.ErrTruncated);
        }
        const length = view.getUint32(LogEntry.HeaderBytes, true);
        if (versionAt + length > bytes.length)
        {
            throw LogEntry.Corrupt(LogEntry.ErrTruncated);
        }
        let schemaVersion: string;
        try
        {
            schemaVersion = LogEntry.Decoder.decode(bytes.subarray(versionAt, versionAt + length));
        }
        catch (error)
        {
            throw new GraphError(GraphErrorCode.Corrupt, LogEntry.ErrSchemaVersion, error);
        }
        const catalog = LogEntry.DecodeCatalog(version, bytes.subarray(versionAt + length));
        return Object.freeze({ Commit: commit, Kind: CommitKind.Upgrade, CatalogVersion: version, Batch: LogEntry.EmptyBatch, CreatedIds: Object.freeze([]), Catalog: catalog, SchemaVersion: schemaVersion });
    }

    private static DecodeCatalog(version: number, json: Uint8Array): CatalogSnapshot
    {
        try
        {
            return CatalogStore.Decode(version, json);
        }
        catch (error)
        {
            throw new GraphError(GraphErrorCode.Corrupt, String(error), error);
        }
    }

    private static Header(view: DataView, kind: CommitKind, version: number): void
    {
        if (!Number.isInteger(version) || version < 0 || version > LogEntry.MaxU32)
        {
            throw new GraphError(GraphErrorCode.Internal, LogEntry.ErrVersion + version);
        }
        view.setUint8(0, kind);
        view.setUint32(1, version, true);
    }

    private static Corrupt(message: string): GraphError
    {
        return new GraphError(GraphErrorCode.Corrupt, message);
    }
}
