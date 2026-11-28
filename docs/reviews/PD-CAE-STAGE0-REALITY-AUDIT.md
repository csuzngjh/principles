# PD-CAE Stage 0 Reality Audit

> 审查对象：`docs/specs/PD-CAE-SPEC-v1.1-20261128.md` 与 `docs/specs/PD-CAE-SPEC-v1.0-REVIEW-20261128.md`  
> 代码基线：`csuzngjh/principles @ e30202366f53df60ccaf7589f7988cf445a52fba`（origin/main）  
> 只读快照：`D:\Code\pd-cae-stage0-e302023`  
> 本地工作区：`D:\Code\principles`。任务开始时本地 `main` 为 `3f068988cf04b22501a5c190f52f88630d1cb12f`，落后 origin/main 9 个提交；审查期间 reflog 记录了一次 `merge origin/main: Fast-forward`（2026-11-28 16:15 +0800），最终核验时本地 HEAD 已为 `e30202366f53df60ccaf7589f7988cf445a52fba` 并与 origin/main 同步。工作区仍存在与本次审查无关的 dirty/untracked 文件，未清理、未重置、未覆盖。  
> 审查性质：**Stage 0 read-only reality audit**。未修改生产代码、配置、数据库、RuleCode、Shadow/Live 状态；未创建 PR；未安装依赖；未进入 Stage 1。  
> 测试状态：**NOT RUN**。本报告只使用静态源码、现有测试源码和只读 Git 证据；未声称任何测试实际通过。

---

## 1. Executive Summary

**最终判断：`LIMITED`。**

SPEC v1.1 的方向总体正确：它已经撤回了 v1.0 中过早的 `occurredAt`、时间窗、通用 Temporal Helper、RuleContextV3、新事件库和 Service Host 改动，转向先审计 `tool_calls → RuleContextV2 → RuleCode → Host Gate` 的证据质量。这个收敛与当前代码现实基本一致。

但 Stage 0 证明：当前生产链路**还不能支撑“失败后未经重新观察不得重复同一高风险操作”这类依赖行为顺序、失败事实和否定证据的可信 Shadow/Live 治理**。阻塞点不是缺少 Temporal Engine，而是更基础的证据语义：

1. `tool_calls.outcome='unknown'` 可以生产写入，但 `assembleBehaviorHistory()` 只接受 `success/failure/blocked`；任一行 `unknown` 会使整个 history window 变为 unavailable。失败事实在最需要它的场景中不可靠。
2. `sequenceId` 实际是 `tool_calls.id`，只代表 SQLite insertion identity；`created_at` 是写入/补记时间，不是动作发生时间。异步 verified backfill 可插入晚到的行，因此不能证明真实 ordering。
3. OpenClaw 适配器未把宿主 `toolCallId/runId` 传入 shared HostEvent；无身份时 writer 使用内容形状 dedupe，逐字节相同的重复调用会被折叠，恰好破坏“重复尝试”计数。
4. OpenClaw 在 truncated/execute/other 不透明窗口中仍可能输出 `priorReadOfTarget='no'`，而 Codex/WorkBuddy 已做 conservative degradation；三宿主事实语义不同。
5. Gate 覆盖存在结构性盲区：仅 write/execute/agent 进入评估；agent 多数无路径而实际零覆盖；MCP/unknown tools 落入 other；shell 的无目标命令会把整串 command 当作 `normalizedPath`，不等于资源归因。

因此，SPEC v1.1 **不需要推翻，但需要修订和收紧**：把 Stage 1–4 全部改为 conditional decision points；把 repeated-failure/Ordering 明确挂在“顺序、outcome、target attribution、host readiness 可证明”之后；当前唯一可批准的是只读/离线证据审计与 characterization fixtures，而不是生产 Shadow 扩张。

---

## 2. 当前 HEAD 与近期重构影响

### Git 基线

- 审查目标基线：`e30202366f53df60ccaf7589f7988cf445a52fba`。
- 任务开始时，本地 `D:\Code\principles` HEAD 为 `3f068988cf04b22501a5c190f52f88630d1cb12f`，落后 origin/main 9 个提交；因此主 Agent 使用独立只读快照 `D:\Code\pd-cae-stage0-e302023` 审查目标代码，避免覆盖工作区。
- 交付前最终核验时，reflog 显示本地 main 已在 2026-11-28 16:15 +0800 对 origin/main fast-forward；当前 HEAD 与 origin/main 均为 `e30202366f53df60ccaf7589f7988cf445a52fba`（ahead=0, behind=0）。因此本报告源码行号同时对应审查目标基线与最终 origin/main。
- 工作区仍包含与本次审查无关的 dirty/untracked 文件（包括若干 website/asset 文件状态）；本报告新增两个审查文档是本次任务的唯一写入，未触碰生产文件、配置、数据库或既有 SPEC。

### PR #2810 后 Service Host 架构

源码支持 SPEC 的边界判断：

- `pd service run-once` 是唯一 managed Service Host 入口，worker 以 bounded `--once` 形式运行；`packages/pd-cli/src/program.ts` 中 Service Host/worker 命令注释明确“no continuous mode”。
- 三宿主 worker 通过 Service Host ownership admission；RuleHost 求值仍只在同步 host hook 内发生。
- 未发现后台 RuleHost Consumer 或可复活入口。
- OpenClaw Gateway 进程内仍有 CorrectionObserver、telemetry/retention timer 等非 RuleHost consumer 型周期任务；若 Owner 的“后台唯一性”是指“consumer scheduling 唯一”，现状合规；若指“宿主进程零后台任务”，则需另行解释。

**结论：** CAE 不应也不需要修改 Service Host。任何后续周期性分析若需要存在，必须进入既有 Service Host owned task 流程；但最小 CAE 路线不需要它。

---

## 3. 最新 Runtime 架构和真实调用链

### 3.1 同步 RuleHost 生产链

```text
OpenClaw / Codex / WorkBuddy before-tool hook
  → host adapter decode / wiring
  → createProductionHostRuntime(...)
  → createProductionRuleHostGate(...)
  → ToolSemanticRegistry.resolve(toolName)
  → isRuleHostEvaluableKind(write|execute|agent)
  → buildRuleHostAction(...)
  → optional host ruleContextProvider → RuleContextV2
  → state.db activation + artifact digest + Owner approval checks
  → rule implementation child-process/vm batch
  → validate/normalize RuleHostResult
  → mergeDecisions(...)
  → HostEventResult
  → host-specific output enforcement
```

关键源码：

- `packages/host-runtime/src/index.ts`：`createProductionHostRuntime`/`createProductionHostRuntime` 接线。
- `packages/host-runtime/src/production-rulehost-gate.ts:345-360`：只评估 write/execute/agent；`normalizedPath` 为 null/empty 时提前 allow。
- `packages/principles-core/src/runtime/internalization/rule-host-input-builder.ts:312-314`：`isRuleHostEvaluableKind` 的单一语义权威。
- `packages/principles-core/src/runtime/internalization/rule-host-evaluator.ts:46-158`：`mergeDecisions`，优先级 block > auto_correct > requireApproval > allow。
- `packages/host-runtime/src/production-rulehost-gate.ts:1025-1052`：只有 RuleCode `block` 会转为 shared `deny`；非 block 最终以 `decision:'allow'` 加 metadata 返回。

### 3.2 一条还是多条路径？

**决策计算基本收敛**：三宿主生产 wiring 都进入 shared production gate；未发现存活的旧 RuleHost class 决策链。

**端到端效果未完全收敛**：

- OpenClaw 会解释 `auto_correct`/`requireApproval` metadata；见 `packages/openclaw-plugin/src/hooks/gate.ts:663-705`。
- Codex encoder 只支持 PreToolUse deny；`packages/codex-adapter/src/codec/output-encoder.ts:20-37`。
- WorkBuddy encoder 同样只把 PreToolUse deny 作为阻断；`packages/workbuddy-adapter/src/codec/output-encoder.ts:44-63`。
- 因此同一 RuleCode decision 在不同宿主上的 host effect 不同。

### 3.3 资源与盲区

`buildRuleHostAction` 的 target extraction 不是完整资源语义：

- direct path 只识别 `file_path/path/file/target`：`rule-host-input-builder.ts:232-237`。
- shell mutation regex 只覆盖有限的 `>|>>|sed -i|rm|mv|mkdir|touch|cp` 形态：`rule-host-input-builder.ts:239-247`。
- shell 无清晰文件目标时返回整串 command 且 `isPath=false`：`rule-host-input-builder.ts:248-250`；这意味着它仍可能进入 gate，但 `normalizedPath` 是 opaque command，不是可关联资源。
- pathless write 使用 synthetic `<tool:...>`：`rule-host-input-builder.ts:253-255`，可防止“无路径即跳过”，但不是实际资源。
- agent canonical kind 虽在 evaluable set 中，但多数 agent 参数无 path，实际在 `production-rulehost-gate.ts:360` 被放行；agent 子行为不可见。
- Codex 插件 PreToolUse matcher 在 `plugins/principles-disciple/hooks/hooks.json:3-6` 仅覆盖 `Bash|apply_patch|pd_submit_pain`，比 shared gate 更窄。

---

## 4. Trajectory 数据权威与完整性审查

### 4.1 真实数据流

```text
Host tool event
  → host decoder / adapter
  → shared production pain evidence handler
  → sanitize params/result
  → INSERT tool_calls
  → optional transcript verified outcome UPDATE/INSERT
  → host-specific history reader
  → assembleBehaviorHistory
  → computeBehaviorFacts
  → RuleContextV2
  → RuleCode
```

### 4.2 `tool_calls` 能证明什么

可证明：

- 某一时刻有一条宿主工具调用观测被写入 SQLite。
- 新写入路径可携带 `tool_use_id/project_dir/host_kind`；shared live INSERT 见 `packages/host-runtime/src/production-pain-evidence.ts:526-557`。
- `params_json`/`result_preview` 是 sanitized/bounded evidence projection，不是原始完整 payload。

不能证明：

- 所有行为都被捕获。
- 行为真实因果顺序。
- 业务目标成功。
- 同一逻辑资源。
- “没有发生”某行为。
- 跨宿主同一 session 的归属。

### 4.3 `created_at` 与 `sequenceId`

- live writer 在写入时用 `new Date().toISOString()` 生成 `created_at`：`production-pain-evidence.ts:526-557`。
- verified transcript 对已有 `unknown` row 做 in-place UPDATE；对缺失 row 做 INSERT，且时间同样是补记时刻：`production-pain-evidence.ts:379-413`。
- shared reader按 `created_at DESC, id DESC` 读取：`packages/host-runtime/src/workspace-behavior-evidence.ts:130-135`。
- `assembleBehaviorHistory` 把 row.id 直接放进 `sequenceId`：`packages/host-runtime/src/behavior-history.ts:72-79`。

**结论：** `sequenceId` 只能表示 insertion row id；`created_at` 是 write/backfill time。二者都不能当真实 occurredAt 或 causal order。

### 4.4 `unknown` outcome 与窗口降级

主 Agent 交叉验证纠正了一个子代理分歧：Agent A 曾表述为“unknown 行被静默丢弃”。直接源码证实这不是事实。

真实行为是：

- `RuleToolOutcome` 只接受 `success/failure/blocked`：`packages/principles-core/src/runtime/internalization/rule-context-v2.ts:30`。
- `assembleBehaviorHistory()` 对任何非三值 outcome 直接返回整个 window unavailable：`packages/host-runtime/src/behavior-history.ts:37-40`。
- production writer 却合法写入 `unknown`：`packages/host-runtime/src/production-pain-evidence.ts:91-98`。
- gate 对 history unavailable 的 v2 rules通常逐条 suspended：`packages/host-runtime/src/production-rulehost-gate.ts:757-791`。

**影响：** 这不是把 unknown 伪装成 success/failure，而是“单行 unknown 毒化整窗”。方向保守，但 coverage 损失大，且无法用现有 ABI 表达“该行未知、其他行仍可用”。

### 4.5 `computeBehaviorFacts()` 的三值语义缺口

`computeBehaviorFacts` 在 available window 上计算：

- `priorReadOfTarget` 初始为 `targetPath === null ? 'unknown' : 'no'`：`rule-context-v2.ts:310-321`。
- 只有看到同 normalizedPath 的 read/search 才变 yes。
- 函数本身不看 `window.truncated`：`rule-context-v2.ts:315-337`。

因此，是否保守取决于 provider：

- Codex provider 在 truncated 或存在 execute/other 时把 facts 降为 unknown/null：`packages/host-runtime/src/codex-rule-context-provider.ts:163-178`。
- WorkBuddy provider同样做 conservative degradation，并严格 hostKind attribution。
- OpenClaw assembler直接 `computeBehaviorFacts(history, targetPath, null)`：`packages/openclaw-plugin/src/core/rule-context-assembler.ts:74-85`，无 truncated/execute/other 降级，默认窗口只有 20：`rule-context-assembler.ts:45`。

**结论：** OpenClaw 可把“窗口内没看到”输出为 `no`，这与 SPEC 的三值证据语义冲突。

### 4.6 dedupe、attribution 与 backfill 缺陷

- 有 `toolCallId` 时按 `(session_id, tool_use_id[, host_kind])` dedupe；无身份时按完整内容形状 dedupe：`production-pain-evidence.ts:540-554`。
- OpenClaw adapter 未把宿主 `toolCallId/runId` 传入 HostEvent；写入时 `tool_use_id` 为 NULL：`packages/openclaw-plugin/src/host-runtime/openclaw-host-runtime.ts:214-223` 与 `production-pain-evidence.ts:556-557`。
- 内容形状 dedupe 会折叠同 session 内完全相同的重复调用；这正是 repeated-failure 场景的核心证据。
- verified-only INSERT 不写 `project_dir`，后续严格 project-scoped reader会把它视为 unscoped prior row 并可能降级：`production-pain-evidence.ts:383-413`、`workspace-behavior-evidence.ts:139-141`。
- Codex provider 未传 `hostKind`；WorkBuddy 严格传 `hostKind:'workbuddy'`。跨宿主 session/project 碰撞时二者防御强度不同。

### 4.7 Retention

- 默认 trajectory retention 为 enabled、90 天；最小合法正数为 7 天：`packages/principles-core/src/runtime/trajectory-retention.ts:25-35`。
- sweep 覆盖 `tool_calls/assistant_turns/user_turns/governance_observations`：`trajectory-retention.ts:468-476`。
- 删除前写 audit/export，但 audit 不保留完整 row 内容。

**结论：** `truncated=false` 不能证明完整历史；它只证明某次查询在当前过滤条件和 limit 下没有读到更多 row，不能排除 hook 缺失、dedupe、retention、异步滞后或宿主盲区。

---

## 5. 三宿主 RuleHost 能力矩阵

| 能力 | OpenClaw | Codex | WorkBuddy |
|---|---|---|---|
| PreToolUse 接线 | 进程内同步 hook，覆盖广 | 子进程 hook；PreToolUse matcher 仅 `Bash|apply_patch|pd_submit_pain` | 子进程 wrapper，matcher `*` |
| PostToolUse 接线 | 有 | 有 | 有，另有 PostToolUseFailure |
| 调用身份 | 适配器未透传 toolCallId/runId | `tool_use_id` required，host-authoritative | `call_id/tool_use_id` 可选，缺失不伪造 |
| 事件顺序 | 无可信宿主序号 | 无通用动作序号；tool_use_id 是关联键不是顺序键 | 同左 |
| outcome 可信度 | error/result 形状推断，宿主 error 填充语义 UNVERIFIED | shell 文本结果常先 unknown，transcript 可升级 | 通道契约较强：PostToolUse/Failure 分流 |
| block 是否真实阻止 | SDK contract 支持，宿主执行 UNVERIFIED | PD 只能证明 encoded stdout，宿主执行 UNVERIFIED |  probe 证据最强：deny 阻止且 reason 可达模型 |
| block reason 到 Agent | UNVERIFIED | UNVERIFIED | VERIFIED 较强 |
| requireApproval | 只记录事件后返回 void，不暂停 | 无通道 | 无通道 |
| auto_correct | 唯一有受验证参数改写路径 | encoder 拒绝 modifiedInput | encoder 拒绝 modifiedInput |
| RuleContext 窗口 | 20 行；仅 session；无 host/project/time cutoff | 100 行；project/time cutoff/current id exclusion；未 hostKind 过滤 | 100 行；同 Codex 且严格 hostKind attribution |
| facts 降级 | truncated/execute/other 不降级，可能输出伪 `no` | truncated/execute/other 降级 unknown/null | 同 Codex，且 attribution 更严格 |
| designGate | 无 | 有 Codex-specific designGate | deliberately 无 |
| 失败姿态 | 多数 fail-open | 多数 fail-open | PreToolUse decode/dispatch failure 更偏 fail-closed |

**宿主试点判断：** 当前没有任何宿主满足 repeated-failure Shadow 的全部 readiness 条件。若必须选择第一研究宿主，**Codex 最适合做离线/受控 replay pilot**，因为 tool_use_id、project scope、time cutoff 和 designGate 证据链较完整；但它的 shell outcome unknown 问题必须先解决。WorkBuddy 适合验证真实 deny channel；OpenClaw 在 toolCallId、dedupe、facts degradation 修复前不应作为第一 pilot。

---

## 6. RuleCode 生成与轨迹泛化能力评估

### 6.1 已具备的能力

- Artificer output 支持 `implementationCode`、`requiresContextVersion:2`、case-level `ruleContext`。
- Golden Trace replay 可把显式 `ruleContext` 放入 synthetic RuleHostInput。
- 生成 prompt 要求 canonicalKind-first、禁止把 params 文本当外部事实、要求 unavailable history 下 neutral allow。
- sandbox 能执行完整 JS over `input.context.history.calls`，因此 runtime 表达能力本身不是首要瓶颈。

### 6.2 真正缺口

1. **输入证据缺口（P0）**：没有 target identity、same-action fingerprint、failure boundary、evidenceSinceFailure、retryability、error classification。
2. **评估 oracle 缺口（P0）**：deterministic replay只重放 authored/system cases，不能惩罚 keyword-overfit/case-overfit；没有 holdout、mutation、semantic-equivalence matrix。
3. **生成 contract 缺口（P1）**：prompt 同时说“可读取真实 history”与“不能跨调用观察 ordering”，会阻止或误导轨迹规则生成。
4. **测量缺口（P1）**：Shadow `rulehost_evaluated` 只说明 rule hypothetical decision，不含 gold label、任务后果、是否误拦、正常任务损害或 paired control。
5. **Examiner 缺口（P1）**：当前 executor主要是 offline-stub/synthetic calibration，不能证明真实宿主行为改善。

### 6.3 案例原则可行性

原则：“Agent 在操作失败后，不应未经必要的重新观察或验证，就盲目重复同一高风险操作。”

当前无法可信回答：

- **同一目标**：只有单一 normalizedPath 字符串；shell/patch/multi-target/resource identity 不足。
- **之前失败**：ABI 有 outcome，但生产 unknown 与窗口 unavailable 破坏可靠性。
- **新证据**：没有“failure 之后的有效 observation/verification”事实。
- **幂等重试**：无 idempotency/retry 概念。
- **临时错误**：error type/exit/result preview 不进入 RuleContext ABI。
- **不指定唯一工具**：canonicalKind 有帮助，但无法表达“任一等效 verification action”。
- **跨工具泛化**：host alias adversarial coverage很薄，且常在 author已使用 host-real name 时跳过。

**结论：** 主要缺失不是 runtime 执行能力，而是 input evidence semantics + generation/evaluation oracle。手写规则可以在窄场景扫描 raw history，但不能证明泛化或正确性。

---

## 7. SPEC v1.1 问题清单（P0/P1/P2）

### P0-1 — `unknown` outcome ABI 冲突使失败证据不可靠

- 分类：`VERIFIED`
- 文件：`production-pain-evidence.ts:91-98`、`behavior-history.ts:37-40`、`production-rulehost-gate.ts:757-791`
- SPEC 原要求：先核实 unknown 是否导致异常降级，不得伪造成功/失败。
- 差异：SPEC 怀疑被证实；实际是整个窗口 unavailable，而不是单行 unknown。
- 影响：context-dependent rules coverage 大幅下降；repeated-failure 场景不可信。
- 最小修复：先量化 unknown/upgrade 比例；若修，受控扩展 V2 outcome semantics 或 row-level validity，禁止静默过滤或伪装。
- SPEC 需修订：是，明确这是 Stage 1 readiness blocker。

### P0-2 — 真实 ordering 不可证明

- 分类：`VERIFIED`（静态语义）；生产占比 `UNVERIFIED`
- 文件：`production-pain-evidence.ts:379-413,526-557`、`workspace-behavior-evidence.ts:130-135`、`behavior-history.ts:72-79`
- 差异：SPEC 已正确预见，但未把 repeated-failure pilot 明确挂在 ordering readiness gate 后。
- 最小修复：不新增 occurredAt；先建立 host-native/controlled evidence readiness，ordering 不可证时规则必须 neutral/unknown。
- SPEC 需修订：是。

### P0-3 — target attribution 与覆盖盲区使 same-target 只在窄场景成立

- 分类：`VERIFIED`
- 文件：`rule-host-input-builder.ts:232-258,312-314`、`production-rulehost-gate.ts:345-360`、`plugins/principles-disciple/hooks/hooks.json:3-6`
- 影响：shell opaque command 不是资源；agent 实际零覆盖；MCP/unknown tools不治理；Codex hook 覆盖面比 shared gate更窄。
- 最小修复：Stage 0/1 输出六类 coverage denominator；不要扩大 gate 范围。
- SPEC 需修订：小改，明确“非空 normalizedPath ≠ 资源已归因”。

### P0-4 — `requireApproval` 不是干预能力

- 分类：`VERIFIED`
- 文件：`openclaw-plugin/src/hooks/gate.ts:683-689`、Codex/WorkBuddy output encoders、`production-rulehost-gate.ts:973-981`
- SPEC 已正确声明；需强制执行到指标与文案。
- 最小修复：不扩展能力；shadow/promotion/Examiner 必须区分 ruleDecision/gateDecision/hostEffect。
- SPEC 需修订：不需要大改，但验收标准需更硬。

### P0-5 — RuleCode 生成/评估不能证明真正轨迹泛化

- 分类：`VERIFIED`（静态源码）
- 文件：`artificer-prompt-builder.ts:365-382`、`evaluator`/`golden-trace` replay 路径
- 影响：关键词/case-overfit 规则仍可能通过；无法证明跨工具名称与参数形状泛化。
- 最小修复：离线 holdout/mutation/negative-control matrix；先不修 ABI。
- SPEC 需修订：是，Stage 1 必须包含 evaluation oracle 负控。

### P1-1 — OpenClaw toolCallId 丢失 + 内容 dedupe 折叠真实重复

- 分类：`VERIFIED`（源码）；宿主 id 可用性部分 `UNVERIFIED`
- 文件：`openclaw-host-runtime.ts:214-223`、`production-pain-evidence.ts:540-557`
- 最小修复：确认宿主稳定 id 后窄改 adapter；不得 invent id。

### P1-2 — OpenClaw facts degradation 与 Codex/WorkBuddy 不一致

- 分类：`VERIFIED`
- 文件：`rule-context-assembler.ts:74-85`、`codex-rule-context-provider.ts:163-178`
- 最小修复：若审计确认影响，OpenClaw provider 对齐 conservative degradation；这是行为变化，需要 characterization tests。

### P1-3 — host attribution 防御不一致

- 分类：`VERIFIED`
- 文件：`workspace-behavior-evidence.ts:117-171`、Codex/WorkBuddy providers、OpenClaw legacy reader
- 最小修复：按 pilot host 逐个窄修，不做一刀切。

### P1-4 — verified-only insert 缺 project_dir

- 分类：`VERIFIED`
- 文件：`production-pain-evidence.ts:383-413`、`workspace-behavior-evidence.ts:139-141`
- 最小修复：给 verified outcome write path 传入可证明 project scope；无法证明时明确不可用于 project history。

### P1-5 — Shadow evidence 不能证明价值

- 分类：`CODE-SUPPORTED`
- 影响：wouldBlock/wouldAllow 无法区分正确拦截、误拦、漏拦。
- 最小修复：离线 labeled challenge suite + confusion matrix；不要新增评估数据库。

### P1-6 — 恢复命令保护不是 gate-level invariant

- 分类：`VERIFIED`
- 文件：`rule-host-input-builder.ts` recoveryControl、`production-rulehost-gate.ts`
- 影响：错误 live rule理论上仍可 block deactivate/status 命令。
- 最小修复：promotion negative control；是否加 gate-level hard guard需 Owner 单独决策。

### P1-7 — WorkBuddy host-tool declaration 与 gate evaluable set 存在语义错位

- 分类：`VERIFIED`
- 文件：`packages/workbuddy-adapter/src/tool-semantics.ts`、`packages/principles-core/src/runtime/internalization/tool-semantic-registry.ts:68-80`、`production-rulehost-gate.ts:345-353`
- 实际情况：WorkBuddy host mappings 包含 read/search 类工具，但 shared gate 永远不评估 read/search；`hasHostTool` 的注释语义是“host dispatch 且路由到 RuleHost gate”。因此某些 read/search 规则可能在 activation/reliability 层看似 host-dispatchable，却在生产中永远不会触发。
- 影响：activation coverage 与真实 enforcement coverage 进一步偏离。
- 最小修复：不恢复 runtime filtering；应修正 host declaration/activation validation 的 dispatchability 语义，或显式区分“host knows tool”与“RuleHost-evaluable tool”。
- SPEC 需修订：小改，coverage matrix 必须区分 host-declared、hook-routed、RuleHost-evaluable。

### P1-8 — outcome 语义宿主相关，OpenClaw 可能把“无明确完成证据”记为 success

- 分类：`CODE-SUPPORTED`；宿主真实 error 填充语义 `UNVERIFIED`
- 文件：`production-pain-evidence.ts:53-109`、`openclaw-host-runtime.ts:214-223`
- 实际情况：OpenClaw after-tool output 被包装成 `{error,result,durationMs}`；只要 envelope 是 record 且无 error/exit evidence，normalizeOutcome 倾向 success。Codex shell 文本结果更常落 unknown，WorkBuddy 则由 PostToolUse/PostToolUseFailure 通道契约增强成败判断。
- 影响：outcome 不能作为跨宿主统一强事实；失败恢复与重试治理必须先按宿主建立 outcome evidence matrix。
- 最小修复：不伪造统一语义；为 outcome 增加 evidence source/provenance 或至少按宿主制定 conservative classifier。
- SPEC 需修订：是，host readiness matrix 必须包含 outcome evidence source。

### P2-1 — `affectedTools` 非 runtime filter 易被误读

- 分类：`VERIFIED`
- 现状符合 SPEC/PRI-1187；需要 UI/promotion report 显式说明 declared scope ≠ runtime filter。

### P2-2 — prompt/comment 时代错位

- 分类：`VERIFIED`
- Artificer prompt 的 ordering 表述与 v2 history 能力并存，需文本纠偏；注释中若仍称旧 gate 为唯一权威也需修正。

### P2-3 — retention/coverage metadata 缺失

- 分类：`VERIFIED`
- 否定事实无法区分“未发生”与“证据已删/未采集”。

### P2-4 — legacy OpenClaw writer 仍存在，可能产生低归因混合行

- 分类：`VERIFIED`（代码存在）；当前是否仍被生产调用 `CODE-SUPPORTED/limited`
- 文件：`packages/openclaw-plugin/src/core/trajectory.ts`、`packages/openclaw-plugin/src/hooks/pain.ts:379-393`
- 实际情况：legacy `recordToolCall` writer仍存在；普通 after-tool路径已通过 `recordTrajectory:false` 让 shared kernel owning atomic tool_calls row。若 legacy writer仍被其他路径调用，会写入缺 `tool_use_id/project_dir/host_kind` 的弱归因行。
- 影响：历史窗口混杂新旧证据形态，进一步降低 attribution 与 ordering 可信度。
- 最小修复：Stage 1 只读统计 legacy/unattributed rows；不要在新逻辑中复用 legacy writer。
- SPEC 需修订：不需要，但应在证据质量矩阵中列出。

---

## 8. 已有能力复用清单

**ALREADY IMPLEMENTED / REUSE：**

1. canonical `tool_calls` 与 shared production writer。
2. `RuleContextV2`、validators、`computeBehaviorFacts`、UNAVAILABLE sentinel。
3. host-specific RuleContext providers（虽需语义对齐）。
4. shared production RuleHost gate 与 activation/digest/Owner approval checks。
5. child-process/vm RuleCode runtime、batch timeout、source/output/memory caps。
6. Golden Trace case-level `ruleContext`。
7. Shadow/Live activation、`rulehost_evaluated` telemetry。
8. ToolSemanticRegistry/canonicalKind。
9. recoveryControl grammar marker。
10. Service Host bounded worker ownership。

**不需要新建：** DB、table、background service、Agent、Rule Engine、Temporal DSL、Action Broker、RuleContextV3。

---

## 9. 过度设计风险及明确拒绝的方案

### Reject

- 新 event store / 第二 trajectory DB。
- RuleContextV3 或 parallel ABI 作为第一步。
- TemporalEngine / Temporal DSL / BehaviorTrajectoryV1。
- 实时 LLM rule evaluation。
- 第二套 CAE-only RuleCode executor。
- 后台 RuleHost consumer。
- 把 rowid/created_at 当 causal ordering。
- 为历史行 backfill host/project/occurredAt 并声称可信。
- 用 params/command 文本推断 Owner approval 或外部事实。

### Defer

- `occurredAt`，直到 host-native event time/provenance 可证。
- 通用 Ordering relation，直到顺序证据 readiness 成立。
- 三宿主等价支持。
- requireApproval/auto_correct 作为 pilot intervention。
- durable coverage projection/store。

### Minimal Change

- 当前阶段零生产代码变更。
- 先补 characterization tests/fixtures 与只读 evidence audit。
- 若修复，按 defect 单独窄修：OpenClaw id wiring、unknown semantics、provider degradation、verified project scope。

---

## 10. 最小可落地方案

**最小可交付不是新功能，而是证据闭合：**

1. 静态/只读覆盖率矩阵：按 host 统计 hook unreachable、non-evaluable kind、no target、synthetic target、opaque command、resource-attributed、context unavailable、attribution unprovable、evaluated、matched、shadow wouldBlock。
2. 离线 Golden Trace fixture pack：使用现有 case-level `ruleContext`，覆盖 unknown、truncated、backfill/order inversion、same/different target、execute/other、跨宿主污染、idempotent retry。
3. Characterization tests：固定当前行为，尤其 unknown 全窗 unavailable、OpenClaw truncated facts、content dedupe。
4. 数据质量只读审计：真实 workspace 仅在 Owner另行授权后统计 unknown 占比、upgrade 率、NULL host/project/tool_use_id 占比、truncated 占比。本 Stage 未执行。
5. 只有在上述证据证明某一窄缺陷是唯一瓶颈时，才提出单文件/单链路修复。

---

## 11. 测试证据与尚未验证事实

### 本 Stage 执行状态

- 单元/集成/E2E：**NOT RUN**。
- 真实宿主 probe：**NOT RUN**。
- 真实 workspace DB 查询：**NOT RUN**。
- 测试源码只作为静态 coverage evidence 阅读。

### 场景覆盖核查

| 场景 | 现有覆盖/现实判断 | Stage 0 状态 |
|---|---|---|
| 同目标失败后重复操作 | 无完整 oracle；unknown/order/target identity 阻塞 | 缺失，建议离线 fixture |
| 失败后重新观察再尝试 | 无 evidenceSinceFailure 语义 | 缺失 |
| 资源 A 失败后操作 B | target attribution 不足；shell 不透明 | 缺失 |
| 不同工具别名同类操作 | canonicalKind 基础存在；host alias replay 很薄 | 部分覆盖，泛化不足 |
| outcome unknown | production writer/assembler行为可由源码证明；已有测试固定部分 outcome contract | 静态确认，NOT RUN |
| 异步补记乱序 | 代码证明可能发生；无正式负控 oracle | 缺失 |
| 历史截断 | Codex/WorkBuddy 有 conservative degradation；OpenClaw 无 | 覆盖不一致 |
| 历史过 retention | retention 代码存在；RuleContext 无 coverage metadata | 缺失 |
| 跨宿主同名 session | WorkBuddy 严格；Codex/OpenClaw弱 | 覆盖不一致 |
| Shell/Agent 无法解析资源 | 结构性盲区已确认 | 需 coverage matrix |
| 合理幂等重试 | 无 idempotency 语义 | 缺失 |
| 历史 DB 不可用 | unavailable/suspension 路径存在 | 静态确认，NOT RUN |

---

## 12. 对 SPEC v1.1 的逐章节修订建议

- **§0 决策摘要**：保留。增加“Stage 1–4 均为 conditional decision points，不构成实施批准”。
- **§1 生产事实基线**：大部分正确。修正/补充：`normalizedPath` 非空不等于资源归因；OpenClaw adapter未透传 toolCallId；unknown 是整窗 unavailable。
- **§2 问题与范围**：保留“不解决通用 temporal”。明确 repeated-failure 不是默认可行 pilot，而是 readiness-gated research case。
- **§3 三层边界**：保留。补充 host effect 四元组：ruleDecision/gateDecision/hostEffect/degradedReason。
- **§4 行为轨迹定义**：补充 `blocked` outcome当前无生产来源；`sequenceId` 应命名/解释为 insertion row id；`created_at` 是 write/backfill time。
- **§5 三值语义**：保留。把 Ordering readiness 提升为硬门禁；不存在可证顺序时 repeated-failure不得进入 Shadow。
- **§6 RuleContextV2**：保留“不新建 V3”。但补充：可能需要受控 V2 semantic amendment（row-level unknown/coverage metadata），这不是“完全不改 ABI”。
- **§7 宿主能力**：矩阵基本正确。补充 OpenClaw requireApproval 只是记录、agent实际零覆盖、Codex matcher缺口、OpenClaw facts degradation差异。
- **§8 最小验证场景**：保留作为研究案例，但必须标注当前不可直接进入生产 Shadow；先离线 replay。
- **§9 分阶段实施**：Stage 1 仅限 offline replay/evidence quality；Stage 2 只做被证据迫切的窄修；Stage 3 需 readiness checklist；Stage 4需 recovery hard guarantee。
- **§10 验收标准**：增加 coverage denominator、unknown/order/backfill负控、host effect distinction、keyword-overfit holdout。
- **§11 复杂度上限**：完全保留。
- **§12 停工条件**：补充“若修复需要引入第二数据流/后台 consumer/parallel ABI，立即停工”。
- **§14 v1.0 变更**：保留。
- **§15 源码依据**：保留固定 SHA；本报告已按该 SHA 审查。

---

## 13. H1–H7 交叉验证

| 假设 | 判定 | 结论 |
|---|---|---|
| H1 不需要新事件数据库 | `VERIFIED` | 是。现有 `tool_calls` 足以作为第一阶段证据源；问题是语义和完整性，不是缺 DB。 |
| H2 不需要 RuleContextV3 | `CODE-SUPPORTED` | 不需要 V3；但可能需要受控 V2 semantic amendment 来表达 row-level unknown/coverage。 |
| H3 不需要 Temporal Engine | `VERIFIED` | 不需要。连通用 Ordering 都应 defer 到顺序证据可证之后。 |
| H4 不需要新增 LLM 实时评估 | `VERIFIED` | 生产 gate 是 deterministic RuleCode；LLM 只属于既有离线生成/评审链。 |
| H5 不需要改变 Service Host | `CODE-SUPPORTED` | 是。同步 hook 与后台 consumer 边界已存在，CAE 最小路线不触碰。 |
| H6 不需要马上支持全部宿主 | `VERIFIED` | 必须单宿主。当前无宿主 fully ready；条件性首选 Codex 做离线/受控 replay。 |
| H7 现有代码已解决部分问题 | `VERIFIED` | 是。RuleContextV2、shared gate、Golden Trace、Shadow activation 等已存在；标为 ALREADY IMPLEMENTED。 |

---

## 14. 最终判断与 Stage 1 最小工作范围

### 最终判断：`LIMITED`

不是 `BLOCKED`，因为：

- 现有架构资产充足；
- SPEC 的“不新建系统”方向正确；
- 离线 replay/negative-control 可完全复用现有 Golden Trace/ruleContext。

也不是 `READY`，因为：

- repeated-failure 所需的 ordering、failure outcome、target identity、evidenceSinceFailure 均不可信；
- 三宿主能力与事实语义不一致；
- 生成/评估链不能证明轨迹泛化价值。

### 推荐 Stage 1 最小范围（仍不自动启动）

**只做 offline replay + evidence readiness，不做生产激活。**

预计涉及文件/区域（若 Owner批准）：

- `packages/host-runtime/tests/behavior-history.test.ts` 及相邻测试：characterize unknown/truncated/outcome行为。
- `packages/host-runtime/tests/` 或 `packages/principles-core/src/runtime/internalization/__tests__/`：新增离线 trajectory fixtures/holdout matrix。
- `packages/host-runtime/src/behavior-history.ts`：仅在证据要求下窄修 unknown/row-level semantics。
- `packages/openclaw-plugin/src/core/rule-context-assembler.ts`：仅在证据要求下对齐 conservative facts degradation。
- `packages/openclaw-plugin/src/host-runtime/openclaw-host-runtime.ts`：仅当确认宿主稳定 id 后透传 toolCallId/runId。
- `packages/host-runtime/src/production-pain-evidence.ts`：仅修 verified-only insert project scope 或 dedupe证据问题。
- `packages/host-runtime/src/codex-rule-context-provider.ts`：仅在 pilot 选择 Codex 且证据要求时增加 hostKind attribution。
- `packages/principles-core/src/runtime/internalization/artificer-prompt-builder.ts`：仅当进入生成实验时，澄清 bounded history 与 ordering 限制。

**Stage 1 不应触碰：** Service Host、数据库 schema、生产 RuleCode activation、RuleContextV3、Temporal Engine、后台 consumer。

---

## 15. 子代理交叉验证记录

本审查使用多个独立子代理覆盖 Runtime/RuleHost、Trajectory/data credibility、host capability、RuleCode generation/evaluation、complexity/regression。主 Agent 对关键冲突进行了源码裁定：

- **冲突 1：unknown 行是“静默丢弃”还是“整窗 unavailable”？**  
  裁定：后者。`behavior-history.ts:37-40` 对无效 outcome 直接返回 unavailable；不是静默丢弃。
- **冲突 2：SPEC 所称“缺 normalizedPath 即提前 allow”是否覆盖全部盲区？**  
  裁定：只覆盖 null/empty。shell 无资源时可能以整串 command 作为非空 normalizedPath 进入评估，因此“被评估”不等于“资源可归因”。
- **冲突 3：Service Host 是否被 CAE 影响？**  
  裁定：无影响。未发现后台 RuleHost consumer；CAE 最小路线不需要后台任务。
- **冲突 4：是否可立即选择 OpenClaw 作为第一 pilot？**  
  裁定：不建议。OpenClaw hook 覆盖广，但 toolCallId/dedupe/facts degradation/ordering证据弱；条件性首选 Codex 做离线 replay，WorkBuddy用于验证 deny channel。

---

## 16. 审计边界

- 未审查真实生产 workspace 数据；因此 unknown 占比、NULL host/project/tool_use_id 占比、truncated 占比、shadow wouldBlock 分布全部 `UNVERIFIED`。
- 未验证宿主真实执行 deny/modified input 的端到端行为；仅按源码 contract 与已有 probe 注释分类。
- 未验证 PR #2810 的 GitHub 编号本身；只验证当前源码中的 Service Host ownership 结构。
- Error Context 路由：任务开始时 plan mode 无自动匹配，已人工查看 Pattern Index 中 EP-06/EP-12；交付前 diff mode（`--base origin/main`）仍无自动匹配。
- PD-Lab 判定：`NOT_REQUIRED`。本任务是纯只读架构审查与文档交付，未运行 Agent behavior experiment。
- 本报告不构成 Stage 1 批准。
