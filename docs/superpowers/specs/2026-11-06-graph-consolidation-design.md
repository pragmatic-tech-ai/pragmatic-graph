# One graph engine for every use case — consolidation design

Date: 2026-11-06. Status: draft for review.
Inputs: `docs/integration/query-surfaces-audit.md` (inventory of today's surfaces),
the engine living spec (Project #1 item PVTI_lADOE0Zc984Biu4ozhGXYXA), `docs/decisions.md`.

## 1. Intent

Today TODL and pragmatic-server answer graph queries and writes through several unrelated
mechanisms: a `FrozenGraph` rebuilt per request, a cached shard graph, an app graph plus
per-request connector prefetch, an environment graph, the compile-side `Repository`, and a
per-connection connector runtime. Each has its own row filter, field mask, result encoding,
cursor recipe and write path, and some miss security checks the others apply.

The goal is **one engine — pragmatic-graph — underneath every use case**. Dev and runtime
differ in scale, data volume, number of users and security policy, never in code. The
external endpoints (`cypher/*`, `model/view`, `connector/*`, `data/write`) may keep their wire
shapes, but they all run on the same mechanism.

## 2. Goals, non-goals, anti-goals

Goals
- A single running engine instance per graph (dev tenant solution, runtime environment) that
  every read and write endpoint goes through.
- Startup from compiled TODL: the metadata snapshot seeds and upgrades the engine's storage.
- All persistence of instance data goes through connectors with one transactional contract;
  a default connector writes `.todl` files, another persists into the engine's own storage.
- One access-enforcement mechanism inside the engine, fed by policy decided outside it.
- First milestone: the dev architecture-model case end to end. Runtime apps immediately after.

Non-goals (now)
- Moving the compiler / language service `Repository` onto the engine. It models source
  (broken code, provenance, file/member origin, aliasing) and must run in Plexus without the
  platform. It stays.
- Hand-written data migrations. Upgrades discard what no longer fits (§4.3).
- Distributed storage or commit. Deployment shape is one owning engine per graph (§9).
- Caching or mirroring external connector data.
- A vectorized/analytic executor. The existing Cypher interpreter is ported first.

Anti-goals — failure even if it works
- Two code paths for dev and runtime.
- Any endpoint that filters or masks data itself, or bypasses the engine's access scope.
- The engine importing anything from TODL, the server or identity, or knowing what a role,
  share or policy is.
- Serving external data that may be stale.
- `Repository` and the engine disagreeing on "is X an instance of Y" (aspects included).

## 3. Architecture overview

```
.todl sources ──compile──► packages ──Domain──► MetadataSnapshot ─┐
                                                                  ├─► GraphEngine.Open ─► running engine
                                         storage (LMDB / memory) ─┘        │
                                                                           ├─ catalog (concepts, aspects, members, models)
     endpoints ──(AccessScope)──► GraphEngine query/transaction API ───────┤
                                                                           ├─ engine-owned data (KV)
                                                                           └─ connectors (per model / concept binding)
                                                                                 ├─ TodlFileConnector  (.todl rewrite)
                                                                                 ├─ EngineStorageConnector
                                                                                 └─ external adapters (Postgres, Mongo, REST, Neo4j)
```

Layering: pragmatic-graph is the lowest layer. Every contract named below (`MetadataSnapshot`
input shape, `IGraphConnector`, `AccessScope`, predicate expressions, signals) is declared in
the engine and free of upper-layer types. TODL and the server implement or produce them.

## 4. Startup and upgrade

### 4.1 Metadata snapshot
`Domain` keeps loading packages and composing what is today `FrozenGraph`. It is renamed to
reflect its role (working name **MetadataSnapshot**) and stays immutable. It carries:
concepts, aspects, members (types, cardinality, ordering), taxonomies and terms, model nodes and
their connector bindings, and the seed instances of `.todl`-backed models. It exposes a stable
content version (hash) so the engine can detect change.

TODL converts it into the engine's neutral input (`SnapshotDescription`, engine-declared):
definitions with stable names, aspect lists, member descriptors, model → binding table, and
seed rows. Aspects must be present (today they are not emitted into the manifest; fixing that
is part of this work). The engine never sees TODL types.

### 4.2 Open
`GraphEngine.Open(description, storage)`:
- no storage / empty storage → create catalog from the description, load seed, record version;
- stored version equals description version → open as is;
- otherwise → upgrade (4.3), then open.
After `Open` resolves the engine is running and serves the query and transaction API. During
upgrade no other reader or writer exists (system principal, exclusive).

### 4.3 Upgrade rule
Diff stored catalog vs description by stable definition/member names.
- Added definitions/members/taxonomies → added.
- Removed definition → its instances and their edges are discarded.
- Removed or retyped member → its values / edges are discarded.
- Changed parent concept or aspect list of a definition → instances whose type no longer
  satisfies a constraint are discarded (builder decides finer cases; discard is always safe).
- Seed: instances that came from the seed are re-applied from the new snapshot (seed wins for
  seeded nodes; seeded nodes absent from the new seed are removed). Nodes created at runtime are
  kept unless they conflict as above.
The engine's current catalog is append-only (decisions R-series); this design adds removal,
retyping and discard. Hand-written migrations are a later extension point at this step.

### 4.4 Dev loop
A developer saves a `.todl` file → the saved sources recompile → new snapshot → the dev host
re-opens/upgrades the running engine. A write made through `TodlFileConnector` changes `.todl`
files, which triggers the same recompile; the resulting upgrade must be a no-op for data the
write already put in the engine (seed re-apply is idempotent).

## 5. Connectors and data residency

### 5.1 Binding
Every model node names a connector; the existing TODL connector syntax (model-default
connector + per-concept override) stays. A binding is identified by (model, concept). A model
with no binding uses the **environment default connector**: `TodlFileConnector` in dev tenants,
`EngineStorageConnector` in runtime tenants (configuration, not code).

### 5.2 Residency classes
| Class | Where instance data lives | Reads | Writes |
|---|---|---|---|
| `.todl` models | snapshot seed, loaded into engine storage | from engine | engine + `TodlFileConnector` |
| engine-storage models | engine KV | from engine | `EngineStorageConnector` (commits into the same engine transaction) |
| external models | the external system only | fetched on demand per query | external adapter |

External data is never mirrored or cached across queries: we cannot know it did not change
from outside. Fetched rows live only for the query or transaction that fetched them.

### 5.3 Connector contract (engine-declared)
```
interface IGraphConnector
{
    Capabilities: ConnectorCapabilities;          // filter push-down, key lookup, reverse lookup, keyset paging
    Fetch(request: FetchRequest): AsyncIterable<FetchedRow>;
    Begin(): Promise<IConnectorTransaction>;
}
interface IConnectorTransaction
{
    Apply(changes: ConnectorChangeSet): Promise<void>;
    Commit(): Promise<void>;
    Revert(): Promise<void>;
}
```
`FetchRequest`: concept, predicate (engine expression, may include access-scope predicates),
projected members, optional key set, optional reverse lookup (member = id), limit and resume
token. Rows come back keyed by public id. Anything the connector cannot push down is
evaluated by the engine on the returned rows. TODL's existing adapter framework
(`IDataSourceAdapter`, `QueryRequest`, `ConnectorWorkingCopy`, todl-connectors-host adapters)
is adapted to this contract; its earlier "cached read-through + explicit flush" lifecycle is
superseded.

### 5.4 Cross-model edges
An edge belongs to the model that holds its source node (the relationship is a member on the
source concept). It is written through the source model's connector and stores the target's
stable public id. Targets resolve when traversed, via the target model's connector key lookup;
a missing target reads as dangling, not an error. Reverse traversal uses engine reverse edges
when the source is engine-owned, and a reverse-lookup fetch when the source is external. The
engine keeps no separate store for cross-model links.

*Designer's call — identity of `.todl` instances:* the public id is today's qualified instance id.
A rename or namespace move is delete + create; links to the old id dangle (consistent with §4.3
discard). Rename-stable identity is a later extension.

## 6. Writes

All writes — Cypher `CREATE/MERGE/SET/DELETE`, `data/write`, connector write-back — become one
engine transaction. Commit is synchronous write-through:
1. OCC validation of the engine transaction (engine-owned data only).
2. Group changes by owning binding; `Begin` on each participating connector.
3. `Apply` to each; then `Commit` each.
4. Commit the engine transaction; caller gets success.
Any failure → `Revert` every participating connector, abort the engine transaction, report the
failure. The engine guarantees the flow; what `Revert` achieves on the far side is the
connector author's responsibility.

*Designer's call — making step 4 unable to conflict:* step 1 becomes an engine **prepare**: OCC
validation plus a reservation of the transaction's write-set logical keys. Other transactions
that touch reserved keys fail validation (or wait) until the prepared one finalizes; unrelated
commits continue, so slow connectors do not block the whole write group. Step 4 then only
applies. If it still fails (I/O), `Revert` is called on connectors that already committed;
`Revert` after `Commit` is legal in the contract and means "compensate". The current committer
(group `Submit`, R25) gains this prepare/finalize split. `TodlFileConnector` stages file rewrites, swaps them in on
commit and restores originals on revert (today's `DevModelWriter` logic moves here).
Consistency note: reads of external rows cannot be re-validated at commit; that protection is
the connector's (via its transaction).
*Designer's call — read-your-writes:* the engine transaction keeps R30 (a `GraphTransaction` does
not see its own pending writes; flow-language semantics). Cypher's intra-query read-your-writes
is a query-level overlay over the transaction's pending change set, living in the engine's
Cypher module; it replaces today's `WriteOverlay` and draft rebakes.

*Designer's call — seeded data in runtime:* runtime tenants have no source files, so nodes from
`.todl` seed are read-only there (rejected by the write predicate). Runtime-created data lives in
engine-storage or external bindings.

## 7. Access: decided outside, enforced inside

The engine knows nothing of principals, roles, policies or shares. Every reader and
transaction is opened with an engine-declared **AccessScope**:
- per-concept row predicate (engine expression over members, edges, ids);
- hidden members per concept;
- write predicate per concept and operation (create / update / delete).
The only unscoped access is an explicit system scope used by `Open`/upgrade.

The server (with TODL's policy compiler) turns principal + TODL policy declarations + shares +
depth rules into an AccessScope and caches it per principal and snapshot version. The engine
uses the scope to optimize: folds predicates into the plan, uses indexes/derived labels where
they match, pushes them into connector fetches, masks before materializing. Depth and share rules
need graph predicates — reachability within N hops over given edge types, membership in a
set held as graph data — so the engine predicate language includes them. Shares become
ordinary graph data.

Dev and runtime use the same mechanism; dev policies are typically lenient. This closes the
current gaps (environment graph unfiltered, `connector/writeBack` unchecked, `model/view` missing
depth) by construction.

## 8. Query layer and endpoints

The Cypher stack (`TODL/src/cypher`: parser, query model, fluent builder, unparser, planner,
operators, executor, cell codec) moves into pragmatic-graph and runs over engine snapshots:
label scans from extents including aspect carriers, index seek for inline properties and
equality predicates, expand from stored edges, connector fetch operators for external
bindings. TODL re-exports it as today's `Cypher` namespace. (Builder may stage the move.)
Engine work this needs beyond Plan 1: secondary/partial indexes, label extents incl. aspects,
statistics sufficient for scan-vs-seek choices, catalog removal/retyping (§4.3), the predicate
language (§7), connector fetch operators.

Endpoints keep their wire shapes and become thin:
- `cypher/query`, `cypher/execute` → engine query / transaction with the caller's scope. The
  four graph-source branches (dev, dev+modelId, runtime app, environment) disappear;
  `modelId` becomes a scope/filter, not a separate graph.
- `model/view`, `model/resources` → projection of a scoped engine query.
- `connector/read`, `readPage` → scoped engine query over the binding's concept;
  `connector/writePaged`, `writeBack`, `data/write` → engine transaction.
- One result cell encoding (today's Cypher cells) for all reads; endpoint DTOs are mapped from it.
- Cursors: engine commit version + keyset position (+ connector resume token for external
  bindings). Replaces GraphRevision, GraphDataDigest and offset fingerprints.
- Change push: the engine commit signal / changefeed drives runtime data-changed notifications;
  `solution/graphChanged` continues for snapshot changes.

## 9. Hosting

One owning engine per graph (dev solution or runtime environment), embedded in the worker that
holds the existing tenant-ownership lease; other workers forward. Dev: memory or local LMDB.
Runtime: LMDB on a volume the next lease holder can reach.
**Runtime: one engine per environment, like Dataverse.** All apps deployed into an environment
share its engine and catalog; an app is a consumer of the environment's data, not a separate
store. App A's data is visible to app B under the AccessScope, which is the only isolation. The
environment catalog is the union of the packages its apps bring (*designer's call:* two apps
pinning incompatible versions of the same package is rejected at deploy; compatible versions
upgrade the environment snapshot per §4.3). Shares are per environment graph data.
**Cut-over:** existing runtime app data (JSON/SQLite records, share grants) is not imported; the
switch is clean.
**Dev: one shared engine per dev tenant, fed from saved files.** The snapshot is compiled from
saved `.todl` files only, never from unsaved editor buffers. Every developer in the tenant sees
the same engine; a save (or a `TodlFileConnector` write) becomes visible to all after the
recompile. Per-user draft isolation (`PrincipalDraftGraphMask`, per-principal drafts) is dropped.
The engine runs in the server only. Plexus offline keeps working on the `Repository` and does
not embed the engine. Kept clean for later: commit
sequencer interface and pluggable KV, so a FoundationDB-style backend and read replicas can
come without changing code above them.

## 10. What is retired
`FrozenGraph` as a queryable graph (survives only as the snapshot), `GraphQuery`/`IGraphQuery`
full-scan engine, `ConnectorRuntimeGraphQuery`, `ConnectorPrefetch`, `GraphQueryAdapter`,
`WriteOverlay`, `ModelDraftWriter`/`ModelDraftBaker` re-bake path, server `TenantGraphCache`,
`ModelShardCache`, `EnvironmentGraphOverlay`, `FilteredGraphQuery`, `FieldMaskedGraphQuery`,
`AllowedIds`, `ModelReadFilter`, `PrincipalDraftGraphMask`, `AuthorizingCypherWriter` (becomes
scope write predicates), connector-service inline filters, built-in `StorageDocumentSession` /
`SqliteDocumentSession`, `GraphDataDigest`, per-connection `ConnectorRuntime`.
`ModelDataSource` / typed read clients are re-based on the engine query API.
Also: update protocol and server `ARCHITECTURE.md` (currently stale).

## 11. Milestones
1. **Dev end to end**: snapshot → engine open/upgrade; `TodlFileConnector`; Cypher on engine;
   AccessScope; `cypher/query`, `cypher/execute`, `model/view` on the engine for dev tenants;
   dev-side retirements.
2. **Runtime apps**: `EngineStorageConnector`; external adapters on the connector contract with
   on-demand fetch; `data/write`, `connector/*`, environment graph on the engine; runtime
   change push; runtime retirements.

### 11.1 Milestone 2 decisions (owner, 2026-11-10)
- **The environment graph is the Dataverse.** A runtime environment runs ONE engine whose catalog is
  the union of every package delivered into it. Both delivery channels feed it: `application/deploy`
  (packages + UI + policy) and admin promote (`graph/load`, a package set without UI). Neither builds a
  graph of its own. A re-promote or redeploy is an in-place upgrade per §4.3 (data of removed
  definitions discarded, seeded nodes re-applied, runtime-created data kept); a package still
  delivered by another channel stays in the union. The separate promoted `EnvironmentGraph` (its
  overlay, unfiltered query and `loaded-graph.json`-built instance) and per-app data stores are
  retired. The only instance data outside the engine is the read-only FrozenGraph bundled into an
  app built for the bundled target (client-side, never written).
- **Runtime compiles nothing.** The environment engine opens from compiled package manifests
  (packages → `Domain` → snapshot → engine); compiler/language services run in development
  environments only.
- **Ungoverned app-private concepts keep today's bypass.** A concept the tenant security model does not
  govern is filtered by the app's policy rules only; governed concepts get policy AND depth.
- **Shares are graph data.** A system share-grant concept links a record to the principal or team it is
  shared with; the access scope widens reads (and the write rules it already widens today) through a
  graph predicate over those grants, and a grant commits in the same transaction as any other write.

## 12. Invariants to test
- Repository/engine agreement: for every compiled fixture, `Repository.IsA` /
  `InstancesMatching` equal engine label-scan results, aspects included.
- Upgrade discard is total: after upgrade no stored value violates the new catalog.
- Write flow: a failure at any step leaves the engine unchanged and every connector reverted.
- No endpoint returns a row or member outside its AccessScope (same suite runs per endpoint).
- External data: two consecutive queries each fetch (no cross-query reuse).

## 13. Left to the builder
Plan decomposition, the exact predicate expression AST, index structures, the snapshot→
description conversion details, finer upgrade cases, cursor encoding, how the Cypher move is
staged, and naming of the snapshot class.
