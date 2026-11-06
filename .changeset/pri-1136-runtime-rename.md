---
"@principles/core": major
"@principles/host-runtime": patch
"@principles/pd-cli": patch
"@principles/pd-mcp-server": patch
"@principles/codex-adapter": patch
"@principles/workbuddy-adapter": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

core: the `runtime-v2` generation name is gone from the code surface (PRI-1136). The directory `src/runtime-v2/` is now `src/runtime/`, the `@principles/core/runtime-v2` subpath (and its 17 sub-subpaths) is now `@principles/core/runtime`, and the TypeScript identifiers that spelled the generation were renamed (`RUNTIME_V2_PRINCIPLE_BUDGET` → `RUNTIME_PRINCIPLE_BUDGET`, `RuntimeV2SchemaVersionSchema` → `RuntimeSchemaVersionSchema`, `recordRuntimeV2ActivationsInjected` → `recordRuntimeActivationsInjected`, …).

This is a **breaking** subpath change for any package that imports `@principles/core/runtime-v2`: the old specifier no longer resolves. Every in-repo consumer moves in the same commit; the OpenClaw plugin bundles core through esbuild, so installed plugin builds are unaffected.

Frozen wire values did **not** change: `runtime_v2_prompt_activations_injected`, `source: 'pd-runtime-v2'`, `pd-runtime-v2-diagnosis` and the other §4 literals keep their exact bytes. The prompt header `Runtime V2 activated principles:` is also unchanged — the golden characterization tests still pass byte-for-byte.

host-runtime: import paths follow the rename; no behavior change.

pd-cli / pd-mcp-server / codex-adapter / workbuddy-adapter: their compiled output imports the core subpath, so they must be republished in the same version pass — otherwise an installed copy keeps resolving the removed `@principles/core/runtime-v2` specifier. Public API is unchanged; patch only.

principles-disciple: import paths follow the rename; the bundled plugin ships the same behavior.

create-principles-disciple: bundles the plugin, so it follows the same version pass.
