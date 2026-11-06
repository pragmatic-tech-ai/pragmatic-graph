# Engine core for consolidation (milestone 1, plan 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give pragmatic-graph what the consolidation design needs below the query layer: a description-driven `GraphEngine.Open` that upgrades (and discards) stored data, seed synchronization, node ownership, secondary indexes, a predicate language with graph predicates, AccessScope enforcement on reads and writes, a prepare/finalize committer, and write-through to connectors.

**Architecture:** Everything stays inside pragmatic-graph and keeps Plan 1's shape: catalog → KV keyspaces → committer groups → reader/transaction facade. Upgrades and seed are committer work items (atomic, logged, raised on CommitApplied). Access is an engine-declared `AccessScope` of predicates applied by readers and checked at commit. Connector write-through wraps the committer's new prepare/finalize split.

**Tech Stack:** TypeScript 7, Node (`node:test`, `node:crypto`), lmdb-js. Tests via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-11-06-graph-consolidation-design.md` (read §4–§7 and §9). Also binding: `docs/decisions.md` (R1–R34, F1–F9) and `docs/format/on-disk-format.md`.

**Out of scope (later plans):** Cypher on the engine (plan 2), TODL snapshot conversion and `TodlFileConnector` (plan 3), server hosting (plan 4). External (non-resident) bindings — `Fetch`, on-demand reads, identity-only stub nodes for edges to external targets, predicate push-down — belong to milestone 2 (spec §11); this plan declares only the transactional half of the connector contract.

## Global Constraints

- Engine is the lowest layer: no import from TODL, Mural, server or identity; only runtime dependency `lmdb` (node built-ins allowed). Upward communication by signals only.
- OOP: no module-level free functions or mutable module state; Allman braces; PascalCase interfaces and public methods; reused string literals are `private static readonly` PascalCase constants; fixed value sets are enums.
- Teardown through `dispose()`. Public storage APIs are async and never return live references into storage.
- Every error raised on purpose is a `GraphError` with a `GraphErrorCode` (F8). New codes are appended, never renumbered.
- Conflict detection uses logical keys only (R23); every new read path records its keys, every new write path adds its write keys.
- Format version stays 1 (unfrozen); every key/value change is documented in `docs/format/on-disk-format.md` in the same task.
- Tests live in `src/<area>/tests/*.test.ts`; every task runs against both MemoryStore and LMDB where it touches storage (follow the existing dual-backend pattern in `src/tests/GraphStore.test.ts`).
- Each task ends green: `npm test` and `npm run typecheck`. Append the task's rulings to `docs/decisions.md` as R35+ ("what — why — cost if wrong").
- Fix every review finding, including minors; never defer.

## Review Focus

1. Upgrade that removes a concept which kept concepts still link to: reverse edges on surviving nodes must disappear too (no dangling adjacency entries). → Task 4 test `purge removes incoming edges on surviving nodes`.
2. A seeded node edited at runtime, then an upgrade with an unchanged seed: content hash unchanged, so the runtime edit must be overwritten only when the seed *content* changes — expected: unchanged seed leaves runtime edit, changed seed overwrites. → Task 5 tests `unchanged seed keeps runtime edit`, `changed seed wins`.
3. Unique index under concurrent creates of the same value in two transactions: exactly one commits. → Task 6 test `concurrent unique inserts: one wins`.
4. Scope reads are reads: a transaction whose visibility depended on a node another commit changed must conflict. → Task 7 test `visibility read is recorded`.
5. A connector that hangs: the prepared reservation must expire and later writers must proceed. → Task 9 test `expired reservation releases keys`; Task 10 test `timeout reverts connectors`.

---

### Task 1: Node owner and node-level reads

Every node records the model (owner) that holds it, so writes can be routed to that model's connector (spec §5.1). Readers gain node-level operations the later tasks and the query layer need.

**Files:**
- Modify: `src/format/FormatKeys.ts` (add `IdsTag.Owner`, `FormatKeys.NodeOwner(id: bigint)`)
- Modify: `src/txn/WriteBatch.ts` (CreateNode gains optional `owner`; serialized with a presence flag)
- Modify: `src/txn/BatchApplier.ts` (write/clear owner key on create/delete)
- Modify: `src/GraphTransaction.ts`, `src/GraphReader.ts`
- Modify: `docs/format/on-disk-format.md`
- Test: `src/tests/NodeReads.test.ts`, extend `src/txn/tests/WriteBatch.test.ts`

**Interfaces:**
- Produces:
  - `GraphTransaction.CreateNode(publicId: string, concept: string, options?: ICreateNodeOptions): void` and the same signature on `WriteBatch.CreateNode`, with `interface ICreateNodeOptions { readonly ClusterHint?: string; readonly Owner?: string }` (replaces the positional `clusterHint`; update all call sites). `ICreateNodeOp` gains `readonly Owner?: string`.
  - `GraphReader.ConceptOf(publicId: string): Promise<string | undefined>` — records `Node(publicId)`.
  - `GraphReader.OwnerOf(publicId: string): Promise<string | undefined>` — `''` when created without owner; `undefined` when no node. Records `Node(publicId)`.
  - `GraphReader.ScanNodes(conceptOrAspect: string): AsyncIterable<string>` — public ids of live nodes whose concept is/inherits/carries it, per matching concept then slot order; records `Extent(typeId)` per matching type.
  - `GraphReader.EstimateCount(conceptOrAspect: string): Promise<number>` — sum of slot counts over matching concepts (upper bound: includes deleted slots); records nothing.

- [ ] **Step 1: Write failing tests** in `src/tests/NodeReads.test.ts` (both backends):
  - `owner round-trips`: create `a` with `{ Owner: 'm1' }`, `b` without → `OwnerOf('a') === 'm1'`, `OwnerOf('b') === ''`, `OwnerOf('zz') === undefined`.
  - `owner cleared on delete`: delete `a` → `OwnerOf('a') === undefined`; raw scan of `Keyspace.Ids` with `IdsTag.Owner` prefix finds no entry for its id.
  - `ScanNodes includes aspect carriers`: concepts `Server` and `Laptop` carry aspect `Asset`, `Person` does not → `ScanNodes('Asset')` yields exactly the Server and Laptop ids; deleted nodes excluded.
  - `EstimateCount is an upper bound`: 3 creates + 1 delete → `EstimateCount('Asset') === 3`.
  - `ScanNodes records extents`: txn T1 scans `Asset`, T2 creates a Laptop and commits, T1 writes anything and commits → `ConflictError`.
  - WriteBatch: `Deserialize(Serialize(b))` deep-equals for CreateNode with and without Owner.
- [ ] **Step 2: Run** `npx tsx --test src/tests/NodeReads.test.ts src/txn/tests/WriteBatch.test.ts` — expect FAIL (`OwnerOf` not a function).
- [ ] **Step 3: Implement.** Owner key = `FormatKeys.NodeOwner(id)` in `Keyspace.Ids`, value UTF-8 owner (only written when owner non-empty). Owner change is not supported (create-time only). The owner key is covered by the existing `Node(publicId)` conflict key (no new logical key).
- [ ] **Step 4: Run** the tests, then `npm test` and `npm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(engine): node owner and node-level reads`.

---

### Task 2: Predicate language and node-local evaluation

Engine-declared predicate AST used by partial indexes (Task 6), access scopes (Tasks 7–8) and later by the query layer.

**Files:**
- Create: `src/predicate/Predicate.ts` (AST classes), `src/predicate/PredicateCodec.ts` (JSON), `src/predicate/PredicateError.ts`
- Create: `src/predicate/NodeEvaluator.ts` (evaluates against a node's own values)
- Modify: `src/index.ts`
- Test: `src/predicate/tests/Predicate.test.ts`

**Interfaces:**
- Produces (all exported):
  - `enum CompareOp { Eq = 1, Ne, Lt, Le, Gt, Ge }`
  - `abstract class Predicate { abstract readonly Kind: PredicateKind; get IsNodeLocal(): boolean }` with `enum PredicateKind { True = 1, False, Compare, In, IsNull, And, Or, Not, IdIn, Related, Reachable, Seeded, OwnerIs }`.
  - Leaves: `Compare(Member: string, Op: CompareOp, Value: CellValue)`, `In(Member: string, Values: readonly CellValue[])`, `IsNull(Member: string)`, `IdIn(Ids: ReadonlySet<string>)`, `Seeded()`, `OwnerIs(Owners: ReadonlySet<string>)`.
  - Combinators: `And(Terms: readonly Predicate[])`, `Or(Terms: readonly Predicate[])`, `Not(Term: Predicate)`; singletons `Predicate.True`, `Predicate.False`.
  - Graph predicates (evaluated in Task 7): `Related(Relationship: string, Direction: EdgeDirection, Target: Predicate)` — has at least one neighbor over the relationship satisfying Target; `Reachable(From: ReadonlySet<string>, Steps: readonly IPathStep[], MaxHops: number)` with `interface IPathStep { readonly Relationship: string; readonly Direction: EdgeDirection }` — node is one of `From` or reachable from it in 1..MaxHops hops, each hop over any of `Steps`.
  - `IsNodeLocal` is true iff the tree contains no Related/Reachable/Seeded/OwnerIs (those need the reader).
  - `PredicateError extends GraphError` (`GraphCode` SchemaViolation) with `enum PredicateErrorCode { Malformed = 1, NotNodeLocal }`.
  - `PredicateCodec.ToJson(p: Predicate): unknown`, `PredicateCodec.FromJson(json: unknown): Predicate` (throws `PredicateError` code `Malformed`).
  - `NodeEvaluator.Matches(p: Predicate, values: ReadonlyMap<string, CellValue>, publicId: string): boolean` — node-local only (throws `PredicateError` `NotNodeLocal` otherwise).
- Semantics (pin in tests): three-valued like SQL collapsed at the top — a comparison with a null/absent member is false, `Not(Compare(...))` on null is also false (`Not` of unknown stays unknown → false); `IsNull` true for null or absent. Comparisons across value types are false (no coercion), except Int64 vs Float64 compare numerically. String comparison is UTF-8 byte order (matches TupleCodec ordering). Dates/DateTimes compare by instant; Duration only Eq/Ne.

- [ ] **Step 1: Write failing tests** `src/predicate/tests/Predicate.test.ts`:
  - `compare null is false both ways`: values `{ x: null }` → `Matches(Compare('x', Eq, 1n))` false and `Matches(Not(Compare('x', Eq, 1n)))` false; `Matches(IsNull('x'))` true; absent member same as null.
  - `int and float compare numerically`: `{ n: 2n }` matches `Compare('n', Lt, 2.5)`.
  - `mixed types never match`: `{ s: '1' }` does not match `Compare('s', Eq, 1n)`.
  - `string order is byte order`: `'Z' < 'a'` and `'é' > 'z'`.
  - `In and IdIn`, `And/Or short-circuit`, `True/False`.
  - `codec round-trips every kind` (deep-equal after ToJson→FromJson, including Related and Reachable); `FromJson({ Kind: 99 })` throws `PredicateError` code `Malformed` with `GraphCode === SchemaViolation`.
  - `IsNodeLocal`: `And([Compare, Related])` is false.
- [ ] **Step 2: Run** `npx tsx --test src/predicate/tests/Predicate.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** the AST as immutable classes (one class per kind), the codec, `NodeEvaluator`. Value comparison reuses the CellValue classes (`DateValue`, `DateTimeValue`, `DurationValue`).
- [ ] **Step 4: Run** the tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(engine): predicate language`.

---

### Task 3: Schema description and catalog rebuild

The engine's neutral input (spec §4.1) and a deterministic rebuild of the catalog from it that keeps ids of unchanged definitions.

**Files:**
- Create: `src/schema/SchemaDescription.ts` (input interfaces), `src/schema/CatalogPlanner.ts`, `src/schema/CatalogDiff.ts`
- Modify: `src/catalog/CatalogTypes.ts` (add `IndexDef`), `src/catalog/CatalogSnapshot.ts` (`Build` takes indexes and `NextIndexId`; `Indexes()`, `IndexesOn(concept)`), `src/catalog/CatalogStore.ts` (serialize indexes; additive JSON), `src/catalog/CatalogModel.ts` (`DefineIndex`), `src/index.ts`
- Test: `src/schema/tests/CatalogPlanner.test.ts`, extend `src/catalog/tests/CatalogStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ISchemaDescription
  {
      readonly Version: string;                       // opaque content version from the producer (hash)
      readonly Definitions: readonly IDefinitionDescription[];
      readonly Indexes: readonly IIndexDescription[];
      readonly Seed: readonly ISeedNode[];            // used by Task 5
      readonly Bindings: readonly IBindingDescription[]; // used by Tasks 10–11
      readonly DefaultConnector?: string;
  }
  interface IDefinitionDescription { readonly Name: string; readonly IsAspect: boolean; readonly Parent: string | null; readonly Aspects: readonly string[]; readonly Members: readonly MemberInput[]; readonly Options?: IConceptOptions }
  interface IIndexDescription { readonly Name: string; readonly On: string; readonly Members: readonly string[]; readonly Unique?: boolean; readonly Where?: Predicate }
  interface ISeedNode { readonly PublicId: string; readonly Concept: string; readonly Owner: string; readonly Properties: Readonly<Record<string, CellValue>>; readonly Links: readonly ISeedLink[] }
  interface ISeedLink { readonly Relationship: string; readonly To: string; readonly Properties?: Readonly<Record<string, CellValue>> }
  interface IBindingDescription { readonly Model: string; readonly Concept?: string; readonly Connector: string }
  ```
  - `IndexDef { Id: number; Name: string; On: string; Members: readonly number[] /* member ids */; Unique: boolean; Where?: Predicate }` — index ids are a separate stable counter from 1.
  - `CatalogPlanner.Plan(stored: CatalogSnapshot, desired: ISchemaDescription): ICatalogPlan` with `interface ICatalogPlan { readonly Catalog: CatalogSnapshot /* Version = stored.Version + 1, or stored itself when Diff.IsEmpty */; readonly Diff: CatalogDiff }`.
  - `CatalogDiff` (read-only): `AddedTypes`, `RemovedTypes: readonly TypeDefinition[]` (old defs), `RemovedMembers: readonly { Type: string; Member: MemberDef }[]` (old member defs, per concept they were effective on), `ChangedHierarchy: readonly string[]` (kept concepts whose parent or aspect list changed), `AddedIndexes`, `RemovedIndexes: readonly IndexDef[]`, `get IsEmpty(): boolean`.
- Rules (pin in tests):
  - Identity is by name. A kept type keeps its TypeId. A member is *kept* (same id) iff Name, Kind, Type, Many, Ordered, Targets (as a set) and EdgeProperties are equal and its `Nullable` did not go from true to false; any other change is *retyped*: old id removed, new id assigned. Nullable false→true keeps the id.
  - A member moved between declaring types (e.g. from concept to an aspect it now carries) keeps its id when otherwise equal (R2 ids are catalog-global; match by owner-type-agnostic `(Name, effective on concept)`).
  - An index is kept iff On, Members, Unique and Where (codec JSON) are equal; otherwise removed + added (new id).
  - Validation errors from `Seal` propagate as `CatalogError`; the stored catalog is unaffected.
  - Plan is pure (no I/O).

- [ ] **Step 1: Write failing tests** `src/schema/tests/CatalogPlanner.test.ts`:
  - `identical description is empty diff`: plan returns the stored snapshot object and `Diff.IsEmpty`.
  - `added concept gets new ids, kept ids stable`.
  - `removed concept listed with old def`.
  - `retyped member gets a new id`: `size: Int64` → `size: String` → old id in `RemovedMembers`, new member id `>` stored `NextMemberId - 1`.
  - `nullable true to false is retype; false to true keeps id`.
  - `member moved to carried aspect keeps id`.
  - `parent change lists concept in ChangedHierarchy, keeps TypeId`.
  - `index change is remove plus add`; `index on aspect allowed, on unknown member → CatalogError UnknownMember`.
  - CatalogStore: `indexes round-trip through Save/Load` and a catalog JSON without `indexes` loads with none (additive).
- [ ] **Step 2: Run** `npx tsx --test src/schema/tests/CatalogPlanner.test.ts src/catalog/tests/CatalogStore.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Build the new catalog with a fresh `CatalogModel` seeded with the stored counters, re-recording kept definitions with their ids (add an internal `CatalogModel.Restore(def: TypeDefinition)` used only by the planner) and new ones via `DefineConcept/DefineAspect/DefineIndex`.
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(engine): schema description and catalog planner`.

---

### Task 4: Upgrade commit and discard

Applies an `ICatalogPlan` atomically: purge what no longer fits, save the catalog, log it (spec §4.3).

**Files:**
- Create: `src/schema/DataPurger.ts`
- Modify: `src/txn/Committer.ts` (`SubmitUpgrade`), `src/txn/LogEntry.ts` (`CommitKind.Upgrade = 3`, encoding), `src/format/FormatMeta.ts` or `FormatKeys` (`Meta("schemaVersion")`), `src/GraphStore.ts` (internal `Upgrade(description)`), `docs/format/on-disk-format.md`
- Test: `src/schema/tests/Upgrade.test.ts`, extend `src/txn/tests/LogEntry.test.ts`

**Interfaces:**
- Consumes: `CatalogPlanner.Plan`, `CatalogDiff` (Task 3).
- Produces:
  - `Committer.SubmitUpgrade(description: ISchemaDescription): Promise<IUpgradeCommit>` with `interface IUpgradeCommit { readonly Commit: bigint /* the Upgrade entry's number; LastCommit when nothing changed */; readonly Catalog: CatalogSnapshot; readonly Changed: boolean }`. Runs alone in its group, like SubmitSchema; plans against the committer's current catalog at its turn.
  - `GraphStore.Upgrade(description: ISchemaDescription): Promise<IUpgradeCommit>` (internal, used by Task 11) and `GraphStore.SchemaVersion(): Promise<string | undefined>` (reads `Meta("schemaVersion")`).
  - `DataPurger.Purge(txn: IWriteTransaction, old: CatalogIndex, next: CatalogIndex, diff: CatalogDiff, keys: WriteKeySet): Promise<IPurgeStats>` with `IPurgeStats { NodesRemoved: number; ValuesRemoved: number; EdgesRemoved: number }`.
  - `ICommitApplied` gains `Kind: CommitKind.Upgrade` entries carrying `Catalog` (as SchemaChange) and `SchemaVersion: string`. Log value: `kind u8 = 3, catalogVersion u32, versionLength u32, version UTF-8, catalog JSON`.
- Discard rules (pin in tests):
  - Removed type → every node of it is removed: rows, public-id bindings, owner keys, all cells, all edges in both directions (including the reverse entries stored under surviving nodes), slot meta, seed markers (Task 5).
  - Removed/retyped member → its column chunks/deltas for every type purged; for a relationship, all its edges in both directions.
  - ChangedHierarchy concept → members no longer effective on it are purged for that type; edges of relationships whose Targets no longer accept the concept are purged where the concept is the target; nodes are kept.
  - A kept or retyped non-nullable member (or a newly added non-nullable property) on a concept with existing nodes → those nodes are removed (spec: "discard is always safe"); seed (Task 5) re-creates seeded ones.
  - Removed index → its entries purged (Task 6 adds index entries; until then a no-op branch).
  - Purge writes the logical write keys of everything it removes into `keys` (Node, Cell, Edge, Extent, Column) so open transactions conflict; in addition every transaction begun before the upgrade fails on catalog version (existing rule).
  - When `Diff.IsEmpty` but `description.Version` differs, only `Meta("schemaVersion")` is rewritten (no log entry, `Changed: false`).
  - Everything happens in one `store.Write`.

- [ ] **Step 1: Write failing tests** `src/schema/tests/Upgrade.test.ts` (both backends):
  - `first upgrade on empty store defines catalog and version`: `SchemaVersion()` becomes `'v1'`, `CommitApplied` raised once with `Kind === Upgrade`.
  - `same version twice is a no-op`: second call `Changed === false`, no CommitApplied.
  - `removed concept discards its nodes`: `Note` removed → `ScanNodes('Note')` throws `CatalogError UnknownType`; public id resolves to nothing; raw `Keyspace.Columns` scan has no key with Note's typeId.
  - `purge removes incoming edges on surviving nodes`: `Person -authored-> Note`, remove `Note` and the `authored` relationship stays on Person with Targets now `[Doc]` → `Neighbors(person, 'authored', Out)` is empty and raw Edges keyspace has no entry with the removed node's id.
  - `retyped member drops values`: `size Int64 → String` → `GetProperty` returns null for old nodes.
  - `new required member discards existing nodes`.
  - `open transaction conflicts after upgrade`.
  - `changefeed replays upgrade`: `ReadChanges(0n)` yields the Upgrade entry with `SchemaVersion` and full catalog.
  - `failed plan leaves store unchanged`: description with unknown parent → rejects `CatalogError`, `SchemaVersion()` unchanged.
- [ ] **Step 2: Run** `npx tsx --test src/schema/tests/Upgrade.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Purge enumerates with the OLD catalog index (node-id column scans per affected type), then writes. Reuse `EdgeStore.Unlink`/adjacency scans for both directions; delete column/delta keys by `FormatKeys.Column/Delta` prefixes. Flush/AssertFlushed discipline (R20/F6) as in `ApplyGroup`.
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(engine): upgrade commit with discard`.

---

### Task 5: Seed synchronization

Seed rows from the description are applied in the same upgrade write (spec §4.3 "seed wins for seeded nodes").

**Files:**
- Create: `src/schema/SeedSynchronizer.ts`, `src/schema/SeedHash.ts`
- Modify: `src/format/FormatKeys.ts` (`FormatKeys.Seed(publicId)` in `Keyspace.Meta`), `src/txn/Committer.ts` (upgrade group appends a seed Batch commit), `src/GraphReader.ts` (`IsSeeded`), (the `Seeded` predicate is evaluated in Task 7; here only the reader method), `docs/format/on-disk-format.md`
- Test: `src/schema/tests/Seed.test.ts`

**Interfaces:**
- Consumes: `SubmitUpgrade` (Task 4), `ISeedNode` (Task 3).
- Produces:
  - `SeedHash.Of(node: ISeedNode): Uint8Array` — SHA-256 (node:crypto) over a canonical encoding: PublicId, Concept, Owner, properties sorted by name with TupleCodec-encoded values, links in given order.
  - `SeedSynchronizer.Build(view: ISeedView, seed: readonly ISeedNode[], storedHashes: ReadonlyMap<string, Uint8Array>): Promise<ISeedPlan>` with `interface ISeedView { Resolve(publicId: string): Promise<{ readonly Concept: string; readonly Owner: string } | undefined>; OutEdges(publicId: string): Promise<readonly { readonly Relationship: string; readonly To: string }[]> }` (implemented over the upgrade's write txn, post-purge) and `ISeedPlan { readonly Batch: WriteBatch; readonly Hashes: ReadonlyMap<string, Uint8Array>; readonly Removed: readonly string[] }`.
  - `GraphReader.IsSeeded(publicId: string): Promise<boolean>` — records `Node(publicId)`.
  - `IUpgradeCommit` gains `SeedCommit?: bigint` (the Batch commit number when the seed changed anything).
- Rules (pin in tests):
  - Runs on every `SubmitUpgrade` whose description version differs from the stored one, even when the catalog diff is empty.
  - Seed node absent in store → CreateNode (with Owner) + SetProperty for each property + Link in array order (ordered relationships keep that order).
  - Seed node present and seeded with equal hash → untouched (runtime edits survive).
  - Seed node present with different hash, or present but not seeded (created at runtime) → overwritten: every effective property set (properties absent from the seed set to null; a non-nullable absent one is a `CommitError MissingRequired` failing the upgrade), every out-edge over the node's relationships removed and the seed links re-added; marked seeded. Owner is not changed for an existing node (owner is create-time, Task 1); a differing owner is a CommitError `InvalidValue`.
  - Previously seeded id absent from the new seed → DeleteNode.
  - Links may point to seed nodes created later in the same seed (apply creates first, then properties, then links).
  - Seed and upgrade are atomic: catalog Upgrade entry and seed Batch entry in one `store.Write`, two consecutive commit numbers; a seed failure rejects the whole upgrade.
  - Seed markers: `Meta("seed", publicId)` → 32-byte hash.

- [ ] **Step 1: Write failing tests** `src/schema/tests/Seed.test.ts`:
  - `first open loads seed`: 2 seed nodes with a link → both exist, `IsSeeded` true, `Neighbors` returns the link, `OwnerOf` the seed owner.
  - `unchanged seed keeps runtime edit`: set a property on a seeded node via a transaction, upgrade with a new Version string but same seed → value kept.
  - `changed seed wins`: change that node's seed property → runtime value replaced.
  - `runtime node with seed id is taken over`.
  - `removed seed node is deleted`; `runtime nodes untouched`.
  - `ordered links follow seed order`.
  - `seed failure aborts upgrade`: seed link to unknown id → rejects `CommitError UnknownNode`; `SchemaVersion()` and catalog unchanged.
  - `changefeed has Upgrade then Batch`.
- [ ] **Step 2: Run** `npx tsx --test src/schema/tests/Seed.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Ids (R16 forbids allocating inside the Write): before the Write, a read-only pre-pass over a store snapshot allocates one id per seed node that is absent or whose stored hash differs. Inside the Write the seed batch is built against the post-purge state through `ISeedView` and applied with `BatchApplier` using those ids. If a create needs an id the pre-pass did not allocate (a purge removed a node the pre-pass saw), abort the Write and re-run the whole upgrade once with a fresh pre-pass; a second miss is `GraphError Internal`. Log as a Batch entry after the Upgrade entry.
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(engine): seed synchronization`.

---

### Task 6: Secondary indexes

Ordered, composite, unique and partial indexes over properties, on concepts or aspects (carriers included).

**Files:**
- Create: `src/indexes/IndexStore.ts`, `src/indexes/IndexKey.ts`, `src/indexes/tests/Indexes.test.ts`
- Modify: `src/kv/Keyspace.ts` (`Index = 'index'`), both KV backends if they enumerate keyspaces (LMDB named DB), `src/txn/BatchApplier.ts` (maintenance), `src/txn/ConflictKeys.ts` (`IndexEntry`, `IndexRange`), `src/txn/CommitError.ts` (`UniqueViolation` appended), `src/schema/DataPurger.ts` (removed indexes), upgrade path (build added indexes), `src/GraphReader.ts` (`SeekIndex`), `docs/format/on-disk-format.md`

**Interfaces:**
- Consumes: `IndexDef`, `CatalogSnapshot.IndexesOn` (Task 3), `NodeEvaluator` (Task 2), upgrade group (Task 4).
- Produces:
  - Key: `TupleCodec.Encode([indexId, ...values, internalId])` in `Keyspace.Index`, empty value. Null values encode as tuple null and are indexed. Date → days int, DateTime → epoch micros int (zone ignored for ordering), Duration not indexable (`CatalogError InvalidMember` at plan time).
  - `GraphReader.SeekIndex(index: string, range: IIndexRange): AsyncIterable<string>` with `interface IIndexRange { readonly Prefix: readonly CellValue[]; readonly Lower?: IIndexBound; readonly Upper?: IIndexBound; readonly Reverse?: boolean; readonly Limit?: number }`, `interface IIndexBound { readonly Value: CellValue; readonly Inclusive: boolean }` (bounds apply to the member after the prefix). Yields public ids in index order; records the scanned key range in `Keyspace.Index` (phantom-safe).
  - `ConflictKeys.IndexEntry(key: Uint8Array)` written by maintenance for every added/removed entry.
- Rules (pin in tests):
  - Maintenance on CreateNode (after the batch's properties are known — evaluate at end of batch per node, like MissingRequired), SetProperty on an indexed member, DeleteNode; only nodes whose concept IsA `On`; partial `Where` must be node-local (else `CatalogError InvalidMember` at plan time) and is evaluated on the node's post-batch values — entering/leaving the predicate adds/removes the entry.
  - Unique: at most one entry per value tuple; tuples containing a null never violate (SQL style). Violation → `CommitError UniqueViolation` (`ConstraintViolation`). Unique check reads the prefix range, so a concurrent insert of the same value conflicts.
  - Added index on existing data is built inside the upgrade Write (Task 4 group); a unique violation in existing data fails the upgrade.

- [ ] **Step 1: Write failing tests** `src/indexes/tests/Indexes.test.ts` (both backends):
  - `seek by equality prefix`, `range with bounds inclusive/exclusive`, `reverse with limit`.
  - `composite index orders by second member within prefix`.
  - `aspect index covers carriers`.
  - `partial index tracks predicate entry and exit`: `Where Compare('status', Eq, 'open')`; set status closed → no longer yielded.
  - `delete removes entry`; `retype of indexed member drops index entries` (via upgrade).
  - `unique violation rejects batch`; `nulls never violate unique`.
  - `concurrent unique inserts: one wins` (two transactions, both commit → exactly one `ConflictError` or `UniqueViolation`, one success).
  - `seek is phantom-safe`: T1 seeks, T2 inserts in range and commits, T1 commits a write → `ConflictError`.
  - `index added by upgrade is built over existing nodes`.
- [ ] **Step 2: Run** `npx tsx --test src/indexes/tests/Indexes.test.ts` — FAIL.
- [ ] **Step 3: Implement** `IndexStore` (Add/Remove/Seek/Build over a txn) and wire maintenance into `BatchApplier`.
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(engine): secondary indexes`.

---

### Task 7: AccessScope and read enforcement

Access decided outside, enforced inside (spec §7). Every reader and transaction carries a scope.

**Files:**
- Create: `src/access/AccessScope.ts`, `src/access/ScopeEvaluator.ts`, `src/access/tests/ReadScope.test.ts`
- Modify: `src/GraphStore.ts` (`BeginRead(scope)`, `Begin(scope)` — scope REQUIRED), `src/GraphReader.ts`, `src/GraphTransaction.ts`, every existing test call site (pass `AccessScope.System`), `src/index.ts`

**Interfaces:**
- Consumes: `Predicate` (Task 2), `ScanNodes/ConceptOf/OwnerOf/IsSeeded` (Tasks 1, 5).
- Produces:
  ```ts
  enum AccessDefault { Allow = 1, Deny = 2 }
  interface IWriteRules { readonly Create?: Predicate; readonly Update?: Predicate; readonly Delete?: Predicate }
  class AccessScope
  {
      static readonly System: AccessScope;              // everything visible, all writes allowed
      static Build(options: IAccessScopeOptions): AccessScope;
      readonly Default: AccessDefault;
  }
  interface IAccessScopeOptions
  {
      readonly Default: AccessDefault;                   // for concepts with no applicable Rows entry
      readonly Rows?: ReadonlyMap<string, Predicate>;    // key: concept or aspect name
      readonly Hidden?: ReadonlyMap<string, ReadonlySet<string>>;
      readonly Writes?: ReadonlyMap<string, IWriteRules>;
  }
  ```
  - `ScopeEvaluator` (internal): `Visible(publicId): Promise<boolean>` and `HiddenMembers(concept): ReadonlySet<string>`. Applicable entries for a node = entries keyed by its concept, any ancestor concept, or any carried aspect; all applicable Rows predicates must hold (AND); no applicable entry → `Default`. Hidden = union of applicable sets.
  - Graph predicates: `Reachable` computes its reachable set once per reader (BFS over Steps, from `From`, up to MaxHops, through the reader's recorded reads) and caches it on the evaluator; `Related` evaluates its Target recursively under the SAME scope (an invisible neighbor does not count). `Seeded` → `IsSeeded`; `OwnerIs` → `OwnerOf`.
  - Enforcement in GraphReader: an invisible node behaves exactly as a missing node in `GetProperty` (undefined), `ConceptOf`, `OwnerOf`, `IsSeeded`, `Neighbors` (filtered out), `ScanNodes`, `ScanConcept`, `SeekIndex` (skipped). A hidden member reads as `null` in `GetProperty`; `ScanConcept` over a hidden member yields no rows for that node.
  - Every read the evaluator performs is recorded in a transaction's ReadSet (visibility is a read).
- [ ] **Step 1: Write failing tests** `src/access/tests/ReadScope.test.ts`:
  - `System sees everything` (existing suites pass with System).
  - `Deny default hides unlisted concepts`.
  - `row predicate on aspect applies to carriers`; `concept and aspect predicates AND together`.
  - `invisible node looks missing everywhere` (GetProperty undefined, not in Neighbors/ScanNodes/ScanConcept/SeekIndex).
  - `hidden member reads null and is absent from scans`.
  - `Reachable within hops`: team T -member-> P1 -manages-> P2 -manages-> P3; scope `Person: Reachable({T}, [member Out, manages Out], 2)` → P1, P2 visible, P3 not.
  - `Related ignores invisible neighbors`.
  - `visibility read is recorded`: T1 reads node N visible via `Compare('status', Eq, 'open')`, T2 sets N.status closed and commits, T1 writes anything and commits → `ConflictError`.
- [ ] **Step 2: Run** `npx tsx --test src/access/tests/ReadScope.test.ts` — FAIL.
- [ ] **Step 3: Implement**; update all call sites `BeginRead()`/`Begin()` → `BeginRead(AccessScope.System)`/`Begin(AccessScope.System)`.
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(engine): access scope read enforcement`.

---

### Task 8: Write gate

Write predicates checked at commit before anything is submitted.

**Files:**
- Create: `src/access/WriteGate.ts`, `src/access/AccessError.ts`, `src/access/tests/WriteScope.test.ts`
- Modify: `src/errors/GraphError.ts` (append `AccessDenied = 12`), `src/GraphTransaction.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `AccessScope`, `ScopeEvaluator` (Task 7), `WriteBatch.Ops()`.
- Produces: `AccessError extends GraphError` with `enum AccessErrorCode { CreateDenied = 1, UpdateDenied, DeleteDenied, HiddenMember, InvisibleNode }`, `GraphCode === AccessDenied`, message names op index, public id and concept. `WriteGate.Check(evaluator: ScopeEvaluator, batch: WriteBatch, catalog: CatalogSnapshot): Promise<void>`.
- Rules (pin in tests):
  - Create: applicable `Create` predicates must hold on the node's values at the end of the batch (node-local only; a non-node-local Create predicate → `AccessError CreateDenied` with reason "not node-local" — documented restriction).
  - Update (SetProperty, Link/Unlink as source): node must be visible and applicable `Update` predicates hold on its pre-batch (snapshot) values; nodes created in the same batch are exempt from Update. Link target must be visible (else `InvisibleNode`).
  - Delete: visible and `Delete` predicates hold on pre-batch values.
  - Writing a hidden member → `HiddenMember`.
  - Missing write rules for a concept → allowed iff `scope.Default === Allow`.
  - Seeded read-only at runtime is expressed by the host as `Update/Delete: Not(Seeded())` — test it.
  - The gate's reads are recorded (stale permission conflicts).
  - Gate runs before Submit (and before Prepare, Tasks 9–10); a denied commit consumes no commit number.
- [ ] **Step 1: Write failing tests** `src/access/tests/WriteScope.test.ts` covering each rule above, plus `denied commit leaves graph unchanged and raises no CommitApplied` and `seeded nodes read-only via Not(Seeded())`.
- [ ] **Step 2: Run** `npx tsx --test src/access/tests/WriteScope.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(engine): write gate`.

---

### Task 9: Committer prepare / finalize

Splits commit so connectors can commit between engine validation and engine apply (spec §6, designer's call).

**Files:**
- Create: `src/txn/PreparedCommit.ts`, `src/txn/Reservations.ts`
- Modify: `src/txn/Committer.ts`, `src/txn/tests/Committer.test.ts` (or new `src/txn/tests/Prepare.test.ts`)

**Interfaces:**
- Produces:
  - `Committer.Prepare(batch: WriteBatch, readSet: ReadSet, snapshotCommit: bigint, catalogVersion: number, timeoutMs?: number): Promise<PreparedCommit>` — queued like Submit; in its group turn: history check, catalog version check, id allocation, a dry-run apply inside a `store.Write` that is aborted (throw an internal sentinel) to validate semantics and obtain the batch's `WriteKeySet`; then registers a reservation = the batch's ReadSet ∪ its write keys. Rejects exactly as Submit would (ConflictError / CommitError).
  - `class PreparedCommit { readonly Batch: WriteBatch; Finalize(): Promise<bigint>; Abort(): void; readonly Expired: boolean }` — `Finalize` submits the prepared batch through the normal group path reusing its allocated ids; it resolves with the commit number and releases the reservation. `Abort` releases it. Finalize after Abort/expiry → `ConflictError`.
  - `Committer.DefaultPrepareTimeoutMs = 30000`.
- Rules (pin in tests):
  - While reserved, any other group candidate whose applied write keys intersect the reservation, or whose reads intersect the prepared write keys, is rejected with `ConflictError` (existing BatchFailure re-run mechanism, generalized to carry a ConflictError). Other prepares are checked the same way at their dry-run.
  - Unrelated commits proceed while a prepare is outstanding.
  - A schema change or upgrade may run while reservations exist; the prepared commit then fails Finalize on catalog version (ConflictError) — the caller compensates connectors.
  - Expired reservation is released lazily at the next group and on Finalize.
  - Finalize cannot fail on conflict for a non-expired reservation and an unchanged catalog (test).
- [ ] **Step 1: Write failing tests**:
  - `prepare then finalize commits`, CommitApplied raised once at finalize.
  - `prepare rejects conflicts like submit`.
  - `writer to reserved key conflicts`; `reader of prepared write key conflicts if it commits a write`; `unrelated writer proceeds`.
  - `finalize cannot conflict while reserved` (fuzz: 50 random concurrent submits during the reservation, finalize always succeeds).
  - `abort releases`; `expired reservation releases keys` (timeoutMs 20) and `finalize after expiry conflicts`.
  - `upgrade during reservation fails finalize`.
  - `dry-run leaves no trace` (raw keyspace scan identical before/after Prepare+Abort; id counter may advance).
- [ ] **Step 2: Run** `npx tsx --test src/txn/tests/Prepare.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(engine): committer prepare and finalize`.

---

### Task 10: Connector contract and write-through

Writes to nodes bound to a connector go through that connector's transaction before the engine finalizes (spec §5.3, §6).

**Files:**
- Create: `src/connectors/GraphConnector.ts` (contract), `src/connectors/ConnectorChangeSet.ts`, `src/connectors/BindingTable.ts`, `src/connectors/WriteCoordinator.ts`, `src/connectors/ConnectorError.ts`, `src/connectors/tests/WriteThrough.test.ts`
- Modify: `src/errors/GraphError.ts` (append `ConnectorFailed = 13`), `src/GraphTransaction.ts` (Commit delegates to the coordinator when the context has bindings), `src/GraphContext.ts` (holds `BindingTable` and connectors), `src/index.ts`

**Interfaces:**
- Consumes: `PreparedCommit` (Task 9), `WriteGate` (Task 8), `OwnerOf`/`ConceptOf` (Task 1), `IBindingDescription` (Task 3).
- Produces:
  ```ts
  interface IGraphConnector
  {
      readonly Name: string;
      Begin(): Promise<IConnectorTransaction>;
  }
  interface IConnectorTransaction
  {
      Apply(changes: ConnectorChangeSet): Promise<void>;
      Commit(): Promise<void>;
      Revert(): Promise<void>;           // legal before and after Commit; after Commit means compensate
  }
  class ConnectorChangeSet               // immutable, per connector
  {
      readonly Changes: readonly ConnectorChange[];    // in batch op order
  }
  type ConnectorChange = BatchOp & { readonly Owner: string; readonly Concept: string };
  ```
  - `BindingTable.Resolve(owner: string, concept: string): string | undefined` — most specific wins: (Model = owner, Concept = concept or an ancestor/aspect of it, nearest first) → (Model = owner, no Concept) → `DefaultConnector` → undefined. A resolved name equal to `BindingTable.EngineStorage = 'engine'` or undefined means engine-only (no connector participates).
  - Routing: CreateNode/SetProperty/DeleteNode by the node's owner+concept (from the batch for nodes it creates, else the snapshot); Link/Unlink by the SOURCE node (spec §5.4).
  - `ConnectorError extends GraphError` (`ConnectorFailed`) with `Connector: string`, `Phase: ConnectorPhase` (`Begin | Apply | Commit | Finalize`), `cause`.
- Flow (pin in tests): gate → if no participant, plain Submit → else Prepare → Begin all participants (sorted by connector name) → Apply each → Commit each → Finalize. Any failure or Prepare timeout → Revert every connector that began (including committed ones, in reverse order), Abort the prepared commit, throw ConnectorError (or the original ConflictError/CommitError/AccessError when the engine rejected before any connector began). A Revert that throws is reported as an `AggregateError` cause, never swallowed. Connector calls run outside the committer's Write (never inside `store.Write`).
- [ ] **Step 1: Write failing tests** with a recording fake connector (`FakeConnector` in the test folder, configurable to fail/hang per phase):
  - `engine-only bindings never call connectors`.
  - `binding resolution: model+concept beats model beats default`; `aspect binding applies to carriers`.
  - `change set carries owner, concept, op order`; `link routed by source owner`.
  - `two connectors: both commit then engine finalizes`; success visible to a new reader only after all commits.
  - `apply failure reverts all and engine unchanged`; `second commit failure reverts first (compensate)`.
  - `engine conflict at prepare: no connector began`.
  - `timeout reverts connectors`: connector hangs in Commit longer than timeoutMs → its transaction reverted after it returns, ConnectorError Phase Commit, graph unchanged.
  - `revert failure surfaces`.
- [ ] **Step 2: Run** `npx tsx --test src/connectors/tests/WriteThrough.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(engine): connector write-through`.

---

### Task 11: GraphEngine facade

The single entry point hosts use (spec §4.2, §9).

**Files:**
- Create: `src/GraphEngine.ts`, `src/tests/GraphEngine.test.ts`
- Modify: `src/index.ts` (export `GraphEngine` and every public type from Tasks 1–10), `README` section if present, `docs/format/on-disk-format.md` (summary of new keys), `docs/decisions.md`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  enum StorageKind { Memory = 1, Lmdb = 2 }
  interface IEngineStorage { readonly Kind: StorageKind; readonly Path?: string; readonly Lmdb?: ILmdbOptions }
  interface IGraphEngineOptions
  {
      readonly Description: ISchemaDescription;
      readonly Storage: IEngineStorage;
      readonly Connectors?: readonly IGraphConnector[];   // names must be unique; bindings must name a registered connector or 'engine'
      readonly PrepareTimeoutMs?: number;
  }
  class GraphEngine
  {
      static Open(options: IGraphEngineOptions): Promise<GraphEngine>;   // open/create store, Upgrade(description) (no-op when SchemaVersion matches), then running
      Upgrade(description: ISchemaDescription): Promise<IUpgradeCommit>;   // hot upgrade (dev recompile); replaces bindings atomically after the commit
      BeginRead(scope: AccessScope): Promise<GraphReader>;
      Begin(scope: AccessScope): Promise<GraphTransaction>;
      readonly CommitApplied: ISignal<ICommitApplied>;
      ReadChanges(afterCommit: bigint): AsyncIterable<ICommitApplied>;
      readonly SchemaVersion: string;
      readonly Catalog: CatalogSnapshot;
      dispose(): Promise<void>;
  }
  ```
  - Open errors: unknown connector name in a binding → `GraphError InvalidArgument` before the store is touched; any upgrade failure closes the store and rethrows.
  - `GraphStore` stays as the low-level store (used by tests); `GraphStore.DefineSchema` is kept but `GraphEngine` never uses it.
- [ ] **Step 1: Write failing tests** `src/tests/GraphEngine.test.ts` (both backends):
  - `first run creates and seeds`; `reopen with same description does nothing` (no CommitApplied, data intact); `reopen with changed description upgrades and discards` (end-to-end of Tasks 4–5 through the facade, LMDB reopen in a fresh process using the existing `DurabilityChild.ts` pattern).
  - `hot upgrade swaps bindings` (write after upgrade goes to the newly bound connector).
  - `scoped read and gated write through the facade`.
  - `connector write-through through the facade`.
  - `binding to unknown connector rejects before opening`.
  - Export surface test: every name listed in this task is exported from `src/index.ts`; no internal class (`Committer`, `IndexStore`, `DataPurger`, `ScopeEvaluator`, `WriteCoordinator`) is exported.
- [ ] **Step 2: Run** `npx tsx --test src/tests/GraphEngine.test.ts` — FAIL.
- [ ] **Step 3: Implement**; update `docs/format/on-disk-format.md` (Index keyspace, Owner, Seed, schemaVersion, Upgrade log entry) and append rulings to `docs/decisions.md`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build` — PASS.
- [ ] **Step 5: Commit** `feat(engine): GraphEngine facade`.
