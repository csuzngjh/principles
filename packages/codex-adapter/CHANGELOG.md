# @principles/codex-adapter

## 0.8.11

### Patch Changes

- ecd68fa: Adaptive activation now skips selection deterministically before the candidate read: missing host-bound turn identity, a blank prompt, an exhausted hook budget, and pure social acknowledgements return the Native body with zero model requests. Substantive prompts and task continuations keep the existing single-send fast path; the default-off switch and Native fallback are unchanged.
- ce31128: PRI-1171 P1（工单①+②，行为零变化提取）：host-runtime 新增 `conversation-ingestion` seam——统一宿主轨迹摄取的唯一中立入口（`TranscriptSourceAdapter` 契约 + `runConversationIngestion` 五段管线 + 同意台账 v3 + 同意分层文本策略）；Codex 摄取管线平移接入（解码器/版本守卫/路径授权留 codex-adapter，旧导出名兼容 re-export 一个版本周期）。同意台账权威迁至 `<workspace>/.state/conversation-ingestion-consent.json`（按宿主分键），旧 `.pd/codex-ingestion-consent.json` 首读单向迁移并改名 `.superseded`（保留审计）；新增 `owner_directive` 决定通道（须带 evidenceRef）。行为锁定：codex-adapter 全量 379/379 通过（真实 fixtures 走迁移后生产路径）；seam 新增 37 测试（flag-off 零读/consent 门/守卫拒绝不落库/preIngest 失败保水位/malformed 提交后降级/incomplete-tail/TOCTOU/水位回缩/consent 迁移矩阵）。
- Updated dependencies [8de5b0a]
- Updated dependencies [ecd68fa]
- Updated dependencies [ce31128]
- Updated dependencies [ce31128]
  - @principles/core@7.3.2
  - @principles/host-runtime@3.4.0

## 0.8.10

### Patch Changes

- 030d003: 把 Codex `UserPromptSubmit` 宿主的 5 秒 hook 窗口接到 Adaptive 有效截止上。
  
  此前 Codex hook 只按 `10s 首字节 + 10s 生成` 计时，宿主会在 5 秒到点时直接终止子进程并丢弃输出；
  实测中自适应选择跨过宿主截止（5060 ms），Native 正文与诊断一起被截断，传输也没有收到中止。
  
  现在 hook 按 `5000 − 800 ms` 从进程启动起算建立绝对截止，并复用既有 `AbortSignal` 贯通准入、生成、
  授权重验与装配：截止到达即取消传输、忽略迟到结果、保留 Native 正文；诊断新增
  `TURN_DEADLINE_EXCEEDED`，与生成超时 `SELECTION_EXPIRED`、正常弃选 `no_increment` 区分。
  未提供外层截止的既有调用方（OpenClaw）行为不变。
- 746e55d: B3：hook 与 replay 共用同一个工具语义解析入口。`resolveHostToolSemanticsForHook()` 以“workspace 持久化声明 → 宿主静态声明 → baseline”为优先级解析 `canonicalKind`：声明中出现的原始工具名以声明为准（与 replay/证据/Console 读取的是同一份 `.pd/host-tool-semantics/*.json`），声明未覆盖的静态名继续补齐，避免陈旧声明截断宿主当前工具面。声明损坏或跨宿主冲突时返回带 reason/nextAction 的类型化失败，绝不静默回退成空 registry；消费方（OpenClaw gate、Codex/WorkBuddy pd-hook）保留可用性——退回宿主静态声明并在 stderr / logger 留下可观察诊断（rc-9）。
  
  修复前：同一 workspace 中若持久化声明把 `exec` 记为 `write`（或声明了静态表没有的工具名），OpenClaw gate 仍按静态表判为 `execute`，生产侧提取出 `out.txt`，而 replay 得到 `<tool:exec>`，同一条路径规则在回放命中、在生产不命中。现在两端一致。
  
  OpenClaw 的接入模块刻意放在 `hooks/hook-tool-semantics.ts` 而非 `constants/tool-semantics.ts`：后者位于 `rulehost-evidence` 卫星包路径上，引入 host-runtime barrel 会把整条 LLM 依赖图拉进卫星包（satellite-purity / OPT-002）。
- Updated dependencies [c8b984f]
- Updated dependencies [030e0cf]
- Updated dependencies [2efe4a0]
- Updated dependencies [030d003]
- Updated dependencies [389477a]
- Updated dependencies [746e55d]
  - @principles/core@7.3.1
  - @principles/host-runtime@3.3.1

## 0.8.9

### Patch Changes

- 0afc6b3: SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8：Agent 痛点入口四阶段落地。
  
  - 阶段 1：Core Pain Submit Capability、anchor 校验、统一 Origin/Provenance；`evaluatePainIngress()` 增加 MCP 专用分支并排在通用 Unbound 分支之前。
  - 阶段 2：MCP `pd_submit_pain` 契约面；超时返回 `submit_unconfirmed`，并以 `taskId = diagnosis_<painId>` 做限时只读回查（found/not_found/read_error），不取消写入、不自动重投。
  - 阶段 3：四类写入点统一 `DEFAULT_PAIN_SCORE = 40`（`moderate`）；MCP 路径恢复 Observability，`pain_events` 可见。
  - 阶段 4：Console L2/L2b；OpenClaw tick 增加 L3 自动诊断（每轮最多 1 个，失败保留 pending，flag `openclaw_diagnostician_consumer` 可关）；安装器废弃旧 `pd-record-pain` skill（仅重命名字节命中已发布载荷的副本，用户修改副本保留并告警）。
  
  MCP 写能力仍受 OG-4 门禁约束：生产入口不开启，`tools/list` 不含 `pd_submit_pain`。
- 9ae1936: PRI-1170: 修复 Adaptive Activation 的选择协议并接入真实 Codex `exec` hook（默认关闭）。
  
  - 候选负载改为 `{ref, text, digest}`，`digest = sha256(实际下发正文)`，模型只原样复制引用与摘要；PD 用本轮冻结候选表核对，并独立重验正文、修订与授权。
  - 截止拆成「首字节 10 秒 + 生成阶段独立 10 秒」；保持每轮最多一次实际发送、零重试、零 repair、零 provider fallback，迟到结果不应用。
  - 新增 `@principles/host-runtime` 的选择协议与 priority provider 模块；`codex-adapter` 在 `before_prompt_build` 分支按 `host.codex.adaptive_activation`（quiet，默认 `false`）装配，关闭时 Native 输出逐字节一致且零模型请求。
  - 每次请求输出一行有界结构化诊断（阶段、首字节/生成结束/取消时点、引用与摘要校验结果、`finish_reason`），不保存原始会话、完整响应或凭据。
- Updated dependencies [0afc6b3]
- Updated dependencies [9ae1936]
- Updated dependencies [f1cf77b]
- Updated dependencies [f1cf77b]
- Updated dependencies [09a1205]
  - @principles/core@7.3.0
  - @principles/host-runtime@3.3.0

## 0.8.8

### Patch Changes

- Updated dependencies [3f6ab0d]
- Updated dependencies [1042164]
  - @principles/core@7.2.0
  - @principles/install-layout@0.7.0
  - @principles/host-runtime@3.2.2

## 0.8.7

### Patch Changes

- Updated dependencies [93288c7]
  - @principles/install-layout@0.6.0
  - @principles/host-runtime@3.2.1

## 0.8.6

### Patch Changes

- Updated dependencies [ddbd1cf]
  - @principles/core@7.0.0
  - @principles/host-runtime@3.2.0

## 0.8.5

### Patch Changes

- Updated dependencies [8da2cdc]
- Updated dependencies [30ccf33]
  - @principles/core@6.0.0
  - @principles/host-runtime@3.1.0

## 0.8.4

### Patch Changes

- Updated dependencies [20719c6]
- Updated dependencies [bbdcb50]
  - @principles/core@5.2.0
  - @principles/install-layout@0.5.0
  - @principles/host-runtime@3.0.4

## 0.8.3

### Patch Changes

- Updated dependencies [6278ec3]
  - @principles/core@5.1.0
  - @principles/host-runtime@3.0.0

## 0.8.2

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
  - @principles/host-runtime@2.2.3

## 0.8.1

### Patch Changes

- Updated dependencies [46cbdab]
  - @principles/core@4.0.0
  - @principles/host-runtime@2.0.0

## 0.8.0

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

### Patch Changes

- Updated dependencies [dc1addd]
  - @principles/core@3.0.0
  - @principles/host-runtime@1.0.0

## 0.7.0

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
  - @principles/host-runtime@0.15.0

## 0.6.3

### Patch Changes

- Updated dependencies [5fa6fc9]
  - @principles/core@2.0.0
  - @principles/host-runtime@0.14.5

## 0.6.2

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
- Updated dependencies [b8ec104]
  - @principles/host-runtime@0.14.3

## 0.6.1

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
  - @principles/host-runtime@0.14.2

## 0.6.0

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

## 0.5.14

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
  - @principles/host-runtime@0.13.5

## 0.5.13

### Patch Changes

- 1b13597: SPEC-PD-PAIN-RECALL-CLI-001: new read-only `pd pain recall` command — recalls the historical pains a principle verifiably derives from, so a host Agent can check a principle's origin, trigger boundary, or current-situation fit on demand. Only two authoritative association edges are honored (`reuseEvidence[].painId`; `derivedFromPainIds` resolved through its production contract as candidate ids via `tasks.input_ref`), results dedup by real pain id while keeping every evidence ref, `--context` re-ranks deterministically without any model/network call, and per-source availability separates `not_recorded` from `unreadable` (`source_missing`/`source_unreadable` never masquerade as `no_matches`). All three hosts' `pd-cli-operator` skills (Codex plugin, OpenClaw en/zh templates, WorkBuddy adapter) now document when to call it, how to read the JSON contract, and the diagnosis-is-not-owner-statement rule.

## 0.5.12

### Patch Changes

- Updated dependencies [0f2d1fb]
  - @principles/core@1.296.0
  - @principles/host-runtime@0.13.0

## 0.5.11

### Patch Changes

- 4256244: PRI-1019：为 Codex RuleCode 接通经 Owner 认证的设计事实声明、生成能力检查和逐次运行时事实；缺失或失效事实会暂停依赖规则并显示原因。Console 提供范围登记与撤回入口；保留真实原则审批与逐工件激活流程。
- Updated dependencies [4256244]
  - @principles/core@1.295.3
  - @principles/host-runtime@0.12.2

## 0.5.10

### Patch Changes

- Updated dependencies [48df168]
  - @principles/host-runtime@0.12.0

## 0.5.9

### Patch Changes

- d3796e4: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.
  
  - Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match (host-declared provider) → legacy fixed 2000-char fallback with a bounded machine-readable reason code — provider-less name-only matches NEVER confirm (v0.2 trust amendment: a unanimous name cannot prove the deployment is not a custom endpoint). Budget formula `min(16000, max(1250, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens). The 1250 floor is MEASURED (shared route full render of one minimum viable principle = 849/1204 chars with self-report off/on — lower floors re-create the audited 32K zero-injection defect); the 16000 cap is the Owner target upper bound (1M windows map to 15625).
  - Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 1250..16000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 16000 max tier; cross-host aggregation is monotone — only ALL-hosts overflow brands an entry oversized everywhere); injection events carry budget provenance INCLUDING the bounded `budgetFallbackReason` code.
  - Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
  - Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.
- Updated dependencies [d3796e4]
  - @principles/core@1.295.0
  - @principles/host-runtime@0.11.0

## 0.5.8

### Patch Changes

- 1a127e2: 修复 RuleCode 新生成契约与路径事实，统一原则范围内的语义验收，并为经过逐规则复验的 Codex V2 规则接通运行上下文。
- Updated dependencies [1a127e2]
  - @principles/core@1.293.5
  - @principles/host-runtime@0.10.3

## 0.5.7

### Patch Changes

- b02ebb5: Connect WorkBuddy current-user explicit Owner pain submissions to existing governance admission and diagnostic task creation. Preserve native session/turn identity, unverified Owner evidence, bounded input rejection and model-visible receipts; retain Codex prefix behavior through the shared parser.
- Updated dependencies [b02ebb5]
  - @principles/core@1.293.4
  - @principles/host-runtime@0.10.2

## 0.5.6

### Patch Changes

- 06152af: Connect Codex Owner-labelled behavior evidence to the shared internalization preflight. Reuse one validated assembler across OpenClaw, Codex and evidence attach/resume; read trajectory data without creating or migrating it and preserve host-specific semantics. Missing labels reach Owner review without model calls or attempts; missing/corrupt sources remain observable source faults.
- Updated dependencies [fec1306]
- Updated dependencies [574954a]
- Updated dependencies [06152af]
  - @principles/install-layout@0.4.0
  - @principles/core@1.293.0
  - @principles/host-runtime@0.10.0

## 0.5.5

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/core@1.292.1
  - @principles/host-runtime@0.9.1
  - @principles/install-layout@0.3.1

## 0.5.4

### Patch Changes

- 5e794be: WorkBuddy remediation: pass through the existing toolUseId into tool-failure admission candidates (optional, default-off behavior unchanged) so per-call identity survives the admission boundary.
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
- Updated dependencies [6e60d84]
- Updated dependencies [0f94f8c]
- Updated dependencies [4ba83b7]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
  - @principles/core@1.292.0
  - @principles/host-runtime@0.9.0
  - @principles/install-layout@0.3.0

## 0.5.3

### Patch Changes

- 6317a63: Keep unresolved content references unresolved across evidence replays (Phase 1 closeout review P2-2). The evidence producers treated the STORED contentRef as an opaque truthy object when rebuilding an observation for a replayed source event: an already-stored `revision_reference_unresolved` reference (no payloadDigest — e.g. an activation whose artifact is missing) was re-emitted as `resolution: 'resolved'` without a digest. The normalizer rejects `resolved`-without-digest before the store's idempotent dedup branch runs, so replaying the SAME source event failed with `observation_contentRef_resolved_requires_payloadDigest` instead of landing as an idempotent duplicate — "record count unchanged" was the result of rejection, not idempotency (the real 2026-10-11 replay probe hit exactly this). Resolution is now upgraded to `resolved` only when a payloadDigest is actually present; digest-carrying (resolved) replays keep their digest and dedup as before. Fixed at all four producer sites (Codex prompt delivery + Codex deny chain, OpenClaw prompt delivery + gate enforcement chain); validator, oracle, and store semantics unchanged. `create-principles-disciple` rides along because the installer bundles the plugin. Regression tests drive the real recorder → ingress → store boundary on both hosts: unresolved first-record + replay lands as `duplicateCount: 1` with the original resolution preserved, and a new ingress boundary test pins digest-less-batch replay as an idempotent duplicate plus same-key-different-content as a reported conflict.

## 0.5.2

### Patch Changes

- 4b84634: Advance the Marketplace runtime pin to the already-published npm versions that carry the Phase 1 intervention-evidence face: codex-adapter 0.5.1 (codex-evidence-recorder), host-runtime 0.8.1 (intervention-evidence-ingress), core 1.291.2 (published by the 2026-10-11T03:51Z release train, carries the #1982 evaluator template-pairing fix). Verified by `npm run check:runtime-pin` (packaged capability probe S1–S5 PASS against npm-installed bytes) plus tarball content inspection of all three evidence modules (re-run against 1.291.2 after the train published it). The previous pin (0.4.7 / 0.7.11 / 1.287.6) predates the Phase 1 evidence recorder, so officially installed Codex hosts had no intervention-evidence surface (acceptance 2026-10-10 §7.2 G-Codex-1).
- Updated dependencies [4b84634]
- Updated dependencies [4b84634]
- Updated dependencies [4b84634]
  - @principles/core@1.291.3
  - @principles/host-runtime@0.8.2

## 0.5.1

### Patch Changes

- c20aef0: PRI-943: the pd-hook process boundary is now fail-open by construction, not by convention. The hook promises Codex `exitCode 0` (unconditional) plus exactly one JSON object on stdout whenever stdout stays writable, but three terminal paths could still abort the process with exit 1: the write-out tail (`stderr` loop, `stdout` JSON, `process.exitCode`) sat outside `main()`'s try, EPIPE from a host that closed the pipe arrives as an **async `'error'` event** no try/catch can reach (node then dies with "Unhandled 'error' event"), and `void main()` had no rejection handler. Each is now belted on its own — per-write guards, a guarded stdout serialization that falls back to `{}` (`hook_stdout_serialize_failed`, rc-8), persistent `'error'` listeners armed only on the entry path, and a last-resort entry `catch` that still emits `{}` when nothing reached stdout (best effort: if stdout itself is the failed stream, the object may not survive the dead pipe) — with a single bounded `hook_stream_failed` / `hook_fatal` diagnostic on stderr, never in the machine channel.

## 0.5.0

### Minor Changes

- d5732f8: PD v2 Phase 1 Evidence Foundation (ADR-0027): normalized intervention evidence ledger.
  
  - core: intervention evidence contract + deterministic normalizer (rc-1..rc-5 trust boundary, anti-forgery cross-field rules), append-only SQLite ledger tables inside the existing state.db (idempotent same-source replay, reported source conflicts, immutable records, activation occurrence snapshots), busyTimeoutMs connection option, and the four-query audit read contract.
  - host-runtime: shared intervention evidence ingress — the single validated entry every host source uses; never throws, never waits on locks (busyTimeoutMs 0), degrades with structured reason + nextAction.
  - openclaw-plugin (principles-disciple): evidence wiring on both legacy and shared routes — prompt delivery attempts (submitted/attempted, host consumption never claimed), enforcement chains on gate block/auto-correct (runtime_loaded delivery, runtime_verified application with explicit proof boundary, episode, effect), agent_claimed self-report mirroring; gated by the existing principle_receipt_ledger flag.
  - codex-adapter: evidence adapter on the shared ingress — UserPromptSubmit delivery attempts after the durable event-log line, deny chains recorded only after successful stdout encoding; honest capability matrix (self_report Unsupported, enforcement Unknown per PRI-780).
  - create-principles-disciple (ships pd-console): four read-only evidence-audit queries under /api/v1/receipts/evidence-audit plus the authenticated Owner outcome input POST /api/v1/evidence/outcomes (closed body contract, server-derived actor), and an evidence-audit section on the principle detail page.
  
  No effectiveness scoring, ranking, or automatic governance action anywhere (Phase 1 records facts only).

### Patch Changes

- Updated dependencies [d5732f8]
- Updated dependencies [0b981bb]
  - @principles/core@1.290.0
  - @principles/host-runtime@0.8.0

## 0.4.8

### Patch Changes

- cee2304: Use the Codex user governance workspace across projects while resolving tool paths from the active project. Register Marketplace setup with the existing canonical installation so Companion can discover its Codex worker.
- df9e555: PRI-917 v0.3.3 (OD-PRI917-05): Reuse Review Gate — automatic candidate intake now consults the semantic reuse evaluation capability before creating a Principle.
  
  A `reuse` recommendation parks the candidate (`refused/reuse_pending_owner`): no Principle is written, no evidence is appended, the candidate stays pending for the Owner, and the bridge emits an observable `reuse_gate_triggered` event plus a `reuse_review_required` outcome pointing at `pd candidate review --decide reuse|create`. `create`/`uncertain` recommendations and every evaluation failure degrade to normal creation (learning never blocks). `reuseEvaluation.enabled=false` restores the exact pre-v0.3.3 behavior.
  
  Also fixes the R5 "two-heads-block" defect: `pd candidate review --decide reuse` no longer lets the PRI-442 admission pre-check reject low-confidence candidates — a reuse verdict creates nothing, so the ledger-quality gate does not apply (the `--decide create` pre-check is unchanged).
  
  PR review fixes (4×P2, PRI-938): the bridge cache key now folds in the reuse-gate switch so a long-lived host picks up `reuseEvaluation.enabled` toggles in both directions (T11 rollback without a restart); mixed batches and replays keep parked candidates visible (`reuse_review_required` degraded outcome, Codex worker `reuseReviewRequiredCandidateIds`, OpenClaw `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` log gated on the park disposition); `pd diagnose` / `pd pain-retry` render parked candidates with review guidance and exclude them from `internalize` next-action lists.
  
  Follow-up review fixes: evaluation profile and timeout changes invalidate the cached reuse hook. Replay verifies the original diagnosis admission and performs a read-only reuse check before reporting a parked candidate, preserving failed-intake and gate-disabled behavior without additional persisted state.
  
  Owner-approved configuration hardening: constructing CandidateIntakeService with both reuseRecommendation and reuseDecision now fails explicitly before either callback or any candidate mutation, instead of silently prioritizing the decision channel.
- Updated dependencies [cee2304]
- Updated dependencies [df9e555]
  - @principles/host-runtime@0.7.13
  - @principles/core@1.289.0

## 0.4.7

### Patch Changes

- 84c7074: PRI-892: fixed the silent no-op of `npx create-principles-disciple` on Windows. Node resolves the main module through symlinks/junctions while `process.argv[1]` keeps the unresolved link path handed over by npm/npx `.bin` shims, so the raw `pathToFileURL(argv[1]) === import.meta.url` entry guard never matched and the CLI exited 0 with zero output (install / repair-update-chain / uninstall all dead). The guard now canonicalizes argv[1] with `realpathSync` before comparing (fail-safe: an unreadable entry is simply not the main module), keeps the cli-7 import-safety semantics (importing the module still never parses argv), and adds an rc-9 observable fallback: when the entry path unambiguously names this package's `dist/index.js` but canonicalization still misses, the CLI warns on stderr instead of saying nothing. The identical guard in the Codex `pd-hook` entry is fixed the same way (linked installs previously skipped `main()` silently). Regression tests spawn the built CLI and hook through a junction path and assert real output (red before the fix: empty stdout, exit 0).
- 1ac725c: PRI-892 follow-up (last open review finding of the merged PR #1833): the Codex `pd-hook` entry guard could still reproduce the silent no-op it was introduced to remove, because it compared `argv[1]` only after `realpathSync` and answered a failed lookup with `return false`. A legitimate direct invocation whose realpath lookup threw (EPERM, an antivirus-held path, an exotic mount) therefore skipped `main()` and the hook emitted nothing. The guard now decides in three layers: the raw `pathToFileURL(argv[1]) === import.meta.url` comparison runs first, so an ordinary `node dist/pd-hook.js` never depends on a filesystem lookup succeeding; realpath canonicalization still covers the npm/npx `.bin` shim and junctioned-install case; and when realpath itself throws while `argv[1]` still names this file, the guard writes a bounded rc-9 diagnostic (`reason=entry_identity_unverified … nextAction=…`) and runs `main()`, preserving the hook contract of exactly one JSON object on stdout. cli-7 import-safety is unchanged, and the installer needed no edit because its `looksLikeOwnDistEntry()` fallback already resolves without realpath. Regression tests pin all three layers by spawning the built hook through a real path, a junction path and an unresolvable path, plus the negative control that an unresolvable entry naming a different file stays silent.
- Updated dependencies [c7453ea]
- Updated dependencies [99e6a8c]
- Updated dependencies [edbbcd9]
- Updated dependencies [8b7b775]
- Updated dependencies [9d98f89]
- Updated dependencies [92074a0]
  - @principles/host-runtime@0.7.8
  - @principles/core@1.287.2
  - @principles/install-layout@0.2.7

## 0.4.6

### Patch Changes

- 8ae91f4: Re-cut of @principles/codex-adapter. The 0.4.5 tarball on npm was published by a legacy release run carrying stale internal dependency ranges (@principles/core ^1.74.1, @principles/host-runtime ^0.1.0), so an install resolving to 0.4.5 pulls inconsistent dependency copies. npm tarballs are immutable and cannot be corrected in place, so this publishes a fresh 0.4.6 from the current aligned tree (@principles/core ^1.287.0, @principles/host-runtime ^0.7.7, @principles/install-layout ^0.2.0). Version re-cut only; no source change.
- Updated dependencies [75b4ac4]
  - @principles/core@1.287.1

## 0.4.5

### Patch Changes

- 8424d60: Baseline-cutover dependency-contract fix: the @principles/host-runtime range now matches the aligned version (^0.7.7) so workspace resolution stays single-copy after version alignment (ERR-131).
- Updated dependencies [8424d60]
  - @principles/core@1.287.0
