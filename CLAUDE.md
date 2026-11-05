# pragmatic-graph

Graph database storage engine (KV layer + graph layout). npm: `@pragmatic-tech-ai/graph`, Apache-2.0.

## Layering
The engine is the lowest layer. It must not import anything from TODL, Mural or any higher layer, and exposes no types from them. Upward communication is by raising signals only. Only runtime dependency: `lmdb`.

## Code style
- Object-oriented: no module-level free functions, no mutable module-level state. Behavior lives in classes (static members allowed).
- Allman braces: opening brace on its own line for classes, methods and control flow (`else`/`catch`/`finally` on their own line). Object literals and block-bodied arrows stay inline.
- PascalCase for interfaces and public methods.
- Reused string literals are `private static readonly` PascalCase constants; fixed sets of values are enums, not string literals.
- Teardown through `dispose()`.
- Public storage APIs are async and never return live references into storage.

## Tests
Every test file lives in a `tests/` subfolder next to the code it exercises (`src/<area>/tests/*.test.ts`). Run with `npm test`; type-check with `npm run typecheck`.
