# Cypher on the engine (milestone 1, plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port TODL's Cypher stack (`TODL/src/cypher`, ~6.9k lines, ~490 tests) into pragmatic-graph so queries and writes run directly on `GraphEngine` readers and transactions under an `AccessScope`, with label extents that include aspect carriers, index seeks, and read-your-writes inside a query.

**Architecture:** New area `src/cypher/` in pragmatic-graph. The pure front end (lexer, parser, query model, fluent builder, unparser, expressions, functions, values, aggregators) is copied and de-TODL'd. The graph contract becomes async (`ICypherSource`) and is implemented over `GraphReader`; operators become async iterators; writes go to a `GraphTransaction` through a query-level overlay. Hosts supply id/owner placement for `CREATE`.

**Tech Stack:** TypeScript 7, Node, `tsx --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-graph-consolidation-design.md` §6 (read-your-writes call), §8. Depends on plan 1 (`docs/superpowers/plans/2026-11-06-engine-core-consolidation.md`) being merged: `GraphEngine`, `AccessScope`, `ScanNodes`, `SeekIndex`, `ConceptOf`, `OwnerOf`, `EstimateCount`.

**Staging (designer's call):** TODL's `src/cypher` stays untouched in this plan. The server still runs on it, and a parallel agent is working there. The engine copy becomes the only one in the server plan (plan 4), which switches the server over and deletes TODL's copy, `GraphQueryAdapter`, `WriteOverlay` and `ModelDraftWriter`. `push-down.ts` is not ported: it feeds connector prefetch, which is retired in milestone 2.

**Out of scope:** connector fetch operators (M2), cursors/keyset paging (server plan), TODL's `MirrorSnapshot` cell shape (TODL plan maps the engine cell to it).

## Global Constraints

- Engine layering: `src/cypher` imports only from pragmatic-graph and node built-ins. No TODL type, name or concept (no `IInstanceMirror`, `Scalar`, `MirrorSnapshot`, `ReflectedEntity`).
- Code style per `CLAUDE.md`: OOP, Allman braces, PascalCase public members, `private static readonly` constants, enums for value sets, `dispose()`.
- Public storage-facing APIs async; no live references into storage.
- Every engine error stays a `GraphError`; Cypher errors keep TODL's hierarchy (`CypherError`, `CypherSyntaxError`, `CypherSemanticError`, `CypherTimeout`, `CypherWriteError`), with `CypherWriteError.cause` carrying the engine `GraphError`.
- Tests in `src/cypher/tests/`. Each task ends with `npm test` and `npm run typecheck` green; rulings appended to `docs/decisions.md` (R-next).
- Fix every review finding, including minors.

## Review Focus

1. A query whose `MATCH` names an aspect label: carriers of the aspect (direct and via subtypes) must be returned, the same set `Repository.IsA` gives. → Task 3 test `aspect label scans carriers`.
2. A node hidden by the scope that is reachable by `Expand` from a visible node: it must not appear, and a `count()` over the pattern must not include it. → Task 3 test `expand skips invisible targets`, `count excludes invisible`.
3. `CREATE` then `MATCH` of the created node in the same query (read-your-writes) while R30 forbids the transaction from seeing it: the overlay must return it with its properties. → Task 5 test `created node visible later in same query`.
4. A write query that fails half-way (e.g. second `SET` violates non-nullable): no partial write may be committed and no connector called. → Task 5 test `failed write query commits nothing`.
5. Integer handling: a JSON parameter `2` compared with a Float64 member `2.0` must match; a bigint outside 2^53 must survive the result encoding. → Task 2 test `int and float compare numerically`, Task 6 test `large int round-trips`.

---

### Task 1: Reader support for the query layer

**Files:**
- Modify: `src/GraphReader.ts`, `src/catalog/CatalogSnapshot.ts`
- Test: `src/tests/QueryReads.test.ts`

**Interfaces:**
- Consumes: plan 1 `GraphReader` (scoped), `ScanNodes`, `ConceptOf`, `OwnerOf`.
- Produces:
  - `GraphReader.ReadNode(publicId: string): Promise<INodeView | undefined>` with `interface INodeView { readonly PublicId: string; readonly Concept: string; readonly Owner: string; readonly Properties: ReadonlyMap<string, CellValue> }` — all effective non-hidden properties (null for unset); `undefined` when missing or invisible. Records `Node` + `Cell` keys.
  - `GraphReader.Links(publicId: string, direction: EdgeDirection): Promise<readonly ILinkView[]>` with `interface ILinkView { readonly Relationship: string; readonly PublicId: string }` — every relationship effective on the node, in relationship declaration order, then edge order; invisible targets omitted; hidden relationships omitted.
  - `CatalogSnapshot.IsA(concept: string, conceptOrAspect: string): boolean` (self, ancestor or carried aspect), `CatalogSnapshot.Relationships(): readonly string[]` (distinct names), `CatalogSnapshot.Names(): readonly string[]` (concepts and aspects).
- [ ] **Step 1: Write failing tests** (both backends): `ReadNode returns null for unset properties`; `ReadNode hides hidden members` (scope Hidden `{Server: {secret}}` → no `secret` key); `ReadNode of invisible node is undefined`; `Links covers every relationship in declaration order`; `Links omits invisible targets`; `IsA follows parent and aspects`; `ReadNode records reads` (T1 ReadNode, T2 sets a property, T1 commits a write → `ConflictError`).
- [ ] **Step 2: Run** `npx tsx --test src/tests/QueryReads.test.ts` — FAIL.
- [ ] **Step 3: Implement** over the existing column/edge reads; reuse the scope evaluator from plan 1 Task 7.
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(engine): node and link reads for the query layer`.

---

### Task 2: Port the pure front end

Copy, de-couple, keep behaviour.

**Files:**
- Create `src/cypher/` from TODL `src/cypher/`: `lexer.ts`, `parser.ts`, `query-model.ts`, `patterns.ts`, `fluent.ts`, `unparser.ts`, `expressions.ts`, `functions.ts`, `aggregators.ts`, `values.ts`, `values-structured.ts`, `binding.ts`, `enums.ts`, `errors.ts`, `execution-limits.ts`, `parameter-binder.ts`, `referenced-labels.ts`. File names switch to the engine's PascalCase-class-per-file convention (e.g. `Lexer.ts`, `CypherParser.ts`).
- Create: `src/cypher/CypherNode.ts`
- Tests: port the pure TODL test files (aggregators, errors, execution-limits, expressions, expressions-sp2, fluent, fluent-sp2, functions, lexer, parser, parser-expr, parser-sp2, path-functions, query-model, query-model-sp2, referenced-labels, value-ordering, values, values-structured, write-parse, write-roundtrip) into `src/cypher/tests/`.

**Interfaces:**
- Produces:
  - Scalars are engine `CellValue` (minus `null`, which is `NullValue`). TODL's `Scalar` disappears. Integer literals parse to `bigint` (Int64), decimal literals to `number`. Arithmetic: int∘int → bigint (overflow beyond Int64 → `CypherError` `IntegerOverflow`), any float operand → number. Comparison and equality: Int64 vs Float64 compare numerically (same rule as plan 1 predicates); other cross-type comparisons are false/null as today. Date/DateTime/Duration values compare per plan 1 Task 2 rules.
  - `class CypherNode { readonly PublicId: string; readonly Concept: string; readonly Owner: string; readonly Properties: ReadonlyMap<string, CellValue>; Links?: readonly ILinkView[] }` (immutable except the one-time `Links` fill in Task 6). `NodeValue` wraps a `CypherNode` (replaces `IInstanceMirror`); `NodeValue.Field(name)` reads `Properties`. `NodeValue.Reader()/AsEntity()/ToDto()`'s TODL coupling is removed (`ToDto` moves to the codec, Task 6).
  - `ParameterBinder`: JSON numbers that are safe integers → bigint; other numbers → number; `{ "$date": "YYYY-MM-DD" }`, `{ "$datetime": "<ISO-8601 instant>", "zone": "<IANA>" }`, `{ "$duration": "<ISO-8601 duration>" }` → engine values.
- [ ] **Step 1: Port the listed tests** (adjust only for bigint literals and the `CypherNode` stub); add `int and float compare numerically` (`2n = 2.0` true, `2n < 2.5` true), `integer literal is bigint`, `int overflow raises IntegerOverflow`, `date parameter binds`.
- [ ] **Step 2: Run** `npx tsx --test "src/cypher/tests/**/*.test.ts"` — FAIL (modules missing).
- [ ] **Step 3: Port the sources.** Rewrite to the engine style rules while copying (TODL is already OOP; mostly braces and file layout). No behaviour change beyond the numeric rules above.
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS. Record the ported test count vs TODL's in the commit message.
- [ ] **Step 5: Commit** `feat(cypher): port parser, query model and expressions`.

---

### Task 3: Async source and read operators

**Files:**
- Create: `src/cypher/CypherSource.ts` (contract), `src/cypher/ReaderSource.ts`, `src/cypher/LabelResolver.ts`
- Port (async): `operators.ts`, `operators-aggregate.ts`, `operators-join.ts`, `operators-optional.ts`, `operators-ordering.ts`, `operators-unwind.ts`, `operators-varlength.ts`, `planner.ts`
- Test: port `operators`, `operators-varlength`, `planner`, `operators-*` tests; new `src/cypher/tests/ReaderSource.test.ts`; `src/cypher/tests/CypherFixture.ts` (test helper building a `GraphEngine` on Memory storage from a definitions + seed literal)

**Interfaces:**
- Consumes: Task 1 reads; plan 1 `GraphEngine`, `AccessScope`.
- Produces:
  ```ts
  interface ICypherSource
  {
      ResolveLabel(label: string): string;                                 // CypherSemanticError if unknown/ambiguous
      HasRelationship(name: string): boolean;
      IsA(node: CypherNode, label: string): boolean;
      ScanLabel(label: string): AsyncIterable<CypherNode>;                 // label = resolved name; aspects include carriers
      ScanAll(): AsyncIterable<CypherNode>;
      Node(publicId: string): Promise<CypherNode | undefined>;
      Expand(publicId: string, relationship: string | undefined, direction: RelDirection): AsyncIterable<IExpandRow>;
      SeekEqual(label: string, member: string, value: CellValue): AsyncIterable<CypherNode> | undefined; // undefined → no usable index
  }
  interface IExpandRow { readonly Relationship: string; readonly Target: CypherNode }
  ```
  - `IOperator.Rows(): AsyncIterable<Binding>`.
  - `LabelResolver`: exact catalog name wins; else unique match of the label against the segment after the last `.` of every name; ambiguous or unknown → `CypherSemanticError` (same messages as TODL's `GraphQueryAdapter.ResolveLabel`).
  - `ReaderSource(reader: GraphReader)` implements `ICypherSource`; all reads go through the scoped reader, so invisible nodes never surface and hidden members are absent.
- Rules (pin in tests): label matching uses `CatalogSnapshot.IsA` (parent chain and aspects) everywhere a label is checked (scan, expand target, label filter, var-length). Expand with no relationship walks `Links`. Result order without `ORDER BY` follows scan order (concept then slot), stable across runs.
- [ ] **Step 1: Write failing tests**: ported operator/planner tests over `CypherFixture`; plus `aspect label scans carriers` (Server, Laptop carry Asset; Person not → `MATCH (a:Asset) RETURN a` yields Server and Laptop nodes, subtypes of Server included); `simple-name label resolves` / `ambiguous simple name throws`; `expand skips invisible targets`; `count excludes invisible`; `hidden member reads null in RETURN`.
- [ ] **Step 2: Run** `npx tsx --test "src/cypher/tests/**/*.test.ts"` — FAIL.
- [ ] **Step 3: Implement.** Expressions stay synchronous: every node is fully loaded (`ReadNode`) when it is bound, so `PropertyAccess` never awaits.
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(cypher): async operators over the engine reader`.

---

### Task 4: Index seek in the planner

**Files:**
- Modify: `src/cypher/Planner.ts`, `src/cypher/ReaderSource.ts`
- Create: `src/cypher/operators/IndexSeek.ts`
- Test: `src/cypher/tests/IndexSeek.test.ts`

**Interfaces:**
- Consumes: plan 1 `SeekIndex`, `CatalogSnapshot.IndexesOn`.
- Produces: `ReaderSource.SeekEqual` returns an iterable when a non-partial index exists whose leading member is the property and whose `On` is the label itself or an ancestor/aspect of it; seek results are filtered by `IsA(label)`. `CypherEngine.Explain(text): string` (operator tree, one line per operator) for tests.
- Rules: an inline property map or a top-level `AND` equality `v.p = literal|$param` on a freshly bound labelled node becomes `IndexSeek` + the remaining filters; anything else keeps `LabelScan` + `Filter`. Results identical either way (ordering may differ; tests compare as sets unless `ORDER BY`).
- [ ] **Step 1: Write failing tests**: `inline property uses index` (Explain shows `IndexSeek(name)`); `where equality uses index`; `partial index never used`; `no index falls back to scan`; `seek and scan agree` (same query with and without index → same set); `seek respects scope` (invisible node not returned).
- [ ] **Step 2: Run** `npx tsx --test src/cypher/tests/IndexSeek.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(cypher): index seek for equality`.

---

### Task 5: Writes, overlay and placement

**Files:**
- Create: `src/cypher/write/NodePlacement.ts` (contract), `src/cypher/write/PendingOverlay.ts`, `src/cypher/write/OverlaySource.ts`, `src/cypher/write/TransactionSink.ts`
- Port (async): `operators-write.ts`, `writer.ts` (`CypherWriteStats` only; `ICypherWriter` is replaced)
- Test: port `write-execute`, `write-operators`, `write-stats` tests; new `src/cypher/tests/WriteOverlay.test.ts`

**Interfaces:**
- Consumes: plan 1 `GraphTransaction` (scoped, write-through, gate), `ICreateNodeOptions { Owner }`.
- Produces:
  ```ts
  interface INodePlacement
  {
      Place(concept: string, properties: ReadonlyMap<string, CellValue>): { readonly PublicId: string; readonly Owner: string };
  }
  ```
  `GuidPlacement` (default: `crypto.randomUUID()`, owner `''`) is the engine's built-in.
  - `PendingOverlay` records the query's creates, property sets, deletes, links and unlinks; `OverlaySource` implements `ICypherSource` = transaction snapshot reader + overlay (created nodes appear in scans/expands of matching labels, set properties override, deleted nodes and unlinked edges disappear). Replaces TODL's `WriteOverlay`.
  - `TransactionSink` maps write operators onto `GraphTransaction`: CreateNode (with placement's id/owner), SetProperty, RemoveProperty → SetProperty(null), CreateRelationship → Link (returns false and does nothing when the edge already exists in the overlay view), DeleteRelationship → Unlink, DeleteNode (detach → unlink every edge first; non-detach with edges → `CypherWriteError` `NodeHasRelationships`). Reference replace keeps TODL's semantics (Expand out, unlink all, link new).
- Rules: R30 holds for the engine transaction; read-your-writes exists only through the overlay. Nothing reaches the transaction until the mutation pipeline drained without error; then one `Commit()`. Engine errors at commit map to `CypherWriteError` with the `GraphError` as `cause` (`ConflictError` → code `Conflict`, `AccessError` → `Denied`, `CommitError` → `Invalid`, `ConnectorError` → `ConnectorFailed`).
- [ ] **Step 1: Write failing tests**: ported write tests; `created node visible later in same query` (`CREATE (n:Server {name:'a'}) WITH n MATCH (m:Server {name:'a'}) RETURN m`); `set then read in same query sees new value`; `deleted node not matched later`; `failed write query commits nothing` (second SET of null on non-nullable → error, `ReadChanges` shows no new commit, fake connector never began); `placement supplies id and owner`; `denied write maps to CypherWriteError Denied with cause`; `merge does not duplicate edge`.
- [ ] **Step 2: Run** `npx tsx --test "src/cypher/tests/**/*.test.ts"` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(cypher): writes through engine transactions`.

---

### Task 6: Engine entry point, results and cell codec

**Files:**
- Port: `engine.ts` → `src/cypher/CypherEngine.ts`, `result.ts`, `cell-codec.ts`
- Modify: `src/index.ts` (export namespace `Cypher`)
- Test: port `engine`, `engine-paging`, `engine-sp2`, `cell-codec`, `qualified-label`, `label-simple-name`, `orderby-structural-key`, `planner-sp2`, `unparser-roundtrip`, `varlength-parse-plan`, `public-surface` tests onto `CypherFixture`; new `src/cypher/tests/CellCodec.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  ```ts
  interface ICypherRunOptions { readonly Parameters?: ReadonlyMap<string, ParameterValue>; readonly Limits?: ExecutionLimits; readonly Placement?: INodePlacement }
  class CypherEngine
  {
      constructor(engine: GraphEngine);
      Execute(scope: AccessScope, source: string | CypherQuery, options?: ICypherRunOptions): Promise<CypherResult>;
      Explain(source: string | CypherQuery): string;
  }
  ```
  - Read-only queries open `BeginRead(scope)`; queries with write clauses open `Begin(scope)` and commit. The reader/transaction is disposed in every outcome.
  - Before results are returned, every `NodeValue` reachable in a row (including inside lists, maps, paths) gets `Links(publicId, Out)` filled once (through the same scoped reader / overlay), so `ToDto` is synchronous.
  - `CypherResult` / `CypherResultDto { Columns, Rows, Truncated, HasMore, Stats? }` keep TODL's shape and paging semantics (`engine-paging` tests).
  - Node cell (engine-neutral, replaces `{ $node: MirrorSnapshot }`): `{ "$node": { "id": string, "concept": string, "owner": string, "properties": Record<string, CellDto>, "links": Record<string, string[]> } }`. Relationship cell `{ from, type, to }` as today. Map escaping (`$map`) as today.
  - Value cells: safe-range Int64 and Float64 → JSON number; Int64 outside ±(2^53−1) → `{ "$int": "<decimal>" }`; Date `{ "$date": "YYYY-MM-DD" }`; DateTime `{ "$datetime": "<ISO instant>", "zone": "<IANA>" }`; Duration `{ "$duration": "<ISO-8601>" }`. `CypherCellCodec.Decode` is the exact inverse. Maps whose only key is one of these tags are `$map`-escaped.
  - The whole TODL public surface is exported under `Cypher` except `GraphQueryAdapter`, `ICypherGraph`, `ICypherWriter`, `CypherPushDown`, `CypherQueryFilterProvider`, `GraphQuerySchema`, `ICypherSchema` (TODL-only, retired in plan 4 / M2); `ICypherSource`, `INodePlacement`, `GuidPlacement`, `CypherNode` are added.
- [ ] **Step 1: Write failing tests**: ported suites; `node cell carries owner, properties, links`; `large int round-trips` (`2n**60n` → `{ $int }` → decode equal); `tag-shaped map is escaped`; `reader disposed after error`; `write query commits once` (one CommitApplied).
- [ ] **Step 2: Run** `npm test` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build` — PASS. Commit message lists ported vs TODL test counts per file and every dropped case with its reason (only cases asserting `GraphQueryAdapter`/`IGraphQuery`/`MirrorSnapshot`/push-down specifics may be dropped).
- [ ] **Step 5: Commit** `feat(cypher): engine entry point and cell codec`.

---

### Task 7: Package release prep

**Files:**
- Modify: `package.json` (version `0.1.0`), `README.md` (Cypher section: entry point, scope, placement, cell format), `docs/decisions.md`

- [ ] **Step 1:** Bump to `0.1.0` (plans 1–2 change the public API: scoped `Begin`/`BeginRead`, `GraphEngine`, `Cypher`).
- [ ] **Step 2: Run** `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run` — PASS; tarball contains only `dist`.
- [ ] **Step 3: Commit** `chore: 0.1.0`. Publishing needs the user's explicit go.
