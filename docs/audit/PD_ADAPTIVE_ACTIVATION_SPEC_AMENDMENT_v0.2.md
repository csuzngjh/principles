# PD Adaptive Activation SPEC — WorkBuddy Amendment v0.2

> **PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.2.md**
> 对 `docs/specs/PD Adaptive Activation SPEC v0.4.md` 的正式修订提案（可直接合并为 SPEC v0.5）
>
> | 项 | 值 |
> |:---|:---|
> | 版本 | v0.2（取代 Amendment v0.1） |
> | 日期 | 2026-11-04 |
> | 状态 | `READY_FOR_OWNER_REVIEW` — 提案，**非已实现、非已验证** |
> | 宿主基线 | WorkBuddy Desktop `5.9.2` / 引擎 `@genie/agent-cli 2.165.0`（SHA-256 `6fbfd77bae7e7688abf7dfd2488b50c79390c966a9132e73ebe7a5a2d7df99cf`）/ Electron `37.10.3-43` / PD 插件 `0.2.2` |
> | 上游材料 | `PD_WORKBUDDY_HOST_AUDIT_v0.1.md`、`PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md`、`PD_WORKBUDDY_INTEGRATION_GAP_AUDIT_v0.1.md`、`PD_WORKBUDDY_EVIDENCE_MANIFEST_v0.1.md`、`PD_WORKBUDDY_AMENDMENT_ADVERSARIAL_REVIEW_v0.1.md` |
> | 约束 | **不修改 SPEC v0.4 原文**；本文件为独立修正案，经 Owner 审阅后由独立 PR 合并为 v0.5 |
> | 本轮纪律 | 只读源码取证；未修改生产代码 / 宿主配置 / 生产数据库 / 用户会话；未启用 async hook；未创建 PR |

## 0. 使用说明与状态阶梯

### 0.1 替换单元

以「章节内需替换的段落 / 表格 / 接口定义」为单位。每个替换文本均为**完整可粘贴**的正式 Markdown / TypeScript / YAML；未列出的段落保持 v0.4 原文不变。A-ID 为修正案条目编号，仅供评审与追溯，不进入 SPEC 正文。

### 0.2 强制状态阶梯

本修正案所有条款、验收项与 Self-audit 必须使用以下互斥状态，**禁止混用，禁止把提案标为 `PASS`**：

```
PROPOSED → SPEC_REVISED → IMPLEMENTED → TESTED → RUNTIME_VERIFIED → ACCEPTED
DEFERRED_PENDING_EVIDENCE （旁路状态：能力保持 OFF，等待隔离探针）
```

| 状态 | 含义 |
|:---|:---|
| `PROPOSED` | 仅在 Amendment 中提出，未进 SPEC |
| `SPEC_REVISED` | 已进入 SPEC v0.5 文本，无实现 |
| `IMPLEMENTED` | 代码存在，未测试 |
| `TESTED` | 有自动化断言，未在当前宿主运行验证 |
| `RUNTIME_VERIFIED` | 当前安装版本的真实运行证据 |
| `ACCEPTED` | Owner 明确批准 |
| `DEFERRED_PENDING_EVIDENCE` | 能力保持 OFF；所需证据未取得 |

### 0.3 证据等级纪律

`OFFICIAL_DOC` / `SOURCE_CONFIRMED` / `RUNTIME_VERIFIED` / `STATIC_CONFIG` / `HISTORICAL_PROBE` / `INFERRED` / `NOT_RUN` / `UNKNOWN` / `NOT_FOUND`。

- `SOURCE_CONFIRMED` **不得**升格为 `RUNTIME_VERIFIED`；`NOT_RUN` **不得**升格为 `Supported`。
- 官方文档、匹配版本源码、真实运行三者冲突时**分别登记**，按 §2.1 优先级为当前 profile 取值。
- `PROBE_PENDING`：源码确认存在但运行时零样本的状态；在 profile 中与 `NOT_RUN` 分开记录，**不得作为启用依据**。

### 0.4 v0.1 → v0.2 方向性变更（评审要点）

1. **删除** v0.1 的 `determinism-first rule`（把 `TaskCreated` 当确定性 `NEW_TASK` 并跳过 `principle_decision`）——`TaskCreated` 实为 Agent 内部 todo 工具通知。
2. **删除** 「async hook cannot outlive the session」——无源码证据且与源码行为相反。
3. **Deferred Refresh 载体**从宿主 `async:true` hook 改回 **PD 既有 detached worker**（`pd workbuddy worker` + Runtime V2 task lease），host async 保持 OFF。
4. **交付证据**从单维 `injectionStatus` 改为三维状态机 + 六阶段独立观察 + 封闭世界默认。
5. **配置残留**从「生产重复注入风险」降级为「物理残留 ≠ 可发现性」，绝对路径移出长期 Receipt。
6. **性能**从「degraded=0 即放行」改为统计上界验收；动态读取 `hooks.json` 明确定性为**正确性修复而非性能优化**。

---

## 1. 修订总表（A-01 … A-48）

| A-ID | 主题 | v0.2 裁定 | 状态 |
|:---|:---|:---|:---|
| A-01 | Metadata 五元组 + 二轮基线 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-02 | §0.3 宿主发现 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-03 | §3.1 Host async Hook 节点 | **REJECT** → A-38 | — |
| A-04 | 「cannot outlive the session」 | **REJECT** → A-38 | — |
| A-05 | §4.3 Context Snapshot | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-06 | §5.1 映射表 / refresh triggers 分级 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-07 | `HOST_TASK_CREATED/COMPLETED` 确定性边界 | **REJECT** → A-37 | — |
| A-08 | §5.4 determinism-first rule | **REJECT** → A-37 | — |
| A-09 | §5.5 checkpoint | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-10 | §8.2 Working Set 字段 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-11 | §8.3.1 多版本幂等 | **REJECT** → A-42 | — |
| A-12 | §9.3 F3 列表 | ACCEPT_WITH_CHANGE → A-41 | `PROPOSED` |
| A-13 | §10.2 profile YAML | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-14 | §10.4 host async carrier | **REJECT** → A-38 | — |
| A-15 | §11.2 flags | ACCEPT_WITH_CHANGE → A-47 | `PROPOSED` |
| A-16 | §12.2 Profile 接口 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-17 | §12.3 Host Matrix | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-18 | §12.4 WorkBuddy 执行规则 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-19 | §12.5 规则 11–16 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-20 | §13.2 Channel Matrix | **ACCEPT** | `SPEC_REVISED`（依据 `SOURCE_CONFIRMED`） |
| A-21 | §13.3 注入内容规则 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-22 | `injectionStatus.degraded` | **REJECT** → A-39 | — |
| A-23 | §14.3 超时/失败表 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-24 | §14.2 async 载体 | **REJECT** → A-38 | — |
| A-25 | §14.5 Failure Matrix | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-26 | §15.2 receipt（单维 + boolean） | **REJECT** → A-39/A-40/A-42 | — |
| A-27 | §15.3 事件类型 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-28 | §15.5 WorkBuddy 证据 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-29 | §17.3 性能探针 | ACCEPT_WITH_CHANGE → A-43 | `PROPOSED` |
| A-30 | §17.4 WorkBuddy 性能条 | ACCEPT_WITH_CHANGE → A-43 | `PROPOSED` |
| A-31 | §19 Gates | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-32 | §20 验收 | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-33 | §21 Stop Conditions | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-34 | §22 Open Questions | ACCEPT_WITH_CHANGE | `PROPOSED` |
| A-35 | ADR-015/016 | **REJECT** → A-45 | — |
| A-36 | `PASS (amended)` Self-audit | **REJECT** → A-44 | — |
| **A-37** | Task/Subagent 语义分类 + `HOST_TASK_GRAPH_CHANGED` + no-semantic-bypass | **NEW / ACCEPT** | `PROPOSED` |
| **A-38** | Deferred Refresh 载体 + outlive-session 契约 | **NEW / ACCEPT** | `PROPOSED`（能力 `DEFERRED_PENDING_EVIDENCE`） |
| **A-39** | Delivery Integrity 三维状态机 | **NEW / ACCEPT** | `PROPOSED` |
| **A-40** | Lifecycle Stage Observations | **NEW / ACCEPT** | `PROPOSED` |
| **A-41** | Compaction 契约 | **NEW / ACCEPT** | `PROPOSED` |
| **A-42** | Plugin Identity 指纹 + 四层 discoverability | **NEW / ACCEPT** | `PROPOSED` |
| **A-43** | 七维耗时分离 + 统计性能验收 | **NEW / ACCEPT** | `PROPOSED` |
| **A-44** | 状态阶梯 Self-audit | **NEW / ACCEPT** | `PROPOSED` |
| **A-45** | ADR-015′/016′/017 | **NEW / ACCEPT** | `PROPOSED` |
| **A-46** | §2.1 证据等级纪律 + `PROBE_PENDING` | **NEW / ACCEPT** | `PROPOSED` |
| **A-47** | §11/§19 Flag 与 Gate 一致性 | **NEW / ACCEPT** | `PROPOSED` |
| **A-48** | 保持 OFF / 等待探针能力登记 | **NEW / DEFERRED_PENDING_EVIDENCE** | `DEFERRED_PENDING_EVIDENCE` |

---

# 2. 正式替换文本（按 SPEC 章节组织）

## 2.1 Metadata 表 — A-01

**替换** Metadata 表中 `Host evidence baseline` 至 `Verified runtime scope` 四行：

```markdown
| Host evidence baseline        | `PD Host Event Capability Matrix v0.1 — Live Runtime Verification` (HISTORICAL, 2026-10-12, engine 2.161.0 / Desktop 5.8.1 / PD 0.2.0 — **EXPIRED for the current profile**); superseded for WorkBuddy by `PD_WORKBUDDY_HOST_AUDIT_v0.1.md` + `PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md` (2026-11-04) |
| Host probe baseline commit    | `5c3371c3935192081585d741f50a899bc4445b0e` (HISTORICAL)                                                                        |
| Host probe observed HEAD      | `2f2bdf101955a807b8c041fca5a162174b9b494e` (HISTORICAL)                                                                        |
| WorkBuddy profile baseline    | appVersion `5.9.2`; engine `@genie/agent-cli 2.165.0`; Electron `37.10.3-43`; engine SHA-256 `6fbfd77bae7e7688abf7dfd2488b50c79390c966a9132e73ebe7a5a2d7df99cf`; PD plugin `0.2.2`; enabled `hooks/hooks.json` SHA-256 `556d546aacf0bd66c10360e5823ce39e7f979cd36970766908af78ba66a21a85`; `UserPromptSubmit` 15 s / others 30 s; verifiedAt `2026-11-04`; status `CONDITIONALLY_VERIFIED` |
| Amendment review baseline     | `PD_WORKBUDDY_AMENDMENT_ADVERSARIAL_REVIEW_v0.1.md` (2026-11-04); this Amendment v0.2 status `READY_FOR_OWNER_REVIEW`; all proposals are `PROPOSED`, unverified capabilities are `DEFERRED_PENDING_EVIDENCE` |
| Verified runtime scope        | OpenClaw embedded; OpenClaw Gateway `sessions.reset`; Codex headless CLI; **WorkBuddy Desktop 5.9.2 hosting the CLI engine subprocess** (Desktop UI-only capabilities and standalone-IDE modes remain `NOT_RUN`) |
```

## 2.2 §0.3 Evidence-Driven Host Findings — A-02

**替换** §0.3 中 WorkBuddy 相关 bullet 与「The evidence also confirms」列表中的 WorkBuddy 条目：

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
  system-level instruction priority. Per-turn `confirmed` evidence for
  engine 2.165.0 is still `NOT_RUN`.
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
- The historical "canonical 15 s vs installed 0.2.0 cache 30 s" divergence
  is resolved for the active profile: the enabled `0.2.2` `hooks.json` is
  byte-identical to the repository canonical copy (SHA-256 `556d546a…`).
  Stale `0.1.0` / `0.2.0` directories remain on disk, but host loading
  resolves a **single installPath** from `installed_plugins.json`; physical
  residue is NOT evidence of duplicate registration. The only confirmed
  concatenation risk is two hook-config sources **inside the same plugin
  root** (manifest `hooks` field plus the default `hooks/hooks.json`).
- `TaskCreated` / `TaskCompleted` are **notifications of Agent-internal
  todo/plan items** produced by `TaskCreateTool` / `TaskUpdateTool`. Their
  payload contains only session-level identity plus `task_id` /
  `task_subject` / optional plan fields — no user prompt, no
  `generation_id`, no turn identifier, and no parent-task hierarchy. They
  MUST NOT be mapped to a user task boundary (see §5.1 / §5.4).
- Classic `PreCompact` hooks **cannot prevent compaction**: `allowed:false`,
  `continue:false` and exit code 2 only suppress the hook's stdout being
  adopted as additional compaction instructions. `PostCompact` is
  observational and its return value is discarded. `compact_summary` is a
  lossy summary, not the full pre-compaction context.
- `async: true` hooks exist in engine source, but there is **no evidence**
  that a detached hook cannot outlive its originating session; the host
  only kills registered hook pids in the `process.exit` wrapper. The host
  does not validate or wait for a detached worker's result commit. Host
  async refresh remains OFF pending an isolated probe.
- **A real silent delivery failure has been observed**: in the 2026-11-04
  live session the PD `UserPromptSubmit` hook exited `code=1` at 12.113 s
  with `status=degraded reason=workbuddy_wrapper:entry_deadline_exceeded`,
  and the session contains **zero** `runtime_v2_prompt_activations_injected`
  records. The submission was not blocked, but the principle contribution
  for that turn was lost. The 12.021 s figure is the wrapper's
  self-deadline **budget setting**, not an attribution to any synchronous
  stage; no phase-level timing data exists.
- Probe callback latency is not PD plugin latency. The actual PD DB,
  selection, rendering, and adapter path has not yet been measured — and
  the observed production degradation makes that measurement a P0
  prerequisite rather than a later Phase 2 task.
```

## 2.3 §2.1 Evidence Labels — A-46

**追加**到 §2.1 证据标签表之后：

```markdown
### 2.1.1 Evidence Grade and Status Discipline (NEW)

The evidence labels above describe **how** a fact is known. Implementation
state is described separately by the status ladder in §0.2 of the
Amendment. These two dimensions MUST NOT be conflated:

- `SOURCE_CONFIRMED` (matched-version host source) is NOT
  `RUNTIME_VERIFIED` (live execution on the current install).
- `NOT_RUN` is neither support nor failure.
- `PROBE_PENDING` denotes an event whose dispatch point is
  `SOURCE_CONFIRMED` but for which the current session produced **zero live
  samples**. It MUST NOT be used as an enablement basis; such events remain
  OFF until a `RUNTIME_VERIFIED` probe exists.
- `OFFICIAL_DOC` claims apply only to the runtime mode named by that
  document. CLI, IDE and Desktop documents may contradict one another and
  the matched source; all three MUST be recorded separately.

When official documentation, matched-version source and live runtime
disagree, resolution for the active profile follows the priority in §2.1,
but the disagreement itself MUST remain in the Evidence Manifest.

Known CLI-document / source contradiction (2026-11-04): the CLI Hooks
reference states that a `PreCompact` exit code 2 can prevent compaction;
engine `2.165.0` `executeClassicPreCompactHooks` does not act on
`allowed:false` at all. The source behavior governs the current profile;
the document claim is retained as an `OFFICIAL_DOC` discrepancy.
```

## 2.4 §3 Core Architecture — A-38（取代 A-03 / A-04）

**替换** §3.1 mermaid 图中 `D -. deferred refresh .-> H --> I --> J --> R` 一行及其后说明段：

```markdown
    D -. bounded refresh request .-> W[PD existing detached worker (OFF)]
    W -. result, next prompt only .-> R
```

```markdown
The model path is a deferred refresh path. It is not a synchronous
dependency of `BEFORE_MODEL_TURN`.

PD already ships a detached background worker (`pd workbuddy worker`,
scheduled by PD Companion) with a durable Runtime V2 task lease
(`lease_owner` / `lease_expires_at` / `status`) and a recovery sweep. That
worker is the **candidate carrier** for Deferred Refresh. Its Deferred
Refresh contract — context fingerprint, Working Set revision, stale-result
discard, and "result affects only a later prompt boundary" — is not yet
implemented, so all Model-assisted modes remain OFF.

A host-native `async: true` hook exists in WorkBuddy engine 2.165.0 source
but is `PROBE_PENDING` and MUST NOT be treated as the carrier. It is not an
injection channel under any circumstances.
```

**在 §3.3 Model-assisted Mode 代码块 `No background result may mutate a prompt already submitted to the host.` 之后追加**：

```markdown
For WorkBuddy, "Deferred Refresh Eligibility" requires all of the
following, each independently verified before Shadow or Live may be
enabled:

1. The carrier is a detached worker that does not block the synchronous
   prompt hook.
2. A detached worker **may continue executing after the originating
   session has ended**. No host guarantee of session-bound cleanup may be
   assumed. The only host-side cleanup found is `killAllHooksSync()` in the
   `process.exit` wrapper, which does not cover natural event-loop drain,
   crashes, or OS-level termination.
3. Worker results are bound to `sessionId`, `generationId` when the source
   event supplies one, `hostTaskId` when it supplies one,
   `workingSetRevision`, `hostProfileId`, and `contextFingerprint`.
   Missing fields MUST remain missing; adapters MUST NOT fabricate them.
4. Results from a closed or different session MUST NOT contaminate a new
   session. Isolation is enforced by session-scoped keys, the durable task
   lease, a Working Set revision fence, idempotency keys, and stale-result
   discard.
5. `asyncTimeout` bounds the child process lifetime only. It neither
   validates nor waits for the worker's result commit and MUST NOT be used
   as a substitute for a durable journal entry plus a revision check.
6. Every deferred result is applied only at a later verified
   `BEFORE_MODEL_TURN`; it can never retroactively change the current turn.

Host-native async refresh and Model-assisted Shadow/Live remain
`DEFERRED_PENDING_EVIDENCE` until an isolated probe demonstrates items 1–6.
```

## 2.5 §4.3 Read-only Context Snapshot Contract — A-05

**替换** §4.3 的 TypeScript 接口：

```typescript
interface AdaptiveContextSnapshot {
  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;
  engineVersion: string;          // e.g. "@genie/agent-cli 2.165.0"
  engineSha256?: string;
  runtimeMode: string;            // e.g. "desktop_cli_engine"
  hostProfileId: string;
  hostProfileRevision: string;
  profileStatus: "VERIFIED" | "CONDITIONALLY_VERIFIED" | "EXPIRED" | "NOT_RUN";
  pdPluginVersion?: string;
  configSha256?: string;          // hash of the enabled hooks.json content

  workspaceId: string;
  sessionId: string;
  generationId?: string;         // present on UPS/Stop; ABSENT on Task/Compaction events
  hostTaskId?: string;           // sourced from snake_case `task_id`; Agent-internal plan item
  agentId?: string;              // SubagentStart/Stop session storeId
  sessionSource?: "startup" | "resume" | "clear" | "unknown";  // NO "compact"
  compactSummaryEvidence?: string; // metadata only; NOT a semantic input

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

**替换** §4.3 Rules 列表末尾（在 `Missing reliable workspaceId or sessionId …` 之后）：

```markdown
- `generationId`, `hostTaskId`, `agentId`, `sessionSource` and
  `compactSummaryEvidence` MUST come only from verified host payload
  fields. Missing values remain missing; adapters MUST NOT derive them
  from message IDs, trace IDs, transcript parsing, or fabricated ordinals.
  In particular `generation_id` is absent from `TaskCreated`,
  `TaskCompleted` and `PostCompact` payloads.
- `compactSummaryEvidence` is a lossy compression summary recorded for
  provenance only. It MUST NOT be used to compute `contextFingerprint`, to
  select principles, or to represent the full pre-compaction context.
- `hostTaskId` identifies an Agent-internal todo/plan item, not a user
  task. It MUST NOT be interpreted as a user task boundary.
- A change in `engineVersion`, `engineSha256`, `runtimeMode`,
  `pdPluginVersion`, `configSha256` or `hostProfileRevision` invalidates
  the profile-bound Working Set until `resolveHostProfile()` re-verifies it.
```

## 2.6 §5.1 / §5.2 Host Event Semantics — A-06 + A-37

**替换** §5.1 表格中 WorkBuddy 两行及其后「A mapping is permitted…」段落：

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

For the current WorkBuddy profile, host events are classified as follows:

| Class | Events | Evidence grade | Activation |
|:------|:-------|:---------------|:-----------|
| Injection | `UserPromptSubmit` | `RUNTIME_VERIFIED` (1 live dispatch) | Enabled for Native |
| Evidence channels | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `RUNTIME_VERIFIED` (164/162/0 live dispatches) | Enabled; no principle injection |
| Session init | `SessionStart` | `RUNTIME_VERIFIED` (1 live dispatch) | Enabled; health/profile check only |
| `PROBE_PENDING` lifecycle | `SessionEnd`, `Stop`, `PreCompact`, `PostCompact`, `TaskCreated`, `TaskCompleted`, `SubagentStart`, `SubagentStop` | `SOURCE_CONFIRMED` dispatch points, **zero live samples** | **OFF** until a `RUNTIME_VERIFIED` isolated probe |

`PROBE_PENDING` is not `Supported`. Source-level presence of an event name
is not evidence of its dispatch, its payload shape, its timing, or its
semantic suitability. No `PROBE_PENDING` event may be used as a selection
trigger, a session counter, or a task boundary until verified.
```

**替换** §5.2 的 `CanonicalEventType` 定义（A-37）：

```typescript
type CanonicalEventType =
  | "BEFORE_MODEL_TURN"
  | "WORKSPACE_FOCUS_REVISION_CHANGED"
  | "SESSION_CONTEXT_RESTORED"
  | "SESSION_RESET_CONFIRMED"
  | "PERIODIC_CHECKPOINT"
  | "HOST_TASK_GRAPH_CHANGED"       // Agent-internal plan graph; weak signal
  | "HOST_SUBAGENT_SCOPE_CHANGED"   // subagent session scope; weak signal
  | "HOST_SESSION_ENDED"            // best-effort lifecycle end
  | "HOST_POST_COMPACT";            // invalidation / revalidation signal
```

**在 §5.2 `CanonicalHostEvent` 接口中增补**：

```typescript
  engineVersion?: string;
  engineSha256?: string;
  configSha256?: string;
  generationId?: string;     // absent on Task/Compaction events
  hostTaskId?: string;       // from snake_case `task_id`
  agentId?: string;
  sessionSource?: "startup" | "resume" | "clear" | "unknown";
  semanticAuthority: false;  // host events NEVER produce a TaskChangeType decision
```

**新增 §5.2.1（A-37）**：

```markdown
### 5.2.1 Host Event Semantic Classification (NEW)

Engine 2.165.0 `TaskCreated` / `TaskCompleted` are best-effort notifications
emitted by the internal `TaskCreateTool` / `TaskUpdateTool` when an
Agent-internal todo/plan item is created or marked `completed`. Their
payload contains session-level identity and snake_case `task_id` /
`task_subject` / optional plan fields. There is no user prompt, no
`generation_id`, no turn identifier, no `parentTaskId`, and no way to
reverse-resolve the originating user request. `task_id` is a session-
partitioned auto-increment ordinal. One user request may produce 0, 1 or N
such events. `SubagentStart` / `SubagentStop` belong to a separate session-
lineage chain and share no payload fields with Task events.

Four boundary classes MUST remain distinct:

1. **User task boundary** — only a verified prompt event carrying `prompt`
   and turn identity can indicate a new user request. No WorkBuddy host
   event currently provides a deterministic user task boundary. Semantic
   classification remains the responsibility of `principle_decision`.
2. **Agent-internal task boundary** — `TaskCreated` / `TaskCompleted` =
   `HOST_TASK_GRAPH_CHANGED`, a weak signal only.
3. **Subagent boundary** — `SubagentStart` / `SubagentStop` =
   `HOST_SUBAGENT_SCOPE_CHANGED`, a scope hint only.
4. **Ordinary tool phase** — `Pre/PostToolUse` = evidence channels only.

**No-semantic-bypass rule (hard constraint).** A host event MUST NOT:

- produce a `TaskChangeType` decision (`NEW_TASK`, `GOAL_SHIFT`,
  `PHASE_SHIFT`, `UNCERTAIN`, `SAME_TASK`);
- cause `principle_decision` to be skipped;
- select, replace, activate or deactivate any principle;
- serve as a session/turn counter, a user-identity source, or a billing
  boundary.

`HOST_TASK_GRAPH_CHANGED` may only (a) correlate and deduplicate on
`(session_id, task_id)`, (b) record provenance, and (c) mark a Working Set
as `revalidationRequired`. `teammate_name` / `team_name` are optional
agent/team labels and MUST NOT be read as user attribution.
```

## 2.7 §5.4 Trigger Conditions — A-37（取代 A-08）

**替换** §5.4 整个表格与其后一句：

```markdown
| Trigger                        | Description                                                            | Action                                                                                                     |
|:-------------------------------|:-----------------------------------------------------------------------|:-----------------------------------------------------------------------------------------------------------|
| `INITIAL_SESSION`              | No valid Working Set exists when a verified prompt event arrives       | Native immediately; enqueue deferred initialization only if a safe worker exists                           |
| `HOST_TASK_GRAPH_CHANGED`      | Agent-internal plan item created/completed (`task_id`, snake_case)    | Record provenance; mark `revalidationRequired`; **no Decision Model call, no selection**                |
| `HOST_SUBAGENT_SCOPE_CHANGED`  | Subagent session started/stopped                                       | Record scope hint; **no selection**                                                                        |
| `HOST_SESSION_ENDED`           | `SessionEnd` (best-effort, not guaranteed)                              | Best-effort cleanup; idle TTL remains authoritative                                                        |
| `HOST_POST_COMPACT`            | `PostCompact` (`compact_summary` is lossy metadata only)               | Invalidate cached fingerprint; set `revalidationRequired`; **no injection, no blocking, no selection**  |
| `HOST_TASK_BOUNDARY`           | A verified host boundary that is proven to carry user-task semantics   | Enqueue deferred Decision Model. **No WorkBuddy event currently qualifies.**                            |
| `FOCUS_REVISION_CHANGED`       | Workspace Focus revision changes                                       | Enqueue Decision Model                                                                                     |
| `CONTEXT_FINGERPRINT_CHANGED`  | Local context fingerprint changes materially                          | Consider bounded refresh                                                                                   |
| `PERIODIC_CHECKPOINT`          | A safe per-session checkpoint is reached                               | Enqueue Decision Model under the throttling rules in §5.5                                                  |
| `COMPACTION_RESUME`            | A verified compaction/resume signal is available                      | Revalidate cached state; do not assume all hosts support it                                                |
| `WORKING_SET_EXPIRED`          | Working Set TTL or validity has expired                               | Native immediately; deferred refresh if safe                                                             |
| `ACTIVATION_REVISION_CHANGED`  | Relevant activation state changes                                     | Revalidate selected IDs before delivery                                                                  |

A trigger can request a refresh; it cannot itself authorize a principle.
A host event can supply technical timing or provenance; it can never
supply semantic task classification.

**Removed rule (Amendment v0.1).** The "determinism-first rule" that mapped
`TaskCreated` to a deterministic `NEW_TASK` and skipped `principle_decision`
is withdrawn. It was based on a false premise about host event semantics
and would cause re-selection on every Agent plan-item creation.

`principle_decision` remains the sole classifier for `GOAL_SHIFT`,
`PHASE_SHIFT`, `UNCERTAIN`, `SAME_TASK`, and for any user-task change that
no host event can express deterministically. §17.5 optimization order item
1 ("Avoid unnecessary Decision calls") is satisfied by **throttling and
deduplication**, not by replacing semantic judgment with a host signal.
```

## 2.8 §5.5 Incremental Checkpoint — A-09

**在 §5.5 的 Per-message behavior 列表末尾追加**：

```markdown
- `maxUserTurnsWithoutReview` remains the **primary** review rhythm for
  user turns. `HOST_TASK_GRAPH_CHANGED`, `HOST_SUBAGENT_SCOPE_CHANGED` and
  `HOST_POST_COMPACT` are not user turns and MUST NOT increment any turn
  counter; they only set `revalidationRequired` flags.
- `SessionStart` with `source: "resume"` and `source: "clear"` may dispatch
  repeatedly and MUST NOT be counted as a new user turn.
- A `PreToolUse` hook that returns `continue: false` causes the host to
  re-submit the user prompt, which fires `UserPromptSubmit` again in the
  same turn. The WorkBuddy adapter MUST NOT emit `continue: false`.
- Every refresh request is idempotent on the tuple
  `(hostProfileId, sessionId, [generationId], [hostTaskId],
  contextFingerprint, workingSetRevision)`. Bracketed fields are optional:
  when the source event does not supply `generation_id` or `task_id`, the
  key MUST omit them rather than substitute a fabricated value.
- `periodKey` remains derived only from a verified, deduplicated user-turn
  sequence; no host event may create a fabricated host turn ordinal.
```

## 2.9 §8 Working Set Persistence — A-10 + A-42

**在 §8.2 `SessionWorkingSet` 接口内增补字段（A-10）**：

```typescript
  generationId?: string;      // absent on Task/Compaction-sourced refreshes
  hostTaskId?: string;        // Agent-internal plan item; provenance only
  sessionSource?: "startup" | "resume" | "clear" | "unknown";
  engineVersion: string;
  engineSha256?: string;
  configSha256?: string;
  pdPluginVersion?: string;
  lastHostEvent?: CanonicalEventType;
  revalidationRequired: boolean;   // set by HOST_POST_COMPACT / HOST_TASK_GRAPH_CHANGED
  preCompactRevision?: number;     // compaction consistency fence
```

**在 §8.2 Rules 列表追加**：

```markdown
- A change in `engineVersion`, `engineSha256`, `configSha256`,
  `pdPluginVersion`, `runtimeMode`, or `hostProfileRevision` invalidates the
  result until `resolveHostProfile()` re-verifies it (implements §12.1).
- `SessionEnd` is best-effort and MUST NOT be the sole cleanup trigger;
  idle TTL remains authoritative.
- On `HOST_POST_COMPACT`, DO NOT recompute `contextFingerprint` from
  `compact_summary` and DO NOT change `selectedPrincipleIds`. Set
  `revalidationRequired = true` and retain `preCompactRevision`. The next
  verified `BEFORE_MODEL_TURN` recomputes the fingerprint from the actual
  current context and revalidates; on mismatch, fall back to Native.
- `HOST_TASK_GRAPH_CHANGED` may set `revalidationRequired` but MUST NOT
  change `selectedPrincipleIds` or invoke `principle_decision`.
- A revision-fenced result whose `sessionId`, `workingSetRevision`,
  `contextFingerprint` or `hostProfileId` no longer matches the current
  turn MUST be discarded (stale-result discard).
```

**替换** §8.3 末尾的「Hook Configuration Layer」小节（A-42，取代 v0.1 A-11）：

```markdown
### 8.3.1 Hook Configuration Discoverability and Identity (NEW)

Four levels MUST be distinguished; a lower level is not evidence of a
higher one:

1. A plugin version directory **exists physically** on disk.
2. That directory is **discoverable** by the host — i.e. it is the single
   `installPath` resolved from `installed_plugins.json`
   (`resolveInstalledPluginCache`), or an explicit `--plugin-dir`.
3. The host **actually loads** `hooks/hooks.json` from that root
   (`HookExtensionLoader.load` resolves exactly one path).
4. **Two effective hook registrations exist for the same event** — e.g.
   both a manifest `hooks` field and the default `hooks/hooks.json` inside
   the **same** plugin root are concatenated by `mergeHooks`, or multiple
   configuration sources (user settings, plugin, scoped registry) are
   merged by `getHooks`.

Stale plugin version directories that are merely present on disk are NOT
evidence of level 2, 3 or 4. The host reads `.orphaned_at` markers only for
plugin-cache garbage collection (approximately 14 days), not as a hook
loading blacklist. Therefore "old `hooks.json` files remain on disk" MUST
NOT be reported as production duplicate injection.

Required controls:

- At profile resolution, compute `configSha256` over the resolved
  `hooks.json` content and `rootFingerprint` over
  `(marketplaceId, pluginId, pluginVersion, configSha256)`.
- At hook entry, verify `configSha256` and `rootFingerprint` against the
  profile-bound values. On mismatch, return a neutral payload and write a
  journal line with `execution: "degraded"`,
  `degradationReason: "hook_config_mismatch"`.
- Verify that the same event is not registered twice from two config
  sources of one root; if it is, emit
  `hook_config_source_concat_detected` and return neutral.
- `deduplicateHooks` deduplicates identical command strings only; it MUST
  NOT be relied upon for version or source deduplication.

Long-term receipts MUST NOT contain absolute filesystem paths. Use
`HostPluginIdentity` (§12.2). Absolute paths are confined to local
diagnostic material (Evidence Manifest, local logs).
```

## 2.10 §9.3 F3 Host-aware Lifecycle Maintenance — A-41

**替换** §9.3 F3 的「Evaluate only verified events」列表：

```markdown
Evaluate only verified events, and record the exact source event per host
profile together with its evidence grade:

- Prompt build / user prompt submit (`before_prompt_build`,
  `UserPromptSubmit`) — the only user-turn-carrying events.
- Compaction **before** (`PreCompact`, `before_compaction`) and **after**
  (`PostCompact`, `after_compaction`).
- Session resume / clear (`SessionStart.source` = `resume` | `clear`).
- Session end (`SessionEnd`, best-effort).
- Agent-internal plan-item signals (`TaskCreated`, `TaskCompleted`) —
  `HOST_TASK_GRAPH_CHANGED`, provenance only.
- Subagent scope (`SubagentStart`, `SubagentStop`) — scope hints only.
- Workspace Focus update.

For the WorkBuddy profile (engine 2.165.0):

- Classic `PreCompact` hooks **cannot prevent or delay compaction**.
  `allowed:false`, `continue:false` and exit code 2 only suppress adoption
  of the hook's stdout as extra compaction instructions. PD MUST NOT rely
  on PreCompact to block compression and MUST NOT return a blocking result
  from it. PD may perform only a **bounded Working Set checkpoint**: record
  `preCompactRevision`, write one journal line, and return.
- **No LLM inference, no external model call, and no principle selection
  may execute inside a synchronous PreCompact hook.** The compaction path
  awaits this hook; any such work directly inflates compaction latency and
  violates §3.3.
- `PostCompact` is observational: the host discards its return value.
  `compact_summary` is a lossy summary extracted from `<summary>` /
  `<conversation_history_summary>`; it has no length or completeness
  guarantee and may be absent. It MUST NOT be treated as the full context,
  MUST NOT be used as a `contextFingerprint` input, and MUST NOT authorize
  principle selection. `PostCompact` is a **state invalidation and
  revalidation signal** only (§8.2).
- `transcript_path` is unchanged across compaction. PreCompact can read the
  pre-compaction transcript; PostCompact is triggered before an explicit
  history flush, so reading the post-compaction file is NOT guaranteed.
  PD MUST NOT depend on that.
- `PreCompact` has no `hasHooks` gate and swallows exceptions; `PostCompact`
  has a `hasHooks` gate and swallows exceptions. Neither is guaranteed to
  dispatch. PD MUST NOT treat their absence as a confirmed boundary.
- `SessionStart.source` values are `startup` / `resume` / `clear`; a
  `"compact"` value is NOT present in this engine build.

Do not assume each host exposes the same lifecycle, and do not use a
`NOT_RUN` or `PROBE_PENDING` cell from one runtime mode as evidence for
another.
```

## 2.11 §10 Model Runtime Configuration — A-13 + A-38

**在 §10.2 YAML sketch 的 `hostProfiles` 下追加（A-13）**：

```yaml
  hostProfiles:
    requireExactVersionMatch: true
    workbuddy:
      appVersion: "5.9.2"
      engineVersion: "2.165.0"
      engineSha256: "6fbfd77bae7e7688abf7dfd2488b50c79390c966a9132e73ebe7a5a2d7df99cf"
      runtimeMode: "desktop_cli_engine"
      pdPluginVersion: "0.2.2"
      configSha256: "<computed over enabled hooks.json content>"
      rootFingerprint: "<computed identity fingerprint, no absolute path>"
      hookTimeoutsMs:
        UserPromptSubmit: 15000
        default: 30000
      hostDefaultTimeoutMs: 60000
      deferredWorker:
        carrier: "pd_existing_worker"   # pd workbuddy worker + Runtime V2 task lease
        enabled: false                  # OFF; contract not implemented
        cycleIntervalMs: 120000
        leaseTtlMs: 300000
      hostAsyncHook:
        enabled: false                  # OFF / DEFERRED_PENDING_EVIDENCE
        asyncTimeoutMs: 30000           # bounds child lifetime only; NOT result commit
```

**追加说明**：

```markdown
- `hookTimeoutsMs` values are **resolved at runtime from the enabled
  plugin's `hooks/hooks.json`**; the YAML values above are the frozen
  profile baseline used for mismatch detection, not an override authority.
  This dynamic resolution is a **correctness / configuration-drift fix**,
  not a performance optimization.
- `resolveHostProfile()` MUST read `install-manifest.json`,
  `cli/package.json`, `installed_plugins.json` and the enabled
  `hooks/hooks.json`, compute `configSha256` and `rootFingerprint`, compare
  them with the frozen profile, and set `profile.status = EXPIRED` on any
  mismatch. On `EXPIRED`, fall back to Native-only and discard deferred
  results bound to the old profile.
- The host engine contains no `configSha256` / `rootFingerprint`
  mechanism; PD computes both. Absolute plugin paths are never written to
  long-term receipts.
```

**替换 §10.4 Deferred Execution Prerequisite 整节（A-38）**：

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

### 10.4.1 WorkBuddy deferred carrier (REVISED)

PD already ships a detached background worker: PD Companion spawns
`pd workbuddy worker` as a separate process on a 120 s cycle, backed by the
durable Runtime V2 task lease (`lease_owner`, `lease_expires_at`,
`status`) and a recovery sweep. This is the **candidate carrier** for
Deferred Refresh and is preferred over any new worker subsystem.

However, the Deferred Refresh **contract** — context fingerprint binding,
Working Set revision fencing, stale-result discard, and "result affects
only a later prompt boundary" — is not implemented in PD code. Therefore
Shadow and Live remain OFF until the contract is implemented, tested, and
verified in an isolated probe.

### 10.4.2 Detached worker lifetime and result safety (NEW, hard constraints)

1. A detached worker **may continue executing after the originating
   session has ended**. The host provides no session-bound cleanup
   guarantee for detached hooks: `killAllHooksSync()` is reachable only
   from the `process.exit` wrapper, not from `SessionEnd`,
   `process.on("exit")`, or `beforeExit`; natural event-loop drain,
   crashes, and OS-level termination leave no cleanup. PD MUST assume the
   worker outlives the session.
2. The worker MUST NOT inject content into the current user turn and MUST
   NOT modify a prompt already submitted to the host.
3. Every worker result MUST be bound to `sessionId`, `generationId` (when
   the source event supplies one), `hostTaskId` (when supplied),
   `workingSetRevision`, `contextFingerprint` and `hostProfileId`. Missing
   fields remain missing; no fabricated identifiers.
4. A result produced under a closed, different, or `EXPIRED` session/profile
   MUST NOT contaminate a new session. Safety is enforced by
   session-scoped keys, the durable task lease, a Working Set revision
   fence, idempotency keys, and stale-result discard. On any mismatch the
   result is discarded and `worker_result_stale_discarded` is recorded.
5. `asyncTimeout` bounds child process lifetime only. It does **not**
   validate or wait for a result commit, and MUST NOT be used as a
   substitute for a durable journal entry plus a revision check.
6. Deferred results are consumed only at a later verified
   `BEFORE_MODEL_TURN`. The current turn always uses Native or a valid
   cached Working Set.

### 10.4.3 Host-native async hook status (NEW)

WorkBuddy engine 2.165.0 exposes an `async: true` / `asyncTimeout` branch
in source. It is `PROBE_PENDING`: no isolated runtime probe has confirmed
detach behavior, timeout enforcement, or session-exit behavior on the
current build. It is **OFF** and MUST NOT be adopted as the Deferred Refresh
carrier until such a probe is `RUNTIME_VERIFIED` and Owner accepts the
change. Other hosts remain subject to their own worker verification; no
cross-host inference is permitted.
```

## 2.12 §11.2 Default Flags — A-47

**替换** §11.2 表格中 v0.1 追加的 4 行（保留原有全部行与 `OFF` 默认）：

```markdown
| WorkBuddy host-native async refresh            | OFF / `DEFERRED_PENDING_EVIDENCE` — isolated probe required |
| WorkBuddy `PROBE_PENDING` lifecycle triggers  | OFF until a `RUNTIME_VERIFIED` isolated probe per event class |
| PD existing-worker Deferred Refresh contract  | OFF until implemented, tested, and probe-verified |
| Host Profile exact-version enforcement        | OFF until `resolveHostProfile()` is implemented and tested |
| `HOST_TASK_GRAPH_CHANGED` provenance capture  | OFF (weak signal; no semantic authority) |
| Current-version `confirmed` delivery claim    | DISABLED until request-level evidence exists |
```

**追加（A-47）**：

```markdown
### 11.2.1 Mandatory observability (not a feature flag)

The Delivery Integrity journal is **not** a feature flag and is not
optional. It is a mandatory, behavior-neutral evidence mechanism:

- one append-only journal line at hook entry and one at hook termination;
- no synchronous database operation, no schema DDL, no idempotency reads;
- bounded by the receipt latency budget in §17.3;
- failure of the journal write MUST NOT change the injection payload, the
  exit code, or the turn outcome.

Because it adds no selection, activation, injection, or model behavior, it
does not conflict with the "all flags OFF by default" rule in §0 Status.
```

**Gate 一致性表（追加到 §11.2 之后）**：

```markdown
| Capability | Flag default | Enabling gate |
|:-----------|:-------------|:--------------|
| Native injection via `UserPromptSubmit` | Existing production behavior | Profile `CONDITIONALLY_VERIFIED` + degraded receipts observable |
| Degraded observability journal | Mandatory (no flag) | Gate 0 (T-03/T-04) |
| Host Profile exact-version enforcement | OFF | Gate 0 (T-01) |
| `PROBE_PENDING` lifecycle triggers | OFF | Gate 0 (P3/P4 probes) |
| PD worker Deferred Refresh | OFF | Gate 4 (§10.4.1 contract + probe) |
| Host-native async refresh | OFF / `DEFERRED_PENDING_EVIDENCE` | Gate 4 + isolated P6 probe + Owner acceptance |
| Model-assisted Shadow | OFF | Gates 0–4 |
| Model-assisted Live | OFF | Gates 0–5 + explicit Owner authorization |

No gate may be satisfied by a `SOURCE_CONFIRMED` or `OFFICIAL_DOC` claim
alone where the gate requires `RUNTIME_VERIFIED`.
```

## 2.13 §12 Host Runtime Capability Profiles — A-16 / A-17 / A-18 / A-19

**替换 §12.2 `HostRuntimeCapabilityProfile` 接口（A-16）**：

```typescript
type ProfileStatus =
  | "VERIFIED" | "CONDITIONALLY_VERIFIED" | "NOT_RUN" | "EXPIRED";

type EvidenceGrade =
  | "OFFICIAL_DOC" | "SOURCE_CONFIRMED" | "RUNTIME_VERIFIED"
  | "STATIC_CONFIG" | "HISTORICAL_PROBE" | "INFERRED"
  | "PROBE_PENDING" | "NOT_RUN" | "UNKNOWN" | "NOT_FOUND";

/** Long-term identity. NO absolute filesystem paths. */
interface HostPluginIdentity {
  pluginId: string;              // "principles-disciple@principles-disciple-market"
  pluginVersion: string;         // "0.2.2"
  profileId: string;
  configSha256: string;          // hash of resolved hooks.json content
  rootFingerprint: string;       // sha256(marketplaceId|pluginId|version|configSha256)
  discoverability: "registry_resolved" | "plugin_dir" | "unknown";
  effectiveHookRegistrations?: number; // same-event registrations after merge
}

interface HostRuntimeCapabilityProfile {
  profileId: string;
  revision: string;

  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;
  engineVersion: string;
  engineSha256?: string;
  electronVersion?: string;
  runtimeMode: string;           // "desktop_cli_engine"
  pdAdapterVersion?: string;
  plugin: HostPluginIdentity;

  beforeModelTurn: {
    sourceEvent: string;
    verified: boolean;
    evidenceGrade: EvidenceGrade;
    dispatchSamples: number;
  };

  /** Events usable ONLY as refresh/evidence signals; never as semantic authority. */
  refreshEvents: Array<{
    sourceEvent: string;
    evidenceGrade: EvidenceGrade;
    dispatchSamples: number;
    semanticAuthority: false;
    activation: "enabled" | "off" | "deferred_pending_evidence";
    boundaryClass:
      | "user_task" | "agent_internal_plan" | "subagent_scope"
      | "tool_phase" | "session_lifecycle" | "compaction";
  }>;

  identity: {
    workspaceId: "verified" | "partial" | "unavailable";
    sessionId: "verified" | "partial" | "unavailable";
    generationId: "verified" | "partial" | "unavailable";
    hostTaskId: "verified" | "partial" | "unavailable"; // snake_case task_id
    turnId: "verified" | "partial" | "unavailable";
    deduplication: "verified" | "partial" | "unavailable";
    note?: string; // e.g. "generation_id absent on Task/PostCompact payloads"
  };

  /** Seven separate timing dimensions; never collapse into one number. */
  timing: {
    hostDefaultTimeoutMs: number;          // 60000
    hostHookTimeoutMs: number;             // resolved from enabled hooks.json
    wrapperSelfDeadlineMs: number;         // budget setting, not a measurement
    pdSyncPathP95Ms?: number;              // measured, may be unknown
    pdSyncPathP99Ms?: number;
    sessionStartHookSelfMs?: number;       // 15552 observed
    sessionStartChainMs?: number;          // 16736 observed, includes other plugins
    sqliteContention: "measured" | "static_only" | "unknown";
    receiptWriteP99Ms?: number;
    softDeadlineMs?: number;
    resolutionSource: "installed_config" | "source_confirmed" | "measured";
  };

  failureSemantics: {
    onHostKill: "block_submission" | "fail_open" | "block_tool" | "unknown";
    onExit0: string;
    onExit1: string;
    onExit2: string;
    onSelfDegradation: string;
    preCompactCanBlock: false;             // classic hook cannot prevent compaction
    postCompactObservational: true;
  };

  injection: {
    channel: "system" | "developer" | "user_prefix"
           | "user_message_system_reminder" | "unknown";
    confirmedClaimAllowed: boolean;        // false for current WorkBuddy profile
    encodingContract: string;
    hostContentLimit: "enforced" | "absent";
    injectionPosition?: "first" | "last";
  };

  asyncCapability: {
    pdExistingWorker: "implemented" | "contract_missing" | "unavailable";
    hostNativeDetachedHook: "probe_pending" | "runtime_verified" | "unavailable";
    detachedWorkerMayOutliveSession: true;
    contributesToCurrentTurn: false;
    asyncTimeoutValidatesResultCommit: false;
    activation: "off" | "owner_gated";
  };

  verifiedAt: string;
  evidenceReferences: string[];
  status: ProfileStatus;
  implementationStatus:
    | "PROPOSED" | "SPEC_REVISED" | "IMPLEMENTED" | "TESTED"
    | "RUNTIME_VERIFIED" | "ACCEPTED" | "DEFERRED_PENDING_EVIDENCE";
}
```

**替换 §12.3 Verified Host Matrix 中 WorkBuddy 两行（A-17）**：

```markdown
| WorkBuddy Desktop 5.9.2 / CLI engine 2.165.0 / PD 0.2.2 | `UserPromptSubmit` 1/1; `SessionStart` 1/1; `PreToolUse` 164; `PostToolUse` 162 (RUNTIME_VERIFIED). `SessionEnd`/`Stop`/`PreCompact`/`PostCompact`/`TaskCreated`/`TaskCompleted`/`SubagentStart`/`SubagentStop` = `PROBE_PENDING` (SOURCE_CONFIRMED dispatch points, 0 live samples). Concurrent spawn across plugins observed. | Start-to-spawn `timeout=15000ms`; **this session's UPS hook degraded at 12.113 s with exit 1 and produced zero injection records** | Host default 60 s overridden by enabled plugin `hooks/hooks.json`: UPS 15 s, others 30 s. Host kill / exit 2 → `block_submission`; exit 1 → non-blocking turn continues. `SessionStart` self 15.6 s / chain 16.7 s | Enabled `0.2.2` `hooks.json` is byte-identical to canonical (SHA-256 `556d546a…`). Stale `0.1.0`/`0.2.0` directories exist physically but are NOT discoverable: loading resolves a single `installPath`. `mergeHooks` concatenation applies to config sources within one root, not version directories | **`user` message `<system-reminder data-role="hook">` before `<user_query>`**; UPS=`last`, SessionStart=`first`; no host-side content limit; `confirmed` claim not allowed | `CONDITIONALLY_VERIFIED` — degraded delivery must be fixed before Live |
| WorkBuddy standalone IDE runtime | Not run | — | IDE official docs describe 7 events and a different config/exit-2 model; **not runtime evidence for this profile** | Do not assume | Unknown | `NOT_RUN`: no isolated IDE runtime probe |
```

**替换「Evidence interpretation」中 WorkBuddy 三条 bullet**：

```markdown
- The 2026-11-04 live log contains 332 hook spawns; `0` host-side
  timeouts and `0` blocked submissions. PD's own wrapper self-degraded
  once (exit 1, non-blocking) and that turn received no principle
  contribution. A degraded hook is a first-class **execution** outcome,
  never a success.
- WorkBuddy tool events are `RUNTIME_VERIFIED` for the current profile
  (164/162 live dispatches + historical P02/P03 contract). Lifecycle and
  compaction events are `PROBE_PENDING`: their dispatch points are
  `SOURCE_CONFIRMED`, but there are zero live samples and their payload
  semantics must not be assumed. `PROBE_PENDING` is not `Supported`.
- `TaskCreated` / `TaskCompleted` are Agent-internal todo notifications
  with no user-request identity. They are classified as
  `boundaryClass: "agent_internal_plan"` and carry
  `semanticAuthority: false`. WorkBuddy Desktop UI-only capabilities
  remain `NOT_RUN`; the Desktop's hook engine itself is verified because
  it runs as the CLI engine subprocess inside the Desktop process tree.
```

**替换 §12.4 「WorkBuddy `lite-wb` CLI」整节（A-18）**：

```markdown
### WorkBuddy Desktop / CLI engine profile

- Only the profile `workbuddy-desktop/5.9.2/cli-engine-2.165.0/pd-0.2.2`
  is `CONDITIONALLY_VERIFIED`. `lite-wb` is an engine file name, not a
  runtime mode.
- Use `UserPromptSubmit` (15 s) as the **sole injection event**. It is the
  only hook that can contribute context to the current turn.
- Use `SessionStart` (30 s) only for health checks and host-profile
  binding verification; it injects at position `first` and MUST NOT be
  used to count sessions or clear a Working Set.
- `PROBE_PENDING` lifecycle events (`SessionEnd`, `Stop`, `PreCompact`,
  `PostCompact`, `TaskCreated`, `TaskCompleted`, `SubagentStart`,
  `SubagentStop`) are **OFF** until an isolated `RUNTIME_VERIFIED` probe.
  They may never inject, may never select principles, and may never
  produce a `TaskChangeType` decision (§5.2.1). `PreToolUse` /
  `PostToolUse` / `PostToolUseFailure` remain evidence channels (§7.1
  single Resolver rule).
- Do not return `continue: false` from `PreToolUse`: it causes the host to
  re-submit the user prompt and re-fire `UserPromptSubmit`.
- **Timeout semantics are two-path, not one**: host-side kill of the hook
  (configured timeout exceeded) or `exit 2` / `deny` / `continue:false`
  yields `allowed:false` and **blocks and clears the user prompt**; PD's
  own self-degradation MUST exit with a non-blocking code and MUST write a
  degraded journal line. The adapter MUST resolve its soft deadline from
  the **actually enabled `hooks/hooks.json`**, never from a hard-coded
  constant, and keep it strictly below the resolved hard limit. This is a
  correctness fix, not a performance optimization.
- Classic `PreCompact` hooks cannot prevent compaction; `PostCompact` is
  observational; `compact_summary` is lossy metadata. PD performs only a
  bounded checkpoint at PreCompact and a state-invalidation at PostCompact
  (§9.3). No LLM in the synchronous compaction path.
- Injection channel is `user_message_system_reminder`. Content MUST be
  self-contained, MUST NOT be written in the voice of a user instruction,
  and MUST NOT assume system/developer priority. The host provides **no**
  `additionalContextLimit`; PD MUST truncate using the existing Prompt
  Capacity Budget and record truncation in the journal (no synchronous DB).
- Host-native `async: true` hooks are `PROBE_PENDING` / OFF. The Deferred
  Refresh candidate carrier is PD's existing detached worker, whose
  contract is not yet implemented (§10.4).
- `configSha256` + `rootFingerprint` identify the enabled plugin
  configuration. Physical presence of stale version directories is not
  evidence of duplicate registration (§8.3.1).
- Standalone IDE runtime and Desktop UI-only capabilities remain excluded.
```

**替换 §12.5 Host Integration Rules 第 11–13 条并追加 14–16（A-19）**：

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
14. **Source-level presence of an event name is not semantic support.**
    A dispatch point proves only that the host can emit an event; it does
    not prove what the event means. `TaskCreated` / `TaskCompleted` are
    Agent-internal plan-item notifications and MUST NOT be mapped to a
    user task boundary (§5.2.1).
15. Evidence grades and implementation states MUST NOT be upgraded across
    the ladder in §0.2 without the corresponding evidence. `SOURCE_CONFIRMED`
    is not `RUNTIME_VERIFIED`; `PROBE_PENDING` and `NOT_RUN` are not
    `Supported`.
16. A host event MUST NOT bypass PD's semantic judgment. No host event may
    produce a `TaskChangeType` decision, skip `principle_decision`, or
    select / activate / deactivate a principle.
```

## 2.14 §13 Host-specific Prompt Injection — A-20 / A-21 / A-39

**A-20 保留 v0.1 的 §13.2 Channel Matrix 原文（无修改）**，仅在其后追加一句：

```markdown
For the current WorkBuddy profile, `confirmedClaimAllowed` is `false`:
the channel is known, but no request-level evidence for engine 2.165.0
exists. Receipts MUST stop at `returned`.
```

**A-21：在 §13.3 Injection Content Rules 末尾追加**：

```markdown
- **WorkBuddy**: recording truncation MUST be a single append-only journal
  line. It MUST NOT add a synchronous database operation, an idempotency
  read, or a schema operation to the prompt hook.
```

**A-39：替换 §13.4 Delivery Status 整节**：

```markdown
## 13.4 Delivery Integrity

Delivery is described by **three independent dimensions plus evidence**.
No single `injectionStatus` enum may combine execution state with payload
state.

```typescript
type HookExecutionStatus =
  | "completed"   // hook returned normally (exit 0)
  | "degraded"    // hook intentionally returned neutral because of a
                  // self-imposed deadline, dependency failure or resource limit
  | "timeout"     // host or wrapper killed the process
  | "failed";     // execution or encoding error

type PayloadStatus =
  | "none"        // no payload produced (policy or degradation)
  | "prepared"    // renderer produced content, not yet returned
  | "returned"    // adapter wrote payload to stdout, host accepted
  | "confirmed"   // independent request-level evidence of entry into the
                  // current model request
  | "unknown";    // cannot be established (e.g. host kill, missing evidence)

type SelectionStatus =
  | "selected" | "skipped" | "unavailable";

type ReceiptState = "open" | "closed" | "reconciled";

type EvidenceGrade =
  | "OFFICIAL_DOC" | "SOURCE_CONFIRMED" | "RUNTIME_VERIFIED"
  | "STATIC_CONFIG" | "HISTORICAL_PROBE" | "INFERRED"
  | "PROBE_PENDING" | "NOT_RUN" | "UNKNOWN" | "NOT_FOUND";

interface DeliveryEvidence {
  evidenceGrade: EvidenceGrade;
  evidenceReference?: string;   // mandatory for "confirmed"
  observedAt: string;           // ISO 8601
  independentlyVerified: boolean;
}

interface DeliveryIntegrity {
  receiptState: ReceiptState;
  execution?: HookExecutionStatus;      // absent while "open"
  payload: PayloadStatus;               // "unknown" while "open"
  selection: SelectionStatus;           // "unavailable" while "open"
  evidence: DeliveryEvidence;
  reconciliation?: {
    source: "journal" | "host_log" | "request_diff" | "worker";
    at: string;
    note?: string;
  };
}
```

### 13.4.1 State transitions

| # | Condition | Transition |
|:--|:----------|:-----------|
| T0 | Hook entry, before expensive work | `open`, `payload=unknown`, `selection=unavailable`, `evidenceGrade=STATIC_CONFIG`, `independentlyVerified=false`. One append-only journal line. |
| T1 | Renderer produced content | `payload=prepared`, `selection=selected` |
| T2 | Payload written to stdout, exit 0 | `closed`, `execution=completed`, `payload=returned` |
| T3 | Independent request-level evidence obtained | `reconciled`, `payload=confirmed`, `evidenceGrade ∈ {RUNTIME_VERIFIED}`, `evidenceReference` present, `independentlyVerified=true` |
| T4 | Intentional no contribution (flag off / no eligible principle / `NONE_APPLICABLE`) | `closed`, `execution=completed`, `payload=none`, `selection=skipped` |
| D1 | Self-deadline / dependency / resource limit | `closed`, `execution=degraded`, `payload=none` |
| D2 | Encoding or execution error | `closed`, `execution=failed`, `payload=unknown` |
| D3 | Host or wrapper killed the process with no chance to write a terminal line | Record remains `open`; reconciliation (worker / host log) sets `execution=timeout`, `payload=unknown`, `receiptState=closed`, with `reconciliation.source` |
| D4 | Reconciliation after `open` with no positive evidence | `execution=timeout` or `failed`; `payload` stays `unknown`. **Never `returned` or `confirmed`.** |
| D5 | Reconciliation with independent request-level evidence | `receiptState=reconciled`, `payload=confirmed` (T3) |

### 13.4.2 Invariants (MUST hold)

1. `payload === "confirmed"` ⇒ `execution === "completed"` ∧
   `evidence.independentlyVerified === true` ∧
   `evidence.evidenceReference` is present.
2. `execution ∈ {"degraded","timeout","failed"}` ⇒
   `payload ∉ {"returned","confirmed"}`.
3. `selection === "unavailable"` ⇒ `payload ∈ {"unknown","none"}`.
4. `receiptState === "open"` ⇒ no terminal `execution`, `payload === "unknown"`,
   and the record MUST NOT be counted as a success.
5. Reconciliation MUST NOT upgrade `unknown` or `none` to `returned` or
   `confirmed` without positive independent evidence.
6. `confirmed` is not equivalent to the model understanding or following
   the principle; behavioral effect is evaluated only by Examiner.

### 13.4.3 Answers to the six integrity questions

1. `degraded` is a **HookExecutionStatus**, not a payload state.
2. Yes — `execution=completed` with `payload=none` is a valid combination
   (T4) and is distinct from `degraded` (D1).
3. `returned` is adapter-side evidence (payload written to stdout);
   `confirmed` requires independent request-level evidence (T3).
   `returned` MUST NOT be inferred as `confirmed`.
4. When a host kill prevents a receipt, the T0 `open` journal line plus D3
   reconciliation records `timeout`/`unknown`; the turn is never counted as
   delivered.
5. Receipt writing MUST be a single `O_APPEND` line to
   `events_<date>.jsonl`: no synchronous SQLite transaction, no idempotency
   reads, no schema DDL, no per-call `mkdirSync`. Heavy evidence replay is
   performed by the existing background worker from the journal. The
   receipt-write latency budget is defined in §17.3.
6. Closed-world default: every receipt begins as `unknown`; only explicit
   positive evidence can move it to `returned` / `confirmed`. In evaluation
   scoring, **only `confirmed` counts as success**; `returned` is an
   attempted delivery, `unknown` is unscored, and
   `degraded`/`timeout`/`failed` are failures.
```

## 2.15 §14 Execution and Failure Handling — A-38 / A-23 / A-25

**替换 §14.3 表格中 WorkBuddy 行及表后说明（A-23）**：

```markdown
| Host profile                       | Host timeout | Host behavior on timeout / non-blocking exit | PD consequence | Required policy |
|:-----------------------------------|-------------:|:--------------------------------------------|:---------------|:---------------|
| Codex headless CLI                 | 600 s host default | Hook marked failed; turn continues | PD UPS configured 5 s | Honor 5 s budget; local-only synchronous path |
| **WorkBuddy Desktop / engine 2.165.0** | **host default 60 s; overridden by enabled `hooks.json`: UPS 15 s, others 30 s** | **Host kill / exit 2 / `deny` / `continue:false` → `allowed:false` → submission blocked and prompt cleared.** **exit 1 or other non-zero → non-blocking, turn continues, stderr becomes a user-visible warning.** `PreToolUse` timeout → tool blocked (fail-closed). `SessionStart` timeout → session proceeds. **Classic `PreCompact` `allowed:false` does NOT prevent compaction.** `PostCompact` return value is discarded. | Enabled `0.2.2` = 15 s; PD wrapper hard-codes a 12 s self-deadline and **has already degraded once in a live session**, losing that turn's injection. The 12 s figure is a budget setting; no phase-level attribution exists. | Fail fast **with a degraded journal line**; resolve the hard deadline from the enabled `hooks/hooks.json` at runtime; keep soft deadline strictly below it; never block the submission |
| OpenClaw embedded                  | 15 s `before_prompt_build` | Fail-open; hook skipped and model request continues | PD internal budget not established | Measure PD path; return well before host deadline; always record delivery outcome |

These are not interchangeable global constants, and failure semantics are
**event-specific**. Seven timing dimensions MUST be recorded separately
(§17.3): PD synchronous path, wrapper self-deadline, `hooks.json` hard
timeout, `SessionStart` self duration, the whole `SessionStart` hook chain,
SQLite lock contention, and receipt-write latency. Do not extrapolate one
event's semantics or one timing dimension to another.

The CLI Hooks reference states that `PreCompact` exit code 2 may prevent
compaction; engine 2.165.0 source does not implement that behavior. Both
claims are recorded; the source governs the current profile.
```

**替换 §14.2 末尾追加段（A-38，取代 v0.1 A-24）**：

```markdown
For the WorkBuddy profile, the Deferred Refresh candidate carrier is PD's
existing detached worker (§10.4.1), and its contract is not yet
implemented. Host-native `async: true` hooks are `PROBE_PENDING` / OFF and
MUST NOT be described as a verified non-blocking worker. Any detached
worker MAY outlive its originating session; §10.4.2 constraints are
mandatory. No deferred result may contribute to the current turn.
```

**替换 §14.5 Failure Matrix 追加行（A-25）**：

```markdown
| PD self-deadline / degraded               | Return a neutral payload with a non-blocking exit code; append one journal line with `execution="degraded"`, `payload="none"`, `degradationReason`, `selfDeadlineMs`, `resolvedHostTimeoutMs`, `elapsedMs`. Do NOT claim `returned`, `skipped` or `confirmed`. No synchronous DB write. |
| WorkBuddy exit 1 / non-blocking error     | Turn proceeds; journal records `execution="degraded"` when PD produced no contribution, otherwise `completed`/`returned`. Host silence is never `confirmed`. |
| WorkBuddy host kill / exit 2 / deny       | Potential submission loss; T0 `open` journal line + D3 reconciliation → `execution="timeout"`, `payload="unknown"`. Fail the profile gate. |
| Hook config source concat / fingerprint mismatch | Neutral return + journal line with `degradationReason:"hook_config_mismatch"` or `"hook_config_source_concat_detected"` (§8.3.1). Physical presence of stale version directories alone is NOT a failure. |
| `PreCompact` blocking result               | Prohibited. Classic PreCompact cannot block compaction; PD performs only a bounded checkpoint. |
| `PostCompact` selection / fingerprint recompute | Prohibited. Only `revalidationRequired=true` may be set. |
| Host Task / Subagent event used as semantic boundary | Prohibited (§5.2.1). Record `semantic_bypass_rejected` if attempted. |
| `PreToolUse` `continue:false`             | Prohibited in the WorkBuddy adapter; would re-submit the user prompt and duplicate `UserPromptSubmit`. |
| Host profile mismatch (`EXPIRED`)         | Native only; discard deferred results bound to the old profile; write `host_profile_expired`. |
| Injection content truncated by PD         | Journal-only `truncated:true` + discarded count; `payload` remains `returned`, `execution` remains `completed`. |
| Deferred worker result stale / cross-session | Discard; record `worker_result_stale_discarded` (§10.4.2). |
```

**替换 §14.4 Soft Deadline Resolution 的第 1 条并追加（A-25）**：

```markdown
- `hostHookTimeoutMs` MUST be read at runtime from the **enabled plugin's
  `hooks/hooks.json`** for the current event (`timeout` is in seconds).
  Hard-coded host timeout constants are prohibited. This is a
  **correctness / configuration-drift** requirement, not a performance
  optimization.
- `softDeadlineMs` MUST be strictly lower than
  `min(hostHookTimeoutMs, pdConfiguredHookBudgetMs)` with a safety margin
  derived from measured PD p95/p99 and worst-case observations.
- A self-degradation MUST complete before `softDeadlineMs` with enough
  residual time to append one journal line; otherwise the host may kill
  the process and block the submission.
- The degraded journal line MUST be append-only and MUST NOT open a
  database connection or perform an idempotency read (§13.4.3).
```

## 2.16 §15 Receipt, Observability, Evidence — A-39 / A-40 / A-27 / A-28

**替换 §15.2 `AdaptiveActivationReceipt` 的 `host` / `identity` / `delivery` / `lifecycle` 段（A-39 + A-40 + A-42）**：

```typescript
interface AdaptiveActivationReceipt {
  receiptId: string;
  timestamp: string;

  host: {
    kind: "openclaw" | "codex" | "workbuddy";
    hostVersion: string;
    engineVersion: string;
    engineSha256?: string;
    runtimeMode: string;
    adapterVersion?: string;
    profileId: string;
    profileRevision: string;
    profileStatus: "VERIFIED" | "CONDITIONALLY_VERIFIED" | "EXPIRED" | "NOT_RUN";
    sourceEvent: string;
    /** NO absolute filesystem paths in long-term receipts. */
    plugin: {
      pluginId: string;
      pluginVersion: string;
      configSha256: string;
      rootFingerprint: string;
      discoverability: "registry_resolved" | "plugin_dir" | "unknown";
    };
  };

  identity: {
    workspaceHash?: string;
    sessionHash?: string;
    generationId?: string;   // absent on Task/Compaction-sourced events
    hostTaskId?: string;     // snake_case task_id; Agent-internal plan item
    agentId?: string;
    turnId?: string;
  };

  governance: {
    eligiblePrincipleIds: string[];
    activationRevision?: string;
    validationStatus: "valid" | "invalid" | "unknown";
  };

  selection: {
    mode: "native" | "model-assisted";
    selectedPrincipleIds: string[];
    decisionType?: TaskChangeType;
    decisionReason?: string;
    selectionReason?: string;
    confidence?: number;
    workingSetRevision?: number;
    contextFingerprint?: string;
  };

  /** Three independent dimensions; see §13.4. */
  delivery: DeliveryIntegrity;

  /** Six independently evidenced stages; see §15.2.1. */
  lifecycle: StageObservation[];

  fallbackReason?: string;
}
```

**新增 §15.2.1（A-40）**：

```markdown
### 15.2.1 Lifecycle Stage Observations (NEW)

Boolean lifecycle flags are NOT permitted. Each stage is an independent
observation with its own status, evidence grade, timestamp, reference and
asserting owner:

```typescript
type LifecycleStage =
  | "plugin_installed"
  | "plugin_loaded"
  | "hook_dispatched"
  | "payload_returned"
  | "request_confirmed"
  | "behavioral_effect";

type StageStatus = "observed" | "not_observed" | "unverifiable";

interface StageObservation {
  stage: LifecycleStage;
  status: StageStatus;
  evidenceGrade: EvidenceGrade;
  timestamp: string;
  evidenceReference?: string;   // mandatory when status = "observed"
  assertedBy:
    | "installer"
    | "host_loader"
    | "hook_entry"
    | "encoder"
    | "request_probe"
    | "reconciler"
    | "examiner";
}
```

Stage ownership (MUST NOT be violated):

| Stage | Sole asserting owner | Evidence |
|:------|:---------------------|:---------|
| `plugin_installed` | installer | `installed_plugins.json` |
| `plugin_loaded` | host loader / reconciler | `HookExtensionLoader` log |
| `hook_dispatched` | hook entry | process start + T0 `open` journal line |
| `payload_returned` | encoder | stdout single-line record |
| `request_confirmed` | request probe / reconciler | independent request-level evidence |
| `behavioral_effect` | Examiner | PD MUST NOT assert; always `unverifiable` |

Rules:

1. A hook receipt may assert only `hook_dispatched` and `payload_returned`.
   `plugin_installed` / `plugin_loaded` are back-filled by the reconciler
   from host-side evidence, never invented by the hook.
2. `request_confirmed` may be appended only after T3 evidence exists.
3. A later stage MUST NOT be used to infer an earlier stage. Seeing
   `payload_returned` does not prove `hook_dispatched` unless that stage was
   independently recorded.
4. `behavioral_effect` remains `unverifiable` in every PD receipt.
5. No stage may be recorded without its own `timestamp` and, when
   `observed`, its own `evidenceReference`.

These six stages are strictly ordered in evidentiary strength: installed
⇏ loaded ⇏ dispatched ⇏ returned ⇏ present in the model request ⇏
understood or followed by the model.
```

**替换 §15.3 Required Events 联合类型中 v0.1 追加的事件（A-27）**：

```typescript
  | "plugin_installed"
  | "plugin_loaded"
  | "hook_dispatched"
  | "hook_config_source_concat_detected"
  | "hook_config_mismatch"
  | "host_profile_expired"
  | "injection_degraded"
  | "injection_truncated"
  | "receipt_reconciled"
  | "worker_result_stale_discarded"
  | "host_task_graph_changed"
  | "subagent_scope_changed"
  | "post_compact_invalidated"
  | "semantic_bypass_rejected"
```

**替换 §15.4 Evidence Semantics 表的 WorkBuddy 相关行并追加**：

```markdown
| Evidence               | What it proves                                                        | What it does not prove                                         |
|:-----------------------|:----------------------------------------------------------------------|:---------------------------------------------------------------|
| `execution=completed`  | The hook returned normally                                            | That a payload existed or reached the model                    |
| `payload=returned`     | Adapter wrote the payload to the host callback                        | That the host included it in the model request                 |
| `payload=confirmed`    | Independent evidence places content in the current request           | Model understanding or compliance                              |
| `execution=degraded`   | A contribution that should have existed was lost                     | That the submission was blocked (it was not)                   |
| `receiptState=open`    | A hook started; no terminal outcome is known                         | Delivery of any kind                                           |
| Behavioral Effect      | Examiner observed a behavior difference under its evaluation protocol | Long-term improvement unless longitudinal evidence supports it |

Do not infer `confirmed` from `returned`, absence of an exception,
`execution=completed`, a host's fail-open behavior, or a known injection
channel.
```

**替换 §15.5 中 WorkBuddy 条目（A-28）**：

```markdown
- **WorkBuddy:** the injection channel is `user_message_system_reminder`
  and the injection position is deterministic (`UserPromptSubmit`=`last`,
  `SessionStart`=`first`). Nevertheless `confirmed` still requires
  independent request-level evidence; a channel definition is not proof of
  delivery, and `confirmedClaimAllowed` is `false` for the current
  profile. Because PD's self-degradation exits non-blockingly while the
  turn continues, absence of a host error MUST NOT be read as successful
  injection. Every degraded hook MUST append one journal line with
  `execution="degraded"`, `payload="none"` and a `degradationReason`;
  the wrapper's degrade path MUST also append that line (it currently does
  not). A host kill that prevents the terminal line leaves an `open`
  record that the reconciler resolves to `timeout`/`unknown`.
  Lifecycle stages MUST be recorded as `StageObservation[]` (§15.2.1);
  the receipt MUST NOT claim `plugin_installed`, `plugin_loaded`,
  `request_confirmed` or `behavioral_effect` on its own authority.
```

## 2.17 §17 Performance and Cost Budget — A-43

**替换 §17.3 开头追加段（A-43）**：

```markdown
**Status correction (2026-11-04):** this probe is no longer a future-only
Phase 2 task for the WorkBuddy profile. A live session recorded a 12.113 s
PD `UserPromptSubmit` self-degradation with zero injection. Measuring and
repairing the synchronous path is a **P0 prerequisite** for SPEC
finalization. The 12.021 s figure is the wrapper's **self-deadline budget
setting**, NOT an attribution to any stage; no phase-level timing data
exists and no stage may be named as the cause without measurement.

### 17.3.1 Seven separate timing dimensions (NEW)

Measure and report these independently; do not collapse them:

1. PD synchronous path internal time (cold and warm process).
2. Wrapper self-deadline (`wrapperSelfDeadlineMs`, a configured budget).
3. `hooks.json` hard timeout resolved at runtime.
4. `SessionStart` hook self duration (15.552 s observed).
5. Whole `SessionStart` hook chain wall time (16.736 s observed, includes
   other plugins).
6. SQLite lock contention (write connections use `busyTimeoutMs: 0`;
   read-only connections set no `busy_timeout`; six connection open/close
   points exist in the synchronous path).
7. Receipt/journal write latency (single append-only line).

Dynamic resolution of `hooks.json` is a **correctness / configuration-drift
fix**, not a performance optimization. It MUST NOT be counted as a latency
improvement.

Mandatory instrumentation: phase-level timers at module load, config
reads, DB open, activation reader, renderer, emitter, encode, and stdout.
Record p50 / p95 / p99 / max and dropped/kill rate.

### 17.3.2 Load matrix and sample size (NEW)

Load matrix: cold/warm process; empty/populated Working Set; minimum and
maximum candidate pools; Workspace Focus available/unavailable; Intent
on/off; concurrent `SessionStart` + `UserPromptSubmit`; DB lock contention;
large transcript and context truncation; receipt-write contention;
configured timeouts of 5 s / 15 s / 30 s.

Sample size: at least **200 measured hook invocations per matrix cell**,
across at least **3 independent runs** and at least **2 distinct sessions
or dates**. Report p50/p95/p99/max, degraded rate, timeout rate, and
blocked rate per cell.

### 17.3.3 Statistical acceptance (NEW)

- `p99(PD synchronous path) ≤ softDeadlineMs − safety margin`, and
  `worst observed < hostHookTimeoutMs`.
- Synchronous path executes **zero** SQLite transactions after the emitter
  change; journal append `p99 ≤ 2 ms` and `max ≤ 5 ms`.
- `execution ∈ {degraded, timeout, failed}` observed 0 times **and** the
  95% upper confidence bound on the failure rate is `≤ 1%`; `allowed:false`
  (blocked submission) observed 0 times.
- No `payload=confirmed` misclassification and no cross-session result
  contamination.

**Statistical interpretation (mandatory).** Observing zero failures in N
trials does NOT prove a zero population failure rate. By the rule of
three, the 95% upper bound is approximately `3 / N` (N = 300 ⇒ ≈ 1%).
Every gate report MUST state N, the bound, and the load matrix. This gate
is a release gate, not proof of zero production risk; post-rollout
telemetry of degraded / timeout / blocked rates and the §21 Stop
Conditions remain in force.
```

**替换 §17.4 中 WorkBuddy 条（A-43）**：

```markdown
- **WorkBuddy:** the effective hard limit is the `timeout` of the
  **enabled plugin version's `hooks/hooks.json`** (`UserPromptSubmit` 15 s
  in the current 0.2.2 profile), not a repository canonical constant and
  not the host's 60 s default. Host kill blocks the submission; PD
  self-degradation with exit 1 does not, but silently loses the
  contribution. Resolving this value at runtime is a correctness
  requirement. The soft deadline derives from measured PD p95/p99 with
  enough residual time to append one degraded journal line. The
  `SessionStart` self duration (15.6 s) and the whole chain (16.7 s
  against a 30 s budget) are recorded separately and MUST NOT be charged
  to the PD synchronous-path budget.
```

## 2.18 §19 Rollout Plan and Gates — A-31

**替换 Phase 0 Status 行并追加任务 / Gate（A-31 + A-47）**：

```markdown
Status: Host Event Capability Matrix v0.1 is **HISTORICAL / EXPIRED for
the WorkBuddy profile** (engine 2.161.0 → 2.165.0, PD 0.2.0 → 0.2.2).
It has been superseded for WorkBuddy by the 2026-11-04 host audit and the
Amendment v0.2 adversarial review. This does not mean all host modes are
verified.

Additional Phase 0 tasks (P0 items in mandatory order):

1. Instrument and measure the PD synchronous path to **attribute** the
   12 s self-degradation to specific stages (§17.3.1). Do not infer the
   cause from the budget value.
2. Optimize the measured synchronous critical path.
3. Move non-essential evidence writes out of the synchronous path:
   emitter converges to a single append-only journal line; the synchronous
   SQLite evidence transaction and idempotency reads are replayed by the
   existing background worker.
4. Resolve the actual `hooks/hooks.json` timeout dynamically (correctness
   fix; property test T-02).
5. Guarantee self-degradation cannot block the user submission (exit 1
   non-blocking; no `continue:false` / `deny` / exit 2).
6. Guarantee degraded outcomes are observable: journal-only, no
   synchronous DB, open→closed/reconciled reconciliation (T-03/T-04).
7. Freeze the WorkBuddy profile identity (appVersion, engineVersion,
   engineSha256, runtimeMode, pdPluginVersion, configSha256,
   rootFingerprint) and its evidence date.
8. Implement `resolveHostProfile()`; any mismatch sets `status=EXPIRED`,
   falls back to Native-only, and discards stale deferred results.
9. Verify discoverability as four distinct levels (§8.3.1); confirm the
   same event is not registered from two config sources of one root.
10. Rebuild the isolated probe lab and run P1 / P3 / P4 / P6 against
    engine 2.165.0. `PROBE_PENDING` lifecycle events and host-native async
    hooks remain OFF throughout.

Gate 0 additions:

- The synchronous path satisfies §17.3.3 statistical acceptance with a
  reported N and 95% upper bound; no `allowed:false` outcome.
- Degraded journal lines are emitted and observable; no receipt write adds
  a synchronous database operation.
- `resolveHostProfile()` is implemented and tested (T-01).
- Discoverability is verified at all four levels; no same-event duplicate
  registration from one root.
- `PROBE_PENDING` events and host-native async refresh remain explicitly
  OFF (A-48).

Gate 2 additionally requires evidence that the resolved soft deadline is
derived from installed configuration at runtime, not a hard-coded
constant, and that this is treated as correctness rather than a latency
improvement.

Gate 4 requires the PD-worker Deferred Refresh contract (§10.4.1) to be
implemented, tested and probe-verified before Shadow; host-native async
refresh requires a separate isolated probe and Owner acceptance.
```

## 2.19 §20 Acceptance Criteria — A-32

**替换** v0.1 追加的验收项（原 v0.4 验收项一律保留）：

```markdown
## B. Native Mode (additions)

- [ ] A degraded hook NEVER prevents the user submission from proceeding
      in the WorkBuddy profile.
- [ ] The §17.3.3 statistical acceptance gate is satisfied with reported
      load matrix, sample size N, p95/p99, worst observed, and 95% upper
      bound on the failure rate.
- [ ] Seven timing dimensions of §17.3.1 are reported separately and no
      stage attribution is inferred from the self-deadline budget.

## C. Model-assisted Mode (additions)

- [ ] No host event (`TaskCreated`, `TaskCompleted`, `SessionEnd`,
      `PostCompact`, `SubagentStart/Stop`) produces a `TaskChangeType`
      decision, selects a principle, or causes `principle_decision` to be
      skipped (§5.2.1, T-07′).
- [ ] `HOST_TASK_GRAPH_CHANGED` only records provenance / sets
      `revalidationRequired`.
- [ ] Deferred Refresh carrier is PD's existing detached worker with the
      §10.4.2 constraints implemented and verified; host-native async
      refresh remains OFF unless separately probed and Owner-accepted.
- [ ] No detached worker contributes to the current turn.
- [ ] `PreToolUse` never returns `continue:false` in the WorkBuddy adapter.

## D. Working Set (additions)

- [ ] `generationId` (when present), `hostTaskId` (snake_case `task_id`),
      `engineVersion`, `engineSha256`, `configSha256`,
      `pdPluginVersion` are bound into the Working Set record; missing
      fields are never fabricated.
- [ ] Discoverability is verified at all four levels of §8.3.1; physical
      residue alone is not treated as duplicate registration.
- [ ] `configSha256` / `rootFingerprint` mismatches yield a neutral return
      and a degraded journal line.
- [ ] `SessionEnd` is best-effort and TTL remains authoritative.
- [ ] `PostCompact` sets `revalidationRequired` without changing
      `selectedPrincipleIds` or recomputing the fingerprint from
      `compact_summary`.
- [ ] Stale, cross-session and `EXPIRED`-profile deferred results are
      discarded with `worker_result_stale_discarded`.

## E. Compaction (additions)

- [ ] No LLM inference or principle selection executes inside a
      synchronous `PreCompact` hook.
- [ ] PD never returns a blocking result from `PreCompact`, and never
      relies on it to prevent compaction.
- [ ] `compact_summary` is recorded as evidence metadata only.

## F. Host Compatibility (replacements / additions)

- [ ] **WorkBuddy Desktop 5.9.2 / CLI engine 2.165.0 / PD 0.2.2 profile is `CONDITIONALLY_VERIFIED`** (replaces the `lite-wb CLI` item).
- [ ] Each profile records appVersion, engineVersion, engineSha256,
      runtimeMode, pluginVersion, `configSha256`, `rootFingerprint`;
      **no absolute path in long-term receipts**.
- [ ] `resolveHostProfile()` sets `status=EXPIRED` on any mismatch.
- [ ] `RUNTIME_VERIFIED` tool events and `PROBE_PENDING` lifecycle events
      are recorded with distinct evidence grades; no cross-mode or
      grade substitution.
- [ ] CLI / IDE / Desktop evidence is recorded separately; the
      PreCompact document/source contradiction is registered.
- [ ] The WorkBuddy injection channel is recorded as
      `user_message_system_reminder` with position `first`/`last`, and
      `confirmedClaimAllowed=false`.

## G. Execution Safety (additions)

- [ ] The WorkBuddy soft deadline is resolved at runtime from the enabled
      plugin's `hooks/hooks.json`; no hard-coded host timeout constant.
- [ ] PD self-degradation appends one degraded journal line before
      returning, with no synchronous database operation.
- [ ] Injected content is truncated by PD using the existing Prompt
      Capacity Budget; truncation is recorded journal-only.
- [ ] `SessionStart` self duration and hook-chain wall time are measured
      and recorded separately.

## H. Evidence (additions)

- [ ] `DeliveryIntegrity` uses three independent dimensions plus evidence;
      `degraded` is a `HookExecutionStatus`, not a payload state.
- [ ] All six §13.4.2 invariants hold, including "open is never success".
- [ ] Lifecycle is `StageObservation[]` with six stages, per-stage owner,
      timestamp, evidence grade and reference; no boolean flags.
- [ ] Only `confirmed` is scored as success; `returned` is an attempted
      delivery; `unknown` is unscored.
- [ ] `confirmed` is never claimed for WorkBuddy without request-level
      evidence from an isolated probe.
- [ ] Host-kill scenarios are reconciled from the T0 `open` journal line.
```

## 2.20 §21 Stop Conditions — A-33

**替换第 12 条并追加 15–19**：

```markdown
12. **Any WorkBuddy hook timeout that can block a user submission**
    (replaces the previous generic wording): host-side kill, `exit 2`,
    `deny`, or `continue:false` reaching the host.
15. A PD self-degradation causes a turn to receive no principle
    contribution (`execution="degraded"` with `payload="none"` observed in
    Live).
16. A degraded / timeout / failed outcome is recorded as `returned`,
    `skipped`, `unknown` or `confirmed`, no journal line is written, or a
    T0 `open` record is counted as success.
17. A same-event duplicate hook registration arises from two config
    sources of one plugin root, or a `configSha256` / `rootFingerprint`
    mismatch is not handled neutrally. (Physical presence of stale version
    directories alone is NOT a stop condition.)
18. `resolveHostProfile()` reports `EXPIRED` and the adapter does not
    fall back to Native-only, or a stale deferred result reaches a new
    session.
19. Any host event is observed producing a `TaskChangeType` decision,
    selecting a principle, or skipping `principle_decision`
    (`semantic_bypass_rejected`).
```

## 2.21 §22 Open Questions — A-34

**替换** v0.1 的 22.1 / 22.2 表：

```markdown
### 22.1 2026-11-04 resolution status (v0.2)

| ID    | Status | Finding |
|:------|:-------|:--------|
| OQ-02 | **Partially closed** | The WorkBuddy hook engine inside Desktop is verified (live dispatches + source). Standalone IDE runtime and Desktop UI-only capabilities remain `NOT_RUN`. |
| OQ-05 | **Partially closed** | `session_id` (all events), `generation_id` (UPS/Stop, absent on Task/Compaction), `cwd`, `task_id` (snake_case), `agent_id` are verified payload fields. `workspaceId` and a stable cross-process `conversationId` remain `UNKNOWN`. |
| OQ-06 | **Answer revised twice** | The host exposes an `async:true` branch in source, but PD already ships a detached worker with a durable task lease. The host async hook is `PROBE_PENDING`/OFF; the Deferred Refresh **contract** is not implemented. Other hosts remain open. |
| OQ-14 | **Open, tightened** | `confirmed` requires request-level evidence. The three-dimension Delivery Integrity model prevents absence of evidence from being scored as success. |
| OQ-15 | **Closed (channel) / re-scoped (delivery)** | Channel = `user` message `<system-reminder data-role="hook">` before `<user_query>`. Per-turn `confirmed` evidence for engine 2.165.0 remains `NOT_RUN`. |
| OQ-16 | **Partially closed** | `generation_id` + `task_id` + `call_id` provide correlation where present; `SessionEnd` is best-effort; `deduplicateHooks` only dedupes identical commands. |

### 22.2 New open questions

| ID    | Question | Required evidence |
|:------|:---------|:------------------|
| OQ-17 | Does `async:true` detached hook behave non-blockingly in engine 2.165.0, is `asyncTimeout` honored, and what happens after the session ends? | Isolated lifecycle probe |
| OQ-18 | Which **specific synchronous stage** produced the 12.021 s self-degradation? | Phase-level PD Hook Performance Probe (§17.3.1) |
| OQ-19 | Does `PostCompact` reliably dispatch, and does `compact_summary` ever carry complete context? | Isolated compaction probe |
| OQ-20 | Can `ConfigChange` detect `hooks.json` / profile drift within a session? | Source + runtime correlation |
| OQ-21 | Are `task_id` / `task_subject` (snake_case) payload shapes stable across engine upgrades? | Per-version probe |
| OQ-22 | Do `TaskCreated` / `TaskCompleted` / `SubagentStart` / `SubagentStop` dispatch reliably with the payload shapes seen in source? | Isolated P3 probe |
| OQ-23 | Can `PreCompact` execute a bounded checkpoint without inflating compaction latency under load? | Isolated P4 probe + phase timings |
| OQ-24 | Is `events_<date>.jsonl` append latency within the §17.3 receipt budget under concurrent hooks? | Concurrency measurement |
| OQ-25 | Can an isolated probe produce request-level `confirmed` evidence for engine 2.165.0? | P1 mock-request probe |
```

## 2.22 §23 Architecture Decision Records — A-45

**替换** v0.1 新增的 ADR-015 / ADR-016：

```markdown
## ADR-015 — Host Events Supply Technical Signals, Never Semantic Authority

**Decision: NEW — PROPOSED. Status: `PROPOSED`.**

Host lifecycle events may supply timing, provenance, deduplication and
invalidation signals. They MUST NOT supply semantic task classification or
principle selection.

A host event MUST NOT produce a `TaskChangeType` decision, skip
`principle_decision`, select/activate/deactivate a principle, or serve as
a user task boundary. `TaskCreated` / `TaskCompleted` in WorkBuddy engine
2.165.0 are Agent-internal todo notifications: they carry no user prompt,
no turn identity, no parent hierarchy, and their `task_id` cannot resolve
the originating user request. `SubagentStart` / `SubagentStop` belong to a
separate session-lineage chain. `PostCompact` carries only a lossy
`compact_summary`.

`principle_decision` remains the sole semantic classifier. §17.5
optimization order item 1 is satisfied by throttling, deduplication and
cached Working Set reuse — not by replacing semantic judgment with a host
signal.

Rationale: Amendment v0.1 proposed a "determinism-first rule" that mapped
`TaskCreated` to a deterministic `NEW_TASK`; source inspection showed this
would re-select principles on every Agent plan-item creation and could
cause systematic erroneous activation. This ADR supersedes that proposal.

## ADR-016 — Mode-Scoped Evidence, Grade Discipline and Status Ladder

**Decision: NEW — PROPOSED. Status: `PROPOSED`.**

Every host capability claim MUST be bound to (a) CLI / IDE / Desktop mode,
(b) official document URL and check date, (c) engine version and binary
hash where available, (d) evidence grade, (e) verification date. Official
documents may contradict matched source and live runtime; such
contradictions MUST be recorded separately, never resolved by silently
discarding one source. `SOURCE_CONFIRMED` MUST NOT be upgraded to
`RUNTIME_VERIFIED`; `NOT_RUN` and `PROBE_PENDING` MUST NOT be upgraded to
`Supported`.

Implementation state is tracked by the §0.2 ladder
(`PROPOSED → SPEC_REVISED → IMPLEMENTED → TESTED → RUNTIME_VERIFIED →
ACCEPTED`, plus `DEFERRED_PENDING_EVIDENCE`). A proposal MUST NOT be
marked `PASS` in a self-audit. A profile is `EXPIRED` on any version,
engine hash, runtime mode, plugin version or `configSha256` change until
reverified.

Rationale: the 2026-11-04 audit found 13 concrete contradictions between
CLI docs, IDE docs, engine source and live runtime, and a historical probe
baseline (2.161.0) that had silently gone stale after a host auto-upgrade
to 2.165.0.

## ADR-017 — Delivery Evidence Uses a Closed-World Default

**Decision: NEW — PROPOSED. Status: `PROPOSED`.**

Delivery state is represented by three independent dimensions
(`HookExecutionStatus`, `PayloadStatus`, `SelectionStatus`) plus evidence
and an `open / closed / reconciled` journal state. Every record begins as
`unknown`; only explicit positive evidence can move it to `returned` or
`confirmed`. A host kill leaves an `open` record that reconciliation
resolves to `timeout` / `unknown`. Only `confirmed` is scored as success.

Lifecycle is a set of independently evidenced `StageObservation` records,
not booleans. PD may not assert `plugin_installed`, `plugin_loaded`,
`request_confirmed` or `behavioral_effect` on its own authority.

Receipt writing MUST NOT add a synchronous database operation to the
prompt hook; it is a single append-only journal line, with heavy evidence
replay delegated to the existing background worker.

Rationale: a live session already lost an injection silently. Treating
"no exception" or a known channel as delivery would make that loss
invisible; adding synchronous evidence writes would make the underlying
latency problem worse.
```

## 2.23 §24 Change Log / §25 Self-audit — A-44

**在 §24 Change Log 追加**：

```markdown
| Metadata / §0.3 / §2.1  | Add WorkBuddy host-native revision + adversarial review corrections; remove determinism-first rule and the "cannot outlive the session" guarantee | Amendment v0.2 (2026-11-04) |
```

**替换 §25.1 Self-audit 表中 v0.1 新增的 4 行，并改用状态阶梯（A-44）**：

```markdown
### 25.1 Consistency Audit — Amendment v0.2 status (NOT `PASS`)

| Check | Status | Required next evidence |
|:------|:-------|:-----------------------|
| Runtime V2 remains sole activation authority | `SPEC_REVISED` | Owner acceptance |
| Native remains independent of external model | `SPEC_REVISED` | Owner acceptance |
| WorkBuddy injection channel is `user_message_system_reminder` | `SPEC_REVISED` (basis `SOURCE_CONFIRMED`) | Current-version request-level `RUNTIME_VERIFIED` probe (OQ-25) |
| WorkBuddy tool events are usable evidence channels | `SPEC_REVISED` (basis `RUNTIME_VERIFIED`, 164/162) | CI regression assertion |
| WorkBuddy lifecycle/compaction events are refresh triggers | `DEFERRED_PENDING_EVIDENCE` | Isolated P3/P4 probes (OQ-22/OQ-23) |
| Host events never bypass semantic judgment | `PROPOSED` | Implementation + T-07′ + Owner acceptance |
| Three-dimension Delivery Integrity + journal | `PROPOSED` | Implementation + T-03/T-04 + runtime journal evidence |
| `degraded` is observable on the wrapper degrade path | `PROPOSED` (currently `NOT_FOUND` in code) | Implementation + T-03 |
| Host profile binds engine SHA / plugin version / configSha256 | `PROPOSED` (currently `NOT_FOUND` in code) | `resolveHostProfile()` + T-01 |
| Deferred Refresh carrier = PD existing worker | `PROPOSED` (contract `NOT_FOUND` in code) | Contract implementation + Gate 4 probe |
| Host-native async refresh | `DEFERRED_PENDING_EVIDENCE` (OFF) | Isolated P6 probe + Owner acceptance |
| Detached worker may outlive session (no host guarantee) | `SPEC_REVISED` (basis `SOURCE_CONFIRMED`) | Runtime lifecycle probe (OQ-17) |
| PreCompact cannot block compaction; PostCompact observational | `SPEC_REVISED` (basis `SOURCE_CONFIRMED`) | Isolated P4 probe |
| Physical `hooks.json` residue is not duplicate registration | `SPEC_REVISED` (basis `SOURCE_CONFIRMED`) | T-08′ configuration test |
| Seven timing dimensions reported separately | `PROPOSED` | Phase-level instrumentation (OQ-18) |
| Statistical performance gate replaces "degraded = 0" | `PROPOSED` | Probe with reported N and 95% bound |
| `confirmed` never claimed without request-level evidence | `SPEC_REVISED` | P1 mock-request probe |
| Self-audit uses the status ladder, never `PASS` for proposals | `SPEC_REVISED` | Owner acceptance |

No row above may be reported as `ACCEPTED` until the Owner explicitly
approves it, and no row may be reported as `TESTED` / `RUNTIME_VERIFIED`
without the named evidence.
```

**替换 §25.2 Evidence Limitations 中 WorkBuddy 相关否定表述**：

```markdown
This SPEC does not claim:

- Codex interactive TUI is verified.
- WorkBuddy standalone IDE runtime or Desktop UI-only capabilities are verified.
- WorkBuddy `PROBE_PENDING` lifecycle/compaction events are usable as
  refresh triggers; they have source-level dispatch points but zero live
  samples.
- `TaskCreated` / `TaskCompleted` represent user task boundaries (they do not).
- A host-native `async:true` hook is a verified Deferred Refresh carrier,
  or that a detached worker cannot outlive its session.
- Classic `PreCompact` can block compaction, or that `compact_summary`
  represents full context.
- Stale plugin version directories on disk imply duplicate hook
  registration.
- PD's synchronous path stage-level timings, p95/p99, or the cause of the
  12 s self-degradation are known.
- A deferred Deferred Refresh contract is implemented in PD code.
- A current-version (2.165.0) request-level `confirmed` injection evidence
  exists.
- Model-assisted selection has passed Shadow evaluation.
- Principle activation has improved long-term host behavior.
```

---

# 3. 新增接口与数据结构汇总（v0.2）

| 名称 | 位置 | 状态 | 用途 |
|:---|:---|:---|:---|
| `resolveHostProfile()` | §12.2 / §10.2 | `PROPOSED` | 解析版本五元组 + `configSha256` + `rootFingerprint`；不匹配 → `EXPIRED` + Native-only |
| `HostPluginIdentity` | §12.2 | `PROPOSED` | 长期身份；**无绝对路径** |
| `AdaptiveContextSnapshot` 修订字段 | §4.3 | `PROPOSED` | `hostTaskId`(snake_case)、`compactSummaryEvidence`、无 `"compact"` source、缺失不伪造 |
| `CanonicalEventType` 新值 | §5.2 | `PROPOSED` | `HOST_TASK_GRAPH_CHANGED` / `HOST_SUBAGENT_SCOPE_CHANGED` / `HOST_SESSION_ENDED` / `HOST_POST_COMPACT`，全部 `semanticAuthority:false` |
| `SessionWorkingSet` 新字段 | §8.2 | `PROPOSED` | `revalidationRequired` / `preCompactRevision` / `configSha256` / 指纹 |
| `DeliveryIntegrity` + 三个枚举 + `DeliveryEvidence` | §13.4 / §15.2 | `PROPOSED` | 三维状态机 + 封闭世界默认 |
| `LifecycleStage` / `StageObservation` / `StageStatus` | §15.2.1 | `PROPOSED` | 六阶段独立观察，替代 boolean |
| `EvidenceGrade`（含 `PROBE_PENDING`） | §2.1.1 / §12.2 | `PROPOSED` | 证据等级纪律 |
| `ProfileStatus` / `implementationStatus` | §12.2 | `PROPOSED` | 状态阶梯落地 |
| 新增事件类型 14 个 | §15.3 | `PROPOSED` | 含 `receipt_reconciled` / `worker_result_stale_discarded` / `semantic_bypass_rejected` |
| `deferredWorker` / `hostAsyncHook` profile 配置 | §10.2 | `PROPOSED`（均 OFF） | 载体与门禁一致性 |
| 七维 timing 结构 | §12.2 / §17.3.1 | `PROPOSED` | 分离测量，禁止合并 |

**已删除的 v0.1 结构**：`injectionStatus.degraded`（并入 `HookExecutionStatus`）、`lifecycle{4×boolean}`（并入 `StageObservation[]`）、`enabledPluginRoot: string`（并入 `HostPluginIdentity`）、`HOST_TASK_CREATED`/`HOST_TASK_COMPLETED`「确定性边界」映射、`determinism-first rule`、`cannot outlive the session`、§8.3.1 多版本幂等、A-36 `PASS (amended)`。

---

# 4. 验收标准汇总（含统计口径）

见 §2.19（§20 追加项）。核心可量化门禁：

| 门禁 | 阈值 / 口径 | 状态 |
|:---|:---|:---|
| 同步路径阶段归因 | 必须有 phase-level 计时；不得从 12 s 预算反推 | `PROPOSED` |
| 样本量 | 每格 ≥ 200 次，≥ 3 次独立运行，≥ 2 会话/日期 | `PROPOSED` |
| p99 | `≤ softDeadlineMs − 安全余量`；worst `< hardTimeoutMs` | `PROPOSED` |
| 同步 SQLite 事务数 | 0（emitter 改造后） | `PROPOSED` |
| journal append | `p99 ≤ 2 ms`、`max ≤ 5 ms` | `PROPOSED` |
| 失败率 | 观测 0 次且 95% 上界 `≤ 1%`（rule of three，N≥300） | `PROPOSED` |
| 阻断率 | `allowed:false` 观测 0 次 | `PROPOSED` |
| 交付误报 | 0 次 `confirmed` 误报；0 次跨 session 污染 | `PROPOSED` |

**生产声明限制**：以上为发布门禁，**不构成生产零风险证明**；上线后必须持续采集 degraded / timeout / blocked 率并保留 §21 停止条件。

---

# 5. 测试要求（v0.2 修订）

| # | 测试 | 断言 | 类型 | 状态 |
|:--|:---|:---|:---|:---|
| T-01 | `resolveHostProfile()` 版本匹配 | 任一身份字段不匹配 → `EXPIRED` + Native-only + `host_profile_expired`；receipt 不含绝对路径 | 单元 | `PROPOSED` |
| T-02 | hooks.json 动态 deadline | 给定 5/15/30 s，self-deadline 恒 < hard limit，receipt 记录实际值；**不得标为性能优化** | 属性测试 | `PROPOSED` |
| T-03 | degraded journal | wrapper 降级 → 一行 `execution=degraded, payload=none`；无 SQLite 连接；`open` 不算成功 | 集成 | `PROPOSED` |
| T-04 | 非阻断降级 | exit 1 降级不产生 `continue:false`/`deny`/exit 2；宿主提交继续；无 journal 时由对账标 `timeout` | 隔离真实引擎探针 | `PROPOSED` |
| T-05 | 当前回合注入形状 | 2.165.0 mock request body 中 `role:"user"` 的 hook system-reminder 位于 `<user_query>` 前；`confirmed` 证据可用 | 隔离真实引擎探针 | `DEFERRED_PENDING_EVIDENCE` |
| T-06 | async detach 生命周期 | `allowed:true` 立即返回、不贡献当前回合、`asyncTimeout` 生效、**Session 结束后进程行为**、结果提交校验 | 隔离真实引擎探针 | `DEFERRED_PENDING_EVIDENCE` |
| T-07′ | **无语义绕过** | `TaskCreated`/`TaskCompleted`/`SessionEnd`/`PostCompact`/`Subagent*` 触发时：① `TaskChangeType` 产出数=0；② `selectedPrincipleIds` 不变；③ `principle_decision` 不被跳过；④ 仅写 provenance / `revalidationRequired` | 单元 + 计数断言 | `PROPOSED` |
| T-08′ | 同 root 配置来源 concat | manifest `hooks` + 默认 `hooks/hooks.json` 同事件 → `hook_config_source_concat_detected` + 中性返回；**物理残留目录不触发** | 集成 | `PROPOSED` |
| T-09 | `continue:false` 禁用 | adapter 任何路径不输出 `continue:false`；重投时按可用身份去重 | 单元 + 探针 | `PROPOSED` |
| T-10 | 注入截断 | 按 principle 边界截断，journal-only `truncated:true`；无同步 DB | 单元 | `PROPOSED` |
| T-11 | 七维耗时测量 | 七维分别记录；`SessionStart` self 与 chain 分开；无阶段归因推断 | 探针 + 集成 | `PROPOSED` |
| T-12 | 分模式证据 | CLI/IDE/Desktop 三份 profile 独立；`SOURCE_CONFIRMED` 不被升格；PreCompact 文档/源码矛盾登记 | 静态契约测试 | `PROPOSED` |
| T-13 | 六阶段观察 | 每阶段独立 `status/evidenceGrade/timestamp/evidenceReference/assertedBy`；hook 不得断言 installed/loaded/confirmed/behavioral_effect | 集成 | `PROPOSED` |
| T-14 | 引擎基线守卫 | `--version` 与 `sha256sum` 等于冻结 profile，否则 SKIP（不得 faked green） | 探针前置守卫 | `PROPOSED` |
| T-15 | Compaction 契约 | PreCompact 不返回阻断结果、无 LLM；PostCompact 只置 `revalidationRequired`；`compact_summary` 不进 fingerprint | 单元 + 隔离探针 | `PROPOSED` |
| T-16 | 三维状态机不变量 | §13.4.2 六条不变量全部成立（含 `open` 不算成功、reconciliation 不升级） | 属性测试 | `PROPOSED` |
| T-17 | 统计验收 | 负载矩阵 + N + p95/p99 + 95% 上界报告；不得以「0 次失败」直接声明零风险 | 性能探针 | `PROPOSED` |
| T-18 | 跨 Session 污染 | 旧 session / `EXPIRED` profile 的 deferred 结果被丢弃并记 `worker_result_stale_discarded` | 集成 | `PROPOSED` |

**v0.1 测试纠正**：T-07 原断言「Task 事件时 `principle_decision` 调用数为 0」是错误断言（会固化错误映射）→ 改为 T-07′；T-08 原「两版 hooks.json 同时可发现」场景不成立 → 改为 T-08′；T-03 原未限定 journal-only → 已补；T-05/T-06 标 `DEFERRED_PENDING_EVIDENCE`。

---

# 6. 明确保留、不需要修改的设计

1. **§2.3 / §16 / ADR-001**：Runtime V2 是唯一治理权威；Selector / Host Adapter 不得创建、批准、撤销 Activation，不得绕过 Artifact Validation。
2. **§3.3 / ADR-002 / ADR-005**：Native 与 Model-assisted 双模共存；同步 prompt hook 默认不做外部模型推理。本轮生产降级再次证明该决定必要。
3. **§5.3**：`SessionStart` 不是通用会话边界，不得用于计数 / 判定新建 / 清空 Working Set。
4. **§5.9**：禁止把关键词 / regex / 固定任务映射当作主语义选择器。本次「no-semantic-bypass」规则是该原则的加强。
5. **§6**：`principle_decision` + `principle_selector` 两阶段、多标签选择、`NONE_APPLICABLE` 有效、Candidate 校验与 allowlist。
6. **§7**：只有一个 Working Set Resolver 产出最终集合；Hook 执行预算与 Prompt Capacity Budget 是两个独立预算；`fair_rotation_v1` 不跨宿主外推；不伪造 turn ordinal。
7. **§13.1 / ADR-011**：一个共享决策核心 + 宿主适配契约。本修正案不把 WorkBuddy 拆成独立选择系统。
8. **§15.4 / ADR-013**：`returned ≠ confirmed ≠ behavioral effect`。v0.2 的三维状态机是该纪律的实现，不是放宽。
9. **§11 / §0 Status / ADR-010**：所有 feature flag 默认 OFF、Shadow 不自动升 Live、Live 需 Owner 逐 profile 授权。degraded journal 是**强制 observability**，不是 feature flag（§11.2.1）。
10. **§1.2 Non-Goals**：不新建 Prompt Injection / Governance Activation / Model Runtime / Evidence 平台；不启用未验证的 Desktop/TUI/IDE 模式；不绕过 Working Set Selector v0.2 的 Hold gates。
11. **§12.5 原有 10 条规则**：尤其「只用宿主真实事件」「不伪造 ID」「不同 runtime mode 的 evidence 不互相填充」全部保留；v0.2 新增 11–16 条为加强。
12. **§18 评测框架**：E1–E5、数据集、指标与 Shadow 阈值保留。
13. **§13.2 Channel Matrix（A-20）**：v0.1 原文完全保留，仅追加 `confirmedClaimAllowed=false` 说明。

---

# 7. 保持 OFF / 等待真实探针的能力登记（A-48）

| 能力 | 状态 | 所需证据 | 不得做什么 |
|:---|:---|:---|:---|
| WorkBuddy host-native `async:true` refresh | `DEFERRED_PENDING_EVIDENCE` / OFF | 隔离 P6：detach、asyncTimeout、Session 退出后进程行为、结果提交校验 | 不得作为 Deferred Refresh 载体，不得写入 §3.1 架构图 |
| `PROBE_PENDING` 生命周期事件作为 refresh trigger | OFF | 隔离 P3/P4：真实派发、payload 形状、并发、Pre/PostCompact 时序 | 不得当 `Supported`，不得产出语义决策 |
| PD worker Deferred Refresh 契约 | OFF（基础设施已实现，契约 `NOT_FOUND`） | 契约实现 + T-18 + Gate 4 探针 | 不得把「已有 worker」等同于「已证明安全」 |
| 当前 2.165.0 的 `confirmed` 声明 | 禁止 | P1 mock-request 请求级证据 | 不得从 `returned` / 已知 channel / 无异常推断 |
| Model-assisted Shadow / Live | OFF | Gates 0–5 | 不得因宿主事件增多而提前启用 |
| Desktop UI-only / standalone IDE runtime | `NOT_RUN` | 独立模式隔离探针 | 不得跨模式填充证据 |
| 跨宿主统一 timeout / channel / 事件映射 | 禁止 | 各宿主独立 profile | 不得为形式统一牺牲宿主语义 |

---

# 8. 定稿检查清单（v0.2）

- [ ] A-01…A-48 经 Owner 审阅并逐条决定接受 / 修改 / 拒绝 / 延后。
- [ ] 特别确认三个方向性反转：① 删除 determinism-first rule；② Deferred Refresh 载体改回 PD 既有 worker；③ 交付证据改三维状态机。
- [ ] 以 5.9.2 / 2.165.0 / 0.2.2 重新冻结 WorkBuddy profile（含 engine SHA-256、`configSha256`、`rootFingerprint`）。
- [ ] P0 六步修复按 §19 顺序执行，阶段归因先于任何优化。
- [ ] 隔离 lab 重建，P1/P3/P4/P6 在 2.165.0 上执行；未通过前 A-48 各项保持 OFF。
- [ ] §25.1 Self-audit 全部改用状态阶梯，任何 `PROPOSED` 项不得标 `PASS`。
- [ ] `PD Host Event Capability Matrix v0.1` 原始证据路径补齐，或明确标注 HISTORICAL / 不可复核。
- [ ] 保持 SPEC v0.4 原文不变；本修正案作为独立文件进入 PR 评审。
- [ ] 本轮结束后停止：不修改生产代码、不实施功能、不创建 PR、不部署发布。

---

**END OF PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.2.md**
