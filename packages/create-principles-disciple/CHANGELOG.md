# create-principles-disciple

## 1.148.9

### Patch Changes

- ddbd1cf: # PRI-1146: Diagnostician Output V2 Only — 唯一生产契约切换与 V1 彻底退役
  
  Owner 决策（2026-11-06）：Diagnostician Output 采用 V2 Only / Clean Break。
  
  ## @principles/core (major)
  
  - `DiagnosticianOutputV1` / `DiagnosticianOutputV1Schema` / `DiagnosticianRecommendation` 删除；唯一契约为 `DiagnosticianOutputV2Schema` / `DiagnosticianOutputV2` / `DiagnosticianRecommendationV2`（含 `recommendationRef` 与 rule 专属 `principleAssociation`，根对象封闭）。
  - Registry：`diagnostician-output` → V2 Schema；`diagnostician-output-v1` 不再解析（fail-loud）；其他 Stage 的 alias 不受影响。
  - 新增可信上下文证据（SPEC v0.6 §5）：`trustedContextReceipt` 升级 `router-context-v2`（canonicalPrinciples available/unavailable、证据引用、逐条 sha256 摘要、重启可复验）；`RouterTrustedPrincipleSource` 端口与 `PrincipleTreeLedgerAdapter.readTrustedPrinciples()`。
  - Default Validator 增加 ASSC-1..4（recommendationRef 唯一、目标存在且为 principle、evidenceRefs 可追溯、非 rule 不得携带关联），并以 `invalidAreas` 区分 Schema/Association 失效。
  - Committer 仅接受 V2，并增加 recommendationRef 唯一写边界守卫。
  - 身份类型新增 `source_declared_relation` basis（仅只读 shadow，OD-01/02/03 未批不授权生成）；新增 `resolveSourceDeclaredRelations` 只读解析器。
  - PainSignalBridge 三处读取切换 V2；历史重放跳过改为结构化 telemetry（rc-9）。
  
  ## @principles/pd-cli (major)
  
  - diagnose/pain-retry 构造注入 trustedPrincipleSource；诊断输出契约随 core 升级为 V2 Only（CLI 输出与落库工件均为 V2）。
  - synthetic baseline / flood simulation fixtures 输出 V2。
  
  ## @principles/host-runtime (minor)
  
  - 遥测 allowlist 新增 `diag_router_trusted_context_unavailable` 与 `replay_review_source_invalid`（P1-01 / rc-9）：ledger 不可证明时 canonical association 保持 unresolved 的原因、以及 replay review skip 的唯一持久记录。
  
  ## create-principles-disciple (patch)
  
  - 随包发布的 pd-console 展示文案与 e2e seed 同步 V2 契约（agent-metadata 输出说明、e2e-seed 诊断字面量）。
  
  Breaking：V1 诊断输出、V1 registry ref 与 V1 兼容读取路径全部移除；本机旧 V1 数据按 Owner 授权清理重置，不提供迁移。

## 1.148.8

### Patch Changes

- 87a6af5: chore(release): re-materialize the npm installer channel for product version 2.8.6
  
  The product version bump (`#2470`, root manifest 2.8.5 → 2.8.6) landed after the
  previous Version Packages cohort was merged, so the published installer
  manifest's `gitHead` still resolves to a commit whose root manifest says 2.8.5.
  The signed channel's PRI-1103 guard builds assets from that cohort and refuses a
  product version the npm channel does not pin, which would leave 2.8.6
  undeliverable to installed runtimes. This patch re-publishes the installer from
  the post-bump commit so `product_version=auto` (2.8.6) resolves against a
  published cohort.
  
  No runtime behavior changes; only the installer's diagnostic version moves.

## 1.148.7

### Patch Changes

- dfa6736: fix(rulehost): surface ACTIVE activations whose `pi_artifacts` row is missing
  
  Both the host-runtime production gate and the OpenClaw `RuleHost` load candidates with `JOIN pi_artifacts`, so an armed activation whose artifact row was deleted vanished from the candidate set and enforcement degraded to `no_rules_armed` with no warning, marker or log (PRI-1044: 8+ hours of silent non-enforcement). The two load paths now detect the dangling reference and emit a structured `activation_artifact_missing` warning with a nextAction plus the existing `~/.pd/enforcement-health/` degraded marker. Decisions are unchanged (still fail-open, the orphaned rule does not run) and healthy sibling rules keep enforcing.
  
  RuleHost review follow-up: log suppression is keyed on the dangling descriptor set instead of a one-shot latch, so the marker keeps refreshing `occurrences`/`lastSeenAt` while the gap persists and a later recurrence warns again.
- dfa6736: fix(rulehost): resolve native Codex `apply_patch` targets so managed writes are actually armed
  
  A real `codex exec` session sends the patch body under `tool_input.command`
  (`{"command":"*** Begin Patch ... *** End Patch"}`), but the Codex rule-context
  provider only read `params.patch` / `params.input`. Target resolution therefore
  returned `undefined`, `targetPaths` stayed empty, the `design_approval` fact
  degraded to `unknown`, no live candidate was produced and every managed file
  write bypassed PD as `no_rules_armed` (`Bash` writes were still gated, which hid
  the gap). `patchTargets` now accepts the `command` carrier as well; the three
  carriers share the same `*** <op> File:` headers, so no header parsing changed.
  
  Verified on a real Codex host with `gpt-5.6-luna`: the same payload is blocked
  (`decision=block`, file not created) while the declaration is `not_approved`,
  and allowed (`decision=allow`, file written) once it is `approved`.
  Regression: `packages/host-runtime/tests/production-design-gate-pretool.test.ts`
  ("blocks a native Codex apply_patch payload whose patch body is under
  tool_input.command").

## 1.148.6

### Patch Changes

- 0c2d610: Refresh already-installed sibling host bindings when the shared runtime is replaced. `install()`/update previously ran only the target host's installers, so a default `--host openclaw` update replaced `~/.pd/runtime` (new MCP server) while WorkBuddy's marketplace and engine-cache `mcp-binding.json` stayed pinned to the previous version; WorkBuddy's launcher then failed closed with `binding_version_mismatch:0.2.1!=0.3.2`. OpenClaw self-heals at plugin registration (`ensureMcpBinding`), WorkBuddy has no such runtime path. The install transaction now snapshots the hosts already recorded in `~/.pd/install.json`, and before writing the manifest re-runs each uncovered host's own host installer (best-effort: failures are logged with reason + next action and never roll back a successful host). Codex's binding is unchanged by design: it is generated only by the manual `$pd-control setup` step after a plugin payload update.

## 1.148.5

### Patch Changes

- 698de3f: feat(principles-core): PRI-1161 hoist the per-block directive boilerplate into the shared header
  
  The shared directive renderer (`renderPrinciplesToDirectives`) no longer repeats "Apply this as an active behavior constraint. Do not treat this as background context." inside every directive block; the instruction is stated once in the shared header ("These directives are mandatory active behavior constraints for this session, not background context, unless they conflict with safety, security, or higher-priority system policy."). Per-principle body, directive id, authority attribute, escaping and the `<directive>` slice boundaries are unchanged; budget arithmetic stays exact because `measureSharedDirectiveBlockChars` / `sharedDirectiveBaseChars` derive from the same builders (header +53, each block −86). Selection/refill changes under tight budgets are explained by the unchanged packing rule. Goldens and tuned fixtures updated to the new renderer bytes.

## 1.148.4

### Patch Changes

- 6b5a4cc: Adaptive Activation config compat: declare the `principleId` mapping identity in the plugin manifest `configSchema` (`adaptiveActivation.properties`, `additionalProperties: false` retained). The #2436 runtime reader already accepted this key, but the undeclared key made any principleId config fail the host's load-time plugin-config validation and take down the entire plugin (PRI-1119 PR #2448 blocker 2). Legacy pinned `(artifactId, activationId)` configs are unaffected: identical keywords, identity arbitration stays at the runtime reader (mixed/partial/blank-identity configs keep failing closed to Native at runtime, not at load). The installer bundles the plugin, so it ships the corrected manifest in the same release.

## 1.148.3

### Patch Changes

- 73c5ea7: Dependency bump: tuf-js from 6.0.1 to 6.0.2 (installer runtime dependency, shipped inside create-principles-disciple).

## 1.148.2

### Patch Changes

- 517e338: feat(openclaw-plugin,host-runtime): revision-resilient adaptive delivery mapping via current principle identity (PRI-1140)
  
  The `adaptiveActivation` mapping may now name a `principleId` instead of a pinned `(artifactId, activationId)`. On a delivery-signal round the provider resolves it to the at-most-one currently authorized prompt activation (`resolveCurrentAuthorizedActivationByPrincipleId`, read-only), so an Owner prompt revision no longer silently kills the intervention until the plugin config is edited by hand. The principle path packs additively (`additiveOnly`): it never squeezes out content the native assembly already holds — such a placement keeps the native assembly and records `would_displace_native_assembly`. The pinned mapping and the controlled-admission path are unchanged; a config without `principleId` behaves byte-identically.

## 1.148.1

### Patch Changes

- 498016c: Write the post-assembly presence observation to the event log when it is recorded, so a one-shot host that exits on its own no longer loses it (PRI-1152).

## 1.148.0

### Minor Changes

- 8da2cdc: refactor(core,host-runtime,pd-console): PRI-1139 B-class canonical contract write-side cutover (PRI-1104 PR-6)
  
  - **core (major)**: the output-schema registry keys become version-neutral
    canonical keys (13 refs drop their `-v1/-v2` suffix); the pre-cutover
    spellings still resolve through the PRI-1104 alias table. The public
    barrel loses the retired zero-consumer helpers `schemaRef()`,
    `RUNTIME_SCHEMA_VERSION`, `SchemaVersionRefSchema` and
    `RuntimeSchemaVersionSchema`, replaced by the single
    `RUNTIME_CONTRACT_SCHEMA_VERSION = 'current'` token (plus the legacy
    `'1'` token and a dual-read union schema). Governance/approval/owner-
    decision contracts now accept both `'current'` and legacy `'1'`
    schemaVersion values; the approval review guard accepts both
    `approval-review` and legacy `approval-review-v1`.
  - **host-runtime (minor)**: the prompt budget policy id switches from
    `model_aware_v2` to `model_aware` (formula unchanged; both event
    spellings remain readable and revert-safe); the Stage-2 classifier
    requests the canonical `signal-classification-output` ref.
  - **principles-disciple / create-principles-disciple (minor)**: the
    console client calls canonical `/api` paths (server keeps the
    deprecated `/api/v1` alias — external integrations unaffected);
    TrajectoryDatabase no longer reads the schema_version epoch (single
    DDL-owner writer only).

### Patch Changes

- 30ccf33: Write the post-assembly presence observation to the event log when it is recorded, so a one-shot host that exits on its own no longer loses it (PRI-1152).
- 30ccf33: Classify `hook:llm_input_presence` as a default-on core surface. The PRI-1150 presence observation was registered through `guardHook` without a registry entry, so the guard installed a no-op and the observation never ran (PRI-1152 B2). Workspace resolution, the session-access requirement, the fact-only event shape and every resource bound are unchanged.

## 1.147.19

### Patch Changes

- 251f762: Close the WorkBuddy install-transaction gap: a failure in any post-registration stage (governance workspace init, LLM runtime profile, install manifest, governance flags) used to leave the just-completed plugin registration in place against a governance state that never materialized. The install now snapshots every PD-owned mutation target (settings.json, installed_plugins.json, the incoming cache version dir, ~/.pd/install.json, the governance config) BEFORE the first host mutation and restores them in reverse order under hash guards — files changed concurrently after PD wrote them are never clobbered and the failure reports ROLLBACK_INCOMPLETE with the preserved evidence path instead of a claimed restore. First installs remove this attempt's registration/cache; upgrades restore the previous payload byte-identically (verified by digest). The governance workspace directory is never auto-deleted: a fresh workspace from a failed attempt is preserved and reported. Successful installs discard the transaction evidence copy.
  
  Safe-upgrade hardening (2026-11-08): an upgrade whose pre-upgrade cache backup cannot be created or whose backup content does not digest-match the payload it copied is REFUSED before any cache replacement (the previous version stays installed and usable). The rollback never deletes the current cache before its replacement material is proven: the backup must exist and digest-match, the restore is staged and verified in an isolated temp dir, the swap runs as renames with no absent-cache window, and a missing/corrupted backup refuses the destructive step while preserving the current payload and reporting ROLLBACK_INCOMPLETE.
  
  Owner-review remediation (2026-11-08): snapshots are now raw byte `Buffer`s compared byte-for-byte and restored byte-for-byte, so host files containing invalid UTF-8 survive a rollback unchanged. A file that no longer matches the exact bytes PD wrote is never overwritten; its original snapshot is persisted to a recovery directory with a manifest containing the original path, snapshot file and SHA-256 so an operator can verify the evidence. New PD-created files are moved aside and re-verified before deletion, and both upgrade and fresh-install cache removals re-hash the moved payload before discarding anything. A committed `rename` followed by a failed temp-directory cleanup is now reported as a real write (`AtomicReplaceCleanupError`) and registered in the transaction, so install.json / governance config changes are actually compensated. Governance-workspace initialization writes and every config write are tracked; an engine registration that already committed before a later stage now runs protected compensation. The error report distinguishes complete from partial rollback and states whether the cache backup is verified, missing, corrupt or unreadable, with concrete recovery paths and next actions. The read-then-rename guard is explicitly documented as best-effort, not an atomic CAS: a non-cooperating write inside the final OS-level window cannot be eliminated and must be reconciled manually from the preserved evidence. The regression suite now uses isolated fixtures and deterministic write/copy/rename fault injection (no OS permission tricks) and asserts the real filesystem state across 21 scenarios.

## 1.147.18

### Patch Changes

- 20719c6: Fix the `--host all` / Codex install contract: `CodexHostInstaller.install` now reports the Codex end state honestly (Marketplace already installed / manual Marketplace step required / state unverifiable) via the new optional `HostInstallResult.manualActionRequired` flag instead of returning a plain failure, so a pending Codex Marketplace install no longer aborts the whole install transaction — an already-successful OpenClaw install stays intact and the shared runtime is not rolled back. The aggregate result is an explicit partial completion (`success=false`, `manualActions[]` in the `--json` output, non-zero exit, per-host MANUAL ACTION REQUIRED text); a re-run after the manual `codex plugin add principles-disciple@principles` converges idempotently. `--host all` still never includes WorkBuddy.
- bbdcb50: Separate the four independent WorkBuddy host facts in `pd health --host workbuddy` — plugin registration (registry), plugin enablement (settings enabledPlugins), governance flag state (ENABLED / EXPLICITLY_DISABLED / DEFAULT_OFF / UNKNOWN, an explicit Owner opt-out is never folded into a generic OFF), and an explicit runtime boundary (RUNTIME_PROBE_NOT_PERFORMED + MODEL_TOOL_CALL_NOT_VERIFIED; pd health stays read-only, never starts the host or the MCP server). The registration/enablement judgment and the host config paths move to @principles/install-layout as the single authority (getWorkbuddyHostConfigPaths / interpretWorkbuddyPluginState) — installer, `status` and `pd health` now resolve the same paths and apply the same rules; the installer delegates instead of owning a second judgment. A complete MCP payload implies nothing about registration or enablement. Verified: a WorkBuddy-only machine reports INSTALLED at the top level (negative control included).
- Updated dependencies [bbdcb50]
  - @principles/install-layout@0.5.0

## 1.147.17

### Patch Changes

- f7cdc5a: feat(openclaw-plugin,host-runtime): PD-self assembly presence observation via official llm_input (PRI-1150, Path A)
  
  - host-runtime: `buildActivePrinciplePromptContext` freezes per-principle
    presence expectations same-source with `additionalContext` (bounded at 64,
    overflow fact, bodyComplete containment); PD-internal contract. Core gains
    the `PromptPresenceObservedEventData` event contract (union + schema).
  - openclaw-plugin: bounded in-memory assembly snapshot registry keyed by
    runId+sessionId (global key/snapshot/body-byte caps + TTL, sticky history
    loss), minimal single-string containment checker (three-value outcomes),
    official llm_input registration, and a PD-owned forensic event
    `runtime_v2_prompt_presence_observed` (boundary
    post_assembly_system_prompt_via_llm_input; containment facts only, no body
    text; unique binding requires complete candidate history, everything else
    degrades to unknown:ambiguous_binding / history_incomplete / expired).
  - Not dependent on hook-result fields the official host drops. Fact-only: no
    D/confirmed/timely, no delivery/adherence claims. Existing llm_output
    behavior unchanged.

## 1.147.16

### Patch Changes

- 97a50b9: feat(openclaw-plugin): freeze prompt presence expectations in before_prompt_build (PRI-1119)
  
  The hook now returns `injectedExpectations` — the per-activation frozen body
  texts (post size guard) injected into `prependSystemContext`, with
  `bodyComplete` marking truncated fragments. Memory-only; consumed by the host
  wire checkpoint (prompt presence check). Requires the host-side carrier support
  (openclaw ai/prompt-presence-check branch) to take effect; older hosts ignore
  the field.

## 1.147.15

### Patch Changes

- 6278ec3: core: `abstraction_layer_v1` is retired to a `gone` tombstone (PRI-1137). The flag ID stays in the contract, but a stale `enabled: true` in user config can no longer re-enable the legacy prompt route — it yields the existing "cannot be re-enabled" warning instead. No config migration is shipped and user `.pd/config.yaml` is never rewritten.
  
  host-runtime: **major** — the published barrel (`export *`) removes public API: `shouldUseSharedHostRuntime`-era helpers are gone from the plugin surface and the rotation signal changed shape (`productionRotates: boolean` → `productionRotation: 'rotates' | 'does_not_rotate' | 'unknown'`, `productionRouteRotates()` → `productionRouteRotationState()` / `hostRotationCapability()`), because a boolean could not express "no single host is bound" without lying that every host is FIFO. OpenClaw gains a single shared prompt route with an optional `roundKeyProvider` (PRI-1137); only OpenClaw injects a real session-turn ordinal and Codex/WorkBuddy remain FIFO without round authority. A round key is issued ONLY for a persisted user turn of this invocation (heartbeat/empty-message/resolution-failure/write-failure all degrade to `legacy_fifo_prefix_v1` observably); run retries replay their own persisted ordinal. The shared packer decides by exact additive arithmetic over per-block measurements (one render per pack instead of O(N²)) — output byte-identical. `checkPromptArtifactDeliverability` accepts an `authority` override (approve-time prechecks bill the `owner` annotation they stamp) and refuses `unconfirmed` when the authority join read breaks.
  
  pd-cli: `prompt-capacity-measurement.mjs` measures the same single production route; the per-budget oversized statistic now covers the whole corpus (FIFO's early stop hid later oversized candidates).
  
  principles-disciple: **major** — the plugin's public module surface removes the deleted route-gate exports (`shouldUseSharedHostRuntime`, `runtimeGateCache`, `runtimeGateFor`). The three prompt hooks no longer branch between plugin-local and shared rendering; every standard host goes through the shared runtime. Signal collection, adaptive activation, controlled admission, manual owner pain, prompt enrichment, receipts and delivery evidence are retained. Frozen wire literals (`legacy_fifo_prefix_v1`, `fair_rotation_v1`, `runtime_v2_prompt_activations_injected`, …) are unchanged. The after_tool_call adapter now forwards `toolArgs` (the SDK's after-event field) to the shared evidence kernel and surfaces its degradation (`trajectory_db_not_found` etc.) in logs and hook-execution records instead of recording a blind success.
  
  create-principles-disciple: bundles the plugin, so it follows the same version pass.

## 1.147.14

### Patch Changes

- d36724c: core: the `runtime-v2` generation name is gone from the code surface (PRI-1136). The directory `src/runtime-v2/` is now `src/runtime/`, the `@principles/core/runtime-v2` subpath (and its 17 sub-subpaths) is now `@principles/core/runtime`, and the TypeScript identifiers that spelled the generation were renamed (`RUNTIME_V2_PRINCIPLE_BUDGET` → `RUNTIME_PRINCIPLE_BUDGET`, `RuntimeV2SchemaVersionSchema` → `RuntimeSchemaVersionSchema`, `recordRuntimeV2ActivationsInjected` → `recordRuntimeActivationsInjected`, …).
  
  This is a **breaking** subpath change for any package that imports `@principles/core/runtime-v2`: the old specifier no longer resolves. Every in-repo consumer moves in the same commit; the OpenClaw plugin bundles core through esbuild, so installed plugin builds are unaffected.
  
  Frozen wire values did **not** change: `runtime_v2_prompt_activations_injected`, `source: 'pd-runtime-v2'`, `pd-runtime-v2-diagnosis` and the other §4 literals keep their exact bytes. The prompt header `Runtime V2 activated principles:` is also unchanged — the golden characterization tests still pass byte-for-byte.
  
  host-runtime: import paths follow the rename; no behavior change. The exported constant `RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS` was renamed to `RUNTIME_EVENT_LOG_CANDIDATE_DIRS`, but the old name stays as a `@deprecated` alias of the same frozen array so `^2.2.0` consumers do not break on a patch release.
  
  pd-cli / pd-mcp-server / codex-adapter / workbuddy-adapter: their compiled output imports the core subpath, so they must be republished in the same version pass — otherwise an installed copy keeps resolving the removed `@principles/core/runtime-v2` specifier. Package-level public API is unchanged; patch only. **Observable CLI contract:** `pd demo story-a --json` adds the generation-neutral `isRuntimeExclusive` field and retains `isRuntimeV2Exclusive` as a deprecated compatibility alias for existing consumers.
  
  principles-disciple: the two shipped payload scripts accept both core subpath generations (`@principles/core/runtime` for Core 5.x, `@principles/core/runtime-v2` for the currently pinned Core 4.1.0), so the plugin keeps working before and after the pin move. Payload changed, so the host cache version is bumped.
  
  create-principles-disciple: bundles the plugin, so it follows the same version pass.

## 1.147.13

### Patch Changes

- 0508343: Add a default-off controlled-admission path for adaptive principle prompts.
  
  When no operator admission is configured the runtime behaves exactly as before. When an admission document is supplied through `PD_AA_ADMISSION_FILE`, a single request may be admitted: the shared `adaptivePriorityProvider` entry claims the admission and hands it to `before_prompt_build` for the same request, replay attempts are rejected, and `consumedAt`/`consumedBy` are written atomically under an exclusive lock. `@principles/core` additionally exports `validateControlledAdmissionBinding` and `canonicalAdaptiveMappingSha256` for the host adapters that bind an admission to a request.

## 1.147.12

### Patch Changes

- a902255: core: add `TRAJECTORY_REQUIRED_COLUMNS` and `convergeTrajectorySchemaVersion` — one declaration of the columns trajectory.db must carry and one writer of its `schema_version` row (PRI-1135). Both are module-level exports of `runtime-v2/trajectory-schema`; the runtime-v2 barrel surface is unchanged.
  
  host-runtime: drop the duplicate hand-maintained column list and import the core constant instead. Because host-runtime now names an export that this core release introduces, both packages must ship in the same version pass — a host-runtime-only release would resolve `@principles/core@4.1.x` and fail at module link time.
  
  principles-disciple: the bundled OpenClaw plugin's trajectory lifecycle now delegates the `schema_version` row to core instead of writing it inline; no user-visible behavior change.
  
  create-principles-disciple: the installer bundles the plugin, so it follows the principles-disciple patch above (same version pass).

## 1.147.11

### Patch Changes

- fbe9d79: PRI-1110 follow-up (P2): the executing-manifest walk now keeps the real read
  failure (for example `manifest_too_large`) instead of letting a shallower
  directory without a `package.json` replace it with `manifest_ENOENT`. Evidence
  notes therefore name the actual reason the plugin version is `unknown`. The
  bounded-read and module-load-binding tests now assert the exact byte count,
  degradation result and reason code.

## 1.147.10

### Patch Changes

- 440aa63: PRI-1110: AA invocation journal now records the minimal effective configuration
  identity for each invocation (host, runtime mode, executing plugin version,
  confirmed hook-set fingerprint, evidence coverage). Fields the running host
  cannot prove stay `unknown`; one frozen snapshot is taken when the invocation
  opens and is reused by its terminal record, so a mid-invocation environment
  change cannot rewrite already-recorded evidence.

## 1.147.9

### Patch Changes

- 485894e: Connect bounded Adaptive Activation to OpenClaw prompt builds with explicit
  core exports, final authorization checks, invocation journals and safe Native
  fallbacks. Keep independent AA lab tools outside the historical EXM v4 module
  scan; preserve the original frozen assets and Owner review provenance.
- c3ef84b: `status` now reports the real WorkBuddy host state instead of only the static path checklist. It reads the three independent sources (installed_plugins.json registration, settings.json enabledPlugins, and the governance config's `host.workbuddy` / `workbuddy_live_keyword_pain` flags) and renders them through the same authority the install summary uses. An unreadable source prints UNKNOWN/UNREADABLE rather than a guessed value, and the status path never writes.

## 1.147.8

### Patch Changes

- a710e8a: PD MCP now writes durable, sanitized JSONL evidence by default to `~/.pd/logs/mcp`
  (one file per process, 2 MiB/file, 64 MiB/directory, 14 days). Set `PD_MCP_LOG=0`
  to disable it with zero writes.
  
  Events: `launcher_start`, `startup`, `initialize`, `tools_list`, `tool_call`,
  `shutdown` and `startup_failure` (a pre-handshake exit now leaves PD-side
  evidence). Logging failures are swallowed: tool results, stdout protocol purity,
  the 32 KiB budget and the 10 s deadline are unchanged.
  
  New export command: `pd mcp logs export [--days 7] [--out <zip|dir>]` bundles the
  recent logs plus a README/manifest into one zip ≤20 MiB for offline analysis.
- 1132c11: PRI-1129: release payloads now ship `plugin/mcp/launcher.cjs` — the entry `openclaw.plugin.json` declares — and the build fails closed when a declared MCP entry is missing; `release-asset-smoke` asserts the extracted payload still contains it.
  
  The installer now also guarantees the other half of the same user-visible path: OpenClaw sanitizes the MCP child's environment (`PD_WORKSPACE_DIR` / `HOME` are stripped), so `pd-recall` can only locate the governance workspace through `~/.openclaw/principles-disciple.json`. The installer writes that PD-owned declaration on first install, leaves a compatible one byte-identical (idempotent), and refuses before any runtime mutation when an existing declaration names a different workspace or cannot be trusted (no silent overwrite, no cross-workspace recall).
  
  Correction to the earlier diagnosis: OpenClaw 2026.10.10 DOES materialize plugin-manifest `mcpServers`; it loads them lazily on the first agent turn. The real blockers were the missing payload entry and the unreachable workspace declaration.
- efae469: PRI-1130: `pd health` now verifies that every file entry declared by the installed plugin payload actually exists — across OpenClaw/Codex/WorkBuddy manifests, `.mcp.json` and `hooks/hooks.json` (including the legal `hooks` field form that points to a custom hooks JSON file) — and reports `declared_entry_missing` with the concrete missing paths instead of trusting the declaration. Any non-neutral MCP status (`CONFIG_MISSING`, `CONFIG_DRIFT`, `VERSION_MISMATCH`, `RESTART_REQUIRED`, `HOST_RUNTIME_NOT_VERIFIED`) now exits non-zero, so exit-code-only automation can no longer treat a broken host install as healthy; `HOST_NOT_FOUND` and `NOT_INSTALLED` stay exit-code neutral.
  
  The WorkBuddy installer no longer enables the plugin on install: `enabledPlugins[key]` follows the manifest's declared `defaultEnabled` (PD declares `false`), an existing explicit Owner `true`/`false` always survives upgrade/reinstall/Repair, and the installer never overwrites the Owner's choice.
  
  The install summary now presents the THREE independent post-install facts separately, sourced from the host itself: registration (`installed_plugins.json`), host enablement (`settings.json` → `enabledPlugins`) and governance (`host.workbuddy`). `HostInstallResult.pluginState` carries those raw facts; the summary prints e.g. `WorkBuddy plugin … INSTALLED / DISABLED` alongside `WorkBuddy governance … ON` and states that hooks stay inactive and `PD记录痛苦：` is not delivered until the Owner enables the plugin. An unreadable registry is reported as `REGISTRY UNREADABLE / NOT VERIFIED` (never `INSTALLED`), and a failed install prints no success lines at all.
- 1c1b91f: WorkBuddy: automatic Pain detection/correction is unsupported (the ingress evidence gate has no persisted observation writer, so automatic candidates never become Pain rows). The installer no longer enables `workbuddy_live_keyword_pain`, and install/status/docs copy now points to the explicit `PD记录痛苦：` prefix only.

## 1.147.7

### Patch Changes

- f3f5250: PRI-1102: the installer now verifies the restored runtime component tree (Console server + Console web entry, pd-cli entry, plugin bundle, OpenClaw plugin entries) instead of only the runtime root, and reports an honest "NOT usable — incomplete" rollback state naming the missing components. A dangling plugin link is removed only when the missing target is confirmed (ENOENT/ENOTDIR); any other filesystem error fails closed and preserves the link.

## 1.147.6

### Patch Changes

- 46cbdab: Remove the Global Friction Index (GFI) mechanism end to end (SPEC `GFI_COMPLETE_REMOVAL_SPEC`).
  
  - BREAKING: friction scoring, mental mode / fatigue state, `GFI_SLICE_RESET` and the `tool_calls.gfi_before` / `gfi_after` columns are gone. `trajectory.db` is migrated when PD opens it: the two legacy columns are dropped and pending empathy confirmations are closed as `abandoned` / `gfi_removal`. A database whose legacy columns cannot be dropped now fails loudly (`trajectory_migration_failed:<reason>`) instead of being silently treated as canonical.
  - BREAKING: Rule Host input no longer carries `session.currentGfi`; `evolution.epTier` and `derived.bashRisk` enrichment are unchanged.
  - Owner-visible GFI surfaces are removed: `/pd-status reset`, `pd runtime health gfi`, the Console GFI health check and GFI status rows. Existing workspaces keep working after the automatic schema migration.

## 1.147.5

### Patch Changes

- 6e7b9d9: 安装器自愈脏环境：目标目录是悬空链接（上一次安装中断残留）时，不再以 ENOENT 中止安装。现在先判定目标形态——缺失则创建、悬空链接只删除链接本身后重建、真实目录与可解析链接原样保留——再执行写入。回滚文案也改为点名恢复状态中缺失/失效的路径，而不是声称「已恢复到之前的安装」。
- 0094f08: Console update check: stop surfacing a "version divergence" between the active release product version and the plugin-directory package version. They are independent version planes (`RELEASE_PROCESS.md`, "The three version planes"), so the comparison flagged every healthy installation (product 2.8.0 vs plugin 2.5.0). The check now reports only the signed active-release identity; the plugin copy stays a diagnostic read.

## 1.147.4

### Patch Changes

- 64f2d5c: Security (P1, follow-up of the PR #2319 review): installed sibling dependency
  links no longer accept path-traversal package names. Names are parsed
  structurally (unscoped = exactly one segment, scoped = exactly `@scope/pkg`)
  and `.`, `..`, empty segments, repeated `/` and `\` are rejected before any
  filesystem mutation, so `path.join()` can no longer normalize a name onto
  `node_modules`, the scoped parent or the component root that the physical-copy
  repair pass would recursively delete. Every entry is validated before any
  link is created, replaced or removed, the normalized link path must be a
  strict descendant of the component's real `node_modules`, and a symlinked
  `node_modules`/scoped parent or a sibling resolving outside the runtime
  directory is refused instead of followed. No dependency trimming,
  release-lock, runtime pin or user install directory is touched.

## 1.147.3

### Patch Changes

- b6aad62: G3 §10.5 (SPEC-PD-RELEASE-ARCH-SIMPLIFICATION-001 §10 item 5): the installed
  pd-cli and pd-console sibling dependency links are now materialized through the
  shared `ensureComponentFileDependencyLinks` helper, after the component
  dependency stage. The previous hand-rolled blocks short-circuited on
  `existsSync()`, so an npm-materialized physical copy silently won over the
  intended runtime sibling; the consolidated pass corrects physical copies,
  wrong-target and dangling links, and fails closed when a declared sibling is
  missing. No dependency trimming, release-lock, runtime pin or user install
  directory is touched.

## 1.147.2

### Patch Changes

- dc1addd: **BREAKING CHANGE** — Pain Phase A: Legacy Retirement (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3, Phase A).
  
  A technical tool failure is now trajectory and health evidence only. It can no longer become an Owner behavioral-deviation Pain on its own; the only automatic admission left is Phase B shared correction detection, and explicit Owner manual Pain is unchanged.
  
  Retired automatic Pain entry points:
  
  - OpenClaw legacy `after_tool_call` admission/emit (`handleAfterToolCall` Stage 5/6, `evaluatePainAdmissionForToolCall`, `emitPainIfAdmitted`) and the shared-host `onAfterToolResult` / `handleSharedPainEvidenceResult` path.
  - Shared Production Pain Evidence tool-failure Pain writing and diagnosis admission; the writer now records verified `tool_calls` (outcome, exit code, raw trajectory) only.
  - Codex live/transcript tool-call admission (`buildLiveToolCandidate` and the `tool_call` branch of `buildTranscriptCandidates`).
  - Repeated-failure escalation (`REPEATED_FAILURE_THRESHOLD` / `consecutiveErrors >= 4` upgrade rules). No replacement error-count escalation was introduced; host error counters stay untouched.
  - RuleHost block automatic Pain (`gate-block-helper.ts` Step 5). The block itself, `gate_blocks`, EventLog, blocked-attempt health counting and the Owner correction entry are unchanged.
  - WorkBuddy `admitBareHostPains` sweep, its worker call, its `admission` report field and the bare-pain `painEnrichmentProvider` sourceRef synthesis. WorkBuddy automatic correction stays fail-closed/observation_only; no `pain_event:<canonicalPainId>` synthetic evidence, no PainIngress bypass, no restored compensation.
  
  Removed public exports:
  
  - `@principles/core/runtime-v2`: `RISKY_HIGH_SCORE_THRESHOLD`, `REPEATED_FAILURE_THRESHOLD` (the upgrade rules they gated are gone; descriptor evaluation is terminal).
  - `@principles/host-runtime`: `admitBareHostPains`, `AdmitBareHostPainsInput`, `AdmitBareHostPainsResult`, `GovernanceToolFailureCandidate` (and the tool-failure variant of `GovernanceSignalCandidate`), `PRODUCTION_WRITE_TOOLS`, `PainEvidenceEntry`, `ProductionToolEventFields`, `DerivedToolPainIdentity`, `deriveProductionToolPainIdentity`, `resetProductionPainCooldownForTest`, `productionPainCooldownEntryCountForTest`.
  
  Retained on purpose: Owner manual `/pd-pain` and the explicit Pain tool (`buildManualPainObservation` → `evaluateEvidenceTriage` → `evaluateTriggerController`), `TriggerController`, `admission-gate.ts`, canonical Pain identity, idempotency/cooldown semantics, `correctionEvidence`/lineage, Diagnostician task creation, and the whole Phase C GFI surface (`hooks/llm.ts` health branch, `/pd-pain` GFI line, Console GFI health, `pd runtime gfi`, `tool_calls.gfi_before/gfi_after`, Session Tracker and receipt chain). No new tables, migrations, feature flags, workers or queues; historical `pain_events` rows remain readable.

## 1.147.1

### Patch Changes

- f02aa73: PRI-1066 recalibrates the model-aware prompt injection budget (`model_aware_v1` → `model_aware_v2`): the baseline doubles from 2000 to 4000 chars at the 128K reference window (hard ceiling 16000 → 32000, fallback 2000 → 4000, total ceiling derived per model), so an Owner-approved principle set stops filling the injection slot after a handful of principles. It also adds the `pi_catalog_model_id` tier (a provider-less model id that the installed catalog answers unanimously derives a real window instead of silently using the fixed fallback), records policy-version-skewed events as `foreignPolicyEventsSkipped` instead of dropping them silently, and removes the standing Focus-page "budget full" nag: `truncated` is the normal rotation state, so the notice now appears only when a host cannot fit even one principle and carries an actionable next step.

## 1.147.0

### Minor Changes

- b37c67f: Gate 4-F (PRI-1071): the installer bundles and deploys `@principles/pd-mcp-server` as a runtime sibling component (release-locks, release asset, npm-distributed components and files manifest all carry it). The WorkBuddy host installer writes the MCP launcher binding during marketplace materialization. Payloads older than the component deploy unaffected — the MCP server then fails closed with an honest missing-entry state.

### Patch Changes

- d825694: Gate 4 (PRI-1071) third remediation round — context isolation, real rollback acceptance, and registration-conflict safety:
  
  - OpenClaw: the host-wide `mcp-binding.json` is written only from an explicitly declared PD workspace (`PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `principles-disciple.json`). Without one, the stale binding is removed and `pd-recall` fails closed (`binding_missing`) instead of binding the `main` agent's workspace for every agent. Per-agent hooks keep their existing workspace resolution.
  - WorkBuddy installer: unchanged transaction semantics, now proven by a real fault injection — a read-only `installed_plugins.json` fails the registration commit after the cache swap, and the previous cache/binding/settings/registry are restored byte-for-byte, after which the real launcher still completes initialize / tools/list / tools/call.
  - All three hosts: a same-name MCP registration owned by another server stops the install/setup BEFORE any config, binding, or cache write; a PD-owned same-name entry is reused idempotently; different names coexist; malformed or unattributable configs fail closed. `pd health` reports `CONFIG_DRIFT` with `mcp_same_name_conflict` / `mcp_registration_unverifiable`.
  - `pd-mcp-server` startup logs a workspace fingerprint (SHA-256 prefix, never the path) so operators and acceptance runs can prove which workspace a process bound.
- Updated dependencies [fb70a87]
  - @principles/install-layout@0.4.1

## 1.146.10

### Patch Changes

- 4257de8: Phase B — Shared Correction Detection (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 / v0.3.1).
  
  Behavior contract changes (intentional, per the v0.3 spec):
  
  - Stage 1 (P-1): matched keywords inside paired quotes no longer constitute STRONG; third-person reported and negated contexts — and the downgraded colloquial terms `我说的是` / `都说了` — are Stage-2 candidates only. `他说这是错的` can no longer reach STRONG through the Codex bare-substring path.
  - P-2 (D5 reversal): LLM-learned keywords never earn `high` precision from TP/FP history; they only enter Stage 2. Owner-promoted and seed terms keep the weight-based rule.
  - P-3: a shared confidence gate (`evaluateStage2ConfidenceGate`) distinguishes CORRECTION / NONE / pending; low confidence and LLM errors are never a terminal NONE. Constants: 0.7 / 0.7, MAX_ATTEMPTS=5, TTL=72h.
  - Pending candidates: ambiguous Codex/WorkBuddy Stage-1 candidates are now persisted as `pending_llm_review` rows in the existing `governance_signal_admissions` table (zero DDL) instead of being silently dropped. New terminal decisions `resolved_none` / `abandoned`; `admitOne` returns the pending/terminal semantic instead of an empty `already_admitted` id. CAS claim/complete/settle, idempotent transitions, crash recovery, aggregate 60s / ≤2 candidates per worker cycle.
  - PainIngress: `ensureGovernanceDiagnosticianTask` derives provenance from `evaluatePainIngress` instead of hardcoding `host_context_bound`; `PainIngressCorrelationV1` gains a `workbuddy` variant; the diagnostician context assembler no longer drops `hostKind='workbuddy'`.
  
  Stage-2 classification is now constructed by one shared host-runtime factory (`createSignalClassifierForWorkspace` / `createSignalLlmClassifier`), used by both workers and the OpenClaw plugin; no second model runtime was added. `EARNED_PRECISION_MIN_TP` remains exported as a deprecated compatibility constant (no admission code consults it — D5 removed earned precision without breaking the public root export).

## 1.146.9

### Patch Changes

- bc268a4: Examiner v0.10.1 — Owner-controlled Behavioral Evaluation productization (SPEC-PD-EXAMINER-001 v0.10.1), shipped through the installer's pd-console payload. The single v0.9 page becomes a four-page Owner journey: Principle Evaluation (per-principle production evidence aggregate — runtime activation, prompt-injection projection with budget provenance, receipts, the intervention-evidence audit with an unpromoted confirmation ladder and agent_claimed/runtime_verified split; degraded lanes carry reason + nextAction, never "zero events"), Study Configuration (fixed challenge-suite catalog with the Gate 1 Gold boundary, host readiness requirements, honest experiment-vs-production difference), Execution & Evidence (frozen production snapshot with EXPERIMENT_CONFIGURATION_DIFFERS_FROM_PRODUCTION markers, fail-closed preflight, three run modes) and Evaluation Report (Report V2 ITT/fidelity/replay, limitations, a SEPARATE production-observation lane and the Owner decision handoff into the existing governance workflow — no new decision system). New read-only APIs: GET /examiner/principles/:id/evidence (before the lab gate — workspace facts, not lab facts), GET /examiner/suites, GET /examiner/hosts/openclaw/readiness. Study creation freezes real inputs: suite-selected cases (didactic-pair default / calibration-core six worlds), RUNTIME-derived RuleCode facts (target-scoped — other principles' rulecodes are baseline, a coupled target refuses with INTERVENTION_NOT_IDENTIFIABLE), real pain lineage in the frozen mapping, and production-snapshot.json. Async execution contract (§12.3): host-dry-run / f2-real-host answer 202 + runId with state derived from the study's existing events ledger, one live run per study (409 duplicate/in-flight), restart recovery to ABANDONED/RESULT_UNKNOWN (never auto-retried), zero model calls in dry-run (local OpenClaw CLI version probe via the lab's new read-only probeOpenClawCli), and F2 gated on an APPROVED Stage R authorization bound to the frozen study — accepted-and-bound settles loudly as NOT-ENABLED-THIS-ROUND with zero model calls. Acceptance: 14 route tests + 11 BDD scenarios + 6-scenario real-browser E2E journey (incl. the coupled-target refusal and historical-assets read-only) all green; i18n en/zh at full key parity under terminology governance.

## 1.146.8

### Patch Changes

- 0cea461: G3.2 build deduplication: build-once ledger with artifact identity (cohort+version+dist SHA-256), preamble verify for core/install-layout/host-runtime, Console skip flag with freshness gate. Cross-platform fixes: ERR-045 npm spawn, GNU tar relative paths, sha512sum backslash stripping.

## 1.146.7

### Patch Changes

- 5fa6fc9: **BREAKING CHANGE** — Pain Phase 0 safe cleanup (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 §6/§9, Phase 0). `@principles/core/runtime-v2` is a published subpath of the public npm package `@principles/core` (declared in `packages/principles-core/package.json` `exports`), and the following 13 symbols that were exported from it at baseline `9a2bd5efb` are **removed**. Any external consumer importing them must migrate; import sites inside this monorepo are zero (grep-verified) and none are re-added as deprecated stubs.
  
  Removed public exports:
  
  - Types: `AdmissionDecisionEvent`, `DiagnosisTaskCreatedEvent`, `EvidenceOnlyRecordedEvent`, `SkippedRefusedEvent`, `AdmissionEvent`
  - Functions: `createAdmissionDecisionEvent`, `createDiagnosisTaskCreatedEvent`, `createEvidenceOnlyRecordedEvent`, `createSkippedRefusedEvent`, `serializeAdmissionEvent`, `validateEventPrivacy`
  - Builders: `buildLlmDetectionObservation`, `buildEmpathyObservation`
  
  (All 13 were verified present in the `runtime-v2` barrel at the pre-change baseline; they had zero production consumers across the monorepo and no deprecated aliases are provided.)
  
  Behavioral retirement (same release): error is not Pain — the legacy Semantic Confusion detection execution path (llm.ts DetectionService funnel + detection-service.ts + detection-funnel.ts) and the LLM Paralysis trigger (stuckLoops branch) no longer create Pain events; the shared event-log/trajectory write points are now fed exclusively by the GFI branch, which is untouched (bounded retirement is Phase C; GFI differential behavior pinned by new tests). Fatal Intercept (before_compaction) no longer fabricates a tool_failure Pain with score 100 bypassing Evidence Triage/TriggerController; the safety interception and informational operational notes remain. Correction Sample Reject no longer produces host Pain from either writer (plugin TrajectoryDatabase + core trajectory-store mirror + the /pd-samples direct emit) — approve/reject, reason and sample_reviews audit rows are unchanged. The retired `thresholds.stuck_loops_trigger` and `scores.paralysis` pain_settings keys are removed from defaults (old files containing them still load — unknown keys are ignored). Historical pain_events rows (`llm_*`, `llm_paralysis`, `intercept_extraction`, `correction_rejected`) remain readable; no schema change, no new flags, no new abstractions. Net code deletion across 4 deleted modules; integrations unaffected beyond the removed imports.

## 1.146.6

### Patch Changes

- ded64b1: Dependency bump: @earendil-works/pi-ai from 1.2.0 to 1.4.0 (installer runtime dependency, shipped inside create-principles-disciple).
- a0dc3aa: Dependency bump: tuf-js from 6.0.0 to 6.0.1 (installer runtime dependency, shipped inside create-principles-disciple).

## 1.146.5

### Patch Changes

- 0020d2d: G2 release payload trim (SPEC-PD-RELEASE-FOOTPRINT-001): the bundled console payload no longer ships `console/dist/ui` (the tsc image of the UI sources — the browser runs the prebuilt dist/web bundle and the server imports nothing from it; consumer audit 2026-11-02), and the `release-manager` runtime component now ships only the transitive module closure of its real consumers (console update seam, deployed bootstrap executor, install-time authority probe) instead of a full second copy of the installer CLI dist. npm tarball −2.3 MiB unpacked / −305 files; self-contained asset payload −3.2 MiB / −430 files. The keep-set is computed from the compiled dist imports (scripts/release-manager-payload.mjs, shared with a guard test) so new runtime imports are tracked automatically; the npm CLI package still ships its complete dist.

## 1.146.4

### Patch Changes

- 9286940: Bump @inquirer/prompts from 8.7.4 to 8.7.5 (installer runtime dependency).
- 7f07f12: Bump @radix-ui/react-alert-dialog from 1.1.23 to 1.2.1 (runtime dependency of pd-console, shipped inside the installer bundle).

## 1.146.3

### Patch Changes

- a625198: PRI-1069/1070 G1 reliability (installer + pd-console, shipped inside create-principles-disciple): installer console verification now binds each probe attempt to the launched child via a one-shot nonce (old-console/foreign/proxy healthy responses are rejected fail-closed) and records attempt-level diagnostics; the probe child is terminated with a real bounded exit join, and an unconfirmed child defers destructive restore (restore_deferred). Rollback no longer deletes the live tree before restoring the backup — same-volume rename-aside with per-tree outcomes, partial-backup compensation, and machine-readable restore_incomplete markers that the Console recovery surface reports as needsRecovery instead of skipping terminal failures.

## 1.146.2

### Patch Changes

- 3e24e7b: Add an authenticated, bounded feedback revision for approved shadow RuleCode while preserving its artifacts, approvals and existing correction budgets. Provide system-owned recovery control semantics shared by production and replay, with a versioned input contract that rejects new artifacts on older Codex and WorkBuddy gates, so revised rules can preserve official recovery access without inventing command-prefix exemptions. Evaluation now also requires design-approval rules to keep the registered CLI recovery controls reachable.
  
  RuleCode activation identity is now versioned by the immutable artifact (`act_code_<ruleId>_<sha256(artifactId)>`, matching the prompt channel), so a revised artifact can no longer collide with the version it replaces; approving it retires the superseded shadow in the same transaction, with its own control state and an immutable supersede decision.

## 1.146.1

### Patch Changes

- bf7191f: Extract the pain-recall service into @principles/core as the Pain Recall Read Model and add the od-a-v1 Capability Facade (PRI-1068, SPEC-PD-AGENT-CAPABILITY-API-001 v0.5, MCP Gate 3). The `recallPains()` service moves from `pd-cli/src/services/pain-recall.ts` to the dedicated `@principles/core/runtime-v2/pain-recall` subpath byte-identically (CLI golden equivalence proven against pre-migration outputs; the strict read-only WAL snapshot matrix migrates with it). The new `@principles/core/runtime-v2/pain-recall-capability` subpath exposes `recallPrinciplePainsCapability` — a protocol-independent `pd.capability.v1` envelope under the frozen od-a-v1 disclosure profile (construction-is-whitelist projection, per-call leaf-path self-check, fail-closed input validation, limit ∈ [1,10]) — as the sole future entry point for the Gate 4 MCP Adapter. The plugin and installer ship core bytes, so they release in the same cohort (PRI-1065 precedent). Gate 4 (MCP server, 32 KiB budget, 10 s deadline) is explicitly not included.

## 1.146.0

### Minor Changes

- 59f4d29: Ship the Examiner offline research panel in the installed console.
  
  `/examiner` is no longer a DEV-only route: the console nav, page and server
  now exist in production builds. The installer payload carries the research
  engine subset under `<console>/lab`, so an installed console can create, run
  and report offline studies without the repository. The panel states its
  scope in-product — every study uses `SYNTHETIC_OFFLINE` gold and the
  deterministic local stub, so it validates the research contract and never
  real host behavior. Real model calls and real host runs stay refused (403).
  
  Studies are workspace data: new studies are written under
  `<workspace>/.pd/examiner/studies`, never into the installation or the
  repository. The lab case constructors move from test fixtures into the lab
  itself so packaged code never imports a test-only module.
  
  No governance migration, real host run, real model call, or historical
  research asset mutation is introduced.

## 1.145.43

### Patch Changes

- c495699: Harden the Console Examiner research surface (SPEC-PD-EXAMINER-001 v0.9).
  New offline studies are written under a dedicated writable root guarded by a
  server-issued ownership marker; the committed historical `examiner-studies`
  assets stay readable and always refuse execution and report writes. The run
  route now re-verifies the frozen study bindings under the study write lock
  before `RUN_STARTED`, reports carry bound injection evidence and capacity
  competition facts, and the capability itself is refused outside a dev runtime.
  
  No governance migration, real host run, real model call, production write, or
  historical asset mutation is introduced.

## 1.145.42

### Patch Changes

- 0dc1272: Governance is ON by default at install time (an explicit enabled:false opt-out
  is preserved and stated), the install summary prints a first-class governance
  state line via the new optional HostInstallResult.governance field, pd-cli
  workspace discovery learns the WorkBuddy governance workspace, and the
  global-pd warning names the always-available node invocation. (PRI-1064)

## 1.145.41

### Patch Changes

- b8ec104: Replace dot-path flag instructions ("Set features.host.workbuddy.enabled=true")
  with a single-line flow mapping the Owner adds to the EXISTING `features:`
  block (`host.workbuddy: {enabled: true}`), plus an explicit statement that the
  dotted id is ONE flat key — a nested host:→workbuddy: write is silently a
  different key.
  
  Two constraints shaped the copy (both verified against the real code, not
  assumed): hook diagnostics collapse every whitespace run, so a multi-line YAML
  block reached users flattened into one unparseable line; and every real
  config.yaml already has a top-level `features:` key, so pasting a second one
  fails with "duplicated mapping key" — which the loader turns into a
  `malformed` config and a full fallback to defaults.
  
  Fixed across ALL hosts: workbuddy hook/worker/installer copy, codex hook
  (host gate + conversation ingestion), catch-up nextAction, worker paused
  status, and the openclaw observer-config loader (which also contrasts the
  genuinely-nested internalAgents path). (PRI-1063)

## 1.145.40

### Patch Changes

- 4930232: Run WorkBuddy hard preflights before any installation work: a Git Bash probe
  plus exclusive-open probes on settings.json / installed_plugins.json refuse
  the install within seconds (with a "fully exit WorkBuddy" nextAction) instead
  of failing after minutes of npm work, and atomic config renames retry briefly
  on Windows lock errnos (EPERM/EBUSY/EACCES). (PRI-1062)

## 1.145.39

### Patch Changes

- 119bf4e: Make registry-installed bundled components executable: the pre-deployment
  compatibility scan's bundled pd-cli now resolves every bundled component's
  file:../ sibling deps through package-root node_modules links, and the
  bundled graph's third-party runtime dependencies (@sinclair/typebox,
  better-sqlite3, @earendil-works/pi-agent-core, @earendil-works/pi-ai, typebox,
  undici, micromatch) are hoisted into the installer's top-level dependencies.
  Upgrades from the registry no longer crash the scan with ERR_MODULE_NOT_FOUND.
  (PRI-1060)

## 1.145.38

### Patch Changes

- 3996007: Reconcile the prompt size-guard ceiling with the model-aware principle budget: the total injection limit is now the applied principle budget plus a fixed 7000-char background allowance instead of a hard-coded 9000, so large-window models no longer have every background block stripped in one turn (PRI-1065). The reference window still resolves to 9000, so existing behavior is unchanged. The stripped-context notice also no longer claims a diagnostician-priority session, which was untrue whenever the guard fired outside that mode.

## 1.145.37

### Patch Changes

- 650e24d: Stop the Console from writing a second response after one has already been
  committed, and give the authenticated Owner E2E suite an assertion budget that
  matches the server's own request budget.
  
  A route that finishes after the request timeout now logs the timeout as the
  first failure instead of masking it with `ERR_HTTP_HEADERS_SENT`; late writes
  are dropped with a bounded warning. The late-error path keeps the original
  status rather than replacing it. No Owner-visible copy or response contract
  changes.

## 1.145.36

### Patch Changes

- aa3c6ab: Organize Console review around one selected item, readable material, an explicit
  decision, and the recorded result. Preserve existing routes and governance
  controls while placing routine runtime history behind disclosure.
  
  Updated Console decisions include the artifact identity and digest returned with
  the reviewed material. Guarded approval, rejection and replacement reject stale
  material at the existing transactional write boundary. Legacy callers without
  the optional review guard retain their existing behavior.
  
  No governance migration, automatic approval, installed-runtime modification,
  new model call, or external service is introduced.

## 1.145.35

### Patch Changes

- 7d30045: Signals: bound the cost of correction detection instead of paying it on every message.
  
  - **Zero-match discovery is now budgeted.** Replaying live user turns showed that
    ~90% (93.5% in an earlier window, 90.9% in the most recent one) match no keyword
    at all, and every one of those used to start a Stage2 "discover a new
    correction phrase" call. `SignalCollectorConfig` gained
    `discoveryRateLimitPerHour` (default 6/hour, `0` = unlimited as before). Only
    zero-match discovery is limited — ambiguous hits are confirmations and stay
    unmetered — and the skipped calls are surfaced as `stage2DiscoverySkipped` in
    signal health, so the degradation is observable in `pd config doctor` rather
    than silent. Measured end-to-end through the production host with real messages:
    12 messages started 12 calls before, 6 after.
  - **Stage2 calls are bounded.** The classifier now resolves with
    `outputPathStrategy: 'json_mode_first'` and `maxRepairAttempts: 1`. On the same
    5 real messages the two strategies both needed one HTTP request, but
    `json_mode_first` finished in 11.5s total (max 3.5s) against 36.2s (max 23.9s),
    and it does not depend on the provider supporting tool calls.
  - **The observer stops re-running on unchanged input.** The periodic cycle skips
    when no user turn arrived since the last successful cycle (measured: 4ms versus
    14.1s for a real dispatch), and its payload now carries at most 40 messages
    truncated to 400 chars instead of every excerpt from 10 sessions (live measure:
    31.9KB → 23.5KB).
  - **One file lock per turn instead of two.** `recordUserTurn` /
    `recordAssistantTurn` used to take the trajectory write lock twice (session
    upsert, then the turn insert). Measured on real SQLite: 8.69ms → 4.47ms per
    turn over 300 writes, byte-identical rows, on the `before_prompt_build` path.

## 1.145.34

### Patch Changes

- f3b413a: PRI-1054: the installer's end-of-run console auto-launch now inherits the
  machine's declared authentication posture instead of hardcoding `--no-auth`.
  
  - With a non-empty `PD_CONSOLE_TOKEN` in the environment, the update chain
    spawns `pd console open` without `--no-auth`, so the console it brings up is
    in the same mode the previous one was in. `pd console open` resolves the
    token from the same variable, so nothing new is invented here.
  - The readiness probe is two-phase in that mode: a bare probe first, and only a
    responder that answers 401 with the console's own `unauthorized` envelope gets
    `Authorization: Bearer <token>` retried. 200 is accepted only when
    `data.authenticationMode` equals the launched posture — the same fact
    `pd console open` refuses on — so a pre-existing console in the other mode is
    not certified as the one this installer launched, and the token is never
    sprayed across the scan range.
  - The manual `pd console open …` instruction surfaced when auto-launch is
    skipped, when the CLI entry is missing, and when the console never becomes
    ready now carries the same posture. A token-configured machine is no longer
    told to start an unauthenticated console.
  
  Why this mattered: PD Companion requests an authenticated console whenever
  `PD_CONSOLE_TOKEN` is in its environment, and it restores that token from its
  own encrypted state on every launch. The unconditional `--no-auth` therefore
  replaced a healthy authenticated console on every release, and the next
  Companion start aborted with `console_authentication_mode_mismatch` — anyone who
  had configured a console token had the desktop app bricked by every version
  bump, and recovering it meant deleting the token, which in turn locks the
  governance decision actions.
  
  Machines with no console token (every fresh install) keep the existing
  `--no-auth` default, and `PD_SKIP_CONSOLE_AUTOLAUNCH` (release smoke, upgrade
  gate) is unchanged.

## 1.145.33

### Patch Changes

- 5349930: RuleCode host promotion loop (SPEC-RULECODE-HOST-PROMOTION-001 v0.1, A→B→C):
  
  - Host resolution: replace the "anything not Codex is OpenClaw" fork with an
    explicit openclaw/codex/workbuddy/unknown/multi-host routing. The OpenClaw
    historical default now applies ONLY to workspaces with no non-OpenClaw
    declaration or evidence — a WorkBuddy-only workspace can no longer inherit
    the OpenClaw capability claim (H02), and durable non-OpenClaw evidence
    whose declaration is missing fails closed for every known host, not just
    Codex.
  - Per-host capability contracts: Codex (`codex-v2@1`) and WorkBuddy
    (`workbuddy-v1@1`) contracts join the existing OpenClaw authority, with
    tool aliases taken from each host's real, evidence-locked vocabulary. The
    promotion shape validator binds to the resolver's contract version — a
    wrong-host contract fails `runtime_compatibility` instead of passing.
  - Shadow attribution (B3): `rulehost_evaluated` events carry `hostKind`;
    promotion shadow summaries count only the resolved promotion host's
    samples. Another host's samples and pre-attribution legacy rows count
    toward no host's threshold (H05). OpenClaw plugin rows are stamped too.
  - WorkBuddy V2 rule context: a provider over WorkBuddy's OWN trajectory
    (same-session tool_calls rows) replaces the blanket "no provider"
    boundary. WorkBuddy supplies no designGate fact (no attestation entry
    point exists there) and unavailable history degrades through the shared
    suspension contract with precise reasons. The V2 qualification gate now
    applies symmetrically: a Codex-stamped artifact never auto-executes on
    WorkBuddy and vice versa (SPEC §11.3/H13). pd-console rides inside the
    create-principles-disciple artifact.
  
    Review fixes (round 2, findings 1-3):
    - R1: `emergency_controls` no longer passes on contract shape + flag
      alone. A core-owned recovery-control registry (verified against the
      real pd CLI registrations and the Console emergency-pause route by
      cross-package contract tests) gates every probe; the fabricated
      `pd status` / `pd activation emergency-pause` commands were removed
      (they never existed), the global pause is honestly declared through
      its real Console surface, OpenClaw probes use the real `exec` tool,
      and a rule combination that blocks the recovery probes fails the
      check.
    - R2: tool_calls rows now carry producer host attribution
      (`host_kind`, stamped by every writer; legacy rows stay NULL and are
      never backfilled). The WorkBuddy provider consumes ONLY rows proven
      to be WorkBuddy's — a colliding Codex session can no longer lend its
      reads to a WorkBuddy read-before-write rule (precise
      unavailable reasons instead). The WorkBuddy PostToolUse channel
      contract classifies string responses as completed successes (the
      failure channel is a separate registration).
    - R3: `rulehost_unhealthy` events pass the same host-attribution
      filter as every other shadow event — a foreign host's anomaly can no
      longer fail (or gate) the target host's readiness.
  
    Review fixes (round 3, findings 1-2):
    - R3/P1: readiness now separates four evidence layers. Composition
      verification executes through the production boundary (every rule of
      candidate+live compiled by the production hardened evaluator, merged by
      the gate's mergeDecisions — a requireApproval escalation fails too);
      console-channel controls carry NO rule probe (their path never passes
      the gate; isolated tests prove the real pause route changes gate
      behavior); emergency_controls additionally requires per-evaluation
      TARGET-ENVIRONMENT reachability evidence — the CLI readiness spawns the
      real `pd activation list --json` subprocess against the target
      workspace (the expected activation must appear in its listing), the
      console proves the pause substrate readable. Absent/failed/mismatched
      evidence fails with `recovery_reachability_unverified`; nothing is
      cached, so no install inherits another's "verified" state.
    - R3/P2: host attribution now runs through DEDUP and FACT UPGRADE. All
      tool_calls dedup/upgrade queries (recordVerifiedToolOutcomes, the live
      PostToolUse path, governance admission) are host-scoped for known
      hosts: a colliding row from another host is a different record (no
      swallowing), a legacy NULL row is never implicitly claimed (a new
      attributed row lands beside it), same-host re-delivery stays
      idempotent, and unknown→final upgrades only same-host rows.
  
    Review fixes (round 4, findings 1-2):
    - R4/P1: recovery reachability is PER-CAPABILITY. The evidence type gains
      a capabilities matrix; emergency_controls requires every registry
      capability (pd_status, rulecode_deactivate, rulecode_global_pause,
      owner_review_access) to carry its own current, channel-matched,
      workspace-matched entry — missing, duplicate, unknown, channel-mismatched
      or failed entries fail closed with stable reason codes. The shared
      host-runtime probe module executes the REAL pd CLI subprocesses: the
      status listing (pd_status) and a new non-destructive
      `pd activation deactivate --dry-run` validation path (rulecode_deactivate
      — real parsing, workspace binding, and target resolution, returning
      BEFORE any governance audit write or store mutation). Console readiness
      assembles its own evidence: the same CLI subprocess probes, a
      transaction-rollback write probe for the pause substrate (table asserted
      unchanged after rollback), and a route-served signal for owner_review
      (real authenticated Console HTTP entry observed in the same evaluation).
      CLI-process promotion honestly reports console-channel entries as NOT
      verified and refuses (fail closed); commit-failure semantics stay
      covered at the service level.
    - R4/P2: real-SQLite dedup coverage extended beyond one helper: the
      production pain-evidence handler (both dedup routes), the governance
      admission entry (both dedup queries), and the Codex ingestion chain each
      get cross-host collision, legacy-NULL, same-host idempotency, and
      terminal-protection regressions against real production entries.
  
  Round 5: verify recovery controls under actionable V2 facts and history,
  normalize probe paths in linear time, and compile RuleCode separately from
  its fixed VM JSON bridge without weakening sandbox limits.

## 1.145.32

### Patch Changes

- ec24a13: Release-verification fix: the N-1 → N upgrade gate's backup assertion targeted the pd-cli `node_modules/@principles/core` slot, which is a physical copy by construction (npm ci `--install-links` materializes `file:../core`; syncPdCli copies node_modules wholesale; the PRI-665 scenario additionally injects a physical duplicate into exactly that slot) — so the publish release matrix failed with "expected false to be true" on ubuntu-24.04/node 22. The rename-swap junction proof now uses the codex-adapter core link (the one slot the installer guarantees as a canonical link), and the pd-cli core slot instead proves the complementary invariant: the injected physical tree moved verbatim, never traversed. Test-only change; no shipped behavior difference — it unblocks the pending 1.145.31/2.2.6 release cohort. PRI-1037 S9 follow-up.

## 1.145.31

### Patch Changes

- 5ad3954: Fix the OpenClaw PD plugin payload so a real `agent exec` round no longer times out at workspace-plugin publication. The shipped plugin component is now the self-contained `dist/bundle.js` plus its single native dependency (`better-sqlite3`): the historical `file:./core` rewrite and the inlined-dependency list are gone from `plugin/package.json`, so an install carries 322 files / 33 MB instead of 16,425 files / 126 MB (and OpenClaw's per-round plugin-source capture drops from ~19,167 files / 153 MB per build to 321 files / 33 MB). Also: the bootstrap executor is now delivered from the payload's own `release-manager` component instead of the executing package — during an update the executor used to re-deploy its own stale code, so `installs.json` regenerated by pre-PRI-1021 code could never converge; `release-locks/plugin` is regenerated for the lean manifest, and the plugin package's own manifest no longer lists `@principles/core` as a runtime dependency (it is bundled at build time). PRI-1037 S9.

## 1.145.30

### Patch Changes

- 07242b7: Legacy principle-injection removal: Runtime V2 activations become the only
  prompt injection authority.
  
  - Plugin: delete the unconditional `<evolution_principles>` block, the
    plugin-local selector shim (`core/principle-injection.ts`), inline
    probation injection (1000-char sub-budget and its session bookkeeping),
    cross-block dedup plumbing (`excludePrincipleIds`, `crossBlockDuplicateIds`,
    `all_deduped_against_legacy`), and probation feedback attribution
    (`handleProbationFeedback` / `recordProbationFeedback`). `prompt.ts` reads
    activations via `readActivatedPrinciples` only.
  - Core: delete `prompt-builder/principle-selection.ts`
    (`selectPrinciplesForInjection`, `formatPrinciple`,
    `DEFAULT_PRINCIPLE_BUDGET`, `InjectablePrinciple`,
    `PrincipleSelectionResult`, `PromptInjectionPart`) and the
    `evolution_principles` step in `truncateInjectionToBudget`.
  - Host runtime: drop the now-unused exclusion input and diagnostic fields from
    `buildActivePrinciplePromptContext`.
  - Event schema: `legacySelectedCount` / `legacyTotalChars` /
    `legacyTruncated` / `crossBlockDuplicateIds` stay optional for reading
    historical events; the plugin no longer emits them, so `pd principles stats`
    reports legacy counters only for turns recorded before this change.
  
  `<core_principles>` (static T-01..T-10 axioms) and Runtime V2
  `<directive>` injection are unchanged.
  
  Behaviour difference to know about before upgrading: a principle that lived
  ONLY in the legacy reducer (active/probation, no Runtime V2 activation) used to
  reach the prompt through the deleted block and no longer does. On the Owner's
  machine that set is empty — 0 of the 847 scanned prompt events ever carried a
  non-zero `legacySelectedCount`, so no turn ever showed a legacy-only principle.
  That census proves "no legacy-only injection happened here", not "every
  workspace is empty": if another workspace still holds active principles with no
  V2 activation, review them with `pd principles stats` and activate them through
  the Owner path before upgrading.
  
  Legacy probation therefore ends with this change: with no probation block there
  is no per-tool feedback attribution, so `recordProbationFeedback` (the only
  path that could promote probation → active at `PROBATION_SUCCESS_THRESHOLD`) is
  deleted too. Existing probation entries keep expiring
  (`probation_expired`) instead of graduating; promotion is Owner-driven through
  Runtime V2 activations.
- 53a285f: Legacy pruning-review chain removal (follow-up to the legacy principle-injection
  removal): the pruning audit log, its injection mask and the operator commands
  that wrote it are deleted, together with the dead legacy subtree reader.
  
  `pd-cli` takes a minor bump rather than a patch because two operator-visible
  subcommands disappear from the CLI surface. `pd runtime pruning report`,
  `explain` and `orphans` keep their contract; `pd runtime pruning review` and
  `pd runtime pruning rollback` are removed, so any script or habit that calls
  them must stop (they wrote a log that nothing reads any more, which made
  `archive-candidate` look like a governance decision that changed nothing).
  
  - Core: delete `runtime-v2/pruning-review-log.ts` (`appendPruningReview`,
    `listPruningReviews`, `PruningReviewDecision`, `PruningReviewRecord`,
    `AppendPruningReviewInput`) and `runtime-v2/pruning-mask.ts`
    (`buildMaskedPrincipleSet`, `getCachedMaskedPrincipleSet`,
    `clearPruningMaskCache`) and their barrel exports. `PruningReadModel` and
    `removeOrphanReferencesFromLedger` stay.
  - pd-cli: `pd runtime pruning` keeps `report`, `explain` and `orphans`; the
    `review` and `rollback` subcommands are gone (`rollback` existed only to
    un-mask a principle for the legacy injection block).
  - Plugin: delete `WorkspaceContext.getActivePrincipleSubtrees()`, which no
    production path called, and the Story A "masked legacy overlap" scenario that
    pinned the mask contract. Retire the `sync-plugin` npm entry point of the
    deactivated dev install chain (the refusing `scripts/sync-plugin.mjs` stub and
    its guard test stay).
  
  Nothing reads the historical `<workspace>/.state/pruning_reviews.jsonl` any more;
  existing files are left untouched and are now inert data.
  
  Prompt injection, pruning health reporting, orphan cleanup and the console
  health panel are unchanged: the mask only ever filtered the `<evolution_principles>`
  block that the previous step removed, so on this installation it had no effect
  left to lose.
- eaaa2e9: WorkBuddy plugin hook wrapper now arms a self-deadline strictly below the hooks.json host timeout and kills a hung adapter child itself, degrading non-blocking (exit 1 + bounded stderr, P02) instead of leaving the outcome to the host's undefined hook-timeout semantics. Rationale (2026-10-28 incident follow-up): the adapter entry's own fail-open exits can never run when the host kills the wrapper mid-flight, so the "UserPromptSubmit failure never blocks" guarantee was unenforceable on the timeout path. Budgets: UserPromptSubmit 12s under a narrowed 15s host timeout (prompt loss is the costliest channel), every other event 25s under the unchanged 30s; a guard test locks every wrapper budget below its hooks.json timeout, and a real-process test proves the kill/degrade path end-to-end (EP-04). Bumps the WorkBuddy plugin manifest 0.2.0 → 0.2.1 (bump-on-content-change convention, #2108) and records the timeout-path semantics in SPEC §4.4.

## 1.145.29

### Patch Changes

- 44a9d3d: Codex agent-assisted explicit pain registration (no prefix).
  
  When the Owner's current message explicitly asks to create a pain signal and provides the feedback, the agent can now complete the registration itself instead of demanding a `PD记录痛苦：` resend:
  
  - The Codex hook publishes the CURRENT turn's host-verified identity (ids/paths only, never prompt text) to a session-hash-partitioned file under `<workspace>/.state/` on every UserPromptSubmit and withdraws only that session's matching turn on Stop (or that session on SessionStart). `pd pain explicit` selects the file using the host-bound `CODEX_SESSION_ID` and rejects conflicting `CODEX_THREAD_ID`; missing identity fails closed.
  - New `pd pain explicit --statement "<Owner 原文>" [--workspace] [--json]` registers through the SAME admission chain as the prefix entry (governance admission marker, explicit 5/hour bucket, diagnostician task ensure, idempotent same-turn convergence). The command takes no lineage flags — lineage comes exclusively from the host-written turn context and is re-validated at registration time.
  - Provenance is auditable: agent-assisted registrations carry `channel: codex_explicit_agent` and an "agent-assisted, no prefix" pain reason, distinct from the hook-read `codex_explicit_prefix` channel (additive literal in the shared PainCorrectionEvidence schema; prefix behavior byte-identical).
  - The `pd-pain-signal` skill now mandates agent-assisted registration for explicit no-prefix requests (verbatim Owner words only, receipt-idempotency check first, honest failure reporting); the "ask the Owner to resubmit" absolute rule is retired, and `pd pain record` remains the post-hoc operator recovery path.

## 1.145.28

### Patch Changes

- 7f1afe2: Legacy cleanup batch 1: remove retired code that had zero production consumers.
  
  - Gate A (`PainDiagnosticGate`) finally retired end to end: the core
    `runtime-v2/pain-gate` policy, its 14-name barrel surface, and the archived
    plugin adapter are deleted. Gate B (`TriggerController` + `evidence-triage`)
    remains the only admission authority.
  - Delete two orphan plugin core modules with zero production importers:
    `workflow-funnel-loader.ts` (stale duplicate of the core loader) and
    `thinking-os-parser.ts` (only two tests imported it; its pure parser moved
    to a test helper).
  - Delete the `@principles/host-runtime` pain-ingress re-export shim; its one
    production consumer now imports the core semantic authority directly, and
    the SPEC §8.2 matrix test moved next to that authority.
  - Reduce the deactivated legacy dev install scripts (`scripts/install.mjs`,
    `packages/openclaw-plugin/scripts/sync-plugin.mjs`) to their PRI-868
    refusal guard, deleting the unreachable installer bodies and their
    test-only helper libraries.
  
  No runtime behavior change: every removed module was unreachable or
  test-only after PRI-454 and PRI-868.

## 1.145.27

### Patch Changes

- 004acb4: Unify the RuleCode textual-basis anchoring check (continuous verbatim span) across the scribe success boundary and the artificer intent preflight, feed scribe validator rejections back into the next model attempt with cross-epoch freshness, and add one bounded authenticated source-correction recovery per rule candidate that CAS-reopens the original needs_human_review artificer on the new scribe epoch. Leases now count attempts per revision epoch while run ordinals stay globally sequential, so reopened epochs actually receive their original maxAttempts. The bundled Console (ships inside create-principles-disciple) gains an authenticated source-correct-once entry whose receipt binds the Owner actor, binding revision, artifact digest and stop reason. Owner review R6: bash-command risk classification is unified across the host gate, the OpenClaw enrichment and golden-trace replay (git mutations and arbitrary code execution count as mutating); approval-gate rules must keep read-only investigation allowed under not_approved, verified by a system-generated counterfactual; the scribe success boundary rejects undeclared approval dependencies.
- c7d3f29: PRI-1048：治理焦点「规则的正式原则归属」队列修复父子任务重复并改版为可理解的来源/阶段/操作卡片。根因：`getCandidatesByTaskId` 本身按「自身+子任务」查询，队列又同时遍历 diagnostician 与 diag_router 任务列表，router 子任务提交的候选被父诊断带出一次、router 再带出一次（真实 workspace 9 候选显示 18 条）。修复在队列聚合所有者（RuleCandidateBindingConsoleModel.list）按 canonical candidateId 去重，共享 store 查询语义不变。同时把队列 DTO 从 candidateId/text/reason 扩展为只读投影：来源痛苦信号原文（trajectory.db 批量只读）、诊断状态、绑定态与原则正文（ledger 权威）、生成链阶段（dreamer→…→rollout_reviewer，受阻带 reasonCode）、修订资格（真实 `resolveRuleBindingRevisionTarget` + 与 reviseRuleBindingOnce 相同的预算规则，仅导出既有函数，无逻辑复制）；前端改为按痛苦信号分组的有界卡片（默认回答「哪次反馈/卡在哪/要做什么」，技术 ID 与原始 JSON 折叠进「技术详情」），「修订并继续」仅在真实资格 ready 且链不在运行时出现，不摆不能执行的按钮，也不把通用重试冒充源修订；@principles/core 仅把 `resolveRuleBindingRevisionTarget` 加入 runtime-v2 barrel 导出（冻结快照同步 +1）。

## 1.145.26

### Patch Changes

- e1d6ffc: PRI-1023: retire the `openclaw-cli` sub-agent runtime backend (ADR-0029). pi-ai is now the only backend PD executes internal agents on; OpenClaw stays supported as a *host*, never as a delegated CLI agent session. Legacy `type: openclaw` profiles still parse, redact and list, but they are read-only: readiness always answers `needs_setup` with a pi-ai next action, `createAdapterConfigFromProfile` fails loud instead of producing an adapter, the console no longer offers, creates or updates the retired type (existing profiles stay listed and labelled retired, editable only by deleting and recreating them as pi-ai), and the `--openclaw-local` / `--openclaw-gateway` / `--agent` CLI flags are gone in favour of `reason: 'retired_runtime_kind'` refusals. Rollback is source-level: revert this PR.

## 1.145.25

### Patch Changes

- 0c4cbda: chore(deps): 升级 tuf-js 3.1.0 → 6.0.0。
  
  tuf-js 是安装器信任根供给链路的直接运行时依赖，随 create-principles-disciple 工件分发，所以记 installer patch。
  
  同时同步 `release-locks/release-manager/package-lock.json`：tuf-js 6 不再经由 make-fetch-happen 取元数据，其整棵传递依赖子树被剪掉，staging 的 `npm ci` 会因 lock 与源码 package.json 不一致而 EUSAGE 失败。
- b50ea82: chore(deps): bump react 19.3.0 -> 19.3.1（#2163；@principles/pd-console 运行时 dependency，打进 console bundle 随 installer 工件分发）。同时把 lock 里 react-dom 一并解析到 19.3.1 并删掉 Dependabot 留下的 `packages/pd-console/node_modules/react` 嵌套副本——否则工作区里会同时存在两份 React（app 用 19.3.1、react-dom 的 peer 用 19.3.0），Console 会以 `Cannot read properties of null (reading 'useMemo')` 白屏。

## 1.145.24

### Patch Changes

- f74524e: PRI-1046 收口：Codex 插件安装链上两条「看起来正常」的静默路径不再成立。① `$pd-control setup` 把「安装后字节与 pin 一致」作为唯一验收，npm 退出码只是过程信号：当字节不符（精确 pin 被静默丢掉、模块只留在嵌套目录）时，先清掉 `runtime/node_modules` 与锁文件、从干净树重装一次，仍不符才结构化失败并逐行列出不符的包——不再把「手工删除 node_modules」当作下一步交给用户；网络请求仍不重试（失败立刻暴露，单请求超时 60 秒），判定权归字节核对，重试不会掩盖一次丢掉 pin 的安装。② `pd-status` 新增 `snapshot` 检查：把已安装缓存快照的版本与该 marketplace 本地 source 里的 `plugin.json` 版本比较，落后即 degraded 并给出 `codex plugin remove/add` 命令——旧快照过去因为 pin 与脚本都取自它自己而永远自称 pinned match。无法比较时区分两类：「非本地 marketplace / 显式 --plugin-root」按设计不适用，其余（config.toml 不可读、source checkout 已删、marketplace 已移除）属 degraded 并给出修复动作。
- 90473c3: chore(deps): bump js-yaml 5.4.3 -> 5.5.0（#2156，连带 argparse 2.0.1 -> 3.0.3；create-principles-disciple 的运行时 dependency，安装器读 YAML 配置随 installer 工件分发）。本 PR 只调和 `packages/create-principles-disciple/package-lock.json`，`package.json` 的 range `^5.4.3` 未变；各组件 staged release-lock 里的 js-yaml 已是 5.5.0，无需重新生成。
- 02918c6: chore(deps): bump i18next 26.4.7 -> 26.5.6（#2159；@principles/pd-console 运行时 dependency，打进 console bundle 随 installer 工件分发）。Dependabot 只同步了 root workspace lock，`release-locks/console` 里仍钉 26.4.7，release staging 的 `npm ci --omit=dev` 会以 `Invalid: lock file's i18next@26.4.7 does not satisfy ^26.5.6` 失败（ERR-131/068 同族）；本 PR 把那条 staged lock 一起调和到 26.5.6。
- 7f286e0: chore(deps): bump @inquirer/prompts 8.7.2 -> 8.7.4（#2160；create-principles-disciple 的运行时 dependency，安装器交互式提示随 installer 工件分发，Dependabot 也把它标在 `installer` 生态）。本 PR 只调和 `packages/create-principles-disciple/package-lock.json`，`package.json` 的 range 未变。
- b6bdd9a: chore(deps): bump @radix-ui/react-select 2.3.7 -> 2.4.1（#2161；@principles/pd-console 运行时 dependency，打进 console bundle 随 installer 工件分发）。

## 1.145.23

### Patch Changes

- 0cb8d0a: PRI-1046：Codex 插件的 `$pd-control setup` 不再凭 npm 退出码认领 runtime pin——装完必须读 `runtime/node_modules` 里三个包 manifest 的真实版本并与 `runtime-version.json` 逐一比对，不一致就结构化失败；marker 只在字节核对通过后写，撒谎的 marker 会触发重装而不是永久短路；精确 pin 的安装不再带 `--prefer-offline`（陈旧 cache 会让 npm 静默丢掉精确版本却仍 exit 0）。

## 1.145.22

### Patch Changes

- 52d2c6a: Connect Owner-decided principle reuse to shared identity resolution, and add authenticated rule-candidate binding with one bounded revision. Preserve prior PI artifacts across revision epochs and reject stale or revoked binding receipts before generation and publication. The bundled Console exposes binding separately from rule approval and activation.

## 1.145.21

### Patch Changes

- 4922dda: PRI-1041：按上游声明确定 RuleCode 必需验证，区分历史证据与可回放事实，独立系统契约测试贯通 L2 自测/提交、Runner、Evaluator 与工件装配；缺少能力或必需覆盖时不再错误标记为验证通过。
- e060c56: PRI-1040：为 Companion 托管的 Codex/WorkBuddy worker 接通合作式发布交接，当前周期完成后才替换，无法安全交接时明确显示原因。Codex 插件发布后维护已发布包固定版本、递增插件缓存版本，并由真实 npm 能力探针保护交付。

## 1.145.20

### Patch Changes

- 1b13597: SPEC-PD-PAIN-RECALL-CLI-001: new read-only `pd pain recall` command — recalls the historical pains a principle verifiably derives from, so a host Agent can check a principle's origin, trigger boundary, or current-situation fit on demand. Only two authoritative association edges are honored (`reuseEvidence[].painId`; `derivedFromPainIds` resolved through its production contract as candidate ids via `tasks.input_ref`), results dedup by real pain id while keeping every evidence ref, `--context` re-ranks deterministically without any model/network call, and per-source availability separates `not_recorded` from `unreadable` (`source_missing`/`source_unreadable` never masquerade as `no_matches`). All three hosts' `pd-cli-operator` skills (Codex plugin, OpenClaw en/zh templates, WorkBuddy adapter) now document when to call it, how to read the JSON contract, and the diagnosis-is-not-owner-statement rule.

## 1.145.19

### Patch Changes

- eba9e22: PRI-1021：安装器不再写 OpenClaw 宿主的 `~/.openclaw/plugins/installs.json`。该文件自 OpenClaw 2026.10.5 起会被 doctor 状态迁移硬拒，导致网关以 exit 78 循环重启；插件注册只由 `openclaw.json` 与宿主自身的安装流程负责。
- e0f9fc8: PRI-1022：让新用户知道「PD 的内置智能体需要自己配 LLM」。安装指引（README 双语、USER_GUIDE 双语、官网 getting-started 双语、安装器 README）新增前置条件与「开始之前：先给 PD 一个 LLM」一节，讲清 provider / model / apiKeyEnv 三个字段和跳过后的真实后果（证据照收，但不诊断、不提原则）。`--yes` 安装摘要不再只说「配置了 runtime profile」，未配置时点名三个字段并给出两条补齐路径。Console 控制中心把原本写好却从未渲染的五句 readiness 文案接到实际状态上，并删掉「runtime profile 是 OpenClaw profile」这句与当前默认架构相反的描述。

## 1.145.18

### Patch Changes

- 0f2d1fb: PRI-1020: Owner-declared context windows (SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001). A new optional `promptBudget` section in `.pd/config.yaml` lets the Owner declare a model's real context window (`declaredContextWindowTokens` + optional per-host `hosts` overrides). It is tier 0 of the injection budget chain — outranking host-reported windows and the model catalog — and scales the budget with the same formula as #2093 (262144 tokens → 4096 chars, cap 16000). This unblocks Codex/WorkBuddy hosts whose adapters carry no window facts and whose custom model ids can never match the installed catalog (previously locked at the 2000-char fallback forever). Console surfaces forecast under the declared basis when no fresh runtime observation exists; a fresh observation still wins. Delete the section to roll back to the previous behavior. Config validation fails loud on malformed values (policy plausibility bounds, closed host set, unknown keys).

## 1.145.17

### Patch Changes

- 4256244: PRI-1019：为 Codex RuleCode 接通经 Owner 认证的设计事实声明、生成能力检查和逐次运行时事实；缺失或失效事实会暂停依赖规则并显示原因。Console 提供范围登记与撤回入口；保留真实原则审批与逐工件激活流程。

## 1.145.16

### Patch Changes

- 6881b6c: Bump the Codex plugin manifest 0.1.1 → 0.2.0 and the WorkBuddy plugin manifest 0.1.0 → 0.2.0. The unified four-skill set (#2106) changed both plugins' shipped content without moving their manifest versions; Codex cache updates key on that version, so users re-running `codex plugin add` could be served the already-installed 0.1.1 payload and never receive the new skills. The WorkBuddy same-version refresh path is content-safe, but a versioned cache dir makes the upgrade observable. Includes a cross-version WorkBuddy upgrade regression (new cache dir + registration repoint + governance data preserved) and parameterizes the delivery tests off the shipped manifest version.

## 1.145.15

### Patch Changes

- 5c383e5: Unify PD host skills around four consistent capabilities, clarify Owner governance and evidence boundaries, and align the published skill bundles and Codex recovery guidance.
  
  Review-round additions: `pd run list/show` gain an optional `--workspace` (governance-workspace reads independent of cwd); Codex skills route every shipped script through `pd-locate.cjs --exec` — one authoritative locator that resolves the plugin root once, fails loud on marketplace ambiguity or a missing script instead of silently falling back to an older version; WorkBuddy near-miss explicit-statement prefixes get an actionable format notice; `pd-review` startup text no longer presents CLI approval as an agent fallback.

## 1.145.14

### Patch Changes

- 765d5c4: Decouple the signal_confirmations batch consumer from the correction_observer flag (AUDIT-P2-04, 2026-10-21 remediation): the periodic cycle now starts when signal_collector is enabled (default on) even with correction_observer off (default), so persisted pending confirmations are consumed instead of remaining invisible permanent-pending records. Keyword optimization remains exclusively gated by correction_observer and is never silently enabled. Batch skips due to an unavailable classifier are now counted (stage2BatchSkipped) and pd config doctor classifies backlog-plus-skip as degraded with an actionable next action.
- d00ea5c: Signal detection sync-path and observability hardening (AUDIT-P2-01/P2-02, 2026-10-21 remediation): defer all health-counter file writes off the before_prompt_build synchronous call stack (degraded/zero-hit paths previously did a synchronous read-modify-write per message); add stage2Invocations and stage2BatchSkipped counters with backward-compatible signal-health parsing and pd config doctor display; add sync-path regression tests and a repeatable detectSync performance baseline. SQLite queue records stay synchronous by design.

## 1.145.13

### Patch Changes

- 48df168: PRI-1017: Console budget forecasts now run under the workspace's most recent runtime budget OBSERVATION, closing the SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1 data-chain gap where the runtime injected under a model-aware budget (e.g. 256K window → 4000 chars) while the console still forecast under its own parameterless fixed 2000-char fallback (`1953/2000`).
  
  - Host-runtime adds a read-only observation model over the EXISTING injection events (`runtime_v2_prompt_activations_injected` JSONL): latest budget fact per host, untrusted-input discipline (closed-set validation, loud skip counts), workspace + host binding, 24h freshness bound, policy-version binding, and pre-policy events skipped rather than reinterpreted. No new database, no second budget state source, no event schema change.
  - The reader is bounded: at most the 7 most recent daily files in each candidate log directory (`.pd/logs` and `.state/logs` — a per-directory cap so a later directory can never be starved of the newest observation), and only the last 4 MiB of each file, so a large log can never stall the console; a cut line is dropped rather than half-parsed, and `truncatedFiles` reports the skip loudly. An observation that only exists in a skipped prefix is reported as absent (honest fallback), never reconstructed.
  - Console surfaces (approvals/grouped badge, activations status rows, post-approval warning) pass the observation-rebuilt `PromptBudgetResolution` into the same production projection; payloads carry `budgetObservedAt` so the UI labels the budget as the most recent runtime observation — never as a live confirmation. Per-host forecasts under an unconfirmed route each carry their own budget basis.
  - Honest degradation: no observation / stale observation (`runtime_budget_observation_stale` reason code) / host mismatch / untrusted event fields all fall back to the fixed budget with traceable reason codes; governance flows are untouched.
  - Also completes a PR #2093 review leftover: the focus-page budget fallback localization keys (10 reason codes + notes) now exist in both en and zh-CN, and the grouped API accepts `?host=workbuddy` like the focus page's host picker.

## 1.145.12

### Patch Changes

- d3796e4: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.
  
  - Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match (host-declared provider) → legacy fixed 2000-char fallback with a bounded machine-readable reason code — provider-less name-only matches NEVER confirm (v0.2 trust amendment: a unanimous name cannot prove the deployment is not a custom endpoint). Budget formula `min(16000, max(1250, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens). The 1250 floor is MEASURED (shared route full render of one minimum viable principle = 849/1204 chars with self-report off/on — lower floors re-create the audited 32K zero-injection defect); the 16000 cap is the Owner target upper bound (1M windows map to 15625).
  - Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 1250..16000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 16000 max tier; cross-host aggregation is monotone — only ALL-hosts overflow brands an entry oversized everywhere); injection events carry budget provenance INCLUDING the bounded `budgetFallbackReason` code.
  - Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
  - Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.

## 1.145.11

### Patch Changes

- 0dc0431: chore(deps): bump @sinclair/typebox 0.34.49 -> 0.34.52（#2087）。typebox 是 core / plugin / console 的运行时 dependency，console 随 installer 分发，故 core、plugin 与 installer 各声明 patch。
- 96bff72: chore(deps): bump @principles/install-layout 0.2.7 -> 0.4.0（#2088）。install-layout 是 installer 的运行时 dependency，随 create-principles-disciple 工件分发，installer 声明 patch。
- 9c4f766: chore(deps): bump i18next 26.4.2 -> 26.4.7（#2089）。i18next 是 pd-console 运行时 dependency，console 随 installer 分发，installer 声明 patch。

## 1.145.10

### Patch Changes

- bf5aed3: Introduce an opt-in WorkBuddy native current-user keyword Pain path using the shared high-precision detector, canonical Pain admission and Diagnostician task continuation. Expose effective keyword detection status; leave the feature off by default and preserve Codex ingestion consent boundaries.

## 1.145.9

### Patch Changes

- 1a127e2: 修复 RuleCode 新生成契约与路径事实，统一原则范围内的语义验收，并为经过逐规则复验的 Codex V2 规则接通运行上下文。

## 1.145.8

### Patch Changes

- b02ebb5: Deliver WorkBuddy pain recording, status, Owner review and disable skills through the plugin package, marketplace and versioned cache. Reject incomplete payloads and unsafe manifest versions before registration, refresh old hook-only caches even at the same manifest version while preserving native registry scopes and older cache versions, confine cache replacement to the PD plugin version directory, and delegate disable to the existing official installer API.

## 1.145.7

### Patch Changes

- 1eb5293: Upgrade the Pi runtime dependency from @earendil-works/pi-ai / pi-agent-core 0.85.1 to 1.2.0 (SPEC-PD-PI12-COMPAT-001). Migrates the three runtime adapters to the Pi 1.2 agent-loop contract: the system prompt now rides the transcript as a leading system message (also fixing the duplicated user message in every L2 request under 0.85.x), shouldStopAfterTurn is replaced by finishTurn with the upstream canonical error/aborted guard, convertToLlm passes the system role through, and the ToolCall extraction predicate adopts the SDK type (arguments narrowed to JsonObject). Regenerates all installer release locks on the Node 22 / npm 10 toolchain; pi-agent-core's runtime dependency tree shrinks to pi-ai + typebox. No governance, activation, or approval behavior changes; Artificer keeps fail-closed semantics (no L1 fallback) and the Owner-Evidence gate is untouched.
- d91b9e0: PRI-1011: an LLM run whose output budget the provider rejects now recovers instead of burning all retries on the same rejected value.
  
  - core: `completeWithRetry` recognises the "requested max_tokens exceeds the maximum output tokens" signature (resolved error responses and thrown errors alike) and halves the budget for the next attempt of that same run — a profile that was never rejected keeps sending exactly what it sends today. A profile that relies on pi-ai native defaulting gets an explicit number for the retry, because resending `undefined` would resend the value the provider just rejected.
  - The ladder stops at a 4096 floor: below that a structured answer is routinely cut off, so further halving would trade a provider rejection for a silent truncation. At the floor the run still fails loud as `execution_failed` with the provider evidence intact.
  - Each step emits an observable `llm_max_tokens_downshift` event (from/to, provider, model, attempt, provider evidence), so the Owner can see what was tried rather than only that something failed.
  - Rate limits, timeouts and unrelated 4xx keep their existing classification and trigger no downshift.
  
  This release train patches `@principles/core`; the correction observer and the other internal agents call it through the bundled `principles-disciple` plugin, and the installer bundles the plugin, so both must be declared in the same plan (release-intent rule N-5/C4). No plugin or installer code changes.
- a241ca2: 修复装机上「Codex 治理健康」永久降级：console 改用安装布局权威去找 pd-cli 入口。
  
  此前 `CodexGovernanceHealthModel` 用包名解析（`require.resolve('@principles/pd-cli/package.json')`）定位要执行的 CLI，而 console 从未声明这个依赖——装机上它必然抛 `MODULE_NOT_FOUND`，被 `catch { return null }` 压成一个常量 reason `pd_cli_unavailable`，与「运行时真的坏了」无法区分；nextAction 还引导 Owner 去 `npm i -g @principles/pd-cli`，这台机器上既无效也不该做（安装面由 installer/更新链独占）。
  
  现在解析顺序为：安装布局权威 `resolveUpdateLayout()` 给出 `pdCliDir` → 拼 `<pdCliDir>/dist/index.js` → 按实际盘上状态给出可区分原因（入口缺失 / 不可读 / 不是常规文件），nextAction 指向控制台的更新页与 `npx create-principles-disciple`。布局解析不到时才退回工作区依赖图（源码树场景），且该通道不做存在性预检，未构建时由子进程自己报结构化失败。既有 dev 行为与 CLI 调用命令行（`health --host codex --workspace <dir> --json`）均未变。
  
  同一症状的第二处断链：CLI 在报告本身判定「治理未就绪」时按设计以退出码 1 结束（cli-2：未就绪就是可执行信号），而 console 把非零退出直接当作采集失败丢掉。于是在 host 未启用的装机上——退出码恒为 1、stdout 却是一份完整报告——面板显示的仍是采集失败常量，真正的阻断原因（如 `host.codex: disabled`）被淹没。现在非零退出只表示「需要用 stdout 判定」：解析并校验到报告字段就原样返回（未就绪仍如实呈现 ready=false + 阻断原因），拿不到可用报告才降级，并区分 `health_collection_failed`（子进程没能给出输出）与 `report_unusable`（输出了但不符合 --json 契约）。

## 1.145.6

### Patch Changes

- ef04263: Retire the local manifest-host union twin: install-layout 0.4.0 is published,
  so the installer imports the shared `installManifestHostsForPersist()` again
  and the temporary local copy (added when the registry only served 0.3.x) is
  deleted. The registry-parity dual-mode test now runs its POSITIVE mode
  against the published dependency: an unknown future host survives codex
  install, workbuddy install and known-host uninstall end-to-end.

## 1.145.5

### Patch Changes

- 807fcab: 修正纠正词库到顶后学习通道冻结的根因：满 200 词时按证据淘汰最没用的学习词（seed/user 永不被淘汰），不再抛错；UPDATE/REMOVE 与 ADD 共用同一条词身份规则，未命中只记一次可读跳过；拒绝把动作词当 term 入库；学习不再删除 Owner 播种词；每次词库变更进 SYSTEM 日志。Stage2 回写不再用判词覆盖命中词，观察员据此拿到真实的 REMOVE 证据。

## 1.145.4

### Patch Changes

- fec1306: > Note: `@principles/pd-companion` is private and changesets-ignored; its
  > desktop release version bump (0.1.2 → 0.1.3) belongs to the companion
  > release-prep flow, not to this changeset.
  >
  > Note (RF-02, PUBLISH_BLOCKED until install-layout 0.4.0 publishes): the
  > npm-published installer resolves its install-layout dependency from the
  > registry, which still serves 0.3.x. While that holds, the installer's
  > unknown-host compatibility is REFUSE-ONLY: a manifest carrying a host the
  > dependency cannot parse makes install/merge fail closed
  > (install_manifest_malformed) instead of dropping the registration —
  > verified against the real registry resolution by the dual-mode parity test
  > in the packaged-install smoke suite. True forward-compat write-through
  > activates when this changeset's install-layout minor publishes (0.4.0) and
  > this package's range is raised to it; the local twin
  > (`src/manifest-host-union.ts`) must then be retired in favor of the shared
  > export, and the parity test flips to its positive mode automatically.
  
  Fix the PD Companion install-compatibility brick (2026-10-16): Companion 0.1.2
  bundled install-layout 0.1.0, whose parser rejected the production 3-host
  manifest (`workbuddy` unknown) as `install_manifest_malformed` — surfacing
  "未找到已安装的 PD / console_runtime_not_installed" on a healthy canonical
  install and mass-stopping every running workspace worker as
  `removed_from_manifest`.
  
  - install-layout: an unknown host string is now a structured
    `install_manifest_unknown_host` warning (parsed into
    `manifest.unknownHosts`), never a malformed manifest; `layoutVersion`
    mismatch, structural damage and illegal workspace paths stay fail-closed;
    new `installManifestHostsForPersist()` reunifies known+unknown hosts for
    writers; the parser re-reads its own output idempotently.
  - installer / workbuddy host installer / uninstaller: manifest write-backs
    carry unknown host registrations forward instead of silently unregistering
    a newer host; an uninstall keeps the shared runtime while any unknown host
    remains registered.
  - Companion: manifest reads return an explicit ok/unavailable outcome — an
    unreadable manifest holds worker state (structured
    `workspace_worker_sync_skipped` events, one Owner-visible escalation per
    episode) instead of syncing an empty list; install-layout failure causes
    are routed distinctly (incompatible layoutVersion → update-the-Companion
    page with a release link; missing install; corrupt runtime).
  - Packaging: verify-package now gates the parser extracted FROM the built
    app.asar through the manifest cross-version compatibility matrix
    (scripts/bundled-parser-compat.mjs) and records the app + bundled
    install-layout versions; companion-release runs the package test suite
    before packaging.
- 06152af: Connect Codex Owner-labelled behavior evidence to the shared internalization preflight. Reuse one validated assembler across OpenClaw, Codex and evidence attach/resume; read trajectory data without creating or migrating it and preserve host-specific semantics. Missing labels reach Owner review without model calls or attempts; missing/corrupt sources remain observable source faults.
- 33b399e: Ship the runtime profile maxTokens preservation fix in the bundled console.
- Updated dependencies [fec1306]
  - @principles/install-layout@0.4.0

## 1.145.3

### Patch Changes

- eaf52c4: PRI-980 (SPEC-PD-IAER-001): bundle refresh — this release train patches `principles-disciple` (evidence-readiness preflight, channel-aware Artificer routing, owner evidence attach/resume, run-correlation telemetry) and `@principles/host-runtime`; the installer bundles the plugin, so it must be declared in the same release plan (release-intent rule N-5/C4). No installer code changes.
- 364e37d: Console readability slice 1 (SPEC-PD-CONSOLE-READABILITY-002): fix static mojibake separators in candidate descriptions, split long rule text into short-title preview + verbatim body (newlines preserved, no bold h1 body), relabel approval record counts (no longer called behavioral evidence), rename the misleading "Edit" action to "Replace pending version", fold raw deterministic-check codes into a disclosure, and stop pasting the candidate description into the principles list "Formation Basis" block.

## 1.145.2

### Patch Changes

- 2010689: WorkBuddy installer: probe every fixed drive's standard Program Files directories when resolving the WorkBuddy engine CLI (G1, 2026-10-15). A Desktop install outside the SystemDrive's Program Files (e.g. `D:\Program Files\WorkBuddy`) previously resolved to "engine not found" — `install` skipped its engine verification and `detect` reported an absent engine on a real installation, and the real-engine isolation test silently skipped on such machines. Env overrides (`PD_WORKBUDDY_ENGINE` / `WB_ENGINE`) keep priority; Linux/CI behavior is unchanged (drive scan is win32-only).

## 1.145.1

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/install-layout@0.3.1

## 1.145.0

### Minor Changes

- 5e794be: WorkBuddy host installer (desktop marketplace registration, governance workspace init, enable/uninstall) + workbuddy-adapter payload distribution and release locks.

### Patch Changes

- 6e677f8: fix(release): 把 openclaw-plugin 的 `@principles/core` 依赖范围对齐到一个**已发布**版本。
  
  ## 问题
  
  `packages/openclaw-plugin/package.json` 声明 `"@principles/core": "^1.291.6"`，
  但 **1.291.6 从未发布到 npm**（registry 上 `@principles/core` 的 latest 仍是 1.291.5）。
  
  该范围由上一个 Version PR（#2015）的 changesets「Updated dependencies」机制自动写入，
  而那次发布从未执行，范围就此悬空。一旦某个 Version PR 把 core 继续 bump（例如 1.291.7），
  `^1.291.6` 的下界就不再等于 workspace 版本，`decidePending()` 判为 `broken`，
  `packages/openclaw-plugin/tests/package/published-host-runtime-bundle.test.ts`
  （以及 `test:host-runtime-parity`）随即抛错：
  
  ```
  @principles/core@^1.291.6 resolves to nothing on the registry and is not a
  changesets-materialized version of this workspace (1.291.7) — a genuinely
  unresolvable publish range.
  ```
  
  ## 修法
  
  把范围改为 `^1.291.5`——registry 上真实存在的版本，于是 `decidePending()` 走
  `published` 分支：套件**真实运行**（而非因 pending 窗口被跳过），实际完成
  `npm pack` → 隔离安装 → import bundle 的完整发布契约验证。
  
  这不是降低需求：`^1.291.6` 本就是 changeset 自动生成的，不代表 plugin 的真实最低
  core 版本。合并后 changesets 会在下一个 Version PR 中把该范围自动对齐到 core 的新版本。
  
  ## 附带影响
  
  `package-lock.json` 同步更新。
  
  > 注：1.291.6 / 2.1.2 这两个已 materialize 但未发布的版本仍悬在发布流程上，
  > 需要单独补发布或由 release train 处理——不在本 changeset 范围内。
- 4ba83b7: PRI-955 (R1 F11): the Console no longer equates "no failed tasks" with "the pipeline is healthy".
  
  - `GET /api/v1/failed-tasks` now returns a derived `pipeline` health block computed on read from the same state.db facts the list already uses — no new persistence, no second truth. Counts come from an exact read-only COUNT(*)/MIN/MAX aggregate scoped to learning-pipeline runner kinds (pendingCount is never a LIMIT-truncated list length; the progress timestamp ignores succeeded tasks outside the learning pipeline). Status semantics: `stalled` (work waiting, no progress inside the window), `backlogged` (work waiting, still progressing — with its own nextAction), `healthy` (nothing waiting plus fresh runner-kind progress evidence), `disabled` (internalization_auto_consumer off — learning cannot advance), `unknown` (unreadable counters or a fresh workspace with no evidence) — every non-healthy state carries a nextAction, and unknown is never reported as healthy. Status semantics: `stalled` (work waiting, no progress inside the window), `backlogged` (work waiting, still progressing), `healthy` (nothing waiting plus fresh progress evidence), `unknown` (unreadable counters or a fresh workspace with no evidence) — every non-healthy state carries a nextAction, and unknown is never reported as healthy.
  - Failed-tasks page: the empty copy no longer claims "PD 管道运行正常"; it states the fact ("当前查询范围内没有失败任务") and renders the learning-queue health card (both zh-CN and en). The card also renders above the list when tasks exist.
  
  Dogfood evidence (2026-10-13, F11): a 13-deep philosopher backlog starving for 35+ minutes was reported by this page as "没有失败任务。PD 管道运行正常。"
- 8f9e870: PRI-956 (R1 F15): the principles review page discloses runtime revocation instead of implying "in effect" from the ledger's asset status.
  
  - Background (Owner-adjudicated): the ledger `status` is an ASSET lifecycle with no deactivated value — a deactivated principle stays `active` there forever, while the runtime authority is the activations table (verified: after Owner deactivation, new sessions inject zero activations). The review page classified ledger-`active` as "approved & in effect" and its cross-check queried approvals rather than activations, so the two governance pages could disagree.
  - Change: `GET /api/v1/principles` items now carry `runtimeDeactivated: true` when the activations table reports a deactivated activation targeting the principle (read-only query; degrades with a reason). The review page renders a "运行时已停用 / Runtime Revoked" badge next to the governance decision. No second write authority is introduced; the ledger status semantics are unchanged (no deactivate→ledger sync), and the classification bucket is unchanged.
  - Regression: `pd health --host codex`-style cross-new-session revocation checks remain covered by the structured injection events (runtime_v2_prompt_activations_injected injectedCount); a full browser approve→activate→inject→deactivate→no-inject regression runs in the R1 acceptance report.
- Updated dependencies [5e794be]
  - @principles/install-layout@0.3.0

## 1.144.28

### Patch Changes

- 9fb95ff: chore(deps): bump tailwind-merge 3.6.0 -> 3.7.0（#2007；@principles/pd-console 运行时 dependency，打进 console bundle 随 installer 工件分发）。
- 06b46b0: chore(deps): bump sonner 2.0.7 -> 2.0.8（#2009；@principles/pd-console 运行时 dependency，打进 console bundle 随 installer 工件分发）。
- a6b824d: chore(deps): bump js-yaml 5.4.2 -> 5.4.3（#2010，installer 自身 lockfile）。js-yaml 是 create-principles-disciple 的运行时 dependency，随发布工件分发，故声明 patch。
- 69fa3f3: chore(deps): bump js-yaml 5.4.1 -> 5.4.3（#2011）。js-yaml 是 core / host-runtime / plugin / pd-cli / console 的运行时 dependency，console 随 installer 分发，故这 4 个可发布包与 installer 各声明 patch。

## 1.144.27

### Patch Changes

- 6317a63: Keep unresolved content references unresolved across evidence replays (Phase 1 closeout review P2-2). The evidence producers treated the STORED contentRef as an opaque truthy object when rebuilding an observation for a replayed source event: an already-stored `revision_reference_unresolved` reference (no payloadDigest — e.g. an activation whose artifact is missing) was re-emitted as `resolution: 'resolved'` without a digest. The normalizer rejects `resolved`-without-digest before the store's idempotent dedup branch runs, so replaying the SAME source event failed with `observation_contentRef_resolved_requires_payloadDigest` instead of landing as an idempotent duplicate — "record count unchanged" was the result of rejection, not idempotency (the real 2026-10-11 replay probe hit exactly this). Resolution is now upgraded to `resolved` only when a payloadDigest is actually present; digest-carrying (resolved) replays keep their digest and dedup as before. Fixed at all four producer sites (Codex prompt delivery + Codex deny chain, OpenClaw prompt delivery + gate enforcement chain); validator, oracle, and store semantics unchanged. `create-principles-disciple` rides along because the installer bundles the plugin. Regression tests drive the real recorder → ingress → store boundary on both hosts: unresolved first-record + replay lands as `duplicateCount: 1` with the original resolution preserved, and a new ingress boundary test pins digest-less-batch replay as an idempotent duplicate plus same-key-different-content as a reported conflict.

## 1.144.26

### Patch Changes

- c111135: Console UI upgrade (SPEC-PD-UIUX-001): honest receipt semantics (0/0 no longer claims "already in context"), Focus reading order with conclusion-first layout and deduped decision inbox, narrow-screen drawer navigation replacing the fixed 256px sidebar, keyboard skip-link that keeps the HashRouter route, danger/contrast token fixes including the dark-mode Welcome button, and full EN/ZH localization with document language sync.

## 1.144.25

### Patch Changes

- 4e38342: Phase 1 acceptance: empty release declaration — this PR is test/documentation only (new intervention-evidence BDD feature + step definitions for pd-console; no production source changes).

## 1.144.24

### Patch Changes

- 3bc01f3: PRI-948: the Owner can finally leave a reason when approving a Principle. The approve action's optional `note` requirement was declared by the owner-decision contract and accepted by the approvals route (`approvals.decision_note`), but the Console confirmation panel never rendered the field and the call site dropped it — so `decision_note` stayed empty forever and approval rationale had no archive. The panel now renders a requirement-driven note textarea (visible and editable, still optional — confirm is not gated on it) and forwards the trimmed note through `approveApproval(approvalId, note)`. Ships the pd-console fix inside the installer package (pd-console is private).

## 1.144.23

### Patch Changes

- f4b7599: PRI-896, PRI-897: the update recovery surface stops alarming forever on residue that the product has already outlived, and a sealed transaction journal can no longer be overwritten by a retry. `GET /api/update/recovery` now consults the product's own verdict (`recoverUnfinishedTransaction`, PRI-853) before labelling a non-terminal journal as needing recovery: a crash orphan that the live `active.json` generation proves was superseded (`old_confirmed`) is reported separately in the new `superseded` field instead of holding the Owner's attention, while a missing/corrupt active record or an interrupted activation (`explicit_refusal`) keeps alarming — demotion is evidence-gated, never a blanket mute. `ReleaseManager.apply()` now refuses to append a second attempt onto an existing journal file (new `journal_sealed` refusal, raised before any side effect), which previously broke whole-file sequence validation and marked even an earlier `confirmed` update in that file as corrupt forever. Ships the pd-console fix inside the installer package (pd-console is private).

## 1.144.22

### Patch Changes

- 8a72441: Re-drive the npm release train so the product 2.3.0 component cohort actually ships (PRI-874).
  
  The Version Packages PR for this cohort merged and auto-dispatched its train, but every matrix leg failed inside the real-upgrade gate with `Cannot decrement patch of version 2.1.0`: the gate's local N-1 baseline helper could only step a patch number down, and ADR-0027 had just moved the plugin to a minor landing (`2.1.0`, patch tail 0). The gate fixture therefore rejected a legitimate release input, Publish and Finalize were skipped, and nothing reached the registry — `@principles/core`, `@principles/pd-cli`, `@principles/host-runtime`, `principles-disciple` and `@principles/codex-adapter` all stayed at their previous published versions even though their new versions are already committed on main.
  
  The fixture itself is fixed on main by `previousReleaseVersion()` (test-only, no shipped code). That fix cannot be retrofitted onto the already-dispatched cohort, because the release matrix runs the gate test from the cohort's own tree by design (G5, SPEC §17.1) and the cohort resolver only accepts a Version Packages PR merge commit. This changeset is the release intent that materializes a new cohort carrying both the committed versions and the corrected gate, so the pending component releases publish.

## 1.144.21

### Patch Changes

- d5732f8: PD v2 Phase 1 Evidence Foundation (ADR-0027): normalized intervention evidence ledger.
  
  - core: intervention evidence contract + deterministic normalizer (rc-1..rc-5 trust boundary, anti-forgery cross-field rules), append-only SQLite ledger tables inside the existing state.db (idempotent same-source replay, reported source conflicts, immutable records, activation occurrence snapshots), busyTimeoutMs connection option, and the four-query audit read contract.
  - host-runtime: shared intervention evidence ingress — the single validated entry every host source uses; never throws, never waits on locks (busyTimeoutMs 0), degrades with structured reason + nextAction.
  - openclaw-plugin (principles-disciple): evidence wiring on both legacy and shared routes — prompt delivery attempts (submitted/attempted, host consumption never claimed), enforcement chains on gate block/auto-correct (runtime_loaded delivery, runtime_verified application with explicit proof boundary, episode, effect), agent_claimed self-report mirroring; gated by the existing principle_receipt_ledger flag.
  - codex-adapter: evidence adapter on the shared ingress — UserPromptSubmit delivery attempts after the durable event-log line, deny chains recorded only after successful stdout encoding; honest capability matrix (self_report Unsupported, enforcement Unknown per PRI-780).
  - create-principles-disciple (ships pd-console): four read-only evidence-audit queries under /api/v1/receipts/evidence-audit plus the authenticated Owner outcome input POST /api/v1/evidence/outcomes (closed body contract, server-derived actor), and an evidence-audit section on the principle detail page.
  
  No effectiveness scoring, ranking, or automatic governance action anywhere (Phase 1 records facts only).
- 0b981bb: 提示词容量与生效反馈修复（PD_PROMPT_CAPACITY_V1，阶段 A/B1/B2/C）：
  
  - core：`listEntryLine` 列表行格式单一权威；prompt 版本替换——dispatcher `supersedeActivationId` 通道 + state store 单事务 `replacePromptActivation`（新激活+不可变 supersede 决策+旧版停用，故障回滚不留双活）；`detectPromptReplacementTarget` / `buildOwnerRevisionArtifact`（复用真实 Scribe 内容合同）；Scribe prompt v5 正文最短充分要求。
  - host-runtime：宿主事实绑定的有效注入路由解析（声明∪pain_events，Codex 恒共享、OpenClaw 按 flag、未知不猜测）；投影合同扩展（unit/计费范围/超长透传/诊断截断标记）；单一 `checkPromptArtifactDeliverability` 写入前预检；激活级注入状态读取；注入事件诚实读模型（无日志=unknown 非零）。
  - pd-cli：`pd activation approve --target-host` + prompt 写入前容量门（拒绝零写入、单一 JSON、结构化 nextAction）。
  - console（随 create-principles-disciple 发布）：审批预检门与 422 拒绝、未确认宿主横幅与请求级目标宿主、激活页注入状态与「修改为可注入版本」入口、替换事务 UX。

## 1.144.20

### Patch Changes

- 64c3111: PRI-947: the Owner approval second step now appears where the Owner is looking. Clicking 批准 on a principle detail page expanded the confirmation panel as the last node of the whole page, below the fold and with no scroll/focus/toast, so the click looked dead; the panel now renders inside the decision region that owns the action buttons, and a Playwright regression test asserts the panel lands in that region and that the first click performs no write. Ships the pd-console fix inside the installer package (pd-console is private).

## 1.144.19

### Patch Changes

- ac46818: PRI-945 — uninstall deletion gates now detect the filesystem entry itself
  (lstat), not its resolved target (existsSync). A dangling symlink/junction
  under `~/.pd` (releases/, staging/, backups/, a dangling active.json) or the
  shared runtime dir, or the plugin extension junction, was previously silently
  skipped — existsSync follows the link to a missing target and returns false —
  so uninstall reported success while stranding the broken link on disk. Each
  removal gate now reclaims the leftover entry, and the remover (fs.rm with
  recursive+force) unlinks it without ever following or deleting the target. The
  CLI `--check` status still reports a dangling link as "missing" (preserved on
  purpose), so only the actual teardown reclaims it.

## 1.144.18

### Patch Changes

- ce5cfc7: PRI-944 — an update or install no longer aborts because `openclaw gateway stop`
  was slow. The gateway stop was decided by the exit code of a 15s `cmd.exe /c`
  wrapper: when the wrapper timed out while the service manager was still closing
  the gateway, the installer concluded "refused to stop" and refused the whole
  run before touching anything — on the reported host that voided a signed-channel
  update at the `verified` stage. `stopOpenClawGateway` now decides by the EFFECT:
  after a failed stop it waits (bounded, 30s, 1s polls) until the observed gateway
  port has no listener and the observed PID has exited, and only then lets the run
  proceed. A refusal is classified so the operator instruction matches reality:
  `gateway_still_running` (verified still listening — stop it by hand),
  `stop_confirmation_timeout` (port cleared, process lingering — wait and retry),
  `verification_unavailable` (nothing observable — refused, never assumed). The
  start leg is deliberately unchanged: its failure is a notification, and a cold
  start measures in minutes.

## 1.144.17

### Patch Changes

- a5d069b: Uninstall no longer tells the user to "manually delete" the personal data it
  just promised to preserve. The post-uninstall hint (.principles/.state, MD
  files) previously read like a cleanup instruction for the same retained
  governance directories, risking accidental deletion of data meant to survive a
  reinstall. The hint now states the files are intentionally preserved and need
  no manual action (PRI-893).
- 3a26f30: PRI-894 + PRI-895 — uninstall reclaims ~/.pd update residue on full shared-runtime teardown. When the last host is uninstalled, `uninstall` now removes staging/, releases/ and backups/ (a GB-scale disk leak) and a dangling active.json that still pointed at a deleted release, after the runtime directory itself is gone and before install.json is removed. Deletion is provably bounded to those three update directories plus the pointer (never a glob of ~/.pd/), so transactions/, logs/, trust/, channels/ and bootstrap/ are left untouched. A corrupt active.json is preserved with an observable note; a partial (single-host) uninstall preserves all residue; and install.json is kept when reclaim fails so a re-run retries instead of stranding the residue.

## 1.144.16

### Patch Changes

- 34ba089: Console approval cards no longer render the internal `unlinked:<artifactId>`
  machine id as the card title on the second path that still produced it
  (PRI-941). PRI-940 closed the case where the pinned draft artifact has left the
  artifact store; an artifact row that still exists can degrade the same way — its
  content yields no extractable description and its lineage resolves to nothing,
  so the grouping key becomes `unlinked:<artifactId>` while `artifactUnavailable`
  stays unset, and that machine id was used as the Owner-visible title. The UI
  title rule now refuses any title shaped like the synthesized grouping key, and a
  card whose title actually degraded states both reasons ("lineage cannot be
  resolved to a principle, and no readable title could be extracted from its
  stored content") instead of going blank without explanation — a candidate that
  does have a readable title gets no warning. `artifactUnavailable` keeps its
  original meaning: the PRI-940 wire contract still asserts that an existing
  artifact carries no such flag. Approve/edit/reject behavior, the `unlinked:`
  grouping key and the ledger itself are unchanged.
- c66c956: Two "view the full evidence chain" links in the console now open a page instead
  of a blank screen (PRI-942). Both pointed at `/evidence`, a route that has never
  been registered: the console's inner route table has no wildcard fallback, so the
  sidebar stayed put while `<main>` rendered nothing — the link looked like a
  failure of the evidence chain rather than a dead address. They now point at
  `/pain`, the only page in the product that actually fetches and renders the
  evidence chain, and it needs no id, so it cannot 404 and never puts a machine
  identifier in the URL. A new static guard in the navigation test walks every
  in-app link the console UI writes with a visible path: literal `to` targets in
  all their quote forms, plus the static part of a target that only becomes dynamic
  after an interpolation marker. Each must resolve against the route table App.tsx
  already publishes, so the next dead link fails CI instead of showing up as an
  empty panel. Landing is not anchored to the individual candidate yet (it opens
  the top of the chain list); per-candidate anchoring is tracked separately.

## 1.144.15

### Patch Changes

- 7d1daef: PRI-926: update history reconciliation now tells the truth. The ReleaseManager journals `preUpdateProductVersion` on the planned transition (from the active record), reconciliation derives `fromVersion` from it (absence stays `unknown`), only journals in the ReleaseManager update domain synthesize Owner-facing rows (wrongly-projected install-domain rows are dropped), timestamps come from the journal's first line instead of the scan moment, and synthesized ids are deterministic (`reconciled-<transactionId>`) so cap-evicted rows cannot resurrect as duplicates. Ships the pd-console reconciliation fix inside the installer package (pd-console is private).

## 1.144.14

### Patch Changes

- 71c8c93: Console approval cards no longer render the internal `unlinked:<artifactId>`
  machine id as the card title when the pinned draft artifact has left the
  artifact store (PRI-940). Real case: a pending approval pinned to a scribe
  revision that a later run superseded showed `unlinked:pi-art-scribe-…` as the
  card title, and the Owner could not tell what the card was about. The grouped
  model now reports `artifactUnavailable` for such cards; the UI replaces the
  machine id with the localized untitled copy and shows a visible note
  explaining that the draft original is gone (likely superseded), that
  rejecting is a safe choice, and where the raw artifact ID remains reachable
  (the edit section's current-artifact field). Approve/edit/reject behavior
  and the `unlinked:` grouping key are unchanged.

## 1.144.13

### Patch Changes

- 5c763b2: chore(deps): bump fs-extra 11.4.0 -> 11.4.1（installer 运行时依赖，随 create-principles-disciple tarball 一起分发，故声明 cpd patch）。
- df9e555: PRI-917 v0.3.3 (OD-PRI917-05): Reuse Review Gate — automatic candidate intake now consults the semantic reuse evaluation capability before creating a Principle.
  
  A `reuse` recommendation parks the candidate (`refused/reuse_pending_owner`): no Principle is written, no evidence is appended, the candidate stays pending for the Owner, and the bridge emits an observable `reuse_gate_triggered` event plus a `reuse_review_required` outcome pointing at `pd candidate review --decide reuse|create`. `create`/`uncertain` recommendations and every evaluation failure degrade to normal creation (learning never blocks). `reuseEvaluation.enabled=false` restores the exact pre-v0.3.3 behavior.
  
  Also fixes the R5 "two-heads-block" defect: `pd candidate review --decide reuse` no longer lets the PRI-442 admission pre-check reject low-confidence candidates — a reuse verdict creates nothing, so the ledger-quality gate does not apply (the `--decide create` pre-check is unchanged).
  
  PR review fixes (4×P2, PRI-938): the bridge cache key now folds in the reuse-gate switch so a long-lived host picks up `reuseEvaluation.enabled` toggles in both directions (T11 rollback without a restart); mixed batches and replays keep parked candidates visible (`reuse_review_required` degraded outcome, Codex worker `reuseReviewRequiredCandidateIds`, OpenClaw `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` log gated on the park disposition); `pd diagnose` / `pd pain-retry` render parked candidates with review guidance and exclude them from `internalize` next-action lists.
  
  Follow-up review fixes: evaluation profile and timeout changes invalidate the cached reuse hook. Replay verifies the original diagnosis admission and performs a read-only reuse check before reporting a parked candidate, preserving failed-intake and gate-disabled behavior without additional persisted state.
  
  Owner-approved configuration hardening: constructing CandidateIntakeService with both reuseRecommendation and reuseDecision now fails explicitly before either callback or any candidate mutation, instead of silently prioritizing the decision channel.

## 1.144.12

### Patch Changes

- 349b747: chore(deps): bump @fontsource/jetbrains-mono 5.2.8 -> 5.3.0 (pd-console，随 installer 分发)。
- 9fc1a31: chore(deps-dev): bump @types/node 26.6.1 -> 26.6.2 in create-principles-disciple.
- a438282: chore(deps): bump @principles/install-layout 0.2.4 -> 0.2.7 in create-principles-disciple（同步 cpd package-lock）。
- 47fad14: chore(deps-dev): bump vitest 5.0.1 -> 5.0.2 in create-principles-disciple.

## 1.144.11

### Patch Changes

- 25e8562: The Console's update page no longer reports "Request timeout" on a slow
  metadata host. `GET /api/update/check` refreshes the signed channel over the
  network — TUF metadata, the channel document and the release metadata, several
  sequential requests to the release metadata host — and it was running under the
  generic 10-second request budget. Measured against GitHub Pages from a CN
  network, the same request completes in ~1.2s most of the time and in ~12.5s
  about one run in five, so the page failed intermittently while the installation
  itself was healthy and already up to date.
  
  The check route now has its own 30-second budget, overridable with
  `PD_UPDATE_CHECK_TIMEOUT_MS` (milliseconds) exactly like the existing
  `PD_UPDATE_APPLY_FULL_TIMEOUT_MS` knob for slow disks and networks. A refused
  value falls back to the default with one observable log line. The check stays
  read-only: a timeout never leaves a partial update behind.
- 7421049: The console's prompt-injection budget forecast now mirrors the production
  selection policy instead of silently defaulting to the legacy FIFO prefix
  (PRI-935). The forecast previously called the budget selector without its
  round key, which did not make it conservative — it selected a different
  policy, one that structurally excludes the newest activation from every
  truncated selection. The console therefore told the Owner an approved
  principle "will NOT enter agent behavior until older ones are deactivated"
  while the live injection path rotates and injects it within a bounded number
  of user turns, pushing Owners to deactivate healthy principles.
  
  buildLivePromptInjectionProjection now accepts the caller's round key and
  reports the policy it actually ran, the eligible count, whether production
  rotates on this route, and the set of activations reachable under some round.
  Reachability is a property of the policy rather than of a single round, so a
  console with no session round key can still distinguish an activation that is
  merely rotated out of the current window from one that is genuinely starved.
  Approve now emits injection_budget_queued for the queued case — with a bounded
  "within at most N consecutive user turns" statement and an explicit note that
  deactivating older principles is not required — and reserves
  injection_budget_excluded for real starvation, no longer asserting a FIFO
  ordering the production route does not use. The pre-decision queue badge and
  both locales follow the same policy, and the raw English server text is
  collapsed behind a native details element so the toast no longer renders as one
  mixed Chinese/English block (still preserved verbatim).
  
  The shared host route deliberately passes no round key and continues to report
  legacy_fifo_prefix_v1, so cross-host fairness remains PRI-930 and is not
  claimed here. All new projection fields are optional; payloads without them
  validate as before and render policy-agnostic copy.

## 1.144.10

### Patch Changes

- 276efe4: A workspace pointer that does not name one fixed directory is no longer
  resolved. A value that lost its separators in transit —
  `"D:.openclawworkspace"` for `D:\.openclaw\workspace` — used to be handed to
  `path.resolve()`, which turned it into a plausible absolute path that depends
  on the process working directory; a root-relative value such as `\workspace`
  was anchored to whichever drive the caller was on. The same config could then
  send governance state (`.pd/state.db`, `.state/trajectory.db`) to a different
  directory depending on which process read it, with no warning.
  
  The plugin now skips such a candidate, continues with the next declared source
  (env > config > default is unchanged), and logs the refusal together with the
  source it fell back to. The installer refuses such a workspace before any side
  effect, rather than only when writing the config pointer. Values that carry
  their own drive, or a UNC share, are unaffected (PRI-931).

## 1.144.9

### Patch Changes

- 50ed22e: Prompt principle injection now rotates deterministically under the fixed
  2000-char budget instead of always packing the oldest prefix, so a live,
  eligible, individually-fitting principle can no longer be permanently starved
  by its position (PRI-904). The rotation round is the session-local user-turn
  ordinal already persisted in the trajectory database — an existing fact, read
  through the registered trajectory-store seam — so consecutive rounds advance
  by exactly one and N rounds cover all N eligible positions: a bounded
  opportunity window with no new persisted scheduling state, no randomness and
  no clock. Non-fitting entries no longer terminate the scan; oversized entries
  are reported separately; the injection event carries selectionPolicy,
  eligibleCount, rotationStartIndex, the round ordinal that produced the
  selection, and schema-bounded dropped/oversized activation id lists (max 16)
  so truncation is explainable and traceable. The legacy FIFO prefix behavior
  remains the rollback baseline whenever no round ordinal is available.

## 1.144.8

### Patch Changes

- e1fda67: The update chain now refuses a non-HTTPS release-asset URL outright, re-checks
  HTTPS on every redirect hop it follows (a carrier can no longer downgrade the
  delivery to plaintext with a 302), and publishes verified asset bytes to their
  canonical staging name only through a private, exclusively-created candidate
  plus an atomic rename, so a plaintext carrier can no longer poison every
  delivery and an unverified file can never be reachable under the name the
  installer deploys from (PRI-927).

## 1.144.7

### Patch Changes

- 1f4faf2: Update apply now survives a transient release-asset download failure (bounded
  retry with backoff) and recycles the transaction's staging directory when the
  journal reaches a terminal state, so failed and successful updates no longer
  leave ~1.3GB per attempt on the customer's disk (PRI-924).

## 1.144.6

### Patch Changes

- 12a5139: PRI-922: retire the previous.json ghost slot. The update-chain layout no longer
  declares a second pointer, recoverUnfinishedTransaction takes only the journal
  plus the active record, and the console recovery endpoint (bundled via this
  package) never reads previous.json. Production install/upgrade/rollback/repair
  behavior is unchanged for normal installation layouts, where the file has had
  no writer since 2026-08-26 and therefore never exists; on a machine with a
  leftover or hand-crafted previous.json, recovery decisions now deliberately
  ignore it (a fabricated record could previously sway them — closed by
  regression tests proving previous.json is not a recovery input).

## 1.144.5

### Patch Changes

- 4726620: feat(installer): PRI-912 canonical junction reconciliation for plugin @principles/core copies
  
  After all components deploy and before the journal 'staged' transition, the
  installer replaces a materialized <plugin>/node_modules/@principles/core
  copy with a junction (Windows) / relative symlink (Unix) to the runtime root
  core — only when the package identity, the plugin manifest's declared file:
  dependency resolving to the canonical core, and the full content digest all
  match. Gate failures skip with a structured reason; a failed conversion
  restores the copy; idempotent across repairs.

## 1.144.4

### Patch Changes

- 176a9a2: build: prune unused better-sqlite3 platform binaries from release assets
  
  Self-contained release assets now keep only the better-sqlite3 prebuild for
  the asset's own platform+arch (linux: musl detected from the build machine,
  which is also the target since cross-builds are refused). Foreign-platform
  `.node` files are removed from every materialized copy after staging and
  before `_release/manifest.json` is generated, so the signed manifest always
  describes the pruned tree. Measured saving on a real win32-x64 build:
  104,349,056 B (99.5 MiB) across 7 copies per platform asset; installer
  dependency resolution, package topology and runtime behavior are unchanged.

## 1.144.3

### Patch Changes

- 4ced615: OPT-002 (runtime-v2 barrel narrowing): the plugin's satellite bundles no longer pull the LLM SDK graph. Six shared plugin modules switched their VALUE imports from the `@principles/core/runtime-v2` barrel to the eight narrow leaf subpaths (type-only barrel imports unchanged; exported names unchanged), and `@principles/core` exports gained those additive subpaths (`./runtime-v2/store/workspace-leak-guard`, `./runtime-v2/feedback/redact-sensitive`, `./runtime-v2/types/event-types`, `./runtime-v2/trajectory-schema`, `./runtime-v2/internalization/{rule-host-input-builder,rule-context-v2,behavior-example-pack,tool-semantic-registry}`). governance-audit.js drops 2,783,013 → 70,786 bytes (−97.5%) and rulehost-evidence.js 2,826,401 → 60,244 bytes (−97.9%); bundle.js is byte-identical (4,151,557) — the main package keeps its LLM runtime through its own direct barrel import. `runtime-v2/index.ts` and all existing exports are untouched. A build-level satellite purity guard (`scripts/build/check-satellite-purity.mjs`, wired into `esbuild.config.js`) now fails any plugin bundle build that reintroduces pi-ai / pi-agent-core / anthropic / openai / genai / undici inputs into the satellite outputs, so the invariant no longer rests on discipline alone.

## 1.144.2

### Patch Changes

- fc1c9de: OPT-001 (artifact-size audit P1): releases now ship the production console web bundle. The pd-console `build` script (used by every official path — installer bundling, release-metadata, publish action, reproducibility, CI smokes) runs the UI step as `build:ui:production` (esbuild minify, no inline sourcemap): app.js drops from 8.6 MiB to 1.1 MiB, shrinking the installer payload by ~7.6 MiB. The bundler script additionally fails loud if a dev-mode app.js (sourceMappingURL marker) ever reaches the payload again. Local dev and console e2e keep using `build:ui` (dev) unchanged.
- c7453ea: PR #1844 follow-up: the Governance Focus prompt-injection forecast and the PRI-890 approve-time budget check now read `buildLivePromptInjectionProjection` (host-runtime), which follows the SAME injection route the agent uses — with `abstraction_layer_v1` off (the live default) the forecast replays the plugin's PromptActivationReader → trimToBudget chain instead of always rendering with the shared-path directive wrapper. Previously a saturated 2000-char budget was over-forecast (~3/11 principles "injected" vs the real 9/11), so the Focus page badge and approve warnings overstated budget pressure. Principle selection, FIFO ordering, injection behavior and the budget algorithm are unchanged; parity and boundary regression tests pin the projection to the live path.
- 38b86f6: PRI-889: Governance Focus now renders the existing PendingReviewCard (Wave 7 component with approve/reject/revise actions) for pending approval groups, giving Owners their first clickable activation-approval path in the browser. When grouped approvals data is available, activation_approval entries skip the legacy OwnerDecisionCard (its only affordance was a dead CTA); when unavailable, all entries keep rendering so decisions never silently disappear. The card honors the PRI-787 governance-readiness lock with a visible reason.
- 5fc33bd: PRI-890: approve now recomputes the production prompt injection projection (same FIFO + 2000-char budget logic the prompt hook uses) and surfaces a non-fatal warning when the freshly approved prompt-channel activation lands outside the budget — previously the approval silently never reached agent behavior when the budget was saturated (PRI-768 v6-02). Non-budget exclusions (artifact resolution failures) are reported with their own reason code, and the Governance Focus approve flow shows the warning toast so the Owner sees it at decision time.
- 84c7074: PRI-892: fixed the silent no-op of `npx create-principles-disciple` on Windows. Node resolves the main module through symlinks/junctions while `process.argv[1]` keeps the unresolved link path handed over by npm/npx `.bin` shims, so the raw `pathToFileURL(argv[1]) === import.meta.url` entry guard never matched and the CLI exited 0 with zero output (install / repair-update-chain / uninstall all dead). The guard now canonicalizes argv[1] with `realpathSync` before comparing (fail-safe: an unreadable entry is simply not the main module), keeps the cli-7 import-safety semantics (importing the module still never parses argv), and adds an rc-9 observable fallback: when the entry path unambiguously names this package's `dist/index.js` but canonicalization still misses, the CLI warns on stderr instead of saying nothing. The identical guard in the Codex `pd-hook` entry is fixed the same way (linked installs previously skipped `main()` silently). Regression tests spawn the built CLI and hook through a junction path and assert real output (red before the fix: empty stdout, exit 0).
- edaae75: Fix PRI-898: the global `pd` command is no longer gated on the npm-distributed payload mode, and the Windows shim set now reaches every shell.
  
  - Decoupling: self-contained release-asset installs (the recommended channel) now write the global `pd` shim into the PATH-managed npm global bin dir, so the host agent finds `pd` without manual PATH edits.
  - Windows coverage: in addition to `pd.cmd` (cmd) and `pd.ps1` (PowerShell), the installer writes an extensionless `pd` sh shim — Git Bash/MSYS does not apply PATHEXT, so a bare `pd` only resolves to that exact-named file. Without it a Git Bash host got command-not-found even with the `.cmd` on PATH.
  - Shim path quoting: the sh forwarding shim embeds its target path in POSIX single quotes, so an install directory containing spaces, `$`, backticks or an apostrophe resolves literally instead of being expanded or breaking out of the quote (the previous double-quote form only escaped `"`).
  
  Foreign-`pd` protection, rollback bookkeeping, the uninstaller scan (now also cleaning the extensionless `pd` on Windows), and the `PD_SKIP_GLOBAL_SHIM` smoke gate are unchanged; the pd-cli upgrade / dependency-resolution payload-mode gates stay where they belong.
- edbbcd9: RAH-3 (PRI-907): complete the release-artifact content boundary. @principles/install-layout and principles-disciple (openclaw-plugin) production builds now exclude compiled tests (tsconfig.build.json; plugin build:types declaration emit filtered too) with the same fail-loud dist hygiene assertion as RAH-1. The installer bundle script (create-principles-disciple) filters compiled test artifacts out of every payload copy AND asserts zero test artifacts across all payload components after materialization — test code can no longer reach user machines even if a future package forgets its build-boundary guard. A repo-level scan (check:workspace-artifacts, wired into verify:merge) backstops all workspace dist trees.
- 8b7b775: Security audit run-1 remediation (findings verified against eabbde6d, applied on ccc69252):
  
  - **RuleCode enforcement is now content-bound** (audit HIGH `rulecode-approval-content-unbound`): the production gate and the OpenClaw plugin RuleHost re-verify the current `pi_artifacts` row against the `activation_decisions.artifact_digest` recorded at Owner promotion time before compiling it. A workspace-local rewrite of `content_json` (or lineage fields) is now skipped with a structured `artifact_content_tampered` warning instead of silently executing unapproved code. Rows without a recorded decision (legacy activations) keep their prior behavior. Adds `mapPiArtifactRow`/`PiArtifactRow` exports (the single `pi_artifacts` row→snapshot mapping) so enforcement reproduces the promotion-time digest byte-for-byte.
  - **Replay evaluate is hard-bounded** (audit MEDIUM `rulecode.replay.in-process-evaluate-no-hard-timeout`): pre-activation replay runs each evaluate call through a precompiled vm script with a 2000ms hard timeout — a looping LLM-authored candidate now fails its replay case instead of hanging the console server, evaluator worker, or CLI process.
  - **Governance-store unavailability leaves a durable trace** (audit MEDIUM `gate-failopen-allow-on-state-corruption`): when `state.db` is missing or unreadable, the gate/plugin record a best-effort marker under `~/.pd/enforcement-health/` (outside the agent-writable workspace), and the console governance read model distinguishes "state.db deleted after initialization — enforcement degraded (fail-open)" from a never-initialized workspace.
  - **Console refuses unauthenticated non-loopback binds** (audit MEDIUM `pd-console-noauth-nonloopback-bind`): the loopback-only invariant now keys on the effective authentication state (token-less default included), not just the explicit `--no-auth` flag.
  - **Plugin honors an explicit conversation-access opt-out** (audit LOW `openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out`): the auto-fix repairs only an absent `allowConversationAccess` flag; an explicit `false` (the documented turn-off) is preserved and surfaced as an honored Owner opt-out instead of being silently rewritten on every gateway start.
- Updated dependencies [edbbcd9]
  - @principles/install-layout@0.2.7

## 1.144.1

### Patch Changes

- 0d39045: chore(deps-dev): bump @types/node 26.5.1 -> 26.6.1 in create-principles-disciple.
- 6b05c87: chore(deps): bump @radix-ui/react-slot 1.3.0 -> 1.3.3 (pd-console, ships inside installer).
- 78a3564: chore(deps): bump js-yaml 5.4.1 -> 5.4.2 in create-principles-disciple (runtime dependency).
- 3587170: chore(deps): bump @radix-ui/react-dialog 1.1.15 -> 1.1.23 (pd-console, ships inside installer).
- 7f5558b: chore(deps-dev): bump vitest 5.0.0 -> 5.0.1 in create-principles-disciple.
- 76ed7d0: chore(deps): bump react/react-dom/@types to 19.3.0 (pd-console, ships inside installer). 单独 bump react-dom 会使 react<->react-dom 版本错配导致 Console 白屏（e2e useMemo of null），故本 PR 配对升级 react 与 @types/react.

## 1.144.0

### Minor Changes

- 8424d60: Baseline-cutover accounting for the unpublished source delta between the registry baseline (1.143.3, published from fb397452) and current main: the update-chain rework landed by PR #1768 (bootstrap executor, transaction journal, release-manager authority, dual-ABI payload application, embedded product identity stamp, public exports) plus the pd-console payload changes it ships (owner-decision UI and console surface updates). The version alignment to 1.143.3 is a starting point, not a claim this content shipped.

### Patch Changes

- 40de641: Owner-facing console fixes carried by PR #1789 (focus CTA deep-links), which merged after the Changesets cutover and was not yet in release accounting. The pd-console payload bundled by the installer now: deep-links owner-decision and grouped-approval CTAs to the specific Principle record instead of the generic review list (activation_approval inbox items carry a resolved `principleId`; on resolution failure they fall back to the prior un-deep-linked behavior, rc-9); re-applies the ledger-validation contract that was silently dropped when the shared artifact→principleId resolver was extracted (ERR-142); and escapes externally-supplied values interpolated into CSS deep-link selectors to close a selector-injection path (ERR-143). Installer bundle content is new, so the installer needs a release.

## 1.10.0

### Minor Changes

- 650ae5a: ## v1.9.1: WebUI Data Source Fixes

  ### Phase 16-20 Complete

  - **Phase 16**: Data Source Tracing - mapped all 4 WebUI pages to API endpoints
  - **Phase 17**: Overview Page Fix - fixed `/api/central/overview`, `/api/overview`, `/api/overview/health`
  - **Phase 18**: Loop/Samples + Feedback Fix - fixed `/api/samples`, `/api/feedback/*` data sources
  - **Phase 19**: Gate Monitor Frontend - fixed `/api/gate/stats`, `/api/gate/blocks` types
  - **Phase 20**: E2E Validation - 19 regression tests added for all API endpoints

  ### Bug Fixes

  - Fixed `evolution-worker.ts` missing `runtimeAdapter` parameter
  - Fixed `nocturnal-train.ts` mode field type annotation
  - Fixed `sync-version.sh` to include `create-principles-disciple` package

  ### Infrastructure

  - Added `@changesets/cli` for monorepo version management
  - Added `data-endpoints-regression.test.ts` with 19 tests
