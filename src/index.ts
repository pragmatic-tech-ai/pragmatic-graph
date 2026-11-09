// Public embedding API of @pragmatic-tech-ai/graph. Storage internals (KV stores, column and edge
// stores, identity indexes, the committer) are deliberately not exported.

// The engine facade: the single entry point hosts use (spec §4.2, §9).
export { GraphEngine, StorageKind, type IEngineStorage, type IGraphEngineOptions } from './GraphEngine.js';

// The low-level store underneath the facade.
export { GraphStore } from './GraphStore.js';
export type { ILmdbOptions } from './kv/lmdb/LmdbStore.js';
export { GraphReader, type ILinkView, type INodeView, type IReadProbe, type IScanRow } from './GraphReader.js';
export type { IIndexBound, IIndexRange } from './indexes/IndexKey.js';
export { GraphTransaction } from './GraphTransaction.js';
export { AccessDefault, AccessScope, type IAccessScopeOptions, type IReadOnlyMembers, type IWriteRules } from './access/AccessScope.js';

// Schema definition.
export { CatalogModel, type IConceptOptions, type IndexDef, type MemberDef, type MemberInput, type TypeDefinition } from './catalog/CatalogModel.js';
export type { CatalogSnapshot } from './catalog/CatalogSnapshot.js';
export { MemberKind, Placement, ValueType } from './catalog/ValueType.js';

// Values and directions.
export { DateTimeValue, DateValue, DurationValue, type CellValue } from './columns/CellValue.js';
export { EdgeDirection } from './format/FormatKeys.js';

// Commits and change notification.
export { WriteBatch, WriteOp, type BatchOp, type ICreateNodeOp, type ICreateNodeOptions, type IDeleteNodeOp, type IDeleteNodeOptions, type ILinkOp, type ISetOwnerOp, type ISetPropertyOp, type IUnlinkOp, type LinkOptions } from './txn/WriteBatch.js';
export { CommitKind, type ICommitApplied } from './txn/LogEntry.js';
export type { IUpgradeCommit } from './txn/Committer.js';
export type { ISignal, ISubscription } from './txn/Signal.js';

// Errors: every error the engine raises on purpose is a GraphError with a GraphErrorCode (ruling F8).
export { GraphError, GraphErrorCode } from './errors/GraphError.js';
export { ConflictError } from './txn/ConflictError.js';
export { AccessError, AccessErrorCode } from './access/AccessError.js';
export { CommitError, CommitErrorCode } from './txn/CommitError.js';
export { CatalogError, CatalogErrorCode } from './catalog/CatalogError.js';
export { EdgeError, EdgeErrorCode } from './edges/EdgeError.js';
export { PublicIdTooLongError } from './identity/PublicIdIndex.js';
export { FormatVersionMismatchError } from './format/FormatMeta.js';

// Connectors: bindings and the write-through contract (spec §5, ruling R72).
export type { IConnectorTransaction, IGraphConnector } from './connectors/GraphConnector.js';
export { ConnectorChangeSet, type ConnectorChange } from './connectors/ConnectorChangeSet.js';
export { BindingTable } from './connectors/BindingTable.js';
export { ConnectorError, ConnectorPhase } from './connectors/ConnectorError.js';

// Predicate language and node-local evaluation.
export { And, Compare, CompareOp, ConceptIs, FalsePredicate, IdIn, In, IsNull, Not, Or, OwnerIs, Predicate, PredicateKind, Reachable, Related, Seeded, TruePredicate, type IPathStep } from './predicate/Predicate.js';
export { PredicateCodec } from './predicate/PredicateCodec.js';
export { PredicateError, PredicateErrorCode } from './predicate/PredicateError.js';
export { NodeEvaluator } from './predicate/NodeEvaluator.js';

// Schema description and catalog planning.
export type { IBindingDescription, IDefinitionDescription, IIndexDescription, ISchemaDescription, ISeedLink, ISeedNode } from './schema/SchemaDescription.js';
export { CatalogPlanner, type ICatalogPlan } from './schema/CatalogPlanner.js';
export { CatalogDiff, type IRemovedMember } from './schema/CatalogDiff.js';

// Cypher over the engine (plan 2): parse, plan and run queries under an access scope.
export * as Cypher from './cypher/index.js';

export class EngineInfo
{
    public static readonly FormatVersion = 1;
}
