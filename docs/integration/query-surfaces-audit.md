# Query surfaces audit (2026-11-06)

What exists today in TODL (main) and pragmatic-server/protocol (master + `graphs-refused-console`)
for querying and writing the graph, and how it converges on pragmatic-graph.

## 1. Substrates (TODL)

| Substrate | Where | Indexes | Changes |
|---|---|---|---|
| Compile graph `Graph` + `InMemoryGraphStore`, read via `Repository` | `compiler-services/model/graph.ts`, `graph-store.ts`, `model.ts` | out/in adjacency, byType, byMetaKind; memo caches cleared on any change | `Graph.changed` signal |
| Runtime `FrozenGraph` / `Heap`, read via `IGraphQuery` (`GraphQuery`) | `domain/graph.ts`, `graph-api/graph-query-engine.ts` | none (InstancesOf/Search/AllInstances = full heap scan + reflect); lazy reverse-ref map | none — every write is a full rebuild |
| `CypherGraphStore` | `compiler-services/model/cypher-store.ts` | delegates to in-memory | replays Cypher text to external Neo4j |

Moving between compile and runtime graphs is always lower-to-manifest + new `FrozenGraph`
(copy-pasted in `ModelDataSource`, `ModelDraftBaker`, `DomainHost`, server `TenantGraphComposition`,
`RuntimeAppGraph`).

## 2. Query engines / evaluators (TODL)

- `cypher/` (~6.9k lines): parser, fluent builder, unparser, `LogicalPlanner` (AllNodesScan/LabelScan,
  inline props become post-scan Filter, Expand/ExpandInto/VarLength), volcano operators, writes,
  `WriteOverlay`, `CypherPushDown`. Graph contract `ICypherGraph`, writer contract `ICypherWriter`
  (only impl `ModelDraftWriter` — rebakes the whole graph on commit).
- `IGraphQuery` (B1) + `ConnectorRuntimeGraphQuery` decorator (prefetched connector rows; not traversable).
- `Repository` type-model queries + `ScopedRepository` (LSP; re-implements rather than filters).
- Predicate evaluator (`predicate/evaluate.ts`) for derive/invariants/quantifiers.
- Also: `QueryFilterEvaluator`, `SqlQueryTranslator`, `IInstanceFilter`, policy predicates (evaluated in server),
  match rules (field tuples in `ResolutionPass`).

## 3. Server endpoints — the "three places"

| Path | Graph | Filter / mask | Encoding | Paging |
|---|---|---|---|---|
| `cypher/query` A1 dev, no modelId | new `Domain`+`FrozenGraph` per request from cached artifact | `AllowedIds` pre-bind + `FieldMaskedGraphQuery` | Cypher cells | offset + GraphRevision |
| `cypher/query` A2 dev, modelId | `ModelShardCache` FrozenGraph per shard | `FilteredGraphQuery` + `FieldMaskedGraphQuery` | Cypher cells | offset + model + principal |
| `cypher/query` A3 runtime, app | cached base Domain + per-request `ConnectorPrefetch` (label-narrowed, push-down) | composite policy/depth/share filter + mask | Cypher cells | offset + `GraphDataDigest` (hashes every instance per page) |
| `cypher/query` A4 runtime, env graph | `EnvironmentGraph` + prefetch of ALL bound concepts | **none** | Cypher cells | offset + digest |
| `model/view`, `model/resources` | legacy `Repository` directly | `ModelReadFilter` (predicate only, **no depth filter**) + mask | `ModelMemberDto` | offset + GraphRevision |
| `connector/read`, `readPage` | per-connection `ConnectorRuntime` | depth only / `ConnectorReadFilter` | `EntityDto` | in-memory offset / keyset from adapter |

Writes:
- `cypher/execute` (dev only): `ModelDraft` → mask → `CypherEngine` + `AuthorizingCypherWriter` →
  rewrites `.todl` files, CAS on source hash, Redis/in-process lease.
- `data/write` (runtime app): `RuntimeAppWriter` → connectors or built-in store
  (`StorageDocumentSession` JSON-per-record / `SqliteDocumentSession`; cloud `CreateAppDataStore` throws).
- `connector/writePaged`, `connector/writeBack` (**no per-row auth**), `data/share|unshare|assign`.

Change push: only `solution/graphChanged` (dev). Nothing for runtime data.

## 4. Defects found (independent of the engine)

1. A4 runtime environment-graph `cypher/query` applies no row filter and no field mask.
2. `connector/writeBack` has no per-row authorization.
3. `model/view` omits the access-depth filter that A1/A2 apply.
4. Cluster `WorkerHost` attach omits `devGraphService` / `environmentGraphHost` → `graph/*` and A4 unavailable.
5. Aspects are not emitted as manifest concepts, so Cypher labels / `IGraphQuery.InstancesOf` cannot
   match aspect carriers, while TODL predicates and `Repository.IsA` do.
6. `ConnectorPrefetch` skips the `MergeFreeConcepts` gate that `FederatedModelDataConnector` applies.
7. protocol and server `ARCHITECTURE.md` are stale (missing `cypher/execute`, `cypher/models`, `graph/*`, `/app/`).

## 5. Duplication to collapse

- 6 `IGraphQuery`/`ICypherGraph` impls, 3 writers.
- 6 row-filter impls, 4 field-mask impls.
- 4 graph-build pipelines, 2 prefetch policies.
- 4 subtype/instance-of implementations with different semantics (aspects vs extends-only).
- 3 reference-traversal implementations.
- 3 result encodings for reads, 3 cursor fingerprint recipes + keyset.

## 6. Convergence target

One store, one engine, one security layer, one encoding, one cursor.

- **Store:** pragmatic-graph per graph (runtime app data, environment graph; later the dev model as a
  materialized index of `.todl`). Catalog derived from the TODL meta-model including aspects (fixes defect 5).
- **Engine:** `cypher/` runs over a `GraphReader` snapshot: LabelScan from extents (incl. aspect carriers),
  IndexSeek for inline props, Expand from adjacency; writes go to a `GraphTransaction` (no rebake).
  `IGraphQuery` remains only as an adapter during migration.
- **Security:** one `SecuredReader` (row predicate + depth + shares + field mask) between every endpoint
  and the snapshot; later predicates compile to derived labels / partial indexes.
- **Endpoints:** `cypher/query` + `cypher/execute` are the core; `model/view` and `connector/read` become
  projections over the same secured reader; one cell encoding.
- **Cursors:** snapshot commit version + keyset over index order, replacing GraphRevision / GraphDataDigest / offset.
- **Notifications:** engine changefeed → runtime data-changed push alongside `solution/graphChanged`.
- **Connectors:** federation stays; prefetch writes into a transaction-local overlay with one policy (fixes defect 6).
