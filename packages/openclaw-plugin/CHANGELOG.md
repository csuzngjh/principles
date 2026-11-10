# principles-disciple

## 3.1.5

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

## 3.1.4

### Patch Changes

- 698de3f: feat(principles-core): PRI-1161 hoist the per-block directive boilerplate into the shared header
  
  The shared directive renderer (`renderPrinciplesToDirectives`) no longer repeats "Apply this as an active behavior constraint. Do not treat this as background context." inside every directive block; the instruction is stated once in the shared header ("These directives are mandatory active behavior constraints for this session, not background context, unless they conflict with safety, security, or higher-priority system policy."). Per-principle body, directive id, authority attribute, escaping and the `<directive>` slice boundaries are unchanged; budget arithmetic stays exact because `measureSharedDirectiveBlockChars` / `sharedDirectiveBaseChars` derive from the same builders (header +53, each block −86). Selection/refill changes under tight budgets are explained by the unchanged packing rule. Goldens and tuned fixtures updated to the new renderer bytes.

## 3.1.3

### Patch Changes

- 6b5a4cc: Adaptive Activation config compat: declare the `principleId` mapping identity in the plugin manifest `configSchema` (`adaptiveActivation.properties`, `additionalProperties: false` retained). The #2436 runtime reader already accepted this key, but the undeclared key made any principleId config fail the host's load-time plugin-config validation and take down the entire plugin (PRI-1119 PR #2448 blocker 2). Legacy pinned `(artifactId, activationId)` configs are unaffected: identical keywords, identity arbitration stays at the runtime reader (mixed/partial/blank-identity configs keep failing closed to Native at runtime, not at load). The installer bundles the plugin, so it ships the corrected manifest in the same release.

## 3.1.2

### Patch Changes

- 517e338: feat(openclaw-plugin,host-runtime): revision-resilient adaptive delivery mapping via current principle identity (PRI-1140)
  
  The `adaptiveActivation` mapping may now name a `principleId` instead of a pinned `(artifactId, activationId)`. On a delivery-signal round the provider resolves it to the at-most-one currently authorized prompt activation (`resolveCurrentAuthorizedActivationByPrincipleId`, read-only), so an Owner prompt revision no longer silently kills the intervention until the plugin config is edited by hand. The principle path packs additively (`additiveOnly`): it never squeezes out content the native assembly already holds — such a placement keeps the native assembly and records `would_displace_native_assembly`. The pinned mapping and the controlled-admission path are unchanged; a config without `principleId` behaves byte-identically.

## 3.1.1

### Patch Changes

- 498016c: Write the post-assembly presence observation to the event log when it is recorded, so a one-shot host that exits on its own no longer loses it (PRI-1152).

## 3.1.0

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

## 3.0.2

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

## 3.0.1

### Patch Changes

- 97a50b9: feat(openclaw-plugin): freeze prompt presence expectations in before_prompt_build (PRI-1119)
  
  The hook now returns `injectedExpectations` — the per-activation frozen body
  texts (post size guard) injected into `prependSystemContext`, with
  `bodyComplete` marking truncated fragments. Memory-only; consumed by the host
  wire checkpoint (prompt presence check). Requires the host-side carrier support
  (openclaw ai/prompt-presence-check branch) to take effect; older hosts ignore
  the field.

## 3.0.0

### Major Changes

- 6278ec3: core: `abstraction_layer_v1` is retired to a `gone` tombstone (PRI-1137). The flag ID stays in the contract, but a stale `enabled: true` in user config can no longer re-enable the legacy prompt route — it yields the existing "cannot be re-enabled" warning instead. No config migration is shipped and user `.pd/config.yaml` is never rewritten.
  
  host-runtime: **major** — the published barrel (`export *`) removes public API: `shouldUseSharedHostRuntime`-era helpers are gone from the plugin surface and the rotation signal changed shape (`productionRotates: boolean` → `productionRotation: 'rotates' | 'does_not_rotate' | 'unknown'`, `productionRouteRotates()` → `productionRouteRotationState()` / `hostRotationCapability()`), because a boolean could not express "no single host is bound" without lying that every host is FIFO. OpenClaw gains a single shared prompt route with an optional `roundKeyProvider` (PRI-1137); only OpenClaw injects a real session-turn ordinal and Codex/WorkBuddy remain FIFO without round authority. A round key is issued ONLY for a persisted user turn of this invocation (heartbeat/empty-message/resolution-failure/write-failure all degrade to `legacy_fifo_prefix_v1` observably); run retries replay their own persisted ordinal. The shared packer decides by exact additive arithmetic over per-block measurements (one render per pack instead of O(N²)) — output byte-identical. `checkPromptArtifactDeliverability` accepts an `authority` override (approve-time prechecks bill the `owner` annotation they stamp) and refuses `unconfirmed` when the authority join read breaks.
  
  pd-cli: `prompt-capacity-measurement.mjs` measures the same single production route; the per-budget oversized statistic now covers the whole corpus (FIFO's early stop hid later oversized candidates).
  
  principles-disciple: **major** — the plugin's public module surface removes the deleted route-gate exports (`shouldUseSharedHostRuntime`, `runtimeGateCache`, `runtimeGateFor`). The three prompt hooks no longer branch between plugin-local and shared rendering; every standard host goes through the shared runtime. Signal collection, adaptive activation, controlled admission, manual owner pain, prompt enrichment, receipts and delivery evidence are retained. Frozen wire literals (`legacy_fifo_prefix_v1`, `fair_rotation_v1`, `runtime_v2_prompt_activations_injected`, …) are unchanged. The after_tool_call adapter now forwards `toolArgs` (the SDK's after-event field) to the shared evidence kernel and surfaces its degradation (`trajectory_db_not_found` etc.) in logs and hook-execution records instead of recording a blind success.
  
  create-principles-disciple: bundles the plugin, so it follows the same version pass.

## 2.7.1

### Patch Changes

- d36724c: core: the `runtime-v2` generation name is gone from the code surface (PRI-1136). The directory `src/runtime-v2/` is now `src/runtime/`, the `@principles/core/runtime-v2` subpath (and its 17 sub-subpaths) is now `@principles/core/runtime`, and the TypeScript identifiers that spelled the generation were renamed (`RUNTIME_V2_PRINCIPLE_BUDGET` → `RUNTIME_PRINCIPLE_BUDGET`, `RuntimeV2SchemaVersionSchema` → `RuntimeSchemaVersionSchema`, `recordRuntimeV2ActivationsInjected` → `recordRuntimeActivationsInjected`, …).
  
  This is a **breaking** subpath change for any package that imports `@principles/core/runtime-v2`: the old specifier no longer resolves. Every in-repo consumer moves in the same commit; the OpenClaw plugin bundles core through esbuild, so installed plugin builds are unaffected.
  
  Frozen wire values did **not** change: `runtime_v2_prompt_activations_injected`, `source: 'pd-runtime-v2'`, `pd-runtime-v2-diagnosis` and the other §4 literals keep their exact bytes. The prompt header `Runtime V2 activated principles:` is also unchanged — the golden characterization tests still pass byte-for-byte.
  
  host-runtime: import paths follow the rename; no behavior change. The exported constant `RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS` was renamed to `RUNTIME_EVENT_LOG_CANDIDATE_DIRS`, but the old name stays as a `@deprecated` alias of the same frozen array so `^2.2.0` consumers do not break on a patch release.
  
  pd-cli / pd-mcp-server / codex-adapter / workbuddy-adapter: their compiled output imports the core subpath, so they must be republished in the same version pass — otherwise an installed copy keeps resolving the removed `@principles/core/runtime-v2` specifier. Package-level public API is unchanged; patch only. **Observable CLI contract:** `pd demo story-a --json` adds the generation-neutral `isRuntimeExclusive` field and retains `isRuntimeV2Exclusive` as a deprecated compatibility alias for existing consumers.
  
  principles-disciple: the two shipped payload scripts accept both core subpath generations (`@principles/core/runtime` for Core 5.x, `@principles/core/runtime-v2` for the currently pinned Core 4.1.0), so the plugin keeps working before and after the pin move. Payload changed, so the host cache version is bumped.
  
  create-principles-disciple: bundles the plugin, so it follows the same version pass.

## 2.7.0

### Minor Changes

- 0508343: Add a default-off controlled-admission path for adaptive principle prompts.
  
  When no operator admission is configured the runtime behaves exactly as before. When an admission document is supplied through `PD_AA_ADMISSION_FILE`, a single request may be admitted: the shared `adaptivePriorityProvider` entry claims the admission and hands it to `before_prompt_build` for the same request, replay attempts are rejected, and `consumedAt`/`consumedBy` are written atomically under an exclusive lock. `@principles/core` additionally exports `validateControlledAdmissionBinding` and `canonicalAdaptiveMappingSha256` for the host adapters that bind an admission to a request.

## 2.6.5

### Patch Changes

- a902255: core: add `TRAJECTORY_REQUIRED_COLUMNS` and `convergeTrajectorySchemaVersion` — one declaration of the columns trajectory.db must carry and one writer of its `schema_version` row (PRI-1135). Both are module-level exports of `runtime-v2/trajectory-schema`; the runtime-v2 barrel surface is unchanged.
  
  host-runtime: drop the duplicate hand-maintained column list and import the core constant instead. Because host-runtime now names an export that this core release introduces, both packages must ship in the same version pass — a host-runtime-only release would resolve `@principles/core@4.1.x` and fail at module link time.
  
  principles-disciple: the bundled OpenClaw plugin's trajectory lifecycle now delegates the `schema_version` row to core instead of writing it inline; no user-visible behavior change.
  
  create-principles-disciple: the installer bundles the plugin, so it follows the principles-disciple patch above (same version pass).

## 2.6.4

### Patch Changes

- fbe9d79: PRI-1110 follow-up (P2): the executing-manifest walk now keeps the real read
  failure (for example `manifest_too_large`) instead of letting a shallower
  directory without a `package.json` replace it with `manifest_ENOENT`. Evidence
  notes therefore name the actual reason the plugin version is `unknown`. The
  bounded-read and module-load-binding tests now assert the exact byte count,
  degradation result and reason code.

## 2.6.3

### Patch Changes

- 440aa63: PRI-1110: AA invocation journal now records the minimal effective configuration
  identity for each invocation (host, runtime mode, executing plugin version,
  confirmed hook-set fingerprint, evidence coverage). Fields the running host
  cannot prove stay `unknown`; one frozen snapshot is taken when the invocation
  opens and is reused by its terminal record, so a mid-invocation environment
  change cannot rewrite already-recorded evidence.

## 2.6.2

### Patch Changes

- 485894e: Connect bounded Adaptive Activation to OpenClaw prompt builds with explicit
  core exports, final authorization checks, invocation journals and safe Native
  fallbacks. Keep independent AA lab tools outside the historical EXM v4 module
  scan; preserve the original frozen assets and Owner review provenance.

## 2.6.1

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

## 2.6.0

### Minor Changes

- 46cbdab: Remove the Global Friction Index (GFI) mechanism end to end (SPEC `GFI_COMPLETE_REMOVAL_SPEC`).
  
  - BREAKING: friction scoring, mental mode / fatigue state, `GFI_SLICE_RESET` and the `tool_calls.gfi_before` / `gfi_after` columns are gone. `trajectory.db` is migrated when PD opens it: the two legacy columns are dropped and pending empathy confirmations are closed as `abandoned` / `gfi_removal`. A database whose legacy columns cannot be dropped now fails loudly (`trajectory_migration_failed:<reason>`) instead of being silently treated as canonical.
  - BREAKING: Rule Host input no longer carries `session.currentGfi`; `evolution.epTier` and `derived.bashRisk` enrichment are unchanged.
  - Owner-visible GFI surfaces are removed: `/pd-status reset`, `pd runtime health gfi`, the Console GFI health check and GFI status rows. Existing workspaces keep working after the automatic schema migration.

## 2.5.0

### Minor Changes

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

## 2.4.0

### Minor Changes

- b37c67f: Gate 4-D/F (PRI-1071): the OpenClaw plugin now ships the read-only `pd-recall` MCP server via its manifest `mcpServers` entry and writes the PD-owned launcher binding (`mcp-binding.json`) beside its payload during the startup health check — from the SAME resolved workspace the hooks use, idempotently, degrading to a structured warning when the installed PD runtime predates the MCP component. Hook/CLI/governance behavior is unchanged; the MCP server is fail-closed (refuses to start without a valid binding) and its unavailability never blocks other PD functions.

### Patch Changes

- d825694: Gate 4 (PRI-1071) third remediation round — context isolation, real rollback acceptance, and registration-conflict safety:
  
  - OpenClaw: the host-wide `mcp-binding.json` is written only from an explicitly declared PD workspace (`PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `principles-disciple.json`). Without one, the stale binding is removed and `pd-recall` fails closed (`binding_missing`) instead of binding the `main` agent's workspace for every agent. Per-agent hooks keep their existing workspace resolution.
  - WorkBuddy installer: unchanged transaction semantics, now proven by a real fault injection — a read-only `installed_plugins.json` fails the registration commit after the cache swap, and the previous cache/binding/settings/registry are restored byte-for-byte, after which the real launcher still completes initialize / tools/list / tools/call.
  - All three hosts: a same-name MCP registration owned by another server stops the install/setup BEFORE any config, binding, or cache write; a PD-owned same-name entry is reused idempotently; different names coexist; malformed or unattributable configs fail closed. `pd health` reports `CONFIG_DRIFT` with `mcp_same_name_conflict` / `mcp_registration_unverifiable`.
  - `pd-mcp-server` startup logs a workspace fingerprint (SHA-256 prefix, never the path) so operators and acceptance runs can prove which workspace a process bound.

## 2.3.0

### Minor Changes

- 4257de8: Phase B — Shared Correction Detection (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 / v0.3.1).
  
  Behavior contract changes (intentional, per the v0.3 spec):
  
  - Stage 1 (P-1): matched keywords inside paired quotes no longer constitute STRONG; third-person reported and negated contexts — and the downgraded colloquial terms `我说的是` / `都说了` — are Stage-2 candidates only. `他说这是错的` can no longer reach STRONG through the Codex bare-substring path.
  - P-2 (D5 reversal): LLM-learned keywords never earn `high` precision from TP/FP history; they only enter Stage 2. Owner-promoted and seed terms keep the weight-based rule.
  - P-3: a shared confidence gate (`evaluateStage2ConfidenceGate`) distinguishes CORRECTION / NONE / pending; low confidence and LLM errors are never a terminal NONE. Constants: 0.7 / 0.7, MAX_ATTEMPTS=5, TTL=72h.
  - Pending candidates: ambiguous Codex/WorkBuddy Stage-1 candidates are now persisted as `pending_llm_review` rows in the existing `governance_signal_admissions` table (zero DDL) instead of being silently dropped. New terminal decisions `resolved_none` / `abandoned`; `admitOne` returns the pending/terminal semantic instead of an empty `already_admitted` id. CAS claim/complete/settle, idempotent transitions, crash recovery, aggregate 60s / ≤2 candidates per worker cycle.
  - PainIngress: `ensureGovernanceDiagnosticianTask` derives provenance from `evaluatePainIngress` instead of hardcoding `host_context_bound`; `PainIngressCorrelationV1` gains a `workbuddy` variant; the diagnostician context assembler no longer drops `hostKind='workbuddy'`.
  
  Stage-2 classification is now constructed by one shared host-runtime factory (`createSignalClassifierForWorkspace` / `createSignalLlmClassifier`), used by both workers and the OpenClaw plugin; no second model runtime was added. `EARNED_PRECISION_MIN_TP` remains exported as a deprecated compatibility constant (no admission code consults it — D5 removed earned precision without breaking the public root export).

## 2.2.13

### Patch Changes

- 5fa6fc9: **BREAKING CHANGE** — Pain Phase 0 safe cleanup (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 §6/§9, Phase 0). `@principles/core/runtime-v2` is a published subpath of the public npm package `@principles/core` (declared in `packages/principles-core/package.json` `exports`), and the following 13 symbols that were exported from it at baseline `9a2bd5efb` are **removed**. Any external consumer importing them must migrate; import sites inside this monorepo are zero (grep-verified) and none are re-added as deprecated stubs.
  
  Removed public exports:
  
  - Types: `AdmissionDecisionEvent`, `DiagnosisTaskCreatedEvent`, `EvidenceOnlyRecordedEvent`, `SkippedRefusedEvent`, `AdmissionEvent`
  - Functions: `createAdmissionDecisionEvent`, `createDiagnosisTaskCreatedEvent`, `createEvidenceOnlyRecordedEvent`, `createSkippedRefusedEvent`, `serializeAdmissionEvent`, `validateEventPrivacy`
  - Builders: `buildLlmDetectionObservation`, `buildEmpathyObservation`
  
  (All 13 were verified present in the `runtime-v2` barrel at the pre-change baseline; they had zero production consumers across the monorepo and no deprecated aliases are provided.)
  
  Behavioral retirement (same release): error is not Pain — the legacy Semantic Confusion detection execution path (llm.ts DetectionService funnel + detection-service.ts + detection-funnel.ts) and the LLM Paralysis trigger (stuckLoops branch) no longer create Pain events; the shared event-log/trajectory write points are now fed exclusively by the GFI branch, which is untouched (bounded retirement is Phase C; GFI differential behavior pinned by new tests). Fatal Intercept (before_compaction) no longer fabricates a tool_failure Pain with score 100 bypassing Evidence Triage/TriggerController; the safety interception and informational operational notes remain. Correction Sample Reject no longer produces host Pain from either writer (plugin TrajectoryDatabase + core trajectory-store mirror + the /pd-samples direct emit) — approve/reject, reason and sample_reviews audit rows are unchanged. The retired `thresholds.stuck_loops_trigger` and `scores.paralysis` pain_settings keys are removed from defaults (old files containing them still load — unknown keys are ignored). Historical pain_events rows (`llm_*`, `llm_paralysis`, `intercept_extraction`, `correction_rejected`) remain readable; no schema change, no new flags, no new abstractions. Net code deletion across 4 deleted modules; integrations unaffected beyond the removed imports.

## 2.2.12

### Patch Changes

- 3e24e7b: Add an authenticated, bounded feedback revision for approved shadow RuleCode while preserving its artifacts, approvals and existing correction budgets. Provide system-owned recovery control semantics shared by production and replay, with a versioned input contract that rejects new artifacts on older Codex and WorkBuddy gates, so revised rules can preserve official recovery access without inventing command-prefix exemptions. Evaluation now also requires design-approval rules to keep the registered CLI recovery controls reachable.
  
  RuleCode activation identity is now versioned by the immutable artifact (`act_code_<ruleId>_<sha256(artifactId)>`, matching the prompt channel), so a revised artifact can no longer collide with the version it replaces; approving it retires the superseded shadow in the same transaction, with its own control state and an immutable supersede decision.

## 2.2.11

### Patch Changes

- bf7191f: Extract the pain-recall service into @principles/core as the Pain Recall Read Model and add the od-a-v1 Capability Facade (PRI-1068, SPEC-PD-AGENT-CAPABILITY-API-001 v0.5, MCP Gate 3). The `recallPains()` service moves from `pd-cli/src/services/pain-recall.ts` to the dedicated `@principles/core/runtime-v2/pain-recall` subpath byte-identically (CLI golden equivalence proven against pre-migration outputs; the strict read-only WAL snapshot matrix migrates with it). The new `@principles/core/runtime-v2/pain-recall-capability` subpath exposes `recallPrinciplePainsCapability` — a protocol-independent `pd.capability.v1` envelope under the frozen od-a-v1 disclosure profile (construction-is-whitelist projection, per-call leaf-path self-check, fail-closed input validation, limit ∈ [1,10]) — as the sole future entry point for the Gate 4 MCP Adapter. The plugin and installer ship core bytes, so they release in the same cohort (PRI-1065 precedent). Gate 4 (MCP server, 32 KiB budget, 10 s deadline) is explicitly not included.

## 2.2.10

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

## 2.2.9

### Patch Changes

- 3996007: Reconcile the prompt size-guard ceiling with the model-aware principle budget: the total injection limit is now the applied principle budget plus a fixed 7000-char background allowance instead of a hard-coded 9000, so large-window models no longer have every background block stripped in one turn (PRI-1065). The reference window still resolves to 9000, so existing behavior is unchanged. The stripped-context notice also no longer claims a diagnostician-priority session, which was untrue whenever the guard fired outside that mode.

## 2.2.8

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

## 2.2.7

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

## 2.2.6

### Patch Changes

- 5ad3954: Fix the OpenClaw PD plugin payload so a real `agent exec` round no longer times out at workspace-plugin publication. The shipped plugin component is now the self-contained `dist/bundle.js` plus its single native dependency (`better-sqlite3`): the historical `file:./core` rewrite and the inlined-dependency list are gone from `plugin/package.json`, so an install carries 322 files / 33 MB instead of 16,425 files / 126 MB (and OpenClaw's per-round plugin-source capture drops from ~19,167 files / 153 MB per build to 321 files / 33 MB). Also: the bootstrap executor is now delivered from the payload's own `release-manager` component instead of the executing package — during an update the executor used to re-deploy its own stale code, so `installs.json` regenerated by pre-PRI-1021 code could never converge; `release-locks/plugin` is regenerated for the lean manifest, and the plugin package's own manifest no longer lists `@principles/core` as a runtime dependency (it is bundled at build time). PRI-1037 S9.

## 2.2.5

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
- Updated dependencies [07242b7]
- Updated dependencies [53a285f]
  - @principles/core@1.297.4

## 2.2.4

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
- Updated dependencies [7f1afe2]
  - @principles/core@1.297.2

## 2.2.3

### Patch Changes

- 004acb4: Unify the RuleCode textual-basis anchoring check (continuous verbatim span) across the scribe success boundary and the artificer intent preflight, feed scribe validator rejections back into the next model attempt with cross-epoch freshness, and add one bounded authenticated source-correction recovery per rule candidate that CAS-reopens the original needs_human_review artificer on the new scribe epoch. Leases now count attempts per revision epoch while run ordinals stay globally sequential, so reopened epochs actually receive their original maxAttempts. The bundled Console (ships inside create-principles-disciple) gains an authenticated source-correct-once entry whose receipt binds the Owner actor, binding revision, artifact digest and stop reason. Owner review R6: bash-command risk classification is unified across the host gate, the OpenClaw enrichment and golden-trace replay (git mutations and arbitrary code execution count as mutating); approval-gate rules must keep read-only investigation allowed under not_approved, verified by a system-generated counterfactual; the scribe success boundary rejects undeclared approval dependencies.
- Updated dependencies [004acb4]
- Updated dependencies [c7d3f29]
  - @principles/core@1.297.1

## 2.2.2

### Patch Changes

- e1d6ffc: PRI-1023: retire the `openclaw-cli` sub-agent runtime backend (ADR-0029). pi-ai is now the only backend PD executes internal agents on; OpenClaw stays supported as a *host*, never as a delegated CLI agent session. Legacy `type: openclaw` profiles still parse, redact and list, but they are read-only: readiness always answers `needs_setup` with a pi-ai next action, `createAdapterConfigFromProfile` fails loud instead of producing an adapter, the console no longer offers, creates or updates the retired type (existing profiles stay listed and labelled retired, editable only by deleting and recreating them as pi-ai), and the `--openclaw-local` / `--openclaw-gateway` / `--agent` CLI flags are gone in favour of `reason: 'retired_runtime_kind'` refusals. Rollback is source-level: revert this PR.
- Updated dependencies [e1d6ffc]
  - @principles/core@1.297.0

## 2.2.1

### Patch Changes

- 1b13597: SPEC-PD-PAIN-RECALL-CLI-001: new read-only `pd pain recall` command — recalls the historical pains a principle verifiably derives from, so a host Agent can check a principle's origin, trigger boundary, or current-situation fit on demand. Only two authoritative association edges are honored (`reuseEvidence[].painId`; `derivedFromPainIds` resolved through its production contract as candidate ids via `tasks.input_ref`), results dedup by real pain id while keeping every evidence ref, `--context` re-ranks deterministically without any model/network call, and per-source availability separates `not_recorded` from `unreadable` (`source_missing`/`source_unreadable` never masquerade as `no_matches`). All three hosts' `pd-cli-operator` skills (Codex plugin, OpenClaw en/zh templates, WorkBuddy adapter) now document when to call it, how to read the JSON contract, and the diagnosis-is-not-owner-statement rule.

## 2.2.0

### Minor Changes

- 0f2d1fb: PRI-1020: Owner-declared context windows (SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001). A new optional `promptBudget` section in `.pd/config.yaml` lets the Owner declare a model's real context window (`declaredContextWindowTokens` + optional per-host `hosts` overrides). It is tier 0 of the injection budget chain — outranking host-reported windows and the model catalog — and scales the budget with the same formula as #2093 (262144 tokens → 4096 chars, cap 16000). This unblocks Codex/WorkBuddy hosts whose adapters carry no window facts and whose custom model ids can never match the installed catalog (previously locked at the 2000-char fallback forever). Console surfaces forecast under the declared basis when no fresh runtime observation exists; a fresh observation still wins. Delete the section to roll back to the previous behavior. Config validation fails loud on malformed values (policy plausibility bounds, closed host set, unknown keys).

### Patch Changes

- Updated dependencies [0f2d1fb]
  - @principles/core@1.296.0

## 2.1.12

### Patch Changes

- 5c383e5: Unify PD host skills around four consistent capabilities, clarify Owner governance and evidence boundaries, and align the published skill bundles and Codex recovery guidance.
  
  Review-round additions: `pd run list/show` gain an optional `--workspace` (governance-workspace reads independent of cwd); Codex skills route every shipped script through `pd-locate.cjs --exec` — one authoritative locator that resolves the plugin root once, fails loud on marketplace ambiguity or a missing script instead of silently falling back to an older version; WorkBuddy near-miss explicit-statement prefixes get an actionable format notice; `pd-review` startup text no longer presents CLI approval as an agent fallback.

## 2.1.11

### Patch Changes

- 765d5c4: Decouple the signal_confirmations batch consumer from the correction_observer flag (AUDIT-P2-04, 2026-10-21 remediation): the periodic cycle now starts when signal_collector is enabled (default on) even with correction_observer off (default), so persisted pending confirmations are consumed instead of remaining invisible permanent-pending records. Keyword optimization remains exclusively gated by correction_observer and is never silently enabled. Batch skips due to an unavailable classifier are now counted (stage2BatchSkipped) and pd config doctor classifies backlog-plus-skip as degraded with an actionable next action.
- d00ea5c: Signal detection sync-path and observability hardening (AUDIT-P2-01/P2-02, 2026-10-21 remediation): defer all health-counter file writes off the before_prompt_build synchronous call stack (degraded/zero-hit paths previously did a synchronous read-modify-write per message); add stage2Invocations and stage2BatchSkipped counters with backward-compatible signal-health parsing and pd config doctor display; add sync-path regression tests and a repeatable detectSync performance baseline. SQLite queue records stay synchronous by design.
- Updated dependencies [765d5c4]
  - @principles/core@1.295.2

## 2.1.10

### Patch Changes

- d3796e4: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.
  
  - Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match (host-declared provider) → legacy fixed 2000-char fallback with a bounded machine-readable reason code — provider-less name-only matches NEVER confirm (v0.2 trust amendment: a unanimous name cannot prove the deployment is not a custom endpoint). Budget formula `min(16000, max(1250, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens). The 1250 floor is MEASURED (shared route full render of one minimum viable principle = 849/1204 chars with self-report off/on — lower floors re-create the audited 32K zero-injection defect); the 16000 cap is the Owner target upper bound (1M windows map to 15625).
  - Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 1250..16000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 16000 max tier; cross-host aggregation is monotone — only ALL-hosts overflow brands an entry oversized everywhere); injection events carry budget provenance INCLUDING the bounded `budgetFallbackReason` code.
  - Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
  - Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.
- Updated dependencies [d3796e4]
  - @principles/core@1.295.0

## 2.1.9

### Patch Changes

- 0dc0431: chore(deps): bump @sinclair/typebox 0.34.49 -> 0.34.52（#2087）。typebox 是 core / plugin / console 的运行时 dependency，console 随 installer 分发，故 core、plugin 与 installer 各声明 patch。
- Updated dependencies [0dc0431]
  - @principles/core@1.294.2

## 2.1.8

### Patch Changes

- d91b9e0: PRI-1011: an LLM run whose output budget the provider rejects now recovers instead of burning all retries on the same rejected value.
  
  - core: `completeWithRetry` recognises the "requested max_tokens exceeds the maximum output tokens" signature (resolved error responses and thrown errors alike) and halves the budget for the next attempt of that same run — a profile that was never rejected keeps sending exactly what it sends today. A profile that relies on pi-ai native defaulting gets an explicit number for the retry, because resending `undefined` would resend the value the provider just rejected.
  - The ladder stops at a 4096 floor: below that a structured answer is routinely cut off, so further halving would trade a provider rejection for a silent truncation. At the floor the run still fails loud as `execution_failed` with the provider evidence intact.
  - Each step emits an observable `llm_max_tokens_downshift` event (from/to, provider, model, attempt, provider evidence), so the Owner can see what was tried rather than only that something failed.
  - Rate limits, timeouts and unrelated 4xx keep their existing classification and trigger no downshift.
  
  This release train patches `@principles/core`; the correction observer and the other internal agents call it through the bundled `principles-disciple` plugin, and the installer bundles the plugin, so both must be declared in the same plan (release-intent rule N-5/C4). No plugin or installer code changes.
- Updated dependencies [1eb5293]
- Updated dependencies [d91b9e0]
  - @principles/core@1.293.3

## 2.1.7

### Patch Changes

- 807fcab: 修正纠正词库到顶后学习通道冻结的根因：满 200 词时按证据淘汰最没用的学习词（seed/user 永不被淘汰），不再抛错；UPDATE/REMOVE 与 ADD 共用同一条词身份规则，未命中只记一次可读跳过；拒绝把动作词当 term 入库；学习不再删除 Owner 播种词；每次词库变更进 SYSTEM 日志。Stage2 回写不再用判词覆盖命中词，观察员据此拿到真实的 REMOVE 证据。
- Updated dependencies [807fcab]
  - @principles/core@1.293.1

## 2.1.6

### Patch Changes

- 06152af: Connect Codex Owner-labelled behavior evidence to the shared internalization preflight. Reuse one validated assembler across OpenClaw, Codex and evidence attach/resume; read trajectory data without creating or migrating it and preserve host-specific semantics. Missing labels reach Owner review without model calls or attempts; missing/corrupt sources remain observable source faults.
- Updated dependencies [574954a]
  - @principles/core@1.293.0

## 2.1.5

### Patch Changes

- eaf52c4: PRI-982 (SPEC-PD-IAER-001 FR-02/FR-04/§4.2): consumer-side evidence preflight + authoritative channel routing for Artificer. The shared consumer cycle resolves the target channel from `pi_metadata.channel` (seed-time bridge authority): only `code_tool_hook` tasks enter ArtificerL2, prompt-channel tasks keep their legal non-L2 pipeline, unresolvable channels refuse to guess. `code_tool_hook` tasks pass a new `preflightArtificerOwnerEvidence` gate BEFORE any runner construction: no Owner selection or an invalid one atomically transitions the task to `needs_human_review` (CAS via `updateTaskIfDiagnosticJsonUnchanged`, humanReviewContext with the stable FR-04 reasonCode + nextAction) with zero LLM calls, zero run records and no attemptCount consumption; a missing host `behaviorEvidence` port degrades observably and leaves the task pending (SPEC §6.2). New optional PITaskMetadata field `ownerEvidenceSelection` (single shape authority shared with the readiness gate; bad values fail the whole metadata closed). The OpenClaw auto-consumer wires the production `BehaviorExamplePackAssembler` through the port (same assembly contract as run-rulehost). ArtificerRunner/prompt builder become channel-aware so the evidence contract no longer kills prompt-channel tasks, while injected packs keep full v2 echo protection on every channel. New telemetry events `artificer_evidence_readiness_checked` / `artificer_blocked_on_owner_evidence` (the latter persisted via the workspace critical-events allowlist).
- eaf52c4: PRI-983 (SPEC-PD-IAER-001 FR-03/FR-06/FR-07): Owner evidence attach and controlled resume. New `pd runtime internalization evidence list|attach|resume` command group (all default dry-run, `--confirm` mutates): list surfaces Artificer tasks blocked on evidence (needs_human_review + stable FR-04 reasonCode) with pain linkage, missing fields and next actions; attach assembles through the production BehaviorExamplePackAssembler and persists the Owner selection into `pi_metadata.ownerEvidenceSelection` via the narrow diagnosticJson CAS with new provenance fields (revision, contentDigest, ownerOperation, attachedAt — ABSENT=legacy, single shape authority shared with the readiness gate); the task stays needs_human_review (attach never unblocks). resume re-assembles, verifies the stored sha256 contentDigest (mismatch → `owner_behavior_examples_stale`; cross-session → `owner_behavior_examples_scope_mismatch` via a new typed, structural scope-error classification in the plugin assembler — no message sniffing) and performs the atomic authority reset through the single recovery authority `ownerRetryNeedsHumanReviewTask`, which gains an optional CAS precondition (expected diagnosticJson + expected status) so at most one concurrent resume wins (T06); the attempt-budget reset is explicit, digest-verified and audited with previousAttemptCount in the existing `.state/recovery_actions.jsonl` append-only log. FR-07: the run-rulehost BEP gate and its confirm-time assembly now derive refusal reasons from the same shared Evidence Readiness judgment (`assessEvidenceReadiness`) the consumer preflight uses — identical inputs produce identical stable reason codes on both production entries, with no V1 fallback and unchanged command parameters. New telemetry events `artificer_owner_evidence_attached` / `artificer_owner_evidence_resumed` (bounded payloads, no raw trajectories).
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
  - @principles/core@1.292.2

## 2.1.4

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/core@1.292.1

## 2.1.3

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
- Updated dependencies [6e60d84]
- Updated dependencies [0f94f8c]
- Updated dependencies [4ba83b7]
- Updated dependencies [5e794be]
  - @principles/core@1.292.0

## 2.1.2

### Patch Changes

- 69fa3f3: chore(deps): bump js-yaml 5.4.1 -> 5.4.3（#2011）。js-yaml 是 core / host-runtime / plugin / pd-cli / console 的运行时 dependency，console 随 installer 分发，故这 4 个可发布包与 installer 各声明 patch。
- Updated dependencies [69fa3f3]
  - @principles/core@1.291.6

## 2.1.1

### Patch Changes

- 6317a63: Keep unresolved content references unresolved across evidence replays (Phase 1 closeout review P2-2). The evidence producers treated the STORED contentRef as an opaque truthy object when rebuilding an observation for a replayed source event: an already-stored `revision_reference_unresolved` reference (no payloadDigest — e.g. an activation whose artifact is missing) was re-emitted as `resolution: 'resolved'` without a digest. The normalizer rejects `resolved`-without-digest before the store's idempotent dedup branch runs, so replaying the SAME source event failed with `observation_contentRef_resolved_requires_payloadDigest` instead of landing as an idempotent duplicate — "record count unchanged" was the result of rejection, not idempotency (the real 2026-10-11 replay probe hit exactly this). Resolution is now upgraded to `resolved` only when a payloadDigest is actually present; digest-carrying (resolved) replays keep their digest and dedup as before. Fixed at all four producer sites (Codex prompt delivery + Codex deny chain, OpenClaw prompt delivery + gate enforcement chain); validator, oracle, and store semantics unchanged. `create-principles-disciple` rides along because the installer bundles the plugin. Regression tests drive the real recorder → ingress → store boundary on both hosts: unresolved first-record + replay lands as `duplicateCount: 1` with the original resolution preserved, and a new ingress boundary test pins digest-less-batch replay as an idempotent duplicate plus same-key-different-content as a reported conflict.

## 2.1.0

### Minor Changes

- d5732f8: PD v2 Phase 1 Evidence Foundation (ADR-0027): normalized intervention evidence ledger.
  
  - core: intervention evidence contract + deterministic normalizer (rc-1..rc-5 trust boundary, anti-forgery cross-field rules), append-only SQLite ledger tables inside the existing state.db (idempotent same-source replay, reported source conflicts, immutable records, activation occurrence snapshots), busyTimeoutMs connection option, and the four-query audit read contract.
  - host-runtime: shared intervention evidence ingress — the single validated entry every host source uses; never throws, never waits on locks (busyTimeoutMs 0), degrades with structured reason + nextAction.
  - openclaw-plugin (principles-disciple): evidence wiring on both legacy and shared routes — prompt delivery attempts (submitted/attempted, host consumption never claimed), enforcement chains on gate block/auto-correct (runtime_loaded delivery, runtime_verified application with explicit proof boundary, episode, effect), agent_claimed self-report mirroring; gated by the existing principle_receipt_ledger flag.
  - codex-adapter: evidence adapter on the shared ingress — UserPromptSubmit delivery attempts after the durable event-log line, deny chains recorded only after successful stdout encoding; honest capability matrix (self_report Unsupported, enforcement Unknown per PRI-780).
  - create-principles-disciple (ships pd-console): four read-only evidence-audit queries under /api/v1/receipts/evidence-audit plus the authenticated Owner outcome input POST /api/v1/evidence/outcomes (closed body contract, server-derived actor), and an evidence-audit section on the principle detail page.
  
  No effectiveness scoring, ranking, or automatic governance action anywhere (Phase 1 records facts only).

### Patch Changes

- 0b981bb: OpenClaw 提示词构建事件记录实际宿主与独立事件身份；旧日志缺少来源时保持未知，避免同 run 跨宿主或多次构建被合并。
- Updated dependencies [d5732f8]
- Updated dependencies [0b981bb]
  - @principles/core@1.290.0

## 2.0.10

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

## 2.0.9

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

## 2.0.8

### Patch Changes

- df9e555: PRI-917 v0.3.3 (OD-PRI917-05): Reuse Review Gate — automatic candidate intake now consults the semantic reuse evaluation capability before creating a Principle.
  
  A `reuse` recommendation parks the candidate (`refused/reuse_pending_owner`): no Principle is written, no evidence is appended, the candidate stays pending for the Owner, and the bridge emits an observable `reuse_gate_triggered` event plus a `reuse_review_required` outcome pointing at `pd candidate review --decide reuse|create`. `create`/`uncertain` recommendations and every evaluation failure degrade to normal creation (learning never blocks). `reuseEvaluation.enabled=false` restores the exact pre-v0.3.3 behavior.
  
  Also fixes the R5 "two-heads-block" defect: `pd candidate review --decide reuse` no longer lets the PRI-442 admission pre-check reject low-confidence candidates — a reuse verdict creates nothing, so the ledger-quality gate does not apply (the `--decide create` pre-check is unchanged).
  
  PR review fixes (4×P2, PRI-938): the bridge cache key now folds in the reuse-gate switch so a long-lived host picks up `reuseEvaluation.enabled` toggles in both directions (T11 rollback without a restart); mixed batches and replays keep parked candidates visible (`reuse_review_required` degraded outcome, Codex worker `reuseReviewRequiredCandidateIds`, OpenClaw `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` log gated on the park disposition); `pd diagnose` / `pd pain-retry` render parked candidates with review guidance and exclude them from `internalize` next-action lists.
  
  Follow-up review fixes: evaluation profile and timeout changes invalidate the cached reuse hook. Replay verifies the original diagnosis admission and performs a read-only reuse check before reporting a parked candidate, preserving failed-intake and gate-disabled behavior without additional persisted state.
  
  Owner-approved configuration hardening: constructing CandidateIntakeService with both reuseRecommendation and reuseDecision now fails explicitly before either callback or any candidate mutation, instead of silently prioritizing the decision channel.
- Updated dependencies [df9e555]
  - @principles/core@1.289.0

## 2.0.7

### Patch Changes

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
- Updated dependencies [b50ec74]
  - @principles/core@1.287.7

## 2.0.6

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

## 2.0.5

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
- Updated dependencies [50ed22e]
  - @principles/core@1.287.6

## 2.0.4

### Patch Changes

- 4ced615: OPT-002 (runtime-v2 barrel narrowing): the plugin's satellite bundles no longer pull the LLM SDK graph. Six shared plugin modules switched their VALUE imports from the `@principles/core/runtime-v2` barrel to the eight narrow leaf subpaths (type-only barrel imports unchanged; exported names unchanged), and `@principles/core` exports gained those additive subpaths (`./runtime-v2/store/workspace-leak-guard`, `./runtime-v2/feedback/redact-sensitive`, `./runtime-v2/types/event-types`, `./runtime-v2/trajectory-schema`, `./runtime-v2/internalization/{rule-host-input-builder,rule-context-v2,behavior-example-pack,tool-semantic-registry}`). governance-audit.js drops 2,783,013 → 70,786 bytes (−97.5%) and rulehost-evidence.js 2,826,401 → 60,244 bytes (−97.9%); bundle.js is byte-identical (4,151,557) — the main package keeps its LLM runtime through its own direct barrel import. `runtime-v2/index.ts` and all existing exports are untouched. A build-level satellite purity guard (`scripts/build/check-satellite-purity.mjs`, wired into `esbuild.config.js`) now fails any plugin bundle build that reintroduces pi-ai / pi-agent-core / anthropic / openai / genai / undici inputs into the satellite outputs, so the invariant no longer rests on discipline alone.
- Updated dependencies [4ced615]
- Updated dependencies [de38d90]
  - @principles/core@1.287.3

## 2.0.3

### Patch Changes

- df43600: PRI-899: effect receipts now carry the activation that produced them, so behavior evidence JOINs back to its activation. The `principle_applications.activation_id` column, the optional `recordPrincipleApplication` input and the presence-path propagation all already existed — every EFFECT write point simply passed nothing, leaving 93/93 effect rows NULL and `JOIN activations` at 0. The legacy hook path now passes `report.liveDecisionActivationId` for `rule_blocked` and `auto_correct_applied` (that value was already in scope and already consumed by the `rulehost_evaluated` event); the shared-gate deny path recovers the same fact from the `metadata.evaluations` live entry and threads it through `accountSharedDeny`; and the prompt-channel `self_reported` row resolves the reported principle to the activation carried alongside it, reusing the single pairing derivation that already fed the presence receipt. Unattributable decisions — no winner, shadow-only, or absent metadata — still write an UNLINKED receipt exactly as before, so lineage is never fabricated and shadow activation ids are never promoted to live.
  
  PRI-900: adds an experiment-level Behavior Signature declaration (`docs/experiments/pri-836/behavior-signature.json`) that reuses a principle artifact's `IntentContractV1` verbatim for Target Behavior / Forbidden Pattern / Evidence Source / Expected New Behavior, and adds only the three fields the acceptance spec marks as new: eligible opportunity, previous behavior (B0 failure pattern, frequency and observed evidence), and before/after observation windows split by `created_at` rather than session (exposed sessions are long-lived and would mix before/after). A repo-wide guard validates every such declaration with the real `isValidIntentContractV1` and rejects declarations that fork their own copies of the contract fields. No new table, runtime, Behavior Engine or storage — the declaration is one JSON file per experiment, and behaviour adjudication stays with the Owner (`adjudication.status = not_evaluated`).
- edbbcd9: RAH-3 (PRI-907): complete the release-artifact content boundary. @principles/install-layout and principles-disciple (openclaw-plugin) production builds now exclude compiled tests (tsconfig.build.json; plugin build:types declaration emit filtered too) with the same fail-loud dist hygiene assertion as RAH-1. The installer bundle script (create-principles-disciple) filters compiled test artifacts out of every payload copy AND asserts zero test artifacts across all payload components after materialization — test code can no longer reach user machines even if a future package forgets its build-boundary guard. A repo-level scan (check:workspace-artifacts, wired into verify:merge) backstops all workspace dist trees.
- 8b7b775: Security audit run-1 remediation (findings verified against eabbde6d, applied on ccc69252):
  
  - **RuleCode enforcement is now content-bound** (audit HIGH `rulecode-approval-content-unbound`): the production gate and the OpenClaw plugin RuleHost re-verify the current `pi_artifacts` row against the `activation_decisions.artifact_digest` recorded at Owner promotion time before compiling it. A workspace-local rewrite of `content_json` (or lineage fields) is now skipped with a structured `artifact_content_tampered` warning instead of silently executing unapproved code. Rows without a recorded decision (legacy activations) keep their prior behavior. Adds `mapPiArtifactRow`/`PiArtifactRow` exports (the single `pi_artifacts` row→snapshot mapping) so enforcement reproduces the promotion-time digest byte-for-byte.
  - **Replay evaluate is hard-bounded** (audit MEDIUM `rulecode.replay.in-process-evaluate-no-hard-timeout`): pre-activation replay runs each evaluate call through a precompiled vm script with a 2000ms hard timeout — a looping LLM-authored candidate now fails its replay case instead of hanging the console server, evaluator worker, or CLI process.
  - **Governance-store unavailability leaves a durable trace** (audit MEDIUM `gate-failopen-allow-on-state-corruption`): when `state.db` is missing or unreadable, the gate/plugin record a best-effort marker under `~/.pd/enforcement-health/` (outside the agent-writable workspace), and the console governance read model distinguishes "state.db deleted after initialization — enforcement degraded (fail-open)" from a never-initialized workspace.
  - **Console refuses unauthenticated non-loopback binds** (audit MEDIUM `pd-console-noauth-nonloopback-bind`): the loopback-only invariant now keys on the effective authentication state (token-less default included), not just the explicit `--no-auth` flag.
  - **Plugin honors an explicit conversation-access opt-out** (audit LOW `openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out`): the auto-fix repairs only an absent `allowConversationAccess` flag; an explicit `false` (the documented turn-off) is preserved and surfaced as an honored Owner opt-out instead of being silently rewritten on every gateway start.
- Updated dependencies [99e6a8c]
- Updated dependencies [8b7b775]
- Updated dependencies [9d98f89]
- Updated dependencies [92074a0]
  - @principles/core@1.287.2

## 2.0.2

### Patch Changes

- 8424d60: Baseline-cutover accounting for the unpublished source delta between the registry baseline (2.0.1, published from fb397452) and current main: pain/llm hook refinements and the plugin sync script update carried after the 2026-09-19 release train. The version alignment to 2.0.1 is a starting point, not a claim this content shipped.
- Updated dependencies [8424d60]
  - @principles/core@1.287.0

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
