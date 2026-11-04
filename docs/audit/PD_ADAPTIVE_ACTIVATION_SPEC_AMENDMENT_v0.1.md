# PD Adaptive Activation SPEC — WorkBuddy Amendment Proposal v0.1

> ⚠️ **SUPERSEDED BY `PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.2.md` (2026-11-04).**
> 反向审查发现 v0.1 存在会导致错误激活的设计缺陷（把 `TaskCreated` 当确定性 `NEW_TASK`）、
> 未获证据支持的 async 生命周期保证、以及混淆执行/交付状态的 Delivery 模型。
> 详见 `PD_WORKBUDDY_AMENDMENT_ADVERSARIAL_REVIEW_v0.1.md`。**本文件仅作历史记录，请勿据以实施。**
>
> **PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.1.md** — 针对 SPEC v0.4 的逐章节修改建议
> **本文件是独立修正案，不覆盖、不修改 `docs/specs/PD Adaptive Activation SPEC v0.4.md` 原文。**
> 基线：2026-11-04 / WorkBuddy Desktop 5.9.2 / 引擎 2.165.0 / PD 插件 0.2.2
> 依据：`PD_WORKBUDDY_HOST_AUDIT_v0.1.md`、`PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md`、`PD_WORKBUDDY_INTEGRATION_GAP_AUDIT_v0.1.md`

## 0. 使用说明

- **替换单元粒度**：以「章节内需替换的段落 / 表格 / 接口定义」为单位。每个替换文本都是**完整可粘贴**的 Markdown / TypeScript；未列出的段落一律保持 v0.4 原文不变。
- **不修改原文**：本提案交 Owner 审阅后，由后续独立 PR 合并成 v0.5 或 v0.4-errata。
- **证据引用**：每条修改标注 `Gap-ID` 与证据等级；证据细节见 `PD_WORKBUDDY_EVIDENCE_MANIFEST_v0.1.md`。
- **判定三值**：`修订` / `保留（明确不改）` / `新增`。

## 1. 修订总表

| 章节 | 判定 | 替换单元 | 主因 / Gap |
|:---|:---|:---|:---|
| Metadata | 修订 | A-01 | GAP-05 / GAP-06 |
| §0.3 Evidence-Driven Host Findings | 修订 | A-02 | GAP-04/05/06/07 |
| §3 Core Architecture | 修订（保留核心） | A-03, A-04 | GAP-09 |
| §4 Context Model | 修订 | A-05 | GAP-12 |
| §5.1 / §5.2 Host Event Semantics | 修订 | A-06, A-07 | GAP-06/07/08 |
| §5.3 SessionStart Is Not a Universal Boundary | **保留（明确不改）** | — | 结论被当前源码再次证实 |
| §5.4 Trigger Conditions | 修订 | A-08 | GAP-08 |
| §5.5 Incremental Checkpoint | 修订 | A-09 | GAP-08/13 |
| §5.6–5.9 Decision Model | **保留（明确不改）** | — | 语义选择器设计正确 |
| §6 General Reasoning Selector | **保留（明确不改）** | — | 无 WorkBuddy 相关问题 |
| §7 Unified Selection / Packing | **保留（明确不改）** | — | 「只有一个 Resolver 产出最终集合」「两个独立预算」均正确 |
| §8 Working Set Persistence | 修订 | A-10, A-11 | GAP-10/12 |
| §9 Workspace Focus | 修订（小修） | A-12 | GAP-12 |
| §10 Model Runtime Configuration | 修订 | A-13, A-14 | GAP-09/11 |
| §11 Feature Flags | 修订 | A-15 | GAP-09/11 |
| §12 Host Runtime Capability Profiles | **大幅修订** | A-16, A-17, A-18, A-19 | GAP-04/05/06/11/17 |
| §13 Host-specific Prompt Injection | **大幅修订** | A-20, A-21, A-22 | GAP-04/14 |
| §14 Execution and Failure Handling | 修订 | A-23, A-24, A-25 | GAP-01/02/03/09 |
| §15 Receipt, Observability, Evidence | 修订 | A-26, A-27, A-28 | GAP-02/16 |
| §16 Security and Privacy | **保留（明确不改）** | — | 治理边界正确 |
| §17 Performance and Cost | 修订 | A-29, A-30 | GAP-01/17 |
| §18 Evaluation and Experiments | **保留（明确不改）** | — | 评测框架与本轮宿主发现无关 |
| §19 Rollout Plan and Gates | 修订 | A-31 | GAP-05/11/18 |
| §20 Acceptance Criteria | 修订 | A-32 | GAP-01/02/03/10/11/18 |
| §21 Stop Conditions | 修订 | A-33 | GAP-01/02/03 |
| §22 Open Questions | 修订 | A-34 | GAP-04/09/15 |
| §23 Architecture Decision Records | 修订（新增 2 条） | A-35 | GAP-09/15 |
| §24 Change Log / §25 Self-audit | 修订 | A-36 | 一致性维护 |

---

# 2. 逐章节修正案

## A-01 — Metadata 表

- **判定**：修订
- **原因**：Host evidence baseline 指向 2.161.0 / 5.8.1 / PD 0.2.0 的历史探针；当前为 2.165.0 / 5.9.2 / 0.2.2，且引擎 SHA 已变（GAP-05）。`Verified runtime scope` 中「WorkBuddy `lite-wb` CLI」的表述不成立（GAP-06）。
- **原设计的问题**：`Host probe observed HEAD` 与 `Code audit baseline` 已有区分纪律，但未记录**宿主引擎版本与二进制指纹**，导致 §12.1「版本变更 profile 失效」无法执行。
- **新设计**：把宿主身份写成五元组并绑定 SHA-256；`runtimeMode` 按实际 Desktop + CLI 引擎子进程描述。

**建议替换文本**（替换 Metadata 表中 `Host evidence baseline` 至 `Verified runtime scope` 四行）：

```markdown
| Host evidence baseline        | `PD Host Event Capability Matrix v0.1 — Live Runtime Verification` (HISTORICAL, 2026-10-12, engine 2.161.0 / Desktop 5.8.1 / PD 0.2.0 — **EXPIRED for the current profile**); superseded for WorkBuddy by `PD_WORKBUDDY_HOST_AUDIT_v0.1.md` + `PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md` (2026-11-04) |
| Host probe baseline commit    | `5c3371c3935192081585d741f50a899bc4445b0e` (HISTORICAL)                                                                        |
| Host probe observed HEAD      | `2f2bdf101955a807b8c041fca5a162174b9b494e` (HISTORICAL)                                                                        |
| WorkBuddy profile baseline    | appVersion `5.9.2`; engine `@genie/agent-cli 2.165.0`; Electron `37.10.3-43`; engine SHA-256 `6fbfd77bae7e7688abf7dfd2488b50c79390c966a9132e73ebe7a5a2d7df99cf`; PD plugin `0.2.2`; `UserPromptSubmit` 15 s / others 30 s; verifiedAt `2026-11-04` |
| Verified runtime scope        | OpenClaw embedded; OpenClaw Gateway `sessions.reset`; Codex headless CLI; **WorkBuddy Desktop 5.9.2 hosting the CLI engine subprocess** (Desktop UI-only capabilities and standalone-IDE modes remain `NOT_RUN`) |
```

---

## A-02 — §0.3 Evidence-Driven Host Findings

- **判定**：修订
- **原因**：GAP-04（channel UNKNOWN 已可判定）、GAP-05（版本）、GAP-07（tool events NOT_RUN 过时）、GAP-10（15/30 差异已消解但残留风险）。
- **原设计的问题**：把 2026-10-12 探针的中间状态写成当前有效结论；「injection channel unknown」导致 §13 无法定义真实契约。

**建议替换文本**（替换 §0.3 中 WorkBuddy 相关的 bullet 与「The evidence also confirms」列表中的 WorkBuddy 条目，其余保持原文）：

```markdown
- WorkBuddy `5.9.2` Desktop (CLI engine `2.165.0`), 2026-11-04 current-environment
  audit: `UserPromptSubmit` 1/1, `SessionStart` 1/1, `PreToolUse` 164,
  `PostToolUse` 162 real dispatches observed in the live workspace log.
  `SessionStart` and `UserPromptSubmit` spawn concurrently (same-timestamp
  spawn of two different plugins observed); dispatch ordering is not
  guaranteed, but the host's **injection positions are deterministic**:
  `SessionStart` context = `first`, `UserPromptSubmit` context = `last`.
  Desktop UI-only capabilities (`/hooks` review panel, interactive TUI) and
  the standalone IDE runtime remain `NOT_RUN`.

The evidence also confirms (current profile):

- Injection channel: OpenClaw `system` + `user` prefix; Codex `developer`;
  **WorkBuddy = `user` message containing a `<system-reminder data-role="hook">`
  block placed before `<user_query>`** (`SOURCE_CONFIRMED` in engine 2.165.0;
  same shape in the historical P04 mock-request fixture). It is NOT a
  `system` or `developer` role and MUST NOT be assumed to carry
  system-level instruction priority.
- Host timeout behavior: OpenClaw fail-open; **WorkBuddy blocks the
  submission only when the hook result is `allowed:false`** (exit code 2,
  `permissionDecision:deny`, `continue:false`, or host-side kill after the
  configured timeout). A PD self-degradation that exits with code 1 is
  **non-blocking and the turn proceeds**; Codex marks the hook failed while
  the turn continues.
- Host-level timeout values are not interchangeable: OpenClaw
  `before_prompt_build` 15 s; WorkBuddy host default 60 s overridden by the
  enabled plugin's `hooks/hooks.json` (`UserPromptSubmit` 15 s, others 30 s
  in the current 0.2.2 profile); Codex host hook default 600 s.
- **The historical "canonical 15 s vs installed 0.2.0 cache 30 s" divergence
  is resolved for the active profile**: the enabled `0.2.2` `hooks.json` is
  byte-identical to the repository canonical copy (SHA-256 `556d546a…`).
  The unresolved risk is instead **stale `hooks.json` copies physically
  coexisting** (`0.1.0` / `0.2.0` / `0.2.2`) combined with the host's
  array-concatenation `mergeHooks` semantics, which can cause duplicate
  registration and duplicate injection.
- **A real silent delivery failure has been observed**: in the 2026-11-04
  live session the PD `UserPromptSubmit` hook exited `code=1` at 12.113 s
  with `status=degraded reason=workbuddy_wrapper:entry_deadline_exceeded`,
  and the session contains **zero** `runtime_v2_prompt_activations_injected`
  records. The submission was not blocked, but the principle contribution
  for that turn was lost. Deferred work therefore cannot be treated as a
  future-only concern.
- Probe callback latency is not PD plugin latency. The actual PD DB,
  selection, rendering, and adapter path has not yet been measured — and
  the observed production degradation makes that measurement a P0
  prerequisite rather than a later Phase 2 task.
```

---

## A-03 / A-04 — §3 Core Architecture

- **判定**：修订（保留决策核心）
- **原因**：GAP-09。架构图中 deferred refresh 为一条无载体的虚线，§10.4/§14.2 把宿主后台能力列为未决前提。
- **原设计的问题**：不违反「共享决策核心 + 宿主适配器」原则，但缺一条**宿主原生异步执行载体**，迫使实现者自建 worker（与 §1.2 Non-Goal 12「不引入新独立子系统」冲突）。
- **新设计**：保留 §3.1 全部节点，只把 `D -. deferred refresh .-> H` 改为经过 `Host async hook` 节点；§3.3 的 Model-assisted 流程图补一段载体说明。**共享决策核心、Native/Model 双模、两阶段模型结构一律不动。**

**建议替换文本 A-03**（替换 §3.1 mermaid 图中 `D -. deferred refresh .-> H --> I --> J --> R` 一行及紧随其后的说明段）：

```markdown
    D -. bounded refresh request .-> W[Host-native async Hook]
    W --> H --> I --> J --> R
```

```markdown
The model path is a deferred refresh path. It is not a synchronous
dependency of `BEFORE_MODEL_TURN`.

For the WorkBuddy profile the deferred execution carrier is the host's
native detached hook (`async: true` with `asyncTimeout`), which returns
`allowed:true` immediately and never contributes content to the current
turn. An async hook MUST NOT be used as an injection channel; its result
may only update a versioned Working Set that is consumed at a later
verified `BEFORE_MODEL_TURN`. Other hosts must prove their own safe worker
before Model-assisted modes are enabled for them.
```

**建议替换文本 A-04**（在 §3.3 Model-assisted Mode 代码块 `No background result may mutate a prompt already submitted to the host.` 之后追加）：

```markdown
For WorkBuddy, "Deferred Refresh Eligibility" is additionally gated by a
host-native capability check: the enabled plugin must declare a detached
`async` hook whose `asyncTimeout` is strictly bounded, and the adapter must
verify that the hook process is tracked by the host (`registerHookPid`) and
cannot outlive the session. If this check fails, Shadow and Live remain OFF
for that profile while Native continues unchanged.
```

---

## A-05 — §4.3 Read-only Context Snapshot Contract

- **判定**：修订
- **原因**：GAP-12。宿主提供 `generation_id` / `taskId` / `agent_id` / `source` / `compact_summary`，PD 未纳入身份维度。
- **原设计的问题**：`AdaptiveContextSnapshot` 只有 `workspaceId` / `sessionId`，无法关联同一轮内的 UPS 与 Stop，也无法识别 Task 边界与压缩后上下文。

**建议替换文本**（替换 §4.3 的 TypeScript 接口）：

```typescript
interface AdaptiveContextSnapshot {
  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;
  engineVersion: string;          // NEW: e.g. "@genie/agent-cli 2.165.0"
  engineSha256?: string;          // NEW: profile invalidation anchor
  runtimeMode: string;            // NEW: e.g. "desktop_cli_engine"
  hostProfileId: string;
  hostProfileRevision: string;
  pdPluginVersion?: string;       // NEW: installed plugin version

  workspaceId: string;
  sessionId: string;
  generationId?: string;         // NEW: shared across UPS/Stop in one turn
  taskId?: string;               // NEW: host TaskCreated/TaskCompleted
  agentId?: string;              // NEW: SubagentStart/Stop
  sessionSource?: "startup" | "resume" | "clear" | "compact" | "unknown";
  compactSummary?: string;       // NEW: PostCompact revalidation input

  recentConversation: ConversationMessage[];
  sessionWorkingSet?: SessionWorkingSet;

  workspaceFocus?: {
    revision: string;
    content: string;
    updatedAt?: string;
    sourcePath?: string;
  };

  intent?: {
    enabled: boolean;
    revision?: string;
    content?: string;
  };

  hostEvent: CanonicalHostEvent;
  capturedAt: string;
}
```

**追加规则**（替换 §4.3 Rules 列表末尾，在 `Missing reliable workspaceId or sessionId …` 之后）：

```markdown
- `generationId`, `taskId`, `agentId`, `sessionSource` and `compactSummary`
  MUST come only from verified host payload fields. Missing values remain
  missing; adapters MUST NOT derive them from message IDs, trace IDs,
  transcript parsing, or fabricated ordinals.
- A change in `engineVersion`, `engineSha256`, `runtimeMode`,
  `pdPluginVersion` or `hostProfileRevision` invalidates the profile-bound
  Working Set until `resolveHostProfile()` re-verifies it.
```

---

## A-06 / A-07 — §5.1 映射表 / §5.2 Canonical Event Envelope

- **判定**：修订
- **原因**：GAP-06/07/08。
- **原设计的问题**：§5.1 映射表把 `WorkBuddy lite-wb CLI` 当独立模式、把 Desktop 整体标 `NOT_RUN`；§5.2 的 `CanonicalEventType` 只有 5 个值，无法表达宿主确定性任务/压缩边界。

**建议替换文本 A-06**（替换 §5.1 表格中 WorkBuddy 两行及其后「A mapping is permitted…」段落）：

```markdown
| Host/runtime mode                                  | Source event          | Mapping                             | Evidence                                              |
|---------------------------------------------------|:----------------------|:------------------------------------|:------------------------------------------------------|
| Codex headless CLI                                 | `UserPromptSubmit`    | `BEFORE_MODEL_TURN`                 | VERIFIED-E3, 8/8 (historical)                         |
| **WorkBuddy Desktop 5.9.2 / CLI engine 2.165.0**  | `UserPromptSubmit`    | `BEFORE_MODEL_TURN`                 | RUNTIME_VERIFIED, 1/1 live dispatch + SOURCE_CONFIRMED |
| OpenClaw embedded                                  | `before_prompt_build` | `BEFORE_MODEL_TURN`                 | VERIFIED-E3, seven event types observed               |
| Codex interactive TUI                              | —                     | No mapping authorized               | NOT_RUN                                               |
| **WorkBuddy standalone IDE runtime**               | —                     | No mapping authorized               | NOT_RUN (IDE docs describe only 7 events; no runtime evidence) |
| **WorkBuddy Desktop UI-only capabilities**         | —                     | No mapping authorized               | NOT_RUN (`/hooks` review panel, TUI; hook engine itself IS verified) |
| OpenClaw reply `/reset`                            | —                     | No mapping authorized               | NOT_RUN                                               |
| OpenClaw ordinary Gateway turn                     | —                     | No mapping authorized by this probe | NOT_RUN                                               |

A mapping is permitted only for the exact host version / engine version /
runtime mode / installed plugin version for which evidence exists. A
version or mode change invalidates the profile until reverified.
`lite-wb` is the name of the CLI engine entry file, **not** a runtime mode;
profiles MUST NOT be named after it.

For the current WorkBuddy profile, the following host events are
additionally verified and may be used as **refresh triggers only** (never
as injection channels): `SessionStart`, `SessionEnd`, `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `PreCompact`, `PostCompact`,
`TaskCreated`, `TaskCompleted`, `SubagentStart`, `SubagentStop`, `Stop`.
Dispatch evidence: `PreToolUse` 164 and `PostToolUse` 162 live dispatches;
remaining events `SOURCE_CONFIRMED` with zero live samples in the audited
session (NOT_RUN for runtime confirmation, not unsupported).
```

**建议替换文本 A-07**（替换 §5.2 的 `CanonicalEventType` 定义）：

```typescript
type CanonicalEventType =
  | "BEFORE_MODEL_TURN"
  | "WORKSPACE_FOCUS_REVISION_CHANGED"
  | "SESSION_CONTEXT_RESTORED"
  | "SESSION_RESET_CONFIRMED"
  | "PERIODIC_CHECKPOINT"
  | "HOST_TASK_CREATED"        // NEW: deterministic task boundary
  | "HOST_TASK_COMPLETED"      // NEW: deterministic task boundary
  | "HOST_SESSION_ENDED"       // NEW: best-effort lifecycle end
  | "HOST_POST_COMPACT";       // NEW: compaction revalidation point
```

并在 `CanonicalHostEvent` 接口中增补：

```typescript
  engineVersion?: string;
  engineSha256?: string;
  generationId?: string;
  taskId?: string;
  agentId?: string;
  sessionSource?: string;
```

---

## A-08 — §5.4 Trigger Conditions

- **判定**：修订
- **原因**：GAP-08。宿主确定性 Task/Session/Compaction 事件应跳过 `principle_decision`，直接映射 decision。
- **原设计的问题**：`HOST_TASK_BOUNDARY` 一行只写「Enqueue Decision Model」，把宿主已确定的边界又交给模型判断，产生不必要调用与错误激活风险。

**建议替换文本**（替换 §5.4 整个表格与其后一句）：

```markdown
| Trigger                        | Description                                                            | Action                                                                                                     |
|:-------------------------------|:-----------------------------------------------------------------------|:-----------------------------------------------------------------------------------------------------------|
| `INITIAL_SESSION`              | No valid Working Set exists when a verified prompt event arrives       | Native immediately; enqueue deferred initialization only if a safe worker exists                           |
| `HOST_TASK_CREATED`            | Host `TaskCreated` with a verified `taskId`                            | **Deterministic `NEW_TASK`**; skip `principle_decision`; enqueue Selector only                          |
| `HOST_TASK_COMPLETED`          | Host `TaskCompleted` with a verified `taskId`                          | **Deterministic task boundary**; invalidate/expire the task-bound Working Set; no Decision Model call    |
| `HOST_SESSION_ENDED`           | Host `SessionEnd` (best-effort, not guaranteed)                        | Best-effort Working Set cleanup; TTL remains the authoritative fallback                                   |
| `HOST_POST_COMPACT`            | Host `PostCompact` with `compact_summary`                              | Recompute `contextFingerprint`, revalidate cached IDs; **no injection, no blocking**                    |
| `HOST_TASK_BOUNDARY`           | Any other verified host task boundary                                  | Enqueue deferred Decision Model                                                                            |
| `FOCUS_REVISION_CHANGED`       | Workspace Focus revision changes                                       | Enqueue Decision Model                                                                                     |
| `CONTEXT_FINGERPRINT_CHANGED`  | Local context fingerprint changes materially                          | Consider bounded refresh                                                                                   |
| `PERIODIC_CHECKPOINT`          | A safe per-session checkpoint is reached                               | Enqueue Decision Model **only when no verified deterministic boundary has fired since the last review**  |
| `COMPACTION_RESUME`            | A verified compaction/resume signal is available                      | Revalidate cached state; do not assume all hosts support it                                                |
| `WORKING_SET_EXPIRED`          | Working Set TTL or validity has expired                               | Native immediately; deferred refresh if safe                                                             |
| `ACTIVATION_REVISION_CHANGED`  | Relevant activation state changes                                     | Revalidate selected IDs before delivery                                                                  |

A trigger can request a refresh; it cannot itself authorize a principle.

**Determinism-first rule (WorkBuddy profile).** When a host event already
determines the task boundary (`TaskCreated`, `TaskCompleted`, `SessionEnd`,
`PostCompact`), the adapter MUST NOT invoke `principle_decision` for that
boundary. `principle_decision` is reserved for semantic changes *within* a
task (`GOAL_SHIFT`, `PHASE_SHIFT`, `UNCERTAIN`) that no host event can
express. This is an instance of §17.5 optimization order item 1:
"Avoid unnecessary Decision calls."
```

---

## A-09 — §5.5 Incremental Checkpoint

- **判定**：修订
- **原因**：GAP-08/13。turn 计数应降级为兜底；需显式列出 WorkBuddy 的重复派发成因。
- **原设计的问题**：`maxUserTurnsWithoutReview=4` 是主节奏；且「不要计数重复/回放回调」未说明宿主特定成因。

**建议替换文本**（在 §5.5 的 Per-message behavior 列表末尾追加）：

```markdown
- For the WorkBuddy profile, verified host lifecycle events take priority
  over counter-based checkpoints. `maxUserTurnsWithoutReview` is a fallback
  used only when no verified deterministic boundary has fired.
- `SessionStart` with `source: "resume"` and `source: "clear"` may dispatch
  repeatedly and MUST NOT be counted as a new user turn.
- A `PreToolUse` hook that returns `continue: false` causes the host to
  re-submit the user prompt, which fires `UserPromptSubmit` again in the
  same turn. The WorkBuddy adapter MUST NOT emit `continue: false`, and the
  deduplication key MUST include `generationId` so that a re-submitted
  prompt does not create a second turn or enqueue a duplicate refresh.
- Every refresh request is idempotent on
  `(hostProfileId, sessionId, generationId, taskId, contextFingerprint,
  workingSetRevision)`.
```

---

## A-10 / A-11 — §8 Working Set Persistence

- **判定**：修订
- **原因**：GAP-10/12。
- **原设计的问题**：`SessionWorkingSet` 缺生命周期字段；§8.3 只覆盖 DB 层并发，未覆盖 Hook 配置层重复注册。

**建议替换文本 A-10**（在 §8.2 `SessionWorkingSet` 接口内增补字段）：

```typescript
  generationId?: string;
  taskId?: string;
  sessionSource?: "startup" | "resume" | "clear" | "compact" | "unknown";
  engineVersion: string;
  engineSha256?: string;
  pdPluginVersion?: string;
  lastHostEvent?: CanonicalEventType;
```

并在 §8.2 Rules 列表追加：

```markdown
- A change in `engineVersion`, `engineSha256`, `pdPluginVersion`,
  `runtimeMode`, or `hostProfileRevision` invalidates the result until
  `resolveHostProfile()` re-verifies it (implements §12.1).
- `SessionEnd` is best-effort and MUST NOT be the sole cleanup trigger;
  idle TTL remains authoritative.
- `PostCompact` recomputes `contextFingerprint` from `compact_summary`
  without changing `selectedPrincipleIds` until a later validated refresh.
```

**建议替换文本 A-11**（在 §8.3 Concurrency 末尾追加新小节）：

```markdown
### 8.3.1 Hook Configuration Layer Idempotency (NEW)

Database revision checks do not protect against duplicate hook
registration. For the WorkBuddy profile:

1. The host merges hook configurations from multiple sources by **array
   concatenation**, not replacement. Stale plugin version directories may
   still contain a complete `hooks/hooks.json`.
2. Before enabling a plugin version, verify `installed_plugins.json`
   resolves to exactly one PD `installPath`, and that stale version
   directories are not discoverable by the host.
3. At hook entry, verify that `${CODEBUDDY_PLUGIN_ROOT}` resolves to the
   profile-bound version. On mismatch, return a neutral result
   immediately and write an `injection_skipped` receipt with
   `fallbackReason: "duplicate_or_stale_hook_registration"`.
4. `deduplicateHooks` deduplicates only identical command strings; it does
   NOT deduplicate two different plugin versions. PD MUST NOT rely on it.
```

---

## A-12 — §9.3 F3 Host-aware Lifecycle Maintenance

- **判定**：修订（小修）
- **原因**：GAP-12。F3 的事件列表是通用措辞，缺 Task/PostCompact/确定性边界。
- **原设计的问题**：`Compaction` 与 `Session resume` 未区分 Pre/Post，也无任务边界事件。

**建议替换文本**（替换 §9.3 F3 的「Evaluate only verified events」列表）：

```markdown
Evaluate only verified events, and record the exact source event per host
profile:

- Prompt build / user prompt submit (`before_prompt_build`,
  `UserPromptSubmit`).
- Compaction **before** (`PreCompact`, `before_compaction`) and **after**
  (`PostCompact`, `after_compaction`) — the "after" event is observational
  only and MUST NOT be used to block or rewrite the compacted context.
- Session resume / clear (`SessionStart.source` = `resume` | `clear`).
- Session end (`SessionEnd`, best-effort).
- Deterministic task boundaries (`TaskCreated`, `TaskCompleted`).
- Workspace Focus update.

Do not assume each host exposes the same lifecycle, and do not use a
`NOT_RUN` cell from one runtime mode as evidence for another.
```

---

## A-13 / A-14 — §10 Model Runtime Configuration

- **判定**：修订
- **原因**：GAP-09/11。`requireExactVersionMatch` 无实现；§10.4 的 deferred worker 前提对 WorkBuddy 已不成立。
- **原设计的问题**：§10.2 的配置 sketch 只有 `hostProfiles.requireExactVersionMatch: true`，没有运行时解析契约；§10.4 要求「若无法证明安全 deferred worker 则保持 OFF」，但宿主已有原生 async hook。

**建议替换文本 A-13**（在 §10.2 YAML sketch 的 `hostProfiles` 下追加）：

```yaml
  hostProfiles:
    requireExactVersionMatch: true
    workbuddy:
      appVersion: "5.9.2"
      engineVersion: "2.165.0"
      engineSha256: "6fbfd77bae7e7688abf7dfd2488b50c79390c966a9132e73ebe7a5a2d7df99cf"
      runtimeMode: "desktop_cli_engine"
      pdPluginVersion: "0.2.2"
      hookTimeoutsMs:
        UserPromptSubmit: 15000
        default: 30000
      hostDefaultTimeoutMs: 60000
      asyncRefresh:
        enabled: false          # OFF by default; Owner-gated
        hookType: "async_command"
        asyncTimeoutMs: 30000
```

并追加说明：

```markdown
- `hookTimeoutsMs` values are **resolved at runtime from the enabled
  plugin's `hooks/hooks.json`**; the YAML values above are the frozen
  profile baseline used for mismatch detection, not an override authority.
- `resolveHostProfile()` MUST read `install-manifest.json`,
  `cli/package.json`, `installed_plugins.json` and the enabled
  `hooks/hooks.json`, compare them with the frozen profile, and set
  `profile.status = EXPIRED` on any mismatch.
```

**建议替换文本 A-14**（替换 §10.4 Deferred Execution Prerequisite 整节）：

```markdown
## 10.4 Deferred Execution Prerequisite

A deferred model path requires a safe execution mechanism that does not
block the host prompt hook.

Before enabling Shadow or Live, verify whether an existing PD or host
worker/Agent execution path can:

- Accept a refresh request without blocking the hook.
- Persist or safely cache the result.
- Enforce workspace/session/profile binding.
- Cancel or discard stale work.
- Avoid duplicate concurrent refreshes.
- Report failures and latency.

Reuse existing runtime infrastructure if it satisfies these requirements.
Do not assume a host supports background execution merely because it
supports prompt hooks. If no safe deferred execution mechanism is proven,
keep model-assisted modes OFF and use Native.

### 10.4.1 WorkBuddy host-native async carrier (NEW)

For the current WorkBuddy profile the host engine provides a detached
command hook (`async: true` with `asyncTimeout`), verified by source
inspection of engine `2.165.0`. This satisfies the "non-blocking"
requirement and is the preferred carrier for Deferred Refresh, in place of
a new PD-owned worker process.

Hard constraints:

1. An `async` hook returns `allowed:true, exitCode:0` immediately and
   **contributes no content to the current turn**. It MUST NOT be used as
   an injection channel.
2. Its result may only update a versioned Working Set consumed at a later
   verified `BEFORE_MODEL_TURN`.
3. The detached process is still bounded by `asyncTimeout` and host
   SIGTERM→SIGKILL handling; PD MUST implement idempotency, a lease, and
   stale-result discard using §8.3.
4. The adapter MUST verify the async hook is registered under the
   profile-bound plugin version (§8.3.1) before enabling Shadow/Live.
5. Runtime behavior of the async hook is `NOT_RUN` in the 2026-11-04
   audit; it MUST be verified in an isolated probe before Gate 4.
6. Other hosts remain subject to their own worker verification. No
   cross-host inference is permitted.
```

---

## A-15 — §11.2 Default Flags

- **判定**：修订
- **原因**：GAP-09/11。新增能力需独立 flag，默认 OFF。
- **原设计的问题**：现有 Default Flags 表没有 async refresh / profile 绑定 / 确定性边界的开关。

**建议替换文本**（在 §11.2 表格末尾追加，保持 `OFF` 默认与 §0 Status 声明不变）：

```markdown
| WorkBuddy host-native async refresh      | OFF until isolated async-hook probe passes  |
| WorkBuddy deterministic task boundaries | OFF / available only after profile re-verification |
| Host Profile exact-version enforcement  | OFF until `resolveHostProfile()` is implemented   |
| WorkBuddy `degraded` delivery receipts  | **ON** (observability only; no behavior change)  |
```

> `degraded` receipts are the single exception to "all new capabilities OFF":
> they add no selection or injection behavior and are required to make the
> already-occurring silent delivery loss observable (§15, §21).

---

## A-16 / A-17 / A-18 / A-19 — §12 Host Runtime Capability Profiles

- **判定**：**大幅修订**
- **原因**：GAP-04/05/06/11/17。§12 是 v0.4 的硬门禁，也是当前最过时的一章。
- **原设计的问题**：`HostRuntimeCapabilityProfile` 缺引擎版本/二进制指纹；§12.3 矩阵 WorkBuddy 行全部基于历史探针；§12.4 的 WorkBuddy 执行规则把「timeout 阻断提交」当成单一语义、把 tool/compaction 事件排除在外。

**建议替换文本 A-16**（替换 §12.2 `HostRuntimeCapabilityProfile` 接口）：

```typescript
interface HostRuntimeCapabilityProfile {
  profileId: string;
  revision: string;

  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;          // e.g. "5.9.2"
  engineVersion: string;        // NEW e.g. "2.165.0"
  engineSha256?: string;        // NEW: binary-level invalidation anchor
  electronVersion?: string;     // NEW for Desktop profiles
  runtimeMode: string;          // NEW e.g. "desktop_cli_engine"
  pdAdapterVersion?: string;
  installedPluginVersion?: string;  // NEW e.g. "0.2.2"
  enabledPluginRoot?: string;       // NEW: absolute path of enabled version

  beforeModelTurn: {
    sourceEvent: string;
    verified: boolean;
    evidenceGrade: "E3" | "SOURCE_CONFIRMED" | "RUNTIME_VERIFIED" | "NOT_RUN";
  };

  // NEW: events verified for refresh (not injection)
  refreshEvents: Array<{
    sourceEvent: string;
    evidenceGrade: "OFFICIAL_DOC" | "SOURCE_CONFIRMED" | "RUNTIME_VERIFIED" | "NOT_RUN";
    dispatchSamples?: number;
  }>;

  identity: {
    workspaceId: "verified" | "partial" | "unavailable";
    sessionId: "verified" | "partial" | "unavailable";
    generationId: "verified" | "partial" | "unavailable";  // NEW
    taskId: "verified" | "partial" | "unavailable";        // NEW
    turnId: "verified" | "partial" | "unavailable";
    deduplication: "verified" | "partial" | "unavailable";
  };

  timing: {
    hostDefaultTimeoutMs?: number;      // NEW: 60000
    hostHookTimeoutMs?: number;         // resolved from enabled hooks.json
    pdConfiguredHookBudgetMs?: number;
    sessionStartChainMeasuredMs?: number; // NEW: 16736 observed
    pdMeasuredP95Ms?: number;
    pdMeasuredP99Ms?: number;
    softDeadlineMs?: number;
    resolutionSource: "installed_config" | "source_confirmed" | "measured";
  };

  failureSemantics: {
    onHostKill: "fail_open" | "block_submission" | "block_tool" | "hook_failed_turn_continues" | "unknown";
    onExit0: string;
    onExit1: string;
    onExit2: string;
    onSelfDegradation: string;          // NEW
  };

  injection: {
    channel: "system" | "developer" | "user_prefix"
           | "user_message_system_reminder" | "unknown";  // NEW value
    confirmed: boolean;
    encodingContract: string;
    hostContentLimit: "enforced" | "absent";  // NEW
    injectionPosition?: "first" | "last";    // NEW
  };

  asyncCapability: {                      // NEW
    hostNativeDetachedHook: "source_confirmed" | "runtime_verified" | "not_run" | "unavailable";
    contributesToCurrentTurn: false;
  };

  verifiedAt: string;
  evidenceReferences: string[];
  status: "VERIFIED" | "CONDITIONALLY_VERIFIED" | "NOT_RUN" | "EXPIRED";
}
```

**建议替换文本 A-17**（替换 §12.3 Verified Host Matrix 中 WorkBuddy 两行）：

```markdown
| WorkBuddy Desktop 5.9.2 / CLI engine 2.165.0 / PD 0.2.2 | `UserPromptSubmit` 1/1; `SessionStart` 1/1; `PreToolUse` 164; `PostToolUse` 162 (live). `SessionEnd`/`Stop`/`PreCompact`/`PostCompact`/`TaskCreated`/`TaskCompleted`/`SubagentStart`/`SubagentStop` SOURCE_CONFIRMED with 0 live samples. Concurrent spawn across plugins observed. | Start-to-spawn `timeout=15000ms`; **this session's UPS hook degraded at 12.113 s with exit 1 and produced zero injection records** | Host default 60 s overridden by enabled plugin `hooks.json`: UPS 15 s, others 30 s. Host kill / exit 2 → `block_submission`; exit 1 → non-blocking turn continues. `SessionStart` chain 16.7 s | Canonical and enabled `0.2.2` hooks.json are byte-identical (SHA-256 `556d546a…`); stale `0.1.0`/`0.2.0` copies remain on disk | **`user` message `<system-reminder data-role="hook">` before `<user_query>`**; UPS=`last`, SessionStart=`first`; no host-side content limit | `CONDITIONALLY_VERIFIED` — degraded delivery must be fixed before Live |
| WorkBuddy standalone IDE runtime | Not run | — | IDE official docs describe 7 events and a different config/exit-2 model; **not runtime evidence for this profile** | Do not assume | Unknown | `NOT_RUN`: no isolated IDE runtime probe |
```

并替换「Evidence interpretation」中 WorkBuddy 三条 bullet：

```markdown
- The 2026-11-04 live log contains 332 hook spawns; `0` host-side
  timeouts and `0` blocked submissions. PD's own wrapper self-degraded
  once (exit 1, non-blocking) and that turn received no principle
  contribution. `degraded` is a first-class outcome, not a success.
- WorkBuddy tool events are **verified** for the current profile
  (164/162 live dispatches + historical P02/P03 contract). The earlier
  `NOT_RUN` statement applied only to one historical probe build.
- WorkBuddy Desktop UI-only capabilities remain `NOT_RUN`; the Desktop's
  hook engine itself is verified because it runs as the CLI engine
  subprocess inside the Desktop process tree.
```

**建议替换文本 A-18**（替换 §12.4 「WorkBuddy `lite-wb` CLI」整节）：

```markdown
### WorkBuddy Desktop / CLI engine profile

- Only the profile `workbuddy-desktop/5.9.2/cli-engine-2.165.0/pd-0.2.2`
  is verified. `lite-wb` is an engine file name, not a runtime mode.
- Use `UserPromptSubmit` (15 s) as the **sole injection event**. It is the
  only hook that can contribute context to the current turn.
- Use `SessionStart` (30 s) only for health checks and host-profile
  binding verification; it injects at position `first` and MUST NOT be
  used to count sessions or clear a Working Set.
- Use `TaskCreated` / `TaskCompleted` / `SessionEnd` / `PreCompact` /
  `PostCompact` / `SubagentStart` / `SubagentStop` / `Stop` as
  **refresh triggers only** (§5.4 determinism-first rule). `PreToolUse` /
  `PostToolUse` / `PostToolUseFailure` remain evidence channels and MUST
  NOT inject principles (§7.1 single Resolver rule).
- Do not return `continue: false` from `PreToolUse`: it causes the host to
  re-submit the user prompt and re-fire `UserPromptSubmit`.
- **Timeout semantics are two-path, not one**: host-side kill of the hook
  (configured timeout exceeded) or `exit 2` / `deny` / `continue:false`
  yields `allowed:false` and **blocks and clears the user prompt**; PD's
  own self-degradation MUST exit with a non-blocking code and MUST write a
  `degraded` receipt. The adapter MUST resolve its soft deadline from the
  **actually enabled `hooks/hooks.json`**, never from a hard-coded
  constant, and keep it strictly below the resolved hard limit.
- Resolve the installed plugin version from `installed_plugins.json` and
  verify `hooks/hooks.json` of that version. Stale version directories
  must not be discoverable (§8.3.1).
- Injection channel is confirmed as `user_message_system_reminder`. Content
  MUST be self-contained, MUST NOT be written in the voice of a user
  instruction, and MUST NOT assume system/developer priority. The host
  provides **no** `additionalContextLimit`; PD MUST truncate using the
  existing Prompt Capacity Budget and record truncation.
- `async: true` detached hooks are available as the Deferred Refresh
  carrier (§10.4.1), subject to isolated-probe verification.
- Standalone IDE runtime and Desktop UI-only capabilities remain excluded.
```

**建议替换文本 A-19**（在 §12.5 Host Integration Rules 末尾追加）：

```markdown
11. CLI, IDE and Desktop documentation describe different contracts.
    A capability claim MUST name its source document, engine version,
    runtime mode and evidence date. Do not use an IDE-only document to
    deny an engine capability, and do not use engine source to claim an
    IDE runtime is verified.
12. When official documentation, matched-version source and live runtime
    disagree, record all three separately with their evidence grades;
    resolution for the active profile follows the priority in §2.1.
13. `NOT_RUN` from one runtime mode MUST NOT be used to fill a cell of
    another runtime mode, and MUST NOT be silently upgraded to "supported"
    because the same engine binary contains the event name.
```

---

## A-20 / A-21 / A-22 — §13 Host-specific Prompt Injection Contract

- **判定**：**大幅修订**
- **原因**：GAP-04/14。
- **原设计的问题**：channel `Unknown`；「不假设角色优先级」结论正确但缺具体契约；无长度约束。

**建议替换文本 A-20**（替换 §13.2 Channel Matrix）：

```markdown
| Host profile                              | Verified injection channel            | Contract                                                                                                                                                 |
|:------------------------------------------|:--------------------------------------|:---------------------------------------------------------------------------------------------------------------------------------------------------------|
| OpenClaw embedded                         | `system` main body + `user` prefix short directive | Main principles via `prependSystemContext`; short dynamic directives via `prependContext`                                                       |
| Codex headless CLI                        | `developer`                           | Use `additionalContext`; do not claim system priority                                                                                                        |
| **WorkBuddy Desktop / CLI engine 2.165.0**| **`user_message_system_reminder`**    | Use `hookSpecificOutput.additionalContext` on `UserPromptSubmit` only. Host wraps the value as `<system-reminder data-role="hook">` and appends it to the **`user` message before `<user_query>`** (position `last`); `SessionStart` uses position `first`. NOT system, NOT developer. |
| Unverified modes                          | Unknown                               | Model-assisted Live disabled                                                                                                                                  |

`returned` means the adapter produced this payload. `confirmed` still
requires independent request-level evidence; the channel being known does
not by itself prove delivery for a specific turn.
```

**建议替换文本 A-21**（替换 §13.3 Injection Content Rules 列表）：

```markdown
- Preserve Principle Artifact meaning; do not rewrite the principle into
  a new policy.
- Keep dynamic directives short and separately attributable.
- Do not inject model reasoning or free-form selector explanations as
  commands.
- Make content self-contained.
- **WorkBuddy**: injected text lives inside a `user` message next to
  `<user_query>`. It MUST be clearly delimited, MUST NOT be phrased as a
  user instruction or request, and MUST NOT contain executable content or
  prompt-injection-shaped text. Do not assume system/developer precedence.
- **WorkBuddy**: the host does not enforce `additionalContextLimit` or any
  equivalent content limit. The adapter MUST truncate using the existing
  Prompt Capacity Budget, keep complete principle boundaries, and record
  `truncated: true` plus the discarded count in the receipt.
- Respect each host's actual output-size constraints.
- Use existing Renderer and escaping/sanitization rules.
- Do not assume message role or precedence beyond the verified profile.
- **Only `UserPromptSubmit` may inject principles in the WorkBuddy
  profile.** Tool/lifecycle hooks may contribute evidence only; §7.1's
  single-Resolver rule is unchanged.
```

**建议替换文本 A-22**（替换 §13.4 Delivery Status 列表与两段说明）：

```markdown
The adapter must report what it can actually prove:

- `returned`: adapter returned the injection payload to the host
  callback.
- `confirmed`: independent evidence confirms the payload entered the
  current model request.
- `degraded`: **NEW** — the adapter intentionally returned a neutral /
  empty payload because a self-imposed deadline, dependency failure or
  resource limit was hit before a valid contribution could be produced.
  `degraded` is a failure outcome, never `skipped`, never `unknown`, and
  never `returned`.
- `skipped`: deliberately did not contribute content for a policy reason
  (e.g. feature flag off, no eligible principles).
- `timeout`: the adapter/PD deadline was exceeded.
- `failed`: the adapter returned an execution/encoding error.
- `unknown`: available evidence cannot establish the result.

`returned` is not equivalent to `confirmed`.

`degraded` is not equivalent to `skipped`: the former lost a contribution
that should have existed, the latter deliberately contributed nothing.

`confirmed` is not equivalent to the model understanding or following
the principle.
```

---

## A-23 / A-24 / A-25 — §14 Execution and Failure Handling

- **判定**：修订
- **原因**：GAP-01/02/03/09。
- **原设计的问题**：§14.3 把 WorkBuddy 超时写成单一「阻断提交」；§14.5 无 `degraded` / `duplicate registration` / `self-deadline` 行；§14.2 无宿主 async 载体。

**建议替换文本 A-23**（替换 §14.3 表格中 WorkBuddy 行及表后说明）：

```markdown
| Host profile                       | Host timeout | Host behavior on timeout / non-blocking exit | PD consequence | Required policy |
|:-----------------------------------|-------------:|:--------------------------------------------|:---------------|:---------------|
| Codex headless CLI                 | 600 s host default | Hook marked failed; turn continues | PD UPS configured 5 s | Honor 5 s budget; local-only synchronous path |
| **WorkBuddy Desktop / engine 2.165.0** | **host default 60 s; overridden by enabled `hooks.json`: UPS 15 s, others 30 s** | **Host kill / exit 2 / `deny` / `continue:false` → `allowed:false` → submission blocked and prompt cleared.** **exit 1 or other non-zero → non-blocking, turn continues, stderr becomes a user-visible warning.** `PreToolUse` timeout → tool blocked (fail-closed). `SessionStart` timeout → session proceeds. | Enabled `0.2.2` = 15 s; PD wrapper currently hard-codes 12 s self-deadline and **has already degraded in a live session**, losing that turn's injection | Fail fast **with a `degraded` receipt**; resolve the hard deadline from the enabled `hooks/hooks.json` at runtime; keep soft deadline strictly below it; never block the submission |
| OpenClaw embedded                  | 15 s `before_prompt_build` | Fail-open; hook skipped and model request continues | PD internal budget not established | Measure PD path; return well before host deadline; always record delivery outcome |

These are not interchangeable global constants, and failure semantics are
**event-specific**: `UserPromptSubmit`, `PreToolUse`, `SessionStart` and
`PostCompact` do not share one timeout consequence. Do not extrapolate one
event's semantics to another.
```

**建议替换文本 A-24**（在 §14.2 Deferred Refresh 末尾追加）：

```markdown
For the WorkBuddy profile, the verified non-blocking worker is the
host-native detached `async` hook (§10.4.1). It MUST NOT contribute to the
current turn, and its registration MUST be validated against the
profile-bound plugin version (§8.3.1) before use.
```

**建议替换文本 A-25**（在 §14.5 Failure Matrix 追加行）：

```markdown
| PD self-deadline exceeded / degraded     | Return a neutral payload with a non-blocking exit code; **write a `degraded` receipt** including `degradationReason`, `selfDeadlineMs`, `resolvedHostTimeoutMs`, `elapsedMs`; do NOT claim `returned` or `skipped`; keep Model-assisted modes unchanged |
| WorkBuddy exit 1 / non-blocking error    | Turn proceeds; record `delivery=degraded` if PD produced no contribution, otherwise `returned`; never treat host silence as `confirmed` |
| WorkBuddy host kill / exit 2 / deny      | Treat as potential submission loss; fail the profile gate; never reach this state from PD-controlled work |
| Duplicate or stale hook registration     | Neutral return + `injection_skipped` with `fallbackReason:"duplicate_or_stale_hook_registration"` (§8.3.1) |
| `PreToolUse` `continue:false`            | Prohibited in the WorkBuddy adapter; would re-submit the user prompt and duplicate `UserPromptSubmit` |
| Host profile mismatch                    | `profile.status=EXPIRED`; Native only if safe; write receipt; re-run `resolveHostProfile()` |
| Injection content truncated by PD        | Record `truncated:true` + discarded count; still `returned` (not `degraded`) |
```

并在 §14.4 Soft Deadline Resolution 的 Rules 中替换第 1 条并追加：

```markdown
- `hostHookTimeoutMs` MUST be read at runtime from the **enabled plugin's
  `hooks/hooks.json`** for the current event (`timeout` is in seconds).
  Hard-coded host timeout constants are prohibited.
- `softDeadlineMs` MUST be strictly lower than
  `min(hostHookTimeoutMs, pdConfiguredHookBudgetMs)` with a measured
  safety margin derived from PD p95/p99 and worst-case observations.
- A self-degradation MUST complete before `softDeadlineMs` with enough
  time left to write the `degraded` receipt; otherwise the host may kill
  the process and block the submission.
```

---

## A-26 / A-27 / A-28 — §15 Receipt, Observability, Evidence

- **判定**：修订
- **原因**：GAP-02/16。
- **原设计的问题**：`AdaptiveActivationReceipt` 无 `degraded`、无生命周期层；事件集无 `hook_dispatched` / `injection_degraded`；§15.5 WorkBuddy 条仍写「channel unknown」。

**建议替换文本 A-26**（替换 §15.2 receipt 的 `host` / `identity` / `delivery` 三段）：

```typescript
  host: {
    kind: "openclaw" | "codex" | "workbuddy";
    hostVersion: string;
    engineVersion: string;
    engineSha256?: string;
    runtimeMode: string;
    adapterVersion?: string;
    installedPluginVersion?: string;
    enabledPluginRoot?: string;
    profileId: string;
    profileRevision: string;
    profileStatus: "VERIFIED" | "CONDITIONALLY_VERIFIED" | "EXPIRED" | "NOT_RUN";
    sourceEvent: string;
  };

  identity: {
    workspaceHash?: string;
    sessionHash?: string;
    generationId?: string;
    taskId?: string;
    agentId?: string;
    turnId?: string;
  };

  delivery: {
    renderStatus: "rendered" | "skipped" | "failed" | "unknown";
    injectionStatus:
      | "returned"
      | "confirmed"
      | "degraded"          // NEW
      | "skipped"
      | "timeout"
      | "failed"
      | "unknown";
    injectionChannel: "system" | "developer" | "user_prefix"
                    | "user_message_system_reminder" | "unknown";
    injectionPosition?: "first" | "last";
    truncated?: boolean;
    discardedCount?: number;
    elapsedMs?: number;
    selfDeadlineMs?: number;
    resolvedHostTimeoutMs?: number;
    degradationReason?: string;
    timeoutStatus?: string;
    evidenceReference?: string;
  };

  lifecycle: {                    // NEW: four-level distinguishability
    installed: boolean;
    loaded: boolean;
    dispatched: boolean;
    contributed: boolean;
  };
```

**建议替换文本 A-27**（在 §15.3 Required Events 联合类型中追加）：

```typescript
  | "plugin_installed"
  | "plugin_loaded"
  | "hook_dispatched"
  | "hook_config_duplicate_detected"
  | "host_profile_expired"
  | "injection_degraded"
  | "injection_truncated"
  | "host_task_boundary_consumed"
  | "post_compact_revalidated"
```

**建议替换文本 A-28**（替换 §15.5 中 WorkBuddy 条目）：

```markdown
- **WorkBuddy:** the injection channel is `user_message_system_reminder`
  and the injection position is deterministic (`UserPromptSubmit`=`last`,
  `SessionStart`=`first`). Nevertheless `confirmed` still requires
  independent request-level evidence; a channel definition is not proof of
  delivery. Because PD's self-degradation exits non-blockingly while the
  turn continues, absence of a host error MUST NOT be read as successful
  injection. Every degraded hook MUST produce an `injection_degraded`
  event and a `degraded` receipt. The receipt's `lifecycle` block MUST
  distinguish installed / loaded / dispatched / contributed; installer
  writes the first two, the hook entry writes the third, and the encoder
  writes the fourth.
```

---

## A-29 / A-30 — §17 Performance and Cost Budget

- **判定**：修订
- **原因**：GAP-01/17。生产已降级；SessionStart 整链 16.7 s 未纳入；§17.3 把性能探针列为未来 Phase 2。
- **原设计的问题**：「Before any Model-assisted activation implementation or Live rollout, measure the actual PD path」方向正确，但未把「已经发生的生产降级」作为 P0 前置，也未测 SessionStart 链与 degraded 率。

**建议替换文本 A-29**（在 §17.3 Mandatory PD Hook Performance Probe 开头追加）：

```markdown
**Status correction (2026-11-04):** this probe is no longer a future-only
Phase 2 task for the WorkBuddy profile. A live session already recorded a
12.113 s PD `UserPromptSubmit` self-degradation with zero injection.
Measuring and repairing the synchronous path is a **P0 prerequisite** for
SPEC finalization; Model-assisted Live remains blocked until the degraded
rate is zero under the defined load matrix.

Additional mandatory measurements for the WorkBuddy profile:

- Wrapper self-deadline resolution from the enabled `hooks/hooks.json`
  under 5 s / 15 s / 30 s configured timeouts.
- `degraded` rate under cold start, populated Working Set, maximum
  candidate pool, and concurrent `SessionStart` + `UserPromptSubmit`.
- `SessionStart` hook-chain wall time (observed 16.7 s in the audited
  session, including other plugins) and its effect on PD's soft deadline.
- Receipt-write latency on the degraded path (must fit inside the margin).
- Duplicate-hook-registration scenarios (two plugin versions enabled).
```

**建议替换文本 A-30**（替换 §17.4 中 WorkBuddy 条）：

```markdown
- **WorkBuddy:** the effective hard limit is the `timeout` of the
  **enabled plugin version's `hooks/hooks.json`** (`UserPromptSubmit` 15 s
  in the current 0.2.2 profile), not a repository canonical constant and
  not the host's 60 s default. Host kill blocks the submission; PD
  self-degradation with exit 1 does not, but silently loses the
  contribution. The soft deadline must be resolved at runtime from
  installed configuration and PD p95/p99, with enough residual time to
  write a `degraded` receipt. The `SessionStart` chain (16.7 s observed
  against a 30 s budget) must be included in the per-profile timing
  record.
```

---

## A-31 — §19 Rollout Plan and Gates

- **判定**：修订
- **原因**：GAP-05/11/18。

**建议替换文本**（在 Phase 0 的 Tasks 列表与 Gate 0 中追加，并替换 Phase 0 Status 行）：

```markdown
Status: Host Event Capability Matrix v0.1 is **HISTORICAL / EXPIRED for
the WorkBuddy profile** (engine 2.161.0 → 2.165.0, PD 0.2.0 → 0.2.2).
It has been superseded for WorkBuddy by the 2026-11-04 host audit. This
does not mean all host modes are verified.

Additional Phase 0 tasks:

10. Freeze the WorkBuddy profile five-tuple (appVersion, engineVersion,
    engineSha256, runtimeMode, pdPluginVersion) and its evidence date.
11. Implement `resolveHostProfile()` and make version mismatch set
    `status=EXPIRED` at runtime.
12. Verify only one PD plugin version is discoverable by the host and
    add stale-`hooks.json` cleanup (§8.3.1).
13. Repair the observed PD `UserPromptSubmit` self-degradation and add
    `degraded` receipts before any further gate.
14. Rebuild the isolated probe lab and re-run P1 / P3 / P4 / P6 against
    engine 2.165.0, including the `async` hook and current-turn injection
    shape.

Gate 0 additions:

- The current-version `UserPromptSubmit` path has a zero degraded rate
  under the defined load matrix.
- `degraded` receipts are emitted and observable.
- Only one PD hook configuration is discoverable.
- `async` hook detach behavior is `RUNTIME_VERIFIED` (or async refresh
  remains explicitly OFF).
```

并在 Phase 2 Gate 2 追加一句：

```markdown
Gate 2 additionally requires evidence that the resolved soft deadline is
derived from installed configuration at runtime, not a hard-coded constant.
```

---

## A-32 — §20 Acceptance Criteria

- **判定**：修订（新增验收项，原有一律保留）

**建议替换文本**（按分组追加）：

```markdown
## B. Native Mode (additions)

- [ ] A degraded hook NEVER prevents the user submission from proceeding
      in the WorkBuddy profile.
- [ ] Under the defined load matrix, the WorkBuddy `UserPromptSubmit`
      degraded rate is 0.

## C. Model-assisted Mode (additions)

- [ ] A deterministic host task boundary (`TaskCreated`, `TaskCompleted`,
      `SessionEnd`, `PostCompact`) does NOT invoke `principle_decision`.
- [ ] The WorkBuddy Deferred Refresh carrier is a host-native detached
      `async` hook, verified in an isolated probe, and contributes nothing
      to the current turn.
- [ ] `PreToolUse` never returns `continue:false` in the WorkBuddy adapter.

## D. Working Set (additions)

- [ ] `generationId` / `taskId` / `engineVersion` / `engineSha256` /
      `pdPluginVersion` are bound into the Working Set record.
- [ ] Only one PD `hooks/hooks.json` is discoverable; a duplicate or stale
      registration yields a neutral return plus a receipt.
- [ ] `SessionEnd` is treated as best-effort and TTL remains authoritative.
- [ ] `PostCompact` recomputes the fingerprint without changing selected IDs.

## F. Host Compatibility (replacements / additions)

- [ ] **WorkBuddy Desktop 5.9.2 / CLI engine 2.165.0 / PD 0.2.2 profile is verified** (replaces the `lite-wb CLI` item).
- [ ] Each profile records appVersion, engineVersion, engineSha256,
      runtimeMode and installed plugin version.
- [ ] `resolveHostProfile()` sets `status=EXPIRED` on any version mismatch.
- [ ] WorkBuddy tool and compaction events are recorded as verified
      refresh triggers, not `NOT_RUN` for the current profile.
- [ ] CLI / IDE / Desktop evidence is recorded separately; no
      cross-mode substitution.
- [ ] The WorkBuddy injection channel is recorded as
      `user_message_system_reminder` with position `first`/`last`.

## G. Execution Safety (additions)

- [ ] The WorkBuddy soft deadline is resolved at runtime from the enabled
      plugin's `hooks/hooks.json`; no hard-coded host timeout constant.
- [ ] PD self-degradation writes a `degraded` receipt before returning.
- [ ] Injected content is truncated by PD using the existing Prompt
      Capacity Budget; truncation is recorded.
- [ ] `SessionStart` hook-chain wall time is measured and recorded.

## H. Evidence (additions)

- [ ] `degraded` is a distinct delivery status and is never scored as
      `returned`, `skipped` or `confirmed`.
- [ ] The receipt's `lifecycle` block distinguishes installed / loaded /
      dispatched / contributed.
- [ ] Current-version model-request injection evidence exists from an
      isolated probe (or `confirmed` is never claimed for WorkBuddy).
```

---

## A-33 — §21 Stop Conditions

- **判定**：修订

**建议替换文本**（在编号列表末尾追加，并替换第 12 条）：

```markdown
12. **Any WorkBuddy hook timeout that can block a user submission**
    (replaces the previous generic wording): host-side kill, `exit 2`,
    `deny`, or `continue:false` reaching the host.
15. A PD self-degradation causes a turn to receive no principle
    contribution (i.e. `injection_degraded` is observed in Live).
16. A `degraded` delivery is recorded as `returned`, `skipped`,
    `unknown` or `confirmed`, or no receipt is written for it.
17. More than one PD plugin version / `hooks.json` is discoverable by the
    host, or a duplicate registration produces a second injection.
18. `resolveHostProfile()` reports `EXPIRED` and the adapter does not
    fall back to Native-only.
```

---

## A-34 — §22 Open Questions

- **判定**：修订

**建议替换文本**（在原表后追加「Resolution status」表，不删除原行）：

```markdown
### 22.1 2026-11-04 resolution status

| ID    | Status | Finding |
|:------|:-------|:--------|
| OQ-02 | **Partially closed** | The WorkBuddy hook engine inside Desktop is verified (live dispatches + source). Standalone IDE runtime and Desktop UI-only capabilities remain `NOT_RUN`. The question is re-scoped, not fully closed. |
| OQ-05 | **Partially closed** | `session_id` (all events), `generation_id` (shared within a turn), `cwd`, `taskId`, `agent_id` are verified host payload fields. `workspaceId` and a stable cross-process `conversationId` remain `UNKNOWN`. |
| OQ-06 | **Answer changed for WorkBuddy** | The host provides a native detached `async` hook (SOURCE_CONFIRMED). Runtime verification in an isolated lab is still required before Gate 4. Other hosts remain open. |
| OQ-14 | **Open, tightened** | The adapter can only prove `submitted` today; `confirmed` requires request-level evidence. A `degraded` state is now mandatory so that absence of evidence is not scored as success. |
| OQ-15 | **Closed (channel) / re-scoped (delivery)** | Channel = `user` message `<system-reminder data-role="hook">` before `<user_query>`. What remains open is per-turn `confirmed` evidence for engine 2.165.0. |
| OQ-16 | **Partially closed** | `generation_id` + `taskId` + `call_id` provide correlation; `SessionEnd` is best-effort; `deduplicateHooks` only dedupes identical commands. |

### 22.2 New open questions

| ID    | Question | Required evidence |
|:------|:---------|:------------------|
| OQ-17 | Does `async:true` detached hook behave non-blockingly in engine 2.165.0 under a real session, and is `asyncTimeout` honored? | Isolated probe with mock model |
| OQ-18 | What is the actual PD synchronous path cost distribution that produced the 12.021 s self-degradation? | PD Hook Performance Probe with phase-level timings |
| OQ-19 | Does `PostCompact` reliably dispatch and is `compact_summary` sufficient as a new context fingerprint? | Isolated compaction probe |
| OQ-20 | Can `ConfigChange` be used to detect `hooks.json` / profile drift within a session? | Source + runtime event correlation |
| OQ-21 | Are `TaskCreated` / `TaskCompleted` payloads stable across engine upgrades (camelCase `taskId`)? | Per-version probe |
```

---

## A-35 — §23 Architecture Decision Records

- **判定**：新增 2 条（保留 ADR-001..014 全部结论）

**建议替换文本**（追加在 §23 末尾）：

```markdown
## ADR-015 — Prefer Host-Native Deterministic and Async Capabilities

**Decision: NEW — PROPOSED.**

When a host already provides deterministic lifecycle events
(`TaskCreated`, `TaskCompleted`, `SessionEnd`, `PreCompact`, `PostCompact`)
or a non-blocking execution carrier (WorkBuddy `async: true` detached
hook), PD MUST use them before adding a model call or a new worker
subsystem. A deterministic boundary MUST NOT be re-derived by
`principle_decision`. This does not relax the shared decision core
(ADR-011): adapters still cannot change governance or selection semantics.

Rationale: engine 2.165.0 exposes 29 hook events and a native detach
mechanism; using LLM inference or a bespoke worker to reconstruct signals
the host already emits adds latency, cost and misactivation risk, and
conflicts with §1.2 Non-Goal 12 and §17.5 optimization order.

## ADR-016 — Mode-Scoped Evidence and No Cross-Mode Substitution

**Decision: NEW — PROPOSED.**

Every host capability claim MUST be bound to (a) CLI / IDE / Desktop mode,
(b) official document URL and check date, (c) engine version and binary
hash where available, (d) evidence grade, (e) verification date. Official
CLI, IDE and Desktop documents may contradict each other and matched
source; such contradictions MUST be recorded separately, never resolved by
silently discarding one source. `NOT_RUN` in one mode MUST NOT be used as
evidence for another, and a profile is `EXPIRED` on any version/mode
change until reverified.

Rationale: the 2026-11-04 audit found 12 concrete contradictions between
CLI docs, IDE docs, engine source and live runtime (see Capability Matrix
§6), and a historical probe baseline (2.161.0) that had silently gone
stale after a host auto-upgrade to 2.165.0.
```

---

## A-36 — §24 / §25 一致性维护

- **判定**：修订（机械性同步，不改架构结论）
- **建议**：§24 Change Log 增加一行「v0.4 → Amendment v0.1：WorkBuddy host-native revision」；§25.1 Self-audit 表中 4 行 PASS 需改为「PASS (amended)」并新增 6 行：

```markdown
| WorkBuddy injection channel is known (`user_message_system_reminder`)         | PASS (amended) |
| WorkBuddy tool/compaction events are usable refresh triggers                    | PASS (amended) |
| `degraded` is a distinct, receipted delivery outcome                            | PASS (amended) |
| Host profile binds engine version + hash + installed plugin version             | PASS (amended) |
| Deferred refresh uses a host-native async carrier for WorkBuddy                 | PASS (amended) |
| A zero degraded rate is a SPEC-finalization prerequisite                        | PASS (amended) |
```

并在 §25.2 Evidence Limitations 中删去「WorkBuddy injection role/channel is known」的否定表述，改为「per-turn `confirmed` model-request evidence for engine 2.165.0 is not yet available」。

---

# 3. 新增接口与数据结构汇总

| 名称 | 位置 | 用途 |
|:---|:---|:---|
| `resolveHostProfile()` | 新增运行时函数（Host Adapter） | 从 `install-manifest.json`、`cli/package.json`、`installed_plugins.json`、启用版 `hooks/hooks.json` 解析五元组并与冻结 profile 比对；不匹配即 `EXPIRED` + Native-only + receipt |
| `ResolvedExecutionBudget.resolutionSource` | §14.4 已有接口 | 新增「必须从 installed config 读取」约束 |
| `AdaptiveContextSnapshot` 新字段 | §4.3 | `engineVersion` / `engineSha256` / `runtimeMode` / `pdPluginVersion` / `generationId` / `taskId` / `agentId` / `sessionSource` / `compactSummary` |
| `CanonicalEventType` 新值 | §5.2 | `HOST_TASK_CREATED` / `HOST_TASK_COMPLETED` / `HOST_SESSION_ENDED` / `HOST_POST_COMPACT` |
| `SessionWorkingSet` 新字段 | §8.2 | `generationId` / `taskId` / `sessionSource` / `engineVersion` / `engineSha256` / `pdPluginVersion` / `lastHostEvent` |
| `HostRuntimeCapabilityProfile` 新字段 | §12.2 | `engineVersion` / `engineSha256` / `electronVersion` / `runtimeMode` / `enabledPluginRoot` / `refreshEvents[]` / `identity.generationId` / `identity.taskId` / `timing.hostDefaultTimeoutMs` / `timing.sessionStartChainMeasuredMs` / `failureSemantics` 结构化 / `injection.channel` 新枚举值 / `injection.hostContentLimit` / `injection.injectionPosition` / `asyncCapability` |
| `AdaptiveActivationReceipt` 新字段 | §15.2 | `host.engineVersion` / `engineSha256` / `enabledPluginRoot` / `profileStatus`；`identity.generationId/taskId/agentId`；`delivery.degraded` / `injectionPosition` / `truncated` / `discardedCount` / `selfDeadlineMs` / `resolvedHostTimeoutMs` / `degradationReason`；`lifecycle{installed,loaded,dispatched,contributed}` |
| 新增事件类型 | §15.3 | `plugin_installed` / `plugin_loaded` / `hook_dispatched` / `hook_config_duplicate_detected` / `host_profile_expired` / `injection_degraded` / `injection_truncated` / `host_task_boundary_consumed` / `post_compact_revalidated` |
| `injectionStatus = "degraded"` | §13.4 / §15.2 | 区分「本应有贡献但降级丢失」与「策略性跳过」 |

# 4. 新增测试要求汇总

| # | 测试 | 断言 | 类型 |
|:--|:---|:---|:---|
| T-01 | `resolveHostProfile()` 版本匹配 | 五元组任一不匹配 → `status=EXPIRED` + Native-only + `host_profile_expired` 事件 | 单元 |
| T-02 | hooks.json 动态 deadline | 给定 5/15/30 s 配置，self-deadline 恒 < hard limit 且 receipt 记录实际值 | 属性测试 |
| T-03 | degraded receipt | 注入超时降级 → `injectionStatus="degraded"`、`lifecycle.contributed=false`、`fallbackReason` 存在；**不得**为 `returned`/`skipped`/`unknown` | 集成 |
| T-04 | 非阻断降级 | WorkBuddy exit 1 降级路径不产生 `continue:false` / `deny` / exit 2，宿主提交继续 | 真实引擎探针（隔离 lab） |
| T-05 | 当前回合注入形状 | engine 2.165.0 mock request body 中 `role:"user"` 的 `<system-reminder data-role="hook">` 位于 `<user_query>` 之前 | 真实引擎探针（隔离 lab） |
| T-06 | async detach | `async:true` hook 立即返回 `allowed:true`、不贡献当前回合内容、`asyncTimeout` 生效 | 真实引擎探针（隔离 lab） |
| T-07 | 确定性边界跳过模型 | `TaskCreated` / `TaskCompleted` / `SessionEnd` / `PostCompact` 触发时 `principle_decision` 调用数为 0 | 单元 + 计数断言 |
| T-08 | 重复注册防护 | 两版 hooks.json 同时可发现 → 中性返回 + `injection_skipped`，注入计数为 1 | 集成 |
| T-09 | `continue:false` 禁用 | WorkBuddy adapter 任何路径都不输出 `continue:false`；模拟重投时 `generationId` 去重生效 | 单元 + 探针 |
| T-10 | 注入截断 | 超预算内容按 principle 边界截断，receipt 记 `truncated:true` + 丢弃数 | 单元 |
| T-11 | SessionStart 链耗时 | 记录整链耗时，验证 PD soft deadline 仍有余量 | 真实引擎探针 |
| T-12 | 分模式证据 | CLI/IDE/Desktop 三份 profile 独立，禁止用 IDE 文档的 7 事件否定引擎能力 | 静态契约测试 |
| T-13 | 生命周期四层 | installer 写 `installed/loaded`、hook 入口写 `dispatched`、encoder 写 `contributed` | 集成 |
| T-14 | 引擎基线守卫 | 探针脚本断言 `node <engine> --version` 与 `sha256sum <engine>` 等于 profile 基线，否则 SKIP（不得 faked green） | 探针前置守卫 |

# 5. 明确保留、不需要修改的设计

以下内容经本轮调查确认**仍然成立，不得因宿主适配修订而改动**：

1. **§2.3 / §16 / ADR-001**：Runtime V2 是唯一治理权威；Selector / Host Adapter 不得创建、批准、撤销 Activation，不得绕过 Artifact Validation。
2. **§3.3 / ADR-002 / ADR-005**：Native 与 Model-assisted 双模共存；同步 prompt hook 默认不做外部模型推理。本轮生产降级恰恰再次证明该决定必要。
3. **§5.3**：`SessionStart` 不是通用会话边界，不得用于计数 / 判定新建 / 清空 Working Set。当前源码证实 `resume` / `clear` 会重复派发，结论正确。
4. **§5.9**：禁止把关键词 / regex / 固定任务映射当作主语义选择器。即使引入宿主确定性事件，也只作为**技术边界检测**，不作为抽象原则选择器。
5. **§6**：`principle_decision` + `principle_selector` 两阶段、多标签选择、`NONE_APPLICABLE` 有效、Candidate 校验与 allowlist。
6. **§7**：只有一个 Working Set Resolver 产出最终集合；Hook 执行预算与 Prompt Capacity Budget 是两个独立预算；`fair_rotation_v1` 不跨宿主外推；不伪造 turn ordinal。
7. **§13.1 / ADR-011**：一个共享决策核心 + 宿主适配契约。**本修正案是填实 WorkBuddy 契约，不是把它拆成独立选择系统**。
8. **§15.4 / ADR-013**：`returned ≠ confirmed ≠ behavioral effect`；不得从 `returned`、无异常、fail-open 推断 `confirmed`。本次 `degraded` 的引入是加强而非削弱该纪律。
9. **§11 / §0 Status / ADR-010**：所有 feature flag 默认 OFF、Shadow 不自动升 Live、Live 需 Owner 逐 profile 授权。新增的 async refresh / 确定性边界开关同样默认 OFF；唯一例外是纯观测性的 `degraded` receipt。
10. **§1.2 Non-Goals**：不新建 Prompt Injection / Governance Activation / Model Runtime / Evidence 平台；不启用未验证的 Desktop/TUI/IDE 模式；不绕过 Working Set Selector v0.2 的 Hold gates。
11. **§12.5 原有 10 条规则**：尤其「只用宿主真实事件」「不伪造 ID」「不同 runtime mode 的 evidence 不互相填充」全部保留，新增 11–13 条是对它们的加强。
12. **§18 评测框架**：E1–E5、数据集、指标与 Shadow 阈值与本轮宿主事实无关，保留。

---

# 6. 定稿检查清单

- [ ] A-01…A-36 全部经 Owner 审阅并决定接受 / 修改 / 拒绝。
- [ ] 以 5.9.2 / 2.165.0 / 0.2.2 重新冻结 WorkBuddy profile（含 engine SHA-256）。
- [ ] P0 Gap-01/02/03 修复完成并有回归测试（T-02/T-03/T-04）。
- [ ] 隔离 lab 重建，P1/P3/P4/P6 探针在当前引擎版本上执行并归档（T-05/T-06/T-11/T-14）。
- [ ] `PD Host Event Capability Matrix v0.1` 的原始证据路径补齐，或明确标注为 HISTORICAL / 不可复核。
- [ ] §25.1 Self-audit 表按 A-36 同步更新，避免「PASS」与修订后的正文矛盾。
- [ ] 保持 v0.4 原文不变；本修正案作为独立文件进入 PR 评审。

---

**END OF PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.1.md**
