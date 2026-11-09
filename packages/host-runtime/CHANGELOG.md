# @principles/host-runtime

## 3.1.1

### Patch Changes

- 517e338: feat(openclaw-plugin,host-runtime): revision-resilient adaptive delivery mapping via current principle identity (PRI-1140)
  
  The `adaptiveActivation` mapping may now name a `principleId` instead of a pinned `(artifactId, activationId)`. On a delivery-signal round the provider resolves it to the at-most-one currently authorized prompt activation (`resolveCurrentAuthorizedActivationByPrincipleId`, read-only), so an Owner prompt revision no longer silently kills the intervention until the plugin config is edited by hand. The principle path packs additively (`additiveOnly`): it never squeezes out content the native assembly already holds — such a placement keeps the native assembly and records `would_displace_native_assembly`. The pinned mapping and the controlled-admission path are unchanged; a config without `principleId` behaves byte-identically.

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

- Updated dependencies [8da2cdc]
- Updated dependencies [30ccf33]
  - @principles/core@6.0.0

## 3.0.4

### Patch Changes

- Updated dependencies [20719c6]
- Updated dependencies [bbdcb50]
  - @principles/core@5.2.0
  - @principles/install-layout@0.5.0

## 3.0.3

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
- Updated dependencies [f7cdc5a]
  - @principles/core@5.1.1

## 3.0.2

### Patch Changes

- ee9e62b: Consent-store single-format convergence + global control-state write mutex (PRI-1138, PRI-1104/5, PRI-1151).
  
  Single writable format (PRI-1138): `writeProductTelemetryControlState` refuses any non-current schemaVersion, so no code path can persist or regenerate a legacy v1 file; parsing converges into one `parseConsentState` entry with a single current-format whitelist; legacy v1 files remain readable through the strictly one-way, read-only migrator (`migrateLegacyConsentFile`), preserving consent/consentVersion/telemetrySecret verbatim.
  
  Global write mutex (PRI-1151): every control-state writer now serializes on ONE cross-process lock (`product-telemetry.json.state-lock`) via the new `withControlStateLock` transaction entry — the legacy v1→v2 migration write-back, `pd telemetry enable/disable/reset` (now async locked transactions awaited through the CLI), and workspace export bookkeeping merges. `readProductTelemetryControlState` is now a pure read (v1 parsed in memory, never written); persistence happens exclusively inside locked transactions, so no writer can build its write from a stale read — once disable succeeds, no concurrent migration/enable/reset/merge can restore the previous granted consent or secret. The lock uses an ownership-checked protocol (owner token in the lock body, atomic rename-claim for stale takeover and for release): a crashed holder is recovered after the stale threshold, a live holder's lock is never deleted by another process, a late release cannot delete a successor's lock, acquisition waits are bounded and fail loud (never degrading into lock-free writes). The per-workspace export lock adopts the same takeover/release protocol. Verified by real multi-process tests (deterministic stdio barriers): migration vs disable/reset/enable/workspace-merge races, 6-way cross-process mutual exclusion with zero lost updates, bounded-timeout loud failure, and stale-lock recovery. No wire values, snapshot payloads, or export behavior changed.

## 3.0.1

### Patch Changes

- 34b35d9: Fix Stage-2 correction review silently consuming attempts under production default budgets: the per-classification timeout derived from the aggregate-budget remainder was fractional (`performance.now()` float arithmetic), and the pi-ai adapter hands it straight to `AbortSignal.timeout`, which rejects non-integer delays with `ERR_OUT_OF_RANGE` before any network I/O. Every classification then failed instantly, each failure consumed a durable attempt via `pending_llm_error`, and after five cycles the pending candidate was abandoned (`llm_error`) without a single real model call. The remainder is now clamped to whole milliseconds at the producer (PRI-1147 real-LLM BDD, ERR-191), with a regression test asserting the classifier receives an integer timeout under the default budgets.

## 3.0.0

### Major Changes

- 6278ec3: core: `abstraction_layer_v1` is retired to a `gone` tombstone (PRI-1137). The flag ID stays in the contract, but a stale `enabled: true` in user config can no longer re-enable the legacy prompt route — it yields the existing "cannot be re-enabled" warning instead. No config migration is shipped and user `.pd/config.yaml` is never rewritten.
  
  host-runtime: **major** — the published barrel (`export *`) removes public API: `shouldUseSharedHostRuntime`-era helpers are gone from the plugin surface and the rotation signal changed shape (`productionRotates: boolean` → `productionRotation: 'rotates' | 'does_not_rotate' | 'unknown'`, `productionRouteRotates()` → `productionRouteRotationState()` / `hostRotationCapability()`), because a boolean could not express "no single host is bound" without lying that every host is FIFO. OpenClaw gains a single shared prompt route with an optional `roundKeyProvider` (PRI-1137); only OpenClaw injects a real session-turn ordinal and Codex/WorkBuddy remain FIFO without round authority. A round key is issued ONLY for a persisted user turn of this invocation (heartbeat/empty-message/resolution-failure/write-failure all degrade to `legacy_fifo_prefix_v1` observably); run retries replay their own persisted ordinal. The shared packer decides by exact additive arithmetic over per-block measurements (one render per pack instead of O(N²)) — output byte-identical. `checkPromptArtifactDeliverability` accepts an `authority` override (approve-time prechecks bill the `owner` annotation they stamp) and refuses `unconfirmed` when the authority join read breaks.
  
  pd-cli: `prompt-capacity-measurement.mjs` measures the same single production route; the per-budget oversized statistic now covers the whole corpus (FIFO's early stop hid later oversized candidates).
  
  principles-disciple: **major** — the plugin's public module surface removes the deleted route-gate exports (`shouldUseSharedHostRuntime`, `runtimeGateCache`, `runtimeGateFor`). The three prompt hooks no longer branch between plugin-local and shared rendering; every standard host goes through the shared runtime. Signal collection, adaptive activation, controlled admission, manual owner pain, prompt enrichment, receipts and delivery evidence are retained. Frozen wire literals (`legacy_fifo_prefix_v1`, `fair_rotation_v1`, `runtime_v2_prompt_activations_injected`, …) are unchanged. The after_tool_call adapter now forwards `toolArgs` (the SDK's after-event field) to the shared evidence kernel and surfaces its degradation (`trajectory_db_not_found` etc.) in logs and hook-execution records instead of recording a blind success.
  
  create-principles-disciple: bundles the plugin, so it follows the same version pass.

### Patch Changes

- Updated dependencies [6278ec3]
  - @principles/core@5.1.0

## 2.2.3

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

## 2.2.2

### Patch Changes

- a902255: core: add `TRAJECTORY_REQUIRED_COLUMNS` and `convergeTrajectorySchemaVersion` — one declaration of the columns trajectory.db must carry and one writer of its `schema_version` row (PRI-1135). Both are module-level exports of `runtime-v2/trajectory-schema`; the runtime-v2 barrel surface is unchanged.
  
  host-runtime: drop the duplicate hand-maintained column list and import the core constant instead. Because host-runtime now names an export that this core release introduces, both packages must ship in the same version pass — a host-runtime-only release would resolve `@principles/core@4.1.x` and fail at module link time.
  
  principles-disciple: the bundled OpenClaw plugin's trajectory lifecycle now delegates the `schema_version` row to core instead of writing it inline; no user-visible behavior change.
  
  create-principles-disciple: the installer bundles the plugin, so it follows the principles-disciple patch above (same version pass).
- Updated dependencies [a902255]
  - @principles/core@4.2.0

## 2.2.1

### Patch Changes

- fda71df: PRI-1114 修复：单会话分类查询（纠正/任务结果/弱候选）被每会话行上限截断时，截断状态现在传播到全局覆盖判定。
  以前目标 run 的记录恰好落在截断之后时，会返回空列表且 `coverage.complete=true`；现在降级为 `complete=false` 并给出 `session_rows_truncated`，计数按“下界”处理。
  读取预算未放宽，仍未新增表或写入路径。

## 2.2.0

### Minor Changes

- 0f6a867: PRI-1114: 新增只读运行时行为证据关联读模型 `linkAdaptiveBehaviorEvidence`，以及 `pd activation link` 命令。
  按 run 级归属连接注入机会、工具调用、纠正与任务输出，只复用既有 journal / EventLog / trajectory 读取路径，
  不建表、不写库、不调用模型；缺证一律降级为 `unknown`，不推断送达先后或任务成功。

## 2.1.0

### Minor Changes

- 6696ca6: PRI-1109: add a read-only adaptive-delivery journal reconciler and the thin `pd activation journal` command. The command pairs recorded open/terminal states conservatively, reports coverage and truncation explicitly, and never writes logs or runs a model. `@principles/core` only gains a public export of the existing `canonicalStringify` (no behavior change).

### Patch Changes

- Updated dependencies [6696ca6]
  - @principles/core@4.1.0

## 2.0.2

### Patch Changes

- 485894e: Connect bounded Adaptive Activation to OpenClaw prompt builds with explicit
  core exports, final authorization checks, invocation journals and safe Native
  fallbacks. Keep independent AA lab tools outside the historical EXM v4 module
  scan; preserve the original frozen assets and Owner review provenance.
- Updated dependencies [485894e]
  - @principles/core@4.0.2

## 2.0.1

### Patch Changes

- 2a7aec5: PRI-1093 / SPEC P-5: WorkBuddy keyword detection no longer applies a sentence-initial `startsWith` pre-filter before the shared keyword-stage guards. Mid-sentence corrections now reach the same quote / third-person / negation guards Codex uses, so they are no longer silently discarded at the detection layer and land in the same `ambiguity` disposition. This does not add Pain: WorkBuddy still has no persisted behavior-trace evidence, so admitted candidates stop at the evidence gate (`abandoned` / `evidence_invalid`). Cost impact: at most one extra Stage-1 evaluation per prompt; Stage-2 pending candidates stay zero-LLM in the hook.
  
  `@principles/core` also gains one deterministic guard in the shared keyword stage: a clause that opens with a hypothetical/conditional marker (`如果` / `假如` / `要是` / `假设` / `万一`) downgrades a high-precision correction hit from STRONG to `ambiguity`, because such a clause states a hypothesis rather than an Owner assertion. The guard is clause-scoped, so a real correction in a later clause still reaches STRONG.
  
  `@principles/workbuddy-adapter` is a comment-only correction: the hook note now describes the post-P-5 shared-guard behavior instead of a `startsWith` pre-filter that no longer exists. No runtime behavior changed.
- Updated dependencies [2a7aec5]
- Updated dependencies [efae469]
- Updated dependencies [c1e7e1f]
- Updated dependencies [1c1b91f]
  - @principles/core@4.0.1

## 2.0.0

### Major Changes

- 46cbdab: Remove the Global Friction Index (GFI) mechanism end to end (SPEC `GFI_COMPLETE_REMOVAL_SPEC`).
  
  - BREAKING: friction scoring, mental mode / fatigue state, `GFI_SLICE_RESET` and the `tool_calls.gfi_before` / `gfi_after` columns are gone. `trajectory.db` is migrated when PD opens it: the two legacy columns are dropped and pending empathy confirmations are closed as `abandoned` / `gfi_removal`. A database whose legacy columns cannot be dropped now fails loudly (`trajectory_migration_failed:<reason>`) instead of being silently treated as canonical.
  - BREAKING: Rule Host input no longer carries `session.currentGfi`; `evolution.epTier` and `derived.bashRisk` enrichment are unchanged.
  - Owner-visible GFI surfaces are removed: `/pd-status reset`, `pd runtime health gfi`, the Console GFI health check and GFI status rows. Existing workspaces keep working after the automatic schema migration.

### Patch Changes

- Updated dependencies [46cbdab]
  - @principles/core@4.0.0

## 1.0.0

### Major Changes

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

### Patch Changes

- Updated dependencies [dc1addd]
  - @principles/core@3.0.0

## 0.15.1

### Patch Changes

- f02aa73: PRI-1066 recalibrates the model-aware prompt injection budget (`model_aware_v1` → `model_aware_v2`): the baseline doubles from 2000 to 4000 chars at the 128K reference window (hard ceiling 16000 → 32000, fallback 2000 → 4000, total ceiling derived per model), so an Owner-approved principle set stops filling the injection slot after a handful of principles. It also adds the `pi_catalog_model_id` tier (a provider-less model id that the installed catalog answers unanimously derives a real window instead of silently using the fixed fallback), records policy-version-skewed events as `foreignPolicyEventsSkipped` instead of dropping them silently, and removes the standing Focus-page "budget full" nag: `truncated` is the normal rotation state, so the notice now appears only when a host cannot fit even one principle and carries an actionable next step.
- Updated dependencies [f02aa73]
  - @principles/core@2.1.1

## 0.15.0

### Minor Changes

- 4257de8: Phase B — Shared Correction Detection (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 / v0.3.1).
  
  Behavior contract changes (intentional, per the v0.3 spec):
  
  - Stage 1 (P-1): matched keywords inside paired quotes no longer constitute STRONG; third-person reported and negated contexts — and the downgraded colloquial terms `我说的是` / `都说了` — are Stage-2 candidates only. `他说这是错的` can no longer reach STRONG through the Codex bare-substring path.
  - P-2 (D5 reversal): LLM-learned keywords never earn `high` precision from TP/FP history; they only enter Stage 2. Owner-promoted and seed terms keep the weight-based rule.
  - P-3: a shared confidence gate (`evaluateStage2ConfidenceGate`) distinguishes CORRECTION / NONE / pending; low confidence and LLM errors are never a terminal NONE. Constants: 0.7 / 0.7, MAX_ATTEMPTS=5, TTL=72h.
  - Pending candidates: ambiguous Codex/WorkBuddy Stage-1 candidates are now persisted as `pending_llm_review` rows in the existing `governance_signal_admissions` table (zero DDL) instead of being silently dropped. New terminal decisions `resolved_none` / `abandoned`; `admitOne` returns the pending/terminal semantic instead of an empty `already_admitted` id. CAS claim/complete/settle, idempotent transitions, crash recovery, aggregate 60s / ≤2 candidates per worker cycle.
  - PainIngress: `ensureGovernanceDiagnosticianTask` derives provenance from `evaluatePainIngress` instead of hardcoding `host_context_bound`; `PainIngressCorrelationV1` gains a `workbuddy` variant; the diagnostician context assembler no longer drops `hostKind='workbuddy'`.
  
  Stage-2 classification is now constructed by one shared host-runtime factory (`createSignalClassifierForWorkspace` / `createSignalLlmClassifier`), used by both workers and the OpenClaw plugin; no second model runtime was added. `EARNED_PRECISION_MIN_TP` remains exported as a deprecated compatibility constant (no admission code consults it — D5 removed earned precision without breaking the public root export).

### Patch Changes

- Updated dependencies [4257de8]
  - @principles/core@2.1.0

## 0.14.6

### Patch Changes

- 6595b42: PRI-988: `INTERNALIZATION_CONSUMER_SKIP` events now carry the queue's `noReadyTasks`, `invalidMetadataCount` and bounded `sampleInvalidTaskIds` diagnostics, so heartbeat telemetry distinguishes an empty queue from hydration failures.

## 0.14.5

### Patch Changes

- Updated dependencies [5fa6fc9]
  - @principles/core@2.0.0

## 0.14.4

### Patch Changes

- 3e24e7b: Add an authenticated, bounded feedback revision for approved shadow RuleCode while preserving its artifacts, approvals and existing correction budgets. Provide system-owned recovery control semantics shared by production and replay, with a versioned input contract that rejects new artifacts on older Codex and WorkBuddy gates, so revised rules can preserve official recovery access without inventing command-prefix exemptions. Evaluation now also requires design-approval rules to keep the registered CLI recovery controls reachable.
  
  RuleCode activation identity is now versioned by the immutable artifact (`act_code_<ruleId>_<sha256(artifactId)>`, matching the prompt channel), so a revised artifact can no longer collide with the version it replaces; approving it retires the superseded shadow in the same transaction, with its own control state and an immutable supersede decision.
- Updated dependencies [3e24e7b]
  - @principles/core@1.298.1

## 0.14.3

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

## 0.14.2

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
- Updated dependencies [5349930]
  - @principles/core@1.297.5

## 0.14.1

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
- Updated dependencies [07242b7]
- Updated dependencies [53a285f]
  - @principles/core@1.297.4

## 0.14.0

### Minor Changes

- 44a9d3d: Codex agent-assisted explicit pain registration (no prefix).
  
  When the Owner's current message explicitly asks to create a pain signal and provides the feedback, the agent can now complete the registration itself instead of demanding a `PD记录痛苦：` resend:
  
  - The Codex hook publishes the CURRENT turn's host-verified identity (ids/paths only, never prompt text) to a session-hash-partitioned file under `<workspace>/.state/` on every UserPromptSubmit and withdraws only that session's matching turn on Stop (or that session on SessionStart). `pd pain explicit` selects the file using the host-bound `CODEX_SESSION_ID` and rejects conflicting `CODEX_THREAD_ID`; missing identity fails closed.
  - New `pd pain explicit --statement "<Owner 原文>" [--workspace] [--json]` registers through the SAME admission chain as the prefix entry (governance admission marker, explicit 5/hour bucket, diagnostician task ensure, idempotent same-turn convergence). The command takes no lineage flags — lineage comes exclusively from the host-written turn context and is re-validated at registration time.
  - Provenance is auditable: agent-assisted registrations carry `channel: codex_explicit_agent` and an "agent-assisted, no prefix" pain reason, distinct from the hook-read `codex_explicit_prefix` channel (additive literal in the shared PainCorrectionEvidence schema; prefix behavior byte-identical).
  - The `pd-pain-signal` skill now mandates agent-assisted registration for explicit no-prefix requests (verbatim Owner words only, receipt-idempotency check first, honest failure reporting); the "ask the Owner to resubmit" absolute rule is retired, and `pd pain record` remains the post-hoc operator recovery path.

### Patch Changes

- cd773b5: Codex explicit pain statement: fix evidence-promotion ordering.
  
  - Run the live observation ingestion BEFORE the explicit registration in
    pd-hook, so the FIRST `PD记录痛苦：` submission of a rollout promotes its
    evidence window instead of degrading with rollout_not_found /
    trigger_not_found (the trigger observation used to be written only by the
    ingestion pass that ran after the registration).
  - Promote evidence BEFORE enqueuing the Diagnostician task, closing the
    window where a fast worker could start the first diagnosis before the
    available evidence window was promoted.
  - With codex_conversation_ingestion disabled, skip promotion and disclose
    `conversation_ingestion_disabled` in the receipt (no transcript read, no
    session observation, no misleading missing-substrate reason).
  - Reconciliation now requires the current ingestion consent explicitly:
    flag-off recovers tasks and links without reading or promoting old session
    observations; enabled reconciliation promotes before making tasks runnable.
  - ensureGovernanceDiagnosticianTask: a concurrent ensure racing on the same
    deterministic task id now converges on the existing task instead of
    reporting task_submit_failed:UNIQUE while the task actually exists.
- Updated dependencies [44a9d3d]
  - @principles/core@1.297.3

## 0.13.5

### Patch Changes

- 4fefb36: Codex explicit pain statement: fix evidence-promotion ordering.
  
  - Run the live observation ingestion BEFORE the explicit registration in
    pd-hook, so the FIRST `PD记录痛苦：` submission of a rollout promotes its
    evidence window instead of degrading with rollout_not_found /
    trigger_not_found (the trigger observation used to be written only by the
    ingestion pass that ran after the registration).
  - Promote evidence BEFORE enqueuing the Diagnostician task, closing the
    window where a fast worker could start the first diagnosis before the
    available evidence window was promoted.
  - With codex_conversation_ingestion disabled, skip promotion and disclose
    `conversation_ingestion_disabled` in the receipt (no transcript read, no
    session observation, no misleading missing-substrate reason).
  - Reconciliation now requires the current ingestion consent explicitly:
    flag-off recovers tasks and links without reading or promoting old session
    observations; enabled reconciliation promotes before making tasks runnable.
  - ensureGovernanceDiagnosticianTask: a concurrent ensure racing on the same
    deterministic task id now converges on the existing task instead of
    reporting task_submit_failed:UNIQUE while the task actually exists.

## 0.13.4

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

## 0.13.3

### Patch Changes

- 004acb4: Unify the RuleCode textual-basis anchoring check (continuous verbatim span) across the scribe success boundary and the artificer intent preflight, feed scribe validator rejections back into the next model attempt with cross-epoch freshness, and add one bounded authenticated source-correction recovery per rule candidate that CAS-reopens the original needs_human_review artificer on the new scribe epoch. Leases now count attempts per revision epoch while run ordinals stay globally sequential, so reopened epochs actually receive their original maxAttempts. The bundled Console (ships inside create-principles-disciple) gains an authenticated source-correct-once entry whose receipt binds the Owner actor, binding revision, artifact digest and stop reason. Owner review R6: bash-command risk classification is unified across the host gate, the OpenClaw enrichment and golden-trace replay (git mutations and arbitrary code execution count as mutating); approval-gate rules must keep read-only investigation allowed under not_approved, verified by a system-generated counterfactual; the scribe success boundary rejects undeclared approval dependencies.
- Updated dependencies [004acb4]
- Updated dependencies [c7d3f29]
  - @principles/core@1.297.1

## 0.13.2

### Patch Changes

- e1d6ffc: PRI-1023: retire the `openclaw-cli` sub-agent runtime backend (ADR-0029). pi-ai is now the only backend PD executes internal agents on; OpenClaw stays supported as a *host*, never as a delegated CLI agent session. Legacy `type: openclaw` profiles still parse, redact and list, but they are read-only: readiness always answers `needs_setup` with a pi-ai next action, `createAdapterConfigFromProfile` fails loud instead of producing an adapter, the console no longer offers, creates or updates the retired type (existing profiles stay listed and labelled retired, editable only by deleting and recreating them as pi-ai), and the `--openclaw-local` / `--openclaw-gateway` / `--agent` CLI flags are gone in favour of `reason: 'retired_runtime_kind'` refusals. Rollback is source-level: revert this PR.
- Updated dependencies [e1d6ffc]
  - @principles/core@1.297.0

## 0.13.1

### Patch Changes

- 52d2c6a: Connect Owner-decided principle reuse to shared identity resolution, and add authenticated rule-candidate binding with one bounded revision. Preserve prior PI artifacts across revision epochs and reject stale or revoked binding receipts before generation and publication. The bundled Console exposes binding separately from rule approval and activation.
- Updated dependencies [52d2c6a]
  - @principles/core@1.296.2

## 0.13.0

### Minor Changes

- 0f2d1fb: PRI-1020: Owner-declared context windows (SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001). A new optional `promptBudget` section in `.pd/config.yaml` lets the Owner declare a model's real context window (`declaredContextWindowTokens` + optional per-host `hosts` overrides). It is tier 0 of the injection budget chain — outranking host-reported windows and the model catalog — and scales the budget with the same formula as #2093 (262144 tokens → 4096 chars, cap 16000). This unblocks Codex/WorkBuddy hosts whose adapters carry no window facts and whose custom model ids can never match the installed catalog (previously locked at the 2000-char fallback forever). Console surfaces forecast under the declared basis when no fresh runtime observation exists; a fresh observation still wins. Delete the section to roll back to the previous behavior. Config validation fails loud on malformed values (policy plausibility bounds, closed host set, unknown keys).

### Patch Changes

- Updated dependencies [0f2d1fb]
  - @principles/core@1.296.0

## 0.12.2

### Patch Changes

- 4256244: PRI-1019：为 Codex RuleCode 接通经 Owner 认证的设计事实声明、生成能力检查和逐次运行时事实；缺失或失效事实会暂停依赖规则并显示原因。Console 提供范围登记与撤回入口；保留真实原则审批与逐工件激活流程。
- Updated dependencies [4256244]
  - @principles/core@1.295.3

## 0.12.1

### Patch Changes

- 222d9e0: Connect WorkBuddy live keyword Pain detection to the shared learned correction vocabulary (AUDIT-P3-01, 2026-10-21 remediation; SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001 v0.2): assessWorkbuddyLiveKeyword accepts an optional UnifiedKeywordStore and admitTrustedWorkbuddyLiveCorrection plus the adapter pre-filter now resolve the same shared live store (seed + learned, mtime-cached, seed-only degradation) instead of the four-term P0 projection, so earned-high terms accumulated on other hosts take effect in WorkBuddy. Only high-precision correction terms can trigger automatic Pain (existing gates unchanged: startsWith prefilter, native UserPromptSubmit validation, explicit Owner-statement prefix reservation, both default-OFF flags, no LLM, no transcript reads). Adds direct host-runtime unit tests for the admission boundary (previously adapter-indirect only, AUDIT-P3-04).
- Updated dependencies [765d5c4]
  - @principles/core@1.295.2

## 0.12.0

### Minor Changes

- 48df168: PRI-1017: Console budget forecasts now run under the workspace's most recent runtime budget OBSERVATION, closing the SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1 data-chain gap where the runtime injected under a model-aware budget (e.g. 256K window → 4000 chars) while the console still forecast under its own parameterless fixed 2000-char fallback (`1953/2000`).
  
  - Host-runtime adds a read-only observation model over the EXISTING injection events (`runtime_v2_prompt_activations_injected` JSONL): latest budget fact per host, untrusted-input discipline (closed-set validation, loud skip counts), workspace + host binding, 24h freshness bound, policy-version binding, and pre-policy events skipped rather than reinterpreted. No new database, no second budget state source, no event schema change.
  - The reader is bounded: at most the 7 most recent daily files in each candidate log directory (`.pd/logs` and `.state/logs` — a per-directory cap so a later directory can never be starved of the newest observation), and only the last 4 MiB of each file, so a large log can never stall the console; a cut line is dropped rather than half-parsed, and `truncatedFiles` reports the skip loudly. An observation that only exists in a skipped prefix is reported as absent (honest fallback), never reconstructed.
  - Console surfaces (approvals/grouped badge, activations status rows, post-approval warning) pass the observation-rebuilt `PromptBudgetResolution` into the same production projection; payloads carry `budgetObservedAt` so the UI labels the budget as the most recent runtime observation — never as a live confirmation. Per-host forecasts under an unconfirmed route each carry their own budget basis.
  - Honest degradation: no observation / stale observation (`runtime_budget_observation_stale` reason code) / host mismatch / untrusted event fields all fall back to the fixed budget with traceable reason codes; governance flows are untouched.
  - Also completes a PR #2093 review leftover: the focus-page budget fallback localization keys (10 reason codes + notes) now exist in both en and zh-CN, and the grouped API accepts `?host=workbuddy` like the focus page's host picker.

## 0.11.0

### Minor Changes

- d3796e4: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.
  
  - Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match (host-declared provider) → legacy fixed 2000-char fallback with a bounded machine-readable reason code — provider-less name-only matches NEVER confirm (v0.2 trust amendment: a unanimous name cannot prove the deployment is not a custom endpoint). Budget formula `min(16000, max(1250, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens). The 1250 floor is MEASURED (shared route full render of one minimum viable principle = 849/1204 chars with self-report off/on — lower floors re-create the audited 32K zero-injection defect); the 16000 cap is the Owner target upper bound (1M windows map to 15625).
  - Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 1250..16000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 16000 max tier; cross-host aggregation is monotone — only ALL-hosts overflow brands an entry oversized everywhere); injection events carry budget provenance INCLUDING the bounded `budgetFallbackReason` code.
  - Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
  - Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.

### Patch Changes

- Updated dependencies [d3796e4]
  - @principles/core@1.295.0

## 0.10.4

### Patch Changes

- bf5aed3: Introduce an opt-in WorkBuddy native current-user keyword Pain path using the shared high-precision detector, canonical Pain admission and Diagnostician task continuation. Expose effective keyword detection status; leave the feature off by default and preserve Codex ingestion consent boundaries.
- Updated dependencies [bf5aed3]
  - @principles/core@1.294.1

## 0.10.3

### Patch Changes

- 1a127e2: 修复 RuleCode 新生成契约与路径事实，统一原则范围内的语义验收，并为经过逐规则复验的 Codex V2 规则接通运行上下文。
- Updated dependencies [1a127e2]
  - @principles/core@1.293.5

## 0.10.2

### Patch Changes

- b02ebb5: Connect WorkBuddy current-user explicit Owner pain submissions to existing governance admission and diagnostic task creation. Preserve native session/turn identity, unverified Owner evidence, bounded input rejection and model-visible receipts; retain Codex prefix behavior through the shared parser.
- Updated dependencies [b02ebb5]
  - @principles/core@1.293.4

## 0.10.1

### Patch Changes

- c5f03c8: SPEC-RULECODE-QUALITY-001 A（PRI-995）：RuleCode 可信生成与运行时保护。① 共享门禁对 requiresContextVersion:2 规则强制暂停——provider 缺席/返回 undefined/坏对象/抛异常/schema 合法 unavailable/整体超时时，跳过该 V2 规则（带故障种类警告，evaluatedLiveRules=0），不再把 truthy 不可用上下文当可执行；健康 V1 规则照常执行，shadow 不影响 live。② 新增 artificer 意图依据前置门（消费循环内、构造 runner 之前、零生成调用）：scribe 工件必须带 intentContract 与机器可读 executionConditions，声明的外部可信事实须经宿主 trustedFacts 口可解析；缺失/损坏/冲突映射到 needs_human_review 可审阅停点（intent_unverified/intent_conflict/trusted_fact_provider_absent 等稳定 reasonCode），runner 内置防御镜像杜绝直调绕过；通过时写入带版本与材料摘要的派生核查记录（证据而非通行证，每次重derive）。③ 源 I/O 瞬时故障与 Owner 缺样例分离：重启持久的 1-then-2 周期退避、连续 3 次进 source_fault_persistent 终态（非 Owner 标签）。④ 生成提示删除"最近似代理/params 前置条件当证据"指导（原自填批准产物根源），新增 INTENT EXECUTION CONDITIONS 块；scribe 契约 v8 增加 executionConditions 输出。⑤ 样例包校验新增同输入相反标签冲突检测；deadline 早退补 evaluatedLiveRules=0 观测。
- Updated dependencies [c5f03c8]
  - @principles/core@1.293.2

## 0.10.0

### Minor Changes

- 06152af: Connect Codex Owner-labelled behavior evidence to the shared internalization preflight. Reuse one validated assembler across OpenClaw, Codex and evidence attach/resume; read trajectory data without creating or migrating it and preserve host-specific semantics. Missing labels reach Owner review without model calls or attempts; missing/corrupt sources remain observable source faults.

### Patch Changes

- Updated dependencies [fec1306]
- Updated dependencies [574954a]
  - @principles/install-layout@0.4.0
  - @principles/core@1.293.0

## 0.9.2

### Patch Changes

- eaf52c4: PRI-982 (SPEC-PD-IAER-001 FR-02/FR-04/§4.2): consumer-side evidence preflight + authoritative channel routing for Artificer. The shared consumer cycle resolves the target channel from `pi_metadata.channel` (seed-time bridge authority): only `code_tool_hook` tasks enter ArtificerL2, prompt-channel tasks keep their legal non-L2 pipeline, unresolvable channels refuse to guess. `code_tool_hook` tasks pass a new `preflightArtificerOwnerEvidence` gate BEFORE any runner construction: no Owner selection or an invalid one atomically transitions the task to `needs_human_review` (CAS via `updateTaskIfDiagnosticJsonUnchanged`, humanReviewContext with the stable FR-04 reasonCode + nextAction) with zero LLM calls, zero run records and no attemptCount consumption; a missing host `behaviorEvidence` port degrades observably and leaves the task pending (SPEC §6.2). New optional PITaskMetadata field `ownerEvidenceSelection` (single shape authority shared with the readiness gate; bad values fail the whole metadata closed). The OpenClaw auto-consumer wires the production `BehaviorExamplePackAssembler` through the port (same assembly contract as run-rulehost). ArtificerRunner/prompt builder become channel-aware so the evidence contract no longer kills prompt-channel tasks, while injected packs keep full v2 echo protection on every channel. New telemetry events `artificer_evidence_readiness_checked` / `artificer_blocked_on_owner_evidence` (the latter persisted via the workspace critical-events allowlist).
- eaf52c4: PRI-984 (SPEC-PD-IAER-001 FR-08): unified run-correlation payload for the Artificer evidence telemetry. `artificer_evidence_readiness_checked`, `artificer_blocked_on_owner_evidence`, `artificer_owner_evidence_attached` and `artificer_owner_evidence_resumed` now carry a single shared correlation block (`artificer-run-correlation.ts`, one definition, no per-site drift): taskId, attemptNumber (the task's attemptCount at event-write time; post-resume that is the new budget start certified by the authority reset), workspace, agentKind ('artificer'), executionMode ('preflight' | 'recovery'), a reasonCode on every event (the FR-04 code where one exists, otherwise the operation status — previously the ready/attached verdicts carried no reason field), and evidenceDigestPrefix (first 12 chars of the behavior-pack contentDigest — auditable without pack content; previously only the blocked/attach/resume paths referenced evidence). persistentRunId / adapterRunId stay semantically absent by design: every event fires before the lease-minted run row exists (consumer preflight runs on a dry-run wake — zero run rows) or outside any runtime invocation, and no placeholder ids are fabricated; the correlation joins the next lease's deterministic `run_<taskId>_<attempt>` row through (taskId, attemptNumber), proven on real SQLite by the recovery T10 integration test. The consumer cycle passes its workspaceDir into the preflight so production payloads always identify the workspace. rc-8: bounded scalars only — no raw tool output, no private trajectories.
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
  - @principles/core@1.292.2

## 0.9.1

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/core@1.292.1
  - @principles/install-layout@0.3.1

## 0.9.0

### Minor Changes

- 5e794be: WorkBuddy third host: production runtime hostKind branch, prompt-injection roster, worker status authority, intervention ingress source.

### Patch Changes

- 6e60d84: SPEC-CODEX-PAIN-CLOSURE-001: Codex 痛苦反馈闭环修复。
  
  - CR-01（PRI-960）：工具执行结果三值契约（success/failure/unknown）——缺失退出码不再伪造为 0，snake_case/camelCase 退出码全位置读取；tool_calls 增补 tool_use_id 连接列；consent 门控的 transcript 事实路径把文本型 live 观测升级为宿主核实的最终结果。
  - CR-02/CR-03（PRI-958/959）：明确 Owner 陈述（--owner-statement / PD记录痛苦：前缀，≤500 字拒绝不截断）仅满足空输入证据准入条件；候选行新增 admission_json——不可变评估历史 + 当前指针 + 独立处理进度域；CLI intake 写入许可以持久化完整门禁为准（部分检查仅作快速预拒）。
  - CR-05：诊断成功后的准入/收编/seed 断点由 worker 有界续接（不重跑诊断 LLM，最多 3 次自动尝试，终态可读）。
  - CR-06：pd pain retry 支持 --owner-statement/--dry-run/--confirm 的授权恢复语义。
  - CR-07：Codex 用户消息 `PD记录痛苦：<反馈>` 前缀入口（UserPromptSubmit Hook，登记→任务→回执，无 LLM，幂等）；插件交付 pd-record-pain skill。
  - CR-08：worker 周期活性事实持久化（readiness ≠ liveness）；pd codex worker --status 与 Companion 分开报告活性。
- 0f94f8c: PRI-954 (R1 F10): bounded stage fairness for the internalization consumer — oldest-ready-stage-first.
  
  - core: `InternalizationQueueReadModel` ReadyTask entries now carry the task row's `createdAt` (queue age; additive field, falls back to the hydrated pi-metadata timestamp for legacy rows) so consumers can implement age-based fairness without a second query.
  - host-runtime: `runInternalizationConsumerCycle` starts each cycle's stage scan at the stage owning the globally OLDEST ready task instead of always dreamer-first. Under a continuous stream of new dreamer tasks (each real Pain creates one) downstream stages (philosopher → … → rollout_reviewer) were previously starved for an unbounded number of cycles — measured at 35+ minutes philosopher starvation with a 13-deep backlog in the 2026-10-13 dogfood run. The new order removes the priority-order starvation (the oldest ready task is served before newer arrivals) with no concurrency, no persisted scheduler state (works across one-shot `pd codex worker --once` processes), and with leases, idempotency, dependency order, and single-task-per-cycle semantics unchanged. Ties keep the original priority order; tasks without a readable createdAt never jump the queue.
- Updated dependencies [6e60d84]
- Updated dependencies [0f94f8c]
- Updated dependencies [4ba83b7]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
  - @principles/core@1.292.0
  - @principles/install-layout@0.3.0

## 0.8.3

### Patch Changes

- 69fa3f3: chore(deps): bump js-yaml 5.4.1 -> 5.4.3（#2011）。js-yaml 是 core / host-runtime / plugin / pd-cli / console 的运行时 dependency，console 随 installer 分发，故这 4 个可发布包与 installer 各声明 patch。
- Updated dependencies [69fa3f3]
  - @principles/core@1.291.6

## 0.8.2

### Patch Changes

- 4b84634: Advance the Marketplace runtime pin to the already-published npm versions that carry the Phase 1 intervention-evidence face: codex-adapter 0.5.1 (codex-evidence-recorder), host-runtime 0.8.1 (intervention-evidence-ingress), core 1.291.2 (published by the 2026-10-11T03:51Z release train, carries the #1982 evaluator template-pairing fix). Verified by `npm run check:runtime-pin` (packaged capability probe S1–S5 PASS against npm-installed bytes) plus tarball content inspection of all three evidence modules (re-run against 1.291.2 after the train published it). The previous pin (0.4.7 / 0.7.11 / 1.287.6) predates the Phase 1 evidence recorder, so officially installed Codex hosts had no intervention-evidence surface (acceptance 2026-10-10 §7.2 G-Codex-1).
- Updated dependencies [4b84634]
- Updated dependencies [4b84634]
  - @principles/core@1.291.3

## 0.8.1

### Patch Changes

- ec96a95: PRI-915: wire `ledgerIdentity.isAvailable` in the internalization consumer
  cycle's evaluator construction so an unreadable principle ledger surfaces as
  `identity_source_unavailable` instead of `invalid_identity` drift.
- Updated dependencies [ec96a95]
  - @principles/core@1.291.0

## 0.8.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [d5732f8]
- Updated dependencies [0b981bb]
  - @principles/core@1.290.0

## 0.7.14

### Patch Changes

- 0139c88: PRI-939 Option A — reuse gate degradation visibility. The semantic reuse evaluation's unavailable state is now Owner-visible: reuse_gate_triggered and reuse_evaluation_unavailable persist to the workspace critical-events.jsonl sink (recommended deliberately excluded — no second decision log), the four short-lived CLI commands (pain record / pain retry / diagnose / candidate review) emit through a workspace-scoped telemetry emitter instead of the unsubscribed singleton, the intake gate carries the hook outcome on the CREATE result so CLI outputs show why duplicate protection did not run, and `pd health` summarizes the last unavailable event. Gate behavior unchanged (Rule 4, park semantics, reuseDecision/reuseEvidence untouched).
- Updated dependencies [0139c88]
  - @principles/core@1.289.1

## 0.7.13

### Patch Changes

- cee2304: Use the Codex user governance workspace across projects while resolving tool paths from the active project. Register Marketplace setup with the existing canonical installation so Companion can discover its Codex worker.
- Updated dependencies [df9e555]
  - @principles/core@1.289.0

## 0.7.12

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

## 0.7.11

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

## 0.7.10

### Patch Changes

- da4c731: Identity **writer** boundary (PRI-911A, third gate after the Type Boundary #1851 and the Activation Identity Boundary #1856): `pi_artifacts.source_principle_id` can now only ever hold a **canonical ledger UUID or NULL** — never title/`T-NN`/other display text. Audit trail: `docs/audit/identity-writer-hardening.md`.
  
  **W1 — DreamerRunner no longer carries an LLM-asserted identity.** The runner wrote `output.sourcePrincipleId` straight onto the artifact column; after `stripFabricatedCorePrincipleIds` the only value that can reach it is a Historical Core Principle registry id (`T-NN`), which is not a ledger principle. The column is now left empty and the assertion is reported via `dreamer_identity_assertion_not_carried`. The value still rides in `contentJson`, so the Activations console's Bug-O L1 'unlinked' display is unchanged — stamping the real identity remains ScribeRunner's ledger-verified job (PR #1856 I2).
  
  **W2 — EvaluatorRunner's rule stamp replaced its lenient chain.** Rule assembly previously resolved the identity through column → `contentJson.principleId` → `contentJson.sourcePrincipleId` → `principleDraft.title`, which is exactly how philosopher titles became durable identities in the column. Assembly now reads the bearer's `source_principle_id` column only, gates it through `canonicalLedgerPrincipleId` — the value-level gate split out of PR #1856's `resolveActivationPrincipleId`, so there is still exactly one UUID parser in the repo — and, when the host injects the new optional `EvaluatorRunnerDeps.ledgerIdentity.hasPrinciple`, verifies ledger membership. Outcomes: `evaluator_identity_stamp_success`, or the rule written with a NULL identity plus `evaluator_identity_stamp_failed` carrying `missing_identity` / `non_canonical_identity` / `invalid_identity` (`ambiguous_identity` stays with the bearer/lineage resolvers that can actually see multiplicity).
  
  **Rule assembly is deliberately NOT aborted on an unverified identity** — PR #1856 established that identity gaps are enforced at the publication boundary (rule preserved, no approval subject, no activation), so a wrong identity no longer silently becomes a lost candidate; `evaluator_rule_assembly_failed` keeps its structural meaning. All three production `EvaluatorRunner` construction sites (host-runtime consumer cycle, pd-cli `createEvaluatorRunnerDeps` shared by RuleHost and `runtime internalization run-once`) are wired with the ledger check; unwired callers keep the shape-only gate. The wiring is no longer
  grep-maintained: `identity-writer-production-wiring.test.ts` fails if a production construction site
  drops the injection (or bypasses the sanctioned `createEvaluatorRunnerDeps` factory), or if an identity
  event name drifts away from `TelemetryEventType`. Rollback = revert; no schema change, no data migration, no new flag.
- Updated dependencies [da4c731]
  - @principles/core@1.287.5

## 0.7.9

### Patch Changes

- 42f0f4a: Activation identity boundary is now **ledger-aware and end-to-end** (Phase 3, I2 + I3 — `docs/architecture/principle-identity-reconciliation.md`), fixing the Owner review of PR #1856 where the shape-only gate cut the live production chain.
  
  **I2 — production chain stamping (the missing half of the ADR §6).** `ScribeRunner` now resolves the ledger principle identity through the real chain and stamps it at write time: scribe context → dreamer artifact (`sourceDreamerArtifactId`) → dreamer task seed `diagnosticJson.candidateId` (fallback: the `dreamer-<candidateId>-<channel>` task-id spelling) → `ledger.listForCandidate` exactly-one. Stamping is fail-soft and observable (`identity_stamp_failed` / `identity_stamp_skipped` events; `task_succeeded` carries `sourcePrincipleId`) — an unresolvable or ambiguous chain writes the artifact unstamped instead of guessing. Requires the new optional `ScribeRunnerDeps.ledgerIdentity` dep; unwired callers are unchanged.
  
  **I3 — ledger membership, verified BEFORE the commit.** The gate moved out of the writers (they now only guard `kind` + `validationStatus`) into `ActivationDispatcher.resolveActivationIdentity`, which runs on **both** paths: `enqueueForApproval` (before the approval record — that record *is* the pre-commit state change) and `activateArtifact` (before the activation commit). Resolution states:
  - `direct_validated` — a stamped UUID that the ledger actually contains;
  - `candidate_lineage` — an unstamped artifact resolved through the dreamer lineage;
  - unresolved → `invalid_artifact`. A stamped-but-unknown UUID is data drift (`principle_not_in_ledger: <id>`) and never falls through to lineage guessing.
  
  UUID shape alone never proves membership. Writers no longer refuse identity-less artifacts (they lack ledger deps; the dispatcher is the single gate). Without `ledgerIdentity` deps the legacy strict UUID-shape boundary applies unchanged, so unwired callers keep prior behavior.
  
  Console / CLI / E2E fixtures were migrated to real ledger-backed UUID identities, and **all manual identity stamping in tests was removed** — the identity must now come from the production chain.
  
  **Every production dispatch site is now wired with ledger deps**, so the identity chain is not cut at any entry point:
  
  - `demo-story-a-runner` previously used the synthetic string `demo-principle-<runId>` as the artifact identity and built its dispatcher with no ledger deps — the new gate refused all three channels (`invalid_artifact`). It now mints a **real ledger principle** (`PrincipleTreeLedgerAdapter.writeProbationEntry`, `derivedFromPainIds: [demo-<runId>]`), stamps that UUID onto both artifacts (`makePrincipleArtifactRecord(runId, principleId)`), and passes `ledgerIdentity` to both dispatchers. The Story-A demo exercises the SAME identity contract production does instead of bypassing it.
  - `pd-cli` rollout-parity fixtures seed the durable ledger entry their scribe chain implies (a real principle UUID + `sourceRef`), matching what a production internalization produces.
  - The pd-console **E2E seed** (`scripts/e2e-seed.ts`) now seeds ledger-backed UUID identities for every `pi_artifact` it writes (10 stable UUIDs + `p-001`). Previously the seed pointed artifacts at non-UUID, non-ledger ids (`p-001`, `p-002`, `p-click-*`, `p-rulecode-*`), so under the fail-closed gate the happy-path approvals returned 500 (`no_principle_id_in_artifact`) and — worse — that gate reason **shadowed** the RuleHostWriter golden-trace schema check that `rule-host-writer-golden-trace.spec.ts` asserts. With ledger-resolved identities the gate passes and the schema check runs, so `golden_trace_schema_invalid` surfaces as the spec requires (its own regression contract). Verified locally: `focus-approve-flow` 2/2, `rule-host-writer-golden-trace` 4/4, BDD `focus-page` 1/1.
  - `resolveActivationPrincipleId` now **lowercase-normalizes** the resolved UUID: ledger keys come from `randomUUID()` (always lowercase), so an uppercase-but-shape-valid UUID previously missed `hasPrinciple` and was misreported as `principle_not_in_ledger`.
- Updated dependencies [42f0f4a]
  - @principles/core@1.287.4

## 0.7.8

### Patch Changes

- c7453ea: PR #1844 follow-up: the Governance Focus prompt-injection forecast and the PRI-890 approve-time budget check now read `buildLivePromptInjectionProjection` (host-runtime), which follows the SAME injection route the agent uses — with `abstraction_layer_v1` off (the live default) the forecast replays the plugin's PromptActivationReader → trimToBudget chain instead of always rendering with the shared-path directive wrapper. Previously a saturated 2000-char budget was over-forecast (~3/11 principles "injected" vs the real 9/11), so the Focus page badge and approve warnings overstated budget pressure. Principle selection, FIFO ordering, injection behavior and the budget algorithm are unchanged; parity and boundary regression tests pin the projection to the live path.
- 8b7b775: Security audit run-1 remediation (findings verified against eabbde6d, applied on ccc69252):
  
  - **RuleCode enforcement is now content-bound** (audit HIGH `rulecode-approval-content-unbound`): the production gate and the OpenClaw plugin RuleHost re-verify the current `pi_artifacts` row against the `activation_decisions.artifact_digest` recorded at Owner promotion time before compiling it. A workspace-local rewrite of `content_json` (or lineage fields) is now skipped with a structured `artifact_content_tampered` warning instead of silently executing unapproved code. Rows without a recorded decision (legacy activations) keep their prior behavior. Adds `mapPiArtifactRow`/`PiArtifactRow` exports (the single `pi_artifacts` row→snapshot mapping) so enforcement reproduces the promotion-time digest byte-for-byte.
  - **Replay evaluate is hard-bounded** (audit MEDIUM `rulecode.replay.in-process-evaluate-no-hard-timeout`): pre-activation replay runs each evaluate call through a precompiled vm script with a 2000ms hard timeout — a looping LLM-authored candidate now fails its replay case instead of hanging the console server, evaluator worker, or CLI process.
  - **Governance-store unavailability leaves a durable trace** (audit MEDIUM `gate-failopen-allow-on-state-corruption`): when `state.db` is missing or unreadable, the gate/plugin record a best-effort marker under `~/.pd/enforcement-health/` (outside the agent-writable workspace), and the console governance read model distinguishes "state.db deleted after initialization — enforcement degraded (fail-open)" from a never-initialized workspace.
  - **Console refuses unauthenticated non-loopback binds** (audit MEDIUM `pd-console-noauth-nonloopback-bind`): the loopback-only invariant now keys on the effective authentication state (token-less default included), not just the explicit `--no-auth` flag.
  - **Plugin honors an explicit conversation-access opt-out** (audit LOW `openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out`): the auto-fix repairs only an absent `allowConversationAccess` flag; an explicit `false` (the documented turn-off) is preserved and surfaced as an honored Owner opt-out instead of being silently rewritten on every gateway start.
- Updated dependencies [99e6a8c]
- Updated dependencies [edbbcd9]
- Updated dependencies [8b7b775]
- Updated dependencies [9d98f89]
- Updated dependencies [92074a0]
  - @principles/core@1.287.2
  - @principles/install-layout@0.2.7
