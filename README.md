# @pragmatic-tech-ai/graph

Graph database storage engine for TypeScript: an ordered KV layer (LMDB) with a graph layout on top. Early scaffold.

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

Licensed under Apache-2.0. See NOTICE for attribution.
