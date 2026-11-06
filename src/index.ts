// Public embedding API of @pragmatic-tech-ai/graph. Storage internals (KV stores, column and edge
// stores, identity indexes, the committer) are deliberately not exported.

export { GraphStore } from './GraphStore.js';
export { GraphReader, type IScanRow } from './GraphReader.js';
export { GraphTransaction } from './GraphTransaction.js';

// Schema definition.
export { CatalogModel, type IConceptOptions, type MemberDef, type MemberInput, type TypeDefinition } from './catalog/CatalogModel.js';
export type { CatalogSnapshot } from './catalog/CatalogSnapshot.js';
export { MemberKind, Placement, ValueType } from './catalog/ValueType.js';

// Values and directions.
export { DateTimeValue, DateValue, DurationValue, type CellValue } from './columns/CellValue.js';
export { EdgeDirection } from './format/FormatKeys.js';

// Commits and change notification.
export { WriteBatch, WriteOp, type BatchOp, type ICreateNodeOp, type IDeleteNodeOp, type ILinkOp, type ISetPropertyOp, type IUnlinkOp, type LinkOptions } from './txn/WriteBatch.js';
export type { ICommitApplied } from './txn/Committer.js';
export type { ISignal, ISubscription } from './txn/Signal.js';

// Errors: every error the engine raises on purpose is a GraphError with a GraphErrorCode (ruling F8).
export { GraphError, GraphErrorCode } from './errors/GraphError.js';
export { ConflictError } from './txn/ConflictError.js';
export { CommitError, CommitErrorCode } from './txn/CommitError.js';
export { CatalogError, CatalogErrorCode } from './catalog/CatalogError.js';
export { EdgeError, EdgeErrorCode } from './edges/EdgeError.js';
export { PublicIdTooLongError } from './identity/PublicIdIndex.js';
export { FormatVersionMismatchError } from './format/FormatMeta.js';

export class EngineInfo
{
    public static readonly FormatVersion = 1;
}
