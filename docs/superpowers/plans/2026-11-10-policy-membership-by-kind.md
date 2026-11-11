# Policy membership by member kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `x in entity.m` (and `entity.m has x`) mean what spec §11.2 says, and the same thing in the engine scope compiler and in the runtime evaluator. For a relationship member it means the entity links through `m` to the node whose id is `x`. For a scalar member it means `m` equals `x`. Nothing compiles to a silent never-match any more.

**Architecture:** TODL owns the meaning in one place. A new engine-free reference evaluator, `PolicyPredicateEvaluator` in `src/compiler-services/policy/`, evaluates a policy predicate over an `IPolicyEntityView`, which has `Member(name)` for scalars and `Targets(name)` for link targets. Today's identity-engine evaluator logic moves into this class, and todl-identity-engine's `PolicyPredicateCompiler` delegates to it, so the runtime gate and TODL's parity oracle are the same code. The member kind (relationship or scalar) comes from one engine-free rule, `MemberKindRule`. `SnapshotDescriber` itself decides relationship-vs-property through it, so the engine description, the compiler and the instance views cannot disagree. `TermCompiler.CompileMembership` in `PolicyScopeCompiler` compiles by kind. A relationship gets a visibility-independent link test built from `Reachable` (plus a self-exclusion guard in allow positions). A scalar gets the equality or `In` forms that already exist. `IInstanceView` (TODL) and `EntityView` (todl-identity) each gain `Targets(name)`, and every place that builds a view supplies it.

**Tech Stack:** TypeScript (strict, ESM), `node:test` via `tsx`, `@pragmatic-tech-ai/graph` 0.2.x (unchanged; no engine work), TODL 0.54.0 → 0.55.0, todl-identity 0.1.0 → 0.2.0, todl-identity-engine 0.1.0 → 0.2.0, pragmatic-server (consumer, no version).

**Spec:** `D:/architecture-agent/pragmatic-graph/docs/superpowers/specs/2026-11-06-graph-consolidation-design.md` §11.2, last bullet (binding). Supersedes the Q5 default of plan `2026-11-10-todl-runtime-on-engine.md`, the "Entity-member in/has stays False + NeverMatches (Q5)" clause of R117, ruling P4-i, and the allow half of ruling P4-h (see S6). Record the result as **R119** in `pragmatic-graph/docs/decisions.md` (Task 5).

**Repos and branches:** TODL `D:/architecture-agent/TODL`, branch `feat/policy-membership-by-kind` cut from `feat/m2.2-runtime-on-engine`. todl-identity, todl-identity-engine and pragmatic-server each get a branch `feat/policy-membership-by-kind` cut from `master`. Merge locally. Push and publish only on the owner's explicit instruction.

---

## Semantics (binding for every task)

Notation: the AST is `PolicyMembership { collection: PolicyRef; item: PolicyOperand }`. `x in C` and `C has x` parse to the same node, with `collection = C` and `item = x`, so there is no separate direction rule. The cases where `collection` is a principal ref (`entity.m in principal.list`, and a fully constant membership) keep their current compile. The evaluator half of that case changes only as S5 says.

**S1 Member kind.** A member is a **relationship** exactly when the engine description makes it a `MemberKind.Relationship`:
- a declared relationship;
- a field typed by a concept or aspect;
- a many-valued taxonomy field (also a field typed by a primitive whose name is a taxonomy name, when it is many-valued).

Every other declared member is a **scalar**. TODL has no many-valued scalar in the engine: a many-card primitive field is described as one single-valued property, and `ReflectedNode.attrs` holds one `Scalar`. So "many-valued scalar" is not a case. Such a member is a scalar, and equality applies to its one value. `entity.storageId`, and `entity.id` when the concept declares no `id` member, name the node's public id (the existing `TermCompiler.IsId` rule) and count as scalars.

**S2 Item values.** The item is a literal, a principal fact or an entity member. Its value set `V` is:
- the array's elements when the value is an array (`principal.groups`, any list fact): **any-of**;
- `[v]` for a single scalar `v`;
- **empty** when the value is `undefined` or `null` (a missing fact).

An empty `V` makes the membership **False**. This is deliberately not `==`'s `undefined === undefined` behaviour: a missing claim never grants through membership. `not (x in entity.m)` with a missing `x` is therefore True.

**S3 Relationship member `m`.** The membership holds iff some `v` in `V` is a string and the entity has a link through `m` to the node whose public id is `v`. A non-string `v` (number or boolean) never matches.
- An item that is itself an entity member (`entity.a in entity.m`) fails closed with `EntityToEntity`, as today.
- A literal non-string item reports `NeverMatches` with the new message `MsgNotAnId` and folds to False.

**S4 Scalar member `m`.** The membership holds iff the entity's value of `m` is set and equals some `v` in `V`, under the factory's value semantics (`SourceText` for `FromRepository`, `Typed` for `FromRules`, exactly as `==` converts today). Conversion outcomes (`Unconvertible`, `NeverNumber`, `Never`) behave and report as they do in `CompileCompare` and `PrincipalCollection` today. For an id member (S1), the membership holds iff the node id is in `V`'s strings.

**S5 Entity relationship as the item (`entity.rel in principal.list`).** The compiler already means "links to one of the list". The evaluator is changed to agree: when the item is an entity member and `Targets(item)` is defined, the membership holds iff some target is in the list. This closes the same never-match in the opposite direction.

**S6 Link test is visibility-independent.** The evaluator reads raw link targets. It does not know whether the reader may see the target, or whether the target is external. The compiled form must not depend on that either, or `principal.id in entity.members` silently admits nobody when `User` is hidden, falls to Default Deny, or is an external (stub) row. So the compiler uses `Reachable` (unscoped edges), never `Related`, for both S3 and S5. This replaces the allow half of P4-h ("a hidden owner does not grant"). Let `T` be the item's strings.
- **Allow position** (failure False): `And([Reachable(T, [{ Relationship: m, Direction: EdgeDirection.In }], 1), Not(IdIn(T))])`. `Not(IdIn(T))` stops `Reachable`'s "From is reachable" rule from admitting a target node itself, which happens on self-referential relationships such as `Employee.manager`. Residual: an entity that links to itself through `m` and whose id is in `T` is not admitted (narrower, safe).
- **Deny position** (failure True, which is also any odd number of `not`s around an allow leaf): `Reachable(T, [{ Relationship: m, Direction: EdgeDirection.In }], 1)`. This is today's deny form. It may also match a target node itself, which can only widen a deny (safe).

**S7 Kleene and fail-closed.** The evaluator stays two-valued. In some places the engine yields Unknown:
- a fetched external row whose relationship could have an externally held source (`Reachable` is Unknown there);
- a hypothetical create node (`IdIn` and `Reachable` are Unknown);
- the cycle guard.

Unknown stays Unknown under `Not` and is not visible at the top, so in every one of those places the engine is the stricter side. No compiled form may make the engine wider than the evaluator: allow-position forms are equal to or narrower than S3, and deny-position forms are equal to or wider. Engine links are never dangling (a link needs a stored target, a stub for an external one), so `Reachable` from a target id the engine does not hold matches nothing, and nothing links to such a target. Documented residual (owner question OQ1): a create checked by an allow-write rule that uses relationship membership is refused by the engine, because a hypothetical node's graph predicates are Unknown. The in-memory evaluator, given a payload view whose `Targets` is undefined, decides it by S4 on the payload field.

**S8 Unknown members.** An unknown member reports `UnknownMember` and fails closed in the compiler, as today. In the evaluator, `Targets` and `Member` are both undefined, so the membership is False. (This is the existing position-dependent divergence for unknown members. It is unchanged and out of scope.)

**Not in scope:** `==`/`!=` on a relationship member (the compiler reports `RelationshipCompare`, and the evaluator compares `undefined`) is unchanged. Push-down (`PolicyPushDown`) never translates a membership, and a test pins that.

---

## Global Constraints

- Layering: the engine never imports TODL. TODL imports the engine only under `src/engine-bridge/**`. Everything else this plan adds to TODL (`compiler-services/policy`, `model-data`) is engine-free, and `engine-bridge/tests/EngineFree.test.ts` must keep passing. todl-identity-engine and the server call down into TODL. Nothing calls up.
- OOP: no module-level free functions, no mutable module state. Allman braces. PascalCase for interfaces and public methods. Plain data-shape fields that mirror serialized JSON (`IPolicyRuleSource.concept`) keep their casing.
- No inline string literals: messages and reused keys are `private static readonly` PascalCase constants (for example `TermCompiler.MsgNotAnId` and `PrincipalPolicyFacts.GroupsFact`). Fixed value sets are enums.
- Enums are append-only. `PolicyDiagnosticCode` gets no new member. `NeverMatches` keeps value 4: its doc comment is rewritten (Task 4), and nothing is renumbered or removed. The new `ModelMemberKind` enum starts at `Scalar = 1`.
- Tests live in `tests/` subfolders next to the code.
- **Never run `npm install`** in TODL or any workspace repo (it breaks the `file:` symlinks). Siblings consume each other's built `dist`, so run `npm run build` in a repo before testing its dependents.
- TODL's working tree has uncommitted M2.2 changes from another lane (`ChangeBatcher.ts`, `DataSourceTransaction.ts`, `docs/ARCHITECTURE.md`, `package.json`, `EngineBridgeSurface.test.ts`). Do not stash, revert or commit them. Cut the branch once they are committed to `feat/m2.2-runtime-on-engine`, or ask the controller.
- Every task ends green (`npm test` plus typecheck in the touched repo). Fix every review finding, including minors.

## Review Focus

1. **Hidden or external target.** `allow read when principal.id in entity.members` must admit the entity even when the reader cannot see the `User` node (target concept policied away, Default Deny, or an external stub). The old `Related` form admitted nobody. → Task 4 tests `allow: a hidden target still grants (visibility-independent)` (FromRepository) and `relationship membership grants over a hidden target` (FromRules).
2. **Self-referential relationship.** `allow read when principal.id in entity.manager` must not admit the principal's own `Employee` record just because it is the target. → Task 4 test `allow: the target node itself is not admitted (self-referential relationship)`.
3. **Missing principal fact.** `principal.dept in entity.dept` with no `dept` claim must admit nobody, not every row with an unset `dept`. `not (...)` must admit everybody, in both the compiler and the evaluator. → Task 3 test `missing item: membership is False under both kinds`, and Task 4 parity cases `missing fact: scalar membership is False, not IsNull`.
4. **Negation and deny over relationships.** `deny read when principal.id in entity.blockedBy`, and `allow read when not (principal.id in entity.blockedBy)`, must still exclude when the blocking target is hidden. Group lists must work any-of (`principal.groups in entity.teams`). → Task 4 tests `deny: a hidden target still denies`, `not in an allow takes the deny form` and `group list is any-of over links`.
5. **Drift.** The evaluator and the compiler must never classify a member differently, and no rule may be pushed down unsoundly. → Task 2 test `MemberKindRule agrees with SnapshotDescriber for every member form`; Task 4's parity tables use `PolicyPredicateEvaluator` as the oracle in both factories; Task 6 test `membership rules are never pushed down`.

---

### Task 1: `EntityView.Targets` (todl-identity) [parallel with Tasks 2–5]

**Files:**
- Modify: `D:/architecture-agent/todl-identity/src/authz/entity-predicate.ts`, `src/testing/fakes.ts`, `package.json` (version `0.2.0`)
- Test: `src/authz/tests/access.test.ts`, new `src/authz/tests/entity-view.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EntityView
  {
      Member(name: string): unknown;
      /** Link target ids when `name` is a relationship member of the entity's concept ([] if none); undefined for a scalar or unknown member. */
      Targets(name: string): readonly string[] | undefined;
  }
  ```
  `Targets` is required, so every view builder has to decide on it.

- [ ] **Step 1: Failing test** `entity-view.test.ts` › `fake entity view exposes targets`. The testing fake built with `{ fields: { a: 'x' }, links: { owners: ['u1'] } }` gives `Targets('owners')` deep-equal to `['u1']`, `Targets('a') === undefined`, and `Member('a') === 'x'`.
- [ ] **Step 2: Run** `npm test` in todl-identity. Expected: FAIL (the fake has no `links`, so it does not compile).
- [ ] **Step 3: Implement.** Add the member, and extend the fake view builder in `testing/fakes.ts` with an optional `links: Record<string, readonly string[]>`. A member listed in `links` is a relationship, and every other member's `Targets` is undefined. Update the `EntityView` literals in `access.test.ts` with `Targets: () => undefined`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(authz): EntityView.Targets for relationship members`.

### Task 2: One member-kind rule and `IInstanceView.Targets` (TODL)

**Files:**
- Create: `src/model-data/member-kind-rule.ts`, `src/model-data/repository-member-kinds.ts`, `src/model-data/instance-views.ts`
- Modify: `src/model-data/instance-filter.ts`, `src/model-data/model-data-source.ts` (`admits`), `src/engine-bridge/SnapshotDescriber.ts` (`FieldMember` and `RelationshipMember` decide the kind through the rule; value-type mapping unchanged), `src/engine-bridge/PolicyScopeCompiler.ts` (private `MembersOf(repo, concept)` takes its kind from `RepositoryMemberKinds`, and its value-type mapping stays), `src/index.ts` (root exports)
- Test: new `src/model-data/tests/member-kind-rule.test.ts` and `src/model-data/tests/instance-views.test.ts`; update `src/model-data/tests/instance-filter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export enum ModelMemberKind { Scalar = 1, Relationship }
  export class MemberKindRule
  {
      /** Taxonomy names are collected from `manifests` exactly as SnapshotDescriber.Run does (manifest.taxonomies()). */
      public static FromManifests(manifests: Iterable<Manifest>): MemberKindRule;
      public FieldIsRelationship(field: FieldInfo): boolean;
      /** Relationship / Scalar per S1 for an effective member of `type`; undefined when `type` has no such member. */
      public KindOf(type: TypeInfo, member: string): ModelMemberKind | undefined;
  }
  export class RepositoryMemberKinds
  {
      /** S1 over a Repository's effective schema (today's PolicyScopeCompiler.MembersOf kind decision, moved). */
      public static Of(repo: Repository, concept: string): ReadonlyMap<string, ModelMemberKind>;
  }
  export interface IInstanceView
  {
      readonly Concept: string;
      Field(name: string): Scalar | undefined;
      Targets(name: string): readonly string[] | undefined;
  }
  export class InstanceViews
  {
      public constructor(rule: MemberKindRule);
      /** Field: the mirror's value; storageId (and id when undeclared) read the node id. Targets: node.refs[name] ?? [] for a relationship, else undefined. */
      public OfMirror(mirror: IInstanceMirror): IInstanceView;
      /** Field: node.attrs (ids as in OfMirror); Targets: repo.refs(node.id, name) for a relationship per RepositoryMemberKinds, else undefined. */
      public static OfRepositoryNode(repo: Repository, node: Node): IInstanceView;
  }
  ```
- `ModelDataSource` builds one `InstanceViews` from the manifests of the reflection graph it reads, and `admits` uses `OfMirror`.

- [ ] **Step 1: Failing tests.**
  - `member-kind-rule.test.ts` › `MemberKindRule agrees with SnapshotDescriber for every member form`: a fixture concept declares a scalar field, a concept-typed field, an aspect-typed field, a single and a many taxonomy field, a many-card primitive, and a declared relationship. For each member, `KindOf` is `Relationship` iff the `SnapshotDescriber` description has `MemberKind.Relationship` for it, and `RepositoryMemberKinds.Of` agrees on the same fixture. A name that is not a member gives undefined.
  - `instance-views.test.ts` › `mirror view exposes link targets for relationships only`: `Order { name : string; owner : Customer?; tags : Color*; }` with `o1.owner = c1`. Then `Targets('owner')` is `['c1']`, `Targets('tags')` is `[]`, `Targets('name')` is undefined, and `Field('name')` is the value.
  - `instance-views.test.ts` › `id members read the node id`: `Field('storageId')` and `Field('id')` (undeclared) both equal the node id. A concept that declares `id : string` reads its attribute.
  - `instance-views.test.ts` › `repository node view matches mirror view`: for every member of the fixture, `OfRepositoryNode` and `OfMirror` give equal `Field` and `Targets`.
  - `instance-filter.test.ts` › `filter sees targets`: a filter keeping `v.Targets('owner')?.includes('c1')` keeps exactly `o1`.
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/model-data/tests/*.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the kind decision into the two classes. `SnapshotDescriber` and `PolicyScopeCompiler.MembersOf` call them, and their existing tests (`PolicyScopeCompiler member mapping matches SnapshotDescriber`, the describer suite) must pass unchanged. Add `Targets` to every `IInstanceView` literal in TODL tests.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(model-data): one member-kind rule; IInstanceView.Targets`.

### Task 3: Reference evaluator `PolicyPredicateEvaluator` (TODL)

**Files:**
- Create: `src/compiler-services/policy/policy-predicate-evaluator.ts`
- Modify: `src/index.ts` (root export)
- Test: new `src/compiler-services/policy/tests/policy-predicate-evaluator.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface IPolicyEntityView
  {
      Member(name: string): unknown;
      Targets(name: string): readonly string[] | undefined;
  }
  /** Structurally satisfied by engine-bridge IPrincipalFacts and by todl-identity-engine PrincipalPolicyFacts. */
  export interface IPolicyFacts
  {
      Get(name: string): Scalar | readonly Scalar[] | undefined;
  }
  export class PolicyPredicateEvaluator
  {
      /** Compare: === on raw values (unchanged semantics). Membership: S2-S5. Bool/Not: two-valued. */
      public static Holds(predicate: PolicyPredicate, entity: IPolicyEntityView, facts: IPolicyFacts): boolean;
      /** Or(allows) AND NOT Or(denies); an action without rules admits. */
      public static Admits(rules: readonly PolicyRule[], action: PolicyAction, entity: IPolicyEntityView, facts: IPolicyFacts): boolean;
  }
  ```
  `IInstanceView` with `Field` adapted to `Member` and todl-identity's `EntityView` are both assignable to `IPolicyEntityView`.

- [ ] **Step 1: Failing tests**, each asserting `Holds(...)`:
  - `compare keeps === semantics`: the current identity-engine cases (missing claim `==` literal is false; two missing facts are equal; `!=` of an absent field is true).
  - `relationship membership: id in targets`: `principal.me in entity.owners` with targets `['u1','u2']` and `me='u2'` is true. With `me='u9'` it is false. `5 in entity.owners` is false.
  - `relationship membership: list item is any-of`: `principal.groups in entity.teams` with groups `['g1','g2']` and targets `['g2']` is true. With `[]` it is false.
  - `scalar membership is equality`: `principal.region in entity.region` with `'eu'` and `'eu'` is true. With `'us'` it is false. An unset member is false.
  - `scalar membership: list item is any-of`: `principal.regions in entity.region` with regions `['us','eu']` and `'eu'` is true.
  - `missing item: membership is False under both kinds`: a missing fact against a relationship and against a scalar (set and unset) gives false, and `not (...)` gives true.
  - `entity relationship item in principal list`: `entity.owner in principal.owners` with targets `['c1']` and list `['c1']` is true (S5). A scalar item keeps `list.includes(Member(item))`.
  - `entity in entity is false`: `entity.a in entity.m` is false.
  - `has is the same node as in`: a predicate parsed from `entity.owners has principal.me` holds wherever `principal.me in entity.owners` does (parse both through `PolicyRules.Parse` of compiled rules).
  - `admits combines rules`: deny overrides allow, and no rules for the action admits.
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/compiler-services/policy/tests/policy-predicate-evaluator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `Holds` as a switch over `PolicyNodeKind` (no free functions), with private statics `Value(operand, entity, facts): unknown`, `Items(value: unknown): readonly unknown[]` (S2) and `Membership(node, entity, facts): boolean` (S3–S5).
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(policy): engine-free reference evaluator with membership by kind`.

### Task 4: Compile membership by kind (TODL `PolicyScopeCompiler`)

**Files:**
- Modify: `src/engine-bridge/PolicyScopeCompiler.ts`: `TermCompiler.CompileMembership`, new private `EntityCollection`, `Links`; remove `MsgNever` and add `MsgNotAnId`; rewrite the `NeverMatches` doc comment to "a test that can never hold given the member's kind or type (a number against decimal-text values, a non-string id against a relationship)"; class doc of `PolicyScopeCompiler`
- Test: `src/engine-bridge/tests/PolicyScopeCompiler.test.ts`, `src/engine-bridge/tests/PolicyScopeCompilerFromRules.test.ts`

**Interfaces:**
- Consumes: `PolicyPredicateEvaluator` (Task 3) and `InstanceViews` / `ModelMemberKind` (Task 2).
- Internal signatures:
  ```ts
  private CompileMembership(collection: PolicyRef, item: PolicyOperand, failure: Predicate): Predicate;
  /** `item in entity.member` (S3/S4): dispatch on IsId / member kind. */
  private EntityCollection(member: string, item: IOperand, failure: Predicate): Predicate;
  /** S6: allow (failure False) And(Reachable(T,[{m,In}],1), Not(IdIn(T))); deny (failure True) Reachable(T,[{m,In}],1). */
  private static Links(member: string, targets: ReadonlySet<string>, failure: Predicate): Predicate;
  private static readonly MsgNotAnId = 'a non-string value tested against relationship "{1}" of "{0}" never matches (link targets are node ids)';
  ```
- Compiled shapes (exact), with `T` = the item's strings and `V` = the item values (S2):
  - **Empty `V`:** `FalsePredicate`, with no diagnostic.
  - **Item is an entity member:** `failure`, reported as `EntityToEntity`.
  - **Collection is an id member:** `IdIn(T)`, or `FalsePredicate` when `T` is empty.
  - **Collection is a relationship:** `Links(m, T, failure)`, or `FalsePredicate` when `T` is empty. A literal non-string item reports `NeverMatches` (`MsgNotAnId`).
  - **Collection is a scalar, single item:** the same tree and diagnostics as `entity.m == x` produces today when `x` is defined (`And([Not(IsNull(m)), Compare(m, Eq, cell)])`, or the conversion's fold or `failure`).
  - **Collection is a scalar, list item:** exactly `PrincipalCollection(list, { Member: m }, failure)`.
  - **Unknown collection member:** `failure`, reported as `UnknownMember`.
  - **`entity.rel in principal.list` (`PrincipalCollection`):** its relationship branch now also calls the new `Links`, so its allow form changes from `Related` to the S6 allow form.

- [ ] **Step 1: Failing tests** (rewrite the P4-i/Q5 tests; keep every other existing test).
  - In `PolicyScopeCompiler.test.ts`, the fixture `Order` gains `members : Customer*;` and `Customer` gains `manager : Customer?;`. Links: `o1.members = [c1, c2]`, `c3.manager = c1`, and `c1.manager = c1` (self-loop).
    - Parity table rows. Each row's `Visible` is asserted equal to the engine scan and to `PolicyPredicateEvaluator.Admits` over `InstanceViews.OfRepositoryNode` views of the same compiled repository data:
      - `principal fact in entity property is equality` (`principal.region in entity.region`, region `'eu'`, visible `['c1','c4']`);
      - `list fact in entity property is any-of` (regions `['us','zz']`, visible `['c2']`);
      - `missing fact: scalar membership is False, not IsNull` (visible `[]`);
      - `not over missing-fact membership admits all` (visible `['c1','c2','c3','c4']`).
    - `principal fact in entity relationship matches links` (replaces P4-i): `allow read when principal.me in entity.owner` with `me='c2'` gives Orders `['o2']`, and `Diagnostics` is `[]`.
    - `has form compiles like in`: `entity.owner has principal.me` gives a `PredicateCodec`-equal Rows predicate.
    - `allow: a hidden target still grants (visibility-independent)` (replaces P4-h's allow test): Customer allowed only for `region == "eu"`. `principal.me in entity.owner` with `me='c2'` (hidden) gives `['o2']`, and `entity.owner in principal.owners` with `['c2']` gives `['o2']`.
    - `allow: hidden target grants under Default Deny`: same result with `AccessDefault.Deny` and no Customer policy.
    - `allow: the target node itself is not admitted (self-referential relationship)`: `policy Customer { allow read when principal.me in entity.manager; }` with `me='c1'` gives `['c3']`. This also pins the S6 self-loop residual: the evaluator admits `['c1','c3']`, because `c1.manager = c1`. The test asserts that the engine set is a subset of the evaluator set and differs only by `c1`.
    - `deny: a hidden target still denies`: `deny read when principal.me in entity.members` with `me='c2'` (hidden) gives Orders `['o2','o3']`.
    - `not in an allow takes the deny form`: `allow read when not principal.me in entity.members` with `me='c2'` gives `['o2','o3']`. The compiled Rows equal `Not(Reachable({'c2'}, [{members, In}], 1))`.
    - `group list is any-of over links`: `principal.groups in entity.members` with `['zz','c1']` gives `['o1']`.
    - `exact predicate shapes`: allow Rows for `principal.me in entity.owner` (`me='c1'`) is `PredicateCodec`-equal to `And([Reachable({'c1'}, [{ Relationship: 'owner', Direction: In }], 1), Not(IdIn({'c1'}))])`. In a deny it is `Reachable({'c1'}, ..., 1)`.
    - `non-string literal against a relationship never matches and is reported`: `5 in entity.owner` gives Rows False and `Diagnostics` codes `[NeverMatches]` with the message from `MsgNotAnId`.
    - `entity in entity membership fails closed`: `entity.name in entity.owner` gives allow False, deny True, and `[EntityToEntity]`.
    - `write: allow-write by relationship membership refuses creates (S7 residual)`: a create of an Order under `allow write when principal.me in entity.owner` fails with `AccessErrorCode.CreateDenied`, and an update of `o1` with `me='c1'` succeeds.
    - Extend `Diagnostics are structural`: the membership rules above give the same `Diagnostics` for two different principals, and before `Compile`.
  - In `PolicyScopeCompilerFromRules.test.ts`, delete the inlined `Oracle`. `Fx.OracleVisible` uses `PolicyPredicateEvaluator.Admits` over views built from `Fx.Rows` (`Member` = `Entity[name]`, `Targets` = `Links[name]` for members the description marks `Relationship`, else undefined). `Fx.Description` gains `members` (`MemberKind.Relationship`, `Targets: [Fx.B]`, `Many: true`), and `Fx.Open` links `a1.members → b1`.
    - `entity membership keeps parity` is replaced by:
      - `scalar membership matches typed values` (`principal.p in entity.priority` with `p = 5` gives `['a1','a3']`);
      - `string fact against Int64 scalar membership never matches` (no diagnostic);
      - `relationship membership grants over a hidden target` (B allowed for nobody; `principal.me in entity.members` with `me='b1'` gives `['a1']`).
    - Each of these asserts engine-visible equals `Fx.OracleVisible`, and `Diagnostics` has no `MalformedPolicy`.
    - Extend `same scope as FromRepository for string rules` with `allow read when principal.region in entity.region` (shape-equal through both factories).
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/engine-bridge/tests/PolicyScopeCompiler*.test.ts`. Expected: FAIL (False/NeverMatches today, and the `Related` shape).
- [ ] **Step 3: Implement** per the shapes above. `Fold` is unchanged. `Links` is used by both `PrincipalCollection` and `EntityCollection`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS (including `EngineFree.test.ts`).
- [ ] **Step 5: Commit** `feat(engine-bridge): policy membership compiles by member kind (spec 11.2)`.

### Task 5: TODL release prep and decision record (TODL + pragmatic-graph docs)

**Files:**
- Modify: TODL `package.json` (version `0.55.0`), `docs/ARCHITECTURE.md` (policy section: one reference evaluator, membership by kind; edit only the policy lines and leave the other lane's pending edits alone), `pragmatic-graph/docs/decisions.md` (append **R119**)

- [ ] **Step 1:** Append R119 (TODL policy membership by kind, spec §11.2). It records S1–S8 verbatim in short form, names the superseded rulings (R117 Q5 clause, P4-i, P4-h allow half), and names the shared oracle (`PolicyPredicateEvaluator`, `MemberKindRule`).
- [ ] **Step 2: Run** `npm run build`, `npm test` and `npm run typecheck` in TODL. Expected: PASS, with `dist/` exporting `PolicyPredicateEvaluator`, `IPolicyEntityView`, `IPolicyFacts`, `InstanceViews`, `MemberKindRule`, `RepositoryMemberKinds` and `ModelMemberKind` from the root.
- [ ] **Step 3: Commit** in TODL `chore(release): 0.55.0 policy membership by kind` and in pragmatic-graph `docs(decisions): R119 policy membership by member kind`.

### Task 6: Runtime evaluator delegates to TODL (todl-identity-engine) [after Tasks 1 and 5]

**Files:**
- Create: `src/policy/principal-policy-facts.ts`
- Modify: `src/policy/policy-predicate-compiler.ts` (remove the private `Evaluate`/`Operand`; `Compile` delegates), `src/adapters/policy-instance-filter.ts` (the view passes `Targets`), `src/index.ts` (export `PrincipalPolicyFacts`), `package.json` (version `0.2.0`)
- Test: `src/policy/tests/policy-predicate-compiler.test.ts`, `src/adapters/tests/policy-instance-filter.integration.test.ts`, new `src/adapters/tests/policy-push-down-membership.test.ts`; add `Targets` to every `EntityView`/`IInstanceView` literal in the existing tests (`fusion-access-policy.test.ts`, `access-depth-evaluator.test.ts`, …)

**Interfaces:**
- Produces:
  ```ts
  export class PrincipalPolicyFacts
  {
      private static readonly GroupsFact = 'groups';
      public readonly Id: string;
      public constructor(principal: Principal);
      /** `groups` is principal.Groups; any other name is principal.Claim(name). */
      public Get(name: string): Scalar | readonly Scalar[] | undefined;
  }
  ```
  `PolicyPredicateCompiler.Compile(predicate, principal)` returns `{ Matches: (view) => PolicyPredicateEvaluator.Holds(predicate, view, facts) }` with one `PrincipalPolicyFacts` per call. `CompileRuleSet` keeps its signature and fusion.

- [ ] **Step 1: Failing tests.**
  - `policy-predicate-compiler.test.ts`: `Fixture.View(fields, links = {})` adds `Targets`. The existing `membership over non-array collection is false` becomes `scalar membership is equality` (`"a" in entity.name` with `name: "a"` is true; with `"b"` it is false). New:
    - `relationship membership matches a claim`: claim `id: 'u1'`, `principal.id in entity.owners`, links `owners: ['u1']` gives true; `['u2']` gives false;
    - `groups any-of over links`: `principal.groups in entity.teams` with groups `['admins']` and links `teams: ['admins']` gives true;
    - `missing claim never grants through membership`: true for `not (...)`.
  - `policy-instance-filter.integration.test.ts` › `relationship membership filters reflected instances`: the policy `allow read when principal.id in entity.owner` over a compiled model, with `ModelDataSource.Instances`, keeps exactly the owned instances.
  - `policy-push-down-membership.test.ts` › `membership rules are never pushed down`: `PolicyPushDown.EligibleFilter` gives undefined for `allow read when principal.id in entity.owners` and for `allow read when principal.region in entity.region and entity.kind == "x"`.
  - `principal-policy-facts` › `groups and claims`: `Get('groups')` is the groups array, `Get('id')` is `Claim('id')`, and absent is undefined.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Delegate, and add `Targets: (n) => view.Targets(n)` in `PolicyAccessInstanceFilter`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(policy): evaluate through TODL's reference evaluator; membership by kind`.

### Task 7: Server adoption and the M2.3 handoff (pragmatic-server) [after Task 6]

**Files:**
- Modify: `src/host/cypher/filtered-graph-query.ts:77` and `src/host/filtered-read-write-target-source.ts:31` (build the view with `InstanceViews.OfMirror` and spread `RecordKey`), `src/host/model-read-filter.ts:24` (`InstanceViews.OfRepositoryNode(model, node)`), `src/host/runtime-app-writer.ts:249` (`PayloadView`: `Targets: () => undefined`, a payload carries no links, per S7), `src/host/engine/depth-scope-compiler.ts:314` (`EmptyView` adds `Targets: () => undefined`), `src/host/engine/principal-facts.ts` (deleted; the dev-access scope source and its tests use `PrincipalPolicyFacts`)
- Test: every test literal of `IInstanceView`/`IRecordKeyedView` (`runtime-app-writer.test.ts:472`, …) gains `Targets`; new `src/host/tests/model-read-filter-membership.test.ts`; extend `src/host/engine/tests/dev-access-scope-source.test.ts`

- [ ] **Step 1: Failing tests.**
  - `model-read-filter-membership.test.ts` › `runtime read gate admits by relationship membership`: a runtime model with `allow read when principal.id in entity.owners`, read by principal claim `id = 'u1'`, sees only the records linked to `u1`.
  - `dev-access-scope-source.test.ts` › `membership rules compile without never-match diagnostics`: the dev scope's `Policies.Diagnostics` for `principal.id in entity.owners` is empty, and the engine read under that scope agrees with `ModelReadFilter` on the same data.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (views lack `Targets`, so compilation fails, and the membership gate never matches).
- [ ] **Step 3: Implement** the site changes above.
- [ ] **Step 4: Run** `npm test` and `npx tsc -p tsconfig.build.json --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(host): instance views carry link targets; policy membership by kind`.
- [ ] **Step 6: M2.3 handoff note** (in the M2.3 plan's inputs, not code). `FromRules` emits no `MalformedPolicy` for membership, so treating `MalformedPolicy` as fatal is unaffected. `NeverMatches` now means a statically impossible literal and should be surfaced as a deploy warning. When M2.3 retires the in-memory gates, `PolicyPredicateEvaluator` stays as TODL's test oracle.

---

## Order, parallelism, release

- Task 1 (todl-identity) runs in parallel with Tasks 2→3→4→5 (TODL, sequential).
- Task 6 starts once Tasks 1 and 5 are built. Task 7 starts once Task 6 is built.
- Release order (on owner instruction only): todl-identity 0.2.0 and TODL 0.55.0 (either order), then todl-identity-engine 0.2.0, then the server consumes them through its `file:` dependencies after a rebuild. pragmatic-graph has no version change.

## Open questions for the owner (defaults are used; nothing blocks)

- **OQ1 Creates under relationship-membership write rules.** **Default:** the engine refuses them (S7). A hypothetical create node cannot evaluate `Reachable`/`IdIn`, and that was already true of today's `entity.rel in principal.list`. Allowing them needs an engine change: decide a create's own links in the batch against graph predicates. Should that engine work be scheduled?
- **OQ2 Visibility independence (S6) reverses P4-h's allow half.** **Default:** membership through a hidden or external target grants, as the evaluator and the §11.2 wording do. If hidden-target grants must stay forbidden, the evaluator would have to consult target visibility instead.
