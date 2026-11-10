# External bindings on the engine (milestone 2, plan 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a binding's data live only in an external system: the engine reads it on demand through the connector contract's read side (fetch, key lookup, reverse lookup), scopes and filters it like its own data, links engine nodes to it, writes it through the connector, and pages any query with a keyset cursor.

**Architecture:** Connectors declare a residency. Mirrored connectors (TodlFileConnector) keep today's behaviour. External connectors add `Capabilities` and `Fetch`, and their nodes are never stored in engine KV, except identity-only *stub* nodes that engine-resident nodes link to. Cypher reads through a new `FederatedSource` (an `ICypherSource`) that unions the scoped `ReaderSource` with a per-query `FetchSession`, resolves stubs through key lookups, and evaluates the access scope on fetched rows in Kleene logic. Writes to external nodes go to the connector only, gated against the fetched row. Paging gains an opaque keyset cursor over the result's total order.

**Tech Stack:** TypeScript 7, Node (`node:test`), lmdb-js. Tests via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-11-06-graph-consolidation-design.md`: §5.2–§5.4, §6, §7, §8 (fetch operators, cursors), §11.1 (milestone 2 decisions) and §12 ("two consecutive queries each fetch"). Also binding: `docs/decisions.md` (R1–R95) and `docs/format/on-disk-format.md`.

**Out of scope (later M2 plans):** adapting TODL's adapters (SQL, document, REST, Neo4j) to this contract, the environment union catalog, and `PolicyScopeCompiler.FromRules` (M2.2, TODL). The runtime environment host, endpoints, shares-as-graph-data wiring and data-changed push (M2.3, server). Shares need nothing from this plan beyond `Related` over engine nodes, which exists.

## Design rulings (record each as R96+ in the task that implements it)

- **D1 Residency.** `IGraphConnector.Residency?: ConnectorResidency` (`Mirrored = 1`, the default when absent; `External = 2`). An External connector implements `IExternalConnector`. `GraphEngine.Open`/`Upgrade` rejects with `GraphError InvalidArgument`: an External connector named as `DefaultConnector` (a fetch needs a concrete model), and a binding to a connector whose `Residency` is External but which lacks `Fetch`/`Capabilities`.
- **D2 Nothing external is stored.** The only exception is a stub: an identity-only node (public id, concept, owner, no property cells) created when an engine-resident node links to an external node. A stored node is a stub iff `BindingTable.Resolve(owner, concept)` names an External connector. A stub is deleted in the same batch that removes its last edge. Reads never surface a stub's own (empty) data. A stub is resolved through a key-lookup fetch, and a stub the connector no longer has is **dangling**: `Node` is undefined, its links are omitted, no error.
- **D3 Fetch lifetime.** One `FetchSession` per Cypher read (`Execute` without writes) and per `GraphTransaction`. Within it, key lookups and fetched rows are memoised by public id, so one query sees one consistent value per external node. Nothing outlives the session (spec §5.2, §12). Connector resume tokens are used only inside a session to drain a fetch page by page.
- **D4 Push-down is advisory.** `FetchRequest.Predicate` is `And(scope row predicate for the fetched concept, query hint)`. The connector may apply any part of it or none. The engine always evaluates the scope (D5) and every query filter on each returned row, so correctness never depends on the connector.
- **D5 Scoping fetched rows (Kleene).** Values, `IdIn`, `OwnerIs` and `ConceptIs` are known; `Seeded` is False.
  - `Related` Out is evaluated over the row's links. A target that is an engine-resident node is decided as today. An external target is Unknown, except when `Target` is True.
  - `Related` In is decided through the stub's engine edges when a stub exists. With no stub it is False, unless some External binding could hold a source of that relationship, in which case it is Unknown.
  - `Reachable` is True when the id is in `From`. Otherwise it is decided through the stub (engine BFS) when a stub exists, else Unknown.
  - Unknown at the top means not visible. Hidden members are removed from the row before it becomes a `CypherNode`.
- **D6 Row validation.**
  - A row whose `(Model, Concept)` resolves to a different connector is dropped silently, because a more specific binding owns it.
  - A row whose `Concept` is not defined, is an aspect, or is not the requested concept (or a subtype of it) fails the query with `ConnectorError` (`Phase = Fetch`), cause `GraphError SchemaViolation`. So does a row that carries a value for a non-property member or a value `ValueCodec.Check` rejects, and a row whose public id is invalid (empty, or over 400 UTF-8 bytes).
  - Members the row omits are absent (null).
- **D7 External writes.** Create, SetProperty, SetDefault, DeleteNode, and Link/Unlink whose source is an External node become connector changes only, with no KV write. `WriteGate` evaluates Update and Delete rules against the session's fetched row, which must be visible: an invisible or missing row is `AccessDenied`, as for engine nodes. Create rules are evaluated as today.
  - **No OCC for external rows** (spec §6 consistency note).
  - **External delete:** engine edges into the deleted node's stub are unlinked in the same batch, each routed to its source's binding (R89), and the stub is removed.
- **D8 Keyset cursor.** `CypherCursor { Commit: bigint; After: readonly CypherValue[] }`, encoded as an opaque string by `CypherCursor.Encode`/`Decode`.
  - A paged read (`Limits.RowCap` with `Limits.After` or `Limits.Skip`) uses the implicit total order (R86). With `After` it returns rows strictly greater than `After` in that order, and `CypherResult.NextCursor` carries the last row's key when `HasMore`.
  - The cursor records the snapshot commit it was cut at. Resuming at a later commit is legal, because keyset positions stay correct. `CypherResult.Commit` exposes the current snapshot so hosts can apply their own staleness policy.
  - `Skip` stays supported. `After` and `Skip` together are `GraphError InvalidArgument`.
- **D9 Engine storage default.** Runtime descriptions set `DefaultConnector: BindingTable.EngineStorage` (already accepted). Plan 1 adds the test and the doc sentence, and no new class: "EngineStorageConnector" is this binding.

## Global Constraints

- Engine is the lowest layer: no import from TODL, Mural, server or identity; only runtime dependency `lmdb`.
- OOP: no module-level free functions or mutable module state; Allman braces; PascalCase interfaces and public methods; reused literals `private static readonly` PascalCase; fixed value sets are enums.
- Every deliberate error is a `GraphError` with a `GraphErrorCode` (F8); new enum members are appended, never renumbered (`ConnectorPhase.Fetch` appended).
- Format version stays 1 (unfrozen); stubs need no new key (they are ordinary nodes with no cells) — document that in `docs/format/on-disk-format.md`.
- Public storage APIs are async and never return live references; teardown through `dispose()`.
- Tests in `src/<area>/tests/*.test.ts`; storage-touching tests run on MemoryStore and LMDB (existing dual-backend pattern).
- Each task ends green: `npm test` and `npm run typecheck`. Append the task's rulings to `docs/decisions.md` (R96+).
- Fix every review finding, including minors; never defer.

## Review Focus

1. A connector returns a row of a concept it was not asked for, with a mistyped value, or for a model a more specific binding owns: wrong-concept and mistyped rows must fail loudly, and foreign-binding rows must be dropped. → Task 2 tests `wrong concept fails the query`, `mistyped value fails the query`, `row owned by a more specific binding is dropped`.
2. A fetch throws halfway through a scan: the query must fail with `ConnectorError` (`Phase Fetch`) and must not return a partial result. → Task 2 test `fetch failure mid-iteration fails the query`.
3. The same external node is reached twice in one query, once by scan and once by expand: there must be one key lookup and one consistent value. Across two queries there must be two fetches. → Task 2 tests `session memoises key lookups`, `two sessions each fetch`.
4. An engine node links to an external node that was later deleted at the source: the link reads as dangling, with Expand yielding nothing, OutLinks omitting it, and no error. → Task 5 test `dangling external target is omitted`.
5. A scope with `Related`/`Reachable` over external rows must fail closed (not visible) when undecidable, never open. → Task 3 tests `Related in over external source is Unknown`, `Reachable without stub is Unknown`.

---

### Task 1: Connector read contract and residency

**Files:**
- Modify: `src/connectors/GraphConnector.ts`, `src/connectors/ConnectorError.ts` (append `ConnectorPhase.Fetch = 'Fetch'`), `src/connectors/BindingTable.ts`, `src/GraphEngine.ts` (CheckBindings), `src/index.ts`
- Create: `src/connectors/FetchContract.ts`
- Test: `src/connectors/tests/FetchContract.test.ts`, extend `src/connectors/tests/WriteThrough.test.ts`

**Interfaces:**
- Produces (in `FetchContract.ts`, all exported from `src/index.ts`):
  - `enum ConnectorResidency { Mirrored = 1, External = 2 }`
  - `interface IConnectorCapabilities { readonly KeyLookup: boolean; readonly ReverseLookup: boolean; readonly PushDown: ReadonlySet<PredicateKind> }` (advisory, D4)
  - `interface IFetchRequest { readonly Model: string; readonly Concept: string; readonly Predicate: Predicate; readonly Members: readonly string[]; readonly Keys?: readonly string[]; readonly Reverse?: { readonly Relationship: string; readonly Target: string }; readonly Limit?: number; readonly Resume?: string }`
  - `interface IFetchedRow { readonly PublicId: string; readonly Concept: string; readonly Values: ReadonlyMap<string, CellValue>; readonly Links: ReadonlyMap<string, readonly string[]> }` (Links: relationship → target public ids, declaration order)
  - `interface IFetchPage { readonly Rows: readonly IFetchedRow[]; readonly Resume?: string }`
  - `interface IExternalConnector extends IGraphConnector { readonly Residency: ConnectorResidency.External; readonly Capabilities: IConnectorCapabilities; Fetch(request: IFetchRequest): Promise<IFetchPage> }`
  - `IGraphConnector` gains `readonly Residency?: ConnectorResidency`.
  - `BindingTable.ExternalTargets(concept: string, catalog: CatalogSnapshot, external: ReadonlySet<string>): readonly IFetchTarget[]` with `interface IFetchTarget { readonly Model: string; readonly Concept: string; readonly Connector: string }`: one entry per binding whose connector is in `external` and whose concept is `concept`, a subtype, or an ancestor of it (an ancestor binding fetches with `Concept = concept`); model-wide external bindings yield `Concept = concept`. Ordered by model, then concept.
  - `BindingTable.IsStub(owner: string, concept: string, catalog: CatalogSnapshot, external: ReadonlySet<string>): boolean`.

- [ ] **Step 1: Failing tests** in `FetchContract.test.ts`:
  - `open rejects an external default connector`: an External connector named as `DefaultConnector` makes `GraphEngine.Open` reject with `GraphError InvalidArgument`, before storage is touched.
  - `open rejects external residency without Fetch`: a connector with `Residency: External` but no `Fetch` is rejected with `InvalidArgument`.
  - `mirrored is the default residency`: a connector without `Residency` still write-throughs exactly as before (reuse a `WriteThrough.test.ts` scenario).
  - `ExternalTargets covers subtypes, ancestors and model-wide`: bindings `(m1, Server)→ext`, `(m2, Asset)→ext` (model-wide on `m3`→ext); `ExternalTargets('Server')` equals `[{m1,Server,ext},{m2,Server,ext},{m3,Server,ext}]`, and `ExternalTargets('Laptop')` (a sibling of Server under Asset) excludes m1.
  - `engine storage as default`: a description with `DefaultConnector: BindingTable.EngineStorage` and no bindings writes without any connector participating (D9).
- [ ] **Step 2: Run** `npx tsx --test src/connectors/tests/FetchContract.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 3: Implement** the contract types, `BindingTable.ExternalTargets`/`IsStub`, and the Open/Upgrade checks (D1). Document D9 in the `BindingTable` class comment.
- [ ] **Step 4: Run** the task's tests, then `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Append R96 (D1) and R97 (D9) to `docs/decisions.md`, then commit `feat(connectors): read contract and residency`.

### Task 2: FetchSession

**Files:**
- Create: `src/connectors/FetchSession.ts`
- Test: `src/connectors/tests/FetchSession.test.ts`, `src/connectors/tests/FakeExternalConnector.ts` (scripted pages, fetch log, throw-at-call-N)

**Interfaces:**
- Consumes: Task 1 contract types; `IReadProbe` (`src/GraphReader.ts`).
- Produces: `class FetchSession` with:
  - `constructor(connectors: ReadonlyMap<string, IExternalConnector>, bindings: BindingTable, catalog: CatalogSnapshot)`
  - `Scan(target: IFetchTarget, predicate: Predicate, members: readonly string[], probe?: IReadProbe): AsyncIterable<IFetchedRow>`: drains pages through `Resume` and ticks the probe once per row.
  - `Lookup(publicId: string, candidates: readonly IFetchTarget[]): Promise<IFetchedRow | undefined>`: memoised. It asks candidates in order with `Keys: [publicId]` and stops at the first hit; the miss is memoised too.
  - `Reverse(target: IFetchTarget, relationship: string, targetId: string): AsyncIterable<IFetchedRow>`: requires `Capabilities.ReverseLookup`, and yields nothing otherwise.
  - Rows from `Scan`/`Reverse` populate the lookup memo.
- Every connector throw is wrapped as `new ConnectorError(name, ConnectorPhase.Fetch, cause)`. Row validation follows D6.

- [ ] **Step 1: Failing tests**:
  - `session memoises key lookups`: two `Lookup('x', …)` calls make one connector call.
  - `two sessions each fetch`: the same scan in two sessions makes two connector calls (§12).
  - `scan drains resume tokens`: a scripted three pages yields all rows in order.
  - `wrong concept fails the query`, `mistyped value fails the query` and `invalid public id fails the query` each reject with `ConnectorError` (`Phase Fetch`), cause `GraphError SchemaViolation`.
  - `row owned by a more specific binding is dropped`.
  - `fetch failure mid-iteration fails the query`: the throw happens on page 2, and the iteration rejects with `ConnectorError` after yielding page 1's rows. The caller (Task 4) guarantees no partial result.
  - `reverse without capability yields nothing`.
- [ ] **Step 2: Run** `npx tsx --test src/connectors/tests/FetchSession.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `FetchSession` (D3, D6).
- [ ] **Step 4: Run** the task's tests, then `npm test`/`typecheck`. Expected: PASS.
- [ ] **Step 5:** Append R98 (D3) and R99 (D6), then commit `feat(connectors): per-query fetch session`.

### Task 3: Scoping fetched rows

**Files:**
- Create: `src/access/FetchedNode.ts`
- Modify: `src/access/ScopeEvaluator.ts`, `src/GraphReader.ts`
- Test: `src/access/tests/FetchedScope.test.ts`

**Interfaces:**
- Consumes: `IFetchedRow` (Task 1), `BindingTable.IsStub` (Task 1).
- Produces:
  - `class FetchedNode { constructor(row: IFetchedRow, owner: string); readonly Stub: bigint | undefined }`. The stub id is filled by the reader when a stub exists for the public id.
  - `ScopeEvaluator.VisibleFetched(node: FetchedNode): Promise<boolean>`, evaluated under D5.
  - `GraphReader.AdmitFetched(row: IFetchedRow, owner: string): Promise<IFetchedRow | undefined>`: the row with hidden members (`HiddenMembers(row.Concept)`) removed when visible, else undefined. It records the stub's node read when a stub exists.
  - `GraphReader.FetchPredicate(concept: string): Predicate`: the `And` of applicable `Rows` predicates (True when none, False when `Default` denies and none apply), for D4.

- [ ] **Step 1: Failing tests** (both backends):
  - `property predicate on fetched row`: `Rows: {Server: Compare(cpu, Gt, 4)}`; rows cpu 8 and cpu 2 → only the first is admitted.
  - `hidden member is removed`.
  - `OwnerIs and IdIn decide`.
  - `Seeded is false`.
  - `Related out to an engine node decides normally`.
  - `Related in through a stub decides`: an engine node `t` links to external `x` (stub present), and `Rows: Related(r, In, IdIn{t})` admits `x`.
  - `Related in over external source is Unknown`: no stub, an external binding exists for the relationship's source concept → not visible.
  - `Related in with no possible source is False`: under `Not(Related…)` the row is visible.
  - `Reachable without stub is Unknown` → not visible; `Reachable with id in From` → visible.
  - `FetchPredicate ands applicable rows`.
- [ ] **Step 2: Run** `npx tsx --test src/access/tests/FetchedScope.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** D5 in `ScopeEvaluator` (reuse `Evaluation`, the cycle guard and the budget; fetched values come from the row, not `Load`).
- [ ] **Step 4: Run** the task's tests, then `npm test`/`typecheck`. Expected: PASS.
- [ ] **Step 5:** Append R100 (D5), then commit `feat(access): scope evaluation over fetched rows`.

### Task 4: FederatedSource for Cypher reads

**Files:**
- Create: `src/cypher/FederatedSource.ts`
- Modify: `src/cypher/CypherSource.ts` (`ScanLabel(label, probe?, hint?: Predicate)`), `src/cypher/ReaderSource.ts`, `src/cypher/write/OverlaySource.ts` (pass the hint through), `src/cypher/CypherEngine.ts`, `src/GraphEngine.ts` (expose `ExternalConnectors(): ReadonlyMap<string, IExternalConnector>` and the binding table to the Cypher module)
- Test: `src/cypher/tests/FederatedRead.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `class FederatedSource implements ICypherSource { constructor(base: ReaderSource, reader: GraphReader, session: FetchSession, bindings: BindingTable) }`:
  - `ScanLabel` yields the base scan with stubs skipped, then each `ExternalTargets(label)` fetch, with `Predicate = And(reader.FetchPredicate(target.Concept), hint ?? True)` and `Members` = the concept's visible properties. Rows pass `AdmitFetched` and become `CypherNode` (owner = target model).
  - `ScanAll` covers every concept the same way.
  - `Node(id)`: an engine node is returned as-is unless it is a stub. A stub goes through `Lookup` with `ExternalTargets(stub concept)` filtered to the stub's owner, and is undefined when dangling. An id neither stored nor already fetched in this session is undefined: external nodes are reached only through scans, seeks and links.
  - `Expand` Out: for an engine node, base links, with each stub target resolved through `Node` and dangling ones omitted. For an external node, its row `Links`, each target resolved through `Node`.
  - `Expand` In: engine edges (into the node, or into its stub), plus `Reverse` fetches over every External target whose concept declares the relationship (connectors without `ReverseLookup` contribute nothing).
  - `Expand` Undirected: the union, de-duplicated as `ReaderSource` does.
  - `OutLinks`: the same with direction Out.
  - `SeekEqual`: the base seek plus external fetches with hint `Compare(member, Eq, value)`.
  - `IndexFor` delegates to base.
  - `CypherEngine.Execute` builds a `FederatedSource` (one `FetchSession` per call) whenever the engine has External connectors, and a plain `ReaderSource` otherwise. A `ConnectorError` from any operator rejects `Execute`; no partial `CypherResult` is returned.

- [ ] **Step 1: Failing tests** (fake external connector on concept `Ticket`, engine concept `Team`):
  - `label scan unions engine and external rows`: `MATCH (n:Ticket)` returns fetched rows only, with no KV entries for them (raw scan finds no Ticket node).
  - `scope filters fetched rows`.
  - `match by property pushes a hint`: `MATCH (t:Ticket {state:'open'})`; the fake connector's logged request predicate contains `Compare(state, Eq, 'open')`. The result is identical when the fake ignores the predicate (D4).
  - `connector failure rejects Execute`.
  - `external source links into an engine node`: a fetched Ticket row `Links: {team: ['a']}`, with engine `Team` `a`. `MATCH (t:Ticket)-[:team]->(a:Team) RETURN t` finds it (Out), and `MATCH (a:Team {id:'a'})<-[:team]-(t) RETURN t` finds it through `Reverse` when the fake declares `ReverseLookup`, and returns nothing when it does not.
  - `Explain shows the fetch`: `Explain` output names `Fetch` for external targets (OperatorPrinter line `Fetch Ticket via ext`).
- [ ] **Step 2: Run** `npx tsx --test src/cypher/tests/FederatedRead.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The planner's `LabelScan`/`IndexSeek` pass a hint built from the scanned variable's node-local WHERE conjuncts and its pattern property map (property vs literal or parameter: `=`, `<>`, `<`, `<=`, `>`, `>=`, `IN`, `IS NULL`); anything else contributes nothing. Filters stay in the plan unchanged.
- [ ] **Step 4: Run** the task's tests, then `npm test`/`typecheck`. Expected: PASS, including every existing Cypher suite unchanged.
- [ ] **Step 5:** Append R101 (D4 and hint translation), then commit `feat(cypher): federated reads over external bindings`.

### Task 5: Stubs and cross-model links

**Files:**
- Modify: `src/txn/WriteBatch.ts` (Link gains optional `Target?: { Concept: string; Owner: string }`, serialized with a presence flag), `src/txn/BatchApplier.ts`, `src/GraphTransaction.ts` (`LinkOptions` gains `ExternalTarget?: { Concept: string; Owner: string }`), `src/cypher/write/TransactionSink.ts`, `docs/format/on-disk-format.md`
- Test: `src/txn/tests/Stubs.test.ts`, extend `src/cypher/tests/FederatedRead.test.ts`

**Interfaces:**
- Produces:
  - A Link whose `to` is not a stored node and carries `Target` creates the stub `(to, Target.Concept, Target.Owner)` first. `BindingTable.IsStub` must hold for it, else `CommitError InvalidEdge`. An existing stub with a different concept is `CommitError TargetTypeMismatch`.
  - Unlink or DeleteNode that removes a stub's last edge deletes the stub in the same batch.
  - `TransactionSink.CreateRelationship` fills `ExternalTarget` when the target `CypherNode` came from a fetch.

- [ ] **Step 1: Failing tests** (both backends):
  - `link to external creates stub`: the stub has no cells (raw `Keyspace.Columns` scan finds nothing for its id), and `OwnerOf`/`ConceptOf` return the target's.
  - `stub removed with last edge`.
  - `stub kept while another edge remains`.
  - `stub for an engine-bound concept is rejected` (`InvalidEdge`).
  - `dangling external target is omitted`: the fake connector no longer has `x`; `MATCH (a:Team)-[:assigned]->(t) RETURN t` returns no row, and `a`'s OutLinks omit `x`, with no error.
  - `reverse traversal through stub`: `MATCH (t:Ticket)<-[:assigned]-(a)` finds `a`.
- [ ] **Step 2: Run** `npx tsx --test src/txn/tests/Stubs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** (D2). Document the stub rule in `docs/format/on-disk-format.md`: no new key, a node with no cells whose binding is External.
- [ ] **Step 4: Run** the task's tests, then `npm test`/`typecheck`. Expected: PASS.
- [ ] **Step 5:** Append R102 (D2), then commit `feat(txn): stub nodes for links to external data`.

### Task 6: Writes to external nodes

**Files:**
- Modify: `src/GraphTransaction.ts` (owns a `FetchSession`; `Commit` passes it to the gate and coordinator), `src/access/WriteGate.ts`, `src/txn/BatchApplier.ts` (skip KV for external-node ops), `src/connectors/WriteCoordinator.ts`, `src/cypher/write/WriteQueryRunner.ts` (its source is a `FederatedSource` over the transaction's session)
- Test: `src/connectors/tests/ExternalWrites.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - Ops on an External node (resolved by `Target`/owner and concept for creates, otherwise by the session's fetched row or the stub) are routed to that connector's `ConnectorChangeSet` and never applied to KV.
  - `WriteGate.Check` gains an optional `fetched: (publicId: string) => Promise<IFetchedRow | undefined>`, used for the Update and Delete rules of external nodes (D7).
  - An external DeleteNode adds Unlink ops for engine edges into its stub (routed per R89) and removes the stub.

- [ ] **Step 1: Failing tests**:
  - `create external node goes to connector only`: `CREATE (t:Ticket {state:'new'})`; the connector's `Apply` receives CreateNode and SetProperty, and the raw KV has no node.
  - `set on fetched node`: `MATCH (t:Ticket {id:'x'}) SET t.state = 'done'`; the connector receives SetProperty.
  - `update rule evaluated on fetched row`: `Writes: {Ticket: {Update: Compare(state, Ne, 'locked')}}`; SET on a locked ticket rejects with `AccessDenied`, and no connector `Begin`.
  - `invisible external row cannot be updated` (`AccessDenied`).
  - `delete external node unlinks engine edges and removes stub`: engine `a -assigned-> x`; `MATCH (t:Ticket {id:'x'}) DETACH DELETE t`; the batch holds Unlink(a, assigned, x) routed to engine storage, plus the connector's DeleteNode; the stub is gone.
  - `connector failure reverts and leaves KV unchanged` (spec §12 write-flow invariant).
- [ ] **Step 2: Run** `npx tsx --test src/connectors/tests/ExternalWrites.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** (D7).
- [ ] **Step 4: Run** the task's tests, then `npm test`/`typecheck`. Expected: PASS.
- [ ] **Step 5:** Append R103 (D7), then commit `feat(connectors): writes to external nodes`.

### Task 7: Keyset cursor

**Files:**
- Create: `src/cypher/CypherCursor.ts`
- Modify: `src/cypher/ExecutionLimits.ts` (`After?: CypherCursor`), `src/cypher/CypherEngine.ts` (paging), `src/cypher/CypherResult.ts` (`NextCursor?: CypherCursor`), `CypherResultDto` (`NextCursor?: string`), `src/index.ts`
- Test: `src/cypher/tests/CypherCursor.test.ts`

**Interfaces:**
- Produces: `class CypherCursor { constructor(readonly Commit: bigint, readonly After: readonly CypherValue[]); Encode(): string; static Decode(text: string): CypherCursor }`. A malformed text is `GraphError InvalidArgument`. The encoding is versioned (leading `1.`), base64url of a JSON array that uses `CypherCellCodec` cells for the values.

- [ ] **Step 1: Failing tests**:
  - `pages concatenate to the full result`: 25 rows, RowCap 10, chaining `NextCursor` gives 10, 10 and 5, equal to the unpaged sorted result. The last page has no `NextCursor`.
  - `insert between pages neither repeats nor skips`: after page 1, create a node sorting before the cursor; page 2 starts exactly after page 1's last row.
  - `cursor round-trips`, including temporal and node cells.
  - `malformed cursor is InvalidArgument`.
  - `After with Skip is InvalidArgument`.
  - `resume at a later commit is allowed`.
  - `federated pages`: paging over a mixed engine and external label returns every row once.
- [ ] **Step 2: Run** `npx tsx --test src/cypher/tests/CypherCursor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** (D8): compare the total-order key with the existing implicit sort's comparator, and drop rows `<= After` before the cap.
- [ ] **Step 4: Run** the task's tests, then `npm test`/`typecheck`. Expected: PASS.
- [ ] **Step 5:** Append R104 (D8), then commit `feat(cypher): keyset cursor`.

### Task 8: Exports, docs and release

**Files:**
- Modify: `src/index.ts` (verify every new public type is exported, including the `Cypher` namespace additions), `README.md` (an "External bindings" section: residency, Fetch, stubs, cursor), `docs/format/on-disk-format.md` (cross-check), `package.json` (`0.2.0`)
- Test: `src/tests/PublicSurface.test.ts` (extend the existing export test, or create it if absent)

- [ ] **Step 1: Failing test** `public surface exports the read contract`: imports `ConnectorResidency`, `IExternalConnector` (type), `FetchSession`, `CypherCursor` and `ConnectorPhase.Fetch` from the package entry.
- [ ] **Step 2: Run** the test. Expected: FAIL for any missing export.
- [ ] **Step 3: Implement** the exports and docs, and bump the version to `0.2.0` (the `ICypherSource.ScanLabel` signature changed).
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build`. Expected: all PASS.
- [ ] **Step 5:** Commit `chore: 0.2.0 — external bindings`. Publishing is the controller's step after review, with the user's go-ahead.
