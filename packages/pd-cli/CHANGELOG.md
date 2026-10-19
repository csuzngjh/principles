# @principles/pd-cli

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
