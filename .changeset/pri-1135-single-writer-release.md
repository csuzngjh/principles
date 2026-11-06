---
"@principles/core": minor
"@principles/host-runtime": patch
---

core: add `TRAJECTORY_REQUIRED_COLUMNS` and `convergeTrajectorySchemaVersion` — one declaration of the columns trajectory.db must carry and one writer of its `schema_version` row (PRI-1135). Both are module-level exports of `runtime-v2/trajectory-schema`; the runtime-v2 barrel surface is unchanged.

host-runtime: drop the duplicate hand-maintained column list and import the core constant instead. Because host-runtime now names an export that this core release introduces, both packages must ship in the same version pass — a host-runtime-only release would resolve `@principles/core@4.1.x` and fail at module link time.
