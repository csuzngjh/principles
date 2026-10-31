# Changelog

## 1.297.10

### Patch Changes

- 3996007: Reconcile the prompt size-guard ceiling with the model-aware principle budget: the total injection limit is now the applied principle budget plus a fixed 7000-char background allowance instead of a hard-coded 9000, so large-window models no longer have every background block stripped in one turn (PRI-1065). The reference window still resolves to 9000, so existing behavior is unchanged. The stripped-context notice also no longer claims a diagnostician-priority session, which was untrue whenever the guard fired outside that mode.

## 1.297.9

### Patch Changes

- 216ddbb: Bind Stage A evidence references to the trusted diagnosis context. Unknown or copied prompt-example refs now fail closed with `evidence_ref_unbound` before an artifact or candidate can be created (PRI-1059).

## 1.297.8

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

## 1.297.7

### Patch Changes

- 02610af: Rule association shadow contracts + router source evidence (SPEC-RULE-ASSOCIATION-005).
  
  - Diagnostician output gains an opt-in V2 shadow shape: a rule recommendation may
    carry `principleAssociation` (`linked` with `recommendation_ref` /
    `canonical_principle` target, or `unresolved` with a fixed reason), plus a
    `recommendationRef` on every recommendation. V1 generation and validation are
    unchanged — nothing is promoted, and each association is marked
    `authorizesGeneration: false`.
  - The diag router now records system-owned invocation evidence (message,
    system prompt and predecessor artifact digests, never model output) and writes
    a `trustedContextReceipt` (`router-context-v1`) into the committed diagnostician
    content, re-verified at the write boundary before the commit proceeds. The
    receipt reports `canonicalPrinciples.status = 'unavailable'` because the router
    has no system-owned canonical Principle allowlist; source association therefore
    stays in shadow.
  - Rollback: revert this change — no persisted schema, flag or migration is added,
    and the extra receipt key is additive on the V1 envelope.

## 1.297.6

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

## 1.297.5

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

## 1.297.4

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

## 1.297.3

### Patch Changes

- 44a9d3d: Codex agent-assisted explicit pain registration (no prefix).
  
  When the Owner's current message explicitly asks to create a pain signal and provides the feedback, the agent can now complete the registration itself instead of demanding a `PD记录痛苦：` resend:
  
  - The Codex hook publishes the CURRENT turn's host-verified identity (ids/paths only, never prompt text) to a session-hash-partitioned file under `<workspace>/.state/` on every UserPromptSubmit and withdraws only that session's matching turn on Stop (or that session on SessionStart). `pd pain explicit` selects the file using the host-bound `CODEX_SESSION_ID` and rejects conflicting `CODEX_THREAD_ID`; missing identity fails closed.
  - New `pd pain explicit --statement "<Owner 原文>" [--workspace] [--json]` registers through the SAME admission chain as the prefix entry (governance admission marker, explicit 5/hour bucket, diagnostician task ensure, idempotent same-turn convergence). The command takes no lineage flags — lineage comes exclusively from the host-written turn context and is re-validated at registration time.
  - Provenance is auditable: agent-assisted registrations carry `channel: codex_explicit_agent` and an "agent-assisted, no prefix" pain reason, distinct from the hook-read `codex_explicit_prefix` channel (additive literal in the shared PainCorrectionEvidence schema; prefix behavior byte-identical).
  - The `pd-pain-signal` skill now mandates agent-assisted registration for explicit no-prefix requests (verbatim Owner words only, receipt-idempotency check first, honest failure reporting); the "ask the Owner to resubmit" absolute rule is retired, and `pd pain record` remains the post-hoc operator recovery path.

## 1.297.2

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

## 1.297.1

### Patch Changes

- 004acb4: Unify the RuleCode textual-basis anchoring check (continuous verbatim span) across the scribe success boundary and the artificer intent preflight, feed scribe validator rejections back into the next model attempt with cross-epoch freshness, and add one bounded authenticated source-correction recovery per rule candidate that CAS-reopens the original needs_human_review artificer on the new scribe epoch. Leases now count attempts per revision epoch while run ordinals stay globally sequential, so reopened epochs actually receive their original maxAttempts. The bundled Console (ships inside create-principles-disciple) gains an authenticated source-correct-once entry whose receipt binds the Owner actor, binding revision, artifact digest and stop reason. Owner review R6: bash-command risk classification is unified across the host gate, the OpenClaw enrichment and golden-trace replay (git mutations and arbitrary code execution count as mutating); approval-gate rules must keep read-only investigation allowed under not_approved, verified by a system-generated counterfactual; the scribe success boundary rejects undeclared approval dependencies.
- c7d3f29: PRI-1048：治理焦点「规则的正式原则归属」队列修复父子任务重复并改版为可理解的来源/阶段/操作卡片。根因：`getCandidatesByTaskId` 本身按「自身+子任务」查询，队列又同时遍历 diagnostician 与 diag_router 任务列表，router 子任务提交的候选被父诊断带出一次、router 再带出一次（真实 workspace 9 候选显示 18 条）。修复在队列聚合所有者（RuleCandidateBindingConsoleModel.list）按 canonical candidateId 去重，共享 store 查询语义不变。同时把队列 DTO 从 candidateId/text/reason 扩展为只读投影：来源痛苦信号原文（trajectory.db 批量只读）、诊断状态、绑定态与原则正文（ledger 权威）、生成链阶段（dreamer→…→rollout_reviewer，受阻带 reasonCode）、修订资格（真实 `resolveRuleBindingRevisionTarget` + 与 reviseRuleBindingOnce 相同的预算规则，仅导出既有函数，无逻辑复制）；前端改为按痛苦信号分组的有界卡片（默认回答「哪次反馈/卡在哪/要做什么」，技术 ID 与原始 JSON 折叠进「技术详情」），「修订并继续」仅在真实资格 ready 且链不在运行时出现，不摆不能执行的按钮，也不把通用重试冒充源修订；@principles/core 仅把 `resolveRuleBindingRevisionTarget` 加入 runtime-v2 barrel 导出（冻结快照同步 +1）。

## 1.297.0

### Minor Changes

- e1d6ffc: PRI-1023: retire the `openclaw-cli` sub-agent runtime backend (ADR-0029). pi-ai is now the only backend PD executes internal agents on; OpenClaw stays supported as a *host*, never as a delegated CLI agent session. Legacy `type: openclaw` profiles still parse, redact and list, but they are read-only: readiness always answers `needs_setup` with a pi-ai next action, `createAdapterConfigFromProfile` fails loud instead of producing an adapter, the console no longer offers, creates or updates the retired type (existing profiles stay listed and labelled retired, editable only by deleting and recreating them as pi-ai), and the `--openclaw-local` / `--openclaw-gateway` / `--agent` CLI flags are gone in favour of `reason: 'retired_runtime_kind'` refusals. Rollback is source-level: revert this PR.

## 1.296.2

### Patch Changes

- 52d2c6a: Connect Owner-decided principle reuse to shared identity resolution, and add authenticated rule-candidate binding with one bounded revision. Preserve prior PI artifacts across revision epochs and reject stale or revoked binding receipts before generation and publication. The bundled Console exposes binding separately from rule approval and activation.

## 1.296.1

### Patch Changes

- 4922dda: PRI-1041：按上游声明确定 RuleCode 必需验证，区分历史证据与可回放事实，独立系统契约测试贯通 L2 自测/提交、Runner、Evaluator 与工件装配；缺少能力或必需覆盖时不再错误标记为验证通过。

## 1.296.0

### Minor Changes

- 0f2d1fb: PRI-1020: Owner-declared context windows (SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001). A new optional `promptBudget` section in `.pd/config.yaml` lets the Owner declare a model's real context window (`declaredContextWindowTokens` + optional per-host `hosts` overrides). It is tier 0 of the injection budget chain — outranking host-reported windows and the model catalog — and scales the budget with the same formula as #2093 (262144 tokens → 4096 chars, cap 16000). This unblocks Codex/WorkBuddy hosts whose adapters carry no window facts and whose custom model ids can never match the installed catalog (previously locked at the 2000-char fallback forever). Console surfaces forecast under the declared basis when no fresh runtime observation exists; a fresh observation still wins. Delete the section to roll back to the previous behavior. Config validation fails loud on malformed values (policy plausibility bounds, closed host set, unknown keys).

## 1.295.3

### Patch Changes

- 4256244: PRI-1019：为 Codex RuleCode 接通经 Owner 认证的设计事实声明、生成能力检查和逐次运行时事实；缺失或失效事实会暂停依赖规则并显示原因。Console 提供范围登记与撤回入口；保留真实原则审批与逐工件激活流程。

## 1.295.2

### Patch Changes

- 765d5c4: Decouple the signal_confirmations batch consumer from the correction_observer flag (AUDIT-P2-04, 2026-10-21 remediation): the periodic cycle now starts when signal_collector is enabled (default on) even with correction_observer off (default), so persisted pending confirmations are consumed instead of remaining invisible permanent-pending records. Keyword optimization remains exclusively gated by correction_observer and is never silently enabled. Batch skips due to an unavailable classifier are now counted (stage2BatchSkipped) and pd config doctor classifies backlog-plus-skip as degraded with an actionable next action.

## 1.295.1

### Patch Changes

- c754ef5: Align RuleCode intent verification with the original Owner-attributed diagnosis evidence supplied to Scribe, while preserving lineage checks and trusted-approval requirements.

## 1.295.0

### Minor Changes

- d3796e4: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.
  
  - Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match (host-declared provider) → legacy fixed 2000-char fallback with a bounded machine-readable reason code — provider-less name-only matches NEVER confirm (v0.2 trust amendment: a unanimous name cannot prove the deployment is not a custom endpoint). Budget formula `min(16000, max(1250, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens). The 1250 floor is MEASURED (shared route full render of one minimum viable principle = 849/1204 chars with self-report off/on — lower floors re-create the audited 32K zero-injection defect); the 16000 cap is the Owner target upper bound (1M windows map to 15625).
  - Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 1250..16000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 16000 max tier; cross-host aggregation is monotone — only ALL-hosts overflow brands an entry oversized everywhere); injection events carry budget provenance INCLUDING the bounded `budgetFallbackReason` code.
  - Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
  - Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.

## 1.294.2

### Patch Changes

- 0dc0431: chore(deps): bump @sinclair/typebox 0.34.49 -> 0.34.52（#2087）。typebox 是 core / plugin / console 的运行时 dependency，console 随 installer 分发，故 core、plugin 与 installer 各声明 patch。

## 1.294.1

### Patch Changes

- bf5aed3: Introduce an opt-in WorkBuddy native current-user keyword Pain path using the shared high-precision detector, canonical Pain admission and Diagnostician task continuation. Expose effective keyword detection status; leave the feature off by default and preserve Codex ingestion consent boundaries.

## 1.294.0

### Minor Changes

- 6f33c29: PRI-966 G2: register the Learning Lab real-actor round contract (`learning-lab-actor-action-v1`) in OUTPUT_SCHEMA_REGISTRY and export its schema — lets the research actor reuse the production PiAiRuntimeAdapter structured-output machinery. Production runners never pass this ref (research-only consumer; wired and rehearsed offline in scripts/dev/principle-learning-lab, no real model calls).

## 1.293.5

### Patch Changes

- 1a127e2: 修复 RuleCode 新生成契约与路径事实，统一原则范围内的语义验收，并为经过逐规则复验的 Codex V2 规则接通运行上下文。

## 1.293.4

### Patch Changes

- b02ebb5: Connect WorkBuddy current-user explicit Owner pain submissions to existing governance admission and diagnostic task creation. Preserve native session/turn identity, unverified Owner evidence, bounded input rejection and model-visible receipts; retain Codex prefix behavior through the shared parser.

## 1.293.3

### Patch Changes

- 1eb5293: Upgrade the Pi runtime dependency from @earendil-works/pi-ai / pi-agent-core 0.85.1 to 1.2.0 (SPEC-PD-PI12-COMPAT-001). Migrates the three runtime adapters to the Pi 1.2 agent-loop contract: the system prompt now rides the transcript as a leading system message (also fixing the duplicated user message in every L2 request under 0.85.x), shouldStopAfterTurn is replaced by finishTurn with the upstream canonical error/aborted guard, convertToLlm passes the system role through, and the ToolCall extraction predicate adopts the SDK type (arguments narrowed to JsonObject). Regenerates all installer release locks on the Node 22 / npm 10 toolchain; pi-agent-core's runtime dependency tree shrinks to pi-ai + typebox. No governance, activation, or approval behavior changes; Artificer keeps fail-closed semantics (no L1 fallback) and the Owner-Evidence gate is untouched.
- d91b9e0: PRI-1011: an LLM run whose output budget the provider rejects now recovers instead of burning all retries on the same rejected value.
  
  - core: `completeWithRetry` recognises the "requested max_tokens exceeds the maximum output tokens" signature (resolved error responses and thrown errors alike) and halves the budget for the next attempt of that same run — a profile that was never rejected keeps sending exactly what it sends today. A profile that relies on pi-ai native defaulting gets an explicit number for the retry, because resending `undefined` would resend the value the provider just rejected.
  - The ladder stops at a 4096 floor: below that a structured answer is routinely cut off, so further halving would trade a provider rejection for a silent truncation. At the floor the run still fails loud as `execution_failed` with the provider evidence intact.
  - Each step emits an observable `llm_max_tokens_downshift` event (from/to, provider, model, attempt, provider evidence), so the Owner can see what was tried rather than only that something failed.
  - Rate limits, timeouts and unrelated 4xx keep their existing classification and trigger no downshift.
  
  This release train patches `@principles/core`; the correction observer and the other internal agents call it through the bundled `principles-disciple` plugin, and the installer bundles the plugin, so both must be declared in the same plan (release-intent rule N-5/C4). No plugin or installer code changes.

## 1.293.2

### Patch Changes

- c5f03c8: SPEC-RULECODE-QUALITY-001 A（PRI-995）：RuleCode 可信生成与运行时保护。① 共享门禁对 requiresContextVersion:2 规则强制暂停——provider 缺席/返回 undefined/坏对象/抛异常/schema 合法 unavailable/整体超时时，跳过该 V2 规则（带故障种类警告，evaluatedLiveRules=0），不再把 truthy 不可用上下文当可执行；健康 V1 规则照常执行，shadow 不影响 live。② 新增 artificer 意图依据前置门（消费循环内、构造 runner 之前、零生成调用）：scribe 工件必须带 intentContract 与机器可读 executionConditions，声明的外部可信事实须经宿主 trustedFacts 口可解析；缺失/损坏/冲突映射到 needs_human_review 可审阅停点（intent_unverified/intent_conflict/trusted_fact_provider_absent 等稳定 reasonCode），runner 内置防御镜像杜绝直调绕过；通过时写入带版本与材料摘要的派生核查记录（证据而非通行证，每次重derive）。③ 源 I/O 瞬时故障与 Owner 缺样例分离：重启持久的 1-then-2 周期退避、连续 3 次进 source_fault_persistent 终态（非 Owner 标签）。④ 生成提示删除"最近似代理/params 前置条件当证据"指导（原自填批准产物根源），新增 INTENT EXECUTION CONDITIONS 块；scribe 契约 v8 增加 executionConditions 输出。⑤ 样例包校验新增同输入相反标签冲突检测；deadline 早退补 evaluatedLiveRules=0 观测。

## 1.293.1

### Patch Changes

- 807fcab: 修正纠正词库到顶后学习通道冻结的根因：满 200 词时按证据淘汰最没用的学习词（seed/user 永不被淘汰），不再抛错；UPDATE/REMOVE 与 ADD 共用同一条词身份规则，未命中只记一次可读跳过；拒绝把动作词当 term 入库；学习不再删除 Owner 播种词；每次词库变更进 SYSTEM 日志。Stage2 回写不再用判词覆盖命中词，观察员据此拿到真实的 REMOVE 证据。

## 1.293.0

### Minor Changes

- 574954a: PRI-990: single-task failed recovery — pd runtime recovery failed-task --task-id <exact> (dry-run default, CAS-guarded confirm, explicit --reset-budget for exhausted budgets, recovery_actions.jsonl audit with previousAttemptCount). Core: recoverSingleFailedTask + inspectFailedTaskRecovery strict path; legacy batch recoverFailedTask upgraded to the same CAS precondition with unchanged observable behavior.

## 1.292.2

### Patch Changes

- eaf52c4: PRI-981 (SPEC-PD-IAER-001 FR-01/FR-05): add the shared, side-effect-free evidence readiness gate (`assessEvidenceReadiness` + `EvidenceReadiness` contract, runtime-v2 internalization) and harden ArtificerRunner so a missing or invalid BehaviorExamplePack fails as a structured permanent `input_invalid` (PDRuntimeError with reasonCode/nextAction) instead of a plain retryable execution failure. A missing pack no longer burns retry attempts or reaches the model.
- eaf52c4: PRI-982 (SPEC-PD-IAER-001 FR-02/FR-04/§4.2): consumer-side evidence preflight + authoritative channel routing for Artificer. The shared consumer cycle resolves the target channel from `pi_metadata.channel` (seed-time bridge authority): only `code_tool_hook` tasks enter ArtificerL2, prompt-channel tasks keep their legal non-L2 pipeline, unresolvable channels refuse to guess. `code_tool_hook` tasks pass a new `preflightArtificerOwnerEvidence` gate BEFORE any runner construction: no Owner selection or an invalid one atomically transitions the task to `needs_human_review` (CAS via `updateTaskIfDiagnosticJsonUnchanged`, humanReviewContext with the stable FR-04 reasonCode + nextAction) with zero LLM calls, zero run records and no attemptCount consumption; a missing host `behaviorEvidence` port degrades observably and leaves the task pending (SPEC §6.2). New optional PITaskMetadata field `ownerEvidenceSelection` (single shape authority shared with the readiness gate; bad values fail the whole metadata closed). The OpenClaw auto-consumer wires the production `BehaviorExamplePackAssembler` through the port (same assembly contract as run-rulehost). ArtificerRunner/prompt builder become channel-aware so the evidence contract no longer kills prompt-channel tasks, while injected packs keep full v2 echo protection on every channel. New telemetry events `artificer_evidence_readiness_checked` / `artificer_blocked_on_owner_evidence` (the latter persisted via the workspace critical-events allowlist).
- eaf52c4: PRI-983 (SPEC-PD-IAER-001 FR-03/FR-06/FR-07): Owner evidence attach and controlled resume. New `pd runtime internalization evidence list|attach|resume` command group (all default dry-run, `--confirm` mutates): list surfaces Artificer tasks blocked on evidence (needs_human_review + stable FR-04 reasonCode) with pain linkage, missing fields and next actions; attach assembles through the production BehaviorExamplePackAssembler and persists the Owner selection into `pi_metadata.ownerEvidenceSelection` via the narrow diagnosticJson CAS with new provenance fields (revision, contentDigest, ownerOperation, attachedAt — ABSENT=legacy, single shape authority shared with the readiness gate); the task stays needs_human_review (attach never unblocks). resume re-assembles, verifies the stored sha256 contentDigest (mismatch → `owner_behavior_examples_stale`; cross-session → `owner_behavior_examples_scope_mismatch` via a new typed, structural scope-error classification in the plugin assembler — no message sniffing) and performs the atomic authority reset through the single recovery authority `ownerRetryNeedsHumanReviewTask`, which gains an optional CAS precondition (expected diagnosticJson + expected status) so at most one concurrent resume wins (T06); the attempt-budget reset is explicit, digest-verified and audited with previousAttemptCount in the existing `.state/recovery_actions.jsonl` append-only log. FR-07: the run-rulehost BEP gate and its confirm-time assembly now derive refusal reasons from the same shared Evidence Readiness judgment (`assessEvidenceReadiness`) the consumer preflight uses — identical inputs produce identical stable reason codes on both production entries, with no V1 fallback and unchanged command parameters. New telemetry events `artificer_owner_evidence_attached` / `artificer_owner_evidence_resumed` (bounded payloads, no raw trajectories).
- eaf52c4: PRI-984 (SPEC-PD-IAER-001 FR-08): unified run-correlation payload for the Artificer evidence telemetry. `artificer_evidence_readiness_checked`, `artificer_blocked_on_owner_evidence`, `artificer_owner_evidence_attached` and `artificer_owner_evidence_resumed` now carry a single shared correlation block (`artificer-run-correlation.ts`, one definition, no per-site drift): taskId, attemptNumber (the task's attemptCount at event-write time; post-resume that is the new budget start certified by the authority reset), workspace, agentKind ('artificer'), executionMode ('preflight' | 'recovery'), a reasonCode on every event (the FR-04 code where one exists, otherwise the operation status — previously the ready/attached verdicts carried no reason field), and evidenceDigestPrefix (first 12 chars of the behavior-pack contentDigest — auditable without pack content; previously only the blocked/attach/resume paths referenced evidence). persistentRunId / adapterRunId stay semantically absent by design: every event fires before the lease-minted run row exists (consumer preflight runs on a dry-run wake — zero run rows) or outside any runtime invocation, and no placeholder ids are fabricated; the correlation joins the next lease's deterministic `run_<taskId>_<attempt>` row through (taskId, attemptNumber), proven on real SQLite by the recovery T10 integration test. The consumer cycle passes its workspaceDir into the preflight so production payloads always identify the workspace. rc-8: bounded scalars only — no raw tool output, no private trajectories.

## 1.292.1

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.

## 1.292.0

### Minor Changes

- 5e794be: WorkBuddy third host shared contract: GovernanceHostKind and evidence source-kind unions widen with 'workbuddy'; hook-log anti-forgery parity; intervention capability-declarations CHECK migrated (row-preserving).

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
- 4ba83b7: PRI-955 (R1 F11): the Console no longer equates "no failed tasks" with "the pipeline is healthy".
  
  - `GET /api/v1/failed-tasks` now returns a derived `pipeline` health block computed on read from the same state.db facts the list already uses — no new persistence, no second truth. Counts come from an exact read-only COUNT(*)/MIN/MAX aggregate scoped to learning-pipeline runner kinds (pendingCount is never a LIMIT-truncated list length; the progress timestamp ignores succeeded tasks outside the learning pipeline). Status semantics: `stalled` (work waiting, no progress inside the window), `backlogged` (work waiting, still progressing — with its own nextAction), `healthy` (nothing waiting plus fresh runner-kind progress evidence), `disabled` (internalization_auto_consumer off — learning cannot advance), `unknown` (unreadable counters or a fresh workspace with no evidence) — every non-healthy state carries a nextAction, and unknown is never reported as healthy. Status semantics: `stalled` (work waiting, no progress inside the window), `backlogged` (work waiting, still progressing), `healthy` (nothing waiting plus fresh progress evidence), `unknown` (unreadable counters or a fresh workspace with no evidence) — every non-healthy state carries a nextAction, and unknown is never reported as healthy.
  - Failed-tasks page: the empty copy no longer claims "PD 管道运行正常"; it states the fact ("当前查询范围内没有失败任务") and renders the learning-queue health card (both zh-CN and en). The card also renders above the list when tasks exist.
  
  Dogfood evidence (2026-10-13, F11): a 13-deep philosopher backlog starving for 35+ minutes was reported by this page as "没有失败任务。PD 管道运行正常。"

## 1.291.6

### Patch Changes

- 69fa3f3: chore(deps): bump js-yaml 5.4.1 -> 5.4.3（#2011）。js-yaml 是 core / host-runtime / plugin / pd-cli / console 的运行时 dependency，console 随 installer 分发，故这 4 个可发布包与 installer 各声明 patch。

## 1.291.5

### Patch Changes

- 4e56337: Derivation-fidelity obligations for the internalization chain (Phase 1 acceptance r6). Live-chain evidence (p1-final r4 chain, 2026-10-12) showed the chain dying on a rule demanded to read "Owner write-confirmation records" from `input.context` — a field the RuleHost stateless single-call contract does not carry — because (a) the Scribe promoted a diagnosis **implementation recommendation** (a design proposal for persisted confirmation records) into `intentContract` as if Owner-mandated while silently narrowing the Owner's "ALL protected/ access (including read-only) requires confirmation" to write-only gating, and (b) the judge, treating the contract as the definition of correctness, put the unexpressible check into `requiredChanges`. Two additive prompt-contract clauses, no schema/validator/oracle/replay/routing changes: Scribe `scribe-output-v1.prompt.v6` adds OWNER-SOURCE GROUNDING (contract requirements must be grounded in the diagnosis's Owner-attributed statements, never in implementation recommendations; carried derived mechanisms must be marked `derived_mechanism:` in risks; every Owner-attributed requirement not carried into the contract must be declared with a structured `owner_requirement_gap:` risks entry — silence about a dropped requirement is a fidelity defect). Evaluator `evaluator-output-v1.prompt.v9` adds RULEHOST EXPRESSIBILITY (requiredChanges may only demand behavior the stateless single-call contract can express; demands presupposing new input go to concerns). r6 review round (2026-10-12) then bumped both contracts again: scribe `scribe-output-v1.prompt.v7` moves gap disclosure into a STRUCTURED `ownerRequirementGaps` output field (validated, machine-consumed — the free-text risks prefix had no downstream consumer), and evaluator `evaluator-output-v1.prompt.v10` replaces the concerns-prefix mismatch protocol with a STRUCTURED `evaluation.mismatchFindings` field (the prefix scan mis-routed a negative-sentence mention to human review on a live chain) and separates four situations — a disclosed derived implementation choice is NOT a divergence; false attribution to the Owner and defeating Owner-attributed requirements are; RuleHost-inexpressible requirements follow the EXPRESSIBILITY path and route to the Owner through concerns and the pipeline's gap surface instead. scopePrecision is unchanged: a declared limitation never auto-passes misblock/miss checks. Obligation regressions were executed red against the pre-fix code, then green; internalization suite 80 files / 1190 tests PASS.
  
  **pd-cli (@principles/pd-cli)**: the rulehost pipeline reads the scribe's structured `ownerRequirementGaps` and carries them on EVERY post-scribe outcome — candidate-ready, text-principle-only, identity-unverified, enqueue-failed, and all post-scribe rejection paths (`RuleHostPipelineResult.ownerRequirementGaps`, via `withGaps`/`readScribeOwnerRequirementGaps`). Declared gaps therefore reach the Owner on any outcome and can never silently count as satisfied.

## 1.291.4

### Patch Changes

- 3c98904: Wire the evaluator's failed-case `caseInput` into the CLI adversarial feedback formatter (`formatAdversarialFeedback`). Phase 1 final acceptance review found that #1986's `caseInput` field reached the persisted evaluator artifact but not the repair loop it was built for: `formatAdversarialFeedback` is the ONLY feedback channel into loop-created round-2 Artificer tasks (the PRI-509 repairPayload channel does not apply to them), and it rendered only `caseId | attackType | expected vs actual | rationale`. Live-chain evidence (p1-final sandbox, 2026-10-11): the real round-2 task's persisted diagnosticJson carried exactly one verdict line — `v2-path-boundary [boundary]: expected block, got allow — validation_failed: Expected block but got allow` — with no failure path and no context facts, so the artificer repaired blind and the chain was rejected on the same deterministic case twice. Failed cases now append an indented `caseInput:` continuation line (already bounded by the producer's shared 400-char budget; absent on legacy artifacts renders nothing). Formatter-only change: validator, oracle, and prompt contracts unchanged.

## 1.291.3

### Patch Changes

- 4b84634: Carry the failed adversarial case's defining input into the repair round and document the context.facts field semantics in the Artificer prompt (contract v10 → v12). Live p1-closeout chain evidence: with the #1982 pairing fix active, artificer r2 converged (2 template failures → 1) but the remaining `v2-path-boundary` failure was unactionable — the repair evidence named only `Expected block but got allow`, dropping the case's tool/params/context facts and authored rationale, and the prompt never defined what `priorReadOfTarget`/`readCount` mean. Failed-case entries now carry a bounded `caseInput` summary (rc-8) rendered as an `Input:` line in the repair prompt. CONTEXT MODE states the facts semantics as WINDOW-OBSERVATION FACTS ONLY: v11's allow/block mapping (yes = legitimate edit, 0 = fresh session, no+>0 = block) claimed more than the fields prove — a read count cannot establish Owner confirmation, file pre-existence, or sibling relation — and v12 replaces it with an obligation to report unverifiable constraints as observation gaps in `risks`. Review round 2: the params digest is TARGET-FIRST — the case's own target (path/file_path via the existing resolveCasePathParam contract) gets an independent budget written ahead of content fields, so legal edit payloads with long oldText/newText can no longer evict `protected/…` from the repair input; a long target truncates visibly inside its own budget, and a case with no derivable target says so explicitly. Validator, templates, and oracle unchanged.
- 4b84634: Give the Evaluator judge the host's OWN tool-to-kind mapping as the kind authority (contract v6 → v8). Live p1-closeout chain evidence: a rule whose write gate branched on `input.action.canonicalKind === 'write'` passed the FULL deterministic replay, yet the LLM judge returned needs_revision claiming "edit/apply_patch return allow" — the prompt's tool catalog carried tool NAMES without any kind mapping. The first fix (v7) over-corrected by claiming every writeTools entry dispatches as 'write'; the real OpenClaw catalog is a RISK grouping whose writeTools also includes a shell tool dispatching 'execute' and an agent-delegation tool dispatching 'agent'. v8 projects the runner's existing host semantic context into the judge prompt as `input.hostToolKinds` (no second mapping table), marks the catalog as never-a-kind-table, keeps unknown when no mapping is present, and re-allows concrete evidenced parameter-shape coverage flags. Replay gate, validator, and decision thresholds unchanged.

## 1.291.2

### Patch Changes

- 10d7e4b: Derive write-context templates from one complete, compatible positive example. Fail explicitly when required templates cannot be derived, before auxiliary cases can make an incomplete replay appear successful.

## 1.291.1

### Patch Changes

- 11fd509: Artificer prompt contract v10: state the Owner-labelled case echo obligation the v2 output gate enforces — a missing or renamed caseId is rejected, while a kept caseId is restored from the authoritative pack before validation — so v2 rule generation stops failing on cases the model was never told to carry.

## 1.291.0

### Minor Changes

- ec96a95: PRI-915: make principle-ledger availability decidable so identity refusals no
  longer misreport a transient outage as data drift.
  
  - `readLedgerFileState(stateDir)` (new): returns the ledger store plus a
    `LedgerFileAvailability` tri-state — `ok` / `empty` (no file or zero-byte
    file: a true empty ledger) / `unreadable` (exists but read/parse failed,
    with the underlying problem). `loadLedger` behavior is unchanged.
  - `PrincipleTreeLedgerAdapter.isAvailable()` (new): false only when the ledger
    file exists but cannot be read.
  - `LedgerIdentityChecker` gains the required `isAvailable()`; production and
    test implementations are updated.
  - `resolveLedgerActivationId` reports `ledger_unavailable: …` instead of
    `principle_not_in_ledger` while the ledger is unreadable (direct and lineage
    paths).
  - `EvaluatorRunner` identity stamp gains the fifth failure reason
    `identity_source_unavailable` (checked before membership) and
    `ScribeRunner` reports `ledger_unavailable` in its skip event reason.

## 1.290.0

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

## 1.289.2

### Patch Changes

- 6365e2e: R7: the two candidate→ledger read/audit surfaces are now reuse-aware. `pd trace`
  (`PainChainReadModel`) resolves a consumed candidate into the ledger through BOTH
  expressions — `derivedFromPainIds` (created) and `Principle.reuseEvidence[]`
  (resolved into an existing principle by a reuse decision, zero ledger growth by
  design) — so a successful reuse chain traces as `succeeded` with the reuse target
  in `ledgerEntryIds` instead of the false `degraded/ledger_write_failed`.
  `auditCandidateLedgerConsistency` (pd health / pd candidate audit, now one shared
  judgment) no longer flags by-design-absent candidates as missing: reuse-resolved
  candidates are counted in the new additive `reusedResolvedCount`, and consumed
  candidates whose `recommendation_kind` never targets the Principle Ledger (rule /
  implementation / prompt / defer; fail-closed unknown kinds) are counted in
  `nonLedgerKindCount`. Only a consumed principle-kind candidate with no resolution
  anywhere remains true drift (`missingLedgerEntryIds` lists them). On the R7
  production workspace this drops the audit from 63 missing (52+ kind/reuse false
  positives masking real drift) to 5 true-drift entries. No write path changes.
  Audit error results additionally surface the bounded underlying failure reason
  (e.g. a stale state.db schema) with a concrete next action instead of a generic
  refusal, on `pd candidate audit` and every surface sharing the judgment.

## 1.289.1

### Patch Changes

- 0139c88: PRI-939 Option A — reuse gate degradation visibility. The semantic reuse evaluation's unavailable state is now Owner-visible: reuse_gate_triggered and reuse_evaluation_unavailable persist to the workspace critical-events.jsonl sink (recommended deliberately excluded — no second decision log), the four short-lived CLI commands (pain record / pain retry / diagnose / candidate review) emit through a workspace-scoped telemetry emitter instead of the unsubscribed singleton, the intake gate carries the hook outcome on the CREATE result so CLI outputs show why duplicate protection did not run, and `pd health` summarizes the last unavailable event. Gate behavior unchanged (Rule 4, park semantics, reuseDecision/reuseEvidence untouched).

## 1.289.0

### Minor Changes

- df9e555: PRI-917 v0.3.3 (OD-PRI917-05): Reuse Review Gate — automatic candidate intake now consults the semantic reuse evaluation capability before creating a Principle.
  
  A `reuse` recommendation parks the candidate (`refused/reuse_pending_owner`): no Principle is written, no evidence is appended, the candidate stays pending for the Owner, and the bridge emits an observable `reuse_gate_triggered` event plus a `reuse_review_required` outcome pointing at `pd candidate review --decide reuse|create`. `create`/`uncertain` recommendations and every evaluation failure degrade to normal creation (learning never blocks). `reuseEvaluation.enabled=false` restores the exact pre-v0.3.3 behavior.
  
  Also fixes the R5 "two-heads-block" defect: `pd candidate review --decide reuse` no longer lets the PRI-442 admission pre-check reject low-confidence candidates — a reuse verdict creates nothing, so the ledger-quality gate does not apply (the `--decide create` pre-check is unchanged).
  
  PR review fixes (4×P2, PRI-938): the bridge cache key now folds in the reuse-gate switch so a long-lived host picks up `reuseEvaluation.enabled` toggles in both directions (T11 rollback without a restart); mixed batches and replays keep parked candidates visible (`reuse_review_required` degraded outcome, Codex worker `reuseReviewRequiredCandidateIds`, OpenClaw `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` log gated on the park disposition); `pd diagnose` / `pd pain-retry` render parked candidates with review guidance and exclude them from `internalize` next-action lists.
  
  Follow-up review fixes: evaluation profile and timeout changes invalidate the cached reuse hook. Replay verifies the original diagnosis admission and performs a read-only reuse check before reporting a parked candidate, preserving failed-intake and gate-disabled behavior without additional persisted state.
  
  Owner-approved configuration hardening: constructing CandidateIntakeService with both reuseRecommendation and reuseDecision now fails explicitly before either callback or any candidate mutation, instead of silently prioritizing the decision channel.

## 1.288.1

### Patch Changes

- d37e61a: PRI-917 v0.3.2 review fixes (PR #1902 review findings, 2 P1 + 4 P2).
  
  principles-core: the missing-profile warning in the effective config now
  judges the RESOLVED enabled value (legacy configs without the
  reuseEvaluation section no longer silently skip it); isValidReuseEvaluation
  Output delegates to the full trust boundary (closed field set + cross-field
  rules) instead of the bare open-field-set schema check.
  
  pd-cli: a source=default OpenClaw profile resolves in delegated mode in the
  runtime-adapter-resolver (identical semantics to
  pain-signal-runtime-factory's validateRuntimeConfig) — the semantic reuse
  evaluation capability now actually RUNS under the default configuration
  instead of permanently degrading to unavailable; the evaluation timeout
  falls back to the resolved profile's own timeoutMs; a hallucinated
  selectedPrincipleId is downgraded to unavailable
  (selected_principle_not_in_shortlist) instead of being shown as an
  executable recommendation; the production-validation E2E creates its
  workspace under os.tmpdir().

## 1.288.0

### Minor Changes

- cc8c84a: PRI-917 v0.3.2 — Semantic Reuse Evaluation Capability (five-layer merge train).
  
  principles-core: reuse-evaluation-output contract (closed field set +
  cross-field rules), ReuseEvaluationRunner (proposal-only, PDRuntimeAdapter +
  structured-output-repair), reuseEvaluation config section, profile-id
  runtime resolution, reuse_evaluation_recommended/unavailable telemetry
  events.
  
  pd-cli: pd candidate review shows the semantic evaluation (advisory — the
  Owner decides; observable degrade to lexical-only), and reuse_selected
  intake outcomes report the resolution instead of a refused-write error.
  
  Governance boundary unchanged: the capability only RECOMMENDS; the Owner's
  verdict is recorded exclusively in Principle.reuseEvidence[]. No new
  database, decision storage, relationship entity, capability registry, or
  agent registration.

## 1.287.8

### Patch Changes

- 0939eac: fix: address PR 1900 review findings — admission gate bypass, reuse proposal validation, CLI contract hardening, and telemetry registration

## 1.287.7

### Patch Changes

- b50ec74: `pd pain retry` no longer dead-ends on a failed diagnosis task: it now
  recovers the failed diagnostician family (parent + rootcause/distiller/router
  stages) through the shared recovery authority before re-running, and a
  surviving `lease_conflict` says so with a nextAction pointing at
  `pd runtime recovery failed-tasks`. Both CLI diagnosis paths
  (`pd diagnose run` and `pd pain retry`, including dead-letter replay) now
  write the `pain_diagnoses` attribution ledger when the
  `pain_diagnosis_persistence` flag is on — the result reports
  `attempted` / `disabled` / `skipped_no_pain_lineage` honestly instead of
  silently dropping the attribution row (PRI-934, PRI-935).

## 1.287.6

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

## 1.287.5

### Patch Changes

- da4c731: Identity **writer** boundary (PRI-911A, third gate after the Type Boundary #1851 and the Activation Identity Boundary #1856): `pi_artifacts.source_principle_id` can now only ever hold a **canonical ledger UUID or NULL** — never title/`T-NN`/other display text. Audit trail: `docs/audit/identity-writer-hardening.md`.
  
  **W1 — DreamerRunner no longer carries an LLM-asserted identity.** The runner wrote `output.sourcePrincipleId` straight onto the artifact column; after `stripFabricatedCorePrincipleIds` the only value that can reach it is a Historical Core Principle registry id (`T-NN`), which is not a ledger principle. The column is now left empty and the assertion is reported via `dreamer_identity_assertion_not_carried`. The value still rides in `contentJson`, so the Activations console's Bug-O L1 'unlinked' display is unchanged — stamping the real identity remains ScribeRunner's ledger-verified job (PR #1856 I2).
  
  **W2 — EvaluatorRunner's rule stamp replaced its lenient chain.** Rule assembly previously resolved the identity through column → `contentJson.principleId` → `contentJson.sourcePrincipleId` → `principleDraft.title`, which is exactly how philosopher titles became durable identities in the column. Assembly now reads the bearer's `source_principle_id` column only, gates it through `canonicalLedgerPrincipleId` — the value-level gate split out of PR #1856's `resolveActivationPrincipleId`, so there is still exactly one UUID parser in the repo — and, when the host injects the new optional `EvaluatorRunnerDeps.ledgerIdentity.hasPrinciple`, verifies ledger membership. Outcomes: `evaluator_identity_stamp_success`, or the rule written with a NULL identity plus `evaluator_identity_stamp_failed` carrying `missing_identity` / `non_canonical_identity` / `invalid_identity` (`ambiguous_identity` stays with the bearer/lineage resolvers that can actually see multiplicity).
  
  **Rule assembly is deliberately NOT aborted on an unverified identity** — PR #1856 established that identity gaps are enforced at the publication boundary (rule preserved, no approval subject, no activation), so a wrong identity no longer silently becomes a lost candidate; `evaluator_rule_assembly_failed` keeps its structural meaning. All three production `EvaluatorRunner` construction sites (host-runtime consumer cycle, pd-cli `createEvaluatorRunnerDeps` shared by RuleHost and `runtime internalization run-once`) are wired with the ledger check; unwired callers keep the shape-only gate. The wiring is no longer
  grep-maintained: `identity-writer-production-wiring.test.ts` fails if a production construction site
  drops the injection (or bypasses the sanctioned `createEvaluatorRunnerDeps` factory), or if an identity
  event name drifts away from `TelemetryEventType`. Rollback = revert; no schema change, no data migration, no new flag.

## 1.287.4

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

## 1.287.3

### Patch Changes

- 4ced615: OPT-002 (runtime-v2 barrel narrowing): the plugin's satellite bundles no longer pull the LLM SDK graph. Six shared plugin modules switched their VALUE imports from the `@principles/core/runtime-v2` barrel to the eight narrow leaf subpaths (type-only barrel imports unchanged; exported names unchanged), and `@principles/core` exports gained those additive subpaths (`./runtime-v2/store/workspace-leak-guard`, `./runtime-v2/feedback/redact-sensitive`, `./runtime-v2/types/event-types`, `./runtime-v2/trajectory-schema`, `./runtime-v2/internalization/{rule-host-input-builder,rule-context-v2,behavior-example-pack,tool-semantic-registry}`). governance-audit.js drops 2,783,013 → 70,786 bytes (−97.5%) and rulehost-evidence.js 2,826,401 → 60,244 bytes (−97.9%); bundle.js is byte-identical (4,151,557) — the main package keeps its LLM runtime through its own direct barrel import. `runtime-v2/index.ts` and all existing exports are untouched. A build-level satellite purity guard (`scripts/build/check-satellite-purity.mjs`, wired into `esbuild.config.js`) now fails any plugin bundle build that reintroduces pi-ai / pi-agent-core / anthropic / openai / genai / undici inputs into the satellite outputs, so the invariant no longer rests on discipline alone.
- de38d90: Principle Ledger write boundary (Phase 1 / PR1): candidate-origin writes to the Principle Ledger now require a validated `recommendation_kind === 'principle'`. Unknown, missing, or malformed kinds are refused fail-closed and reported as an explicit disposition instead of silently collapsing into a principle; candidate persistence, kind routing, and defer handling are unchanged.

## 1.287.2

### Patch Changes

- 99e6a8c: RAH-1 (PRI-905): production builds now exclude test code (tsconfig.build.json: *.test.*, __tests__/, __fixtures__/, *.spec.*), clean dist before building, and fail the build if compiled test artifacts appear in dist. Published dist shrinks accordingly (@principles/core tarball was ~57% test artifacts by size); runtime API, source layout and vitest behavior are unchanged. Test files are still type-checked via the new `typecheck` (tsc --noEmit) scripts, wired into verify:merge.
- 8b7b775: Security audit run-1 remediation (findings verified against eabbde6d, applied on ccc69252):
  
  - **RuleCode enforcement is now content-bound** (audit HIGH `rulecode-approval-content-unbound`): the production gate and the OpenClaw plugin RuleHost re-verify the current `pi_artifacts` row against the `activation_decisions.artifact_digest` recorded at Owner promotion time before compiling it. A workspace-local rewrite of `content_json` (or lineage fields) is now skipped with a structured `artifact_content_tampered` warning instead of silently executing unapproved code. Rows without a recorded decision (legacy activations) keep their prior behavior. Adds `mapPiArtifactRow`/`PiArtifactRow` exports (the single `pi_artifacts` row→snapshot mapping) so enforcement reproduces the promotion-time digest byte-for-byte.
  - **Replay evaluate is hard-bounded** (audit MEDIUM `rulecode.replay.in-process-evaluate-no-hard-timeout`): pre-activation replay runs each evaluate call through a precompiled vm script with a 2000ms hard timeout — a looping LLM-authored candidate now fails its replay case instead of hanging the console server, evaluator worker, or CLI process.
  - **Governance-store unavailability leaves a durable trace** (audit MEDIUM `gate-failopen-allow-on-state-corruption`): when `state.db` is missing or unreadable, the gate/plugin record a best-effort marker under `~/.pd/enforcement-health/` (outside the agent-writable workspace), and the console governance read model distinguishes "state.db deleted after initialization — enforcement degraded (fail-open)" from a never-initialized workspace.
  - **Console refuses unauthenticated non-loopback binds** (audit MEDIUM `pd-console-noauth-nonloopback-bind`): the loopback-only invariant now keys on the effective authentication state (token-less default included), not just the explicit `--no-auth` flag.
  - **Plugin honors an explicit conversation-access opt-out** (audit LOW `openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out`): the auto-fix repairs only an absent `allowConversationAccess` flag; an explicit `false` (the documented turn-off) is preserved and surfaced as an honored Owner opt-out instead of being silently rewritten on every gateway start.
- 9d98f89: Test Diet 2.2-B3-B: move the split-pipeline cached LLM fixture out of the `__tests__` boundary. `test-double-runtime-adapter.ts` (production) imported it from `internalization/__tests__/__fixtures__/`, which made the runtime-v2 fixture a source of truth consumed across the test boundary; the file now lives next to its two owners as `runtime-v2/adapter/split-pipeline-fixtures.ts`. Data, export names and adapter dispatch behavior are unchanged — the only content edits are three relative type-import depths and the import paths of its five consumers. No behavior change.
- 92074a0: Test Diet 2.2-B3-C: remove dead PassThroughValidator scaffold from runtime-v2 diagnostician validator module. Zero consumers (no production or test imports, not in any barrel or barrel-surface fixture), superseded by DefaultDiagnosticianValidator. No behavior change.

## 1.287.1

### Patch Changes

- 75b4ac4: PRI-866 sourcePainId reader convergence: pd-cli's two inline sourcePainId parsers now delegate to the core canonical reader (exported from @principles/core/runtime-v2), and the rulehost pipeline dreamer-task lookup normalizes both sides at the comparison boundary — historical rows or queries carrying surrounding whitespace no longer miss their dreamer seed and are no longer rejected with a misleading no_dreamer_task_seeded.

## 1.287.0

### Minor Changes

- 8424d60: Baseline-cutover accounting for the unpublished source delta between the registry baseline (1.286.0, published from 7e8bf2f0) and current main: internalization pipeline behavioral fixes and additions (dreamer prompt builder, evaluator pain-reason echo, pitask metadata, formation context), owner-decision view contract, pain-to-principle service and sqlite task store changes, and the telemetry event registry — carried by PR #1766 (PRI-846) and PR #1781 (PRI-874). These source changes were never released: the version number alignment to 1.286.0 is a starting point, not a claim this content shipped.

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-17

### Added

- `PainSignalSchema`, `validatePainSignal()`, `deriveSeverity()` -- Universal PainSignal schema and validation (SDK-CORE-03)
- `PainSignalAdapter<TRawEvent>` -- Framework-agnostic pain signal capture interface (SDK-ADP-02)
- `EvolutionHook` -- Callback interface for evolution lifecycle events (SDK-ADP-05)
- `TelemetryEvent` TypeBox schema -- In-process telemetry event schema (SDK-OBS-05)
- `StorageAdapter` -- Abstract storage adapter interface for principle persistence (SDK-CORE-02)
- `PrincipleInjector` -- Framework-agnostic principle injection interface (SDK-ADP-03)
- `DefaultPrincipleInjector` -- Minimal framework-agnostic implementation with budget-aware selection and P0 forced inclusion (SDK-ADP-03, SDK-ADP-04)
- `OpenClawPainAdapter` -- Reference coding domain adapter for OpenClaw tool failures (SDK-ADP-07)
- `WritingPainAdapter` -- Reference writing domain adapter for text quality issues (SDK-ADP-08)
- `CodeReviewPainAdapter` -- Reference code review domain adapter for diff complexity, comment sentiment, and process violations (SDK-ADP-09)
- `describePainAdapterConformance` -- Conformance test factory for PainSignalAdapter implementations (SDK-TEST-02)
- `describeInjectorConformance` -- Conformance test factory for PrincipleInjector implementations (SDK-TEST-02)
- Performance benchmarks with p99 targets (SDK-TEST-03)

### API Freeze Commitment

As of v0.1.0, the following interfaces are frozen (Semver protected):
- `PainSignal` schema (all 12 fields)
- `PainSignalAdapter<TRawEvent>.capture()` signature
- `PrincipleInjector.getRelevantPrinciples()` / `formatForInjection()` signatures
- `InjectionContext` interface
- `InjectablePrinciple` interface

Any additions will be made as non-breaking changes (new optional fields, new interfaces).

### Validation

- PainSignalSchema validated against 3 domains: coding, writing, code-review
- Gap analysis: ZERO unfillable fields across all domains
- E2E pipeline validated: ReviewEvent -> PainSignal -> DefaultPrincipleInjector

### Package

- Initial release as `@principles/core` v0.1.0
- Published from `packages/principles-core/`
- Supports tree-shaking via granular exports map
