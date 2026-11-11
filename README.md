# @pragmatic-tech-ai/graph

Graph database storage engine for TypeScript: an ordered KV layer (LMDB) with a graph layout on top.

    npm install
    npm test
    npm run typecheck
    npm run build

## GraphEngine

`GraphEngine` is the entry point for hosts. `GraphEngine.Open` takes a schema description (`ISchemaDescription`: definitions, indexes, seed, connector bindings), a storage (`{ Kind: StorageKind.Memory }` or `{ Kind: StorageKind.Lmdb, Path }`) and the connectors the bindings name. It creates or upgrades the store to the description; reopening with the same description changes nothing. Then read with `BeginRead(scope)`, write with `Begin(scope)` (both under an `AccessScope`, and both taking optional `IBeginOptions` whose `Connector` is the `ConnectorContext` for that caller's connector work, `Anonymous` by default; `AccessScope.System` sees everything) and follow commits on `CommitApplied` or `ReadChanges`. `Upgrade(description)` applies a new description to a running engine; the connectors stay those given at Open. `ConnectorRevertFailed` reports connector reverts that failed after the caller was answered. Close with `dispose()`.

    const engine = await GraphEngine.Open({ Description: description, Storage: { Kind: StorageKind.Lmdb, Path: dir } });
    const t = await engine.Begin(AccessScope.System);
    t.CreateNode('n1', 'note');
    await t.Commit();
    await engine.dispose();

## Cypher

`Cypher.CypherEngine` runs Cypher on a `GraphEngine` under an `AccessScope`.

    const cypher = new Cypher.CypherEngine(engine);
    const result = await cypher.Execute(scope, 'MATCH (n:note) WHERE n.title = $t RETURN n', {
        Parameters: new Map([['t', 'hello']]),
        Limits: { RowCap: 100 },
        Placement: new Cypher.GuidPlacement(),
    });
    const dto = Cypher.CypherEngine.ToDto(result);

A query without write clauses runs on one `BeginRead(scope)` reader. A query with write clauses runs on one `Begin(scope)` transaction and commits once at the end, so it produces at most one `CommitApplied` (none when it changed nothing); `result.Commit` is that commit's number (absent for a read and for a write that changed nothing; a decimal string in the DTO). Inside the query later clauses see the earlier writes (read-your-writes), and a failed query commits nothing. The scope applies to every read; the write gate and connectors act at commit, so a write query may return its own creates and changes even where the scope's row predicates would hide them from later reads. A write query is never paged or truncated (`Cancel` still applies; the deadline is checked as nodes and edges are read, not only per result row); for a read, `RowCap` truncates (`Truncated`) and, together with `Skip`, pages (`HasMore`).

`Placement` (an `INodePlacement`) chooses the public id and owner of every node a `CREATE` or `MERGE` makes, from its concept and initial properties. The default, `GuidPlacement`, uses a random UUID and no owner. Its `INodePlace` may also carry `Defaults`: property values set on the new node when the query did not set them (a query value wins); they are written before the scope's `Create` rules are judged.

An `AccessScope`'s write rules (`IWriteRules`: `Create`, `Update`, `Delete`, `Append`, `AppendTo`) may also name `ReadOnly` members, per operation (`ReadOnly: { Create?, Update? }`): properties and relationships the writer can read but not set, remove, link or unlink on that concept's nodes, `Create` on nodes the write creates and `Update` on existing ones, so a field can be set once at create and then frozen (an `AccessError` with code `MemberReadOnly`; nothing is committed). Placement defaults are exempt from `ReadOnly` and `Hidden`, and the unlinks a `DETACH DELETE` implies are governed by the `Delete` rule instead.

Setting or removing a property is judged by `Update`; a link or unlink is not: it needs the source's `Append` rule and the target's `AppendTo` rule (`AppendDenied` / `AppendToDenied`). `Endpoints` maps a reified edge concept to its `From` and `To` relationships: such an edge node has no privileges of its own and is visible iff the nodes at both members are visible (one with an unset member is never visible), and writing it needs `Append` on its From node and `AppendTo` on its To node; a write that creates one must link both members in the same transaction. Under a scope that restricts reads, a failed commit's error is redacted to a generic conflict message that names no id or value. `EstimateCount` refuses (`InvalidArgument`) under any scope that restricts reads, since an estimate would count hidden nodes.

Scope entries apply to a concept's subconcepts and to every concept carrying an aspect. The `ConceptIs(name)` predicate is true only on nodes whose own concept is exactly `name`, so `Or(Not(ConceptIs K), rule)` restricts an entry on `K` to `K`'s own nodes. It works in `Rows` and in write rules, but not in an index `Where`. Member sets have exact forms too: `HiddenExact` (beside `Hidden`) and a write entry's `ReadOnlyExact` (beside `ReadOnly`, same `{ Create?, Update? }` stages) apply only to nodes whose own concept is exactly the key, never to its subconcepts. A node's hidden or read-only members are the union of the inherited sets that apply to it and the exact set of its own concept. An exact set keyed on an aspect or an unknown name is refused, and the placement-default and `DETACH DELETE` exemptions hold for exact sets as for the inherited ones.

`GraphReader.Admits(concept, properties)` asks the scope about a node that is not stored: whether a node of `concept` with exactly these property values (missing ones null), no owner, no seed provenance and no relationships would pass the scope's row predicates, so a host can show or hide non-instance items without deciding visibility itself. Predicates that need stored identity or edges (`IdIn`, `OwnerIs`, `Seeded`, `Related`, `Reachable`) cannot hold there, even under `Not`; an unknown concept or an aspect name is never admitted. A `null` or `undefined` entry reads as unset; any other value must fit its member as a write would (an integer widens to a float member when exact), else a `GraphError`. It reads nothing from the store.

`ToDto` encodes each result cell as JSON. Booleans, strings, finite floats and integers within +-(2^53-1) are plain values; null is null; lists are arrays. Other cells are tagged: a node is `{ "$node": { id, concept, owner, properties, links } }` (every visible property, null when unset; links are the outgoing targets by relationship), an integer outside the safe range is `{ "$int": "<decimal>" }`, a NaN or infinite float `{ "$float": "NaN" | "Infinity" | "-Infinity" }`, a date `{ "$date": "YYYY-MM-DD" }`, a datetime `{ "$datetime": "<UTC instant>", "zone": "<IANA>" }`, a duration `{ "$duration": "<ISO-8601>" }`. A relationship is `{ from, type, to }` and a path `{ nodes, relationships }`. A map whose keys look like a tag is escaped as `{ "$map": entries }`, so a query result can never pass for a node or typed scalar. `CypherCellCodec.Decode` is the inverse. Parameters take the same `$date`, `$datetime`, `$duration` and `$float` tags.

`ORDER BY` follows openCypher orderability: NaN sorts above every other number (last ascending, first descending) and equals itself for ordering, while `=` and `<` still treat NaN as comparable to nothing. `min` and `max` use the same order, so `max` is NaN whenever any input is NaN and `min` skips NaN unless every input is NaN.

`Explain(text, scope?, options?)` returns the operator tree `Execute(scope, text, options)` would run, without reading or writing anything; write queries are explained too. The scope is used only for plan-time metadata (members it hides rule out indexes, as at `Execute`; without a scope nothing is hidden), and the options supply the parameters and the limits (with `Skip`, the implicit paging sort shows).

Licensed under Apache-2.0. See NOTICE for attribution.

## External bindings

A binding can name a connector that is the source of truth for a concept instead of mirroring the engine's data. A connector's `Residency` is `Mirrored` (the default: the engine stores the data and writes through to the connector) or `External` (`IExternalConnector`: the engine stores no property data and reads the connector on demand). An External connector provides `Capabilities` and `Fetch(IFetchRequest): Promise<IFetchPage>`; it cannot be the `DefaultConnector`. Failures surface as `ConnectorError` with `ConnectorPhase.Fetch`.

Push-down is advisory. `IFetchRequest.Predicate` carries the access scope and the query's filter hints; the connector may apply any part of it or none, because the engine re-checks the scope and every filter on each returned row. `IFetchRequest.Context` carries the caller's `ConnectorContext`, and `IGraphConnector.Begin(context)` opens that caller's connector transaction. One `FetchSession` (built with a context) serves each Cypher read and each `GraphTransaction`; it memoises rows by public id so a query sees one consistent value per external node, and nothing is reused across queries or transactions. A fetched row that a more specific binding owns is dropped; an invalid row fails the query with `ConnectorError` (`ConnectorPhase.Fetch`); a row whose id names a stored engine node is dropped, since the engine node owns the id.

When an engine node links to an external node, the engine stores a stub: an identity-only node (public id, concept, owner, no property cells). A link to a stub resolves through the connector, and a dangling one reads as absent. Access scopes fail closed over fetched rows: a `Related` rule that goes Out to an external target is always Unknown, so it never admits a row by itself.

Writes to external nodes go to the connector only, with no optimistic-concurrency check on the external data. `GraphEngine.ConnectorApplied` (`IConnectorApplied`) fires once per successful write-through of an engine transaction, for Mirrored and External connectors alike, after every participating connector committed (and after the engine commit when the batch had engine ops). It carries the `Commit` (when there was one) and, per connector name, the concepts touched. It never reports changes made inside an external system on its own: external data has no changefeed.

For paging, `ExecutionLimits.After` (a `Cypher.CypherCursor` with `After` and `Ties`) is the keyset alternative to `Skip`; giving both is an `InvalidArgument` error. Start the chain with `Skip: 0` and a `RowCap`, with `ORDER BY` only over returned columns. `CypherResult.NextCursor` is present only when `HasMore`; persist it with `Encode()` and read it back with `CypherCursor.Decode`. Details: `docs/decisions.md`, R96-R104.
