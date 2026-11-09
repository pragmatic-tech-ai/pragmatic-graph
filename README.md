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

A query without write clauses runs on one `BeginRead(scope)` reader. A query with write clauses runs on one `Begin(scope)` transaction and commits once at the end, so it produces one `CommitApplied`. Inside the query later clauses see the earlier writes (read-your-writes), and a failed query commits nothing. The scope applies to every read; the write gate and connectors act at commit, so a write query may return its own creates and changes even where the scope's row predicates would hide them from later reads. A write query is never paged or truncated (`Cancel` still applies); for a read, `RowCap` truncates (`Truncated`) and, together with `Skip`, pages (`HasMore`).

`Placement` (an `INodePlacement`) chooses the public id and owner of every node a `CREATE` or `MERGE` makes, from its concept and initial properties. The default, `GuidPlacement`, uses a random UUID and no owner.

`ToDto` encodes each result cell as JSON. Booleans, strings, floats and integers within +-(2^53-1) are plain values; null is null; lists are arrays. Other cells are tagged: a node is `{ "$node": { id, concept, owner, properties, links } }` (every visible property, null when unset; links are the outgoing targets by relationship), an integer outside the safe range is `{ "$int": "<decimal>" }`, a date `{ "$date": "YYYY-MM-DD" }`, a datetime `{ "$datetime": "<UTC instant>", "zone": "<IANA>" }`, a duration `{ "$duration": "<ISO-8601>" }`. A relationship is `{ from, type, to }` and a path `{ nodes, relationships }`. A map whose keys look like a tag is escaped as `{ "$map": entries }`, so a query result can never pass for a node or typed scalar. `CypherCellCodec.Decode` is the inverse.

`Explain(text)` returns the operator tree the query would run, without a scope and without reading or writing anything; write queries are explained too.

Licensed under Apache-2.0. See NOTICE for attribution.
