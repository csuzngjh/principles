---
"@principles/core": minor
---

Export `resolveStateDbPath` through `@principles/core/runtime` — the same resolver `SqliteConnection` uses to locate `<workspace>/.pd/state.db` — so write-boundary guards can check the real database path before a connection is constructed instead of re-deriving it.
