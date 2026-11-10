# TODL runtime on the engine (milestone 2, plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the runtime everything TODL owes it so one environment engine can open: TODL's data-source adapters behind the engine's connector contract (read and write), an environment catalog composed from every delivered package set, a system share-grant concept with the predicates the server widens scopes with, `PolicyScopeCompiler.FromRules` for runtime policy files, and an engine-free Cypher wire codec for the browser. Nothing the server still imports is deleted.

**Architecture:** Everything new lives under TODL's `@pragmatic-tech-ai/todl/engine` subpath (`src/engine-bridge/`), which is the only TODL entry allowed to import the engine. `DataSourceConnector` implements the M2.1 `IExternalConnector` over one `ConnectorSpec`, its `ConnectorBinding`s and an `IDataSourceAdapter`. `ExternalIdentity` mints and parses external public ids and resolves foreign keys to link targets. `EnvironmentCatalogComposer` unifies package versions across deliveries, always adds the `todl.system` package, loads one `Domain`, and describes it with external bindings and `DefaultConnector: BindingTable.EngineStorage`. The browser's cell codec moves to an engine-free TODL module, so the browser never imports the engine.

**Tech Stack:** TypeScript (strict, ESM), `node:test` via `tsx --conditions=development --test`, `@pragmatic-tech-ai/graph` 0.2.0 (optional peer of TODL), todl-connectors-host test fixtures (pg-mem, fake document/REST/GraphQL/Cypher sessions).

**Spec:** `D:/architecture-agent/pragmatic-graph/docs/superpowers/specs/2026-11-06-graph-consolidation-design.md`: §4.1, §5.1–§5.4, §6, §7, §9, §10, §11.1 and §12. Builds on plan M2.1 (`docs/superpowers/plans/2026-11-10-external-bindings-on-engine.md`; interfaces D1–D9 are fixed). Current-code facts: `docs/integration/m2-runtime-inventory.md`. Also binding: `docs/decisions.md` (R1–R104+).

**Out of scope (M2.3, server):** the environment host and delivery registry, endpoints on the engine, depth/bypass scope composition, the share endpoints writing grant nodes, data-changed push, and every deletion listed under "Retirement handoff to M2.3".

## Open questions for the owner (defaults are used; nothing blocks)

- **Q1 Optimistic concurrency on external bindings.** The M2.1 contract does not pass the version a reader saw through to `Apply`. **Default (used):** an `Optimistic` binding is guarded with the version read in the before-image at commit (T9), so it catches a concurrent change during the commit window only. A real read-time guard needs an engine contract extension (`IFetchedRow.Version` carried to `ConnectorChange.ExpectedVersion`), which is an engine plan. Should that be scheduled?
- **Q2 Package version compatibility.** **Default (used):** T11 (same major for 1.x and up, same major and minor for 0.x, the highest version wins, and non-semver versions must be equal).
- **Q3 Source-assigned keys on create.** **Default (used):** TODL mints the storage id of an external create: the value of the id member when the write sets it, else a UUID (T8). Sources that must assign keys themselves (SQL serial, REST POST ids) cannot be created through the engine until the contract returns ids from `Commit`. Is that acceptable for v1?
- **Q4 Number literals in runtime policies.** **Default (used):** `FromRules` compiles with typed value semantics (T13): `entity.priority == 5` matches a numeric 5, as today's runtime evaluator does on typed record values. The dev `FromRepository` keeps decimal-text semantics.
- **Q5 Entity-member membership (`x in entity.m`).** **Default (used):** keep evaluator parity. It compiles to False with a `NeverMatches` diagnostic, and the evaluator is not fixed in this plan. Should the evaluator and the compiler be fixed together in a later plan?
- **Q6 Shares in dev tenants.** **Default (used):** `todl.system` is added to environment (runtime) catalogs only. Dev descriptions are unchanged, because dev has no share endpoints.

## Design rulings (record each as the next free R-number in `pragmatic-graph/docs/decisions.md`, tagged "TODL M2.2 Task N", in the task that implements it)

- **T1 Browser cell codec.** The browser keeps TODL's wire codec, not the engine's. The wire shape (`$node` holding a `MirrorSnapshot`, `$map`) is TODL's: `EngineCellMapper` produces it from engine cells, and spec §8 keeps wire shapes. `CypherCellCodec`, `CypherValueDto`, `NodeCellDto`, `CypherResultDto` and `CypherWriteStatsDto` move into the engine-free module `src/graph-api/wire/`. `src/cypher` re-exports them, so `Cypher.CypherCellCodec` is still the same class. The root also exports them as `CypherWire`. `TenantDocumentAssembler` and `EngineCellMapper` import from `graph-api/wire`. Nothing browser-side imports `@pragmatic-tech-ai/graph`, so lmdb never reaches a bundle, and the engine needs no browser subpath.
- **T2 Engine connector names.** An external connector's engine name is `ConnectorSpec.Id ?? ConnectorSpec.Name`. A binding links to its spec by `ConnectorId ?? Connector`. These names are reserved: `BindingTable.EngineStorage` (`'engine'`) and `TodlNames.FileConnector` (`'todl-file'`). Two specs with one name that are not the same spec (the `AppConnectorPlan.SameSpec` rule) are a compose error.
- **T3 Runtime binding rewrite.** In an environment catalog, a binding to a `builtin`-kind connector or to `todl-file` is described as `Connector: BindingTable.EngineStorage`. The builtin store is engine storage now, and runtime has no source files. Every other binding is described with its T2 engine name. Bindings stay per concept (TODL never emits model-wide bindings).
- **T4 External public ids.** `Mint(binding, storageId)` = `` `${Concept}#${Connector}.${Source}#${storageId}` ``, where `Connector` is the T2 engine name. This keeps `ConnectorMirrorMapper`'s shape. `Parse` matches the longest known prefix (everything up to and including the second `#`) and returns the rest verbatim as the storage id, so ids containing `#` round-trip. The storage key sent to an adapter is a `number` when the binding's id member (the member whose `FieldMap` value is `IdKey`) is Int64 or Float64 and the storage id is decimal text, and the string otherwise. Two bindings with the same `(Concept, Connector, Source)` prefix in different models are a compose error, because their ids would collide. A minted id over 400 UTF-8 bytes fails the fetch with `ExternalRowInvalid`.
- **T5 Fetch mapping.** The binding for a request is exact `(Model, Concept)`. When `Concept` is a strict subtype of a bound concept, the page is empty: a source holds exactly its bound concept and cannot pick out subtypes. Rows carry `Concept = binding.Concept`.
  - **Fields:** `IdKey`, plus the `FieldMap` field of each requested property member, plus the field of each mapped relationship member.
  - **Values:** converted to the member's engine type by `CellConverter` (extracted from `SnapshotDescriber`, unchanged). A value that does not convert throws `ExternalRowInvalid`, and the engine turns that into a failed query (consistent with D6). External null is null.
  - **Links:** only single-valued relationships can be field-mapped; a many-valued relationship in a `FieldMap` is ignored and reported as diagnostic `UnmappableRelationship` at compose. A non-null foreign key becomes one link target through `ExternalIdentity.LinkTarget` (T6).
- **T6 Foreign keys.** A foreign key on relationship `r` points to one of `r`'s targets.
  - **Reading:** if exactly one external binding in the environment binds a target concept or one of its subtypes, the target id is `Mint(thatBinding, String(fk))`. With no such binding, the target id is `String(fk)` taken as an engine public id. With more than one, there is no link (nothing is guessed, as in `PopulationBuilder`).
  - **Writing:** `ForeignKey(binding, r, targetId)` is the inverse: the parsed storage key when the target id parses under the chosen binding, else the id itself.
- **T7 Push-down (advisory, D4).** Only the top-level conjuncts of `IFetchRequest.Predicate` are translated, and a conjunct that does not translate is dropped. Each translated term may only exclude rows the engine would exclude too (SQL NULL semantics are no more permissive than Kleene at an `And` top). Translations:
  - `Compare(m, op, v)` on a mapped property becomes `QueryComparison` (`Eq→eq`, `Ne→neq`, `Lt→lt`, `Le→lte`, `Gt→gt`, `Ge→gte`).
  - `In(m, vs)` becomes `in`, `IsNull(m)` becomes `isNull`, and `Not(IsNull(m))` becomes `isNotNull`.
  - `IdIn(ids)` becomes `in` on `IdKey` over the ids that parse under the binding.
  - `Keys` becomes `in` on `IdKey`. When no key parses, the result is an empty page without calling the adapter.
  - `Reverse { Relationship, Target }` becomes `eq` on the relationship's foreign-key field, with `ForeignKey(…, Target)`. An unmapped relationship gives an empty page.
  - Cell to external value: a bigint becomes a number when it is a safe integer, else the term is dropped. Other cells pass through, and temporal cells drop the term.
- **T8 Capabilities and paging.** `Capabilities = { KeyLookup: true, ReverseLookup: true, PushDown: {True, Compare, In, IsNull, Not, And, IdIn} }`.
  - **Paging:** when `adapter.CanPage`, every fetch goes through `QueryPage` with `OrderKey = IdKey` and `Limit = request.Limit ?? 500`. `Resume` is `'1.' + base64url(JSON.stringify({ After }))` of the page's `NextAfter`, and a malformed `Resume` throws `ExternalRowInvalid`. Without `CanPage`, one `Query` returns all rows and no `Resume`. The engine drains resume tokens (D3).
  - **Creates:** `EnvironmentNodePlacement` places an external create at the unique exact-concept external binding of the concept. When two models bind the concept externally it throws `AmbiguousExternalBinding`. The storage id is the id member's value when set, else `randomUUID()`. `Owner` is the binding model, and `Defaults` sets the id member when it is mapped and absent. Every other create gets a `randomUUID()` public id and the owner of the concept's home model (the package that declares it). Default connector = engine.
- **T9 Write side.** `Begin()` opens a `DataSourceTransaction`.
  - **`Apply` (no remote effect):** it only translates and validates, and throws (engine Phase `Apply`) on any change it cannot express. That covers a foreign public id (`ForeignId`), `SetOwner`, an unmapped member, a change to the id member of an existing node, link properties, a binding that is not `Writable` (`NotWritable`), and a `Transactional` binding over an adapter that cannot transact (`UnsupportedExternalChange`).
  - **Merging into batches:** ops on one public id merge in order into one `WriteOperation`. Create, Sets and Links merge into an Upsert. A Delete is a Delete, and a Create then Delete in one set cancels out. Unlink of a mapped foreign key sets it to null. There is one `WriteBatch` per binding, in order of first appearance.
  - **`Commit` writes:** for each batch it reads a before-image (`Query` with `Where IdKey in keys` over all mapped fields), sets `Version` from the before-image for `Optimistic` bindings (Q1), and calls `adapter.Apply(batch)`.
  - **Per-op failures:** any `WriteResult.Failures` throws `ExternalWriteError` (code `ExternalWriteFailed`, carrying `Binding` and the `Failures` with their kinds). The engine reports it as `ConnectorError` (Phase `Commit`) with that cause. The server maps the kinds `conflict`, `unsupported` and `error` to its statuses `conflict`, `invalid` and `failed`.
  - **`Revert`:** before Commit it discards. After Commit, or partway through Commit, it compensates every op that applied, in reverse order: a key that had no before-image is deleted, and every other key is upserted back to its before-image, sequentially and last-write-wins. A failed compensation throws `ExternalWriteError` (code `CompensationFailed`), which the engine raises as `ConnectorRevertFailed`.
  - **Atomicity:** for a `Transactional` binding over an adapter that can transact, a failed batch applied nothing (the adapter rolled it back), so only batches that already committed are compensated. REST, GraphQL and standalone Mongo always rely on compensation, and the result on the far side is the connector's best effort (spec §6). This is documented on `DataSourceConnector`.
- **T10 System package.** `todl.system@1.0.0` is a TODL source file (`src/engine-bridge/system/system.todl`) compiled at build time to `system-package.generated.ts` (a `PackageDocument`), so runtime compiles nothing. `SystemPackage` serves it as a `PackageSource` and `IPackageDocumentSource`. The composer always adds it.
  - **Concept:** `todl.system.ShareGrant { record : todl.Element; subjectKind : string; subjectId : string; read : boolean?; update : boolean?; delete : boolean?; assign : boolean?; share : boolean?; }`. `record` is a single relationship to any element, and an external record is linked through an M2.1 stub.
  - **Grant id:** `ShareGrants.PublicId(recordId, kind, subjectId)` = `'share.' + sha256hex(recordId + '\0' + kind + '\0' + subjectId).slice(0, 32)`. It is deterministic, so a re-share is an update.
  - **Predicates:** `ShareGrantScope` builds the engine predicates the server ORs into scopes. `Widening(subjects, right)` = `Related('record', In, And(SubjectMatch(subjects), Compare(right, Eq, true)))`. `SubjectMatch(subjects)` = `Or(And(Compare(subjectKind, Eq, 'principal'), Compare(subjectId, Eq, id)), And(Compare(subjectKind, Eq, 'team'), In(subjectId, teams)))`, with the team arm omitted when there are no teams. Grants are engine-storage nodes and commit in the same transaction as any other write (§11.1).
  - **Server requirement:** because a `Related` target is decided under the same scope (R66), the server's scope must make the principal's own grants visible. `GrantRows(subjects)` = `SubjectMatch(subjects)` is provided for that.
  - **Deleted records:** a grant whose record edge is gone is inert. M2.3 deletes the grants of a deleted record in the same transaction.
- **T11 Version unification.** A version is semver when it matches `^(\d+)\.(\d+)\.(\d+)$`. Two requested versions of one model are compatible when they are equal, or when both are semver and either the majors are equal and at least 1, or the majors are 0 and the minors are equal. All requested versions of a model must be pairwise compatible, else `EnvironmentCatalogError IncompatibleVersions`, naming the model, the versions and the deliveries that asked for them. The environment loads the highest compatible version.
  - **Requested set:** every root ref of every delivery plus the declared dependencies of every resolved requested version, transitively. This is conservative: a superseded version's dependencies are still checked.
  - **Loading:** each dependency ref is redirected to the chosen version (`UnifiedPackageSource`).
  - **Upgrades:** a redeploy or re-promote re-runs `Compose` over the current deliveries. The resulting description upgrades the engine per §4.3, and a package still delivered by another channel stays in the union.
- **T12 Conflicting definitions.** When a concept or aspect full name is declared by two manifests of different models with different drafted shapes (parent, aspects, or own members by `Agree`), `SnapshotDescriber` reports `DescribeDiagnosticCode.ConflictingDefinition` (appended), and the composer rejects it as `EnvironmentCatalogError ConflictingDefinition`. Identical copies, such as the prelude's `todl.Element` in every package, are fine.
- **T13 `FromRules`.** `PolicyScopeCompiler.FromRules(rules: Iterable<IPolicyRuleSource>, description: ISchemaDescription)`. The input is the `AccessPolicySetting.Load` and `PolicyCatalog.FromPolicies` shape. A repeated concept: the last entry wins (`Map.set`, as `FromPolicies`). Rules are parsed per concept with `PolicyRules.Parse`, and a parse failure compiles that concept fail-closed with `MalformedPolicy`. M2.3 should treat any `MalformedPolicy` from `FromRules` as fatal for the app, which keeps today's whole-app fail-closed behaviour.
  - **Typed value semantics:** a new internal `PolicyValueSemantics { SourceText = 1, Typed = 2 }`. `FromRepository` uses `SourceText` and is unchanged. Under `Typed`, a JS number against a numeric member converts (Int64: an integral safe number becomes a bigint, anything else is `Never`; Float64: the number). A string against a numeric member is `Never`, with no diagnostic, mirroring `===` on typed values. Booleans and strings behave as under `SourceText`.
  - **Membership:** entity-member `in`/`has` stays False with `NeverMatches` (Q5).
- **T14 Retirement ordering.** M2.2 deletes nothing: every retirement candidate still has a pragmatic-server importer, as enumerated under "Retirement handoff to M2.3". M2.2 only adds parallel APIs: wire codec, `DataSourceConnector`, composer, placement, system package and `FromRules`. The composer replaces server `AppConnectorPlan` and `RuntimeAppGraph` after the switch. `IDescribeOptions.EmitExternalBindings` defaults to `false`, so the dev path keeps M1 behaviour until M2.3 installs `DataSourceConnector`s in the dev host and removes the option.

## Global Constraints

- Layering: the engine never imports TODL. TODL imports the engine only under `src/engine-bridge/**` (the `./engine` subpath, `@pragmatic-tech-ai/graph` is an optional peer `^0.2.0`). The root entry and `src/graph-api/**` stay engine-free, and `engine-bridge/tests/EngineFree.test.ts` must keep passing.
- Prerequisite: engine 0.2.0 (plan M2.1) is published before Task 1 starts.
- OOP: no module-level free functions or mutable module state, and Allman braces. PascalCase applies to interfaces and public methods. Existing camelCase interface members that a task does not touch (`PackageSource.resolve`) stay as they are.
- No inline string literals: user-facing text and reused keys are `private static readonly` PascalCase constants, and fixed value sets are enums.
- Error enums are append-only. New `EngineBridgeErrorCode` members, appended in this order: `ExternalRowInvalid`, `ExternalWriteFailed`, `CompensationFailed`, `NotWritable`, `UnsupportedExternalChange`, `AmbiguousExternalBinding`. The new `DescribeDiagnosticCode` members, appended: `ConflictingDefinition`, `UnmappableRelationship`.
- Tests live in `tests/` subfolders next to the code. TODL: `npm test`, `npm run typecheck`. Engine-touching TODL tests use `EngineFixture` (`src/engine-bridge/tests/EngineFixture.ts`).
- Teardown is through `dispose()`. `DataSourceConnector` does not own its adapter (the `DataSourceAdapterCatalog` memoises adapters process-wide).
- External data is never cached across fetches (spec §5.2, §12): the connector keeps no row memo, and `DataSourceTransaction` keeps before-images only for its own life.
- Every task ends green. Fix every review finding, including minors.

## Review Focus

1. A source row whose value does not fit the member type (for example pg returning `int8` as the text `'12x'`, or a JSON number for a String member): the query must fail loudly with `ExternalRowInvalid`, and the row must never read as null. → Task 3 test `unconvertible value fails the fetch`.
2. A storage id containing `#`, or an id that maps to a numeric `IdKey`: key lookup, reverse lookup and writes must all address the same row. → Task 2 tests `storage id with hash round-trips` and `numeric id key is sent as a number`.
3. A commit where the adapter applies two of three ops (Sequential) and then reports a failure: the caller sees a failure, and Revert restores the two applied rows from their before-images. → Task 4 test `partial sequential batch is compensated`.
4. Two apps pin `crm@1.2.0` and `crm@2.0.0`, or two unrelated packages declare `acme.Customer` differently: deploy must be rejected with a message naming the model or concept and the deliveries, and the description must never silently pick one. → Task 7 tests `incompatible majors are rejected` and `conflicting definition is rejected`.
5. A runtime policy compares a number literal (`entity.priority == 5`) or uses a malformed rule entry: the engine scope must match what today's runtime evaluator admits, and a malformed concept must fail closed. → Task 8 tests `number literal matches typed member` and `malformed concept fails closed`.

---

### Task 1: Engine 0.2.0 adoption and the engine-free Cypher wire module

**Files:**
- Modify: `TODL/package.json` (peer and dev `@pragmatic-tech-ai/graph` `^0.2.0`), `TODL/src/cypher/cell-codec.ts`, `src/cypher/values.ts`, `src/cypher/result.ts`, `src/cypher/writer.ts` (re-export the moved types), `src/cypher/index.ts`, `src/graph-api/browser/tenant-document-assembler.ts`, `src/engine-bridge/EngineCellMapper.ts`, `src/index.ts` (`export * as CypherWire from './graph-api/wire/index.js'`)
- Create: `src/graph-api/wire/cypher-cell-codec.ts`, `src/graph-api/wire/cypher-wire-dto.ts`, `src/graph-api/wire/index.ts`
- Test: `src/graph-api/wire/tests/cypher-wire.test.ts`

**Interfaces:**
- Produces: `CypherWire.CypherCellCodec`, which is the same class object as `Cypher.CypherCellCodec`, with unchanged statics `NodeKey`, `MapKey`, `EncodeNode`, `EncodeMap`, `AsNode`, `AsMap`. Types `CypherWire.CypherValueDto`, `NodeCellDto`, `CypherResultDto`, `CypherWriteStatsDto` (bodies unchanged).

- [ ] **Step 1: Failing tests** in `cypher-wire.test.ts`:
  - `wire codec is the Cypher codec`: `assert.equal(CypherWire.CypherCellCodec, Cypher.CypherCellCodec)`.
  - `wire module is engine- and cypher-free`: statically walk the import graph of `src/graph-api/wire/index.ts` (reuse the walker in `EngineFree.test.ts`); no specifier matches `@pragmatic-tech-ai/graph` or `/cypher/`.
  - `assembler is cypher-free`: the same walk from `src/graph-api/browser/tenant-document-assembler.ts`.
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/graph-api/wire/tests/cypher-wire.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the move (T1). Then bump the engine dependency, run `npm install`, and fix any compile fallout from engine 0.2.0 (`ICypherSource.ScanLabel` gained `hint?`; TODL implements no `ICypherSource`, so expect none).
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS, including `EngineFree.test.ts` and `tenant-document-assembler.test.ts` unchanged.
- [ ] **Step 5:** Record T1, then commit `refactor(wire): engine-free Cypher wire codec; adopt graph 0.2.0`.

### Task 2: External identity and value conversion

**Files:**
- Create: `src/engine-bridge/CellConversion.ts` (`CellConverter`, moved out of `SnapshotDescriber.ts` verbatim and exported), `src/engine-bridge/external/ExternalBinding.ts`, `src/engine-bridge/external/ExternalIdentity.ts`, `src/engine-bridge/external/ExternalValues.ts`
- Modify: `src/engine-bridge/SnapshotDescriber.ts` (import `CellConverter`), `src/engine-bridge/EngineBridgeError.ts` (append the codes)
- Test: `src/engine-bridge/external/tests/ExternalIdentity.test.ts`

**Interfaces:**
- Produces:
  - `interface IExternalBinding { readonly Model: string; readonly Connector: string /* T2 engine name */; readonly Binding: ConnectorBinding }`
  - `interface IExternalConnectorPlan { readonly Name: string; readonly Spec: ConnectorSpec; readonly Bindings: readonly IExternalBinding[] }`
  - `interface IParsedExternalId { readonly Binding: IExternalBinding; readonly StorageId: string }`
  - `class ExternalIdentity`:
    - `constructor(description: ISchemaDescription, bindings: readonly IExternalBinding[])`
    - `Mint(binding: IExternalBinding, storageId: string): string`
    - `Parse(publicId: string): IParsedExternalId | undefined`
    - `StorageKey(binding: IExternalBinding, storageId: string): ExternalFieldValue`
    - `LinkTarget(binding: IExternalBinding, relationship: string, foreignKey: ExternalFieldValue): string | undefined`
    - `ForeignKey(binding: IExternalBinding, relationship: string, targetId: string): ExternalFieldValue`
    - `CreateTarget(concept: string): IExternalBinding | undefined` (throws `AmbiguousExternalBinding` when more than one binding fits)
    - `ReadOnly(): readonly IExternalBinding[]` (bindings with `Writable: false`, for M2.3 write predicates)
    - `Bindings(): readonly IExternalBinding[]`
  - `class ExternalValues`:
    - `static ToCell(type: ValueType, value: ExternalFieldValue, subject: string): CellValue` (via `CellConverter`; throws `ExternalRowInvalid` naming `subject`)
    - `static ToExternal(value: CellValue, subject: string): ExternalFieldValue` (a safe bigint becomes a number, any other bigint becomes decimal text, and a temporal value throws `UnsupportedExternalChange`)

- [ ] **Step 1: Failing tests** (T4, T6):
  - `mint matches the mirror scheme`: `Mint(crm.Customer on sql 'crm' source 'customers', '42')` equals `'crm.Customer#crm.customers#42'`.
  - `storage id with hash round-trips`: `Parse(Mint(b, 'a#b'))` gives `{ Binding: b, StorageId: 'a#b' }`.
  - `foreign prefix does not parse`: `Parse('other.X#y.z#1')` is undefined.
  - `numeric id key is sent as a number`: the id member is Int64, so `StorageKey(b, '42') === 42`; for a String id member, `'42'`.
  - `link target mints through the unique external binding`, `link target is an engine id when the target is engine-bound`, `ambiguous link target gives no link`.
  - `foreign key inverts link target` for each of the three cases.
  - `ambiguous create target throws` (`AmbiguousExternalBinding`).
  - `ToCell converts and rejects`: `'5'` and `5` give Int64 `5n`; `'5x'` throws `ExternalRowInvalid`; null stays null.
  - `ToExternal`: `5n` gives `5`; `2n ** 60n` gives `'1152921504606846976'`.
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/engine-bridge/external/tests/ExternalIdentity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Moving `CellConverter` must not change `SnapshotDescriber` output (its tests are the guard).
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Record T4 and T6, then commit `feat(engine-bridge): external identity and value conversion`.

### Task 3: DataSourceConnector read side

**Files:**
- Create: `src/engine-bridge/external/DataSourceConnector.ts`, `src/engine-bridge/external/FetchTranslator.ts`, `src/engine-bridge/external/ResumeToken.ts`
- Test: `src/engine-bridge/external/tests/DataSourceConnectorRead.test.ts`, `src/engine-bridge/external/tests/ExternalFixture.ts` (an `InMemoryAdapter` from `model-data/tests/fakes.ts` wrapped to log requests and toggle `CanPage`, `CanTransact` and throw-at-call-N; a two-concept description: `crm.Customer` external, `crm.Team` engine)

**Interfaces:**
- Consumes: Task 2; engine `IExternalConnector`, `IFetchRequest`, `IFetchPage`, `IFetchedRow`, `ConnectorResidency` (M2.1 Task 1).
- Produces:
  - `class DataSourceConnector implements IExternalConnector`:
    - `constructor(plan: IExternalConnectorPlan, adapter: IDataSourceAdapter, identity: ExternalIdentity, description: ISchemaDescription)`
    - `static async Open(plan: IExternalConnectorPlan, adapters: DataSourceAdapterCatalog, services: IServiceProvider, identity: ExternalIdentity, description: ISchemaDescription): Promise<DataSourceConnector>`
    - `readonly Name`, `readonly Residency = ConnectorResidency.External`, `readonly Capabilities` (T8)
    - `Fetch(request: IFetchRequest): Promise<IFetchPage>`, `Begin()` (Task 4)
  - `class FetchTranslator { static Where(binding: IExternalBinding, predicate: Predicate, identity: ExternalIdentity): QueryFilter | undefined }` (T7)
  - `class ResumeToken { static Encode(after: ExternalFieldValue): string; static Decode(token: string): ExternalFieldValue }`

- [ ] **Step 1: Failing tests** (direct calls to `Fetch`, then one engine round trip):
  - `fetch maps fields to members and mints ids`: the source row `{cust_id: 7, nm: 'Acme', team_fk: 'a'}` with `FieldMap {id: cust_id, name: nm, team: team_fk}` gives a row `{ PublicId: 'crm.Customer#crm.customers#7', Concept: 'crm.Customer', Values: {id: 7n, name: 'Acme'}, Links: {team: ['a']} }`.
  - `key lookup is a Where on IdKey`: `Keys: [mint(7), 'foreign']` logs `Where.All = [{Field: cust_id, Op: in, Values: [7]}]`; with `Keys: ['foreign']` alone, there is no adapter call and the page is empty.
  - `reverse lookup is a Where on the foreign key`: `Reverse {team, 'a'}` logs `{Field: team_fk, Op: eq, Value: 'a'}`.
  - `pushes down translatable conjuncts only`: `And(Compare(name, Eq, 'Acme'), Related(team, Out, True))` logs exactly one term `{nm eq 'Acme'}`.
  - `Not IsNull becomes isNotNull`.
  - `subtype request on a bound ancestor is empty`.
  - `pages through QueryPage with a resume token`: with `CanPage` and 3 records at `Limit 2`, page 1 has 2 rows and `Resume`, and page 2 has 1 row and no `Resume`.
  - `malformed resume token fails`.
  - `unconvertible value fails the fetch` (`ExternalRowInvalid`).
  - `engine round trip`: `EngineFixture.Open` with the connector installed. `MATCH (c:\`crm.Customer\`)-[:team]->(t) RETURN c.name, t.id` returns `['Acme', 'a']`. Running it twice gives two adapter calls (§12).
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/engine-bridge/external/tests/DataSourceConnectorRead.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** T5, T7 and T8 (read part). Class comment: residency, advisory push-down, no caching.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Record T5, T7 and T8, then commit `feat(engine-bridge): data-source connector read side`.

### Task 4: DataSourceConnector write side

**Files:**
- Create: `src/engine-bridge/external/DataSourceTransaction.ts`, `src/engine-bridge/external/ExternalWriteError.ts`, `src/engine-bridge/external/ChangeBatcher.ts`
- Modify: `src/engine-bridge/external/DataSourceConnector.ts` (`Begin`)
- Test: `src/engine-bridge/external/tests/DataSourceConnectorWrite.test.ts`

**Interfaces:**
- Consumes: Task 3; engine `IConnectorTransaction`, `ConnectorChangeSet`, `ConnectorChange`, `WriteOp`.
- Produces:
  - `class ExternalWriteError extends EngineBridgeError { readonly Binding: IExternalBinding; readonly Failures: readonly WriteFailure[] }`
  - `class ChangeBatcher { static Batches(changes: ConnectorChangeSet, identity: ExternalIdentity, connector: string): readonly IPendingBatch[] }`, with `interface IPendingBatch { readonly Binding: IExternalBinding; readonly Batch: WriteBatch }`. It throws per T9.
  - `class DataSourceTransaction implements IConnectorTransaction` (`Apply`, `Commit`, `Revert`), per T9.

- [ ] **Step 1: Failing tests:**
  - `create sets merge into one upsert`: changes `CreateNode(x)`, `SetProperty(x, name, 'N')`, `Link(x, team, 'a')` give one `Upsert { Key: storageKey, Fields: {cust_id, nm: 'N', team_fk: 'a'} }`.
  - `unlink clears the foreign key`, `create then delete cancels`, `delete becomes delete`.
  - `apply refuses what it cannot express`: `SetOwner`, an unmapped member, an id-member change on an existing node, link properties, a foreign id (`ForeignId`), and a non-writable binding (`NotWritable`) each reject in `Apply`, and the adapter receives no `Apply` call.
  - `transactional binding needs a transacting adapter` (`UnsupportedExternalChange` at `Apply`).
  - `per-op failure throws ExternalWriteError`: the adapter returns `Failures [{Key: 7, Kind: conflict}]`, so `Commit` rejects with code `ExternalWriteFailed`, `Failures[0].Kind === 'conflict'`.
  - `partial sequential batch is compensated`: 3 upserts (one new, two existing), the adapter applies 2 then fails. After `Revert`, the new key is deleted and the existing key is restored to its before-image fields.
  - `revert after commit compensates` (engine "compensate" semantics).
  - `revert before commit touches nothing`.
  - `optimistic binding guards with the before-image version`: the logged `WriteOperation.Version` equals the before-image `rev`.
  - `failed compensation throws CompensationFailed`.
  - `engine write-through`: through `EngineFixture`, `CREATE (c:\`crm.Customer\` {name:'N'})` lands in the in-memory source with a UUID key, and its public id parses under the binding (uses Task 5 placement; until then, place with an explicit id).
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/engine-bridge/external/tests/DataSourceConnectorWrite.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** T9. Document the compensation semantics per adapter kind on `DataSourceConnector`: SQL transacts per batch; Mongo transacts on a replica set only; REST and GraphQL compensate only.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Record T9, then commit `feat(engine-bridge): data-source connector write side`.

### Task 5: EnvironmentNodePlacement

**Files:**
- Create: `src/engine-bridge/environment/EnvironmentNodePlacement.ts`
- Test: `src/engine-bridge/environment/tests/EnvironmentNodePlacement.test.ts`

**Interfaces:**
- Consumes: `ExternalIdentity.CreateTarget`, `Mint` (Task 2).
- Produces: `class EnvironmentNodePlacement implements Cypher.INodePlacement { constructor(identity: ExternalIdentity, homeModels: ReadonlyMap<string, string> /* concept → package model id */, ids?: () => string /* default randomUUID */); Place(concept, properties): INodePlace }`. `homeModels` comes from `IEnvironmentCatalog.HomeModels` (Task 7).

- [ ] **Step 1: Failing tests** (T8 placement):
  - `external create uses the id member when set`: `Place('crm.Customer', {id: 9n})` gives `PublicId 'crm.Customer#crm.customers#9'`, `Owner 'crm-pkg'`, and no Defaults.
  - `external create mints a key and defaults the id member`: with `ids = () => 'u1'` and no id, `PublicId` ends `#u1` and `Defaults.get('id') === 'u1'`. For an Int64 id member, the key is still minted as a UUID and the id member is not defaulted (Q3).
  - `engine create owns by home model`: `Place('crm.Team', {})` gives `{ PublicId: 'u1', Owner: 'crm-pkg' }`.
  - `ambiguous external create throws` (`AmbiguousExternalBinding`).
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/engine-bridge/environment/tests/EnvironmentNodePlacement.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then switch Task 4's `engine write-through` test to this placement.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine-bridge): environment node placement`.

### Task 6: System package and share-grant predicates

**Files:**
- Create: `src/engine-bridge/system/system.todl`, `src/engine-bridge/system/system-package.generated.ts`, `scripts/gen-system-package.mts`, `src/engine-bridge/system/SystemPackage.ts`, `src/engine-bridge/system/SystemNames.ts`, `src/engine-bridge/system/ShareGrantScope.ts`, `src/engine-bridge/system/ShareGrants.ts`
- Modify: `TODL/package.json` (`"gen:system-package": "tsx --conditions=development scripts/gen-system-package.mts"`, run in `build` after `gen:prelude`), `src/solution-services/package-manager/storage-package-source.ts` (implements `IPackageDocumentSource`), `src/domain/domain.ts` (declare `IPackageDocumentSource`)
- Test: `src/engine-bridge/system/tests/SystemPackage.test.ts`, `src/engine-bridge/system/tests/ShareGrantScope.test.ts`

**Interfaces:**
- Produces:
  - `interface IPackageDocumentSource { Document(ref: Required<PackageRef>): Promise<PackageDocument> }` (in `domain.ts`).
  - `class SystemPackage implements PackageSource, IPackageDocumentSource { static readonly Ref: Required<PackageRef> /* { model: 'todl.system', version: '1.0.0' } */ }`. `resolve` lowers the embedded document with `PackageManifestBridge.toResolvedJsonDocument`.
  - `class SystemNames`: `ShareGrant = 'todl.system.ShareGrant'`, `Record = 'record'`, `SubjectKind = 'subjectKind'`, `SubjectId = 'subjectId'`.
  - `enum ShareRight { Read = 'read', Update = 'update', Delete = 'delete', Assign = 'assign', Share = 'share' }` (the values are the member names).
  - `enum ShareSubject { Principal = 'principal', Team = 'team' }` (values equal the protocol's `ShareSubjectKind`).
  - `interface IShareSubjects { readonly PrincipalId: string; readonly Teams: readonly string[] }`
  - `class ShareGrantScope { static SubjectMatch(s: IShareSubjects): Predicate; static GrantRows(s: IShareSubjects): Predicate; static Widening(s: IShareSubjects, right: ShareRight): Predicate }`
  - `class ShareGrants { static PublicId(recordId: string, kind: ShareSubject, subjectId: string): string; static Properties(kind: ShareSubject, subjectId: string, rights: readonly ShareRight[]): ReadonlyMap<string, CellValue> }` (unlisted rights are false).

- [ ] **Step 1: Failing tests:**
  - `generated system package is current`: compile `system.todl` with `compilePackage` and compare the `SnapshotDescriber` definitions of both the fresh compile and the generated document; they are deep-equal.
  - `system package describes ShareGrant`: `todl.system.ShareGrant` has members `record` (Relationship, Targets `['todl.Element']`, not Many), `subjectKind` and `subjectId` (String), and `read`, `update`, `delete`, `assign`, `share` (Boolean, nullable).
  - `grant id is deterministic and short`: equal inputs give equal ids, `/^share\.[0-9a-f]{32}$/`, and a different subject gives a different id.
  - `widening admits a shared record` (engine, both backends via `EngineFixture`): records `r1` and `r2`, and a grant to principal `p` with `read: true` on `r1`. Under scope `Rows: {Doc: Widening(p, Read), [ShareGrant]: GrantRows(p)}`, `MATCH (d:Doc)` returns `r1` only.
  - `team grant widens`: the grant is to team `t`, and the subjects are `{p, [t]}`.
  - `grant without the right does not widen` (`read` false, `update` true).
  - `invisible grant does not widen`: with `[ShareGrant]: False`, nothing is returned (pins R66 requirement T10).
  - `grant commits with the write`: one transaction creates a grant and links `record` to `r2`. After commit the widening admits `r2`, and an aborted transaction admits nothing.
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/engine-bridge/system/tests/*.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** T10. Then run `npm run gen:system-package` to produce the generated file, with header `// GENERATED from system.todl by scripts/gen-system-package.mts — do not edit by hand.`
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Record T10, then commit `feat(engine-bridge): todl.system share-grant package and predicates`.

### Task 7: External bindings in the describer and the environment catalog composer

**Files:**
- Modify: `src/engine-bridge/SnapshotDescription.ts` (`IDescribeOptions.EmitExternalBindings?: boolean`; the two diagnostic codes), `src/engine-bridge/SnapshotDescriber.ts` (emit bindings verbatim when the option is set; T12 `ConflictingDefinition`; `UnmappableRelationship`)
- Create: `src/engine-bridge/environment/EnvironmentCatalogComposer.ts`, `src/engine-bridge/environment/PackageVersionUnifier.ts`, `src/engine-bridge/environment/UnifiedPackageSource.ts`, `src/engine-bridge/environment/EnvironmentCatalogError.ts`
- Test: `src/engine-bridge/tests/SnapshotDescriber.test.ts` (extend), `src/engine-bridge/environment/tests/PackageVersionUnifier.test.ts`, `src/engine-bridge/environment/tests/EnvironmentCatalogComposer.test.ts` (packages compiled in the test with `compilePackage` into a fake `IStorage` read by `StoragePackageSource`)

**Interfaces:**
- Consumes: Tasks 2 and 6; `SnapshotDescriber.Describe`; `ConnectorPlanEmitter.PlanFor`; `ModelShardExtractor.ModelsOf`; `fromJSON`.
- Produces:
  - `enum DeliveryChannel { Deploy = 1, Promote = 2 }`
  - `interface IPackageDelivery { readonly Channel: DeliveryChannel; readonly Name: string /* app name or promote set id */; readonly Packages: readonly Required<PackageRef>[] }`
  - `interface IComposeInput { readonly Deliveries: readonly IPackageDelivery[]; readonly Packages: PackageSource & IPackageDocumentSource }`
  - `interface IEnvironmentCatalog { readonly Description: ISchemaDescription; readonly Packages: readonly Required<PackageRef>[] /* chosen, sorted by model */; readonly Snapshot: MetadataSnapshot; readonly Connectors: readonly IExternalConnectorPlan[] /* by Name */; readonly Identity: ExternalIdentity; readonly HomeModels: ReadonlyMap<string, string>; readonly Diagnostics: readonly IDescribeDiagnostic[] }`
  - `class EnvironmentCatalogComposer { static async Compose(input: IComposeInput): Promise<IEnvironmentCatalog> }`. It is pure (no side effects), so the server calls it on the prospective delivery set to validate a deploy or promote.
  - `class PackageVersionUnifier { static async Unify(roots: readonly IPackageDelivery[], source: PackageSource): Promise<ReadonlyMap<string, string> /* model → chosen version */> }` (T11)
  - `class UnifiedPackageSource implements PackageSource { constructor(inner: PackageSource, chosen: ReadonlyMap<string, string>) }`
  - `enum EnvironmentCatalogErrorCode { IncompatibleVersions = 1, ConflictingConnector, ReservedConnectorName, ConflictingDefinition, DuplicateExternalSource }`; `class EnvironmentCatalogError extends Error { readonly Code; readonly Subject: string; readonly Deliveries: readonly string[] }`

Compose algorithm (the order matters):
1. Unify over the deliveries plus `SystemPackage.Ref` (as a delivery named `todl.system`), with a composite source that tries `SystemPackage` first.
2. Load each chosen package into a new `Domain(new UnifiedPackageSource(...))`.
3. For each chosen package, read its document. Build one `ModelConnectorPlan` with `Model = ref.model`, merging `PlanFor(fromJSON(doc), m)` over `ModelsOf(doc)`.
4. Merge specs by T2 identity (conflict gives `ConflictingConnector`; a reserved name gives `ReservedConnectorName`). Rewrite the bindings by T3, and check prefixes by T4 (`DuplicateExternalSource`).
5. `Describe` with `DefaultConnector: BindingTable.EngineStorage` and `EmitExternalBindings: true`. A `ConflictingDefinition` diagnostic throws.
6. Build `ExternalIdentity` over the described external bindings.

- [ ] **Step 1: Failing tests:**
  - Describer: `external bindings are emitted when asked`: a plan binding to `crm` (sql) gives `Bindings` containing `{Model, Concept, Connector: 'crm'}` with the option set, and nothing (M1 behaviour) without it. `conflicting definition is reported`: two models declare `acme.Customer` with different members. `prelude copies do not conflict`.
  - Unifier: `same major picks highest` (`crm@1.2.0`, `crm@1.4.1` give `1.4.1`). `incompatible majors are rejected` (`IncompatibleVersions`, `Subject 'crm'`, `Deliveries` names both). `zero major needs same minor` (`0.3.1` with `0.4.0` rejects). `non-semver must be equal`. `dependency versions are unified`: app A pins `ui@1.0.0`, which depends on `base@1.0.0`, and app B pins `base@1.3.0`, so the loaded `base` is `1.3.0`.
  - Composer: `union of deploy and promote`: the catalog has the definitions of both delivery sets plus `todl.system.ShareGrant`, and `DefaultConnector === 'engine'`. `package delivered twice stays once`. `redeploy drops a package`: compose without app B, and B's concepts are absent. Opening the engine on the first description and then upgrading with the second discards B's instances (through `EngineFixture`, §4.3). `builtin and todl-file bindings become engine storage`. `conflicting connector specs are rejected`. `duplicate external source is rejected`. `reserved connector name is rejected`. `conflicting definition is rejected`. `runtime compiles nothing`: `Compose` succeeds over a storage that holds only `<id>/<version>/model.json` files (no `src/`, no `.todl`). The storage is wrapped to fail any read of a path that ends in `.todl`. The composer reaches `ManifestEmitter`/`mergeBases` lowering only through `StoragePackageSource` and `SystemPackage`. That lowers a compiled document and parses no source, so it counts as reading a compiled package (§11.1), not compiling one. A static import check is deliberately not used: `PackageManifestBridge` imports `compiler-services/api` for `mergeBases`.
  - `environment opens`: `GraphEngine.Open` over `catalog.Description`, with one `DataSourceConnector` per `catalog.Connectors` entry (Task 3) and the placement from `catalog.Identity`, `HomeModels`, succeeds and serves a federated `MATCH`.
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/engine-bridge/environment/tests/*.test.ts src/engine-bridge/tests/SnapshotDescriber.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** T2, T3, T11 and T12.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Record T2, T3, T11, T12 and T14, then commit `feat(engine-bridge): environment catalog composer`.

### Task 8: PolicyScopeCompiler.FromRules

**Files:**
- Modify: `src/engine-bridge/PolicyScopeCompiler.ts` (factory; `PolicyValueSemantics` threaded into `TermCompiler.Convert`), `src/engine-bridge/index.ts`
- Test: `src/engine-bridge/tests/PolicyScopeCompilerFromRules.test.ts`

**Interfaces:**
- Produces: `interface IPolicyRuleSource { readonly concept: string; readonly rulesJson: string }` (lower-case data-shape fields, mirroring the serialized JSON and `AccessPolicySetting.Load`); `PolicyScopeCompiler.FromRules(rules: Iterable<IPolicyRuleSource>, description: ISchemaDescription): PolicyScopeCompiler`. `Compile`, `Diagnostics` and `MembersOf` are unchanged.

- [ ] **Step 1: Failing tests.** Parity is checked against `PolicyCatalog.FromPolicies` + `PolicyPredicateCompiler.CompileRuleSet` from todl-identity-engine, run over the same rules on typed `EntityView`s. If identity-engine is not a TODL dev dependency, inline the evaluator's 4-case semantics as a test oracle class in the test file.
  - `same scope as FromRepository for string rules`: the rules JSON of the existing `PolicyScopeCompiler.test.ts` fixture compiles to `PredicateCodec`-equal Rows and Writes through both factories.
  - `number literal matches typed member`: `allow read when entity.priority == 5`, with `priority` Int64, gives `Compare(priority, Eq, 5n)`. An engine node with `priority 5n` is visible, and the oracle agrees.
  - `string literal against numeric member never matches`: `== '5'` folds to False with no diagnostic.
  - `entity membership keeps parity`: `allow read when principal.id in entity.owners` gives False plus `NeverMatches`.
  - `malformed concept fails closed`: `{concept: 'A', rulesJson: '[{"effect":"maybe"}]'}` gives `MalformedPolicy`, and A's Rows and Writes are False. Concept B, with valid rules, is unaffected.
  - `unknown concept falls to default` (`UnknownConcept`).
  - `last entry wins for a repeated concept`.
  - `deny overrides allow`: allow `entity.region == principal.region` and deny `entity.locked == true` gives a visible node only when the region matches and it is not locked, under both the oracle and the engine.
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/engine-bridge/tests/PolicyScopeCompilerFromRules.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** T13. `FromRepository` passes `SourceText`, and its existing tests must stay unchanged.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Record T13, then commit `feat(engine-bridge): PolicyScopeCompiler.FromRules for runtime policies`.

### Task 9: External-connector conformance over the host adapters (todl-connectors-host)

**Files:**
- Modify: `todl-connectors-host/package.json` (devDependency `@pragmatic-tech-ai/graph` `^0.2.0`)
- Create: `todl-connectors-host/src/testing/external-connector-conformance.ts`, `src/tests/external-connector-conformance.test.ts`

**Interfaces:**
- Consumes: `DataSourceConnector`, `ExternalIdentity` and `IExternalConnectorPlan` from `@pragmatic-tech-ai/todl/engine`; host fixtures `pg-mem-adapter.ts`, `fake-document-session.ts`, `fake-rest-http-client.ts`, `fake-graphql-http-client.ts`, `fake-cypher-session.ts`.
- Produces: `interface IExternalConformanceOptions { readonly HonorsVersionGuard?: boolean; readonly Paged?: boolean }`; `class ExternalConnectorConformance { static Describe(name: string, make: () => Promise<IDataSourceAdapter>, options?: IExternalConformanceOptions): void }`. It runs over source `Customer` seeded `{id: 'c1', label: 'Acme'}`, the same fixture contract as `adapter-conformance.ts`.

- [ ] **Step 1: Failing cases** registered by `Describe` (each a `node:test` test):
  - `scan returns the seed row with a minted id`.
  - `key lookup finds c1 and misses c9`.
  - `push-down result equals no-push-down result`: a predicate on `label` gives the same row set when fetched with and without translation (D4).
  - `paged fetch drains` (only when `Paged`).
  - `create commits to the source`.
  - `update commits to the source`.
  - `delete commits to the source`.
  - `revert after commit restores the before-image`.
  - `per-op failure surfaces as ExternalWriteFailed` (a version conflict when `HonorsVersionGuard`, else an unknown source).
  The test file registers `Describe` for SQL (pg-mem, `HonorsVersionGuard: false`, `Paged: true`), Document (replica-set fake and standalone fake), REST, GraphQL and Cypher.
- [ ] **Step 2: Run** `npx tsx --test src/tests/external-connector-conformance.test.ts` (in todl-connectors-host). Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the harness. Any adapter-specific failure it exposes is fixed in the adapter, in this task.
- [ ] **Step 4: Run** `npm test` in todl-connectors-host, then `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit in todl-connectors-host `test(connectors): external-connector conformance over every host adapter`.

### Task 10: Exports, docs, release and M2.3 handoff

**Files:**
- Modify: `src/engine-bridge/index.ts` (export every new public symbol from Tasks 2–8), `TODL/package.json` (`0.54.0`), `TODL/docs/` engine-bridge section if one exists (otherwise the class comments are the docs), `pragmatic-graph/docs/integration/m2-runtime-inventory.md` (append "After M2.2": the new TODL APIs and the handoff list below)
- Test: `src/engine-bridge/tests/EngineBridgeSurface.test.ts`

- [ ] **Step 1: Failing test** `engine subpath exports the runtime surface`: import from `@pragmatic-tech-ai/todl/engine` each of `DataSourceConnector`, `ExternalIdentity`, `ExternalWriteError`, `EnvironmentCatalogComposer`, `EnvironmentCatalogError`, `DeliveryChannel`, `EnvironmentNodePlacement`, `SystemPackage`, `SystemNames`, `ShareGrantScope`, `ShareGrants`, `ShareRight` and `ShareSubject`, and check that `PolicyScopeCompiler.FromRules` is a function. Also assert that the root entry exports `CypherWire` and none of the above.
- [ ] **Step 2: Run** the test. Expected: FAIL for any missing export.
- [ ] **Step 3: Implement** the exports, bump the version, and append the handoff to the inventory.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run build` in TODL. Expected: all PASS.
- [ ] **Step 5:** Commit `chore: 0.54.0 — runtime on the engine (M2.2)`. Publishing is the controller's step, after review and with the user's go-ahead.

## Retirement handoff to M2.3 (nothing below is deleted in M2.2)

After the server switches its runtime and dev paths onto the environment engine, M2.3 deletes the following. Each item lists the server importer that must go first.

- **TODL `src/cypher/**`, and the root `export * as Cypher`.** First the server must stop importing it: the handler (parser, `ReferencedLabels`, `OverQuery`/`ToDto`, `Deadline`, errors), pragmatic-server (`CypherPushDown`, `GraphQuerySchema`, `ParameterValue`), `cypher-result-mapper`, the param converter, `execute-result-mapper` and `graph-data-digest` (`GraphQueryAdapter`). After the switch, the server uses the engine's `Cypher` (via `@pragmatic-tech-ai/todl/engine` or the engine directly) and `CypherWire` for DTOs. Before deleting, grep Plexus (`apps/plexus`, `plexus-core`) for `Cypher.` from TODL. If Plexus offline uses TODL's Cypher over `GraphQuery`, keep `src/cypher` for it, and record that it is no longer a server path. This includes `ICypherWriter`, `WriteOverlay`, `push-down.ts` and `GraphQueryAdapter`.
- **TODL `src/graph-api/connector-runtime-graph-query.ts`** and its index export. Importers: environment-graph, pragmatic-server.
- **TODL `src/model-data/connector-prefetch.ts`**, plus `connector-mirror-mapper.ts` and `conjunctive-query-filter-provider.ts` once nothing else imports them. Importers: environment-graph, pragmatic-server.
- **TODL `src/model-data/connector-working-copy.ts`, `federated-model-data-connector.ts`.** Importer: server connector-service `WriteBack`, replaced by an engine transaction.
- **TODL `src/connectors/connector-runtime.ts`.** Importers: server connector-service, page reader, keyed write target, `Connectors()`.
- **TODL `IDescribeOptions.EmitExternalBindings`.** Flip it on for dev descriptions once the dev host installs `DataSourceConnector`s, then remove the option so it always emits (T14).
- **Kept, not deleted:** `GraphQuery`/`IGraphQuery` (client-side bundled FrozenGraph, `ModelDataSource`, `EngineCellMapper`, reflection client), with the server's imports removed. `ModelDataSource` and typed read clients stay on their `IModelDataConnector` seam. The runtime re-base is the existing remote flavour (`cypher/query` pages assembled by `TenantDocumentAssembler`, now on `CypherWire`), and the server-side `ConnectorRuntime` → `ModelDataSource` bridge dies with `ConnectorRuntime`. Also kept: the `IDataSourceAdapter` family, `DataSourceAdapterCatalog` and every host adapter (they sit under `DataSourceConnector`).
- **Server-side replacements** (for M2.3's own plan):
  - `AppConnectorPlan` and `RuntimeAppGraph` are replaced by `EnvironmentCatalogComposer`.
  - `ShareStore`/`ShareGrantIndex`/`ShareWidening*` are replaced by `todl.system.ShareGrant` nodes plus `ShareGrantScope`; grants of deleted records are deleted in the same transaction.
  - `AccessPolicySetting.Load` → `IdentityEnforcement` is replaced by `PolicyScopeCompiler.FromRules`, with `MalformedPolicy` treated as fatal.
  - `ExternalIdentity.ReadOnly()` is folded into scope write predicates as False, and seeded nodes get a write predicate `Not(Seeded)` (spec §6 runtime ruling).
  - `ExternalWriteError.Failures` kinds map to `AppWriteResultDto` statuses (T9).
