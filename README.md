# @pragmatic-tech-ai/graph

Graph database storage engine for TypeScript: an ordered KV layer (LMDB) with a graph layout on top.

    npm install
    npm test
    npm run typecheck
    npm run build

## GraphEngine

`GraphEngine` is the entry point for hosts. `GraphEngine.Open` takes a schema description (`ISchemaDescription`: definitions, indexes, seed, connector bindings), a storage (`{ Kind: StorageKind.Memory }` or `{ Kind: StorageKind.Lmdb, Path }`) and the connectors the bindings name. It creates or upgrades the store to the description; reopening with the same description changes nothing. Then read with `BeginRead(scope)`, write with `Begin(scope)` (both under an `AccessScope`; `AccessScope.System` sees everything) and follow commits on `CommitApplied` or `ReadChanges`. `Upgrade(description)` applies a new description to a running engine; the connectors stay those given at Open. `ConnectorRevertFailed` reports connector reverts that failed after the caller was answered. Close with `dispose()`.

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

An `AccessScope`'s write rules (`IWriteRules`: `Create`, `Update`, `Delete`) may also name `ReadOnly` members, per operation (`ReadOnly: { Create?, Update? }`): properties and relationships the writer can read but not set, remove, link or unlink on that concept's nodes, `Create` on nodes the write creates and `Update` on existing ones, so a field can be set once at create and then frozen (an `AccessError` with code `MemberReadOnly`; nothing is committed). Placement defaults are exempt from `ReadOnly` and `Hidden`, and the unlinks a `DETACH DELETE` implies are governed by the `Delete` rule instead.

Scope entries apply to a concept's subconcepts and to every concept carrying an aspect. The `ConceptIs(name)` predicate is true only on nodes whose own concept is exactly `name`, so `Or(Not(ConceptIs K), rule)` restricts an entry on `K` to `K`'s own nodes. It works in `Rows` and in write rules, but not in an index `Where`.

`ToDto` encodes each result cell as JSON. Booleans, strings, finite floats and integers within +-(2^53-1) are plain values; null is null; lists are arrays. Other cells are tagged: a node is `{ "$node": { id, concept, owner, properties, links } }` (every visible property, null when unset; links are the outgoing targets by relationship), an integer outside the safe range is `{ "$int": "<decimal>" }`, a NaN or infinite float `{ "$float": "NaN" | "Infinity" | "-Infinity" }`, a date `{ "$date": "YYYY-MM-DD" }`, a datetime `{ "$datetime": "<UTC instant>", "zone": "<IANA>" }`, a duration `{ "$duration": "<ISO-8601>" }`. A relationship is `{ from, type, to }` and a path `{ nodes, relationships }`. A map whose keys look like a tag is escaped as `{ "$map": entries }`, so a query result can never pass for a node or typed scalar. `CypherCellCodec.Decode` is the inverse. Parameters take the same `$date`, `$datetime`, `$duration` and `$float` tags.

`ORDER BY` follows openCypher orderability: NaN sorts above every other number (last ascending, first descending) and equals itself for ordering, while `=` and `<` still treat NaN as comparable to nothing. `min` and `max` use the same order, so `max` is NaN whenever any input is NaN and `min` skips NaN unless every input is NaN.

`Explain(text, scope?, options?)` returns the operator tree `Execute(scope, text, options)` would run, without reading or writing anything; write queries are explained too. The scope is used only for plan-time metadata (members it hides rule out indexes, as at `Execute`; without a scope nothing is hidden), and the options supply the parameters and the limits (with `Skip`, the implicit paging sort shows).

Licensed under Apache-2.0. See NOTICE for attribution.
