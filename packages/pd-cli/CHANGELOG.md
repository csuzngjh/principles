# @principles/pd-cli

## 1.162.1

### Patch Changes

- 853f174: Fix: `pd pain recall` no longer creates or rewrites `-wal`/`-shm` sidecar files next to WAL-mode databases (the production resting state for both state.db and trajectory.db). Every WAL-mode database is now read through a fingerprint-verified staged snapshot in a private temp directory: the (main, `-wal`) pair is hashed before the copy, the staged copies must match, and the source pair is re-hashed after — any writer race rejects the source as unreadable instead of returning stale data. A non-empty `-wal` (live writer or crash residue) is recovered through the staged pair, so un-checkpointed commits stay visible. Rollback-journal databases keep the direct read-only open. CLI arguments, JSON schema, and exit codes are unchanged. (SPEC-PD-PAIN-RECALL-CLI-001 §6.1/§9.2; SPEC-PD-AGENT-CAPABILITY-API-001 v0.3 §10.3.1)
- Updated dependencies [5ad3954]
  - principles-disciple@2.2.6

## 1.162.0

### Minor Changes

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
- 4b925f3: PRI-1051：`pd version --delivery` 一次给出四个交付面（正式运行时 / OpenClaw 扩展 / Codex 插件 / Companion）的并列结论，让「发版完成」变成可机器判定的口径，而不是内部三链全绿。起因是 2026-10-27 的真实事故：正式运行时与 OpenClaw 扩展已是 core 1.297.2，Codex 插件运行时仍是 1.296.2，Owner 只能逐个核版本才发现。
  
  每面只读各自既有权威（`active.json` + 实时 `~/.pd/runtime` 清单、扩展 shell 的 `package.json`、marketplace pin + plugin data 运行时、Companion 独立发版轨道），不缓存、不落新状态、不访问网络（「是否有更新版本发布」仍归更新频道）。结论值：`ok` / `stale`（附刷新命令）/ `ready_needs_host_restart`（字节已新、宿主未重启；宿主启动时刻读不到时为 `unknown`）/ `not_applicable`（本机没装该宿主）/ `unknown`（带结构化 reason + nextAction）。`--json` 仍只输出一个 JSON 对象，`--delivery` 作为附加字段；任一必需面不是 `ok` 时退出码非 0。不带 `--delivery` 时默认输出与退出语义不变。回滚方式：撤回本改动（纯增量、无持久化）。

### Patch Changes

- Updated dependencies [07242b7]
- Updated dependencies [53a285f]
- Updated dependencies [eaaa2e9]
  - @principles/core@1.297.4
  - @principles/host-runtime@0.14.1
  - principles-disciple@2.2.5
  - @principles/workbuddy-adapter@0.2.14

## 1.161.0

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
- Updated dependencies [cd773b5]
  - @principles/core@1.297.3
  - @principles/host-runtime@0.14.0
  - @principles/codex-adapter@0.6.0
  - @principles/workbuddy-adapter@0.2.13

## 1.160.2

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
- Updated dependencies [4fefb36]
  - @principles/codex-adapter@0.5.14
  - @principles/host-runtime@0.13.5
  - @principles/workbuddy-adapter@0.2.12

## 1.160.1

### Patch Changes

- 004acb4: Unify the RuleCode textual-basis anchoring check (continuous verbatim span) across the scribe success boundary and the artificer intent preflight, feed scribe validator rejections back into the next model attempt with cross-epoch freshness, and add one bounded authenticated source-correction recovery per rule candidate that CAS-reopens the original needs_human_review artificer on the new scribe epoch. Leases now count attempts per revision epoch while run ordinals stay globally sequential, so reopened epochs actually receive their original maxAttempts. The bundled Console (ships inside create-principles-disciple) gains an authenticated source-correct-once entry whose receipt binds the Owner actor, binding revision, artifact digest and stop reason. Owner review R6: bash-command risk classification is unified across the host gate, the OpenClaw enrichment and golden-trace replay (git mutations and arbitrary code execution count as mutating); approval-gate rules must keep read-only investigation allowed under not_approved, verified by a system-generated counterfactual; the scribe success boundary rejects undeclared approval dependencies.
- Updated dependencies [004acb4]
- Updated dependencies [c7d3f29]
  - @principles/core@1.297.1
  - @principles/host-runtime@0.13.3
  - principles-disciple@2.2.3

## 1.160.0

### Minor Changes

- e1d6ffc: PRI-1023: retire the `openclaw-cli` sub-agent runtime backend (ADR-0029). pi-ai is now the only backend PD executes internal agents on; OpenClaw stays supported as a *host*, never as a delegated CLI agent session. Legacy `type: openclaw` profiles still parse, redact and list, but they are read-only: readiness always answers `needs_setup` with a pi-ai next action, `createAdapterConfigFromProfile` fails loud instead of producing an adapter, the console no longer offers, creates or updates the retired type (existing profiles stay listed and labelled retired, editable only by deleting and recreating them as pi-ai), and the `--openclaw-local` / `--openclaw-gateway` / `--agent` CLI flags are gone in favour of `reason: 'retired_runtime_kind'` refusals. Rollback is source-level: revert this PR.

### Patch Changes

- Updated dependencies [e1d6ffc]
  - @principles/core@1.297.0
  - @principles/host-runtime@0.13.2
  - principles-disciple@2.2.2

## 1.159.2

### Patch Changes

- 52d2c6a: Connect Owner-decided principle reuse to shared identity resolution, and add authenticated rule-candidate binding with one bounded revision. Preserve prior PI artifacts across revision epochs and reject stale or revoked binding receipts before generation and publication. The bundled Console exposes binding separately from rule approval and activation.
- Updated dependencies [52d2c6a]
  - @principles/core@1.296.2
  - @principles/host-runtime@0.13.1

## 1.159.1

### Patch Changes

- e060c56: PRI-1040：为 Companion 托管的 Codex/WorkBuddy worker 接通合作式发布交接，当前周期完成后才替换，无法安全交接时明确显示原因。Codex 插件发布后维护已发布包固定版本、递增插件缓存版本，并由真实 npm 能力探针保护交付。
- Updated dependencies [4922dda]
  - @principles/core@1.296.1

## 1.159.0

### Minor Changes

- 1b13597: SPEC-PD-PAIN-RECALL-CLI-001: new read-only `pd pain recall` command — recalls the historical pains a principle verifiably derives from, so a host Agent can check a principle's origin, trigger boundary, or current-situation fit on demand. Only two authoritative association edges are honored (`reuseEvidence[].painId`; `derivedFromPainIds` resolved through its production contract as candidate ids via `tasks.input_ref`), results dedup by real pain id while keeping every evidence ref, `--context` re-ranks deterministically without any model/network call, and per-source availability separates `not_recorded` from `unreadable` (`source_missing`/`source_unreadable` never masquerade as `no_matches`). All three hosts' `pd-cli-operator` skills (Codex plugin, OpenClaw en/zh templates, WorkBuddy adapter) now document when to call it, how to read the JSON contract, and the diagnosis-is-not-owner-statement rule.

### Patch Changes

- Updated dependencies [1b13597]
  - principles-disciple@2.2.1
  - @principles/workbuddy-adapter@0.2.11
  - @principles/codex-adapter@0.5.13

## 1.158.7

### Patch Changes

- 0f2d1fb: PRI-1020: Owner-declared context windows (SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001). A new optional `promptBudget` section in `.pd/config.yaml` lets the Owner declare a model's real context window (`declaredContextWindowTokens` + optional per-host `hosts` overrides). It is tier 0 of the injection budget chain — outranking host-reported windows and the model catalog — and scales the budget with the same formula as #2093 (262144 tokens → 4096 chars, cap 16000). This unblocks Codex/WorkBuddy hosts whose adapters carry no window facts and whose custom model ids can never match the installed catalog (previously locked at the 2000-char fallback forever). Console surfaces forecast under the declared basis when no fresh runtime observation exists; a fresh observation still wins. Delete the section to roll back to the previous behavior. Config validation fails loud on malformed values (policy plausibility bounds, closed host set, unknown keys).
- Updated dependencies [0f2d1fb]
  - principles-disciple@2.2.0
  - @principles/core@1.296.0
  - @principles/host-runtime@0.13.0
  - @principles/codex-adapter@0.5.12
  - @principles/workbuddy-adapter@0.2.10

## 1.158.6

### Patch Changes

- 5c383e5: Unify PD host skills around four consistent capabilities, clarify Owner governance and evidence boundaries, and align the published skill bundles and Codex recovery guidance.
  
  Review-round additions: `pd run list/show` gain an optional `--workspace` (governance-workspace reads independent of cwd); Codex skills route every shipped script through `pd-locate.cjs --exec` — one authoritative locator that resolves the plugin root once, fails loud on marketplace ambiguity or a missing script instead of silently falling back to an older version; WorkBuddy near-miss explicit-statement prefixes get an actionable format notice; `pd-review` startup text no longer presents CLI approval as an agent fallback.
- Updated dependencies [5c383e5]
  - principles-disciple@2.1.12
  - @principles/workbuddy-adapter@0.2.8

## 1.158.5

### Patch Changes

- 765d5c4: Decouple the signal_confirmations batch consumer from the correction_observer flag (AUDIT-P2-04, 2026-10-21 remediation): the periodic cycle now starts when signal_collector is enabled (default on) even with correction_observer off (default), so persisted pending confirmations are consumed instead of remaining invisible permanent-pending records. Keyword optimization remains exclusively gated by correction_observer and is never silently enabled. Batch skips due to an unavailable classifier are now counted (stage2BatchSkipped) and pd config doctor classifies backlog-plus-skip as degraded with an actionable next action.
- d00ea5c: Signal detection sync-path and observability hardening (AUDIT-P2-01/P2-02, 2026-10-21 remediation): defer all health-counter file writes off the before_prompt_build synchronous call stack (degraded/zero-hit paths previously did a synchronous read-modify-write per message); add stage2Invocations and stage2BatchSkipped counters with backward-compatible signal-health parsing and pd config doctor display; add sync-path regression tests and a repeatable detectSync performance baseline. SQLite queue records stay synchronous by design.
- Updated dependencies [765d5c4]
- Updated dependencies [d00ea5c]
- Updated dependencies [222d9e0]
  - principles-disciple@2.1.11
  - @principles/core@1.295.2
  - @principles/host-runtime@0.12.1
  - @principles/workbuddy-adapter@0.2.7

## 1.158.4

### Patch Changes

- 48df168: PRI-1017: Console budget forecasts now run under the workspace's most recent runtime budget OBSERVATION, closing the SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1 data-chain gap where the runtime injected under a model-aware budget (e.g. 256K window → 4000 chars) while the console still forecast under its own parameterless fixed 2000-char fallback (`1953/2000`).
  
  - Host-runtime adds a read-only observation model over the EXISTING injection events (`runtime_v2_prompt_activations_injected` JSONL): latest budget fact per host, untrusted-input discipline (closed-set validation, loud skip counts), workspace + host binding, 24h freshness bound, policy-version binding, and pre-policy events skipped rather than reinterpreted. No new database, no second budget state source, no event schema change.
  - The reader is bounded: at most the 7 most recent daily files in each candidate log directory (`.pd/logs` and `.state/logs` — a per-directory cap so a later directory can never be starved of the newest observation), and only the last 4 MiB of each file, so a large log can never stall the console; a cut line is dropped rather than half-parsed, and `truncatedFiles` reports the skip loudly. An observation that only exists in a skipped prefix is reported as absent (honest fallback), never reconstructed.
  - Console surfaces (approvals/grouped badge, activations status rows, post-approval warning) pass the observation-rebuilt `PromptBudgetResolution` into the same production projection; payloads carry `budgetObservedAt` so the UI labels the budget as the most recent runtime observation — never as a live confirmation. Per-host forecasts under an unconfirmed route each carry their own budget basis.
  - Honest degradation: no observation / stale observation (`runtime_budget_observation_stale` reason code) / host mismatch / untrusted event fields all fall back to the fixed budget with traceable reason codes; governance flows are untouched.
  - Also completes a PR #2093 review leftover: the focus-page budget fallback localization keys (10 reason codes + notes) now exist in both en and zh-CN, and the grouped API accepts `?host=workbuddy` like the focus page's host picker.
- Updated dependencies [48df168]
  - @principles/host-runtime@0.12.0
  - @principles/codex-adapter@0.5.10
  - @principles/workbuddy-adapter@0.2.6

## 1.158.3

### Patch Changes

- d3796e4: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.
  
  - Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match (host-declared provider) → legacy fixed 2000-char fallback with a bounded machine-readable reason code — provider-less name-only matches NEVER confirm (v0.2 trust amendment: a unanimous name cannot prove the deployment is not a custom endpoint). Budget formula `min(16000, max(1250, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens). The 1250 floor is MEASURED (shared route full render of one minimum viable principle = 849/1204 chars with self-report off/on — lower floors re-create the audited 32K zero-injection defect); the 16000 cap is the Owner target upper bound (1M windows map to 15625).
  - Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 1250..16000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 16000 max tier; cross-host aggregation is monotone — only ALL-hosts overflow brands an entry oversized everywhere); injection events carry budget provenance INCLUDING the bounded `budgetFallbackReason` code.
  - Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
  - Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.
- Updated dependencies [d3796e4]
  - @principles/core@1.295.0
  - @principles/host-runtime@0.11.0
  - @principles/codex-adapter@0.5.9
  - principles-disciple@2.1.10
  - @principles/workbuddy-adapter@0.2.5

## 1.158.2

### Patch Changes

- bf5aed3: Introduce an opt-in WorkBuddy native current-user keyword Pain path using the shared high-precision detector, canonical Pain admission and Diagnostician task continuation. Expose effective keyword detection status; leave the feature off by default and preserve Codex ingestion consent boundaries.
- Updated dependencies [bf5aed3]
  - @principles/core@1.294.1
  - @principles/host-runtime@0.10.4
  - @principles/workbuddy-adapter@0.2.4

## 1.158.1

### Patch Changes

- 1a127e2: 修复 RuleCode 新生成契约与路径事实，统一原则范围内的语义验收，并为经过逐规则复验的 Codex V2 规则接通运行上下文。
- Updated dependencies [1a127e2]
  - @principles/core@1.293.5
  - @principles/host-runtime@0.10.3
  - @principles/codex-adapter@0.5.8

## 1.158.0

### Minor Changes

- 574954a: PRI-990: single-task failed recovery — pd runtime recovery failed-task --task-id <exact> (dry-run default, CAS-guarded confirm, explicit --reset-budget for exhausted budgets, recovery_actions.jsonl audit with previousAttemptCount). Core: recoverSingleFailedTask + inspectFailedTaskRecovery strict path; legacy batch recoverFailedTask upgraded to the same CAS precondition with unchanged observable behavior.

### Patch Changes

- ded73b8: Prevent explicit --dry-run --repair-audit from re-projecting recovery audit JSONL. Conflicting flags now fail closed before any writes.
- 06152af: Connect Codex Owner-labelled behavior evidence to the shared internalization preflight. Reuse one validated assembler across OpenClaw, Codex and evidence attach/resume; read trajectory data without creating or migrating it and preserve host-specific semantics. Missing labels reach Owner review without model calls or attempts; missing/corrupt sources remain observable source faults.
- Updated dependencies [fec1306]
- Updated dependencies [574954a]
- Updated dependencies [06152af]
  - @principles/install-layout@0.4.0
  - @principles/core@1.293.0
  - @principles/host-runtime@0.10.0
  - @principles/codex-adapter@0.5.6
  - principles-disciple@2.1.6
  - @principles/workbuddy-adapter@0.2.2

## 1.157.0

### Minor Changes

- eaf52c4: feat(PRI-985): `pd runtime internalization audit-artificer-evidence` — SPEC-PD-IAER-001 FR-09 的只读历史审计命令。对 workspace `.pd/state.db` 以 readonly 连接（不 bootstrap、零写路径、无 --confirm）扫描 `pi-ai-l2`/`pi-ai` 两种 runtime_kind 下 reason 命中 `behavior_example_pack_missing` 的失败运行，按独立 Task ID 聚合（运行数 ≠ 任务数），每任务报告运行次数、失败分类计数、首次/末次时间、任务当前状态与 attempt/maxAttempts，并给出四类异常布尔标记（repeated_retry_consumption / succeeded_run_then_failed / has_governance_side_effects / pack_missing_failure，治理痕迹经 approvals ⋈ pi_artifacts.source_task_id 权威联查，源表缺失时如实标注 detection=unavailable）；汇总段含按 runtime_kind 与最终任务状态细分；每任务 nextAction 指向真实恢复入口（needs_human_review → `pd runtime internalization retry --confirm`，failed → `pd runtime recovery failed-tasks --confirm`，证据附加入口 PRI-983）。`--json` 严格单对象输出（cli-1），空结果为结构化空报告而非报错，DB 打不开/表缺失为结构化拒绝（exit 1，reason+nextAction，不做任何修复尝试）。

### Patch Changes

- eaf52c4: PRI-983 (SPEC-PD-IAER-001 FR-03/FR-06/FR-07): Owner evidence attach and controlled resume. New `pd runtime internalization evidence list|attach|resume` command group (all default dry-run, `--confirm` mutates): list surfaces Artificer tasks blocked on evidence (needs_human_review + stable FR-04 reasonCode) with pain linkage, missing fields and next actions; attach assembles through the production BehaviorExamplePackAssembler and persists the Owner selection into `pi_metadata.ownerEvidenceSelection` via the narrow diagnosticJson CAS with new provenance fields (revision, contentDigest, ownerOperation, attachedAt — ABSENT=legacy, single shape authority shared with the readiness gate); the task stays needs_human_review (attach never unblocks). resume re-assembles, verifies the stored sha256 contentDigest (mismatch → `owner_behavior_examples_stale`; cross-session → `owner_behavior_examples_scope_mismatch` via a new typed, structural scope-error classification in the plugin assembler — no message sniffing) and performs the atomic authority reset through the single recovery authority `ownerRetryNeedsHumanReviewTask`, which gains an optional CAS precondition (expected diagnosticJson + expected status) so at most one concurrent resume wins (T06); the attempt-budget reset is explicit, digest-verified and audited with previousAttemptCount in the existing `.state/recovery_actions.jsonl` append-only log. FR-07: the run-rulehost BEP gate and its confirm-time assembly now derive refusal reasons from the same shared Evidence Readiness judgment (`assessEvidenceReadiness`) the consumer preflight uses — identical inputs produce identical stable reason codes on both production entries, with no V1 fallback and unchanged command parameters. New telemetry events `artificer_owner_evidence_attached` / `artificer_owner_evidence_resumed` (bounded payloads, no raw trajectories).
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
  - @principles/core@1.292.2
  - @principles/host-runtime@0.9.2
  - principles-disciple@2.1.5

## 1.156.1

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/codex-adapter@0.5.5
  - @principles/core@1.292.1
  - @principles/host-runtime@0.9.1
  - @principles/install-layout@0.3.1
  - @principles/workbuddy-adapter@0.2.1
  - principles-disciple@2.1.4

## 1.156.0

### Minor Changes

- 5e794be: New 'pd workbuddy worker' command group; pain-list/runtime-activation host filters accept workbuddy.

### Patch Changes

- 6e60d84: SPEC-CODEX-PAIN-CLOSURE-001: Codex 痛苦反馈闭环修复。
  
  - CR-01（PRI-960）：工具执行结果三值契约（success/failure/unknown）——缺失退出码不再伪造为 0，snake_case/camelCase 退出码全位置读取；tool_calls 增补 tool_use_id 连接列；consent 门控的 transcript 事实路径把文本型 live 观测升级为宿主核实的最终结果。
  - CR-02/CR-03（PRI-958/959）：明确 Owner 陈述（--owner-statement / PD记录痛苦：前缀，≤500 字拒绝不截断）仅满足空输入证据准入条件；候选行新增 admission_json——不可变评估历史 + 当前指针 + 独立处理进度域；CLI intake 写入许可以持久化完整门禁为准（部分检查仅作快速预拒）。
  - CR-05：诊断成功后的准入/收编/seed 断点由 worker 有界续接（不重跑诊断 LLM，最多 3 次自动尝试，终态可读）。
  - CR-06：pd pain retry 支持 --owner-statement/--dry-run/--confirm 的授权恢复语义。
  - CR-07：Codex 用户消息 `PD记录痛苦：<反馈>` 前缀入口（UserPromptSubmit Hook，登记→任务→回执，无 LLM，幂等）；插件交付 pd-record-pain skill。
  - CR-08：worker 周期活性事实持久化（readiness ≠ liveness）；pd codex worker --status 与 Companion 分开报告活性。
- 54d1380: PRI-953 (R1 F1/F2): extend the verified Codex ingestion envelope to 0.162.1 and make stale installs / unverified CLI versions visible.
  
  - codex-adapter: `CODEX_INGESTION_VERIFIED_VERSION` 0.150.1 → 0.162.1, backed by an on-device contract probe against real codex-cli 0.162.1 (125/125 captured hook payloads decode; 8/8 real rollout transcripts ingest with only designed unknown-record-type skips) and sanitized G1 fixtures (`hook-payloads/v0.162.1/`, `transcripts/v0.162.1-tool-final-turn.jsonl`) with end-to-end ingestion + replay-idempotency tests.
  - pd-cli: `pd health --host codex` now reports the runtime actually installed for hooks (PLUGIN_DATA) vs the marketplace-cache pin (`install.staleInstall` + blocker when it diverges with ingestion enabled), the canonical `~/.pd/runtime` adapter version, and the Codex CLI version observed in the newest rollout (`install.latestObservedCliVersion` + `cliStatus`); an unverified CLI with ingestion enabled is a §15 ready blocker with a nextAction — version or install incompatibility is no longer silent.
- Updated dependencies [5e794be]
- Updated dependencies [6e60d84]
- Updated dependencies [6e677f8]
- Updated dependencies [54d1380]
- Updated dependencies [0f94f8c]
- Updated dependencies [4ba83b7]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
  - @principles/codex-adapter@0.5.4
  - @principles/core@1.292.0
  - @principles/host-runtime@0.9.0
  - principles-disciple@2.1.3
  - @principles/workbuddy-adapter@0.2.0
  - @principles/install-layout@0.3.0

## 1.155.4

### Patch Changes

- 69fa3f3: chore(deps): bump js-yaml 5.4.1 -> 5.4.3（#2011）。js-yaml 是 core / host-runtime / plugin / pd-cli / console 的运行时 dependency，console 随 installer 分发，故这 4 个可发布包与 installer 各声明 patch。
- 69c64e3: fix(PRI-957): `pd` 不带 `-w`/`PD_WORKSPACE_DIR` 时先在当前目录向上发现工作区（补 §11.2 承诺的解析步），空候选结果回显被查询的工作区绝对路径；读写共用同一条解析权威，因此「没人声明过的 cwd 推断目标」会在 stderr 说出被使用的工作区，「所在目录 ≠ 声明的 workspace.default」也显式告警；config **解析失败**不再被当作「未声明」——声明值未知时若无 `-w`/`PD_WORKSPACE_DIR` 覆盖则 fail-closed 报错，不再把脚下目录交给写命令（`pd pain record`），有显式覆盖时保留覆盖并说出采用的目标；`-w .` 这类等价相对路径不再误报分歧。杜绝多宿主下「查错库 = 查无候选」的假阴性与静默改目标。
- Updated dependencies [69fa3f3]
  - @principles/core@1.291.6
  - @principles/host-runtime@0.8.3
  - principles-disciple@2.1.2

## 1.155.3

### Patch Changes

- 4e56337: Derivation-fidelity obligations for the internalization chain (Phase 1 acceptance r6). Live-chain evidence (p1-final r4 chain, 2026-10-12) showed the chain dying on a rule demanded to read "Owner write-confirmation records" from `input.context` — a field the RuleHost stateless single-call contract does not carry — because (a) the Scribe promoted a diagnosis **implementation recommendation** (a design proposal for persisted confirmation records) into `intentContract` as if Owner-mandated while silently narrowing the Owner's "ALL protected/ access (including read-only) requires confirmation" to write-only gating, and (b) the judge, treating the contract as the definition of correctness, put the unexpressible check into `requiredChanges`. Two additive prompt-contract clauses, no schema/validator/oracle/replay/routing changes: Scribe `scribe-output-v1.prompt.v6` adds OWNER-SOURCE GROUNDING (contract requirements must be grounded in the diagnosis's Owner-attributed statements, never in implementation recommendations; carried derived mechanisms must be marked `derived_mechanism:` in risks; every Owner-attributed requirement not carried into the contract must be declared with a structured `owner_requirement_gap:` risks entry — silence about a dropped requirement is a fidelity defect). Evaluator `evaluator-output-v1.prompt.v9` adds RULEHOST EXPRESSIBILITY (requiredChanges may only demand behavior the stateless single-call contract can express; demands presupposing new input go to concerns). r6 review round (2026-10-12) then bumped both contracts again: scribe `scribe-output-v1.prompt.v7` moves gap disclosure into a STRUCTURED `ownerRequirementGaps` output field (validated, machine-consumed — the free-text risks prefix had no downstream consumer), and evaluator `evaluator-output-v1.prompt.v10` replaces the concerns-prefix mismatch protocol with a STRUCTURED `evaluation.mismatchFindings` field (the prefix scan mis-routed a negative-sentence mention to human review on a live chain) and separates four situations — a disclosed derived implementation choice is NOT a divergence; false attribution to the Owner and defeating Owner-attributed requirements are; RuleHost-inexpressible requirements follow the EXPRESSIBILITY path and route to the Owner through concerns and the pipeline's gap surface instead. scopePrecision is unchanged: a declared limitation never auto-passes misblock/miss checks. Obligation regressions were executed red against the pre-fix code, then green; internalization suite 80 files / 1190 tests PASS.
  
  **pd-cli (@principles/pd-cli)**: the rulehost pipeline reads the scribe's structured `ownerRequirementGaps` and carries them on EVERY post-scribe outcome — candidate-ready, text-principle-only, identity-unverified, enqueue-failed, and all post-scribe rejection paths (`RuleHostPipelineResult.ownerRequirementGaps`, via `withGaps`/`readScribeOwnerRequirementGaps`). Declared gaps therefore reach the Owner on any outcome and can never silently count as satisfied.
- Updated dependencies [4e56337]
  - @principles/core@1.291.5

## 1.155.2

### Patch Changes

- ec96a95: PRI-915: wire `ledgerIdentity.isAvailable` in the evaluator factory and both
  scribe wirings (rulehost pipeline + run-once) so an unreadable principle ledger
  surfaces as `identity_source_unavailable` instead of `invalid_identity` drift.
- Updated dependencies [ec96a95]
- Updated dependencies [ec96a95]
  - @principles/host-runtime@0.8.1
  - @principles/core@1.291.0

## 1.155.1

### Patch Changes

- a334874: PRI-936: `pd pain retry --pain-id` now makes the budget guard bypass observable. The family reset always passes `force=true` (an explicit retry IS the operator's recovery decision), but the `forceApplied` verdict returned by the single recovery authority (`recoverFailedTask`) was dropped — operators could not see which tasks had their attempt budget silently extended. `recoveredTasks` now carries `{taskId, forceApplied}` in the strict JSON output (same shape on the failed and succeeded branches, cli-1) and the text path annotates extended budgets as `(budget extended)` — the size of the extension is core-owned, so the CLI names no number — same-source as JSON.

## 1.155.0

### Minor Changes

- 0b981bb: 提示词容量与生效反馈修复（PD_PROMPT_CAPACITY_V1，阶段 A/B1/B2/C）：
  
  - core：`listEntryLine` 列表行格式单一权威；prompt 版本替换——dispatcher `supersedeActivationId` 通道 + state store 单事务 `replacePromptActivation`（新激活+不可变 supersede 决策+旧版停用，故障回滚不留双活）；`detectPromptReplacementTarget` / `buildOwnerRevisionArtifact`（复用真实 Scribe 内容合同）；Scribe prompt v5 正文最短充分要求。
  - host-runtime：宿主事实绑定的有效注入路由解析（声明∪pain_events，Codex 恒共享、OpenClaw 按 flag、未知不猜测）；投影合同扩展（unit/计费范围/超长透传/诊断截断标记）；单一 `checkPromptArtifactDeliverability` 写入前预检；激活级注入状态读取；注入事件诚实读模型（无日志=unknown 非零）。
  - pd-cli：`pd activation approve --target-host` + prompt 写入前容量门（拒绝零写入、单一 JSON、结构化 nextAction）。
  - console（随 create-principles-disciple 发布）：审批预检门与 422 拒绝、未确认宿主横幅与请求级目标宿主、激活页注入状态与「修改为可注入版本」入口、替换事务 UX。

### Patch Changes

- Updated dependencies [d5732f8]
- Updated dependencies [0b981bb]
- Updated dependencies [0b981bb]
  - @principles/core@1.290.0
  - @principles/host-runtime@0.8.0
  - principles-disciple@2.1.0
  - @principles/codex-adapter@0.5.0

## 1.154.3

### Patch Changes

- 9d44428: PRI-946 (accept-as-is) — clarify in `runtime-activation.ts` that the local activation path reads `PD_CONSOLE_TOKEN` from env only, by Owner decision: it adds no `~/.pd/owner.json`/store fallback of its own and trusts whatever the caller placed in env (the companion decrypts its stored token into env before spawning the CLI), degrading to break_glass when env has none. Comment-only; no behavior change.

## 1.154.2

### Patch Changes

- df2a1fb: R7 gate-bypass fix — `pd candidate intake`, `pd candidate repair` and
  `pd candidate internalization backfill` now construct their
  CandidateIntakeService through the same Reuse Review Gate assembly as
  `pd diagnose` / `pd pain retry` / the automatic bridge. Previously the three
  manual commands ran with `reuseCheck='not_configured'`, so a semantic
  duplicate the gate had parked (`reuse_review_required`) could be written into
  the Principle Ledger as a duplicate Principle with exit 0 (P0 bypass proven on
  shipped 2.2.0/2.2.1). A parked candidate now surfaces
  `status: review_required` (intake/repair) or a deferred result with a
  `pd candidate review --decide` next action (backfill), mutates nothing, and
  emits the `reuse_gate_triggered` telemetry event like every other path.
  `reuseEvaluation.enabled=false` still restores the exact pre-fix behavior.
- 4b18048: PRI-941 Option A — Codex CLI pain record consumes the already-authorized tool_calls failure evidence (PRI-624 tool-governance surface) from the workspace trajectory via a new scoped acquisition that NEVER queries conversation tables (user_turns / assistant_turns remain ingestion-exclusive) and never opens rollout transcripts. An empty failure set keeps the honest unavailable degradation with an accurate reason (empty_trajectory). PainProvenance, painIngress.v1, the admission gate, consent and the G2A disclosure are untouched.
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
- Updated dependencies [6365e2e]
  - @principles/core@1.289.2

## 1.154.1

### Patch Changes

- 0139c88: PRI-939 Option A — reuse gate degradation visibility. The semantic reuse evaluation's unavailable state is now Owner-visible: reuse_gate_triggered and reuse_evaluation_unavailable persist to the workspace critical-events.jsonl sink (recommended deliberately excluded — no second decision log), the four short-lived CLI commands (pain record / pain retry / diagnose / candidate review) emit through a workspace-scoped telemetry emitter instead of the unsubscribed singleton, the intake gate carries the hook outcome on the CREATE result so CLI outputs show why duplicate protection did not run, and `pd health` summarizes the last unavailable event. Gate behavior unchanged (Rule 4, park semantics, reuseDecision/reuseEvidence untouched).
- Updated dependencies [0139c88]
  - @principles/core@1.289.1
  - @principles/host-runtime@0.7.14

## 1.154.0

### Minor Changes

- df9e555: PRI-917 v0.3.3 (OD-PRI917-05): Reuse Review Gate — automatic candidate intake now consults the semantic reuse evaluation capability before creating a Principle.
  
  A `reuse` recommendation parks the candidate (`refused/reuse_pending_owner`): no Principle is written, no evidence is appended, the candidate stays pending for the Owner, and the bridge emits an observable `reuse_gate_triggered` event plus a `reuse_review_required` outcome pointing at `pd candidate review --decide reuse|create`. `create`/`uncertain` recommendations and every evaluation failure degrade to normal creation (learning never blocks). `reuseEvaluation.enabled=false` restores the exact pre-v0.3.3 behavior.
  
  Also fixes the R5 "two-heads-block" defect: `pd candidate review --decide reuse` no longer lets the PRI-442 admission pre-check reject low-confidence candidates — a reuse verdict creates nothing, so the ledger-quality gate does not apply (the `--decide create` pre-check is unchanged).
  
  PR review fixes (4×P2, PRI-938): the bridge cache key now folds in the reuse-gate switch so a long-lived host picks up `reuseEvaluation.enabled` toggles in both directions (T11 rollback without a restart); mixed batches and replays keep parked candidates visible (`reuse_review_required` degraded outcome, Codex worker `reuseReviewRequiredCandidateIds`, OpenClaw `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` log gated on the park disposition); `pd diagnose` / `pd pain-retry` render parked candidates with review guidance and exclude them from `internalize` next-action lists.
  
  Follow-up review fixes: evaluation profile and timeout changes invalidate the cached reuse hook. Replay verifies the original diagnosis admission and performs a read-only reuse check before reporting a parked candidate, preserving failed-intake and gate-disabled behavior without additional persisted state.
  
  Owner-approved configuration hardening: constructing CandidateIntakeService with both reuseRecommendation and reuseDecision now fails explicitly before either callback or any candidate mutation, instead of silently prioritizing the decision channel.

### Patch Changes

- Updated dependencies [cee2304]
- Updated dependencies [df9e555]
  - @principles/codex-adapter@0.4.8
  - @principles/host-runtime@0.7.13
  - @principles/core@1.289.0
  - principles-disciple@2.0.8

## 1.153.1

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
- Updated dependencies [d37e61a]
  - @principles/core@1.288.1

## 1.153.0

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

### Patch Changes

- Updated dependencies [cc8c84a]
  - @principles/core@1.288.0

## 1.152.18

### Patch Changes

- 0939eac: fix: address PR 1900 review findings — admission gate bypass, reuse proposal validation, CLI contract hardening, and telemetry registration
- Updated dependencies [0939eac]
  - @principles/core@1.287.8

## 1.152.17

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
- Updated dependencies [7421049]
- Updated dependencies [b50ec74]
  - @principles/host-runtime@0.7.12
  - principles-disciple@2.0.7
  - @principles/core@1.287.7

## 1.152.16

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
  - @principles/host-runtime@0.7.10

## 1.152.15

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
  - @principles/host-runtime@0.7.9

## 1.152.14

### Patch Changes

- de38d90: Principle Ledger write boundary (Phase 1 / PR1): candidate-origin writes to the Principle Ledger now require a validated `recommendation_kind === 'principle'`. Unknown, missing, or malformed kinds are refused fail-closed and reported as an explicit disposition instead of silently collapsing into a principle; candidate persistence, kind routing, and defer handling are unchanged.
- Updated dependencies [4ced615]
- Updated dependencies [de38d90]
  - @principles/core@1.287.3
  - principles-disciple@2.0.4

## 1.152.13

### Patch Changes

- 99e6a8c: RAH-1 (PRI-905): production builds now exclude test code (tsconfig.build.json: *.test.*, __tests__/, __fixtures__/, *.spec.*), clean dist before building, and fail the build if compiled test artifacts appear in dist. Published dist shrinks accordingly (@principles/core tarball was ~57% test artifacts by size); runtime API, source layout and vitest behavior are unchanged. Test files are still type-checked via the new `typecheck` (tsc --noEmit) scripts, wired into verify:merge.
- 454eccf: RAH-2 (PRI-906): add a `files` publish whitelist (`dist`, `README.md`) to @principles/pd-cli. The package previously had no whitelist, so npm shipped the entire working tree: 111 uncompiled source files, the full 111-file test suite, and 2 development scripts alongside dist (~450 published files). Runtime surface (bin/exports/main → dist) is unchanged.
- Updated dependencies [c7453ea]
- Updated dependencies [84c7074]
- Updated dependencies [1ac725c]
- Updated dependencies [df43600]
- Updated dependencies [99e6a8c]
- Updated dependencies [edbbcd9]
- Updated dependencies [8b7b775]
- Updated dependencies [9d98f89]
- Updated dependencies [92074a0]
  - @principles/host-runtime@0.7.8
  - @principles/codex-adapter@0.4.7
  - principles-disciple@2.0.3
  - @principles/core@1.287.2
  - @principles/install-layout@0.2.7

## 1.152.12

### Patch Changes

- 75b4ac4: PRI-866 sourcePainId reader convergence: pd-cli's two inline sourcePainId parsers now delegate to the core canonical reader (exported from @principles/core/runtime-v2), and the rulehost pipeline dreamer-task lookup normalizes both sides at the comparison boundary — historical rows or queries carrying surrounding whitespace no longer miss their dreamer seed and are no longer rejected with a misleading no_dreamer_task_seeded.
- Updated dependencies [75b4ac4]
- Updated dependencies [8ae91f4]
  - @principles/core@1.287.1
  - @principles/codex-adapter@0.4.6

## 1.152.11

### Patch Changes

- 8424d60: Baseline-cutover dependency-contract fix: the internal dependency ranges now match the aligned component versions (principles-disciple ^2.0.1, @principles/host-runtime ^0.7.7, @principles/codex-adapter ^0.4.4). Without this, npm would nest stale registry copies inside the workspace after version alignment (ERR-131 single-copy violation; the 2026-09-19 release-train failure mode).
- Updated dependencies [8424d60]
- Updated dependencies [8424d60]
- Updated dependencies [8424d60]
  - @principles/codex-adapter@0.4.5
  - @principles/core@1.287.0
  - principles-disciple@2.0.2
