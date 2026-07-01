# RuleHost Owner Runbook

> **状态**: Active
> **最后更新**: 2026-07-01
> **关联代码**: `packages/openclaw-plugin/src/core/rule-host.ts`
> **关联文档**: `docs/architecture/ACTIVATION_CHANNELS.md`
> **适用角色**: RuleHost owner / oncall
> **编号说明**: R2-RH-001 = 本 runbook；R2-RH-002 = armed-but-empty warn（代码侧已落地）；R2-RH-004 = principleId lineage（代码侧已落地）

---

## 1. 概述与适用范围

RuleHost 是 PD（Principles Disciple）`code_tool_hook` 激活通道的运行时执行器。它在 `before_tool_call` 钩子中被调用，加载并执行 owner 审批通过的实现代码，对工具调用产出 `block` / `requireApproval` / `allow`（no-opinion）决策。

本 runbook 覆盖 owner 日常运维 RuleHost 时会遇到的核心场景：

- **armed-but-empty 警告**（R2-RH-002）：RuleHost 已武装但加载到 0 条激活
- **principleId lineage 排障**（R2-RH-004）：`recordRuleEnforced` 记录了错误的 principleId
- **四通道激活与回滚**：如何查看、promote、停用激活
- **Shadow mode 与人审流程**：shadow → live 的转换路径

**不在本 runbook 范围**：`prompt` / `defer_archive` 通道的内部实现（低风险自动通道，无需 owner 介入）、`skill` / `model_training` 通道（MVP 未落地）。

---

## 2. 架构速览

### 调用链

```
Agent 发起 tool_call
    │
    ▼
hooks/gate.ts (before_tool_call)
    │  line 62: wctx.getRuleHost(logger)
    │  line 93: ruleHost.evaluateDetailed(...)
    ▼
rule-host.ts: _loadActiveCodeImplementations()   ← line 233
    │  从 SQLite activations 表加载 active code_tool_hook 激活
    │  JOIN pi_artifacts 取 content_json → 提取 implementationCode → 隔离 vm 编译
    ▼
对每条激活执行 evaluate() → 合并决策
    │
    ▼
返回 { decision: 'block' | 'requireApproval' | undefined, ruleId, principleId }
    │
    ▼
gate.ts: 根据决策阻断 / 要求人审 / 放行
```

### 关键不变量

- **PRI-436**：每个 `target_ref` 至多一条 active 激活；重复的会被 skip 并 warn
- **rc-9**（no silent fallback）：RuleHost 加载失败或空载时必须发 warn，不能静默降级
- **rc-6**（lineage consistency）：`recordRuleEnforced` 记录的 principleId 必须是真正的 principle ID，不能是 rule ID

---

## 3. 四激活通道

> 详见 `docs/architecture/ACTIVATION_CHANNELS.md`。此处仅列 owner 运维相关摘要。

| 通道 | 实现入口 | 风险等级 | Owner 介入点 |
|---|---|---|---|
| `prompt` | `low-risk-writers.ts` `PromptWriter` | 低（自动） | 无需介入；`pd activation list --channel prompt` 可查看 |
| `defer_archive` | `low-risk-writers.ts` `DeferArchiveWriter` | 低（自动） | 无需介入；`pd activation list`（不带 `--channel`）可查看，含 defer_archive |
| `code_tool_hook` | `writers/rule-host-writer.ts` `RuleHostWriter` | **高（强制人审 + shadow）** | **本 runbook 主要对象** |
| `RuleHost`（运行时执行器） | `openclaw-plugin/src/core/rule-host.ts` | — | 加载并执行 active impl |

`LOW_RISK_CHANNELS = ['prompt', 'defer_archive']`（`activation-types.ts:7`）。这两个通道自动生效，不经过 RuleHost，owner 通常无需干预。`code_tool_hook` 通道的激活必须经过人审 + shadow mode，最终由 RuleHost 在运行时执行。

---

## 4. armed-but-empty 警告诊断（R2-RH-002）

### 4.1 警告含义

RuleHost 已武装（被 gate.ts 调用）但加载到 0 条 active `code_tool_hook` 激活。这是一个**可观测性信号，不是降级**——RuleHost 在空载时正确返回 no-opinion（`undefined`），gate 放行。warn 的目的是让 owner 能区分"RuleHost 工作正常但无规则"与"RuleHost 坏了"。

### 4.2 触发条件

两种情况都会触发 warn（`rule-host.ts:233-249`）：

| 条件 | 代码位置 | 原因 |
|---|---|---|
| (a) `workspaceDir` 未配置 | line 234-239 | RuleHost 构造时未传 workspaceDir，无法定位 SQLite |
| (b) 已配置但 `loaded.length === 0` | line 244-249 | 有 workspaceDir，但 activations 表无 active code_tool_hook 记录 |

### 4.3 警告消息

```
[RuleHost] armed but empty — 0 active code_tool_hook activations loaded (RuleHost will not block or require approval). nextAction=If this is unexpected, run `pd runtime activation list --channel code_tool_hook` to inspect activations, or `pd runtime activation promote` to enable a live rule
```

### 4.4 去重机制

`emptyLoadWarnEmitted` 布尔标志（line 270-271）保证每个 RuleHost 实例最多发一次 warn。重复 evaluate 调用不会刷屏。**重启 agent / 重建 RuleHost 实例会重置该标志**，warn 会复现。

### 4.5 诊断流程

```
[观察到 armed-but-empty warn]
        │
        ▼
[这是预期空载吗?]  ──── 否 ────►  [pd activation list --channel code_tool_hook]
        │                                    │
        是                                   ▼
        │                            [有 shadow activation?]
        ▼                                    │
[可忽略 — 去重已生效，                       │
 不再刷屏]                          ┌───────┴───────┐
                                    ▼               ▼
                                   是              否
                                    │               │
                                    ▼               ▼
                          [pd activation promote    [检查 dispatch 流程：
                           --activation-id <id>      artifact validationStatus
                           --confirm]                是否 = validated？
                           → shadow 转 live]        approval 是否 pending？]
                                    │
                                    ▼
                          [重新触发 tool_call 验证
                           warn 不再复现，RuleHost
                           开始产出决策]
```

**判断"预期空载"**：如果当前 workspace 确实没有任何 validated 的 code_tool_hook artifact，或所有激活都已 deactivate，则空载是正确的，warn 提示你去确认——确认无误后可忽略。

### 4.6 常见根因与处置

| 根因 | 症状 | 处置 |
|---|---|---|
| workspaceDir 未配置 | warn 消息含 "workspaceDir not configured" | 检查 RuleHost 构造参数；确认 OpenClaw workspace 已正确初始化（`pd runtime init --confirm`） |
| 无 validated artifact | `pd activation list` 返回空 | 跑 `pd trace show --pain-id <id>` 确认 pain→artifact 链路是否走通；artifact validationStatus 是否 = validated |
| artifact validated 但未 dispatch | activations 表无记录 | `pd runtime activation dispatch --artifact-id <id> --channel code_tool_hook --confirm` |
| dispatch 了但还在 shadow | `pd activation list` 显示 action=`code_tool_hook_shadow_activate` | `pd activation promote --activation-id <id> --confirm` 转 live |
| activation 被 deactivate | `--include-deactivated` 能看到但默认 list 看不到 | 重新 dispatch 或确认是否误 deactivate |

---

## 5. principleId lineage 诊断（R2-RH-004）

### 5.1 问题背景

`gate.ts:135/164` 调用 `eventLog.recordRuleEnforced()` 时会记录 `principleId`。该 ID 必须是真正的 **principle ID**（来自 Ledger `principles[id]`），不能是 rule ID。R2-RH-004 之前，`result.principleId` 总是被设为 `meta.ruleId`（一个 rule ID），违反 rc-6（lineage consistency）。

### 5.2 修复后的 precedence 链

`rule-host.ts:591`：
```
result.principleId = contentPrincipleId ?? sourcePrincipleId ?? meta.ruleId ?? ruleId
```

优先级（从高到低）：

| 优先级 | 来源 | 代码位置 | 说明 |
|---|---|---|---|
| 1 | `contentJson.principleId` | line 533-535 | artifact payload 中显式声明的 principleId（最权威） |
| 2 | `pi_artifacts.source_principle_id` | line 399-404 | DB lineage 字段（artifact 创建时写入） |
| 3 | `meta.ruleId` | line 591 | rule ID（fallback，非 principle ID） |
| 4 | `ruleId` | line 591 | 最后兜底（ruleId 本身来自 contentJson.ruleId ?? sourceRuleId ?? artifactId） |

### 5.3 排障步骤

**症状**：`recordRuleEnforced` 日志 / eventLog 中 principleId 看起来像 rule ID（如 `rule-xxx`）而非 principle ID（如 `principle-xxx` 或 UUID）。

1. **查 artifact payload**：`pd trace show --pain-id <id>` → 找到对应 artifact → 检查 `content_json.principleId` 字段是否存在且正确
2. **查 DB lineage**：artifact 的 `source_principle_id` 列是否被正确写入（由 artifact 创建链路负责）
3. **确认 fallback 层级**：如果前两级都缺失，principleId 会退化到 `meta.ruleId`——这是设计内的 fallback，但说明 artifact 创建时未携带 principleId，应回溯 artifact 生成链路

### 5.4 预防

新建 code_tool_hook artifact 时，确保 `content_json` 包含 `principleId` 字段，或 artifact 创建链路正确写入 `source_principle_id`。这是上游 dreamer/philosopher/scribe 的职责，不在本 runbook 范围。

---

## 6. Shadow mode 与人审流程

### 6.1 为什么需要 shadow

`code_tool_hook` 通道的激活会执行 owner 提供的实现代码（在隔离 vm 中）。为防止未验证的规则破坏 agent 行为，所有 code_tool_hook 激活必须：

1. **经过人审**：artifact validationStatus = validated 后，进入 ApprovalQueue 等待 owner approve
2. **先 shadow 后 live**：approve 后默认以 `shadow` 模式激活（`action = code_tool_hook_shadow_activate`），RuleHost 加载但不真正阻断；owner 确认效果后再 promote 为 live

### 6.2 shadow → live 转换

```
pd activation list --channel code_tool_hook
    → 找到 action = code_tool_hook_shadow_activate 的激活
    → 记下 activation-id

pd activation promote --activation-id <id> --confirm
    → action 变为 code_tool_hook_live_activate
    → RuleHost 下次 evaluate 时产出真实 block/requireApproval 决策
```

### 6.3 人审流程

```
artifact validationStatus = validated
    │
    ▼
[ApprovalQueue 入队]  ← 自动
    │
    ▼
pd activation approve --approval-id <id> --decided-by <name>
    │
    ▼
[ApprovalCompletionService 触发 dispatch]
    │
    ▼
[以 shadow 模式写入 activations 表]
    │
    ▼
[owner 观察 shadow 效果]
    │
    ▼
pd activation promote --activation-id <id> --confirm
    → live
```

**修改 artifact**：approve 前如需修改 artifact，可用 `pd runtime activation edit --approval-id <id> --new-artifact-id <new>`（P1 #2 owner edit 入口）。

---

## 7. CLI 命令清单

> 所有命令支持 `-w, --workspace <path>` 指定工作目录（默认：`D:\.openclaw\workspace` 或当前目录 `.pd/`）和 `--json` 输出机器可读格式。

### 7.1 激活管理（promoted 顶层命令）

| 命令 | 用途 | 关键 flag |
|---|---|---|
| `pd activation list` | 列出所有激活（默认仅 active） | `-c, --channel <channel>` 过滤通道；`--include-deactivated` 含已停用 |
| `pd activation deactivate` | 停用一条激活（回滚） | `--activation-id <id>`（必填）；幂等（PRI-408 Contract E） |
| `pd activation approve` | 审批 pending approval 并触发 dispatch | `-a, --approval-id <id>`（必填）；`--decided-by <name>`；`--note <text>` |
| `pd activation promote` | shadow → live（R2-RH-002 修复路径） | `--activation-id <id>`；`--confirm` 实际执行（默认 dry-run） |

### 7.2 激活派工（hidden runtime 子命令）

| 命令 | 用途 | 关键 flag |
|---|---|---|
| `pd runtime activation dispatch` | 为 validated artifact 派工激活 | `-a, --artifact-id <id>`；`-c, --channel <channel>`（默认 prompt）；`--confirm` 实际写入 |
| `pd runtime activation edit` | 修改 pending approval 的 artifact（P1 #2） | `-a, --approval-id <id>`；`-n, --new-artifact-id <id>` |

### 7.3 观测与诊断

| 命令 | 用途 |
|---|---|
| `pd trace show --pain-id <id>` | 追溯完整 pain → artifact → activation → ledger 链 |
| `pd runtime features` | 查看 feature flag 状态（PRI-239） |
| `pd runtime health snapshot` | owner 健康快照（chain + ledger + pruning） |
| `pd config doctor` | PD + OpenClaw 配置位置、feature flag、provider 连通性诊断 |

### 7.4 回滚

| 命令 | 用途 | 说明 |
|---|---|---|
| `pd activation deactivate --activation-id <id>` | 停用 code_tool_hook 激活 | **RuleHost 回滚的首选方式**；停用后 RuleHost 重新加载，warn 复现 |
| `pd pruning rollback --principle-id <id>` | 恢复被 mask 的 principle 注入 | 仅 `prompt` 通道相关，不影响 RuleHost |

---

## 8. 回滚流程

### 8.1 停用单条 code_tool_hook 激活

```bash
# 1. 找到要回滚的 activation
pd activation list --channel code_tool_hook

# 2. 停用（幂等，重复调用安全）
pd activation deactivate --activation-id <id>

# 3. 验证
pd activation list --channel code_tool_hook  # 该 activation 不再出现
# 或含已停用：
pd activation list --channel code_tool_hook --include-deactivated  # 显示 deactivated_at 已置位
```

停用后 RuleHost 在下次 evaluate 时重新加载，该规则不再产出决策。如果这是最后一条 active 激活，**armed-but-empty warn 会复现**（因为新建了 RuleHost 实例或 emptyLoadWarnEmitted 逻辑触发）——这是预期行为。

### 8.2 全量回滚 workspace 的所有 code_tool_hook 激活

```bash
# 列出所有 active code_tool_hook 激活
pd activation list --channel code_tool_hook --json

# 逐条 deactivate（无批量命令，需脚本循环）
for id in $(pd activation list --channel code_tool_hook --json | jq -r '.activations[].activation_id'); do
  pd activation deactivate --activation-id "$id"
done
```

> ⚠️ 全量回滚后 RuleHost 完全空载，所有 tool_call 放行。仅在确认规则有严重问题时使用。

---

## 9. 常见问题（FAQ）

### Q1: armed-but-empty warn 反复出现怎么办？

**A**：检查是否每次 agent 会话都重建了 RuleHost 实例。`emptyLoadWarnEmitted` 是实例级标志，新实例会重置。如果 warn 每次会话出现一次，是正常的（去重只在单实例内生效）。如果同一会话内反复出现，说明 RuleHost 实例被重复构造——检查 gate.ts 是否缓存了 RuleHost 实例。

### Q2: promote 后 RuleHost 还是 no-opinion？

**A**：确认 promote 成功（`pd activation list` 显示 action = `code_tool_hook_live_activate`）。然后检查实现代码的 `evaluate` 是否真的 match 当前 tool_call——shadow 模式下 RuleHost 也会加载并执行 evaluate，只是不阻断。如果 shadow 期间 evaluate 从未 match，说明规则条件不匹配当前场景，promote 后依然不会阻断。

### Q3: principleId 记录成了 rule ID 怎么办？

**A**：见 §5.3 排障步骤。通常是 artifact 的 `content_json.principleId` 和 `source_principle_id` 都缺失导致 fallback 到 `meta.ruleId`。回溯 artifact 创建链路，确认 dreamer/philosopher/scribe 是否正确写入了 principleId。

### Q4: shadow 模式会写 eventLog 吗？

**A**：会。RuleHost 在 shadow 模式下同样执行 evaluate 并产出 result，gate.ts 会记录 `recordRuleEnforced`。区别仅在于 shadow 时 decision 不真正阻断 tool_call。这是设计内的——shadow 期间的 eventLog 用于 owner 评估规则效果。

### Q5: workspaceDir 没配置怎么修？

**A**：RuleHost 由 OpenClaw plugin 在 `hooks/gate.ts` 中通过 `wctx.getRuleHost(logger)` 构造。workspaceDir 来自 OpenClaw workspace 配置。确认：
1. `pd runtime init --confirm` 已执行（初始化 workspace .pd/ 目录）
2. OpenClaw workspace 路径正确（默认 `D:\.openclaw\workspace`，或 pd-console dev server 启动时的 workspace）
3. `pd config doctor` 检查配置连通性

---

## 附录：关键代码位置速查

| 关注点 | 文件:行 |
|---|---|
| RuleHost 主类 | `packages/openclaw-plugin/src/core/rule-host.ts:110` |
| 加载 active 激活 | `rule-host.ts:233` `_loadActiveCodeImplementations` |
| armed-but-empty warn | `rule-host.ts:269` `_emitEmptyLoadWarn` |
| principleId precedence | `rule-host.ts:591` |
| source_principle_id 提取 | `rule-host.ts:399-404` |
| contentJson.principleId 提取 | `rule-host.ts:527-535` |
| gate 调用入口 | `packages/openclaw-plugin/src/hooks/gate.ts:62,93` |
| RuleHostWriter（激活写入） | `packages/principles-core/src/runtime-v2/activation/writers/rule-host-writer.ts:171` |
| promote 命令注册 | `packages/pd-cli/src/index.ts:467` `registerRuntimeActivationPromoteCommand` |
| promote handler | `packages/pd-cli/src/commands/runtime-activation.ts:317-403` |
