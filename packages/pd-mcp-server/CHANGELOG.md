# @principles/pd-mcp-server

## 0.3.3

### Patch Changes

- Updated dependencies [ddbd1cf]
  - @principles/core@7.0.0

## 0.3.2

### Patch Changes

- Updated dependencies [8da2cdc]
- Updated dependencies [30ccf33]
  - @principles/core@6.0.0

## 0.3.1

### Patch Changes

- d36724c: core: the `runtime-v2` generation name is gone from the code surface (PRI-1136). The directory `src/runtime-v2/` is now `src/runtime/`, the `@principles/core/runtime-v2` subpath (and its 17 sub-subpaths) is now `@principles/core/runtime`, and the TypeScript identifiers that spelled the generation were renamed (`RUNTIME_V2_PRINCIPLE_BUDGET` → `RUNTIME_PRINCIPLE_BUDGET`, `RuntimeV2SchemaVersionSchema` → `RuntimeSchemaVersionSchema`, `recordRuntimeV2ActivationsInjected` → `recordRuntimeActivationsInjected`, …).
  
  This is a **breaking** subpath change for any package that imports `@principles/core/runtime-v2`: the old specifier no longer resolves. Every in-repo consumer moves in the same commit; the OpenClaw plugin bundles core through esbuild, so installed plugin builds are unaffected.
  
  Frozen wire values did **not** change: `runtime_v2_prompt_activations_injected`, `source: 'pd-runtime-v2'`, `pd-runtime-v2-diagnosis` and the other §4 literals keep their exact bytes. The prompt header `Runtime V2 activated principles:` is also unchanged — the golden characterization tests still pass byte-for-byte.
  
  host-runtime: import paths follow the rename; no behavior change. The exported constant `RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS` was renamed to `RUNTIME_EVENT_LOG_CANDIDATE_DIRS`, but the old name stays as a `@deprecated` alias of the same frozen array so `^2.2.0` consumers do not break on a patch release.
  
  pd-cli / pd-mcp-server / codex-adapter / workbuddy-adapter: their compiled output imports the core subpath, so they must be republished in the same version pass — otherwise an installed copy keeps resolving the removed `@principles/core/runtime-v2` specifier. Package-level public API is unchanged; patch only. **Observable CLI contract:** `pd demo story-a --json` adds the generation-neutral `isRuntimeExclusive` field and retains `isRuntimeV2Exclusive` as a deprecated compatibility alias for existing consumers.
  
  principles-disciple: the two shipped payload scripts accept both core subpath generations (`@principles/core/runtime` for Core 5.x, `@principles/core/runtime-v2` for the currently pinned Core 4.1.0), so the plugin keeps working before and after the pin move. Payload changed, so the host cache version is bumped.
  
  create-principles-disciple: bundles the plugin, so it follows the same version pass.
- Updated dependencies [d36724c]
  - @principles/core@5.0.0

## 0.3.0

### Minor Changes

- a710e8a: PD MCP now writes durable, sanitized JSONL evidence by default to `~/.pd/logs/mcp`
  (one file per process, 2 MiB/file, 64 MiB/directory, 14 days). Set `PD_MCP_LOG=0`
  to disable it with zero writes.
  
  Events: `launcher_start`, `startup`, `initialize`, `tools_list`, `tool_call`,
  `shutdown` and `startup_failure` (a pre-handshake exit now leaves PD-side
  evidence). Logging failures are swallowed: tool results, stdout protocol purity,
  the 32 KiB budget and the 10 s deadline are unchanged.
  
  New export command: `pd mcp logs export [--days 7] [--out <zip|dir>]` bundles the
  recent logs plus a README/manifest into one zip ≤20 MiB for offline analysis.

### Patch Changes

- Updated dependencies [2a7aec5]
- Updated dependencies [efae469]
- Updated dependencies [c1e7e1f]
- Updated dependencies [1c1b91f]
  - @principles/core@4.0.1

## 0.2.2

### Patch Changes

- Updated dependencies [46cbdab]
  - @principles/core@4.0.0

## 0.2.1

### Patch Changes

- Updated dependencies [dc1addd]
  - @principles/core@3.0.0

## 0.2.0

### Minor Changes

- f8a2ce7: Gate 4-B: add the production PD MCP Server package (SPEC-PD-MCP-GATE4-001 v1.2, PRI-1071).
  
  - One shared MCP server implementation for the Codex / OpenClaw / WorkBuddy host plugins; each host spawns its own process around this module.
  - Single read-only tool `pd_recall_principle_pains` with an honest `readOnlyHint: true`; business data flows exclusively through the Gate 3 Capability public subpath `@principles/core/runtime-v2/pain-recall-capability` (OD-A v1 disclosure).
  - Strict input contract at the protocol layer (principleId 1..200 required, limit 1..10 default 3, every other property rejected); capability re-validates field-by-field.
  - Single text content block, no structuredContent; 32 KiB UTF-8 response budget (32768 passes, 32769 → `unavailable` + `response_budget_exceeded`, isError, never silently truncated); 10 s deadline with late-result suppression, bounded orphan tracking and verified resource release (no underlying-cancellation claim).
  - isError mapping per SPEC §4.8 (disclosure assertion failure and Adapter execution failures only); sanitized stderr-only JSON logging; stdout carries MCP protocol messages only; fail-closed startup workspace binding via `PD_MCP_WORKSPACE_DIR` (no cwd/HOME fallback), exit 1 before initialize when the binding is invalid.
  - SDK frozen to `@modelcontextprotocol/server@2.4.0` (exact pin; interop matrix with v1-family host clients 4/4); architecture guard tests pin: Core has no MCP SDK dependency, capability-subpath-only business access, no CLI subprocess queries, pd-cli independence, exact version pins.

### Patch Changes

- d825694: Gate 4 (PRI-1071) third remediation round — context isolation, real rollback acceptance, and registration-conflict safety:
  
  - OpenClaw: the host-wide `mcp-binding.json` is written only from an explicitly declared PD workspace (`PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `principles-disciple.json`). Without one, the stale binding is removed and `pd-recall` fails closed (`binding_missing`) instead of binding the `main` agent's workspace for every agent. Per-agent hooks keep their existing workspace resolution.
  - WorkBuddy installer: unchanged transaction semantics, now proven by a real fault injection — a read-only `installed_plugins.json` fails the registration commit after the cache swap, and the previous cache/binding/settings/registry are restored byte-for-byte, after which the real launcher still completes initialize / tools/list / tools/call.
  - All three hosts: a same-name MCP registration owned by another server stops the install/setup BEFORE any config, binding, or cache write; a PD-owned same-name entry is reused idempotently; different names coexist; malformed or unattributable configs fail closed. `pd health` reports `CONFIG_DRIFT` with `mcp_same_name_conflict` / `mcp_registration_unverifiable`.
  - `pd-mcp-server` startup logs a workspace fingerprint (SHA-256 prefix, never the path) so operators and acceptance runs can prove which workspace a process bound.
