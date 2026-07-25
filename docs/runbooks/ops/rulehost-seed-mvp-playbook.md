# RuleHost Seed-MVP Release Playbook

> **状态**: Active (PRI-495)
> **最后更新**: 2026-07-02
> **关联代码**: `packages/openclaw-plugin/src/core/rule-host.ts`、`packages/pd-cli/src/commands/runtime-internalization-run-rulehost.ts`
> **关联文档**: [`rulehost-owner-runbook.md`](./rulehost-owner-runbook.md)（日常运维）、[`docs/adr/0014-mvp-first-strategy-and-product-pivot.md`](../../adr/0014-mvp-first-strategy-and-product-pivot.md)
> **适用角色**: RuleHost owner / 种子用户 release gate
> **编号说明**: SEED-RH-001 = 本 playbook

---

## 1. 目的与边界

### 1.1 目的

把 RuleContext v2 / RuleHost 从"功能已实现但生产体验不稳"收敛到"可安全给种子用户体验"的 MVP 状态。本 playbook 是 **release 前一次性 smoke gate**，验证种子 workspace 在真实生产入口下端到端跑通：

```text
pain + Owner example IDs
  → BehaviorExamplePack
  → Artificer ↔ Evaluator 对抗循环
  → v2 rule artifact
  → Approval
  → shadow activation（观察，不阻断）
  → shadow 观察通过
  → promote live
  → unread write block / prior read allow
  → flag off 回滚
  → deactivate
```

种子用户首次启用 `rulecode_context_v2` 时**必须**走完本 playbook 的 §4 smoke 步骤，并在 §7 verification matrix 留下记录。

### 1.2 产品边界（不承诺的事项）

PD（Principles Disciple）的 RuleHost seed-MVP **只做** owner 审批后可逆的行为内化。本 playbook 不承诺、不实现、不暗示以下能力：

| 不承诺事项 | 说明 |
|---|---|
| 通用记忆系统 | RuleHost 仅加载当前 workspace 的 active 激活；不跨 workspace、不跨 pain lineage 聚合记忆 |
| 自动任务执行 | 所有 `code_tool_hook` 激活必须经 owner 审批；RuleHost 不代 owner 决策"该不该执行某个工具调用" |
| 自动价值判断 | v2 seed rules 只允许 `allow` / `block`；不允许 `propose_correction`、`requireApproval`、live `auto_correct` |
| 真正 live auto-correct | 所有 correction 必须人审；不存在"agent 自动纠错并执行"的路径 |
| 默认开启 v2 | `rulecode_context_v2` flag 默认 `quiet / enabled: false`；种子用户必须显式开启 |
| MVP-Core 范围扩展 | 本轮不扩展 MVP-Core；新增功能默认 `MVP-Quiet`（off + flag-registered） |

任何超出上述边界的提案必须走 ADR 流程，并在 `docs/plans/post-mvp-conditional-roadmap.md` 评估重启条件。

### 1.3 与 owner runbook 的关系

| 文档 | 用途 | 触发时机 |
|---|---|---|
| 本 playbook（SEED-RH-001） | release 前 smoke + rollback 验证 | 种子用户首次启用 v2 / 每次 release 升级 |
| [`rulehost-owner-runbook.md`](./rulehost-owner-runbook.md)（R2-RH-001） | 日常运维（armed-but-empty、lineage 排障、deactivate） | 日常 oncall |

---

## 2. 前置条件

### 2.1 环境检查

```bash
# 1. PD CLI 可用
pd --version

# 2. workspace 已初始化（.pd/ 目录存在）
pd runtime init --confirm

# 3. 配置诊断通过
pd config doctor

# 4. feature flag 状态（确认 rulecode_context_v2 默认 off）
pd runtime features --json
```

`pd config doctor` 必须无 error 退出。`pd runtime features` 输出中 `rulecode_context_v2` 应为 `{ category: 'quiet', enabled: false }`。

### 2.2 LLM Provider 配置

`run-rulehost` 需要 dreamer / philosopher / scribe / artificer / evaluator 五个 internal agent 的 runtime profile。在 `.pd/config.yaml` 中确认：

```yaml
runtimeProfiles:
  pd.anthropic-sonnet:
    type: pi-ai
    provider: anthropic
    model: claude-3-5-sonnet
    apiKeyEnv: ANTHROPIC_API_KEY
    timeoutMs: 300000
internalAgents:
  defaultRuntime: openclaw.default
  agents:
    dreamer:    { enabled: true, runtimeProfile: pd.anthropic-sonnet }
    philosopher: { enabled: true, runtimeProfile: pd.anthropic-sonnet }
    scribe:     { enabled: true, runtimeProfile: pd.anthropic-sonnet }
    artificer:  { enabled: true, runtimeProfile: pd.anthropic-sonnet }
    evaluator:  { enabled: true, runtimeProfile: pd.anthropic-sonnet }
```

`apiKeyEnv` 指向的环境变量必须在执行 `run-rulehost` 前导出。

### 2.3 Pain 信号已存在

`run-rulehost` 的输入是 pain id。先确认 pain 已记录：

```bash
pd pain record --workspace <ws> --json    # 如需新记录
pd trace show --pain-id <id>              # 确认 pain 存在
```

---

## 3. Step 1 — 开启 `rulecode_context_v2`

### 3.1 修改 `.pd/config.yaml`

在 workspace 根的 `.pd/config.yaml` 的 `features` 段下添加：

```yaml
features:
  # ... 其他 flag ...
  rulecode_context_v2:
    category: quiet      # 保持 quiet；不要改为 core
    enabled: true         # 显式开启
    since: 2026-06-27    # flag 引入日期（与 feature-flag-contract.ts 一致）
```

### 3.2 验证 flag 已生效

```bash
pd runtime features --json | jq '.features[] | select(.id == "rulecode_context_v2")'
# 期望输出：{"id":"rulecode_context_v2","category":"quiet","enabled":true,...}
```

### 3.3 重要约束

- `category` 必须保持 `quiet`。**不要**改为 `core`——这会绕过 seed-MVP 的可逆性约束（ADR-0014 §2.5）。
- 一次只在一个种子 workspace 开启。**不要**全局默认开启。
- 开启后 `run-rulehost` 的 `--behavior-examples` 才会被解释为 v2 BehaviorExamplePack；不开 flag 时传该参数会被拒绝。

---

## 4. Step 2 — 准备 Owner-labelled BehaviorExamples

### 4.1 JSON Schema

`--behavior-examples` 接受一个 JSON 文件路径，schema：

```json
{
  "ownerDesiredOutcome": "<非空字符串：owner 期望 agent 达成的目标>",
  "sourceNegativeToolCallId": <正整数：一次失败 / 偏离 owner 意图的 tool call id>,
  "positiveToolCallIds": [<1..3 个正整数：owner 标注的正面对照 tool call id>]
}
```

### 4.2 字段约束

| 字段 | 类型 | 约束 | 违反时 |
|---|---|---|---|
| `ownerDesiredOutcome` | string | 非空（trim 后长度 > 0） | `behavior_examples_invalid: ownerDesiredOutcome must be a non-empty string` |
| `sourceNegativeToolCallId` | number | 安全整数，> 0 | `behavior_examples_invalid: sourceNegativeToolCallId must be a positive integer` |
| `positiveToolCallIds` | number[] | 1..3 项，每项为安全正整数 | `behavior_examples_invalid: positiveToolCallIds must contain 1 to 3 positive integers` |

文件不可读 / JSON 解析失败时返回 `behavior_examples_unreadable: <error>`。

### 4.3 准备流程

1. **找到一次失败/偏离的 tool call**：通过 `pd pain evidence --json`（近期 pain 决策）或 `pd trace show --pain-id <id>`（pain → artifact → ledger 链）定位 pain 记录；pain 记录中含触发该 pain 的 `toolCallId`（负样本）。也可直接查 SQLite `pain_signals` 表。
2. **找 1~3 次正面对照**：在同一 workspace 或相邻 session 中，找到 owner 认为行为正确的同类 tool call（正样本）。正样本数量 ≤ 3，且必须与负样本同 `toolName`。可从 trajectory DB（`trajectory.db`）查询历史 tool call。
3. **写 `ownerDesiredOutcome`**：一句话描述 owner 期望，如"修改文件前必须先读取目标文件确认路径"。
4. **保存为 JSON 文件**：例如 `./behavior-examples.json`。

### 4.4 示例

```json
{
  "ownerDesiredOutcome": "写入文件前必须先 Read 确认目标路径存在",
  "sourceNegativeToolCallId": 42,
  "positiveToolCallIds": [17, 31]
}
```

---

## 5. Step 3 — Run RuleHost Pipeline

### 5.1 dry-run（必跑，验证 capability）

```bash
pd runtime internalization run-rulehost \
  --workspace <ws> \
  --pain-id <id> \
  --channel code_tool_hook \
  --behavior-examples ./behavior-examples.json \
  --dry-run
```

`--dry-run` 是默认模式：仅校验输入 + 配置 + agent capability 状态，**不**执行 pipeline。输出 `code_rule_capability: ON (...)` 表示 artificer + evaluator 都可用；`OFF (...)` 时按输出的 `nextAction` 修复后再跑。

### 5.2 confirm（实际执行）

```bash
pd runtime internalization run-rulehost \
  --workspace <ws> \
  --pain-id <id> \
  --channel code_tool_hook \
  --behavior-examples ./behavior-examples.json \
  --confirm
```

> `--dry-run` 与 `--confirm` 互斥（CLI gate `cli-4`）。同时传会被 Commander 拒绝。

### 5.3 预期输出

`OVERALL: ✓ CANDIDATE_READY_FOR_OWNER_REVIEW` 表示：
- Artificer 产出了符合 v2 schema 的 rule artifact（仅 `allow` / `block`，含 `evidenceRefs`）
- Evaluator 通过对抗循环
- artifact `validationStatus = validated`，写入 `pi_artifacts` 表
- artifact 进入 ApprovalQueue 等待 owner approve

输出 `OVERALL: ⚠ TEXT_PRINCIPLE_ONLY` 表示 code-rule capability 不可用，仅生成文本 principle（v2 不可用）。**不**进入下一步——先按 `degradationReason` 修复 capability。

---

## 6. Step 4 — Approve → Shadow Activation

### 6.1 查看 pending approval

```bash
pd activation list --channel code_tool_hook --json
# 该输出含 pending approval 状态的 artifact（validationStatus = validated 且未 approve）
# 也可通过 pd-console web UI 查看 ApprovalQueue
```

### 6.2 Approve

```bash
pd activation approve \
  --approval-id <id> \
  --decided-by <owner-name>
```

approve 后 ApprovalCompletionService 触发 `RuleHostWriter.activate()`，写入 activations 表。**PRI-489 后**，approve 产出的 action 必须是 `code_tool_hook_shadow_activate`（**不是** `code_tool_hook_live_activate`）。

### 6.3 验证 shadow 激活已写入

```bash
pd activation list --channel code_tool_hook --json
# 期望：该 activation 的 action = "code_tool_hook_shadow_activate"
#       mode = "shadow"
#       status = "active"
```

---

## 7. Step 5 — 观察 Shadow

### 7.1 触发 tool call

让 agent 在 workspace 中触发与规则相关的 tool call（既包括应被 block 的负样本场景，也包括应被 allow 的正样本场景）。

### 7.2 验证 shadow 不阻断

shadow 模式下 RuleHost 会加载并执行 evaluate，但 **不阻断** tool call。验证：

```bash
# 方式 A: agent 行为观察
# 触发应被 block 的 tool call — agent 应继续执行（不被 block），证明 shadow 不阻断

# 方式 B: eventLog 查询（JSONL 文件，路径 <workspace>/.principles/logs/events_<YYYY-MM-DD>.jsonl）
# gate.ts 在 shadow 期间会调用 eventLog.recordRuleHostEvaluated({
#   toolName, filePath, matched, decision, ruleId, activationId, activationMode: 'shadow'
# })
# 每条记录是一行 JSON。可用 PowerShell 或 jq 过滤：

# PowerShell（Windows 默认终端）：
Get-Content "<workspace>\.principles\logs\events_$(Get-Date -Format 'yyyy-MM-dd').jsonl" |
  Where-Object { $_ -match '"rulehost_evaluated"' -and $_ -match '"shadow"' } |
  Select-Object -Last 10

# 或 jq（跨平台）：
jq -c 'select(.eventType == "rulehost_evaluated" and .data.activationMode == "shadow")' \
  "<workspace>/.principles/logs/events_$(date +%Y-%m-%d).jsonl" | tail -n 10
```

如果 shadow 期间 evaluate 从未 match（`matched: false`），说明规则条件不匹配——promote 后也不会阻断。**先**回到 §5 检查 BehaviorExamplePack 是否正确，再 promote。

> ⚠️ `pd trace show --pain-id <id>` 显示的是 pain → artifact → activation → ledger 链，**不**显示 eventLog 中的 `rulehost_evaluated` 记录。shadow 观察必须查 JSONL 日志文件或观察 agent 实际行为。

### 7.3 验证 would-block 信号

shadow 期间 eventLog 记录的 `decision: 'block'` 是 would-block 信号，gate 不会真正执行 block。owner 据此评估规则效果。

---

## 8. Step 6 — Promote Shadow → Live

### 8.1 Promote

```bash
pd activation promote \
  --activation-id <id> \
  --confirm
```

`--confirm` 必填（promote 默认 dry-run，CLI gate `cli-4`）。promote 后 action 变为 `code_tool_hook_live_activate`。

### 8.2 验证 live

```bash
pd activation list --channel code_tool_hook --json
# 期望：该 activation 的 action = "code_tool_hook_live_activate"
#       mode = "live"
```

### 8.3 验证 live 阻断

触发应被 block 的 tool call，gate 应真正阻断（返回 `decision: 'block'`，agent 收到 block 反馈）。触发应被 allow 的 tool call，gate 放行。

---

## 9. Rollback 路径（一步回滚）

### 9.1 单条 activation 回滚

```bash
# 停用单条 activation（幂等，PRI-408 Contract E）
pd activation deactivate --activation-id <id>

# 验证
pd activation list --channel code_tool_hook
# 该 activation 不再出现（默认 list 仅显示 active）
pd activation list --channel code_tool_hook --include-deactivated
# 显示该 activation，deactivated_at 已置位
```

停用后 RuleHost 在下次 evaluate 时重新加载，该规则不再产出决策。

### 9.2 全局回滚（关闭 v2 flag）

**适用场景**：发现 v2 整体有问题，需要立即停止所有 v2 行为，**而不**逐条 deactivate。

```bash
# 1. 编辑 .pd/config.yaml
#    将 features.rulecode_context_v2.enabled 改为 false（或删除该条目）

# 2. 验证 flag 已关闭
pd runtime features --json | jq '.features[] | select(.id == "rulecode_context_v2")'
# 期望：{"enabled": false, ...}

# 3. 重启 agent / 重建 RuleHost 实例（flag 在 RuleHost 构造时读取）

# 4. 验证 v2 激活已被挂起
pd activation list --channel code_tool_hook --json
# v2 activation 应显示 status = "suspended_by_flag"（PRI-491）
```

### 9.3 回滚后的预期行为

- flag off 后，v2 activation **不会**被执行（既不 block 也不 allow，等同于未加载）
- v1 activation 不受影响（v1 zero-change，ADR-0014）
- armed-but-empty warn 会复现（因为 v2 activation 被挂起，loaded 列表变空）——这是预期信号

### 9.4 回滚不会做的事

- **不**删除 activation 记录（deactivate 只是置 `deactivated_at`，历史可查）
- **不**回滚 approval（Contract F: no data damage）
- **不**删除 artifact（artifact 保留在 `pi_artifacts` 表，可重新 dispatch）

---

## 10. Smoke Checklist（10 正 / 10 负）

种子 workspace release 前必须跑完下表，每项留可观测证据（命令输出 / eventLog / agent 行为）。

### 10.1 正向用例（应通过）

| # | 场景 | 验证命令 | 期望结果 |
|---|---|---|---|
| P1 | `rulecode_context_v2` flag 可开启 | `pd runtime features --json` | `enabled: true` |
| P2 | `run-rulehost --dry-run` capability ON | dry-run 输出 | `code_rule_capability: ON` |
| P3 | `run-rulehost --confirm` 生成 v2 artifact | `pd trace show --pain-id <id>` | artifact `validationStatus = validated`，含 `requiresContextVersion: 2` + `evidenceRefs` |
| P4 | approve 后写 shadow activation | `pd activation list --channel code_tool_hook --json` | `action = code_tool_hook_shadow_activate`，`mode = shadow` |
| P5 | shadow 期间 evaluate 执行 | eventLog | `rulehost_evaluated` 记录，`activationMode = shadow` |
| P6 | shadow 不阻断 tool call | agent 实际行为 | 负样本 tool call 仍执行（不 block） |
| P7 | promote 后变 live | `pd activation list --json` | `action = code_tool_hook_live_activate`，`mode = live` |
| P8 | live 阻断负样本 tool call | agent 实际行为 | 负样本 tool call 被 block，agent 收到反馈 |
| P9 | live 放行正样本 tool call | agent 实际行为 | 正样本 tool call 正常执行 |
| P10 | deactivate 后规则不再执行 | `pd activation list --include-deactivated` | activation `deactivated_at` 已置位；RuleHost 不再产出决策 |

### 10.2 负向用例 / 失败矩阵（应优雅降级）

| # | 场景 | 触发方式 | 期望降级行为 |
|---|---|---|---|
| N1 | flag off 时跑 v2 | 不开 flag 直接 `run-rulehost --behavior-examples` | 拒绝，输出 `reason` + `nextAction` |
| N2 | flag off 时已有 v2 activation | 开 flag → approve → 关 flag → 重启 | activation `status = suspended_by_flag`，不执行 |
| N3 | behavior-examples 文件不可读 | 传不存在路径 | `behavior_examples_unreadable: ...` |
| N4 | behavior-examples JSON malformed | 传非 JSON 内容 | `behavior_examples_invalid: ...` |
| N5 | behavior-examples 缺字段 | 缺 `ownerDesiredOutcome` | `behavior_examples_invalid: ownerDesiredOutcome must be a non-empty string` |
| N6 | v2 Artificer 输出 `propose_correction` | mock LLM 返回该 decision | fail loud（PRI-490），pipeline 失败 |
| N7 | v2 Artificer 改写 evidenceRefs | mock LLM 返回不同 refs | fail loud（PRI-490） |
| N8 | promote 缺 `--confirm` | 不带 `--confirm` | dry-run 输出，不修改 activation |
| N9 | deactivate 不存在的 activation | 传错误 id | 幂等失败，输出 `reason` + `nextAction` |
| N10 | duplicate activation（同 target_ref 已 active） | dispatch 同一 artifact 两次 | 第二次 skip + warn，不重复写入 |

### 10.3 Hook 性能验证（PRI-494）

```bash
# 使用真实 handleBeforeToolCall + 真实 SQLite activation + v2 flag + RuleHost load + VM compile
# Contract threshold (enforced in CI): p95 < 500ms, p99 < 1000ms
# Aspirational target (spec, NOT enforced): p95 < 50ms, p99 < 200ms
# 实测基线见 perf-baselines/2026-07-02-rulehost-seed-mvp-baseline.json
cd packages/openclaw-plugin && npx vitest run tests/hooks/gate-rule-host-perf-budget.test.ts
# v2 RuleContext query perf：
cd packages/openclaw-plugin && npx vitest run tests/core/rule-context-v2.perf.test.ts
```

**性能阈值契约（PRI-496）**:

| 指标 | Aspirational (spec) | Contract (CI enforced) | 理由 |
|---|---|---|---|
| p95 | < 50ms | < 500ms | Windows FS 开销 + SQLite 并发负载 + 全套测试并行运行导致 p95 远高于 spec；sanity bound 已通过 ERR-088 BLOCK_MARKER 验证规则真实执行（非空跑），仅放宽 timing 上限。原 200ms 阈值在慢速 CI runner（GitHub Actions 共享 runner + SQLite FS 开销 3-5x）实测稳态 p95~230ms 时会假阳性失败（PRI-518 PR #1260 命中 p95=254ms），故放宽至 500ms（~2x 最差合法环境），仍能捕获真实回归（>2x baseline）。 |
| p99 | < 200ms | < 1000ms | 同上；Windows 下 SQLite FS 开销是 Linux 的 3-5x，且 CI 全套并行负载会推高 tail latency。原 500ms 阈值同步放宽至 1000ms。 |

- **Aspirational target**：spec 设计目标，不在 CI 强制执行，作为未来优化方向参考。
- **Contract threshold**：CI 实际执行的阈值，是正式契约。测试代码中的 `toBeLessThan(...)` 即此值。
- **Baseline**：实测基线（p50/p95/p99/min/max）见 `perf-baselines/2026-07-02-rulehost-seed-mvp-baseline.json`，每次重大架构变更后更新。

性能测试必须证明规则实际执行（unique block marker），不能只测 timing（ERR-088）。

---

## 11. PRI-478 Final Verification Matrix

种子 workspace release 前在 PRI-478 留下以下矩阵（每个种子 workspace 一份）：

| 维度 | 验证项 | 期望 | 实测 | 通过 |
|---|---|---|---|---|
| 真实 Owner rule 跑通 | `run-rulehost --confirm` 生成 v2 artifact | `validationStatus = validated` | ☐ | ☐ |
| 正向 smoke | §10.1 P1–P10 全通过 | 10/10 | ☐ | ☐ |
| 负向 smoke | §10.2 N1–N10 全降级 | 10/10 | ☐ | ☐ |
| 0 unavailable false block | live 期间无误 block | 0 | ☐ | ☐ |
| Hook perf | p95 < 500ms, p99 < 1000ms (contract, see §10.3) | 达标 | ☐ | ☐ |
| Rollback verified | flag off → suspended_by_flag | 达标 | ☐ | ☐ |
| `npm run verify:merge` | 全绿 | pass | ☐ | ☐ |

**Seed-readiness 决策**：上述矩阵全绿 → workspace 可作为种子 workspace 投产；任一项未达标 → 不投产，按对应 ERR / PR 修复后重跑。

---

## 12. ERR Checklist

本 playbook 涉及的 ERR 条目（执行前必读 `docs/process/error-management/ERROR_PATTERN_INDEX.md`）：

| ERR | 标题 | 本 playbook 如何避免 |
|---|---|---|
| ERR-040 | packaged artifact 与 source-tree 行为不一致 | playbook 命令均来自实际 Commander 注册；不引用未实现的命令 |
| ERR-041 | install success 误导 | §2.1 前置检查包含 `pd config doctor`；不假设 install = 可用 |
| ERR-043 | 文档命令必须可运行 | §3-§9 所有命令已对照 `pd-cli/src/index.ts` 注册树验证 |
| ERR-053 | CLI 子命令必须注册 | §3-§9 命令均为 promoted 顶层或文档标注的 hidden alias |
| ERR-069 | Artificer 共享 schema fail loud | §5.3 / §10.2 N6/N7 验证 v2 schema 强约束 |
| ERR-088 | smoke 必须证明规则执行 | §10.3 性能测试要求 unique block marker |
| ERR-024 | production wiring 错误 | §4-§8 全链路使用真实入口（run-rulehost / approve / promote），不直接 insert activation |

---

## 13. 默认状态提醒

| 项 | 默认 | seed-MVP 是否改变 |
|---|---|---|
| `rulecode_context_v2` flag | `quiet / enabled: false` | 否——仅在选定种子 workspace 显式开启 |
| v1 rule 行为 | 不变 | 否——v1 zero-change（ADR-0014） |
| `code_tool_hook` 通道 | 默认 shadow-first | 是——approve 后先 shadow，promote 才 live（PRI-489） |
| v2 seed rules action 范围 | 仅 `allow` / `block` | 是——禁止 `propose_correction` 等（PRI-490） |
| 自动价值判断 / auto-correct | 不存在 | 否——超出 PD 产品边界 |

---

## 附录 A — 命令速查

```bash
# 开启 v2
# 编辑 .pd/config.yaml，features.rulecode_context_v2.enabled = true
pd runtime features --json | jq '.features[] | select(.id == "rulecode_context_v2")'

# 准备 behavior examples（JSON 文件）
# { "ownerDesiredOutcome": "...", "sourceNegativeToolCallId": N, "positiveToolCallIds": [N1, N2] }

# dry-run
pd runtime internalization run-rulehost -w <ws> --pain-id <id> \
  --channel code_tool_hook --behavior-examples ./examples.json --dry-run

# 实际执行
pd runtime internalization run-rulehost -w <ws> --pain-id <id> \
  --channel code_tool_hook --behavior-examples ./examples.json --confirm

# approve（写 shadow activation）
pd activation approve --approval-id <id> --decided-by <name>

# 查看 activation（确认 shadow）
pd activation list --channel code_tool_hook --json

# promote shadow → live
pd activation promote --activation-id <id> --confirm

# 回滚：单条
pd activation deactivate --activation-id <id>

# 回滚：全局（关 flag）
# 编辑 .pd/config.yaml，features.rulecode_context_v2.enabled = false
# 重启 agent / 重建 RuleHost 实例
pd runtime features --json | jq '.features[] | select(.id == "rulecode_context_v2")'
# 期望 enabled: false；v2 activation 显示 status = suspended_by_flag
```

---

## 附录 B — 产品边界再申明

本 playbook 仅描述 RuleHost seed-MVP 的 release smoke 与 rollback 流程。**不**构成对以下能力的承诺：

- 通用记忆（cross-workspace / cross-pain aggregation）
- 自动任务执行（agent 不代 owner 决策）
- 自动价值判断（v2 仅 allow / block）
- 真正 live auto-correct（必须人审）
- 默认开启 v2（必须显式开启）

任何超出上述边界的提案必须走 ADR 流程，并在 `docs/plans/post-mvp-conditional-roadmap.md` 评估重启条件。本 playbook 随 ADR-0014 MVP-First 阶段同步——MVP 阶段结束后由 maintainer 决定是否归档或演进。
