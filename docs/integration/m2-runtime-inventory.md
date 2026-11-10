# Milestone 2 runtime inventory (2026-11-10)

Snapshot of the runtime-side code milestone 2 re-bases or retires. Gathered by reading code at
pragmatic-server master @dcc34ce6, TODL main @41f283e7, todl-connectors-host, pragmatic-protocol.
Decisions that frame it: spec §11.1 (env graph = Dataverse; promote + deploy feed one catalog; runtime
compiles nothing; ungoverned app-private concepts keep the policy-only bypass; shares are graph data).

## Already retired by milestone 1
TenantGraphCache, ModelShardCache, PrincipalDraftGraphMask, AuthorizingCypherWriter, ModelDraftWriter,
ModelDraftBaker, AllowedIds, TenantGraphComposition.

## Runtime endpoints today (pragmatic-server `src/host/server-connection-handler.ts`, `src/pragmatic-server.ts`)
- `cypher/query` runtime branch (`RunCypherQuery`): refuses `modelId`; graph = `RequireBoundAppGraph`
  (app bound via `application/open`) or `RequireEnvironmentGraph`; cursor fingerprint = GraphRevision +
  `GraphDataDigest`; runs TODL `Cypher.CypherEngine.OverQuery(graph)`. Remote-flavour generated apps
  (TODL html-bundle `emit-remote-data-action.ts`) page `MATCH (n) RETURN n` and assemble documents with
  `TenantDocumentAssembler` (TODL `Cypher.CypherCellCodec`, browser side).
- App graph (`GraphForPragmaticApp`): memoised `AppBase` (`RuntimeAppGraph.BuildDomain` →
  `AppConnectorPlan.For` → `new GraphQuery(domain.Snapshot)` → `BuiltinBindings.Augment`) →
  `ConnectorPrefetch.ForConcepts` (fresh per query, push-down via `Cypher.CypherPushDown` + policy
  `QueryFilterProvider`) → `ConnectorRuntimeGraphQuery` → `FilteredGraphQuery(ShareWidening?(Composite[
  policy, ConceptBypass(depth)]))` → `FieldMaskedGraphQuery`.
- Environment graph (`EnvironmentGraphQuery`, `host/graphs/environment-graph.ts`): `graph/load` stores
  packages (`GraphPackageIngest`), builds `EnvironmentGraph`, saves `graphs/loaded-graph.json`;
  `EnvironmentGraphOverlay` prefetches every bound concept; NO filter, mask or push-down (audit defect 4).
- `data/write` (`WriteForPragmaticApp` → `RuntimeAppWriter`): per op binding lookup + coarse
  `authorizer.Allows` + `binding.Writable`; creates: `StampCreateDefaults`, `RuntimeWritePayloadValidator`,
  `gate.Authorize`; update/delete: `gate.AuthorizeById` via `FilteredReadWriteTargetSource`; field checks
  `gate.CanWriteField`; grouped `adapter.Apply(WriteBatch)`; builtin create id = randomUUID;
  `RevokeSharesForDeletedRecords`.
- `data/share|unshare|shares/list` (`ShareService`), `data/assign` (`AssignService`).
- `connector/*` (`host/connector-service.ts`, per connection over `server.Connectors()` = `ConnectorRuntime`
  from the ACTIVE SOLUTION's Repository): dev-only in practice (runtime tenants have no solution).
  `Read` (whole-model prepare, depth filter, offset slice), `ReadPage` (`ConnectorPageReader`, adapter
  `QueryPage` keyset), `WritePaged` (`ConnectorHydrateWriter`), `WriteBack` (`FederatedModelDataConnector`
  working copy flush — NO per-row authorization, audit defect 2).
- `model/view`, `model/resources` runtime branch: `ProjectModelView` / `ModelReadFilter` over the active
  solution Repository — vestigial for runtime tenants; no depth filter (audit defect 3).
- No runtime data-changed push exists (only `solution/graphChanged`, `solution/buildStateChanged`).
- Wire DTOs: pragmatic-protocol `src/dto/wire-dtos.ts` (`CypherQueryParams/PageDto`, `CypherCellDto` with
  `$node`/`$map`, `AppWriteParams/ResultDto` statuses applied|conflict|denied|invalid|failed,
  Share/Unshare/ListShares/Assign params, `GraphLoadParamsDto/GraphLoadedDto`, `ConnectorReadParams`,
  `Page<EntityDto>`, `ConnectorPagedWriteParams`, `ConnectorWriteBackParams`, `FlushOutcomeDto`,
  `ModelViewParams/PageDto`).

## §10 retirement candidates still present
| Item | Where | Importers |
|---|---|---|
| `GraphQuery` / `IGraphQuery` | TODL `src/graph-api/graph-query*.ts` | server runtime-app-graph, environment-graph, pragmatic-server, handler, filtered/field-masked queries, graph-data-digest, runtime-app-writer, builtin-bindings, filtered-read-write-target-source; TODL cypher/{engine,graph,push-down}, domain-host `Query()`, model-data-source, reflection-client snapshot-reader |
| `ConnectorRuntimeGraphQuery` | TODL `graph-api/connector-runtime-graph-query.ts` | environment-graph, pragmatic-server; TODL index export |
| `ConnectorPrefetch` | TODL `model-data/connector-prefetch.ts` | environment-graph, pragmatic-server |
| `EnvironmentGraphOverlay` (+ `EnvironmentGraph`, `LoadedGraphStore`) | server `host/graphs/environment-graph.ts` | pragmatic-server |
| `FilteredGraphQuery` | server `host/cypher/filtered-graph-query.ts` | pragmatic-server |
| `FieldMaskedGraphQuery` (file also holds widely used `IFieldReadMask`, `AllowAllFieldReadMask`, `MaskedMirror`) | server `host/cypher/field-masked-graph-query.ts` | pragmatic-server |
| `ModelReadFilter` | server `host/model-read-filter.ts` | handler `ResourceHidden` |
| `GraphDataDigest` | server `host/paging/graph-data-digest.ts` | handler `RunCypherQuery` |
| `StorageDocumentSession`, `SqliteDocumentSession` | server `host/connectors/*` | `platform/node-platform.ts CreateAppDataStore` |
| per-connection `ConnectorRuntime` | TODL `connectors/connector-runtime.ts` | server connector-service, page reader, keyed write target, `Connectors()` |
| `ModelDataSource` / typed read clients | TODL `model-data/model-data-source.ts`, generic, model-registry, `codegen/read-client.ts` | server ConnectorRuntime; TODL application bootstrap, browser VMs, reflected-repository, generators; Plexus generated `model.ts` |
| TODL `src/cypher/` (~6.9k lines, 37 files) + `ICypherWriter`, `WriteOverlay` | TODL | server handler (parser, ReferencedLabels, OverQuery/ToDto, Deadline, errors), pragmatic-server (CypherPushDown, GraphQuerySchema, ParameterValue), cypher-result-mapper (CypherCellCodec, CypherResultDto), param converter, execute-result-mapper (CypherWriteStatsDto), graph-data-digest (GraphQueryAdapter); TODL engine-bridge EngineCellMapper (type-only DTO imports), browser tenant-document-assembler (CypherCellCodec, runtime), index `export * as Cypher` |

## Connector adapter framework (TODL `src/model-data/`, todl-connectors-host)
- `IDataSourceAdapter { Query(QueryRequest): Promise<ExternalRecord[]>; Apply(WriteBatch): Promise<WriteResult>;
  Dispose(); CanTransact?; CanVersion?; CanPage?; QueryPage(request, {After?, Limit}) → {Records, NextAfter?};
  SourceManagesVersions?; ClassifyFailure? }`.
- `QueryRequest { Source, Fields[], Where?: { All: QueryComparison[] }, OrderKey? }` — ops eq, neq, lt, lte, gt,
  gte, in, isNull, isNotNull (SQL null semantics); conjunction only.
- `WriteBatch { Source, IdKey, Operations[{Kind: Upsert|Delete, Key, Fields, Version?}], Concurrency:
  LastWriteWins|Optimistic, Atomicity: Sequential|Transactional, VersionField? }` → `WriteResult { Applied,
  Failures[{Key, Kind: conflict|error|unsupported, Reason}], Versions? }`.
- Plans: `ConnectorSpec { Id?, Name, Kind: sql|rest|cypher|document|builtin, Connection?, Config, Secret?,
  Provider? }`, `ConnectorBinding { Concept, Connector, ConnectorId?, Source, IdKey, FieldMap, Writable,
  VersionField?, Concurrency, Atomicity }`.
- `DataSourceAdapterCatalog.Open(spec, services)` memoises one adapter per spec process-wide, wrapped
  `VersionBumpingAdapter(ReconnectingAdapter(inner))` (3 attempts, 200 ms, ×2, 2000 ms max); factories by Kind
  or pack provider. No held transaction handle: only `ISqlSession.Transaction(work)` /
  `IDocumentSession.Transaction(work)` callbacks; transactional batch honoured within one adapter only.
- `ConnectorWorkingCopy` (MarkDirty/MarkDeleted/Flush, per-binding batches) and `FederatedModelDataConnector`
  are the superseded "cached read-through + explicit flush" lifecycle.
- Host adapters: SQL (`SqlAdapter`+`SqlQueryTranslator` in TODL, `PgSqlSession` in host; transact, version,
  page; upsert = INSERT … ON CONFLICT), Document/Mongo (`DocumentAdapter` over `IDocumentSession`, txn only on a
  replica set), Builtin (server `BuiltinAdapterFactory`), REST (`RestAdapter`: source-managed versions, paging,
  no transactions), GraphQL (`GraphQlAdapter`), Neo4j (`CypherAdapter` over `ICypherSession`), npm provider packs
  (`NpmAdapterPackProvider`, sandboxed; `AdapterPackContract` in TODL `adapter-pack.ts`).
  `src/testing/adapter-conformance.ts` is a reusable conformance harness.
- Gaps vs the engine contract: no reverse lookup, key lookup only via `Where idKey = x`, conjunctive comparisons
  only, `NextAfter` ≈ resume token, no Begin/Apply/Commit/Revert handle (REST/GraphQL/Mongo-standalone can only
  compensate), per-op failure kinds and version/concurrency metadata to carry.

## Runtime hosting today
`TenantRegistry` (one `PragmaticServer` per environment id; lease via `ITenantOwnership` In-memory/Redis;
`OnLost` → dispose; `EvictIdle`; optional `WriteLock`). Per-tenant roots: packages, applications, graphs,
identity. On disk: `packages/<id>/<version>/model.json` (immutable); `applications/<app>/live`,
`applications/<app>/<ver>/application.json` `{name, version, packages[{id,version}], ui?}`, `ui/`,
`access-policy.json` (concept → rule JSON; absent = allow-all, malformed = fail closed), `data/` (builtin store;
shares are documents in collection `__shares`); `graphs/loaded-graph.json`. Builtin engine: Sqlite in Cloud
mode, Document otherwise (`CloudPlatform.CreateAppDataStore` throws → builtin unusable in cloud).

## Runtime access today
- Policy: `AccessPolicySetting.Load` → `IdentityEnforcement.Over(PolicyCatalog.FromPolicies(rules), ctx,
  Action.Read|Write)` (todl-identity-engine). M1's TODL `PolicyScopeCompiler.FromRepository(repo, description)`
  reads `@policy` nodes from a Repository; it needs a `FromRules(Map<concept, rulesJson>, description)` factory
  for runtime (same rule JSON; `IConceptPolicy` is its internal input).
- Depth/ownership/field security: server `TenantReadAuthorization` (`host/cypher/read-filter-source.ts`), cached
  `AccessDepthEvaluator` per tenant; no security model → DenyAll. M1 `DepthScopeCompiler.Compile(evaluator,
  principal, description, hasSecurityModel)` and `DevAccessScopeSource` reuse it (rows, write rules,
  HiddenExact, ReadOnlyExact, create defaults). Runtime composition adds `ConceptBypassInstanceFilter`
  (ungoverned app-private concepts skip depth) — the depth compiler has no equivalent yet.
- Shares: `ShareGrantIndex` + `ShareWidening*` filters/authorizers/gates, keyed by `RecordKey.FromNodeId`.
- Reusable M1 plumbing: `AccessScopeConjunction.And`, `DevScopeCache` digest (claims hash, schema version,
  security generation), `Dropped` signal, `ConnectorPrincipalDigest`, `principal-facts.ts`.

## Tests pinning runtime behaviour (to move or retire)
Server: `host/tests/runtime-*.test.ts`, `host/graphs/tests/*`, `host/cypher/tests/{runtime-app-graph,
graph-for-pragmatic-app*,filtered-graph-query,field-masked-graph-query,server-field-security,
server-record-sharing,server-record-assign,read-filter-source,write-authorizer,write-instance-gate,
tenant-read-authorization-reload,app-connector-plan,builtin-default-store,connector-runtime-read}.test.ts`
(keep `pp-security-harness.ts`), `host/tests/app-data-write-*.test.ts`, `runtime-app-writer`,
`runtime-write-payload-validator`, `filtered-read-write-target-source`, `host/sharing/tests/*`,
`host/apps/tests/*`, `host/paging/tests/*`, `host/connectors/tests/*`, `connectors/tests/*`,
`host/tests/connector-*.test.ts`, `tests/connector-*-e2e.test.ts`, `tests/e2e/sp{0,1}-capstone-e2e.test.ts`,
`cluster/tests/worker-host-app-serving.test.ts`, tenancy and platform tests.
TODL: `graph-api/tests/*`, `model-data/tests/*` (~45), `cypher/tests/*` (~45), `graph-api/browser/tests/*`,
`codegen/tests/{read-client,model-package}.test.ts`, `application/tests/*`,
`engine-bridge/tests/{PolicyScopeCompiler,EngineCellMapper,DevLoop}.test.ts`.
todl-connectors-host: per-adapter tests, `connectors-e2e`, `resolution-audit-e2e`, `adapter-conformance.ts`.
