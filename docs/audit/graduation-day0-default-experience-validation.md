# Graduation Day-0 Default Experience Validation (PRI-575)

> 隔离验证报告，2026-08-24。基于分支 `feat/feature-graduation`（PRI-571 四个 flag 默认开启后）。
> 未修改生产 workspace（`D:\.openclaw\workspace`）、未直接写任何数据库；所有写入均通过产品命令
> （`pd runtime init` / `pd demo story-a`）或真实 console HTTP API 完成。

## 0. 与此前验证的区别

前序报告（`docs/new-user-day0-validation.md`）通过**运行时配置覆盖**模拟 flag 开启。
本报告在**默认值翻转已合入代码**的前提下重跑，不再需要任何配置覆盖——这正是毕业的验收点：
新用户零配置即可获得完整体验。

## 1. 实测环境

| 项 | 值 |
| --- | --- |
| 代码 | feat/feature-graduation @ aaec5e31（origin/main 6e3bac21 + PRI-571/572 提交） |
| 隔离 workspace | `D:\pd-graduation-validation`（非生产路径，production-workspace-guard 不保护） |
| demo 链路 workspace | demo 自建临时目录 `%TEMP%\pd-story-a-KQ9klo`（demo 拒绝写入已有 workspace，cli-5 合规） |
| console | `npx tsx src/server/index.ts --workspace <隔离ws> --port 3311 --no-auth` |

## 2. 全链路结果（Install → Init → First Task → Pain → Principle → Approval → Activation → Receipt）

| # | 步骤 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | Install | ⚠️ 部分 | 使用 worktree 构建产物（pd-cli dist）；未跑 `create-principles-disciple` 全量安装器（需停 gateway 且触碰 `~/.openclaw`，超出隔离边界）。installer 生成的 config 内容由 mvp-config.test.ts 覆盖 |
| 2 | Init | ✅ | `pd runtime init --workspace D:\pd-graduation-validation --confirm --json`：全部库表建立、config.yaml 写入、warnings=[] |
| 3 | Flag 默认读取 | ✅ | `pd runtime features --json`：4 个毕业 flag 全部 `enabled=true, category=quiet`；实验性 `principle_receipt_self_report` 保持 false（符合"不自动开启实验性能力"约束） |
| 4 | First Task/Pain/Principle/Approval/Activation | ✅ | `pd demo story-a --json`（自建临时 Day-0 workspace）：3 通道全过——prompt_activate；code_tool_hook（真实 ApprovalQueue.approve → RuleHostWriter.activate → ActivationStateStore.recordActivation）；defer_archive。evidenceSource 均指向真实 store/dispatcher |
| 5a | Receipt presence | ✅ 面板就绪 | Console `/api/v1/receipts/principles/<id>` 返回 `status=ok, effectCount=0, presenceCount=0`——空态而非降级 |
| 5b | Receipt 真实写入 | ❓ UNKNOWN | ledger 写入只存在于 openclaw-plugin hook 路径（prompt.ts presence / gate.ts effect），隔离环境无 Agent 会话可驱动；live 数据佐证见 §4 |
| 6 | Console 无 feature_disabled 降级 | ✅ | `/api/v1/receipts/counts` → `{"status":"ok","counts":[]}`；`/api/v1/principles/<id>/governance` → `principle_not_found`（数据级 404，非 flag 降级）；receipts/governance 两个默认能力页面均正常服务 |

## 3. 失败路径观察（均为预期行为）

- `pd demo story-a --workspace <已有workspace>` → **refused** `demo_write_to_existing_workspace`，
  附 nextAction（隔离守卫，fail-loud）。
- 对无 state.db 的 demo 临时目录跑 `pd principles stats` → `status=degraded`，
  reason 注明 "state.db not found"，且 `receiptLedgerFlagEnabled:true` 读取正确（rc-9 合规降级）。

## 4. Live 数据佐证（只读查询）

| 查询 | 结果 |
| --- | --- |
| live `state.db principle_applications` | 39 行全部 presence/prompt_injected，最新 2026-08-24T00:47Z（presence 管道活跃） |
| live effect 行 | 0 |
| live `.state/trajectory.db gate_blocks` | 0 行 |
| events jsonl rulehost_blocked | 8-20:6 次、8-21:34 次、8-22 之后：0 |

解读：所有 block 都发生在 ledger flag 于 live 开启（8-23 PRI-555 apply）**之前**；
flag 开启后尚无新的 block/auto_correct/self-report 事件。effect=0 是真实证据状态，
不构成捕获中断的证据（缺口分析详见 receipt-effect 管道调查报告 / PRI-573）。

## 5. 剩余 UNKNOWN

1. **安装器端到端**：未在停 gateway 前提下执行完整 `create-principles-disciple` 安装
   （会触碰 live `~/.openclaw/extensions`）。
2. **Receipt 真实写入链**：需要下一次真实 Agent 会话中出现 block / auto_correct /
   自述事件后回收验证（flag 已默认开，无需任何操作）。
3. **LLM 全真实链路**（诊断/dreamer 等）：本机无 MINIMAX key；demo 为确定性 fixture 链路。

## 6. 结论

四个能力毕业后，新用户 Day-0 默认体验的**可静态观测面全部就绪**（初始化、flag 读取、
console 页面与 API 无降级、story-a 主链路通过）。剩余不确定性集中在"第一次真实行为发生
后的 receipt 回收"，该验证只能随真实使用自然完成。
