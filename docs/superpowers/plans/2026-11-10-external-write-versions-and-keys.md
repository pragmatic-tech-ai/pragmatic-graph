# External writes: read-time versions, transaction fetch, immediate external writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec §11.2 (owner, 2026-11-10, revised 2026-11-11) in two waves.

- **Wave 1 (engine 0.3.0, TODL 0.55.0, connectors-host 0.2.0)** ships three things:
  - optimistic locking decided at read time: a fetched row carries the source's version, and every change to that node carries it as `ExpectedVersion`;
  - a public, scope-enforced `GraphTransaction.Fetch` by public id. This is the **M2.3 unblocker**: open item O1 of `pragmatic-server/docs/superpowers/plans/2026-11-10-runtime-graph-on-engine.md`;
  - Cypher `elementId()` with match-by-id, and version conflicts reported as conflicts.
- **Wave 2 (engine 0.4.0, TODL 0.56.0, connectors-host 0.3.0)** ships immediate external writes:
  - a write to an external binding executes at the source when the transaction performs it, and returns what the source assigned (keys, versions), so a created record has its real public id at once;
  - only engine-stored data is transactional;
  - an engine abort or commit failure compensates the external writes already executed, in reverse order, best effort.

**Architecture.**

*Wave 1:*
- `IFetchedRow.Version` lives in the `FetchSession` memo, and `WriteCoordinator.Route` stamps `ConnectorChange.ExpectedVersion` from it.
- `GraphTransaction.Fetch` resolves engine nodes, stubs and concept-hinted external ids through the transaction's FetchSession, under the transaction's scope.
- TODL reads the binding's version field into the row and guards each write with `ExpectedVersion`.

*Wave 2:*
- A GraphTransaction gains **write steps**. Recording methods stay synchronous. `await txn.Flush()` executes the external ops recorded since the last step, and so do `CreateAssigned` and `Commit`. Execution goes through a persistent per-transaction `StepRouter`, which owns routing, `ExternalWriteCheck` and the incremental write gate.
- Each External connector's `IConnectorTransaction.Apply` now **executes** one step and returns `IConnectorApplyResult { Versions }`. The new optional `Create` executes a source-keyed create and returns the created row. `Undo` compensates the latest step. `Commit` only finalizes. `Revert` compensates whatever is not yet undone.
- Mirrored connectors keep stage-at-Apply / execute-at-Commit unchanged.
- The engine keeps a step log. Abort and commit failure walk it in reverse and call `Undo` per step.
- Cypher's `TransactionSink` writes through to the transaction as the pipeline runs.
  - An external write clause on which no later clause depends batches all its rows into one step per connector (pattern stage), decided by the planner's `WriteDependencyAnalysis`.
  - A clause that has a dependent later clause runs one step per row.
  - Each step is awaited, and a failed statement awaits `txn.Abort()`.
- A transaction dropped with executed external writes is compensated and fails loudly: `DisposeAsync` throws `TransactionDroppedError`, and the engine raises `GraphEngine.TransactionDropped`.

**Tech Stack:** TypeScript (engine TS 7; TODL / connectors-host TS 5.7), Node `node:test` via `tsx --test`, lmdb-js (engine), pg-mem and fakes (host).

**Spec:** `docs/superpowers/specs/2026-11-06-graph-consolidation-design.md`. Binding sections:
- §5.3 (connector contract) and §5.4;
- §6 (write flow; compensation is best effort; Revert after Commit means compensate);
- §7 (scopes) and §8 (Cypher, cursors, change push);
- §11.1, and **§11.2: both external-write bullets**;
- §12 (write-flow invariant; two queries each fetch).

Binding rulings in `docs/decisions.md`:
- R30 (a GraphTransaction does not read its own writes);
- R71/R72/R77 (prepare/finalize, setup generation) and R89;
- R96–R104 (M2.1 residency, fetch session, stubs, R103 external writes, ConnectorApplied, cursors);
- R108–R113 (TODL ids, fetch mapping, write side, before-image and compensation);
- P12 (fetch internals stay in the internal channel) and P15 (the scoped GraphReader serves no stub data), from the M2.1 review rounds.

New rulings are **R119+**.

**Repos and branches:** each repo gets branch `feat/external-versions-keys`:
- engine `D:/architecture-agent/pragmatic-graph`, from `main`;
- TODL `D:/architecture-agent/TODL`, from `feat/m2.2-runtime-on-engine` after 0.54.0 ships;
- connectors-host `D:/architecture-agent/todl-connectors-host`, from `feat/m2.2-external-conformance`.

TODL and the host consume the engine (and the host consumes TODL) through `node_modules/@pragmatic-tech-ai/*` junctions to the siblings' built `dist`. Run `npm run build` in the producing repo before a consuming task uses a new symbol. Wave 2 starts once Wave 1's release task is merged.

## Design rulings (record each in `docs/decisions.md` in the task that implements it)

### Wave 1

- **V1 Row version (R119).** `type RowVersion = string | number | bigint`, and `IFetchedRow.Version?: RowVersion`.
  - `FetchedNode.Validated` copies the version. `undefined` and `null` read as absent. A non-finite number, or any other type, is `GraphError SchemaViolation`, so the fetch fails as `ConnectorError Fetch`.
  - The version is the one carried by the **first admitted row** of that id in the session. That is the R98 memo rule: a later fetch in the session never replaces it.
- **V2 Expected version (R119).** `ConnectorChange.ExpectedVersion?: RowVersion` is set on every change whose routing id has a known version, unless the transaction created that id earlier. The routing id is the written node for CreateNode, SetProperty and DeleteNode, and the source for Link and Unlink, including the R89 unlinks that a DeleteNode adds.
  - Changes after a CreateNode of the id (a re-create included) carry no version. Changes before it, such as the DeleteNode, carry it.
  - Mirrored connectors never get a version.
  - The engine never compares versions; the connector guards.
  - In Wave 2 the known version is the latest one this transaction's own write reported for the id, else the fetched one (ruling E5).
- **V3 No read, no expected version (R119).** An external write with no fetched row can only happen under a System scope; scoped writers get `AccessError InvisibleNode` (R103). Such a write carries no `ExpectedVersion`. An Optimistic binding then guards it with the before-image version (R113): nothing was read, so nothing can be stale.
- **V4 Version conflict (R120).** A connector reports a stale `ExpectedVersion` by throwing `ConflictError`, the engine class. TODL throws `ExternalVersionConflict extends ConflictError`.
  - The coordinator wraps it, as today, in `ConnectorError(connector, phase, cause)`.
  - `ConnectorError.IsConflict` is true when `cause` is a `ConflictError`, or when `cause` is an `AggregateError` whose first error is one.
  - `TransactionSink.MapCommitError` maps `IsConflict` to `CypherWriteErrorCode.Conflict`.
  - The commit-time before-image stays, for compensation only.
- **F1 Transaction fetch, the M2.3 unblocker (R121).** Signature: `GraphTransaction.Fetch(keys: readonly (string | IFetchKey)[]): Promise<ReadonlyMap<string, IFetchedView>>`, with `IFetchKey { readonly PublicId: string; readonly Concept?: string; readonly Owner?: string }` and `IFetchedView extends INodeView { readonly External: boolean; readonly Version?: RowVersion }`. Resolution, per key:
  1. A stored non-stub engine node is served as `ReadNode` serves it: scoped, reads recorded, `External: false`.
  2. A stored stub resolves through its identity. The candidates are `BindingTable.ExternalTargets(concept)` with `Model === stub owner`.
  3. An id with no stored node needs `Concept`. The candidates are `ExternalTargets(Concept)`, filtered by `Owner` when given. Without `Concept` the key is absent and nothing is fetched: TODL ids are opaque to the engine.
  4. Rows come from `FetchSession.LookupMany`: one keyed request per candidate target (KeyLookup), else one scan with `And(scope, IdIn{ids})`. They are memoised as `Lookup` memoises them.
  5. Each row is admitted through `GraphReader.AdmitFetched` (validation, `VisibleFetched`, hidden members stripped) and the `StoredNonStub` guard.
  6. `Version` is the session memo's version.

  An id the scope does not admit is **absent** from the result. Its row stays in the session memo, which is never exposed, so a later write to it is still `InvisibleNode`.

  Fetch is a member of GraphTransaction only:
  - P15 holds: `ReadNode` of a stub stays undefined;
  - P12 holds: the internals live in internal `TransactionFetch`, and no `FetchedNode` or session object is exposed.

  This is the sanctioned fetch-before-write path for the transaction API.
- **F2 Cypher by-id match: yes (R121).** Add the Neo4j 5 function `elementId(n)`. It returns the node's public id; applied to a relationship it is a Cypher type error.
  - The planner turns `MATCH (n:L) WHERE elementId(n) = $id` (or `IN $ids`) into an id seek: engine nodes and stubs through the public-id index, external rows through a keyed fetch with the label's `ExternalTargets`.
  - Without a label, the match finds only engine nodes, stubs and rows already in the session.
  - Why yes:
    - `cypher/execute` callers must address one record by the id the engine returned (in Wave 2, a source-assigned one) without a full scan;
    - a property match works only for external rows whose id member is mapped, and never for engine nodes;
    - `IdIn`, `KeyLookup` and `FetchSession.Lookup` already exist;
    - it gives `MATCH … SET/DELETE` by id the same fetch-before-write path F1 gives the transaction API.

  F2 is not on the M2.3 critical path.
- **G1 Guarded deletes (R122).** On an Optimistic binding a Delete carries `WriteOperation.Version`, taken from `ExpectedVersion` or else the before-image. The SQL, REST, GraphQL, Document and Cypher adapters guard the delete with it. A stale delete is a `Conflict` failure, which `DataSourceTransaction` turns into `ExternalVersionConflict`.

### Wave 2

- **E1 Write steps (R123).** A **write step** is the unit in which external ops execute: the ops recorded since the previous step, routed together.
  - **Transaction API.** Recording methods (`CreateNode`, `SetProperty`, `SetDefault`, `DeleteNode`, `Link`, `Unlink`, `DetachUnlink`) stay synchronous and record as today. A step runs at `await txn.Flush()`, at `await txn.CreateAssigned(…)` (which flushes first, then is its own step) and at `Commit` (a final flush before anything else). The external effect of an API call happens at the next step, not inside the synchronous call.
  - Why steps rather than per-call execution: a create must reach the source with every member it sets, or a NOT NULL column or R29 `MissingRequired` fails half-written. The R113 merge of ops on one id stays meaningful: one Upsert per id per step.
  - A caller who wants per-call effects calls `Flush` after each call. A server endpoint that only writes and commits never needs `Flush`.
  - **Cypher.** Each external write clause (CREATE, MERGE's create branch, SET, REMOVE, DELETE) runs in one of two modes, chosen at plan time by E10:
    - **Batched** (no later clause depends on its rows): the clause drains all its input rows, records every row's ops, and executes them as one step per pattern stage. Within a stage the ops go one connector at a time, in name order. Rows are then yielded downstream holding the real nodes.
    - **Per-row** (a later clause depends): each row ends with `sink.EndStep()`, which flushes, and step order is row order.

    In both modes CREATE executes its pattern's nodes so that every new external node's targets come first (E4). A batched clause is an eager barrier: its writes all happen before any later clause's writes in the same query. That is observable only in step order, because by E10 nothing later reads them.
- **E2 Routing and awaiting (R123).** `WriteCoordinator.Route` (stateless, over one batch) becomes the persistent `StepRouter`. One StepRouter per GraphTransaction holds the ChangeRouter origins, `BatchEdges` and `ExternalWriteCheck`.
  - `StepRouter.Route(ops)` returns `IRoutedStep { External: ReadonlyMap<string, ConnectorChangeSet>; Mirrored: ReadonlyMap<string, ConnectorChange[]>; Engine: readonly BatchOp[] }`.
  - The External sets execute now. Mirrored changes accumulate until Commit. Engine ops append to the transaction's engine batch.
  - `ExternalWriteCheck.Finish` runs per step, over the creates of that step: R29 is judged per create step.
  - The write gate runs per step, incrementally: `WriteGate.Check(evaluator, batch, catalog, exempt, fetched, from)` checks ops from index `from`, with the earlier ops as context. A denial fails the step before any connector call.
  - Connector calls in a step run one connector at a time in name order. Each is raced against the setup's timeout as today, from the step's start. They are awaited inside the statement: Cypher operators are async iterators, and `ICypherSink.CreateNode` becomes async.
  - A connector is `Begin`-ed at its first step and kept for the transaction's life. It is begun with the transaction's `ConnectorContext` (`Begin(context)`, security S2, ruling E11).
- **E3 Connector contract (R124).**
  ```ts
  interface IConnectorTransaction
  {
      /** External: executes the step now and reports what the source assigned. Mirrored: stages, as today. */
      Apply(changes: ConnectorChangeSet): Promise<IConnectorApplyResult | void>;
      /**
       * External only, optional: executes source-keyed creates now, as one step. Resolves with one outcome per request,
       * index-aligned (outcomes[i] answers requests[i]). A per-request failure is an outcome, not a throw; a throw means the
       * whole call failed and the connector has logged, for Undo, whatever it applied before throwing.
       */
      Create?(requests: readonly IAssignedCreate[]): Promise<readonly IAssignedOutcome[]>;
      /** External only, optional: compensates the latest executed step not yet undone (a Create is a step). */
      Undo?(): Promise<void>;
      /** Mirrored: commits staged writes. External: finalize only (drops before-images); no remote effect. */
      Commit(): Promise<void>;
      /** Compensates (External) or discards / compensates (Mirrored) everything not yet undone. Legal before and after Commit. */
      Revert(): Promise<void>;
  }
  interface IConnectorApplyResult { readonly Versions?: ReadonlyMap<string, RowVersion> }
  interface IAssignedCreate
  {
      readonly Owner: string;
      readonly Concept: string;
      readonly Properties: ReadonlyMap<string, CellValue>;
      readonly Links: readonly { readonly Relationship: string; readonly To: string }[];
  }
  /** Exactly one of Row / Error. Row: the created record as the source now holds it. Error: why this request did not apply. */
  interface IAssignedOutcome { readonly Row?: IFetchedRow; readonly Error?: unknown }
  ```
  - `IConnectorApplyResult.Versions` is keyed by public id, so a batched Apply over many rows maps versions back by id.
  - A partial Apply (some ops failed) **throws** after logging the applied ops for Undo (R113 per-op accounting). The step then fails, and its `Undo` compensates exactly the ops that applied.
  - Mirrored connectors compile and behave unchanged.
  - An External connector without `Undo` is compensated by `Revert`, after every later step's Undo.
  - An External connector without `Create` refuses `CreateAssigned` with `ConnectorError(connector, Write, GraphError Unsupported)`.
  - `ConnectorPhase.Write = 'Write'` is appended: an immediate step or create that failed.
- **E4 Source-assigned keys (R124).** Signature: `GraphTransaction.CreateAssigned(requests: readonly IAssignedCreate[]): Promise<readonly IFetchedView[]>` (index-aligned), with `IAssignedLink { Relationship: string; To: string }` as the element type of `IAssignedCreate.Links`.
  - Steps:
    1. Flush pending ops.
    2. Check every request: R29; the gate's Create rules, judged hypothetically as for any create; the scope's Hidden and ReadOnly.Create members over its Properties and Links (placement defaults exempt); and the AppendTo rule of every link target that exists in the snapshot (security S2). `ExternalWriteCheck` runs on the properties and links. A failed check fails before any connector call.
    3. Group the requests by binding connector, and call `Create` once per connector, in name order, as one step each.
    4. Validate each returned row with `FetchedNode.Validated`.
    5. Map outcome `i` back to request `i`. The mapping is by position, so the outcome count must equal the request count, else the call is `ConnectorError(connector, Write, GraphError Internal)`.
  - Any `Error` outcome, or invalid row, fails the step. The connector's `Undo` of that step compensates exactly the requests that produced a Row; the per-request accounting of R113 lives in the connector. The transaction then compensates and ends (E6).
  - The returned row is the source's record as it now stands. The public id is minted from the assigned key (TODL: `ExternalIdentity.Mint`), the id member and source defaults are in its Values, and `Version` is set.
  - Requirements on the row: its concept must be `concept`, its id must be valid, and it must not be the id of a stored engine node or of a node the transaction created. Otherwise the step fails with `ConnectorError(connector, Write, GraphError SchemaViolation)` or with cause `CommitError DuplicatePublicId`, and the transaction compensates and ends (E6). The connector must have logged the insert for Undo before returning.
  - On success the row is remembered in the session (`FetchSession.Remember`) and in the StepRouter as created by this transaction. Later ops on that id route External, pass the gate as ops on a created node, and get the row's Version as ExpectedVersion (E5).
  - Cypher: `INodePlace.KeyAssigned?: true` (with `PublicId: ''`) makes `TransactionSink.CreateNode` call `CreateAssigned`, passing the node's properties, defaults and the pattern's outgoing links whose targets exist by then.
  - The overlay node is built from the returned row, so `RETURN o.id` shows the assigned key and `RETURN o` shows the real id.
  - Engine-side links to it (an engine node's link with `ExternalTarget`) are recorded with the real id. `ICommitApplied.CreatedIds` (internal ids of engine ops and stub links, R102) is unchanged, because external nodes are never stored.
  - Client-keyed creates keep today's minted id and are executed by `Apply` at their step.
- **E5 Version ledger (R125).** For each id, the expected version of the next change is: the version this transaction's own latest step reported for it (`IConnectorApplyResult.Versions`, or the created row's `Version`); else the fetched version (V1); else none.
  - V2's "created by the transaction" rule yields to a reported version: a node created at step 1 and updated at step 3 is guarded with step 1's reported version.
  - When the source reports none, TODL falls back to the before-image read at that step (V3), which already reflects the transaction's own earlier write.
  - `Fetch` keeps returning the memo row and its version: a transaction reads its snapshot view and does not read its own writes (R30).
- **E6 Failure and compensation (R125).**
  - **What triggers compensation:**
    - a failed step (connector throw, version conflict, timeout, invalid created row, gate denial after earlier steps);
    - an `Abort()`;
    - any Commit failure: gate, final flush, engine Prepare (OCC conflict included), a Mirrored connector, the External finalize, or engine Finalize/Release.
  - **What compensation does:**
    1. Revert the Mirrored connectors, in reverse order of Begin.
    2. Walk the step log in reverse, calling `Undo` on each step's connector, or that connector's `Revert` once its earlier steps are reached when it has no `Undo`.
    3. End the transaction: every later call is `GraphError Disposed`.

    Compensation is bounded by the setup's timeout from the failure. Late outcomes are reported on `ConnectorRevertFailed`, as today.
  - **What the caller sees:**
    - The failure itself is the error. A failed step is `ConnectorError(connector, Write, cause)`. An engine rejection (ConflictError, CommitError, AccessError) is rethrown as the transaction surfaces it when every compensation succeeded; a CommitError under a read-restricting scope is first redacted by `CommitErrorRedactor` (security S2), and the redacted error is also what goes into the AggregateError below.
    - **When a compensation fails:**
      - the caller gets `ConnectorError(<failing connector or EngineStorage>, <phase>, AggregateError([failure, ...compensationErrors]))`, so an engine rejection is then wrapped, with the failure first;
      - every failed compensation is raised on `ConnectorRevertFailed` at once, not only late ones;
      - `ConnectorApplied` is raised with `Outcome: ConnectorOutcome.CompensationFailed`.

      The source may now hold residue. That is the connector author's responsibility (§6), and the signal is the operator's hook.
  - **Dropped transactions (R125).** A transaction is *dropped* when it has executed at least one external step and is disposed without a successful `Commit` or an `Abort`. A dropped transaction is compensated **and** fails loudly.
    - **The error.** `GraphErrorCode.TransactionDropped = 15` (appended) and `class TransactionDroppedError extends GraphError` with:
      - `TransactionId: string`: a new `GraphTransaction.Id`, a UUID assigned at Begin;
      - `Steps: number`: the external steps executed;
      - `Compensation: Promise<ConnectorOutcome>`: settles when compensation ends (Compensated or CompensationFailed; it never rejects);
      - `Outcome?: ConnectorOutcome`: set when the error is thrown after compensation finished.
    - **`DisposeAsync(): Promise<void>`** (also `[Symbol.asyncDispose]`) is the primary path. Not dropped: it disposes and resolves. Dropped: it compensates (E6), raises `ConnectorApplied` with the outcome and `GraphEngine.TransactionDropped`, then **rejects** with `TransactionDroppedError`, `Outcome` set.
    - **Sync `dispose()`.** Not dropped: unchanged. Dropped: it marks the transaction ended, starts the same compensation detached, and **throws synchronously** a `TransactionDroppedError` whose `Outcome` is undefined and whose `Compensation` promise settles later. The same signals are raised when compensation completes.
    - `Commit`'s own `finally` uses an internal non-throwing end, because a committed or compensated-by-failure transaction is never dropped.
    - `GraphStore.dispose()` ends still-open transactions through an internal `Drop` path. Drop compensates and raises `TransactionDropped`, but does not throw: store shutdown must finish.
    - The signal is `GraphEngine.TransactionDropped: ISignal<TransactionDroppedError>` (also on `GraphStore`), raised once per dropped transaction after compensation settles. A throwing subscriber is ignored.
  - Cypher `ExecuteWrite` awaits `Abort()` on any error, so it never drops a transaction.
- **E7 M2.1 rules under immediate writes (R126).**
  - **Write only after a same-transaction fetch (R103): kept, per step.** An op on an existing external node is decided against the session's row, so a scoped writer must have fetched it (Cypher MATCH, F1 `Fetch`, F2 by-id match). Nodes the transaction created (client-keyed or `CreateAssigned`) count as known.
  - **`ExternalWriteCheck`: kept**, now persistent across steps. A deleted id stays deleted for later steps (UnknownNode), and `DuplicatePublicId` covers ids created in earlier steps and assigned ids.
  - **`ConnectorApplied`: raised once per GraphTransaction, at its end, never per step.** It is `IConnectorApplied { Commit?: bigint; Connectors: …; Outcome: ConnectorOutcome }` with `enum ConnectorOutcome { Committed = 1, Compensated = 2, CompensationFailed = 3 }`:
    - `Committed`: after the engine commit (carrying its number when there is one);
    - `Compensated`: after a failure or abort whose external steps were all undone;
    - `CompensationFailed`: as in E6.

    A transaction with no connector participation raises none.
  - **Why once, at the end:** the server's data-changed push tells clients to refetch, and external sources have no change feed. One notification after the outcome is known is enough and never announces a change that is then undone. Readers may see an external change before the notification (E8), which a refetch hint tolerates.
  - **All-external commit: kept (P13).** A transaction whose engine part is empty still prepares the empty batch, so its engine reads are validated. It releases instead of finalizing, raises `Committed`, and resolves with `SnapshotCommit`. An engine conflict at that Prepare compensates the external steps.
- **E8 Cursors and commit versions (R126).**
  - External effects have no engine commit number. An engine cursor (R104: commit plus keyset) covers engine order only. External rows are fetched per query (§5.2, §12), so a paged read reflects the source as each page is fetched. Rows another transaction writes immediately can appear between pages; the keyset position stays correct, with no duplicates or skips relative to the order.
  - Other transactions can read an external write before the writing transaction commits, and can read it even if that transaction later compensates. This is the accepted cost of §11.2 ("visible to others as soon as the source applies them").
  - Consumers that order writes by engine commit number must use `ConnectorApplied` for external effects.
  - `ICommitApplied` is unchanged.
- **E9 TODL write side (R127).** `DataSourceTransaction`:
  - `Apply(step)` translates the step with `ChangeBatcher.Batches`. That is unchanged except that it no longer re-merges earlier Apply calls: each step stands alone, and ops on one id merge within the step. It then **executes** the step's batches in order. Per batch:
    1. read the before-image (inserts excluded);
    2. run the create-conflict check;
    3. run the version pre-check (`ExpectedVersion` against the before-image; a mismatch is `ExternalVersionConflict` before writing);
    4. call `adapter.Apply`;
    5. record the attempt **under the current step**.

    Apply resolves with `{ Versions }` from `WriteResult.Versions`, keyed by public id.
  - `Create(requests)` is one step:
    1. Resolve each request's binding from `(Owner, Concept)`. It must be `KeyAssignment.Source` on an adapter with `CanAssignKeys`.
    2. Build one `Insert` per request: `Key: null`, `Ref = String(index)`, Fields from Properties, foreign keys from Links via `ExternalIdentity.ForeignKey`.
    3. Send one WriteBatch per binding.
    4. Read `WriteResult.Assigned`, which is **keyed by `Ref`** (the contract: each assigned key names the Ref it answers; order is irrelevant).
    5. Mint each public id with `ExternalIdentity.Mint(binding, String(key))`.
    6. Log every assigned insert for Undo, as a Delete of its key, **before** building outcomes.
    7. Re-read the assigned rows with one `adapter.Query` per binding (IdKey `In` the keys, over IdKey, the mapped fields and the version field), and return them as `IFetchedRow`s built by the fetch side's row builder.

    Outcomes are index-aligned with the requests. A request is an `Error` outcome when it reported a failure, when no Assigned entry names its Ref (`ExternalWriteError(KeyNotAssigned)`), when its key is null or repeats another, or when its minted id is over 400 bytes. Every other request is a `Row` outcome.
  - `Undo()` compensates the latest step's attempts (R113 logic, per step). `Revert()` undoes every remaining step in reverse. `Commit()` only finalizes: state Committed, before-images dropped. A Transactional binding is atomic **per step**.
  - The ChangeBatcher rules of R113 still hold within a step. "Change after a Delete of the same id" across steps is the engine's UnknownNode (E7).
  - `EnvironmentNodePlacement`: a binding with `KeyAssignment.Source` and no id-member value in the write gives `{ PublicId: '', Owner: binding.Model, KeyAssigned: true }`. With an id value given it mints as today, because an explicit key is the caller's choice. Client bindings are unchanged.
  - `keys source;` is authored in the `populate` block and becomes `ConnectorBinding.KeyAssignment?: KeyAssignment` (absent = Client).

- **E10 Cross-row batching and its dependency analysis (R128).**
  - **Home and output.** Write planning in `LogicalPlanner.PlanForWrite` runs a new `WriteDependencyAnalysis` over the `CypherQueryModel`'s clause list. It yields one `WriteMode` per write clause: `enum WriteMode { PerRow = 1, Batched = 2 }`. Only write clauses that can reach an external binding are ever Batched; engine-only writes are not steps, so their mode is moot.
  - **What a clause writes, `W(c)`:**
    - CREATE, and MERGE's create branch: the node and relationship variables the clause introduces, named or anonymous. Anonymous ones get synthetic names, which no later clause can reference.
    - SET / REMOVE: the variables whose properties or labels it changes.
    - DELETE: the variables it deletes.
    - `L(c)`: the label set of the nodes in `W(c)`. The labels come from the pattern for CREATE and MERGE, and from the variable's binding pattern for SET, REMOVE and DELETE. An unlabeled variable gives ⊤ (all labels).
  - **Clause c is Batched iff every later clause d (WITH, MATCH, OPTIONAL MATCH, MERGE, CREATE, SET, REMOVE, DELETE, UNWIND, RETURN, ORDER BY, WHERE), and the query's final projection, satisfies all of the following:**
    1. d references no variable in `Alias*(W(c))`. `Alias*` is the closure of W(c) through WITH and UNWIND projections: any projection item whose expression mentions a variable already in the set adds its alias, so `collect(n)`, `n.id`, `{x: n}` and `[n]` all count.
    2. d's patterns do not use a variable of `Alias*(W(c))` as a node or relationship endpoint. This covers links to the new rows, and a MERGE or MATCH anchored on them.
    3. d does not read, by label, a concept family that may contain the written nodes. Here d is a MATCH, OPTIONAL MATCH, or MERGE's match part, and the test is: d's pattern labels IsA-overlap `L(c)` in either direction (via the catalog), or a pattern node of d is unlabeled while `L(c)` holds an external binding's concept.
    4. d is not a construct the analysis does not model: `WITH *` or `RETURN *`, a path variable over a pattern that includes `W(c)` variables, CALL or subqueries, `FOREACH`, or a later `DELETE`/`SET` over a variable with no known label.
  - Any rule that cannot be decided (unknown construct, unresolvable label) gives **PerRow**. **When unsure, go per-row.**
  - The mode is printed by `OperatorPrinter` (EXPLAIN shows `Batched` / `PerRow`), and tests assert on it.
  - **Pattern stages.** A batched CREATE executes in stages. Stage 0 is the new nodes no other new external node in the same pattern points at, then a stage per topological level of new-external → new-external links. Each stage is one step per connector: `CreateAssigned` for KeyAssigned places, or Apply for client-keyed ones, carrying every row's nodes of that stage. A link-cycle among new external nodes of one pattern puts the closing link into a final Link step after all stages.
  - **Mapping back to rows.** The batched operator keeps `rows[i] → requests[j]`. Outcome j (index-aligned, E3/E4) gives row i its node. Apply results map back by public id (`Versions`). Rows are then yielded in input order, holding the real nodes.
  - **Failure inside a batch.** The step fails as a whole. The connector has applied some rows and failed others: SQL Sequential continues past a failed op; Transactional applies nothing. Under R113 accounting only the applied rows are logged, so the step's `Undo` compensates exactly those. The transaction then compensates its earlier steps in reverse and ends (E6). The query rejects with the step's `ConnectorError Write`. The cause is an `ExternalWriteError` listing the failed rows' keys or Refs, or `IsConflict` for a version conflict.
- **E11 One caller per transaction (security S2; platform security spec §6).** Connector work is never pooled, cached, batched or compensated across callers. The engine's unit of caller is the GraphTransaction and its `ConnectorContext`:
  - Every connector call a GraphTransaction makes runs on the `IConnectorTransaction` begun with that transaction's context. That covers `Fetch`, `Begin`, `Apply`, `Create`, `Undo`, `Commit`, `Revert`, and the compensation of an abort, a failed commit or a dropped transaction (`GraphStore.dispose()`'s Drop included). Fetches carry `IFetchRequest.Context`.
  - Write steps, batched clauses (E10), `CreateAssigned` groups, the step log, the version ledger (E5) and the fetch memo belong to one GraphTransaction. Nothing merges, reorders, replays or reuses them across two transactions, even when their contexts or scopes are equal. E10's cross-row batching is across the rows of one statement in one transaction only.
  - A version one transaction learned never guards another transaction's write.
  - Drop and store shutdown compensate each transaction separately, each on its own connector transactions and in its own reverse step order.

## Global Constraints

- **Engine is the lowest layer.** pragmatic-graph imports nothing from TODL, Mural, server or connectors-host, and exposes no type of theirs. It communicates upward only by signals (`ConnectorApplied`, `ConnectorRevertFailed`, `CommitApplied`). TODL importing engine symbols is downward and allowed.
- **OOP.** No module-level free functions and no mutable module-level state; behaviour lives in classes (static members allowed). Module-level `const` is only for true constants.
- **Allman braces** for classes, methods, constructors, accessors and control flow, with `else`/`catch`/`finally` on their own line. Object literals and block-bodied arrows stay inline. This is hand-maintained.
- **PascalCase** for interfaces and public methods. Private members and serialized-JSON-shaped config keys (`upsertReturn`, `insertMutation`) keep their casing.
- **No inline string literals.** Messages, reused keys and config names are `private static readonly` PascalCase constants. This is TS only (`.mu` labels exempt). Structural single-use tokens may stay inline.
- **Enums over string literals** for fixed sets: `ConnectorOutcome`, `KeyAssignment`, `WriteOperationKind.Insert`, `ConnectorPhase.Write`.
- **Error enums are append-only.**
  - Wave 1 appends nothing to error enums.
  - Wave 2 appends `ConnectorPhase.Write = 'Write'`, `GraphErrorCode.TransactionDropped = 15`, `EngineBridgeErrorCode.KeyNotAssigned` (after `NoHomeModel`) and `WriteOperationKind.Insert = "insert"`, and adds the new enums `ConnectorOutcome` and `WriteMode`.
  - **Wave 1 is self-contained:** nothing in Tasks 1.1–1.7 may use or anticipate a Wave 2 symbol, and Task 1.7 is releasable as soon as 1.1–1.6 are green.
  - Never renumber. Every deliberate engine error is a `GraphError` subclass with a `GraphErrorCode`.
- **Tests live in `tests/` subfolders** next to the code (`src/<area>/tests/*.test.ts`). Storage-touching engine tests run on MemoryStore and LMDB (the existing dual-backend pattern).
- **Never run `npm install` in TODL or in the host**: it breaks the sibling junctions. Edit version ranges by hand. Drop a stale `@pragmatic-tech-ai/*` lock node only if `npm ls` complains.
- Teardown goes through `dispose()`. Public storage APIs are async and never return live references.
- **Each task ends green.**
  - engine: `npm test` and `npm run typecheck`;
  - TODL: `npm test` and `npx tsc --noEmit -p .`;
  - host: `npm test` and `npm run build`.
- Fix every review finding, minors included. Commit only in the task's own repo, and record rulings in the engine's `docs/decisions.md` as a separate engine commit. No push and no publish without the owner's go-ahead.
- **One caller per transaction (E11).** No connector state, step, batch or compensation crosses GraphTransactions; every connector call carries the transaction's `ConnectorContext`.

## Review Focus

1. **Wave 1: the sanctioned fetch leaks or under-fetches.** → Task 1.2 tests:
   - `out-of-scope id is not returned`: absent from the result, hidden members stripped from admitted views, and a later SetProperty on the hidden id is `AccessError InvisibleNode`;
   - `write without a fetch is still refused`;
   - `stub data is still not served by ReadNode` (P15).
2. **Wave 1: a stale read is overwritten.** Another writer changes the row between this transaction's fetch and its write. → Task 1.5 test `optimistic write after a concurrent change fails with a version conflict` (no adapter write; `ExternalVersionConflict`), and Task 1.4 test `stale version maps to Cypher Conflict`.
3. **Wave 2: an abort after N immediate writes must compensate exactly those, in reverse order.** → Task 2.2 test `abort compensates executed steps in reverse order`. Steps run on A, B, A and then the transaction aborts: the calls are `A.Undo, B.Undo, A.Undo` in that order, nothing is undone for the recorded but unflushed op, and `ConnectorApplied.Outcome === Compensated`.
4. **Wave 2: an engine OCC conflict after external writes must compensate them.** → Task 2.2 test `engine conflict at prepare compensates external steps`. A concurrent commit changes a key the transaction read, its Commit rejects with `ConflictError` (as-is), both executed steps are undone, and the engine is unchanged.
5. **Wave 2: a compensation failure must surface and not be swallowed.** → Task 2.2 test `failed compensation surfaces`: an Undo throws during an abort after a step failure, so the caller gets `ConnectorError` with `AggregateError.errors[0]` = the original failure and `[1]` = the Undo error; `ConnectorRevertFailed` fired once with that connector; and `ConnectorApplied.Outcome === CompensationFailed`.
6. **Wave 2: a source-assigned key must flow everywhere at once.** → Task 2.6 test `CREATE with a foreign key to a new source-keyed row`. It runs `CREATE (o:Order {total: 5})-[:customer]->(c:Customer {name: 'a'}) RETURN o, o.id, c.id` with both bindings `keys source` on one SQL connector, and asserts:
   - the customer is inserted first;
   - the order's insert carries `customer_id` = the customer's serial;
   - `o.id` and `c.id` are the serials;
   - the node ids are `Mint(binding, serial)`.

   Plus Task 2.3 test `engine link to an assigned create is stored under the real id`.
7. **Wave 2: batching misjudges a dependency, so a later clause sees no key or a missing row.** → Task 2.4b tests:
   - `dependent clause forces per-row`: `CREATE … WITH n MATCH …`, `… SET n.x`, `… RETURN n.id`, a link to the new rows, a label MATCH over the written concept, and `WITH *` are all PerRow in EXPLAIN, and every later clause sees real keys;
   - `independent multi-row CREATE is one batched step`;
   - `alias closure is followed` (`WITH collect(n) AS ns RETURN ns` → PerRow).
8. **Wave 2: a partial batch failure compensates the wrong rows.** → Task 2.4b test `partial batch failure compensates exactly the applied rows`: row 2 of 3 fails under Sequential, so Undo deletes exactly rows 1 and 3's keys, row 2's never applied, and the query rejects `ConnectorError Write`. Task 2.6 test `partial insert batch logs only applied refs`.
9. **Wave 2: a dropped transaction is silent.** → Task 2.2 tests:
   - `DisposeAsync of a dropped transaction compensates then rejects`: `TransactionDroppedError`, with `Outcome === Compensated`, `TransactionId === txn.Id`, and `TransactionDropped` raised once;
   - `sync dispose of a dropped transaction throws at once`: `Outcome === undefined`, and the `Compensation` promise resolves to `Compensated`.
10. **Wave 2: two callers' batched writes stay apart.** → Task 2.4b test `concurrent batched creates keep their contexts`. Two transactions with contexts alice and bob each run a batched external CREATE at the same time. The fake connector sees two `Begin` calls with distinct contexts, each step carries only its own transaction's rows, and failing bob's step compensates only bob's (alice commits).

---

## Wave 1: read-time versions, transaction fetch (engine 0.3.0, TODL 0.55.0, host 0.2.0)

### Task 1.1: Row versions and expected versions (engine)

**Repo:** pragmatic-graph. **Parallel:** yes, alongside Task 1.6 (host). Engine tasks run in sequence.

**Files:**
- Modify:
  - `src/connectors/FetchContract.ts`
  - `src/access/FetchedNode.ts`
  - `src/connectors/ConnectorChangeSet.ts`
  - `src/connectors/WriteCoordinator.ts` (`INodeOrigins.Version`; `ChangeRouter.Emit` and `Created`)
  - `src/GraphTransaction.ts`
  - `src/index.ts`
- Test:
  - `src/connectors/tests/FetchSession.test.ts`
  - `src/connectors/tests/ExternalWrites.test.ts`
  - `src/connectors/tests/FakeExternalConnector.ts`: its transaction records `Applied: ConnectorChangeSet[]`

**Interfaces:**
- Consumes: `FetchSession.Known(publicId): IFetchedEntry | undefined`.
- Produces:
  - `export type RowVersion = string | number | bigint;`
  - `IFetchedRow.Version?: RowVersion`
  - `FetchedNode.Validated(catalog, row): IFetchedRow` copies the version (error constant `ErrVersion = 'Fetched row has an invalid version'`, SchemaViolation)
  - `type ConnectorChange = BatchOp & { readonly Owner: string; readonly Concept: string; readonly ExpectedVersion?: RowVersion }`
  - `INodeOrigins.Version(publicId: string): RowVersion | undefined`
  - `ChangeRouter.Emit(op: BatchOp, origin: INodeOrigin | undefined, routingId: string): void`

- [ ] **Step 1: Failing tests.**
  - `fetched row keeps its version`: `Lookup` of a row with `Version: 7n` returns `Version === 7n`.
  - `invalid version fails the fetch`: `Version: NaN` fails with `ConnectorError` Fetch, cause SchemaViolation.
  - `first fetched version wins`: a Scan yields x at 'a'. A Lookup after re-scripting x as 'b' keeps `Known('x').Row.Version === 'a'` and makes no new request.
  - `set on a fetched row carries its version`: `ExpectedVersion === 'v1'`.
  - `delete and its unlinks carry the version`: the R89 Unlink for fetched source y carries y's version 3, and the DeleteNode carries x's version.
  - `create carries no version`: neither the CreateNode nor the SetProperty after it carries one.
  - `unfetched system write carries no version`.
  - `mirrored changes carry no version`: `'ExpectedVersion' in change === false`.
- [ ] **Step 2: Run** `npx tsx --test src/connectors/tests/FetchSession.test.ts src/connectors/tests/ExternalWrites.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** V1 and V2. `GraphTransaction` origins: `Version: id => FederatedReads.Of(this).OpenSession?.Known(id)?.Row.Version`. ChangeRouter keeps a `createdHere: Set<string>`. Never add the key when the version is undefined.
- [ ] **Step 4: Run** the task's tests, `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Append R119 (V1–V3). Commit `feat(connectors): read-time row versions and expected versions`.

### Task 1.2: Scope-enforced transaction fetch by public id (engine). **M2.3 UNBLOCKER**

**Repo:** pragmatic-graph. **Parallel:** with Task 1.6 only (engine tasks run in sequence). Schedule it straight after Task 1.1, ahead of 1.3 and 1.4.

**Files:**
- Create: `src/connectors/TransactionFetch.ts` (internal, not exported)
- Modify: `src/GraphTransaction.ts` (`Fetch`), `src/connectors/FetchSession.ts` (`LookupMany`), `src/FederatedReads.ts` (only what TransactionFetch needs: `Session`, `StubIdentity`, `StoredNonStub`, `Setup`), `src/index.ts` (export `IFetchKey`, `IFetchedView`)
- Test: `src/connectors/tests/TransactionFetch.test.ts` (new; MemoryStore and LMDB), `src/connectors/tests/FetchSession.test.ts`

**Interfaces:**
- Consumes: `FetchSession.Lookup`/`Known`, `GraphReader.AdmitFetched(row, owner)`, `GraphReader.ReadNode`, `BindingTable.ExternalTargets(concept, catalog, external)`, `FederatedReads.StubIdentity`/`StoredNonStub`, `RowVersion`.
- Produces:
  - `export interface IFetchKey { readonly PublicId: string; readonly Concept?: string; readonly Owner?: string }`
  - `export interface IFetchedView extends INodeView { readonly External: boolean; readonly Version?: RowVersion }`
  - `GraphTransaction.Fetch(keys: readonly (string | IFetchKey)[]): Promise<ReadonlyMap<string, IFetchedView>>`
  - `FetchSession.LookupMany(publicIds: readonly string[], candidates: readonly IFetchTarget[], probe?: IReadProbe, scope?: IFetchScope): Promise<ReadonlyMap<string, IFetchedEntry>>`
  - internal `class TransactionFetch { constructor(reader: GraphTransaction, channel: FederatedReads); Resolve(keys: readonly IFetchKey[]): Promise<ReadonlyMap<string, IFetchedView>> }`

- [ ] **Step 1: Failing tests.** Fixture: binding `(crm, Customer) → ext`; scope with Customer rows `region = 'eu'` and hidden member `secret`.
  - `fetch then update of an external node via the transaction API succeeds`: `Fetch([{ PublicId: 'c1', Concept: 'Customer' }])` returns c1 with `External === true`. SetProperty and Commit resolve, and the fake holds one SetProperty for c1.
  - `write without a fetch is still refused`: `AccessError InvisibleNode`, and the fake's `BeginCount === 0`.
  - `out-of-scope id is not returned`: c2 (region 'us') is absent, and a SetProperty on c2 is InvisibleNode. For c1, `Properties.has('secret') === false`.
  - `fetched version becomes ExpectedVersion`: `Fetch(...).get('c1').Version === 'v7'`, and the committed change has `ExpectedVersion === 'v7'`.
  - `fetch is memoised for the session`: a second Fetch makes no request and the version stays 'v7' after the fake is re-scripted to 'v8'.
  - `batch fetch makes one request per candidate`: one request with `Keys` `['c1','c3','c4']`.
  - `stub resolves through its identity`: `Fetch(['c5'])` with no Concept returns c5 when an engine node links to it.
  - `unstubbed id without concept is absent and fetches nothing`: empty map, `Requests.length === 0`.
  - `engine node is served scoped`: `External === false`, `Version === undefined`. An invisible engine node is absent.
  - `engine node owns its id`: a connector row for an engine node's id gives the engine view.
  - `stub data is still not served by ReadNode`: after the Fetch, `txn.ReadNode('c5') === undefined`.
  - `fetch after commit is disposed`: `GraphError Disposed`.
  - FetchSession.test: `LookupMany memoises hits and misses`. `LookupMany falls back to one scan without KeyLookup`: a single request with `And(scope, IdIn{ids})`.
- [ ] **Step 2: Run** `npx tsx --test src/connectors/tests/TransactionFetch.test.ts src/connectors/tests/FetchSession.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** F1. `Fetch` calls `RequireActive()` first, groups keys by candidate list, calls `LookupMany`, then admits each row.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run typecheck`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Append R121 (F1). Commit `feat(txn): scope-enforced transaction fetch by public id (M2.3 unblocker)`.

### Task 1.3: Cypher `elementId` and by-id seek (engine)

**Repo:** pragmatic-graph. **Parallel:** with Task 1.6 only. Not on the M2.3 critical path.

**Files:**
- Modify:
  - `src/cypher/FunctionRegistry.ts` (`ElementIdName = 'elementid'`)
  - `src/cypher/LogicalPlanner.ts` and `src/cypher/SeekEquality.ts` (id seek for `elementId(v) = expr` and `elementId(v) IN expr`)
  - `src/cypher/FetchHint.ts` (`IdIn` push-down)
  - `src/cypher/CypherSource.ts`, `src/cypher/ReaderSource.ts`, `src/cypher/FederatedSource.ts` and `src/cypher/write/OverlaySource.ts` (`NodesById`)
- Test: `src/cypher/tests/ElementId.test.ts` (new)

**Interfaces:**
- Produces: `ICypherSource.NodesById(ids: readonly string[], label: string | undefined, probe?: IReadProbe): AsyncIterable<CypherNode>` (scoped; invisible ids skipped), and the Cypher function `elementId(node) → string`.

- [ ] **Step 1: Failing tests.**
  - `elementId returns the public id`.
  - `by-id match seeks engine nodes`: `EXPLAIN` shows the id-seek operator and no label scan.
  - `by-id match looks up external rows`: `MATCH (c:Customer) WHERE elementId(c) IN $ids SET c.name = 'x'` makes one keyed request and commits one SetProperty per admitted id.
  - `by-id match is scoped`: a hidden id yields no row, and nothing is written for it.
  - `elementId of a relationship is a type error`: `CypherError`.
- [ ] **Step 2: Run** `npx tsx --test src/cypher/tests/ElementId.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** F2.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Append the F2 part to R121. Commit `feat(cypher): elementId and by-id seek`.

### Task 1.4: Version conflicts surface as conflicts (engine)

**Repo:** pragmatic-graph. **Parallel:** with Task 1.6 only.

**Files:**
- Modify: `src/connectors/ConnectorError.ts`, `src/cypher/write/TransactionSink.ts` (`MapCommitError`)
- Test: `src/connectors/tests/WriteThrough.test.ts`, plus the existing Cypher write test file covering `MapCommitError` under `src/cypher/tests/`

**Interfaces:**
- Produces: `ConnectorError.IsConflict: boolean` (getter, V4). `MapCommitError` maps `IsConflict` to `CypherWriteErrorCode.Conflict`, checked before the generic ConnectorError branch.

- [ ] **Step 1: Failing tests.**
  - `connector conflict is flagged`: a Commit that throws `new ConflictError('stale')` gives `ConnectorError` with `Phase === Commit`, `IsConflict === true`, and GraphErrorCode `ConnectorFailed`.
  - `connector failure is not a conflict`.
  - `conflict with failed revert is still a conflict`: an AggregateError cause.
  - `stale version maps to Cypher Conflict`: `WriteCode === CypherWriteErrorCode.Conflict`.
- [ ] **Step 2: Run** `npx tsx --test src/connectors/tests/WriteThrough.test.ts` and the Cypher write test. Expected: FAIL.
- [ ] **Step 3: Implement** V4.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run typecheck`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Append R120. Commit `feat(connectors): connector version conflicts are conflicts`.

### Task 1.5: Fetched versions, read-time guards, guarded SQL deletes (TODL)

**Repo:** TODL. **Parallel:** with Tasks 1.3, 1.4 and 1.6, once the engine is built after Task 1.2. Earlier TODL work does not block it.

**Files:**
- Create: `src/engine-bridge/external/ExternalVersionConflict.ts`
- Modify:
  - `src/engine-bridge/external/DataSourceConnector.ts`: fetch fields gain `Binding.VersionField`; `Row` sets `Version`.
  - `src/engine-bridge/external/ExternalValues.ts`: add `ToVersion(value: ExternalFieldValue, subject: string): RowVersion | undefined` and `FromVersion(version: RowVersion): ExternalFieldValue`. A string or finite number passes, null is absent, anything else is `ExternalRowInvalid`.
  - `src/engine-bridge/external/ChangeBatcher.ts`: `PendingWrite.Expected?: RowVersion`, taken from the first non-create change on the id; plus `IPendingBatch.Expected: ReadonlyMap<WriteOperation, ExternalFieldValue>`.
  - `src/engine-bridge/external/DataSourceTransaction.ts`, for Optimistic batches:
    - `Guarded` takes the version from Expected, else from the before-image;
    - the pre-check fails on a mismatch, or on a missing before-image row for an op with an expected version;
    - adapter `Conflict` failures become `ExternalVersionConflict`;
    - Deletes carry the version too.
  - `src/model-data/sql-adapter.ts`: on an Optimistic batch, a Delete becomes `DELETE … WHERE idKey = $1 AND versionField = $2`; rowcount 0 is a Conflict failure.
- Test: `src/engine-bridge/external/tests/DataSourceConnectorRead.test.ts`, `src/engine-bridge/external/tests/DataSourceConnectorWrite.test.ts`, and the SQL adapter test file under `src/model-data/tests/`.

**Interfaces:**
- Consumes: `IFetchedRow.Version`, `ConnectorChange.ExpectedVersion`, `RowVersion`, `ConflictError` (engine, via the junction).
- Produces: `export class ExternalVersionConflict extends ConflictError { constructor(message: string, public readonly Binding: IExternalBinding, public readonly Failures: readonly WriteFailure[]) }`

- [ ] **Step 1: Failing tests.**
  - `fetched row carries the source version`: a record with `ver: 4` gives `row.Version === 4`.
  - `version field is fetched even when not requested`.
  - `boolean version is invalid`: `ExternalRowInvalid`.
  - `no version field, no version`.
  - `optimistic write uses the expected version`.
  - `optimistic write after a concurrent change fails with a version conflict`: expected 3 against a before-image of 4 gives `ExternalVersionConflict` (instanceof `ConflictError`), and `adapter.Apply` is not called.
  - `adapter conflict is a version conflict`.
  - `no expected version falls back to the before-image`.
  - `last-write-wins ignores expected versions`.
  - `optimistic delete with a stale version conflicts`: SQL, with the row remaining.
  - `compensation still guards with post-commit versions`: the R113 test, unchanged.
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/engine-bridge/external/tests/DataSourceConnectorRead.test.ts src/engine-bridge/external/tests/DataSourceConnectorWrite.test.ts` and the SQL adapter test. Expected: FAIL.
- [ ] **Step 3: Implement** V1–V3 (TODL side) and G1 (SQL).
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit -p .`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit in TODL `feat(engine-bridge): read-time optimistic versions and guarded deletes`. Append R122 (G1) in the engine repo, `docs: R122`.

### Task 1.6: Guarded deletes in the host adapters (connectors-host)

**Repo:** todl-connectors-host. **Parallel:** yes, with Tasks 1.1–1.5. It uses only the existing `WriteOperation.Version`.

**Files:**
- Modify:
  - `src/rest/rest-adapter.ts`: an Optimistic Delete sends `If-Match: <Version>`; 409 or 412 is a Conflict; a missing version is a Conflict with no request, fail-closed as for PUT.
  - `src/rest/graphql-adapter.ts`: an Optimistic Delete binds the configured version argument, and without one it is Unsupported.
  - `src/document/document-adapter.ts`: an Optimistic Delete checks `ReadVersionState` first; a mismatch is a Conflict.
  - `src/cypher/cypher-adapter.ts`: `MATCH … WHERE n.<ver> = $ver DETACH DELETE n RETURN count(n)`; 0 is a Conflict.
  - `src/testing/adapter-conformance.ts`, plus the fakes as needed.
- Test: the conformance suite, run per adapter kind.

- [ ] **Step 1: Failing test** (conformance, every kind with `CanVersion`): `optimistic delete with a stale version conflicts` (the Conflict failure; the record still exists). `optimistic delete with the current version deletes`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** G1 per adapter.
- [ ] **Step 4: Run** `npm test`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(adapters): version-guarded deletes`.

### Task 1.7: Wave 1 release (engine 0.3.0, TODL 0.55.0, host 0.2.0). **M2.3 GATE**

**Repo:** all three, in order. **Parallel:** no. M2.3's O1-dependent tasks wait for this release; they do not build against an unreleased engine. Keep the wave small: Tasks 1.1–1.6 have no Wave 2 dependency, so this task can run as soon as they are green.

**Files:**
- Engine: `src/index.ts` (verify exports), `src/tests/PublicSurface.test.ts`, `README.md` (versions, `Fetch`, `elementId`), `package.json` `0.3.0`, `docs/decisions.md`.
- TODL: `package.json` version `0.55.0`, with peer and dev `@pragmatic-tech-ai/graph` set to `^0.3.0` by hand.
- Host: `package.json` version `0.2.0`, with `@pragmatic-tech-ai/graph` set to `^0.3.0`.

- [ ] **Step 1: Failing test** `public surface exports wave 1`: imports `RowVersion` and `IFetchKey`/`IFetchedView` (types), and checks that `ConnectorError.prototype` has `IsConflict`. Also run `npm ls @pragmatic-tech-ai/graph` in TODL, which reports invalid before the range edit.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** the exports, docs and version edits. **Engine 0.3.0 is additive and non-breaking**: optional fields, a new method, a new function, a getter. It is a minor bump only because `^0.2.0` does not admit 0.3.0.
- [ ] **Step 4: Run** engine `npm test && npm run typecheck && npm run build`, then TODL `npm test && npx tsc --noEmit -p . && npm run build`, then host `npm test && npm run build`. Expected: PASS everywhere, and `npm ls` is valid.
- [ ] **Step 5:** Commit engine `chore: 0.3.0 — read-time versions and transaction fetch`, TODL `chore: 0.55.0`, host `chore: 0.2.0`. Publishing (engine first) waits for the owner. Once 0.3.0 is published, notify the controller: that opens the M2.3 gate.

---

## Wave 2: immediate external writes (engine 0.4.0, TODL 0.56.0, host 0.3.0)

### Task 2.1: Write steps, step routing and the immediate connector contract (engine)

**Repo:** pragmatic-graph. **Parallel:** yes, alongside Tasks 2.5 (TODL language) and 2.7 (host inserts). Engine tasks run in sequence.

**Files:**
- Create: `src/connectors/StepRouter.ts` (from `WriteCoordinator.Route`'s ChangeRouter, BatchEdges and ExternalWriteCheck use, now persistent)
- Modify:
  - `src/connectors/GraphConnector.ts` (E3 types)
  - `src/connectors/ConnectorError.ts` (append `Write`)
  - `src/connectors/WriteCoordinator.ts`: `Route` delegates to a fresh StepRouter for one-shot callers; `Run` takes the already-executed External steps and runs Mirrored, External finalize and engine finalize
  - `src/connectors/ExternalWriteCheck.ts` (`Finish(created: ReadonlySet<string>)` per step)
  - `src/access/WriteGate.ts` (`from: number` parameter)
  - `src/GraphTransaction.ts` (`Flush`, the step log, the final flush in Commit)
  - `src/index.ts`
- Test: `src/connectors/tests/ImmediateWrites.test.ts` (new; MemoryStore and LMDB), plus updates to `ExternalWrites.test.ts` and `WriteThrough.test.ts` (Mirrored unchanged). `FakeExternalConnector` gains an executing transaction: `Executed: { Step: number; Changes: ConnectorChangeSet }[]`, `UndoCalls`, scripted `Versions`, and throw-at-step-N.

**Interfaces:**
- Produces:
  - E3: `IConnectorApplyResult`, `IAssignedCreate`, the optional `Create` and `Undo`, and the widened `Apply` result type.
  - `ConnectorPhase.Write = 'Write'`
  - `GraphTransaction.Flush(): Promise<void>`
  - ```ts
    export class StepRouter
    {
        public constructor(table: BindingTable, index: CatalogIndex, origins: INodeOrigins, external: ReadonlySet<string>);
        public Route(ops: readonly BatchOp[]): Promise<IRoutedStep>;
        public Created(publicId: string, origin: INodeOrigin): void;   // also used by CreateAssigned (Task 2.3)
    }
    export interface IRoutedStep
    {
        readonly External: ReadonlyMap<string, ConnectorChangeSet>;
        readonly Mirrored: ReadonlyMap<string, readonly ConnectorChange[]>;
        readonly Engine: readonly BatchOp[];
    }
    ```
  - `WriteGate.Check(evaluator, batch, catalog, exempt, fetched?, from?: number): Promise<void>`

- [ ] **Step 1: Failing tests.**
  - `flush executes external ops now`: after `SetProperty` on a fetched external node and `await txn.Flush()`, the fake has executed one step before Commit.
  - `ops on one id merge within a step`: CreateNode plus 3 SetProperty, then Flush, gives one change set holding all four ops, executed once.
  - `commit flushes remaining ops`: no explicit Flush still executes the ops, as the step before Prepare.
  - `steps are routed by connector in name order`: steps touching B then A in one flush execute A before B.
  - `mirrored connectors still stage until commit`: the FakeConnector `Apply` and `Commit` calls happen inside Commit, after the final flush.
  - `external commit only finalizes`: the fake's `Commit` is called after Prepare succeeds, with no remote effect recorded.
  - `required members are judged per create step`: a CreateNode without a required member, flushed, rejects `CommitError MissingRequired` before any connector call.
  - `gate runs per step`: a denied SetProperty in step 2 rejects at that Flush, and step 1 is then compensated (asserted fully in Task 2.2; here, assert that the step did not execute).
  - `deleted id stays deleted across steps`: DeleteNode, Flush, then SetProperty on the same id, Flush, gives `CommitError UnknownNode`.
  - `step failure is ConnectorError Write`: the fake throws at step 2, so `Flush` rejects with `Phase === Write`.
- [ ] **Step 2: Run** `npx tsx --test src/connectors/tests/ImmediateWrites.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** E1 (transaction API), E2 and E3. Assign step numbers per transaction. Keep the transaction's engine batch as the concatenation of each step's `Engine`.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Append R123 (E1, E2) and the E3 part of R124. Commit `feat(connectors): write steps and immediate external writes`.

### Task 2.2: Compensation, abort and outcomes (engine)

**Repo:** pragmatic-graph. **Parallel:** with Tasks 2.5 and 2.7 only.

**Files:**
- Create: `src/connectors/Compensator.ts` (walks the step log in reverse; Undo, else Revert; deadline; signals)
- Modify:
  - `src/connectors/ConnectorApplied.ts`: `enum ConnectorOutcome`, `Outcome` field
  - `src/connectors/WriteCoordinator.ts`: `Failed` delegates to the Compensator; ConnectorRevertFailed raised for every failed compensation
  - `src/GraphTransaction.ts`: `Abort()`, `Id`, `DisposeAsync()` / `[Symbol.asyncDispose]`, the throwing `dispose()` for dropped transactions, the internal non-throwing end used by Commit, and the ConnectorApplied raise at the end
  - `src/errors/GraphError.ts`: append `TransactionDropped = 15`
  - Create `src/txn/TransactionDroppedError.ts`
  - `src/GraphStore.ts` and `src/GraphEngine.ts`: the `TransactionDropped` signal, and the internal `Drop` used at store dispose
  - `src/index.ts`
- Test: `src/connectors/tests/Compensation.test.ts` (new; MemoryStore and LMDB)

**Interfaces:**
- Produces:
  - `export enum ConnectorOutcome { Committed = 1, Compensated = 2, CompensationFailed = 3 }`
  - `IConnectorApplied.Outcome: ConnectorOutcome`
  - `GraphTransaction.Abort(): Promise<void>`
  - `GraphTransaction.Id: string`
  - `GraphTransaction.DisposeAsync(): Promise<void>` and `[Symbol.asyncDispose]`
  - `export class TransactionDroppedError extends GraphError { readonly TransactionId: string; readonly Steps: number; readonly Compensation: Promise<ConnectorOutcome>; readonly Outcome?: ConnectorOutcome }`
  - `GraphEngine.TransactionDropped: ISignal<TransactionDroppedError>` (and on `GraphStore`)
  - internal `class Compensator { constructor(setup: ConnectorSetup, lateFailures: Signal<ConnectorError>); Run(log: readonly IExecutedStep[], mirrored: readonly IConnectorTransaction[], failure: unknown): Promise<unknown> }`, where `IExecutedStep { Connector: IGraphConnector; Txn: IConnectorTransaction; Step: number }`. `Run` resolves with the error to throw (E6).

- [ ] **Step 1: Failing tests.**
  - `abort compensates executed steps in reverse order`: steps run on A, B, A, then one more op is recorded without a flush, then `Abort()`. `UndoCalls` across fakes is `[A, B, A]` in that order, the unflushed op never executes, and `ConnectorApplied.Outcome === Compensated`.
  - `engine conflict at prepare compensates external steps`: two steps executed, then a concurrent commit to a read key. `Commit` rejects with `ConflictError` (as-is), both steps are undone, the engine is unchanged, and `Outcome === Compensated`.
  - `step failure compensates earlier steps`: step 3 throws, so steps 1 and 2 are undone in reverse. The fake undoes step 3's partially applied ops itself, through its Undo of step 3, which is logged before the throw. Flush rejects `ConnectorError Write`, and later calls are `GraphError Disposed`.
  - `failed compensation surfaces`: during the compensation for a step failure, A's Undo throws. The caller gets `ConnectorError` with cause `AggregateError`, where `errors[0]` is the step failure and `errors[1]` is the Undo error. `ConnectorRevertFailed` fires once, naming A. `Outcome === CompensationFailed`. B's Undo still ran.
  - `connector without Undo is reverted after later steps`: an External fake without `Undo`: its `Revert` runs once, after the Undo of every later step.
  - `mirrored connectors are reverted on failure`: the FakeConnector `Revert` is called.
  - `DisposeAsync of a dropped transaction compensates then rejects`: one step executed, then `await txn.DisposeAsync()`. It rejects with `TransactionDroppedError` where `GraphErrorCode === TransactionDropped`, `TransactionId === txn.Id`, `Steps === 1` and `Outcome === Compensated`. The step was undone *before* the rejection. `TransactionDropped` and `ConnectorApplied` (Compensated) were each raised once.
  - `sync dispose of a dropped transaction throws at once`: `txn.dispose()` throws `TransactionDroppedError` synchronously with `Outcome === undefined`. `await err.Compensation` resolves to `Compensated`, the step is undone, and `TransactionDropped` is raised once after compensation.
  - `dropped transaction with failed compensation`: Undo throws, so `Outcome` / `Compensation` gives `CompensationFailed`, and `ConnectorRevertFailed` is raised as well.
  - `disposing a clean transaction does not throw`: nothing executed, or committed, or aborted; neither `dispose()` nor `DisposeAsync()` throws.
  - `store dispose drops open transactions without throwing`: `GraphStore.dispose()` with an open transaction that has one step compensates it, raises `TransactionDropped`, and returns normally.
  - `successful commit reports Committed once`: one `ConnectorApplied` with `Outcome === Committed` and `Commit` set. An all-external commit gives `Commit === undefined` and `Committed`.
  - `no participation raises nothing`.
  - `drop compensates each transaction on its own connector transactions`: two open transactions with different contexts each execute a step on one connector. Dropping one compensates only its own connector transaction, in its own reverse order, and the other commits untouched.
- [ ] **Step 2: Run** `npx tsx --test src/connectors/tests/Compensation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** E6 and the ConnectorApplied part of E7.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Append the E6 part of R125 and R126 (E7, E8). Commit `feat(connectors): compensation of immediate external writes`.

### Task 2.3: Source-assigned creates and the version ledger (engine)

**Repo:** pragmatic-graph. **Parallel:** with Tasks 2.5 and 2.7 only.

**Files:**
- Modify:
  - `src/GraphTransaction.ts` (`CreateAssigned`)
  - `src/connectors/FetchSession.ts`: `Remember(row, model)` becomes internal-public for created rows, plus a new `VersionLedger`, held by the transaction, that keeps reported versions apart from the read memo
  - `src/connectors/StepRouter.ts`: ExpectedVersion comes from the ledger (E5)
  - `src/index.ts` (export `IAssignedLink`)
- Test: `src/connectors/tests/AssignedCreates.test.ts` (new; MemoryStore and LMDB)

**Interfaces:**
- Produces:
  - `export interface IAssignedLink { readonly Relationship: string; readonly To: string }`
  - `GraphTransaction.CreateAssigned(requests: readonly IAssignedCreate[]): Promise<readonly IFetchedView[]>` (index-aligned; `IAssignedCreate.Links: readonly IAssignedLink[]`)
  - internal `class VersionLedger { Reported(publicId: string, version: RowVersion): void; Expected(publicId: string, fetched: RowVersion | undefined, createdHere: boolean): RowVersion | undefined }`

- [ ] **Step 1: Failing tests.**
  - `assigned create returns the real id`: the fake's `Create` returns row `{ PublicId: 'Order#ext.orders#41', Values: id → 41n, Version: 1 }`. The result view has that PublicId and `Properties.get('id') === 41n`.
  - `later ops on an assigned create route external and are guarded`: after CreateAssigned, SetProperty on the returned id plus a Flush executes with `ExpectedVersion === 1`.
  - `reported versions supersede fetched ones`: fetch at 'v1'; step 1 reports 'v2'; the step 2 change carries `'v2'`.
  - `engine link to an assigned create is stored under the real id`: `Link(e1, 'orders', id, { ExternalTarget })` and Commit, then `Links(e1, 'orders')` equals `[id]`.
  - `invalid created row fails and compensates`: a returned row of another concept fails with `ConnectorError Write`, cause SchemaViolation, and the fake's Undo ran once.
  - `created id colliding with an engine node fails`: cause `CommitError DuplicatePublicId`, with Undo.
  - `connector without Create refuses`: `ConnectorError Write`, cause GraphError code `Unsupported`.
  - `assigned create flushes pending ops first`: a step with a recorded SetProperty executes before the Create.
  - `batched creates map outcomes by position`: three requests give three views in request order, with distinct ids. A connector returning two outcomes for three requests fails with `ConnectorError Write`, cause GraphError `Internal`, and Undo runs.
  - `one error outcome fails the step and undoes the rest`: outcomes `[Row, Error, Row]` fail the step with `ConnectorError Write`, and the fake's Undo of that step ran once (the fake asserts it removed exactly the two rows it created).
  - `requests group by connector`: requests for connectors B, A, B give two `Create` calls, A before B, B's carrying 2 requests.
- [ ] **Step 2: Run** `npx tsx --test src/connectors/tests/AssignedCreates.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** E4 (engine side) and E5.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Append the E4 part of R124 and the E5 part of R125. Commit `feat(txn): source-assigned creates and the version ledger`.

### Task 2.4: Cypher writes through immediately (engine)

**Repo:** pragmatic-graph. **Parallel:** with Tasks 2.5 and 2.7 only.

**Files:**
- Modify:
  - `src/cypher/write/CypherSink.ts`: `CreateNode` becomes async; add `EndStep(): Promise<void>`
  - `src/cypher/write/TransactionSink.ts`:
    - records directly on the transaction (SetDefault and DetachUnlink directly, so the index-keyed `defaults`/`detaches` bookkeeping goes);
    - `EndStep` runs `transaction.Flush()`, and `CreateNode` uses `CreateAssigned` for `KeyAssigned` places;
    - `Commit` calls only `transaction.Commit()`
  - `src/cypher/write/PathCreator.ts`: creation order puts the targets of new external nodes first; a new external source's outgoing links go into its create (`CreateAssigned` links, or ops in the same step); the remaining links follow
  - `CreateOperator.ts`, `MergeOperator.ts`, `SetOperator.ts`, `RemoveOperator.ts`, `DeleteOperator.ts`: `await sink.EndStep()` after each row
  - `src/cypher/write/ExplainSink.ts`: no-op `EndStep`
  - `src/cypher/write/NodePlacement.ts`: `INodePlace.KeyAssigned?: true`
  - `src/cypher/write/WriteQueryRunner.ts`: the class comment drops "nothing has reached the transaction"; on a Run error the caller aborts
  - `src/cypher/CypherEngine.ts`: `ExecuteWrite` awaits `transaction.Abort()` on any error before rethrowing (mapped)
- Test: `src/cypher/tests/CypherImmediateWrites.test.ts` (new)

**Interfaces:**
- Produces: `ICypherSink.CreateNode(concept, properties, links?: readonly IAssignedLink[]): Promise<CypherNode>`; `ICypherSink.EndStep(): Promise<void>`; `INodePlace.KeyAssigned?: true`.

- [ ] **Step 1: Failing tests** (the placement returns `KeyAssigned` for `Order`; the fake connector assigns serials):
  - `CREATE returns the real id and key`: `CREATE (o:Order {total: 5}) RETURN o, o.id, elementId(o)` returns the node id `Order#ext.orders#1`, `o.id` 1, and `elementId` equal to the node id.
  - `one step per row per clause`: `UNWIND [1,2,3] AS x CREATE (n:Ext {k: x}) RETURN n` runs three steps in row order. The query is dependent, so it stays per-row after Task 2.4b too.
  - `pattern creates targets first`: `CREATE (o:Order)-[:customer]->(c:Customer)`, both external on one connector. The Customer create runs first, and the Order create's links carry the customer's real id.
  - `a later clause sees the assigned key`: `CREATE (o:Order {total: 5}) WITH o MATCH (a:Account {k:1}) CREATE (a)-[:places]->(o)`, after which the engine edge is stored to the real id.
  - `failed statement compensates its steps`: the second row's create throws. The query rejects `CypherWriteError ConnectorFailed`, row 1's step is undone, and `Outcome === Compensated`.
  - `stale SET mid-statement is a Conflict and compensates`.
  - `engine-only query is unchanged`: the existing Cypher write suite passes.
- [ ] **Step 2: Run** `npx tsx --test src/cypher/tests/CypherImmediateWrites.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** E1 (Cypher) and the Cypher part of E4.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run typecheck`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Append the Cypher part of R123. Commit `feat(cypher): write through immediately (per-row steps)`.

### Task 2.4b: Cross-row batching of external write clauses (engine)

**Repo:** pragmatic-graph. **Parallel:** with Tasks 2.5 and 2.7 only (it follows Task 2.4).

**Files:**
- Create: `src/cypher/write/WriteDependencyAnalysis.ts`, `src/cypher/write/BatchedWriteOperator.ts` (the eager drain, stage plan, row ↔ request map and yield)
- Modify:
  - `src/cypher/CypherEnums.ts`: `enum WriteMode { PerRow = 1, Batched = 2 }`
  - `src/cypher/LogicalPlanner.ts`: `PlanForWrite` runs the analysis and wraps Batched clauses
  - `src/cypher/write/PathCreator.ts`: stage computation shared with the batched operator
  - `CreateOperator.ts`, `MergeOperator.ts`, `SetOperator.ts`, `RemoveOperator.ts`, `DeleteOperator.ts`: take a `WriteMode`, and call `EndStep` per row only when PerRow
  - `src/cypher/write/TransactionSink.ts`: `CreateNodes(batch)` for a batched stage, routing to `CreateAssigned` and to record-then-Flush
  - `src/cypher/OperatorPrinter.ts`: prints the mode
- Test: `src/cypher/tests/WriteBatching.test.ts` (new)

**Interfaces:**
- Produces:
  - ```ts
    export class WriteDependencyAnalysis
    {
        public constructor(catalog: CatalogSnapshot, external: (concept: string) => boolean);
        /** One mode per clause index of the model; non-write clauses are absent. Conservative (E10). */
        public Modes(model: CypherQueryModel): ReadonlyMap<number, WriteMode>;
    }
    ```
  - `ICypherSink.CreateNodes(stage: readonly IStagedCreate[]): Promise<readonly CypherNode[]>` (index-aligned), where `IStagedCreate { Concept: string; Properties: ReadonlyMap<string, CypherScalar>; Links: readonly IAssignedLink[] }`

- [ ] **Step 1: Failing tests.** The fixture is an external `Order` (keys source) and `Customer` on one fake connector that assigns serials and counts `Create`/`Apply` calls, plus engine `Account`.
  - **Independent clauses batch:**
    - `independent multi-row CREATE is one batched step`: `UNWIND range(1,5) AS i CREATE (:Order {total: i})`. EXPLAIN shows `Batched`, the fake receives exactly **one** `Create` call with 5 requests, and the fake's table holds 5 rows with keys 1..5.
    - `batched rows get their real keys`: `UNWIND range(1,3) AS i CREATE (o:Order {total: i}) RETURN count(*)` gives count 3 with one call. Then a following query, `MATCH (o:Order) RETURN o.id ORDER BY o.id`, returns `[1,2,3]`.
    - `batched SET is one step`: `MATCH (c:Customer) SET c.flag = true`, with no later use, makes one `Apply` holding every row's SetProperty. Each change carries its own fetched `ExpectedVersion`.
  - **Dependent clauses go per-row:**
    - `dependent clause forces per-row`: each of the following is `PerRow` in EXPLAIN, and the fake receives one call per row:
      - `UNWIND [1,2] AS i CREATE (o:Order {total: i}) RETURN o.id`
      - `… CREATE (o:Order) WITH o MATCH (a:Account {k: 1}) CREATE (a)-[:places]->(o)`
      - `… CREATE (o:Order) SET o.note = 'x'`
      - `… CREATE (o:Order) WITH o MATCH (x:Order) RETURN count(x)` (label overlap)
      - `… CREATE (o:Order) WITH * RETURN 1`

      In each, the later clause sees the real keys: `o.id` holds the serials, and the Account edges are stored to the real ids.
    - `alias closure is followed`: `UNWIND [1,2] AS i CREATE (o:Order) WITH collect(o) AS os RETURN size(os)` is PerRow.
    - `unrelated later clause keeps batching`: `UNWIND [1,2] AS i CREATE (:Order {total: i}) WITH 1 AS one MATCH (a:Account) RETURN a.k` is Batched (Account does not overlap Order).
  - **Stages and failures:**
    - `pattern stages batch targets first`: `UNWIND [1,2] AS i CREATE (o:Order {total: i})-[:customer]->(c:Customer {name: 'n'})` makes two `Create` calls: Customers (2 requests), then Orders (2 requests), each order's FK being its own row's customer key.
    - `partial batch failure compensates exactly the applied rows`: the fake applies requests 0 and 2 and reports request 1 as an Error outcome. The query rejects `CypherWriteError ConnectorFailed`, the fake's Undo deletes exactly keys of requests 0 and 2, request 1 never applied, and earlier steps of the query are undone too.
    - `concurrent batched creates keep their contexts`: the Review Focus item 10 scenario (alice and bob, batched CREATE at once). Each `Begin` carries its own context, each step holds only its own rows, and bob's failure compensates only bob's rows.
- [ ] **Step 2: Run** `npx tsx --test src/cypher/tests/WriteBatching.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** E10.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run typecheck`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Append R128 (E10). Commit `feat(cypher): batch independent external write clauses across rows`.

### Task 2.5: `keys source` binding attribute (TODL)

**Repo:** TODL. **Parallel:** yes, alongside Tasks 2.1–2.4 and 2.7. It needs no engine change.

**Files:**
- Modify:
  - `src/model-data/connector-plan.ts`: `enum KeyAssignment`, `ConnectorBinding.KeyAssignment?`; the validator makes `keys source` on a read-only binding a plan error
  - `src/compiler-services/parse/ast.ts`: `PopulateDecl.keyAssignment: string | null`
  - `src/compiler-services/parse/parser.ts`: `KeysMember = "keys"`, `KeyAssignmentValues`, `ExpectedKeysMessage = "expected keys client or source"`, added to `WriteModeMembers`
  - `src/compiler-services/parse/loader.ts`: passes it to `defineBinding`
  - `src/compiler-services/model/builder.ts`: `BindingKeyAssignmentAttr = "keyAssignment"` and a trailing parameter
  - `src/codegen/connector-plan-emitter.ts`: `KeyAssignmentOf`, emitting `KeyAssignment.Source` only when Source
- Test: the existing populate-block parser test, connector-plan emitter test and plan validator test files, in their `tests/` folders.

**Interfaces:**
- Produces: `export enum KeyAssignment { Client = "client", Source = "source" }`; `ConnectorBinding.KeyAssignment?: KeyAssignment`.

- [ ] **Step 1: Failing tests.**
  - `parses keys source`.
  - `rejects unknown keys value`: the message is `expected keys client or source`.
  - `emits KeyAssignment.Source`: and a binding without the attribute emits no property.
  - `keys source on a read-only binding is a plan error`.
- [ ] **Step 2: Run** the three files with `npx tsx --conditions=development --test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(connectors): keys source binding attribute`.

### Task 2.6: Immediate DataSourceTransaction, inserts with assigned keys, placement (TODL)

**Repo:** TODL. **Parallel:** no. It needs engine Task 2.4 built and TODL Task 2.5.

**Files:**
- Modify:
  - `src/model-data/connector-plan.ts`: `WriteOperationKind.Insert = "insert"` (appended), `WriteOperation.Ref?: string`, `interface IAssignedKey`, `WriteResult.Assigned?`
  - `src/model-data/data-source-adapter.ts`: `CanAssignKeys?: boolean`
  - `src/model-data/version-bumping-adapter.ts`, `src/model-data/reconnecting-adapter.ts`: forward `CanAssignKeys` and `Assigned`
  - `src/model-data/sql-adapter.ts`: Insert is `INSERT INTO src (fields) VALUES (…) RETURNING idKey[, versionField]` through `session.Query`; `CanAssignKeys = true`
  - `src/engine-bridge/EngineBridgeError.ts`: append `KeyNotAssigned`
  - `src/engine-bridge/external/ExternalWriteError.ts`: the code union gains it
  - `src/engine-bridge/external/ExternalIdentity.ts`: `KeyAssignmentOf(binding): KeyAssignment`
  - `src/engine-bridge/external/ChangeBatcher.ts`: per step, with no cross-Apply re-merge
  - `src/engine-bridge/external/DataSourceTransaction.ts`: E9 (`Apply` executes; `Create`, `Undo`, finalize-only `Commit`, `Revert`; attempts grouped per step)
  - `src/engine-bridge/external/DataSourceConnector.ts`: exposes its row builder to the transaction, for `Create`'s re-read
  - `src/engine-bridge/environment/EnvironmentNodePlacement.ts`: E9 placement
  - `src/engine-bridge/index.ts`
- Test: `src/engine-bridge/external/tests/DataSourceConnectorWrite.test.ts`, `src/engine-bridge/environment/tests/EnvironmentNodePlacement.test.ts`, the SQL adapter test file, and `src/engine-bridge/external/tests/ImmediateWritesEndToEnd.test.ts` (new: a real `GraphEngine` on MemoryStore with an environment description, `DataSourceConnector` over `SqlAdapter` on the in-memory SQL session, and Cypher through `CypherEngine.Execute` with `EnvironmentNodePlacement`)

**Interfaces:**
- Consumes: E3 and E4 (engine 0.4.0 surface), `KeyAssignment` (Task 2.5).
- Produces:
  - `interface IAssignedKey { Ref: string; Key: ExternalFieldValue; Version?: ExternalFieldValue }`
  - `WriteResult.Assigned?: readonly IAssignedKey[]`
  - `IDataSourceAdapter.CanAssignKeys?: boolean`
  - `DataSourceTransaction.Apply(changes): Promise<IConnectorApplyResult>`, plus `Create(requests: readonly IAssignedCreate[]): Promise<readonly IAssignedOutcome[]>` and `Undo(): Promise<void>`
  - Adapter contract: `WriteResult.Assigned` is keyed by `Ref`, and its order is irrelevant. An adapter may use a bulk insert only when it can correlate each key to its Ref (Mongo `insertMany` `insertedIds` by index; Neo4j `UNWIND $rows … RETURN row.ref, key`). SQL runs one `INSERT … RETURNING` per op, because multi-row `RETURNING` order is not guaranteed.
  - `ExternalIdentity.KeyAssignmentOf(binding): KeyAssignment`
  - `EngineBridgeErrorCode.KeyNotAssigned`

- [ ] **Step 1: Failing tests.**
  - SQL: `sql insert returns the assigned key`: `Assigned` equals `[{ Ref: 'r1', Key: 1 }]`. `sql insert returns the version`.
  - Placement: `source-keyed create without id is key-assigned`: `KeyAssigned === true`, `PublicId === ''`, `Owner === binding.Model`, no Defaults. `source-keyed create with id mints as today`. `client-keyed create unchanged`.
  - Transaction:
    - `apply executes the step`: `adapter.Apply` is called inside Apply, and Apply resolves with the reported `Versions` keyed by public id.
    - `undo compensates only the latest step`: two steps, one `Undo()`; only step 2's ops are compensated.
    - `revert undoes every remaining step in reverse`.
    - `commit only finalizes`: no adapter call.
    - `create inserts and returns the re-read row`: the PublicId is `Mint(binding, '1')`, the Values hold the id member 1 and the column defaults, and the Version is set.
    - `insert without a returned key fails with KeyNotAssigned and deletes nothing`.
    - `source binding over an adapter without CanAssignKeys is unsupported`.
    - `create undo deletes the assigned key`.
    - `create maps outcomes by Ref`: the adapter returns `Assigned` in reverse order, and the outcomes are still index-aligned with the requests.
    - `partial insert batch logs only applied refs`: under Sequential, op 1 of 3 fails, so the outcomes are `[Row, Error, Row]`. `Undo` deletes exactly the keys of refs 0 and 2. Under Transactional over a transacting adapter, all three are Error and Undo issues nothing.
    - `transactional binding is atomic per step`.
  - End to end:
    - `CREATE with a foreign key to a new source-keyed row` (Review Focus 6).
    - `abort after two statements' steps compensates both`: in a GraphTransaction with Flush, Fetch, SetProperty, then Flush, CreateAssigned, then Abort, the SQL table holds its original rows.
    - `stale optimistic SET fails as Cypher Conflict`: `ver` is bumped in SQL between the query's MATCH and SET, through a hook between the clauses.
- [ ] **Step 2: Run** `npx tsx --conditions=development --test` on the listed test files. Expected: FAIL.
- [ ] **Step 3: Implement** E9 and the adapter contract.
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit -p .`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit in TODL `feat(engine-bridge): immediate external writes and source-assigned keys`. Append R127 (E9) in the engine repo, `docs: R127`.

### Task 2.7: Host inserts with assigned keys (connectors-host)

**Repo:** todl-connectors-host. **Parallel:** yes, alongside Tasks 2.1–2.5. It needs only Task 2.6's adapter contract: land 2.6's `connector-plan.ts` and `data-source-adapter.ts` edits first, as their own TODL commit `feat(model-data): insert operation and assigned keys`, then build TODL.

**Files:**
- Modify:
  - REST:
    - `src/rest/rest-http-client.ts`: `RestResponse.Headers?: Readonly<Record<string, string>>`
    - `src/rest/rest-adapter.ts`:
      - Insert is `POST` to `CollectionUrl(source)`;
      - the key is the body field `IdKey`, else the last path segment of `Location`, and neither is an Error failure with Reason `KeyNotReturnedReason`;
      - the version is `ETag`;
      - `CanAssignKeys = true`
  - GraphQL:
    - `src/rest/graphql-adapter.ts`:
      - config keys `insertMutation`, `insertInputArg` (default `input`), `insertInputType` (default `JSON!`);
      - the selection is `IdKey` plus the version field, and the key comes from `data.<insertMutation>.<IdKey>`;
      - `CanAssignKeys` is true only when `insertMutation` is set
    - `../TODL/src/model-data/connector-plan.ts`: `GraphQlIdentifierKeys` gains `insertMutation` and `insertInputArg`. This is a TODL commit, `feat(model-data): validate GraphQL insert config`.
  - Document:
    - `src/document/document-session.ts`: `Insert?(collection: string, doc: Record<string, unknown>): Promise<unknown>`
    - `src/document/mongo-document-session.ts`: `insertOne`, returning `insertedId`
    - `src/document/document-adapter.ts`: Insert only when `IdKey === '_id'` (else Unsupported); an ObjectId key becomes a hex string; `CanAssignKeys = session.Insert !== undefined`
  - Cypher: `src/cypher/cypher-adapter.ts`: Insert is `CREATE (n:<Label>) SET n += $fields, n.<IdKey> = randomUUID() RETURN n.<IdKey> AS key[, n.<ver> AS ver]` (a stable source-assigned property; `elementId` is not stable across stores); `CanAssignKeys = true`
  - Testing: `src/testing/fake-rest-http-client.ts`, `fake-graphql-http-client.ts`, `fake-document-session.ts`, `fake-cypher-session.ts`, `adapter-conformance.ts`
- Test: the conformance suite per kind (SQL via pg-mem, REST, GraphQL, Document, Cypher).

**Interfaces:**
- Consumes: `WriteOperationKind.Insert`, `WriteOperation.Ref`, `WriteResult.Assigned`, `CanAssignKeys`.
- Produces: per-adapter `CanAssignKeys`, `IDocumentSession.Insert?`, `RestResponse.Headers?`.

- [ ] **Step 1: Failing tests.**
  - `insert returns one assigned key per ref`: refs `['r1','r2']`, distinct non-null keys, each `Assigned` entry naming its Ref.
  - `bulk insert correlates by ref`: Mongo `insertMany` and Neo4j `UNWIND` return keys matched to Refs even when the fake reorders its results.
  - `partial bulk insert reports per ref`: one op fails, so it gets a failure naming its Ref, and only the applied Refs appear in `Assigned`.
  - `rest key from Location`: `'42'` from `Location: /orders/42`.
  - `rest insert without key is a failure`.
  - `graphql without insertMutation cannot assign`.
  - `mongo insert needs _id key`.
  - `cypher insert assigns a uuid property`: and a MATCH by that key finds the node.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(adapters): inserts with source-assigned keys`.

### Task 2.8: Wave 2 release (engine 0.4.0, TODL 0.56.0, host 0.3.0)

**Repo:** all three, in order. **Parallel:** no (last).

**Files:**
- Engine: `src/index.ts` (verify), `src/tests/PublicSurface.test.ts`, `README.md` (immediate external writes, steps, compensation, `CreateAssigned`, outcomes), `docs/format/on-disk-format.md` (one Log-section sentence: "External writes never reach the log; only engine ops and stub links are logged (R103). Immediate external writes add no key, entry or format change."), `package.json` `0.4.0`.
- TODL: `package.json` version `0.56.0`, `@pragmatic-tech-ai/graph` `^0.4.0`.
- Host: `package.json` version `0.3.0`, `@pragmatic-tech-ai/graph` `^0.4.0`.

- [ ] **Step 1: Failing test** `public surface exports wave 2`: `ConnectorOutcome`, `ConnectorPhase.Write`, `GraphErrorCode.TransactionDropped`, `TransactionDroppedError`, `WriteMode`, `StepRouter`, and the types `IAssignedLink`, `IAssignedOutcome` and `IConnectorApplyResult`, plus `GraphTransaction.prototype.Flush`, `Abort`, `CreateAssigned` and `DisposeAsync`. Also `npm ls` in TODL reports invalid before the edit.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** the exports, docs and versions.
  - **Engine 0.4.0 is breaking**:
    - External connectors' `Apply` now executes, and `Commit` only finalizes;
    - `ICypherSink.CreateNode` is async;
    - sync `dispose()` of a dropped transaction throws;
    - `IConnectorApplied.Outcome` is new and required;
    - external effects of a Cypher write are visible before its commit.
  - Mirrored connectors are source-compatible.
- [ ] **Step 4: Run** engine `npm test && npm run typecheck && npm run build`, then TODL `npm test && npx tsc --noEmit -p . && npm run build`, then host `npm test && npm run build`. Expected: PASS, and `npm ls` is valid.
- [ ] **Step 5:** Commit engine `chore: 0.4.0 — immediate external writes`, TODL `chore: 0.56.0`, host `chore: 0.3.0`. Publishing waits for the owner.

---

## Task order and parallelism

| Wave | # | Task | Repo | Depends on | Parallel with |
|---|---|---|---|---|---|
| 1 | 1.1 | Row and expected versions | engine | — | 1.6 |
| 1 | 1.2 | **Transaction Fetch (M2.3 unblocker)** | engine | 1.1 | 1.6 |
| 1 | 1.3 | Cypher `elementId` and id seek | engine | 1.2 | 1.5, 1.6 |
| 1 | 1.4 | Version conflicts reported as Conflict | engine | 1.3 | 1.5, 1.6 |
| 1 | 1.5 | TODL versions, guards, SQL guarded delete | TODL | 1.2 (built) | 1.3, 1.4, 1.6 |
| 1 | 1.6 | Host guarded deletes | host | — | 1.1–1.5 |
| 1 | 1.7 | Release 0.3.0 / 0.55.0 / 0.2.0. **M2.3 GATE** | all | 1.1–1.6 | — |
| 2 | 2.1 | Write steps, StepRouter, immediate contract | engine | 1.7 | 2.5, 2.7 |
| 2 | 2.2 | Compensation, Abort, outcomes | engine | 2.1 | 2.5, 2.7 |
| 2 | 2.3 | `CreateAssigned`, version ledger | engine | 2.2 | 2.5, 2.7 |
| 2 | 2.4 | Cypher immediate writes (per-row) | engine | 2.3 | 2.5, 2.7 |
| 2 | 2.4b | Cross-row batching and dependency analysis | engine | 2.4 | 2.5, 2.7 |
| 2 | 2.5 | `keys source` authoring | TODL | 1.7 | 2.1–2.4, 2.7 |
| 2 | 2.6 | Immediate DataSourceTransaction, inserts, placement | TODL | 2.4b (built), 2.5 | — |
| 2 | 2.7 | Host inserts | host | 2.6's contract commit | 2.1–2.5 |
| 2 | 2.8 | Release 0.4.0 / 0.56.0 / 0.3.0 | all | 2.1–2.7 | — |

Engine tasks run in sequence on one branch, and so do TODL tasks. When a TODL or host task consumes an engine task, the engine task ends with `npm run build`. Task 1.5 can start as soon as 1.2 is built. M2.3 does **not** build against an unreleased engine: its O1-dependent tasks wait for the published 0.3.0 (Task 1.7, the M2.3 gate). Wave 1 has no dependency on Wave 2.
