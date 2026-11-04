# PD Adaptive Activation SPEC — WorkBuddy Amendment v0.2.1

> **PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.2.1.md**
> 对 `docs/specs/PD Adaptive Activation SPEC v0.4.md` 的正式修订提案（可直接合并为 SPEC v0.5）
>
> | 项 | 值 |
> |:---|:---|
> | 版本 | v0.2.1（以 v0.2 为基础，**保留其完整内容**，仅作七项定点修订） |
> | 日期 | 2026-11-04 |
> | 状态 | `READY_FOR_OWNER_REVIEW_WITH_OPEN_QUESTIONS` — 提案，**非已实现、非已验证、非 SPEC v0.5 已定稿** |
> | 宿主基线 | WorkBuddy Desktop `5.9.2` / 引擎 `@genie/agent-cli 2.165.0`（SHA-256 `6fbfd77bae7e7688abf7dfd2488b50c79390c966a9132e73ebe7a5a2d7df99cf`）/ Electron `37.10.3-43` / PD 插件 `0.2.2` |
> | 上游材料 | `PD_WORKBUDDY_HOST_AUDIT_v0.1.md`、`PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md`、`PD_WORKBUDDY_INTEGRATION_GAP_AUDIT_v0.1.md`、`PD_WORKBUDDY_EVIDENCE_MANIFEST_v0.1.md`、`PD_WORKBUDDY_AMENDMENT_ADVERSARIAL_REVIEW_v0.1.md`、`PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.2.md` |
> | 约束 | **不修改 SPEC v0.4 原文、不覆盖 v0.2、不修改第二轮审查报告**；本文件为独立修正案，经 Owner 审阅后由独立 PR 合并为 v0.5 |
> | 本轮纪律 | 只读核对已有证据；未修改生产代码 / 宿主配置 / 生产数据库 / 用户会话；未开启 Feature Flag、未进行 Shadow/Live、未执行真实宿主探针；未合并、未部署、未创建 PR、未提交 Git commit |
> | 基线 SHA-256（本轮开始前） | SPEC v0.4 `c022cd66a73d2d644e6b91e24df280b08772ae3a93e77a97e7b30268e5b520c4`；Amendment v0.2 `f8b0cd2381a815187f245f6a8f30b772869a5fc922e85f3736a669dc4988a83b`；第二轮审查报告 `763e783f8b45c6123e8bd65d50f9426490bd56cac1aa8cd9c2f944c50ca26d31` |

## 0.0 v0.2 → v0.2.1 修订说明

本轮是**定点修订**，不重复宿主调查，不扩张系统功能，不增加新的子系统。v0.2 的全部正式替换文本、类型定义、验收项、测试、ADR 与 Open Questions 均保留；仅针对下列七项问题做必要修改，并同步所有引用处。

| ID | 级别 | v0.2 的问题 | v0.2.1 的修订结果 | 主要落点 |
|:---|:---|:---|:---|:---|
| P0-1 | 高 | 用 `(session_id, task_id)` 去重会把同一 todo 的 `TaskCreated` 与 `TaskCompleted` 相互抵消；只用一个 `revalidationRequired`，可能间接触发语义重新决策 | 引入宿主真实事件唯一标识优先、复合键 `(hostProfileId, session_id, task_id, hook_event_name)` 兜底；拆分 `structuralRevalidationRequired` / `semanticReevaluationRequired`；`HOST_TASK_GRAPH_CHANGED` 只能给 provenance 与结构性失效信号，禁止间接触发语义重新决策 | §5.2.1 / §5.4 / §5.5 / §8.2 / §12.2 / §12.5 / §19 / §20 / §21 / §23 |
| P0-2 | 高 | Hook 执行结果、Payload 结果与用户提交结果混合，无法独立回答「提交是否被阻断」 | 新增第四观察维度 `HostSubmissionOutcome = proceeded \| blocked \| unknown`，默认 `unknown`，只有独立宿主证据才能升级；exit 2 / deny / continue:false 不再一律归为 timeout；不向其它宿主外推 | §13.4 / §14.3 / §14.5 / §15.2 / §15.4 / §15.5 / §20 / §21 / §23 |
| P1-1 | 中 | Journal 无调用标识，`open/closed/reconciled` 语义模糊，T0 证据等级用 `STATIC_CONFIG`，「无 T0」被当作 Host kill | 新增 `hookInvocationId`（wrapper 最早入口生成、全链路传递）；T0 证据等级改为运行时派发；三状态重新定义；「无 T0 ≠ Host kill」，无独立证据不得推断 blocked/timeout；对账结果可为 `unknown` 且 `reconciled` 不代表成功 | §13.4 / §14.5 / §15.2 / §15.2.1 / §15.3 / §19 / §20 / §23 |
| P1-2 | 中 | Flag OFF、无适用原则、`NONE_APPLICABLE` 统一归入 `skipped`，把正确语义判断记为跳过 | `SelectionStatus` 扩为 `selected \| none_applicable \| skipped \| unavailable`；`NONE_APPLICABLE` 保持 SPEC v0.4 的**有效决策**语义，Receipt / Selection / Scorer 三处一致 | §13.4 / §15.2 / §15.4 / §18(引用) / §20 / §23 |
| P1-3 | 中 | `configSha256` 只描述插件自身配置，未覆盖宿主实际合并出的有效 Hook 集合 | 拆分为 `pluginConfigSha256` 与 `effectiveHookSetFingerprint`；确定性规范化；只纳入源码证实参与注册的来源；声明 coverage `complete / partial / unknown`；覆盖不全不得标 `VERIFIED`；长期 Receipt 仍禁绝对路径；不新建配置管理系统 | §8.2 / §8.3.1 / §10.2 / §12.2 / §12.4 / §15.2 / §19 / §20 / §21 / §22 |
| P1-4 | 中 | 样本量（200/格）与「95% 上界 ≤1%」结论不匹配，可能用总体 N 借给单个分层 | 三层口径：性能观测（p99 需 CI/上界，200 不足即 `INSUFFICIENT_EVIDENCE`）、失败率验收（每个关键分层独立 N≥300 + 各自 Rule of Three，不混层，整体声明需多重比较方法）、发布裁定（证据不足标 `INSUFFICIENT_EVIDENCE`，不得 PASS） | §17.3.2 / §17.3.3 / §19 Gate 0 / §20 B / §21 / §25 |
| P2 | 低 | 评审接受状态、SPEC 修改状态、内容来源混在一列；A-20 等提前使用 `SPEC_REVISED` | 拆分 `Review Disposition` / `Implementation Status` / `Baseline Provenance`；新增 `RETAINED_FROM_V0_4`；`SPEC_REVISED` 严格限定为「已合入 SPEC v0.5」；A-20 更正为 `PROPOSED` | §0.2 / §1 / §3 / §4 / §5 / §25.1 / §23 |

**未改变的方向性结论**：宿主事件不得绕过语义判断；Deferred Refresh 载体为 PD 既有 worker、host async 保持 OFF；`confirmed` 无请求级证据不得声明；12 s 自降级是预算设定而非阶段归因；P0 生产问题仍开放。

## 0. 使用说明与状态阶梯

### 0.1 替换单元

以「章节内需替换的段落 / 表格 / 接口定义」为单位。每个替换文本均为**完整可粘贴**的正式 Markdown / TypeScript / YAML；未列出的段落保持 v0.4 原文不变。A-ID 为修正案条目编号，仅供评审与追溯，不进入 SPEC 正文。

### 0.2 三个必须分离的状态维度（v0.2.1 修订，P2）

v0.2 把「评审接受」与「正式 SPEC 修改状态」混在同一列。v0.2.1 起强制拆分为**三个互相独立**的维度：任何条款、验收项、Self-audit 行都必须能分别回答这三个问题，禁止用一个维度的值代替另一个。

#### 0.2.1 Review Disposition（评审结论）

| 值 | 含义 |
|:---|:---|
| `ACCEPT` | 审查意见为接受 |
| `ACCEPT_WITH_CHANGE` | 审查意见为修订后接受 |
| `REJECT` | 审查意见为拒绝（由替代条目承载） |
| `DEFERRED_PENDING_EVIDENCE` | 审查意见为延后，等待证据 |

> `ACCEPT` / `ACCEPT_WITH_CHANGE` **只代表审查意见**：不等于 Owner 已批准（`ACCEPTED`），
> 不等于 SPEC 已修改（`SPEC_REVISED`），也不等于代码已实现（`IMPLEMENTED`）。
> 评审矩阵中的 `ACCEPT` 一律不得被解读为治理授权，也不得据此启动 Shadow / Live。

#### 0.2.2 Implementation Status（实施阶段）

本修正案所有条款、验收项与 Self-audit 必须使用以下互斥状态，**禁止混用，禁止把提案标为 `PASS`**：

```
PROPOSED → SPEC_REVISED → IMPLEMENTED → TESTED → RUNTIME_VERIFIED → ACCEPTED
DEFERRED_PENDING_EVIDENCE （旁路状态：能力保持 OFF，等待隔离探针）
```

| 状态 | 严格定义 | 进入该状态所需证据 |
|:---|:---|:---|
| `PROPOSED` | **尚未进入正式 SPEC**；仅存在于本 Amendment | 本文件条目 |
| `SPEC_REVISED` | **已经正式合入 SPEC v0.5 文本**；无实现 | 已合并的 SPEC v0.5 文本与 commit |
| `IMPLEMENTED` | 实际代码已经实现；未测试 | 生产代码变更 |
| `TESTED` | 对应测试已经执行并通过；未在当前宿主运行验证 | 通过的测试记录 |
| `RUNTIME_VERIFIED` | 具备对应**当前安装版本**的运行时证据 | 真实运行日志 / 隔离探针 |
| `ACCEPTED` | Owner 明确批准 | Owner 批准记录 |
| `DEFERRED_PENDING_EVIDENCE` | 能力保持 OFF；所需证据未取得 | — |

> **禁止提前使用 `SPEC_REVISED`**：截至 v0.2.1，SPEC v0.5 尚不存在。本修正案所有
> 条目的 Implementation Status 一律为 `PROPOSED`（A-48 为 `DEFERRED_PENDING_EVIDENCE`）。
> v0.2 把 A-20 等条目标为 `SPEC_REVISED`（依据 `SOURCE_CONFIRMED`）属提前使用，
> 已在 §1 与 §25.1 更正为 `PROPOSED`。`SOURCE_CONFIRMED` 是证据等级，不是实施阶段。

#### 0.2.3 Baseline Provenance（内容来源）

| 值 | 含义 |
|:---|:---|
| `RETAINED_FROM_V0_4` | 原有 SPEC v0.4 设计继续保留，**不代表新修订已经完成** |
| `RETAINED_FROM_V0_2` | 完整沿用 Amendment v0.2 文本，本轮未改 |
| `REVISED_IN_V0_2_1` | 本轮定点修订过的 v0.2 内容 |
| `NEW_IN_V0_2_1` | 本轮新增内容 |

> 三个维度不可互相推导。`ACCEPT` + `PROPOSED` + `RETAINED_FROM_V0_2` 是合法组合；
> 在 SPEC v0.5 正式合入前，`ACCEPT` + `SPEC_REVISED` 是**非法组合**。
> `RETAINED_FROM_V0_4` 只说明来源，不构成对新增修订的实施状态声明。

### 0.3 证据等级纪律

`OFFICIAL_DOC` / `SOURCE_CONFIRMED` / `RUNTIME_VERIFIED` / `STATIC_CONFIG` / `HISTORICAL_PROBE` / `INFERRED` / `NOT_RUN` / `UNKNOWN` / `NOT_FOUND`。

- `SOURCE_CONFIRMED` **不得**升格为 `RUNTIME_VERIFIED`；`NOT_RUN` **不得**升格为 `Supported`。
- 官方文档、匹配版本源码、真实运行三者冲突时**分别登记**，按 §2.1 优先级为当前 profile 取值。
- `PROBE_PENDING`：源码确认存在但运行时零样本的状态；在 profile 中与 `NOT_RUN` 分开记录，**不得作为启用依据**。
- `INSUFFICIENT_EVIDENCE` **不是**证据等级、也**不是**状态阶梯的一环，而是 §17.3.3 的**统计发布裁定标签**；它与 `PASS` 互斥。任何样本量不足、置信区间不满足或关键分层缺数据的情形，必须标 `INSUFFICIENT_EVIDENCE`，不得标 `PASS`。
- 证据无法确定的内容保持 `UNKNOWN` / `PROPOSED`，不得编造结论。

### 0.4 v0.1 → v0.2 方向性变更（评审要点）

1. **删除** v0.1 的 `determinism-first rule`（把 `TaskCreated` 当确定性 `NEW_TASK` 并跳过 `principle_decision`）——`TaskCreated` 实为 Agent 内部 todo 工具通知。
2. **删除** 「async hook cannot outlive the session」——无源码证据且与源码行为相反。
3. **Deferred Refresh 载体**从宿主 `async:true` hook 改回 **PD 既有 detached worker**（`pd workbuddy worker` + Runtime V2 task lease），host async 保持 OFF。
4. **交付证据**从单维 `injectionStatus` 改为三维状态机 + 六阶段独立观察 + 封闭世界默认。
5. **配置残留**从「生产重复注入风险」降级为「物理残留 ≠ 可发现性」，绝对路径移出长期 Receipt。
6. **性能**从「degraded=0 即放行」改为统计上界验收；动态读取 `hooks.json` 明确定性为**正确性修复而非性能优化**。
7. **（v0.2 → v0.2.1）** 把「用户提交结果」从 Hook 执行状态中拆出为第四观察维度；把 Task 事件的**结构性重校验**与**语义重新决策**彻底隔离；`NONE_APPLICABLE` 恢复为独立有效决策；配置指纹拆分并声明 coverage；统计验收改为三层口径；评审 / 实施 / 来源三维度分离。
8. **（v0.2.1 不变项）** 七项修订全部属于**证据链与状态语义修复**：不新增子系统、不开启功能、不改变 Runtime V2 治理权威、不改变 v0.2 已确认的宿主事实基线，也不改变「P0 生产问题仍开放」的结论。

---

## 1. 修订总表（A-01 … A-48）

> **v0.2.1 状态口径修正（P2）**：本表是 v0.2 的**评审记录**。表头「v0.2 裁定」属于
> **Review Disposition**（审查意见；`ACCEPT` 不代表 Owner 已批准、不代表 SPEC 已修改、
> 不代表代码已实现）。表头「状态」在 v0.2 中被当作 Implementation Status 使用，
> v0.2.1 按 §0.2 重新解释：**所有条目当前的 Implementation Status 一律为 `PROPOSED`**
> （A-48 为 `DEFERRED_PENDING_EVIDENCE`）。Baseline Provenance 逐项见 §9.2。
>
> **特别更正**：A-20 在 v0.2 中标为 `SPEC_REVISED`（依据 `SOURCE_CONFIRMED`），属
> **提前使用**——`SOURCE_CONFIRMED` 是证据等级而非实施阶段，且 SPEC v0.5 尚未合入。
> v0.2.1 将 A-20 更正为 `PROPOSED`，Baseline Provenance = `RETAINED_FROM_V0_2`。
> 同理，§25.1 中所有 `SPEC_REVISED` 行已按 §9.2 更正。
>
> 下表「状态」列保留为 **v0.2 历史记录**，不作为 v0.2.1 的实施状态声明；本轮七项
> 定点修订涉及的条目在「§9.1 类型与状态转换总表」中单独标注 `REVISED_IN_V0_2_1`。

| A-ID | 主题 | Review Disposition（v0.2 审查意见） | v0.2 状态（历史记录，非 v0.2.1 实施状态） |
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
| A-20 | §13.2 Channel Matrix | **ACCEPT** | `SPEC_REVISED`（v0.2 历史记录；**v0.2.1 更正为 `PROPOSED`**） |
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
| **A-39** | Delivery Integrity 状态机（v0.2 三维 → v0.2.1 四维） | **NEW / ACCEPT** | `PROPOSED` |
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
| Amendment review baseline     | `PD_WORKBUDDY_AMENDMENT_ADVERSARIAL_REVIEW_v0.1.md` (2026-11-04); superseded by `PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.2.md` and this Amendment **v0.2.1** (2026-11-04), status `READY_FOR_OWNER_REVIEW_WITH_OPEN_QUESTIONS`; all proposals are `PROPOSED`, unverified capabilities are `DEFERRED_PENDING_EVIDENCE` |
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
  pluginConfigSha256?: string;             // plugin's own config files
  effectiveHookSetFingerprint?: string;    // host-resolved effective hook set
  effectiveSourceCoverage?: "complete" | "partial" | "unknown";
  hookInvocationId?: string;    // journal correlation; generated at wrapper entry
  hookEventName?: string;       // native event name; dedup key component
  hostRequestId?: string;       // only when the host actually supplies one
  correlationStatus: "correlated" | "unreliable" | "unknown";

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
  `pdPluginVersion`, `pluginConfigSha256`,
  `effectiveHookSetFingerprint` or `hostProfileRevision` invalidates
  the profile-bound Working Set until `resolveHostProfile()` re-verifies it.
- `effectiveSourceCoverage` of `partial` / `unknown` caps the profile at
  `CONDITIONALLY_VERIFIED`; a fully `VERIFIED` profile requires complete
  coverage (§8.3.1).
- `hookInvocationId`, `hookEventName` and `correlationStatus` are derived
  from real host/wrapper data only. Missing identity fields yield
  `unreliable` / `unknown`, never a fabricated id (§5.2.2).
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
  pluginConfigSha256?: string;
  effectiveHookSetFingerprint?: string;
  effectiveSourceCoverage?: "complete" | "partial" | "unknown";
  hookInvocationId?: string;    // journal correlation
  hookEventName?: string;       // native hook_event_name; dedup key component
  hostRequestId?: string;       // only when the host actually supplies one
  correlationStatus: "correlated" | "unreliable" | "unknown";
  generationId?: string;     // absent on Task/Compaction events
  hostTaskId?: string;       // from snake_case `task_id`
  agentId?: string;
  sessionSource?: "startup" | "resume" | "clear" | "unknown";
  semanticAuthority: false;  // host events NEVER produce a TaskChangeType decision
  triggerClass: "structural" | "provenance_only";  // never "semantic"
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

`HOST_TASK_GRAPH_CHANGED` may only (a) record provenance and (b) set
`structuralRevalidationRequired`. It MUST NOT set
`semanticReevaluationRequired`, enqueue a semantic decision task, or cause
the next verified `BEFORE_MODEL_TURN` to re-run `principle_decision`
indirectly. `teammate_name` / `team_name` are optional agent/team labels
and MUST NOT be read as user attribution.

#### 5.2.2 Event Correlation and Dedup Key (NEW, v0.2.1)

A `TaskCreated` and a `TaskCompleted` for the same todo item are **two
distinct host events** and MUST be retained separately. Using
`(session_id, task_id)` alone would deduplicate them into one record and is
prohibited.

Priority order for the correlation key:

1. A **real host-provided event unique identifier**, if that payload
   actually supplies one. For WorkBuddy engine 2.165.0 `TaskCreated` /
   `TaskCompleted` payloads no dedicated event id was found; its existence
   is `UNKNOWN` (OQ-26) and MUST NOT be assumed or fabricated.
2. Otherwise the composite key
   `(hostProfileId, session_id, task_id, hook_event_name)`. The
   `hook_event_name` component is mandatory: it keeps `TaskCreated` and
   `TaskCompleted` distinct. `session_id` is the session-level host field
   (`parentSessionId ?? session.id`), not a request id.
3. If the host supplies a request id (`generation_id`,
   `conversationRequestId`) for that event, it MAY be attached as an extra
   `hostRequestId` correlation attribute. It MUST NOT be invented when
   absent — Task and Compaction payloads do not carry it.

No adapter may fabricate `generation_id`, `turn_id`, `parentTaskId`, a
plan-item hierarchy, or a synthetic turn ordinal. When a required identity
field is missing, the record MUST be marked
`correlationStatus: "unreliable"` (or `"unknown"` when nothing can be
established) and MUST NOT be used to join events, merge Working Sets, or
trigger any reevaluation.

#### 5.2.3 Structural Revalidation vs Semantic Reevaluation (NEW, v0.2.1)

These are two different operations and MUST remain independent:

| Aspect | `structuralRevalidationRequired` | `semanticReevaluationRequired` |
|:-------|:---------------------------------|:-------------------------------|
| Checks | Working Set revision; Host Profile validity; `pluginConfigSha256` / `effectiveHookSetFingerprint` consistency; Activation and Artifact validity; cache / result expiry | Whether the user's task context has materially changed |
| May call `principle_decision` | **No** | **Yes** — and only via that path |
| May change `selectedPrincipleIds` | **No** | Only through a validated selection result |
| May be set by a host event | **Yes** (`HOST_TASK_GRAPH_CHANGED`, `HOST_POST_COMPACT`, `HOST_SESSION_ENDED`) | **No** |
| Authorized triggers | Any verified structural signal | Only a **verified user semantic change**, or a semantic trigger explicitly authorized in SPEC v0.4 §5 (`FOCUS_REVISION_CHANGED`, `PERIODIC_CHECKPOINT`, `CONTEXT_FINGERPRINT_CHANGED` under §5.5 throttling, `ACTIVATION_REVISION_CHANGED` revalidation) |

`HOST_TASK_GRAPH_CHANGED` is a **structural-only** signal. It MUST NOT set a
semantic flag, MUST NOT enqueue a deferred semantic task, MUST NOT mark the
next `BEFORE_MODEL_TURN` as requiring re-decision, and MUST NOT be used as a
proxy for `NEW_TASK` / `GOAL_SHIFT` / `PHASE_SHIFT`. Structural revalidation
that finds an invalid Activation or Artifact falls back to Native; it does
not ask the model to re-classify the task.

`principle_decision` remains the **sole semantic authority**. The Host
Adapter never performs or schedules semantic classification on its behalf.
```

## 2.7 §5.4 Trigger Conditions — A-37（取代 A-08）

**替换** §5.4 整个表格与其后一句：

```markdown
| Trigger                        | Class | Description                                                            | Action                                                                                                     |
|:-------------------------------|:------|:-----------------------------------------------------------------------|:-----------------------------------------------------------------------------------------------------------|
| `INITIAL_SESSION`              | `STRUCTURAL` | No valid Working Set exists when a verified prompt event arrives      | Native immediately; enqueue deferred initialization only if a safe worker exists                           |
| `HOST_TASK_GRAPH_CHANGED`      | `STRUCTURAL` | Agent-internal plan item created/completed (`task_id`, snake_case)    | Record provenance using the §5.2.2 correlation key; set `structuralRevalidationRequired=true`; **no Decision Model call, no selection, no semantic flag** |
| `HOST_SUBAGENT_SCOPE_CHANGED`  | `PROVENANCE_ONLY` | Subagent session started/stopped                                 | Record scope hint only; **no revalidation flag, no selection**                                            |
| `HOST_SESSION_ENDED`           | `STRUCTURAL` | `SessionEnd` (best-effort, not guaranteed)                             | Best-effort cleanup + `structuralRevalidationRequired=true`; idle TTL remains authoritative               |
| `HOST_POST_COMPACT`            | `STRUCTURAL` | `PostCompact` (`compact_summary` is lossy metadata only)              | Invalidate cached fingerprint; set `structuralRevalidationRequired=true`; **no injection, no blocking, no selection, no fingerprint recompute from the summary** |
| `HOST_TASK_BOUNDARY`           | `SEMANTIC_AUTHORIZED` | A verified host boundary that is proven to carry user-task semantics | Enqueue deferred Decision Model. **No WorkBuddy event currently qualifies.**                          |
| `FOCUS_REVISION_CHANGED`       | `SEMANTIC_AUTHORIZED` | Workspace Focus revision changes (SPEC v0.4 authorized)            | Enqueue Decision Model                                                                                     |
| `CONTEXT_FINGERPRINT_CHANGED`  | `SEMANTIC_AUTHORIZED` | Local context fingerprint changes materially (SPEC v0.4 authorized) | Consider bounded refresh under §5.5 throttling                                                            |
| `PERIODIC_CHECKPOINT`          | `SEMANTIC_AUTHORIZED` | A safe per-session checkpoint is reached (SPEC v0.4 authorized)     | Enqueue Decision Model under the throttling rules in §5.5                                                  |
| `COMPACTION_RESUME`            | `STRUCTURAL` | A verified compaction/resume signal is available                     | Revalidate cached state only; do not assume all hosts support it                                           |
| `WORKING_SET_EXPIRED`          | `STRUCTURAL` | Working Set TTL or validity has expired                              | Native immediately; no semantic re-decision unless a §5-authorized semantic trigger fires                |
| `ACTIVATION_REVISION_CHANGED`  | `STRUCTURAL` | Relevant activation state changes                                    | Revalidate selected IDs before delivery; no re-selection                                                   |

A trigger can request a refresh; it cannot itself authorize a principle.
A host event can supply technical timing, provenance or **structural**
invalidation; it can never supply semantic task classification.

`STRUCTURAL` and `PROVENANCE_ONLY` triggers MUST NOT set
`semanticReevaluationRequired`, MUST NOT enqueue `principle_decision`, and
MUST NOT cause the next verified `BEFORE_MODEL_TURN` to re-run semantic
classification indirectly (§5.2.3). Only `SEMANTIC_AUTHORIZED` triggers may
set `semanticReevaluationRequired`, and the resulting classification is
performed exclusively by `principle_decision`.

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
  counter; they set only `structuralRevalidationRequired` (or nothing).
  They MUST NOT set `semanticReevaluationRequired`.
- `SessionStart` with `source: "resume"` and `source: "clear"` may dispatch
  repeatedly and MUST NOT be counted as a new user turn.
- A `PreToolUse` hook that returns `continue: false` causes the host to
  re-submit the user prompt, which fires `UserPromptSubmit` again in the
  same turn. The WorkBuddy adapter MUST NOT emit `continue: false`.
- Every refresh request is idempotent on the tuple
  `(hookInvocationId, hostProfileId, sessionId, [generationId],
  [hostTaskId], hook_event_name, contextFingerprint, workingSetRevision)`.
  `hookInvocationId` and `hook_event_name` are mandatory so that a
  `TaskCreated` and a `TaskCompleted` for the same todo item are never
  deduplicated into one record (§5.2.2). Bracketed fields are optional:
  when the source event does not supply `generation_id` or `task_id`, the
  key MUST omit them rather than substitute a fabricated value. A record
  with `correlationStatus: "unreliable" | "unknown"` MUST NOT participate
  in merging or in any reevaluation.
- `periodKey` remains derived only from a verified, deduplicated user-turn
  sequence; no host event may create a fabricated host turn ordinal.
- Structural revalidation and semantic reevaluation are independent
  (§5.2.3). A structural flag MUST NOT be consumed, promoted, or
  reinterpreted as a semantic trigger at any later checkpoint, including
  the next `BEFORE_MODEL_TURN`.
```

## 2.9 §8 Working Set Persistence — A-10 + A-42

**在 §8.2 `SessionWorkingSet` 接口内增补字段（A-10）**：

```typescript
  generationId?: string;      // absent on Task/Compaction-sourced refreshes
  hostTaskId?: string;        // Agent-internal plan item; provenance only
  hookEventName?: string;      // native hook_event_name; part of the dedup key
  hookInvocationId?: string;   // generated at wrapper entry; journal correlation
  hostRequestId?: string;      // only when the host actually supplies one
  correlationStatus: "correlated" | "unreliable" | "unknown";
  sessionSource?: "startup" | "resume" | "clear" | "unknown";
  engineVersion: string;
  engineSha256?: string;
  pluginConfigSha256?: string;
  effectiveHookSetFingerprint?: string;
  effectiveSourceCoverage?: "complete" | "partial" | "unknown";
  pdPluginVersion?: string;
  lastHostEvent?: CanonicalEventType;
  structuralRevalidationRequired: boolean;  // set ONLY by structural signals
  semanticReevaluationRequired: boolean;    // set ONLY by §5.4 SEMANTIC_AUTHORIZED triggers
  preCompactRevision?: number;              // compaction consistency fence
```

**在 §8.2 Rules 列表追加**：

```markdown
- A change in `engineVersion`, `engineSha256`, `pluginConfigSha256`,
  `effectiveHookSetFingerprint`, `pdPluginVersion`, `runtimeMode`, or
  `hostProfileRevision` invalidates the result until
  `resolveHostProfile()` re-verifies it (implements §12.1).
- `SessionEnd` is best-effort and MUST NOT be the sole cleanup trigger;
  idle TTL remains authoritative.
- On `HOST_POST_COMPACT`, DO NOT recompute `contextFingerprint` from
  `compact_summary` and DO NOT change `selectedPrincipleIds`. Set
  `structuralRevalidationRequired = true`, leave
  `semanticReevaluationRequired` unchanged, and retain
  `preCompactRevision`. The next verified `BEFORE_MODEL_TURN` recomputes the
  fingerprint from the actual current context and revalidates; on mismatch,
  fall back to Native. This is structural work only (§5.2.3).
- `HOST_TASK_GRAPH_CHANGED` may set only `structuralRevalidationRequired`.
  It MUST NOT change `selectedPrincipleIds`, set
  `semanticReevaluationRequired`, invoke `principle_decision`, or cause a
  semantic re-decision at the next `BEFORE_MODEL_TURN`.
- Structural revalidation checks only: Working Set revision, Host Profile
  validity, fingerprint consistency, Activation / Artifact validity, and
  cache / result expiry. It MUST NOT call any model and MUST NOT alter
  `selectedPrincipleIds`. Semantic reevaluation is reserved for a verified
  user semantic change or a SPEC v0.4 §5-authorized semantic trigger, and
  is performed only by `principle_decision` (§5.2.3).
- A revision-fenced result whose `sessionId`, `workingSetRevision`,
  `contextFingerprint` or `hostProfileId` no longer matches the current
  turn MUST be discarded (stale-result discard).
- `correlationStatus` MUST be derived only from host-supplied fields.
  Missing identity fields remain missing and yield `unreliable` or
  `unknown`, never a fabricated identifier (§5.2.2).
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

Required controls (v0.2.1 — two distinct fingerprints):

- `pluginConfigSha256` describes **the plugin's own configuration files**
  only: the enabled plugin's `hooks/hooks.json` plus, when present, the
  manifest `hooks` field. It answers "has the plugin's declared config
  changed?".
- `effectiveHookSetFingerprint` describes **the effective Hook set the host
  actually resolves and merges**. Only configuration sources that are
  `SOURCE_CONFIRMED` to participate in hook registration may be included.
  For engine 2.165.0 the confirmed sources are: the plugin manifest
  `hooks` field, the default `hooks/hooks.json` of the resolved root
  (`HookExtensionLoader.load`), and the sources merged in `getHooks`
  (user settings `hooks`, `loadHooksFromPlugins`, scoped hook registry).
  Any source that cannot be observed at runtime MUST NOT be assumed to be
  covered.
- Both fingerprints use a deterministic canonicalization
  (`canonical-v1`): UTF-8, stable key ordering, whitespace-normalized,
  event name → matcher → hook entries in declaration order, `${...}`
  placeholders resolved to a stable symbolic form rather than an absolute
  path. The normalization version is stored with the profile so a change in
  normalization itself can be detected.
- `effectiveSourceCoverage` MUST be recorded as
  `complete | partial | unknown`, together with
  `coveredConfigSources: string[]` (source **names**, never absolute paths)
  and `unobservableSourcesNote?: string`. For the current 2.165.0 profile
  it is `partial`: the host-side `getHooks` merge is source-confirmed but
  its runtime content is not fully observable from PD.
- A profile with `effectiveSourceCoverage` of `partial` or `unknown` MUST
  NOT be declared fully `VERIFIED`; the maximum is
  `CONDITIONALLY_VERIFIED`. The `VERIFIED` status requires `complete`
  coverage plus `RUNTIME_VERIFIED` evidence of the effective hook set.
- At hook entry, verify both fingerprints against the profile-bound
  values. On mismatch, return a neutral payload and write a journal line
  with `execution: "degraded"`,
  `degradationReason: "hook_config_mismatch"`. A known fingerprint change
  continues to enforce `EXPIRED` + Native-only (§12.1).
- Verify that the same event is not registered twice from two config
  sources of one root; if it is, emit
  `hook_config_source_concat_detected` and return neutral.
- `deduplicateHooks` deduplicates identical command strings only; it MUST
  NOT be relied upon for version or source deduplication.
- **Non-goal:** these two fingerprints are derived integrity anchors
  computed by `resolveHostProfile()`. They do NOT create a new
  configuration management system, a new config authority, or a second
  source of truth for hook registration; the installed host configuration
  remains authoritative.

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
      pluginConfigSha256: "<canonical-v1 hash of enabled plugin config files>"
      effectiveHookSetFingerprint: "<canonical-v1 hash of host-resolved effective hook set>"
      fingerprintNormalization: "canonical-v1"
      effectiveSourceCoverage: "partial"   # complete | partial | unknown
      coveredConfigSources:
        - "plugin_manifest_hooks"
        - "plugin_root_hooks_json"
        - "host_getHooks_merge"
      unobservableSourcesNote: "runtime content of host-side getHooks merge is not fully observable from PD"
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
  `hooks/hooks.json`, compute `pluginConfigSha256`,
  `effectiveHookSetFingerprint` and `rootFingerprint`, compare them with the
  frozen profile, and set `profile.status = EXPIRED` on any mismatch. On
  `EXPIRED`, fall back to Native-only and discard deferred results bound to
  the old profile.
- `effectiveSourceCoverage` MUST be declared explicitly. `partial` or
  `unknown` coverage caps `profile.status` at `CONDITIONALLY_VERIFIED`;
  a fully `VERIFIED` profile requires complete coverage plus runtime
  evidence. No unobservable host configuration source may be assumed to
  be covered (§8.3.1).
- The host engine contains no `pluginConfigSha256` / `effectiveHookSetFingerprint`
  / `rootFingerprint` / coverage mechanism; PD computes all of them.
  Absolute plugin paths are never written to long-term receipts. These
  fingerprints are integrity anchors only — they do not create a
  configuration management system or a second config authority.
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
  pluginConfigSha256: string;    // plugin's own config files (manifest hooks + hooks/hooks.json)
  effectiveHookSetFingerprint: string; // host-resolved + merged effective hook set
  fingerprintNormalization: string;    // e.g. "canonical-v1"
  effectiveSourceCoverage: "complete" | "partial" | "unknown";
  coveredConfigSources: string[];      // source NAMES only, never paths
  unobservableSourcesNote?: string;
  rootFingerprint: string;       // sha256(marketplaceId|pluginId|version|pluginConfigSha256)
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
    triggerClass: "structural" | "provenance_only";  // NEW v0.2.1: never "semantic"
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
    hookEventName: "verified" | "partial" | "unavailable";  // NEW: dedup key component
    hookInvocationId: "verified" | "partial" | "unavailable"; // NEW: journal correlation
    eventUniqueId: "verified" | "partial" | "unavailable";   // NEW: host-provided, if any
    turnId: "verified" | "partial" | "unavailable";
    deduplication: "verified" | "partial" | "unavailable";
    correlationStatus: "correlated" | "unreliable" | "unknown";
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
    /** NEW v0.2.1: whether independent host evidence for submission outcome exists. */
    submissionOutcomeEvidence: "host_log" | "request_probe" | "none" | "unknown";
    submissionOutcomeDefault: "unknown";
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
  status: ProfileStatus;         // VERIFIED requires effectiveSourceCoverage === "complete"
  /** NEW v0.2.1: implementation status is INDEPENDENT of profile status. */
  implementationStatus:
    | "PROPOSED" | "SPEC_REVISED" | "IMPLEMENTED" | "TESTED"
    | "RUNTIME_VERIFIED" | "ACCEPTED" | "DEFERRED_PENDING_EVIDENCE";
  reviewDisposition?: "ACCEPT" | "ACCEPT_WITH_CHANGE" | "REJECT" | "DEFERRED_PENDING_EVIDENCE";
  baselineProvenance: "RETAINED_FROM_V0_4" | "RETAINED_FROM_V0_2"
                    | "REVISED_IN_V0_2_1" | "NEW_IN_V0_2_1";
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
  `boundaryClass: "agent_internal_plan"`, `triggerClass: "structural"` and
  carry `semanticAuthority: false`. They are correlated with the §5.2.2
  composite key and MUST NOT be deduplicated against each other. WorkBuddy
  Desktop UI-only capabilities remain `NOT_RUN`; the Desktop's hook engine
  itself is verified because it runs as the CLI engine subprocess inside
  the Desktop process tree.
- The current profile records `effectiveSourceCoverage: "partial"`:
  the host-side `getHooks` merge is `SOURCE_CONFIRMED` but its runtime
  content is not fully observable from PD. Therefore the profile MUST NOT
  be declared fully `VERIFIED`; `CONDITIONALLY_VERIFIED` is the maximum
  until coverage is `complete` and the effective hook set is
  `RUNTIME_VERIFIED` (§8.3.1, §10.2).
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
- `pluginConfigSha256` + `effectiveHookSetFingerprint` + `rootFingerprint`
  identify the enabled plugin configuration and the host-resolved effective
  hook set separately. `effectiveSourceCoverage` is declared `partial` for
  this profile; a `partial` / `unknown` coverage caps `profile.status` at
  `CONDITIONALLY_VERIFIED`. Physical presence of stale version directories
  is not evidence of duplicate registration (§8.3.1). Long-term receipts
  carry fingerprints and source **names**, never absolute paths.
- `HostSubmissionOutcome` is an **independent fourth observation
  dimension**. It defaults to `unknown` and may be upgraded to `proceeded`
  or `blocked` only with independent host evidence (host log / request
  probe). `exit 2`, `deny`, `continue:false` and host kill are recorded by
  their actual Hook execution result; they MUST NOT all be classified as
  `timeout`, and a Hook failure MUST NOT by itself imply a blocked
  submission (§13.4). This WorkBuddy-specific failure semantics MUST NOT
  be extrapolated to OpenClaw or Codex.
- `structuralRevalidationRequired` and `semanticReevaluationRequired` are
  independent. `PROBE_PENDING` lifecycle / Task events may set only the
  former; only a verified user semantic change or a SPEC v0.4 §5-authorized
  semantic trigger may set the latter, and only `principle_decision` may
  perform it (§5.2.3).
- `TaskCreated` and `TaskCompleted` are correlated with the §5.2.2
  composite key, retained as distinct events, and never used to skip or
  indirectly trigger `principle_decision`.
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
    select / activate / deactivate a principle. A structural
    revalidation signal MUST NOT be promoted into a semantic reevaluation
    at the next `BEFORE_MODEL_TURN` (§5.2.3).
17. Host event deduplication MUST use the §5.2.2 key. `TaskCreated` and
    `TaskCompleted` are distinct events; missing identity fields are
    recorded as `unreliable` / `unknown`, never fabricated.
18. Hook execution state, payload state, selection state and **host
    submission outcome** are four independent observations. No observation
    may be inferred from another, and host-specific failure semantics
    MUST NOT be generalized across hosts (§13.4).
19. `pluginConfigSha256` and `effectiveHookSetFingerprint` are distinct.
    Only `SOURCE_CONFIRMED` participating config sources may be included;
    coverage MUST be declared; a profile with incomplete coverage MUST NOT
    be declared fully `VERIFIED` (§8.3.1).
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

Delivery is described by **four independent observation dimensions plus
evidence and journal state**. No single `injectionStatus` enum may combine
them. The four dimensions are:

1. `HookExecutionStatus` — how the PD hook process ended.
2. `PayloadStatus` — what happened to the injection payload.
3. `SelectionStatus` — what the selection stage decided.
4. `HostSubmissionOutcome` — whether the **user submission** proceeded,
   was blocked, or is unknown. This is a host-level observation and MUST
   NOT be inferred from any of the first three.

```typescript
type HookExecutionStatus =
  | "completed"   // hook returned normally (exit 0)
  | "degraded"    // hook intentionally returned neutral because of a
                  // self-imposed deadline, dependency failure or resource limit
  | "timeout"     // host or wrapper killed the process, WITH host evidence
  | "failed"      // execution or encoding error
  | "unknown";    // termination cause cannot be established

type PayloadStatus =
  | "none"        // no payload produced (policy, valid empty selection, or degradation)
  | "prepared"    // renderer produced content, not yet returned
  | "returned"    // adapter wrote payload to stdout, host accepted
  | "confirmed"   // independent request-level evidence of entry into the
                  // current model request
  | "unknown";    // cannot be established (missing evidence)

type SelectionStatus =
  | "selected"         // semantic judgment succeeded; principles selected
  | "none_applicable"  // semantic judgment succeeded; VALID EMPTY DECISION
  | "skipped"          // policy or feature flag decided NOT to run selection
  | "unavailable";     // dependency failure prevented selection

type HostSubmissionOutcome =
  | "proceeded"   // independent host evidence: the user submission continued
  | "blocked"     // independent host evidence: the submission was blocked
  | "unknown";    // DEFAULT; no independent host evidence

type ReceiptState = "open" | "closed" | "reconciled";

type EvidenceGrade =
  | "OFFICIAL_DOC" | "SOURCE_CONFIRMED" | "RUNTIME_VERIFIED"
  | "STATIC_CONFIG" | "HISTORICAL_PROBE" | "INFERRED"
  | "PROBE_PENDING" | "NOT_RUN" | "UNKNOWN" | "NOT_FOUND";

interface DeliveryEvidence {
  evidenceGrade: EvidenceGrade;
  evidenceReference?: string;   // mandatory for "confirmed" and for non-unknown submission outcomes
  observedAt: string;           // ISO 8601
  independentlyVerified: boolean;
}

interface DeliveryIntegrity {
  hookInvocationId: string;          // generated at the earliest wrapper entry
  hostRequestId?: string;            // only when the host actually supplies one
  correlationStatus: "correlated" | "unreliable" | "unknown";

  receiptState: ReceiptState;
  execution: HookExecutionStatus;    // "unknown" while "open"
  payload: PayloadStatus;            // "unknown" while "open"
  selection: SelectionStatus;        // "unavailable" while "open"
  submission: HostSubmissionOutcome; // "unknown" while "open" — INDEPENDENT

  evidence: DeliveryEvidence;
  reconciliation?: {
    source: "journal" | "host_log" | "request_diff" | "worker";
    at: string;
    note?: string;
    outcome?: "confirmed" | "unknown" | "timeout";
  };
}
```

### 13.4.0 ReceiptState semantics (NEW, v0.2.1)

| State | Meaning |
|:------|:--------|
| `open` | A T0 journal line exists: the invocation **has started**, no terminal record yet. It is NOT a success, NOT a timeout and NOT a blocked submission. |
| `closed` | The hook produced a **terminal record** (T2 / T4a / T4b / T4c / D1 / D2) — any outcome, including failure, degradation or a valid empty selection. |
| `reconciled` | Background reconciliation **has completed**, regardless of its result (`confirmed`, `unknown` or `timeout`). `reconciled` NEVER means delivery succeeded. |

### 13.4.1 State transitions

| # | Condition | Transition |
|:--|:----------|:-----------|
| T0 | Earliest controllable wrapper entry, before expensive work | Generate `hookInvocationId`; append one `open` line with `payload=unknown`, `selection=unavailable`, `execution=unknown`, `submission=unknown`, `evidenceGrade=RUNTIME_VERIFIED` (the PD hook process is actually running — this is **runtime dispatch evidence of the PD hook**, not host request evidence), `independentlyVerified=false`. |
| T1 | Renderer produced content | `payload=prepared`, `selection=selected` |
| T2 | Payload written to stdout, exit 0 | `closed`, `execution=completed`, `payload=returned` |
| T3 | Independent request-level evidence obtained | `reconciled`, `payload=confirmed`, `evidenceGrade=RUNTIME_VERIFIED`, `evidenceReference` present, `independentlyVerified=true` |
| T4a | Selection succeeded with no applicable principle (`NONE_APPLICABLE`) | `closed`, `execution=completed`, `payload=none`, `selection=none_applicable` |
| T4b | Policy / feature flag decided not to run selection | `closed`, `execution=completed`, `payload=none`, `selection=skipped` |
| T4c | Dependency failure prevented selection | `closed`, `execution=failed`, `payload=unknown`, `selection=unavailable` |
| D1 | Self-deadline / dependency / resource limit | `closed`, `execution=degraded`, `payload=none` |
| D2 | Encoding or execution error | `closed`, `execution=failed`, `payload=unknown` |
| D3 | Host or wrapper killed the process **and independent host evidence exists** | Reconciliation sets `execution=timeout`, `payload=unknown`, `receiptState=reconciled`, `reconciliation.outcome="timeout"` |
| D4 | T0 exists, no terminal line, **no independent host evidence** | Reconciliation sets `execution=unknown`, `payload=unknown`, `submission=unknown`, `receiptState=reconciled`, `reconciliation.outcome="unknown"`. **Never `returned`, `confirmed`, `timeout` or `blocked`.** |
| D5 | Reconciliation with independent request-level evidence | `receiptState=reconciled`, `payload=confirmed` (T3) |
| D6 | **No T0 line at all** | Record as `execution=unknown`, `payload=unknown`, `submission=unknown`, `correlationStatus="unknown"`. **No T0 is NOT evidence of host kill, timeout, or blocked submission**; it may mean the wrapper never started, the journal write failed, or the record was lost. |
| S0 | Default at T0 | `submission=unknown` |
| S1 | Independent host evidence that the turn continued | `submission=proceeded`, with `evidenceReference` |
| S2 | Independent host evidence that the submission was rejected | `submission=blocked`, with `evidenceReference` |

**Host submission outcome scenario table (normative):**

| Scenario | `HookExecutionStatus` | `HostSubmissionOutcome` |
|:---------|:----------------------|:------------------------|
| Normal exit 0 | `completed` | `proceeded` **only with host evidence**; otherwise `unknown` |
| `exit 1` self-degradation | `degraded` (or `failed` by actual record) | `proceeded` **only with host evidence**; otherwise `unknown` |
| `exit 2` | recorded by its **actual** execution result | `blocked` **only with host evidence**; otherwise `unknown` |
| `deny` / `continue:false` | recorded by its **actual** execution result | `blocked` **only with host evidence**; otherwise `unknown` |
| Host kill | `timeout` **only with host evidence**; otherwise `unknown` | determined by host evidence; otherwise `unknown` |
| Unexplained process termination | `unknown` | `unknown` |

`exit 2`, `deny`, `continue:false` and host kill MUST NOT all be collapsed
into `timeout`. A Hook execution failure MUST NOT by itself imply that the
user submission was blocked. `HostSubmissionOutcome` defaults to `unknown`
and may be upgraded only by **independent host evidence** (host log,
request probe), never by PD's own exit code or by absence of an error.
This WorkBuddy-specific failure semantics MUST NOT be generalized to
OpenClaw or Codex.

### 13.4.2 Invariants (MUST hold)

1. `payload === "confirmed"` ⇒ `execution === "completed"` ∧
   `evidence.independentlyVerified === true` ∧
   `evidence.evidenceReference` is present.
2. `execution ∈ {"degraded","timeout","failed","unknown"}` ⇒
   `payload ∉ {"returned","confirmed"}`.
3. `selection === "unavailable"` ⇒ `payload ∈ {"unknown","none"}` and
   `execution ∈ {"failed","unknown"}`.
4. `selection === "none_applicable"` ⇒ `payload === "none"` and the record
   is a **successful semantic decision**, not a failure and not a skip.
5. `receiptState === "open"` ⇒ `payload === "unknown"` ∧
   `submission === "unknown"`, and the record MUST NOT be counted as a
   success.
6. `submission !== "unknown"` ⇒ `evidence.evidenceReference` is present
   and `evidence.independentlyVerified === true`.
7. `execution === "timeout"` ⇒ independent host evidence of a kill exists;
   `execution === "unknown"` otherwise.
8. `submission === "blocked"` MUST NOT imply `execution === "timeout"`,
   and `execution ∈ {"failed","degraded","timeout"}` MUST NOT imply
   `submission === "blocked"`.
9. Reconciliation MUST NOT upgrade `unknown` or `none` to `returned` or
   `confirmed` without positive independent evidence, and MUST NOT upgrade
   `submission=unknown` without host evidence.
10. `receiptState === "reconciled"` carries no implication of success;
    only `payload === "confirmed"` counts as delivered success in scoring.
11. `confirmed` is not equivalent to the model understanding or following
    the principle; behavioral effect is evaluated only by Examiner.
12. Every journal record of one invocation MUST carry the same
    `hookInvocationId`; a record without it cannot be joined or counted.

### 13.4.3 Answers to the seven integrity questions

1. `degraded` is a **HookExecutionStatus**, not a payload state.
2. Yes — `execution=completed` with `payload=none` is a valid combination
   (T4a / T4b) and is distinct from `degraded` (D1). It is also distinct
   from `selection=none_applicable` (a valid semantic decision) and
   `selection=skipped` (a policy decision).
3. `returned` is adapter-side evidence (payload written to stdout);
   `confirmed` requires independent request-level evidence (T3).
   `returned` MUST NOT be inferred as `confirmed`.
4. When a host kill prevents a terminal receipt, the T0 `open` journal
   line plus reconciliation records `timeout` / `unknown` **only when host
   evidence exists**; the turn is never counted as delivered. If there is
   no T0 line at all (D6), nothing may be inferred about the cause.
5. Receipt writing MUST be a single `O_APPEND` line to
   `events_<date>.jsonl`: no synchronous SQLite transaction, no idempotency
   reads, no schema DDL, no per-call `mkdirSync`. Heavy evidence replay is
   performed by the existing background worker from the journal. The
   receipt-write latency budget is defined in §17.3. Generating
   `hookInvocationId` MUST NOT add I/O.
6. Closed-world default: every receipt begins as `unknown`; only explicit
   positive evidence can move it to `returned` / `confirmed` / `proceeded`
   / `blocked`. In evaluation scoring, **only `confirmed` counts as
   success**; `returned` is an attempted delivery, `unknown` is unscored,
   and `degraded`/`timeout`/`failed` are execution failures. A valid
   `none_applicable` decision is NEVER a failure.
7. `HostSubmissionOutcome` is independent: Hook failure does not prove a
   blocked submission, and a proceeded submission does not prove a payload
   was delivered.

### 13.4.4 Selection outcome semantics — `NONE_APPLICABLE` (NEW, v0.2.1)

SPEC v0.4 §6.3 / §6.5 / §6.6 / §18.4 / §20C already establish that
`NONE_APPLICABLE` is a **valid model-assisted selection result**, subject
to explicit validation. This amendment preserves that semantics and MUST
NOT reclassify it:

- `selected` — semantic judgment succeeded and principles were chosen.
- `none_applicable` — semantic judgment succeeded and concluded that no
  principle should be activated. `selectedPrincipleIds` is empty **by
  decision**, not by failure, skip, or degradation.
- `skipped` — a policy or feature flag decided that selection should not
  run at all. No semantic judgment was performed.
- `unavailable` — a dependency failure prevented selection from completing.

Consistency requirements across Receipt, Selection and Scorer:

| Surface | Required behaviour |
|:--------|:-------------------|
| Selector (`PrincipleSelectionResult.status`) | `NONE_APPLICABLE` remains a valid `status` per SPEC v0.4 §6.5; unchanged. |
| Receipt (`selection.selectionStatus`, `delivery.selection`) | Record `none_applicable`; `payload=none`, `execution=completed`. MUST NOT set `degraded`, `failed`, `skipped` or `unavailable`. |
| Scorer (§18.4 `Empty Selection Accuracy`) | `none_applicable` is scored as a **correct semantic decision** when ground truth agrees; it is NOT counted as a delivery failure, a hook failure, or a skip. |
| Failure-rate statistics (§17.3.3) | `none_applicable` MUST NOT be counted in `execution ∈ {degraded,timeout,failed}` failure rates. |

A correct empty decision MUST NOT be recorded as an execution failure or
a policy skip. `skipped` and `unavailable` MUST NOT be used to hide a
`NONE_APPLICABLE` result.

### 13.4.5 Journal identity, propagation and reconciliation (NEW, v0.2.1)

- `hookInvocationId` is generated at the **earliest controllable point in
  `wrapper.cjs`**, before the adapter entry is spawned and before any
  expensive work. It is one opaque identifier (e.g. a UUID); no absolute
  paths, no timestamps-only guessing, no reuse across invocations.
- The SAME identifier MUST be propagated through: `wrapper.cjs` → the
  adapter child process (via an environment variable) → emitter → every
  journal line (T0, terminal line, reconciliation line) → the receipt.
  A record lacking it cannot be joined to the invocation.
- If the host supplies a request id, it MAY be recorded separately as
  `hostRequestId`. It MUST NOT be fabricated; Task and Compaction
  payloads do not carry one.
- T0 MUST be written **as early as possible, before expensive operations**
  (module load, config reads, DB open, renderer). Its `evidenceGrade` is
  `RUNTIME_VERIFIED` for the fact "this PD hook invocation is running",
  with `independentlyVerified=false` (it is not host-side request
  evidence). `STATIC_CONFIG` MUST NOT be used as the T0 grade.
- **No T0 record is NOT equivalent to a host kill** (D6). Without
  independent host evidence, reconciliation MUST NOT infer `blocked` or
  `timeout`.
- If T0 exists but no terminal line exists, reconciliation MAY conclude
  `unknown` (D4), never `returned` or `confirmed`.
- `reconciled` means reconciliation has finished, whatever its result.
  It MUST NOT be treated as delivery success.
- Journal remains **single-line, append-only, no synchronous SQLite**;
  generating and propagating the identifier adds no database operation.
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

**Host submission outcome is a separate observation (v0.2.1).** The
`exit 2` / `deny` / `continue:false` / host-kill behaviours above describe
what WorkBuddy *does to the submission* when the corresponding hook result
reaches the host. They MUST NOT be transcribed into `HookExecutionStatus` as
`timeout`, and they do NOT by themselves constitute evidence for a
particular invocation. For each invocation, `HostSubmissionOutcome` defaults
to `unknown` and is upgraded to `proceeded` / `blocked` only with
independent host evidence (§13.4.1 S1/S2). A Hook execution failure MUST
NOT be read as a blocked user submission, and a proceeded submission MUST
NOT be read as successful payload delivery. These are WorkBuddy-specific
semantics and MUST NOT be extrapolated to OpenClaw or Codex.
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
| Condition | Required handling |
|:----------|:------------------|
| PD self-deadline / degraded | Return a neutral payload with a non-blocking exit code; append one journal line with the invocation's `hookInvocationId`, `execution="degraded"`, `payload="none"`, `submission` unchanged (default `unknown`), `degradationReason`, `selfDeadlineMs`, `resolvedHostTimeoutMs`, `elapsedMs`. Do NOT claim `returned`, `skipped` or `confirmed`. No synchronous DB write. |
| WorkBuddy `exit 1` / non-blocking error | Turn may proceed, but `submission=proceeded` requires independent host evidence; journal records `execution="degraded"` when PD produced no contribution, otherwise `completed`/`returned`. Host silence is never `confirmed` and never `proceeded`. |
| WorkBuddy `exit 2` / `deny` / `continue:false` | Record the **actual** Hook execution result; do NOT force `execution="timeout"`. `submission="blocked"` only with independent host evidence (otherwise `unknown`). Fail the profile gate. |
| Host kill **with** independent host evidence | Reconciliation → `execution="timeout"`, `payload="unknown"`, `receiptState="reconciled"`, `submission` set from host evidence. |
| Host kill **without** independent host evidence; or T0 exists with no terminal line | Reconciliation → `execution="unknown"`, `payload="unknown"`, `submission="unknown"`, `reconciliation.outcome="unknown"`. **Never `returned`, `confirmed`, `timeout` or `blocked`.** |
| **No T0 journal line at all** | Record `execution="unknown"`, `payload="unknown"`, `submission="unknown"`, `correlationStatus="unknown"`. **No T0 is NOT a host kill**; do not infer timeout or blocked submission. |
| Structural revalidation flag present | Run structural checks only; MUST NOT set `semanticReevaluationRequired` or enqueue `principle_decision` (§5.2.3). |
| `NONE_APPLICABLE` selection result | `selection="none_applicable"`, `execution="completed"`, `payload="none"`; valid decision, NOT a failure or a skip (§13.4.4). |
| Hook config source concat / fingerprint mismatch | Neutral return + journal line with `degradationReason:"hook_config_mismatch"` or `"hook_config_source_concat_detected"` (§8.3.1). Physical presence of stale version directories alone is NOT a failure. Coverage `partial`/`unknown` caps the profile at `CONDITIONALLY_VERIFIED`. |
| `PreCompact` blocking result | Prohibited. Classic PreCompact cannot block compaction; PD performs only a bounded checkpoint. |
| `PostCompact` selection / fingerprint recompute | Prohibited. Only `structuralRevalidationRequired=true` may be set. |
| Host Task / Subagent event used as semantic boundary | Prohibited (§5.2.1). Record `semantic_bypass_rejected` if attempted. `TaskCreated` / `TaskCompleted` remain distinct events. |
| `PreToolUse` `continue:false` | Prohibited in the WorkBuddy adapter; would re-submit the user prompt and duplicate `UserPromptSubmit`. |
| Host profile mismatch (`EXPIRED`) | Native only; discard deferred results bound to the old profile; write `host_profile_expired`. |
| Injection content truncated by PD | Journal-only `truncated:true` + discarded count; `payload` remains `returned`, `execution` remains `completed`. |
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
- `hookInvocationId` MUST be generated at the earliest controllable
  wrapper entry and the T0 `open` line written **before** expensive work;
  the same id is propagated to the child process, emitter and all journal
  lines (§13.4.5). Generating the id and writing T0 MUST NOT add a
  database operation; its cost is included in the §17.3.1 receipt/journal
  timing dimension.
```

## 2.16 §15 Receipt, Observability, Evidence — A-39 / A-40 / A-27 / A-28

**替换 §15.2 `AdaptiveActivationReceipt` 的 `host` / `identity` / `delivery` / `lifecycle` 段（A-39 + A-40 + A-42）**：

```typescript
interface AdaptiveActivationReceipt {
  receiptId: string;
  hookInvocationId: string;   // NEW v0.2.1: same id across wrapper/child/emitter/journal
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
      pluginConfigSha256: string;
      effectiveHookSetFingerprint: string;
      fingerprintNormalization: string;
      effectiveSourceCoverage: "complete" | "partial" | "unknown";
      coveredConfigSources: string[];
      rootFingerprint: string;
      discoverability: "registry_resolved" | "plugin_dir" | "unknown";
    };
  };

  identity: {
    workspaceHash?: string;
    sessionHash?: string;
    generationId?: string;   // absent on Task/Compaction-sourced events
    hostTaskId?: string;     // snake_case task_id; Agent-internal plan item
    hookEventName?: string;  // native hook_event_name; dedup key component
    hostRequestId?: string;  // only when the host actually supplies one
    correlationStatus: "correlated" | "unreliable" | "unknown";
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
    selectionStatus: SelectionStatus;   // NEW v0.2.1: includes none_applicable
    selectedPrincipleIds: string[];
    decisionType?: TaskChangeType;
    decisionReason?: string;
    selectionReason?: string;
    confidence?: number;
    workingSetRevision?: number;
    contextFingerprint?: string;
  };

  /** Four independent observation dimensions; see §13.4. */
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
| `hook_dispatched` | hook entry | process start + T0 `open` journal line carrying `hookInvocationId` (`RUNTIME_VERIFIED` for PD dispatch, `independentlyVerified=false`) |
| `payload_returned` | encoder | stdout single-line record with the same `hookInvocationId` |
| `request_confirmed` | request probe / reconciler | independent request-level evidence, joined by `hookInvocationId` |
| `behavioral_effect` | Examiner | PD MUST NOT assert; always `unverifiable` |

Rules:

1. A hook receipt may assert only `hook_dispatched` and `payload_returned`.
   `plugin_installed` / `plugin_loaded` are back-filled by the reconciler
   from host-side evidence, never invented by the hook.
2. `request_confirmed` may be appended only after T3 evidence exists.
   `HostSubmissionOutcome` is NOT a lifecycle stage; it is an independent
   observation dimension in `DeliveryIntegrity` (§13.4).
3. A later stage MUST NOT be used to infer an earlier stage. Seeing
   `payload_returned` does not prove `hook_dispatched` unless that stage was
   independently recorded.
4. `behavioral_effect` remains `unverifiable` in every PD receipt.
5. No stage may be recorded without its own `timestamp` and, when
   `observed`, its own `evidenceReference`.
6. Every stage observation and every journal line for one invocation MUST
   carry the same `hookInvocationId` (§13.4.5). A missing id makes the
   observation unjoinable and MUST NOT be back-filled by guessing.
7. Reconciliation completion adds no stage and does not upgrade any stage
   to `observed` without its own independent evidence.

These six stages are strictly ordered in evidentiary strength: installed
⇏ loaded ⇏ dispatched ⇏ returned ⇏ present in the model request ⇏
understood or followed by the model.
```

**替换 §15.3 Required Events 联合类型中 v0.1 追加的事件（A-27）**：

```typescript
  | "plugin_installed"
  | "plugin_loaded"
  | "hook_dispatched"
  | "journal_t0_written"
  | "hook_config_source_concat_detected"
  | "hook_config_mismatch"
  | "host_profile_expired"
  | "injection_degraded"
  | "injection_truncated"
  | "receipt_reconciled"
  | "host_submission_outcome_observed"
  | "worker_result_stale_discarded"
  | "host_task_graph_changed"
  | "subagent_scope_changed"
  | "post_compact_invalidated"
  | "structural_revalidation_recorded"
  | "none_applicable_selected"
  | "semantic_bypass_rejected"
```

**替换 §15.4 Evidence Semantics 表的 WorkBuddy 相关行并追加**：

```markdown
| Evidence               | What it proves                                                        | What it does not prove                                         |
|:-----------------------|:----------------------------------------------------------------------|:---------------------------------------------------------------|
| `execution=completed`  | The hook returned normally                                            | That a payload existed or reached the model                    |
| `payload=returned`     | Adapter wrote the payload to the host callback                        | That the host included it in the model request                 |
| `payload=confirmed`    | Independent evidence places content in the current request           | Model understanding or compliance                              |
| `execution=degraded`   | A contribution that should have existed was lost                     | That the submission was blocked                                |
| `execution=timeout`    | Independent host evidence of a kill exists                            | That the submission was blocked; that a payload was delivered  |
| `execution=unknown`    | Termination cause could not be established                            | Any specific failure mode, including host kill                 |
| `selection=none_applicable` | A **valid semantic decision** produced an empty selection         | An execution failure, a skip, or a delivery failure           |
| `submission=proceeded` | Independent host evidence that the user submission continued         | That a payload was returned, confirmed, or followed           |
| `submission=blocked`   | Independent host evidence that the submission was rejected            | Which Hook execution status caused it                          |
| `submission=unknown`   | No independent host evidence exists                                   | Either `proceeded` or `blocked`                                |
| `receiptState=open`    | A hook started (T0 exists); no terminal outcome is known              | Delivery of any kind                                           |
| `receiptState=reconciled` | Background reconciliation has completed (any result)               | Delivery success                                              |
| Absence of T0          | Only that no T0 journal line is present                               | Host kill, timeout, or blocked submission                      |
| Behavioral Effect      | Examiner observed a behavior difference under its evaluation protocol | Long-term improvement unless longitudinal evidence supports it |

Do not infer `confirmed` from `returned`, absence of an exception,
`execution=completed`, a host's fail-open behavior, a known injection
channel, or from `submission=proceeded`. Do not infer `blocked` from a
Hook failure, and do not infer `timeout` from a missing T0 line.
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
  not). Every journal line and the receipt MUST carry the same
  `hookInvocationId` (§13.4.5). `HostSubmissionOutcome` defaults to
  `unknown` and is upgraded to `proceeded` / `blocked` only with
  independent host evidence; a hook failure is NEVER read as a blocked
  submission, and `exit 2` / `deny` / `continue:false` are NOT all recorded
  as `timeout`. A T0 `open` line without a terminal line reconciles to
  `unknown`; a missing T0 line is NOT evidence of host kill. `reconciled`
  never means success. A `NONE_APPLICABLE` result is recorded as
  `selection="none_applicable"` (valid decision), never as `skipped`,
  `degraded` or `failed`.
  Lifecycle stages MUST be recorded as `StageObservation[]` (§15.2.1);
  the receipt MUST NOT claim `plugin_installed`, `plugin_loaded`,
  `request_confirmed` or `behavioral_effect` on its own authority.
```

## 2.16.1 §18.4 Empty Selection Accuracy — v0.2.1（P1-2）

**在 §18.4 Selector Metrics 的 `Empty Selection Accuracy` 定义之后追加**：

```markdown
`Empty Selection Accuracy` measures correct `NONE_APPLICABLE` decisions.
A `none_applicable` outcome is a **valid semantic decision**
(`SelectionStatus.none_applicable`, §13.4.4) and MUST be recorded
consistently in the Selector result, the Receipt
(`selection.selectionStatus` / `delivery.selection`) and this Scorer.
Scorer MUST NOT count it as an execution failure, a policy skip, a
delivery failure, or a Hook failure. It MUST NOT be included in the
§17.3.3 Hook execution failure-rate denominator. `skipped` (no selection
performed) and `unavailable` (selection could not complete) are excluded
from this metric entirely and reported separately.
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

### 17.3.2 Load matrix and sample size (v0.2.1)

Load matrix: cold/warm process; empty/populated Working Set; minimum and
maximum candidate pools; Workspace Focus available/unavailable; Intent
on/off; concurrent `SessionStart` + `UserPromptSubmit`; DB lock contention;
large transcript and context truncation; receipt-write contention;
configured timeouts of 5 s / 15 s / 30 s.

**Performance observation sample size**: at least **200 measured hook
invocations per matrix cell**, across at least **3 independent runs** and
at least **2 distinct sessions or dates**. Report p50 / p95 / p99 / max,
degraded rate, timeout rate, blocked rate and `INSUFFICIENT_EVIDENCE`
markers per cell.

**Critical strata** (each MUST be analysed and reported separately):
cold start; maximum candidate pool; concurrent
`SessionStart` + `UserPromptSubmit`; DB lock contention; smallest
configured timeout (5 s); receipt-write contention.

### 17.3.3 Three-layer statistical acceptance (REVISED, v0.2.1)

#### Layer 1 — Performance observation

- Report p50 / p95 / p99 / max **per cell**, with the measurement method
  and the number of samples.
- `p99` MUST be accompanied by an appropriate **confidence interval or
  upper bound** (method declared in the report, e.g. bootstrap or an
  order-statistic/binomial interval). A raw sample p99 alone MUST NOT be
  used to declare the gate satisfied.
- **200 samples are generally insufficient for a stable p99 claim** (only
  about two observations lie above it). If the p99 interval is too wide to
  compare with `softDeadlineMs − safety margin`, the cell MUST be marked
  `INSUFFICIENT_EVIDENCE` and the gate MUST NOT be marked `PASS`.
- Gate: `upper_bound(p99(PD synchronous path)) ≤ softDeadlineMs − safety
  margin` and `worst observed < hostHookTimeoutMs`.
- Synchronous path executes **zero** SQLite transactions after the emitter
  change; journal append `p99 ≤ 2 ms` and `max ≤ 5 ms`, with the same
  interval requirement.
- No `payload=confirmed` misclassification, no cross-session result
  contamination, and no `allowed:false` / `submission=blocked` outcome.

#### Layer 2 — Failure-rate acceptance (per critical stratum)

- Failure is defined as `execution ∈ {degraded, timeout, failed}` **or**
  an independently-evidenced `submission=blocked`. A valid
  `selection=none_applicable`, a `skipped` selection and
  `execution=unknown` are NOT automatically failures, but `unknown` MUST
  be reported separately and MUST NOT be silently dropped.
- Compute the failure rate **separately for each predefined critical
  stratum**. Do NOT merge different load classes and do NOT use the
  overall N to satisfy a single stratum's threshold.
- If observed failures in a stratum are 0 and the report claims a 95%
  upper bound `≤ 1%`, that stratum MUST have **N ≥ 300** and its OWN
  Rule-of-Three bound `≈ 3 / N` (N = 300 ⇒ ≈ 1%). Each bound is stated
  with its stratum and N.
- If a stratum has fewer than 300 samples, its bound MUST be reported as
  `> 1%` or `INSUFFICIENT_EVIDENCE`; it MUST NOT borrow samples from
  other strata.
- **Multiple comparisons**: if an overall 95% confidence statement is
  made across strata, the report MUST declare and apply a multiple
  comparison method (e.g. Bonferroni or Holm) to the per-stratum bounds.
  Without such a method, only per-stratum statements are permitted and no
  overall claim may be made.

#### Layer 3 — Release adjudication

- If sample size is insufficient, a confidence interval / upper bound does
  not satisfy the gate, or any critical stratum lacks sufficient data,
  the adjudication MUST be `INSUFFICIENT_EVIDENCE`. It MUST NOT be marked
  `PASS`, and no Shadow / Live enablement may follow.
- `PASS` requires: all Layer 1 intervals satisfy their gates; every
  critical stratum satisfies its Layer 2 bound; the multiple-comparison
  method (if used) is documented; and the report states N, bounds,
  stratum list and measurement method.
- **Zero observed failures is NOT zero risk.** The Rule-of-Three bound is
  an upper bound on the failure *rate*, not proof of its absence.
- This is a release gate, not proof of zero production risk. Post-rollout
  telemetry of degraded / timeout / blocked / unknown rates and the §21
  Stop Conditions remain in force.
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
   synchronous DB, `hookInvocationId` generated at wrapper entry and
   propagated through child / emitter / journal / receipt, and
   `open→closed→reconciled` reconciliation (T-03/T-04/T-21). No T0 line
   is NOT a host kill.
7. Freeze the WorkBuddy profile identity (appVersion, engineVersion,
   engineSha256, runtimeMode, pdPluginVersion, `pluginConfigSha256`,
   `effectiveHookSetFingerprint`, `fingerprintNormalization`,
   `effectiveSourceCoverage`, `rootFingerprint`) and its evidence date.
   Declaration of `partial` / `unknown` coverage is mandatory.
8. Implement `resolveHostProfile()`; any mismatch sets `status=EXPIRED`,
   falls back to Native-only, and discards stale deferred results.
9. Verify discoverability as four distinct levels (§8.3.1); confirm the
   same event is not registered from two config sources of one root.
   Verify `structuralRevalidationRequired` never becomes
   `semanticReevaluationRequired` (T-19).
10. Rebuild the isolated probe lab and run P1 / P3 / P4 / P6 against
    engine 2.165.0. `PROBE_PENDING` lifecycle events and host-native async
    hooks remain OFF throughout.

Gate 0 additions:

- The synchronous path satisfies the **three-layer** §17.3.3 acceptance
  with per-stratum N, p99 intervals and 95% bounds; any shortfall is
  marked `INSUFFICIENT_EVIDENCE` and the gate is NOT `PASS`.
- Degraded journal lines are emitted and observable; every line carries
  the same `hookInvocationId`; no receipt write adds a synchronous
  database operation.
- `HostSubmissionOutcome` defaults to `unknown`; no Hook failure is
  recorded as a blocked submission and no blocked submission is recorded
  as a Hook timeout without independent host evidence.
- `NONE_APPLICABLE` is recorded as a valid decision, never as a skip or
  failure (T-22).
- `resolveHostProfile()` is implemented and tested (T-01); coverage is
  declared and incomplete coverage is not labelled `VERIFIED` (T-23).
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
      in the WorkBuddy profile; `submission=proceeded` is only recorded
      with independent host evidence.
- [ ] The three-layer §17.3.3 acceptance is satisfied with per-stratum N,
      p99 confidence intervals/upper bounds and Rule-of-Three bounds;
      any shortfall is `INSUFFICIENT_EVIDENCE`, never `PASS`.
- [ ] Seven timing dimensions of §17.3.1 are reported separately and no
      stage attribution is inferred from the self-deadline budget.
- [ ] Every journal line and receipt for one invocation carries the same
      `hookInvocationId`; T0 precedes expensive work; no synchronous DB.

## C. Model-assisted Mode (additions)

- [ ] No host event (`TaskCreated`, `TaskCompleted`, `SessionEnd`,
      `PostCompact`, `SubagentStart/Stop`) produces a `TaskChangeType`
      decision, selects a principle, or causes `principle_decision` to be
      skipped (§5.2.1, T-07′/T-19).
- [ ] `HOST_TASK_GRAPH_CHANGED` only records provenance and sets
      `structuralRevalidationRequired`; it MUST NOT set
      `semanticReevaluationRequired`, enqueue a semantic task, or cause a
      semantic re-decision at the next `BEFORE_MODEL_TURN` (T-19).
- [ ] `TaskCreated` and `TaskCompleted` are retained as distinct events
      under the §5.2.2 composite key; no fabricated
      `generation_id` / `turn_id` / `parentTaskId` (T-19).
- [ ] `NONE_APPLICABLE` is a valid semantic decision in Selector,
      Receipt and Scorer; it is never recorded as `skipped`, `degraded`
      or `failed` (§13.4.4, T-22).
- [ ] Deferred Refresh carrier is PD's existing detached worker with the
      §10.4.2 constraints implemented and verified; host-native async
      refresh remains OFF unless separately probed and Owner-accepted.
- [ ] No detached worker contributes to the current turn.
- [ ] `PreToolUse` never returns `continue:false` in the WorkBuddy adapter.

## D. Working Set (additions)

- [ ] `generationId` (when present), `hostTaskId` (snake_case `task_id`),
      `hookEventName`, `hookInvocationId`, `correlationStatus`,
      `engineVersion`, `engineSha256`, `pdPluginVersion` are bound into the
      Working Set record; missing fields are never fabricated.
- [ ] `structuralRevalidationRequired` and
      `semanticReevaluationRequired` are independent; structural checks
      never call a model and never alter `selectedPrincipleIds` (T-19).
- [ ] Discoverability is verified at all four levels of §8.3.1; physical
      residue alone is not treated as duplicate registration.
- [ ] `pluginConfigSha256` / `effectiveHookSetFingerprint` /
      `rootFingerprint` mismatches yield a neutral return and a degraded
      journal line; coverage is declared and incomplete coverage is never
      labelled `VERIFIED` (T-23).
- [ ] `SessionEnd` is best-effort and TTL remains authoritative.
- [ ] `PostCompact` sets only `structuralRevalidationRequired` without
      changing `selectedPrincipleIds` or recomputing the fingerprint from
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

- [ ] **WorkBuddy Desktop 5.9.2 / CLI engine 2.165.0 / PD 0.2.2 profile is `CONDITIONALLY_VERIFIED`** (replaces the `lite-wb CLI` item); `effectiveSourceCoverage: "partial"` is declared.
- [ ] Each profile records appVersion, engineVersion, engineSha256,
      runtimeMode, pluginVersion, `pluginConfigSha256`,
      `effectiveHookSetFingerprint`, `fingerprintNormalization`,
      `effectiveSourceCoverage`, `rootFingerprint`;
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
- [ ] WorkBuddy failure semantics and `HostSubmissionOutcome` mapping are
      NOT extrapolated to OpenClaw or Codex.

## G. Execution Safety (additions)

- [ ] The WorkBuddy soft deadline is resolved at runtime from the enabled
      plugin's `hooks/hooks.json`; no hard-coded host timeout constant.
- [ ] PD self-degradation appends one degraded journal line carrying
      `hookInvocationId` before returning, with no synchronous database
      operation.
- [ ] Injected content is truncated by PD using the existing Prompt
      Capacity Budget; truncation is recorded journal-only.
- [ ] `SessionStart` self duration and hook-chain wall time are measured
      and recorded separately.
- [ ] `none_applicable` and `skipped` are excluded from the §17.3.3 Hook
      execution failure-rate denominator.

## H. Evidence (additions)

- [ ] `DeliveryIntegrity` uses **four** independent dimensions plus
      evidence; `degraded` is a `HookExecutionStatus`, never a payload
      state; `HostSubmissionOutcome` defaults to `unknown`.
- [ ] All twelve §13.4.2 invariants hold, including "open is never
      success", "no blocked without host evidence", "no timeout without
      host evidence", and "no T0 is not host kill".
- [ ] Lifecycle is `StageObservation[]` with six stages, per-stage owner,
      timestamp, evidence grade, reference and `hookInvocationId`; no
      boolean flags.
- [ ] Only `confirmed` is scored as success; `returned` is an attempted
      delivery; `unknown` is unscored; `none_applicable` is a valid
      semantic decision, not a failure.
- [ ] `confirmed` is never claimed for WorkBuddy without request-level
      evidence from an isolated probe; `submission=proceeded|blocked` is
      never claimed without independent host evidence (T-20).
- [ ] Reconciliation may conclude `unknown`; `reconciled` never implies
      delivery success; `unknown` is never upgraded to `returned` or
      `confirmed` (T-21).
- [ ] Host-kill scenarios are reconciled from the T0 `open` journal line
      **only when independent host evidence exists**; a missing T0 line
      is recorded as `unknown`, not as a kill.
```

## 2.20 §21 Stop Conditions — A-33

**替换第 12 条并追加 15–19**：

```markdown
12. **Any WorkBuddy submission-blocking hook outcome** (replaces the
    previous generic wording): host-side kill, `exit 2`, `deny`, or
    `continue:false` reaching the host, **when independently evidenced**.
    A Hook execution failure alone is NOT this condition.
15. A PD self-degradation causes a turn to receive no principle
    contribution (`execution="degraded"` with `payload="none"` observed in
    Live).
16. A degraded / timeout / failed / unknown outcome is recorded as
    `returned`, `skipped`, `none_applicable`, `confirmed` or `proceeded`;
    no journal line is written; a T0 `open` record is counted as success;
    or `submission=proceeded|blocked` is asserted without independent
    host evidence.
17. A same-event duplicate hook registration arises from two config
    sources of one plugin root, or a `pluginConfigSha256` /
    `effectiveHookSetFingerprint` / `rootFingerprint` mismatch is not
    handled neutrally; or a profile with `partial` / `unknown` coverage is
    declared fully `VERIFIED`. (Physical presence of stale version
    directories alone is NOT a stop condition.)
18. `resolveHostProfile()` reports `EXPIRED` and the adapter does not
    fall back to Native-only, or a stale deferred result reaches a new
    session.
19. Any host event is observed producing a `TaskChangeType` decision,
    selecting a principle, skipping `principle_decision`, or converting
    `structuralRevalidationRequired` into
    `semanticReevaluationRequired` (`semantic_bypass_rejected`).
20. A `TaskCreated` and a `TaskCompleted` for the same todo item are
    deduplicated into one record, or a missing identity field is
    fabricated to force a correlation.
21. `exit 2`, `deny`, `continue:false` or a Hook failure is classified as
    `execution="timeout"` without host evidence, or a blocked submission
    is classified as a Hook timeout; or WorkBuddy submission semantics
    are extrapolated to another host.
22. A valid `NONE_APPLICABLE` decision is recorded / scored as a skip or
    an execution failure, or is included in the §17.3.3 Hook failure-rate
    denominator.
23. A release gate is marked `PASS` while any critical stratum has
    insufficient samples, an unsatisfied p99 interval, or an undeclared
    multiple-comparison method; i.e. `INSUFFICIENT_EVIDENCE` is
    overridden.
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
| OQ-14 | **Open, tightened** | `confirmed` requires request-level evidence. The four-dimension Delivery Integrity model (execution / payload / selection / host submission outcome) prevents absence of evidence from being scored as success; `HostSubmissionOutcome` defaults to `unknown`. |
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
| OQ-26 | Do WorkBuddy `TaskCreated` / `TaskCompleted` payloads contain any real host event unique identifier? If not, is `(hostProfileId, session_id, task_id, hook_event_name)` collision-free across sessions and engine upgrades? | Per-version payload probe of engine 2.165.0+ (currently `UNKNOWN`) |
| OQ-27 | Which host-side `getHooks` configuration sources can be observed at runtime, and can `effectiveSourceCoverage` ever be `complete`? | Runtime config-observability probe (currently `partial`) |
| OQ-28 | Which p99 confidence-interval method (bootstrap / order-statistic) and which multiple-comparison correction should be normative for §17.3.3? | Statistical design review + probe calibration |
| OQ-29 | Can independent host evidence for `submission=proceeded|blocked` be obtained without a production session or a blocking test? | Isolated probe with host log capture |
| OQ-30 | Is a `hostRequestId` ever present on Task / Compaction payloads to improve correlation beyond the composite key? | Per-version payload probe |
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

**Structural / semantic separation (v0.2.1, P0-1).** `structuralRevalidationRequired`
and `semanticReevaluationRequired` are independent. Structural
revalidation checks only Working Set revision, Host Profile validity,
configuration fingerprints, Activation / Artifact validity and cache
expiry; it MUST NOT call a model, MUST NOT change `selectedPrincipleIds`,
and MUST NOT set a semantic flag. Semantic reevaluation is permitted only
for a verified user semantic change or a SPEC v0.4 §5-authorized semantic
trigger, and is performed exclusively by `principle_decision`.

`HOST_TASK_GRAPH_CHANGED` is structural-only. It MUST NOT set a semantic
flag, enqueue a deferred semantic task, or cause the next verified
`BEFORE_MODEL_TURN` to re-run semantic classification indirectly. A
structural flag MUST NOT be promoted, consumed as, or reinterpreted into a
semantic trigger at any later checkpoint. `TaskCreated` and `TaskCompleted`
are distinct events correlated by the §5.2.2 composite key; missing
identity fields are recorded as `unreliable` / `unknown`, never fabricated.

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

Implementation state is tracked by the §0.2.2 ladder
(`PROPOSED → SPEC_REVISED → IMPLEMENTED → TESTED → RUNTIME_VERIFIED →
ACCEPTED`, plus `DEFERRED_PENDING_EVIDENCE`). A proposal MUST NOT be
marked `PASS` in a self-audit. A profile is `EXPIRED` on any version,
engine hash, runtime mode, plugin version, `pluginConfigSha256` or
`effectiveHookSetFingerprint` change until reverified.

**Three separate status dimensions (v0.2.1, P2).** `Review Disposition`
is a review opinion (`ACCEPT` / `ACCEPT_WITH_CHANGE` / `REJECT` /
`DEFERRED_PENDING_EVIDENCE`) and is NOT Owner approval, NOT a SPEC
change and NOT an implementation. `Implementation Status` is the §0.2.2
ladder; `SPEC_REVISED` is permitted **only after formal merge into SPEC
v0.5** — before that, every amendment item is `PROPOSED`.
`Baseline Provenance` records content origin, including
`RETAINED_FROM_V0_4` for original SPEC v0.4 designs that are preserved;
that marker does NOT mean a new revision has been implemented. No
dimension may substitute for another, and no self-audit row may claim
`SPEC_REVISED` or `ACCEPTED` prematurely.

Rationale: the 2026-11-04 audit found 13 concrete contradictions between
CLI docs, IDE docs, engine source and live runtime, and a historical probe
baseline (2.161.0) that had silently gone stale after a host auto-upgrade
to 2.165.0.

## ADR-017 — Delivery Evidence Uses a Closed-World Default and Four Independent Observations

**Decision: NEW — PROPOSED. Status: `PROPOSED`.**

Delivery state is represented by **four independent observation
dimensions** — `HookExecutionStatus`, `PayloadStatus`, `SelectionStatus`
and `HostSubmissionOutcome` — plus `DeliveryEvidence` and an
`open / closed / reconciled` journal state. Every record begins as
`unknown`; only explicit positive evidence can move it to `returned`,
`confirmed`, `proceeded` or `blocked`. A Hook failure MUST NOT be read as
a blocked user submission; a proceeded submission MUST NOT be read as a
delivered payload; `exit 2` / `deny` / `continue:false` / host kill MUST
NOT all be collapsed into `timeout`. `HostSubmissionOutcome` defaults to
`unknown` and requires independent host evidence. WorkBuddy-specific
submission semantics MUST NOT be generalized to other hosts.

`open` means the invocation started with no terminal record; `closed`
means a terminal record exists (any outcome); `reconciled` means
background reconciliation has completed (any result) and is NOT success.
A missing T0 line is NOT evidence of a host kill; with no independent
host evidence, reconciliation concludes `unknown`. `reconciled` never
implies delivery success, and `unknown` is never upgraded to `returned`
or `confirmed`.

Every journal line and receipt carries one `hookInvocationId`, generated
at the earliest controllable wrapper entry and propagated through the
child process, emitter and reconciliation. T0 is `RUNTIME_VERIFIED`
evidence of PD hook runtime dispatch with `independentlyVerified=false`,
and is written before expensive work.

Lifecycle is a set of independently evidenced `StageObservation`
records, not booleans. PD may not assert `plugin_installed`,
`plugin_loaded`, `request_confirmed` or `behavioral_effect` on its own
authority.

Receipt writing MUST NOT add a synchronous database operation to the
prompt hook; it is a single append-only journal line, with heavy evidence
replay delegated to the existing background worker.

Rationale: a live session already lost an injection silently. Treating
"no exception" or a known channel as delivery would make that loss
invisible; adding synchronous evidence writes would make the underlying
latency problem worse.

## ADR-018 — `NONE_APPLICABLE` Is a Valid Semantic Decision, Not a Failure

**Decision: NEW — PROPOSED. Status: `PROPOSED`.**

SPEC v0.4 §6.3 / §6.5 / §6.6 / §18.4 / §20C establishes `NONE_APPLICABLE`
as a valid model-assisted selection result subject to explicit
validation. v0.2 collapsed it into `skipped`; v0.2.1 restores its
independent status in `SelectionStatus`.

`selected` = judgment succeeded with principles; `none_applicable` =
judgment succeeded with a valid empty decision; `skipped` = policy/flag
decided not to run selection; `unavailable` = dependency failure
prevented selection. These four states MUST be recorded consistently in
the Selector result, the Receipt (`selection.selectionStatus` and
`delivery.selection`) and the Scorer (`Empty Selection Accuracy`).
A correct `NONE_APPLICABLE` decision MUST NOT be recorded as an execution
failure, a skip, or a delivery failure, and MUST NOT be counted in the
§17.3.3 Hook execution failure-rate denominator.

Rationale: treating a correct empty selection as a skip or failure would
corrupt both governance evidence and statistical release gates, and would
silently contradict the retained SPEC v0.4 design.
```

## 2.23 §24 Change Log / §25 Self-audit — A-44

**在 §24 Change Log 追加**：

```markdown
| Metadata / §0.3 / §2.1  | Add WorkBuddy host-native revision + adversarial review corrections; remove determinism-first rule and the "cannot outlive the session" guarantee | Amendment v0.2 (2026-11-04) |
| §0.2 / §1 / §25.1 | Split Review Disposition / Implementation Status / Baseline Provenance; correct premature `SPEC_REVISED` | Amendment v0.2.1 (P2) |
| §5.2.1–5.5 / §8.2 / §12.2 / §12.5 | Task event composite dedup key; structural vs semantic revalidation isolation | Amendment v0.2.1 (P0-1) |
| §13.4 / §14 / §15 | `HostSubmissionOutcome` as fourth dimension; `hookInvocationId` and reconciliation semantics; `NONE_APPLICABLE` restored | Amendment v0.2.1 (P0-2 / P1-1 / P1-2) |
| §8.3.1 / §10.2 / §12.2 / §15.2 | `pluginConfigSha256` / `effectiveHookSetFingerprint` + coverage declaration | Amendment v0.2.1 (P1-3) |
| §17.3 / §19 / §20 / §21 | Three-layer statistical acceptance; `INSUFFICIENT_EVIDENCE` release adjudication | Amendment v0.2.1 (P1-4) |
| §23 | ADR-015/016/017 revised; ADR-018 added | Amendment v0.2.1 |
```

**替换 §25.1 Self-audit 表中 v0.1 新增的 4 行，并改用状态阶梯（A-44）**：

```markdown
### 25.1 Consistency Audit — Amendment v0.2.1 status (NOT `PASS`)

> 本表按 §0.2 拆分三个维度。`Review Disposition` 是审查意见，不是 Owner 批准；
> `Implementation Status` 在 SPEC v0.5 正式合入前一律为 `PROPOSED`；
> `Baseline Provenance` 只说明内容来源。`RETAINED_FROM_V0_4` 表示原设计继续
> 保留，**不代表新修订已经完成**。任何行都不得标 `PASS`。

| Check | Review Disposition | Implementation Status | Baseline Provenance | Required next evidence |
|:------|:-------------------|:----------------------|:--------------------|:-----------------------|
| Runtime V2 remains sole activation authority | `ACCEPT` | `PROPOSED` | `RETAINED_FROM_V0_4` | Owner acceptance + SPEC v0.5 merge |
| Native remains independent of external model | `ACCEPT` | `PROPOSED` | `RETAINED_FROM_V0_4` | Owner acceptance + SPEC v0.5 merge |
| `NONE_APPLICABLE` is a valid semantic decision | `ACCEPT` | `PROPOSED` | `RETAINED_FROM_V0_4` | T-22 + Scorer consistency |
| `returned ≠ confirmed ≠ behavioral effect` | `ACCEPT` | `PROPOSED` | `RETAINED_FROM_V0_4` | P1 mock-request probe (OQ-25) |
| WorkBuddy injection channel is `user_message_system_reminder` | `ACCEPT_WITH_CHANGE` | `PROPOSED` | `RETAINED_FROM_V0_2` | Current-version request-level `RUNTIME_VERIFIED` probe (OQ-25) |
| WorkBuddy tool events are usable evidence channels | `ACCEPT_WITH_CHANGE` | `PROPOSED` | `RETAINED_FROM_V0_2` | CI regression assertion |
| WorkBuddy lifecycle/compaction events are refresh triggers | `DEFERRED_PENDING_EVIDENCE` | `DEFERRED_PENDING_EVIDENCE` | `RETAINED_FROM_V0_2` | Isolated P3/P4 probes (OQ-22/OQ-23) |
| Host events never bypass semantic judgment | `ACCEPT_WITH_CHANGE` | `PROPOSED` | `REVISED_IN_V0_2_1` | Implementation + T-07′/T-19 + Owner acceptance |
| Structural revalidation cannot become semantic reevaluation | `ACCEPT` | `PROPOSED` | `NEW_IN_V0_2_1` | T-19 |
| `TaskCreated` / `TaskCompleted` retained as distinct events | `ACCEPT` | `PROPOSED` | `NEW_IN_V0_2_1` | T-19 + OQ-26 |
| Four-dimension `DeliveryIntegrity` + `HostSubmissionOutcome` | `ACCEPT` | `PROPOSED` | `REVISED_IN_V0_2_1` | Implementation + T-16/T-20 + host-evidence probe (OQ-29) |
| `hookInvocationId` journal correlation and reconciliation | `ACCEPT` | `PROPOSED` | `NEW_IN_V0_2_1` | T-21 + runtime journal evidence |
| `degraded` is observable on the wrapper degrade path | `ACCEPT_WITH_CHANGE` | `PROPOSED` (currently `NOT_FOUND` in code) | `RETAINED_FROM_V0_2` | Implementation + T-03 |
| Host profile binds engine SHA / plugin version / both fingerprints | `ACCEPT_WITH_CHANGE` | `PROPOSED` (currently `NOT_FOUND` in code) | `REVISED_IN_V0_2_1` | `resolveHostProfile()` + T-01/T-23 |
| `effectiveSourceCoverage` declared; incomplete ≠ `VERIFIED` | `ACCEPT` | `PROPOSED` | `NEW_IN_V0_2_1` | T-23 + OQ-27 |
| Deferred Refresh carrier = PD existing worker | `ACCEPT_WITH_CHANGE` | `PROPOSED` (contract `NOT_FOUND` in code) | `RETAINED_FROM_V0_2` | Contract implementation + Gate 4 probe |
| Host-native async refresh | `DEFERRED_PENDING_EVIDENCE` | `DEFERRED_PENDING_EVIDENCE` (OFF) | `RETAINED_FROM_V0_2` | Isolated P6 probe + Owner acceptance |
| Detached worker may outlive session (no host guarantee) | `ACCEPT_WITH_CHANGE` | `PROPOSED` | `RETAINED_FROM_V0_2` | Runtime lifecycle probe (OQ-17) |
| PreCompact cannot block compaction; PostCompact observational | `ACCEPT_WITH_CHANGE` | `PROPOSED` | `RETAINED_FROM_V0_2` | Isolated P4 probe |
| Physical `hooks.json` residue is not duplicate registration | `ACCEPT_WITH_CHANGE` | `PROPOSED` | `RETAINED_FROM_V0_2` | T-08′ configuration test |
| Seven timing dimensions reported separately | `ACCEPT_WITH_CHANGE` | `PROPOSED` | `RETAINED_FROM_V0_2` | Phase-level instrumentation (OQ-18) |
| Three-layer statistical acceptance + `INSUFFICIENT_EVIDENCE` | `ACCEPT` | `PROPOSED` | `REVISED_IN_V0_2_1` | T-17/T-24 + OQ-28 |
| `confirmed` never claimed without request-level evidence | `ACCEPT_WITH_CHANGE` | `PROPOSED` | `RETAINED_FROM_V0_2` | P1 mock-request probe |
| Self-audit uses three status dimensions, never `PASS` for proposals | `ACCEPT` | `PROPOSED` | `REVISED_IN_V0_2_1` | Owner acceptance + SPEC v0.5 merge |

No row may be reported as `ACCEPTED` until the Owner explicitly approves
it. No row may be reported as `SPEC_REVISED`, `IMPLEMENTED`, `TESTED` or
`RUNTIME_VERIFIED` without the named evidence. Because SPEC v0.5 does not
yet exist, `SPEC_REVISED` is NOT used as a current status anywhere in this
Amendment v0.2.1.
```

**替换 §25.2 Evidence Limitations 中 WorkBuddy 相关否定表述**：

```markdown
This SPEC does not claim:

- Codex interactive TUI is verified.
- WorkBuddy standalone IDE runtime or Desktop UI-only capabilities are verified.
- WorkBuddy `PROBE_PENDING` lifecycle/compaction events are usable as
  refresh triggers; they have source-level dispatch points but zero live
  samples.
- `TaskCreated` / `TaskCompleted` represent user task boundaries (they do not),
  or that they carry a host event unique identifier, `generation_id`,
  `turn_id` or `parentTaskId` (OQ-26 remains `UNKNOWN`).
- A structural revalidation signal is equivalent to, or may become, a
  semantic reevaluation.
- A Hook execution failure proves blocked submission, or a missing T0
  journal line proves a host kill.
- `NONE_APPLICABLE` is a skip or an execution failure.
- `effectiveSourceCoverage` is `complete` for the current profile
  (it is declared `partial`; unobservable host config sources are not
  assumed covered).
- A release gate with insufficient samples can be marked `PASS`
  (it must be `INSUFFICIENT_EVIDENCE`), or that 200 samples support a
  stable p99 claim.
- A host-native `async:true` hook is a verified Deferred Refresh carrier,
  or that a detached worker cannot outlive its session.
- WorkBuddy submission-outcome semantics apply to other hosts.
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

# 3. 新增接口与数据结构汇总（v0.2.1）

> 本表「状态」列是 **Implementation Status**（§0.2.2）；在 SPEC v0.5 合入前一律
> `PROPOSED`。Baseline Provenance 见 §9.2。

| 名称 | 位置 | Implementation Status | 用途 |
|:---|:---|:---|:---|
| `resolveHostProfile()` | §12.2 / §10.2 | `PROPOSED` | 解析版本五元组 + `pluginConfigSha256` + `effectiveHookSetFingerprint` + `rootFingerprint` + coverage；不匹配 → `EXPIRED` + Native-only |
| `HostPluginIdentity` | §12.2 / §15.2 | `PROPOSED` | 长期身份；双指纹 + coverage + 来源名；**无绝对路径** |
| `AdaptiveContextSnapshot` 修订字段 | §4.3 | `PROPOSED` | `hostTaskId`(snake_case)、`compactSummaryEvidence`、无 `"compact"` source、缺失不伪造 |
| `CanonicalEventType` 新值 | §5.2 | `PROPOSED` | `HOST_TASK_GRAPH_CHANGED` / `HOST_SUBAGENT_SCOPE_CHANGED` / `HOST_SESSION_ENDED` / `HOST_POST_COMPACT`，全部 `semanticAuthority:false` |
| `HostEventCorrelationKey` / `correlationStatus` | §5.2.2 / §8.2 / §12.2 | `PROPOSED` | 优先宿主真实事件唯一标识；兜底复合键含 `hook_event_name`；缺失标 `unreliable` / `unknown` |
| `structuralRevalidationRequired` / `semanticReevaluationRequired` | §5.2.3 / §5.4 / §8.2 | `PROPOSED` | 两个独立标志；宿主事件只能设前者 |
| `SessionWorkingSet` 新字段 | §8.2 | `PROPOSED` | 双标志 / `hookInvocationId` / `correlationStatus` / 双指纹 / `preCompactRevision` |
| `HookExecutionStatus` / `PayloadStatus` / `SelectionStatus` / `HostSubmissionOutcome` | §13.4 / §15.2 | `PROPOSED` | **四个独立观察维度**；`HostSubmissionOutcome` 默认 `unknown` |
| `SelectionStatus.none_applicable` | §13.4.4 / §15.2 | `PROPOSED` | 保留 SPEC v0.4 的有效空决策语义；Receipt / Selection / Scorer 一致 |
| `DeliveryIntegrity` + `DeliveryEvidence` + `ReceiptState` | §13.4 / §15.2 | `PROPOSED` | 四维状态机 + `hookInvocationId` + 封闭世界默认 + `INSUFFICIENT_EVIDENCE` 不属于状态阶梯 |
| `hookInvocationId` / T0 / `open→closed→reconciled` | §13.4.0 / §13.4.5 / §15.2.1 | `PROPOSED` | Journal 关联与对账；`reconciled` 不代表成功 |
| `LifecycleStage` / `StageObservation` / `StageStatus` | §15.2.1 | `PROPOSED` | 六阶段独立观察，替代 boolean |
| `EvidenceGrade`（含 `PROBE_PENDING`） | §2.1.1 / §12.2 | `PROPOSED` | 证据等级纪律 |
| `ProfileStatus` / `implementationStatus` / `reviewDisposition` / `baselineProvenance` | §0.2 / §12.2 | `PROPOSED` | 三维度状态分离落地 |
| 新增事件类型 18 个 | §15.3 | `PROPOSED` | 含 `journal_t0_written` / `host_submission_outcome_observed` / `structural_revalidation_recorded` / `none_applicable_selected` / `receipt_reconciled` |
| `deferredWorker` / `hostAsyncHook` profile 配置 | §10.2 | `PROPOSED`（均 OFF） | 载体与门禁一致性 |
| 七维 timing 结构 | §12.2 / §17.3.1 | `PROPOSED` | 分离测量，禁止合并 |
| 三层统计验收 + `INSUFFICIENT_EVIDENCE` | §17.3.3 / §20 / §25 | `PROPOSED` | 发布裁定标签，与 `PASS` 互斥 |

**已删除 / 已修正的结构**：v0.1 的 `injectionStatus.degraded`（并入 `HookExecutionStatus`）、`lifecycle{4×boolean}`（并入 `StageObservation[]`）、`enabledPluginRoot: string`（并入 `HostPluginIdentity`）、`HOST_TASK_CREATED`/`HOST_TASK_COMPLETED`「确定性边界」映射、`determinism-first rule`、`cannot outlive the session`、§8.3.1 多版本幂等、A-36 `PASS (amended)`；**v0.2 的单一 `configSha256`**（拆为 `pluginConfigSha256` + `effectiveHookSetFingerprint`）、**单一 `revalidationRequired`**（拆为结构性 / 语义性两个标志）、**三维 `DeliveryIntegrity`**（扩为四维）、**把 `NONE_APPLICABLE` 归入 `skipped`**、**`(session_id, task_id)` 去重键**、**提前使用的 `SPEC_REVISED`**。

---

# 4. 验收标准汇总（v0.2.1 统计口径）

见 §2.19（§20 追加项）。所有条目的 Implementation Status 为 `PROPOSED`。

| 门禁 | 阈值 / 口径 | Implementation Status |
|:---|:---|:---|
| 同步路径阶段归因 | 必须有 phase-level 计时；不得从 12 s 预算反推 | `PROPOSED` |
| 性能观测样本量 | 每格 ≥ 200 次，≥ 3 次独立运行，≥ 2 会话/日期；p50/p95/p99/max | `PROPOSED` |
| p99 结论 | 必须附 CI / 上界；区间过宽或 200 次不足 → `INSUFFICIENT_EVIDENCE`，不得凭样本 p99 宣称 PASS | `PROPOSED` |
| 失败率验收 | **每个关键分层独立** N ≥ 300、各自 Rule of Three 95% 上界 `≈3/N`；禁止混层借 N | `PROPOSED` |
| 多重比较 | 若作整体 95% 声明，必须声明并应用 Bonferroni / Holm 等方法 | `PROPOSED` |
| 发布裁定 | 样本不足 / 区间不满足 / 关键分层缺数据 → `INSUFFICIENT_EVIDENCE`，**不得 PASS** | `PROPOSED` |
| p99 / worst | `upper_bound(p99) ≤ softDeadlineMs − 余量`；worst `< hardTimeoutMs` | `PROPOSED` |
| 同步 SQLite 事务数 | 0（emitter 改造后） | `PROPOSED` |
| journal append | `p99 ≤ 2 ms`、`max ≤ 5 ms`（同样需区间）；每行含 `hookInvocationId` | `PROPOSED` |
| 阻断率 | `submission=blocked` 仅由独立宿主证据产生；观测 0 次 | `PROPOSED` |
| 交付误报 | 0 次 `confirmed` 误报；0 次跨 session 污染；`none_applicable` 不计入 Hook 失败率 | `PROPOSED` |
| 配置覆盖度 | `effectiveSourceCoverage` 必须声明；不完整不得标 `VERIFIED` | `PROPOSED` |
| 语义隔离 | 宿主事件不得触发 `semanticReevaluationRequired` 或间接重决策 | `PROPOSED` |

**生产声明限制**：以上为发布门禁，**不构成生产零风险证明**；零次失败不等于零风险。上线后必须持续采集 degraded / timeout / blocked / unknown 率并保留 §21 停止条件。

---

# 5. 测试要求（v0.2.1）

**测试类型分层（强制区分；本轮只定义测试，不执行生产探针）**：

| 类型 | 含义 | 本轮是否执行 |
|:---|:---|:---|
| `文档契约` | 对 Amendment / SPEC 文本做静态一致性断言（枚举、状态组合、编号、引用） | 否（仅定义） |
| `单元测试` | 纯函数 / 类型 / 状态机 / 指纹计算的隔离断言，不启动宿主 | 否（仅定义） |
| `集成测试` | 在测试进程内联动 wrapper / adapter / journal / reconciler，不触碰真实用户会话 | 否（仅定义） |
| `真实运行时探针` | 在隔离 lab 中驱动真实宿主引擎与 mock model | 否（保持 `DEFERRED_PENDING_EVIDENCE`） |

所有测试的 Implementation Status 均为 `PROPOSED`；标注
`DEFERRED_PENDING_EVIDENCE` 的探针在 A-48 通过前保持 OFF。

| # | 测试 | 断言 | 类型 | Implementation Status |
|:--|:---|:---|:---|:---|
| T-01 | `resolveHostProfile()` 版本匹配 | 任一身份字段或 `pluginConfigSha256` / `effectiveHookSetFingerprint` 不匹配 → `EXPIRED` + Native-only + `host_profile_expired`；receipt 不含绝对路径 | `单元测试` | `PROPOSED` |
| T-02 | hooks.json 动态 deadline | 给定 5/15/30 s，self-deadline 恒 < hard limit，receipt 记录实际值；**不得标为性能优化** | `单元测试`（属性） | `PROPOSED` |
| T-03 | degraded journal | wrapper 降级 → 一行含 `hookInvocationId`、`execution=degraded`、`payload=none`、`submission=unknown`；无 SQLite 连接；`open` 不算成功 | `集成测试` | `PROPOSED` |
| T-04 | 非阻断降级 | exit 1 降级不产生 `continue:false`/`deny`/exit 2；`submission` 不因 Hook 失败而升级；缺失 T0 不得推断 kill | `真实运行时探针`（隔离） | `DEFERRED_PENDING_EVIDENCE` |
| T-05 | 当前回合注入形状 | 2.165.0 mock request body 中 `role:"user"` 的 hook system-reminder 位于 `<user_query>` 前；`confirmed` 证据可用 | `真实运行时探针`（隔离） | `DEFERRED_PENDING_EVIDENCE` |
| T-06 | async detach 生命周期 | `allowed:true` 立即返回、不贡献当前回合、`asyncTimeout` 生效、**Session 结束后进程行为**、结果提交校验 | `真实运行时探针`（隔离） | `DEFERRED_PENDING_EVIDENCE` |
| T-07′ | **无语义绕过** | 宿主 Task/Session/Compaction/Subagent 事件触发时：① `TaskChangeType` 产出数=0；② `selectedPrincipleIds` 不变；③ `principle_decision` 不被跳过；④ 仅写 provenance / `structuralRevalidationRequired` | `单元测试` + 计数断言 | `PROPOSED` |
| T-08′ | 同 root 配置来源 concat | manifest `hooks` + 默认 `hooks/hooks.json` 同事件 → `hook_config_source_concat_detected` + 中性返回；**物理残留目录不触发** | `集成测试` | `PROPOSED` |
| T-09 | `continue:false` 禁用 | adapter 任何路径不输出 `continue:false`；重投时按可用身份去重 | `单元测试` + `真实运行时探针` | `PROPOSED` |
| T-10 | 注入截断 | 按 principle 边界截断，journal-only `truncated:true`；无同步 DB | `单元测试` | `PROPOSED` |
| T-11 | 七维耗时测量 | 七维分别记录；`SessionStart` self 与 chain 分开；无阶段归因推断 | `集成测试` + `真实运行时探针` | `PROPOSED` |
| T-12 | 分模式证据 | CLI/IDE/Desktop 三份 profile 独立；`SOURCE_CONFIRMED` 不被升格；PreCompact 文档/源码矛盾登记 | `文档契约` | `PROPOSED` |
| T-13 | 六阶段观察 | 每阶段独立 `status/evidenceGrade/timestamp/evidenceReference/assertedBy` + `hookInvocationId`；hook 不得断言 installed/loaded/confirmed/behavioral_effect | `集成测试` | `PROPOSED` |
| T-14 | 引擎基线守卫 | `--version` 与 `sha256sum` 等于冻结 profile，否则 SKIP（不得 faked green） | `文档契约` + `真实运行时探针` | `PROPOSED` |
| T-15 | Compaction 契约 | PreCompact 不返回阻断结果、无 LLM；PostCompact 只置 `structuralRevalidationRequired`；`compact_summary` 不进 fingerprint | `单元测试` + `真实运行时探针` | `PROPOSED` |
| T-16 | 四维状态机不变量 | §13.4.2 全部十二条不变量（含 `open` 不算成功、reconciliation 不升级、`submission` 独立、`none_applicable` 非失败） | `单元测试`（属性） | `PROPOSED` |
| T-17 | 三层统计验收 | 分层 N、p99 区间、Rule of Three 上界、多重比较方法；证据不足标 `INSUFFICIENT_EVIDENCE`；不得以「0 次失败」声明零风险 | `集成测试` + 统计报告 | `PROPOSED` |
| T-18 | 跨 Session 污染 | 旧 session / `EXPIRED` profile 的 deferred 结果被丢弃并记 `worker_result_stale_discarded` | `集成测试` | `PROPOSED` |
| **T-19** | **Task 事件去重与语义重新决策隔离** | ① `TaskCreated` / `TaskCompleted` 在同一 `task_id` 下产生**两条独立记录**（复合键含 `hook_event_name`）；② 宿主无事件唯一标识时不伪造；③ 缺身份字段标 `unreliable`/`unknown`；④ 两个事件均不得设置 `semanticReevaluationRequired`、不得入队语义任务、不得让下一个 `BEFORE_MODEL_TURN` 重跑 `principle_decision`；⑤ `structuralRevalidationRequired` 不改变 `selectedPrincipleIds` | `单元测试` + `集成测试` | `PROPOSED` |
| **T-20** | **`HostSubmissionOutcome` 独立性** | 构造表格中六种场景，断言 `execution` 与 `submission` 独立；`submission` 默认 `unknown`；`proceeded`/`blocked` 必须有 `evidenceReference` 且 `independentlyVerified=true`；`exit 2`/`deny`/`continue:false` 不被强制标为 `timeout`；Hook 失败不推断 blocked；不向其它宿主外推 | `单元测试` + `文档契约` | `PROPOSED` |
| **T-21** | **`hookInvocationId` / Journal / reconciliation 关联** | wrapper 生成的 id 在 child / emitter / T0 / terminal / reconciliation / receipt 中完全一致；T0 在昂贵操作前且 grade=`RUNTIME_VERIFIED`；无 T0 ≠ kill；T0 无终态 → `unknown`；`reconciled` 不计成功；`unknown` 不升级为 `returned`/`confirmed`；journal 单行 append-only、无同步 DB | `集成测试` | `PROPOSED` |
| **T-22** | **`NONE_APPLICABLE` 独立状态与有效决策** | `selection=none_applicable` 时 `execution=completed`、`payload=none`，不得为 `skipped`/`degraded`/`failed`；Selector status 保持 SPEC v0.4 语义；Scorer `Empty Selection Accuracy` 计为正确决策；不计入 §17.3.3 Hook 失败率 | `单元测试` + `文档契约` | `PROPOSED` |
| **T-23** | **`effectiveHookSetFingerprint` 覆盖与缺失配置源** | 双指纹确定性规范化；只纳入 `SOURCE_CONFIRMED` 来源；`partial`/`unknown` coverage 不得标 `VERIFIED`；指纹变化触发 `EXPIRED` + Native-only；物理残留目录不影响指纹；receipt 不含绝对路径；不引入新配置管理系统 | `单元测试` + `集成测试` | `PROPOSED` |
| **T-24** | **分层统计验收及置信区间** | 每个关键分层独立报告 N、p99 CI/上界、`3/N` 上界；禁止用总体 N 满足单层；整体声明需多重比较方法；样本不足/区间不满足 → `INSUFFICIENT_EVIDENCE` 且不得 PASS | `集成测试` + 统计报告 | `PROPOSED` |
| **T-25** | **状态三维度一致性** | 每条 Self-audit / 修订总表项具备 `Review Disposition` / `Implementation Status` / `Baseline Provenance`；`ACCEPT` 不等于 `ACCEPTED`；`SPEC_REVISED` 在 SPEC v0.5 合入前出现即为失败；`RETAINED_FROM_V0_4` 不被当作已完成修订；A-20 为 `PROPOSED` | `文档契约` | `PROPOSED` |

**历史测试纠正**：T-07 原断言「Task 事件时 `principle_decision` 调用数为 0」→ 改为 T-07′（同时验证「不跳过」与「不产出语义决策」）；T-08 原「两版 hooks.json 同时可发现」→ T-08′；T-03 补 journal-only 与 `hookInvocationId`；T-05/T-06 保持 `DEFERRED_PENDING_EVIDENCE`；T-16 由六条不变量扩为十二条；T-17 由单一统计门禁扩为三层口径。

---

# 6. 明确保留、不需要修改的设计

1. **§2.3 / §16 / ADR-001**：Runtime V2 是唯一治理权威；Selector / Host Adapter 不得创建、批准、撤销 Activation，不得绕过 Artifact Validation。
2. **§3.3 / ADR-002 / ADR-005**：Native 与 Model-assisted 双模共存；同步 prompt hook 默认不做外部模型推理。本轮生产降级再次证明该决定必要。
3. **§5.3**：`SessionStart` 不是通用会话边界，不得用于计数 / 判定新建 / 清空 Working Set。
4. **§5.9**：禁止把关键词 / regex / 固定任务映射当作主语义选择器。本次「no-semantic-bypass」规则是该原则的加强。
5. **§6**：`principle_decision` + `principle_selector` 两阶段、多标签选择、`NONE_APPLICABLE` 有效、Candidate 校验与 allowlist。**v0.2.1 明确保留 `NONE_APPLICABLE` 在 Selector / Receipt / Scorer 三处的有效决策语义**（§13.4.4），不得记为跳过或失败。
6. **§7**：只有一个 Working Set Resolver 产出最终集合；Hook 执行预算与 Prompt Capacity Budget 是两个独立预算；`fair_rotation_v1` 不跨宿主外推；不伪造 turn ordinal。
7. **§13.1 / ADR-011**：一个共享决策核心 + 宿主适配契约。本修正案不把 WorkBuddy 拆成独立选择系统。
8. **§15.4 / ADR-013**：`returned ≠ confirmed ≠ behavioral effect`。v0.2 的三维状态机（v0.2.1 扩为四维，并新增独立 `HostSubmissionOutcome`）是该纪律的实现，不是放宽。
9. **§11 / §0 Status / ADR-010**：所有 feature flag 默认 OFF、Shadow 不自动升 Live、Live 需 Owner 逐 profile 授权。degraded journal 是**强制 observability**，不是 feature flag（§11.2.1）。
10. **§1.2 Non-Goals**：不新建 Prompt Injection / Governance Activation / Model Runtime / Evidence 平台；不启用未验证的 Desktop/TUI/IDE 模式；不绕过 Working Set Selector v0.2 的 Hold gates。
11. **§12.5 原有 10 条规则**：尤其「只用宿主真实事件」「不伪造 ID」「不同 runtime mode 的 evidence 不互相填充」全部保留；v0.2 新增 11–16 条为加强。
12. **§18 评测框架**：E1–E5、数据集、指标与 Shadow 阈值保留。
13. **§13.2 Channel Matrix（A-20）**：v0.1 原文完全保留，仅追加 `confirmedClaimAllowed=false` 说明；其 Implementation Status 在 v0.2.1 中为 `PROPOSED`。
14. **§15.4 / ADR-013**：`returned ≠ confirmed ≠ behavioral effect` 的三段分离继续保留；v0.2.1 增加 `HostSubmissionOutcome` 是**再加一层独立性**，不是放宽。
15. **§12.5 规则 1–10**：全部保留；v0.2 追加 11–16、v0.2.1 追加 17–19 均为加强，不改变原义。
16. **§3.3 同步 Hook 不做外部模型推理**、**§10.4 deferred worker 需要独立验证**、**§19 Gate 0–5 顺序**：全部保留；v0.2.1 只修复状态语义与统计口径，不提前开启任何门禁。

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
| **宿主事件触发 `semanticReevaluationRequired`** | **禁止 / 结构性标志隔离** | §5.2.3 + T-19 | 不得通过标志、延迟任务或下一个 `BEFORE_MODEL_TURN` 间接重决策 |
| **`HostSubmissionOutcome` 的无证据升级** | **禁止（默认 `unknown`）** | 独立宿主证据 + T-20 / OQ-29 | 不得由 Hook 失败推断 blocked，不得向其它宿主外推 |
| **证据不足时标记 `PASS`** | **禁止（须 `INSUFFICIENT_EVIDENCE`）** | T-24 / §17.3.3 | 不得用总体 N 借给关键分层 |

---

# 8. 定稿检查清单（v0.2.1）

- [ ] A-01…A-48 经 Owner 审阅并逐条决定接受 / 修改 / 拒绝 / 延后；确认 §0.2 三维度分离与 A-20 状态更正。
- [ ] 特别确认四个方向性结论：① 删除 determinism-first rule；② Deferred Refresh 载体改回 PD 既有 worker；③ 交付证据为**四维**状态机；④ 结构性重校验与语义重新决策彻底隔离。
- [ ] 以 5.9.2 / 2.165.0 / 0.2.2 重新冻结 WorkBuddy profile（含 engine SHA-256、`pluginConfigSha256`、`effectiveHookSetFingerprint`、`effectiveSourceCoverage`）。
- [ ] P0 六步修复按 §19 顺序执行，阶段归因先于任何优化。
- [ ] 隔离 lab 重建，P1/P3/P4/P6 在 2.165.0 上执行；未通过前 A-48 各项保持 OFF。
- [ ] T-19…T-25 定义经 Owner 确认；所有条目的 Implementation Status 保持 `PROPOSED`，不得提前标 `SPEC_REVISED` / `TESTED` / `RUNTIME_VERIFIED` / `ACCEPTED`。
- [ ] §17.3.3 三层统计口径与 `INSUFFICIENT_EVIDENCE` 发布裁定经统计设计复核（OQ-28）。
- [ ] `PD Host Event Capability Matrix v0.1` 原始证据路径补齐，或明确标注 HISTORICAL / 不可复核。
- [ ] 保持 SPEC v0.4 原文不变；本修正案作为独立文件进入 PR 评审。
- [ ] 本轮结束后停止：不修改生产代码、不实施功能、不创建 PR、不部署发布、不提交 Git commit。

---

# 9. v0.2.1 一致性自查与 Owner Review 状态

## 9.1 类型定义与状态转换总表（v0.2.1 delta）

| 类型 / 状态 | v0.2 | v0.2.1 | Baseline Provenance |
|:---|:---|:---|:---|
| `HookExecutionStatus` | `completed / degraded / timeout / failed` | 增加 `unknown`（原因不明的终止） | `REVISED_IN_V0_2_1` |
| `PayloadStatus` | `none / prepared / returned / confirmed / unknown` | 不变 | `RETAINED_FROM_V0_2` |
| `SelectionStatus` | `selected / skipped / unavailable` | `selected / none_applicable / skipped / unavailable` | `REVISED_IN_V0_2_1` |
| `HostSubmissionOutcome` | 不存在 | `proceeded / blocked / unknown`，默认 `unknown`，仅独立宿主证据可升级 | `NEW_IN_V0_2_1` |
| `ReceiptState` | `open / closed / reconciled`（含义未严格定义） | 明确：已开始无终态 / 已产生终态 / 对账已完成（任何结果）；`reconciled` 不代表成功 | `REVISED_IN_V0_2_1` |
| `DeliveryIntegrity` | 三维 + evidence | 四维 + `hookInvocationId` + `hostRequestId?` + `correlationStatus` + `reconciliation.outcome` | `REVISED_IN_V0_2_1` |
| `hookInvocationId` | 不存在 | wrapper 最早入口生成，全链路同一标识 | `NEW_IN_V0_2_1` |
| 状态迁移 | T0–T4 / D1–D5 | T0（grade=`RUNTIME_VERIFIED`）、T1–T3、T4a/b/c、D1–D6、S0/S1/S2 | `REVISED_IN_V0_2_1` |
| 不变量 | 6 条 | 12 条 | `REVISED_IN_V0_2_1` |
| Journal 关联 | 无 | 无 T0 ≠ kill；T0 无终态 → `unknown`；`unknown` 不升级 | `NEW_IN_V0_2_1` |
| `pluginConfigSha256` / `effectiveHookSetFingerprint` | 单一 `configSha256` | 双指纹 + `fingerprintNormalization` + `effectiveSourceCoverage` + `coveredConfigSources` | `REVISED_IN_V0_2_1` |
| 重校验标志 | 单一 `revalidationRequired` | `structuralRevalidationRequired` / `semanticReevaluationRequired` 独立 | `REVISED_IN_V0_2_1` |
| Task 事件去重键 | `(session_id, task_id)` | 宿主真实事件 id 优先；兜底 `(hostProfileId, session_id, task_id, hook_event_name)`；`correlationStatus` | `REVISED_IN_V0_2_1` |
| 统计验收 | 单层（200/格 + 95% 上界） | 三层：性能观测 / 分层失败率 / 发布裁定（`INSUFFICIENT_EVIDENCE`） | `REVISED_IN_V0_2_1` |
| 状态维度 | 单列混用 | `Review Disposition` / `Implementation Status` / `Baseline Provenance` | `REVISED_IN_V0_2_1` |
| 新增事件 | 14 个 | 18 个（+`journal_t0_written`、`host_submission_outcome_observed`、`structural_revalidation_recorded`、`none_applicable_selected`） | `REVISED_IN_V0_2_1` |
| ADR | 015 / 016 / 017 | 015–017 修订 + 018 新增 | `REVISED_IN_V0_2_1` |

## 9.2 Baseline Provenance 索引

| 范围 | Provenance | 说明 |
|:---|:---|:---|
| SPEC v0.4 §2.3 / §6 / §7 / §15.4 / §16 / ADR-001…014 等治理与设计 | `RETAINED_FROM_V0_4` | 原设计继续保留，**不代表 v0.2.1 修订已实现** |
| v0.2 §2.1 / §2.2 / §2.4 / §2.5 / §2.10 / §2.12 / §3.1 / §10.4 / §12.3 等未在本轮改动的段落 | `RETAINED_FROM_V0_2` | 完整沿用 |
| §0.2 / §1 / §5.2.1–5.5 / §8.2 / §8.3.1 / §10.2 / §12.2 / §12.4 / §12.5 / §13.4 / §14 / §15 / §17.3 / §19 / §20 / §21 / §22 / §23 / §24 / §25 | `REVISED_IN_V0_2_1` | 七项定点修订及其引用同步 |
| §0.0、§5.2.2、§5.2.3、§13.4.0/4/5、§9、T-19…T-25、ADR-018、OQ-26…30 | `NEW_IN_V0_2_1` | 本轮新增 |

> **A-20 特别说明**：其 Review Disposition 为 `ACCEPT`，Implementation Status 为
> `PROPOSED`，Baseline Provenance 为 `RETAINED_FROM_V0_2`。v0.2 的
> `SPEC_REVISED` 已被撤销，且不构成 Owner 批准或 SPEC 修改。

## 9.3 测试与验收分层（T-19 … T-25）

见 §5。新增七项测试的分类：**T-19**（单元 + 集成）、**T-20**（单元 + 文档契约）、
**T-21**（集成）、**T-22**（单元 + 文档契约）、**T-23**（单元 + 集成）、
**T-24**（集成 + 统计报告）、**T-25**（文档契约）。
本轮**只定义测试**：未执行单元测试、集成测试或真实运行时探针；T-04/T-05/T-06
保持 `DEFERRED_PENDING_EVIDENCE`。

## 9.4 ADR 与 Open Questions 更新

- ADR-015 增补「结构性 / 语义性分离」与「禁止间接重决策」。
- ADR-016 增补三状态维度、`SPEC_REVISED` 严格定义、`RETAINED_FROM_V0_4`。
- ADR-017 改为「四维独立观察 + 封闭世界默认」并纳入 `hookInvocationId` 与对账语义。
- **新增 ADR-018**：`NONE_APPLICABLE` 是有效语义决策，不是失败。
- OQ-14 / OQ-16 说明同步；新增 **OQ-26**（Task 事件唯一标识是否存在，`UNKNOWN`）、
  **OQ-27**（配置源可观测性，`partial`）、**OQ-28**（p99 CI 与多重比较方法）、
  **OQ-29**（无生产风险的宿主提交证据）、**OQ-30**（Task/Compaction 是否有 request id）。

## 9.5 内部一致性自查（交付前逐项执行，发现问题已修复）

| # | 检查项 | 结果 | 修复 / 说明 |
|:--|:---|:---|:---|
| 1 | 四个交付维度是否存在相互矛盾的状态组合 | **PASS（文本一致）** | §13.4.2 定义 12 条不变量；`submission` 独立于 `execution`/`payload`/`selection`；`open` 时四维均为 `unknown`/`unavailable`；`none_applicable` 与 `skipped`/`unavailable` 互斥且各有明确 T4a/T4b/T4c 迁移 |
| 2 | `TaskCreated` / `TaskCompleted` 是否仍有路径绕过 `principle_decision` | **PASS（无路径）** | §5.2.1 / §5.2.3 / §5.4 / §5.5 / §8.2 / §12.5 规则 16 / §20 C / §21 19 / ADR-015 全部禁止；`HOST_TASK_GRAPH_CHANGED` 为 `STRUCTURAL`；`structural` 不得提升为语义触发；T-07′/T-19 覆盖 |
| 3 | Structural Revalidation 是否可能间接引发 Semantic Reevaluation | **PASS（已隔离）** | §5.2.3 明确禁止「设置标志 / 延迟任务 / 下一个 `BEFORE_MODEL_TURN` 重决策」；§5.5 禁止后续 checkpoint 提升；§20 C / §21 19 / T-19 断言 |
| 4 | Host blocked 是否被错误映射为 Hook timeout | **PASS（已分离）** | §13.4.1 场景表 + S0/S1/S2；不变量 8；§14.3 / §14.5 / §15.4 / §21 21；`timeout` 需独立宿主证据；`exit 2`/`deny`/`continue:false` 按实际执行结果记录 |
| 5 | 没有独立证据时是否仍可能出现 `confirmed` | **PASS（封闭世界）** | 不变量 1/5/9；T3 需 `evidenceReference` + `independentlyVerified=true`；`confirmedClaimAllowed=false`；`reconciled` 不代表成功；`unknown` 不升级 |
| 6 | `NONE_APPLICABLE` 是否在 Receipt / Selection / Scorer 中一致 | **PASS（已统一）** | §13.4.4 三处表格 + §2.16.1 §18.4 Scorer 正式条款；§15.2 `selection.selectionStatus`；§17.3.3 明确不计入 Hook 失败率；§20 / §21 22 / ADR-018 / T-22 |
| 7 | `effectiveHookSetFingerprint` 是否存在未声明的配置来源 | **PASS（显式声明 coverage）** | §8.3.1 列出 3 类 `SOURCE_CONFIRMED` 来源 + `partial` + `unobservableSourcesNote`；§10.2 YAML；§12.2 字段；不变量要求未观测来源不得假定覆盖；§25.2 明确不声称 `complete` |
| 8 | 统计样本量是否与每个发布声明对应 | **PASS（三层口径）** | §17.3.2 定义关键分层；§17.3.3 Layer 2 每分层 N≥300 + 各自 `3/N`；禁止混层；整体声明需多重比较；Layer 3 `INSUFFICIENT_EVIDENCE`；§4 / §20 / §21 23 / T-24 |
| 9 | `SPEC_REVISED` 是否被提前使用 | **PASS（已全面更正）** | §0.2.2 严格定义；§1 A-20 更正；§25.1 全部 `PROPOSED`；§3/§4/§5 状态列统一；全文件仅剩「历史记录 / 禁止提前使用」语境（见 §9.6 说明） |
| 10 | 新旧章节、类型定义、状态表、测试编号、ADR 是否一致 | **PASS（术语与编号统一）** | `revalidationRequired` 已全部替换为双标志；`configSha256` 已全部替换为双指纹（见 §9.6 残留说明）；`T-19…T-25` 从 19 起编号；ADR-018 与 §13.4.4 一致；事件类型 18 个与 §3 一致 |

> 自查结论：10 项均为文本层一致。所有 Implementation Status 为 `PROPOSED`，
> 自查 `PASS` 仅指**文档内部无矛盾**，不代表实现、测试或运行时验证通过。

## 9.6 残留术语说明（不构成矛盾）

| 残留写法 | 位置 | 性质 |
|:---|:---|:---|
| `SPEC_REVISED` | §0.2.2（定义与禁止）、§1（A-20 历史记录与更正）、§25.1（禁止说明）、§9.1/§9.2 | 均为**定义 / 历史记录 / 禁止语境**，无任何条目当前被标为该状态 |
| `configSha256` | §0.0 修订说明、§3「已删除结构」、§9.1 delta、§9.5 自查第 10 条 | 均为**历史对照 / 描述性引用**；当前所有接口只使用 `pluginConfigSha256` 与 `effectiveHookSetFingerprint`，§10.2 的否定说明也已改用新名称 |
| `revalidationRequired` | §0.0 修订说明、§3「已删除结构」 | 均为**历史对照**；当前接口只使用两个拆分标志 |
| 三维 / 六条不变量 | §0.4 第 4 条（v0.1→v0.2 历史）、§9.1 delta | 历史叙述；当前正式文本为四维 / 十二条 |
| `T-04` 标 `DEFERRED_PENDING_EVIDENCE` | §5 | 与 §7 / A-48 一致：需隔离探针 |
| `PASS (amended)` | §1（A-36 被拒绝条目名）、§3「已删除结构」 | 均为**历史引用**；v0.2.1 的 Self-audit 全部改用 `PROPOSED` 等状态，任何提案不得标 `PASS` |

## 9.7 OPEN 问题（不编造结论，明确保留）

| # | OPEN | 当前裁定 |
|:--|:---|:---|
| O-01 | WorkBuddy Task 事件是否存在宿主真实事件唯一标识 | `UNKNOWN`（OQ-26）；当前只用 §5.2.2 复合键 |
| O-02 | `effectiveSourceCoverage` 能否达到 `complete` | `UNKNOWN`（OQ-27）；当前 `partial`，profile 上限 `CONDITIONALLY_VERIFIED` |
| O-03 | p99 置信区间与多重比较的规范方法 | `UNKNOWN`（OQ-28）；当前只要求「必须声明」 |
| O-04 | 如何在不触碰生产会话的前提下取得宿主提交独立证据 | `UNKNOWN`（OQ-29）；`submission` 保持 `unknown` |
| O-05 | 12 s 自降级的阶段归因、p95/p99、失败率 | `NOT_RUN`；P0 生产问题**仍开放** |
| O-06 | 当前 2.165.0 请求级 `confirmed` 证据 | `NOT_RUN`；不得声明 |
| O-07 | host async hook / `PROBE_PENDING` 生命周期事件的启用 | `DEFERRED_PENDING_EVIDENCE`；A-48 保持 OFF |
| O-08 | SPEC v0.5 是否已合入、Owner 是否批准 | 否；所有条目 `PROPOSED` |

## 9.8 Owner Review 状态与最终裁定

> ## **READY_FOR_OWNER_REVIEW_WITH_OPEN_QUESTIONS**

- 七项定点修订已完成并同步全部引用章节；文档内部一致性自查 10 项通过（仅文本层）。
- 采用 `WITH_OPEN_QUESTIONS` 而非 `READY_FOR_OWNER_REVIEW`，是因为 §9.7 的
  O-01…O-07 仍为 `UNKNOWN` / `NOT_RUN` / `DEFERRED_PENDING_EVIDENCE`，且不
  影响「修正案可提交评审」这一结论。
- **本修正案完成不代表 SPEC v0.5 已定稿，不代表 P0 生产问题已修复，更不代表
  可以启动 Shadow / Live。** 所有 Feature Flag 保持 OFF，A-48 各项保持 OFF。

### 交付与自律核对

| 项 | 结果 |
|:---|:---|
| SPEC v0.4 原文 | 未修改（SHA-256 `c022cd66a73d2d644e6b91e24df280b08772ae3a93e77a97e7b30268e5b520c4`） |
| Amendment v0.2 | 未修改（SHA-256 `f8b0cd2381a815187f245f6a8f30b772869a5fc922e85f3736a669dc4988a83b`） |
| 第二轮审查报告 | 未修改（SHA-256 `763e783f8b45c6123e8bd65d50f9426490bd56cac1aa8cd9c2f944c50ca26d31`） |
| 生产代码 / 宿主配置 / 生产数据库 / 用户会话 | 未修改 |
| Feature Flag / Shadow / Live / 真实宿主探针 | 未开启 / 未执行 |
| Git commit / PR / 部署 / 发布 | 未执行 |
| `docs/audit/` 的 Git 状态 | 被 `.gitignore:258` 的 `/docs/audit/` 忽略；本轮新增文件为未跟踪且被忽略，**不产生已跟踪工作区变更** |
| 本轮新增文件 | 仅 `docs/audit/PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.2.1.md` |

---

**END OF PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.2.1.md**
