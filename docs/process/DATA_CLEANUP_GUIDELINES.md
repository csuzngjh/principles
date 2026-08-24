# PD 生产数据清理守则（Data Cleanup Guidelines）

> 状态: 生效中（PRI-568）
> 动机: 2026-08-21/08-22 连续两次清理事故——一次误删唯一已 promote 的 live rulecode
> 全套证据链（approvals 11→3、activations 32→7、activation_control_states 15→1），
> 一次在停机窗口造成 40 个任务 failed。本守则是这两次教训的制度化。

## 一、治理资产保护清单（永不物理删除）

以下 SQLite 表 / 文件记录的是 **Owner 治理行为的合法凭证与证据链**。
任何清理操作（无论 AI 助手还是人工）**不得对它们执行 DELETE / DROP**：

| 资产 | 位置 | 为什么是资产 |
|---|---|---|
| `approvals` 表 | `.pd/state.db` | Owner 审批记录——治理合法性的唯一凭证 |
| `activations` 表 | `.pd/state.db` | 激活/下线全历史——防线证据链 |
| `activation_control_states` 表 | `.pd/state.db` | promote/enforce 判定依据 |
| `activation_decisions` 表 | `.pd/state.db` | Owner 决策快照（含 global pause） |
| `activation_evidence_snapshots` 表 | `.pd/state.db` | promotion evidence snapshot |
| `pi_artifacts` 表 | `.pd/state.db` | rulecode/原则工件本体——激活的实现载体 |
| `governance_actions.jsonl` | `.state/` | PRI-566 治理动作审计日志 |
| `recovery_actions.jsonl` | `.state/` | 治理恢复动作审计日志 |

需要"清除"这些资产时，唯一的正道是 PD 自己的生命周期操作：
deactivate（保留历史）、archive、`pd activation ...` 系列 CLI——用状态变更表达，
不用物理删除。

## 二、可安全清理的数据

| 数据 | 判别标准 | 方式 |
|---|---|---|
| demo/test 激活及其 control_states（如 `demo-rule-*`、`R_ACCEPT_*`） | ID 前缀为测试用途且非当前活跃 | 先 deactivate 再归档；确认无审批关联后才可删 |
| stub/占位规则（如 `*_stub_bootstrap`） | status=proposed 且无任何 run 历史 | 可删 |
| 过期 pain_events | 超过保留期且已产出 candidate 或明确无价值 | 归档优先；删除需备份 |
| 失败/过期 tasks | 非 needs_human_review 且超过重试窗口 | 官方 pruning 命令 dry-run 确认后执行 |
| 事件日志 events_*.jsonl | 超过保留期 | 归档压缩，不删近期文件 |

判别口诀：**先问"这是 Owner 的决定记录，还是系统的运行残留？"**
前者是资产，后者才是垃圾。

## 三、清理流程硬约束

1. **备份先行**: 修改前必须 `Copy-Item` 出带语义后缀的备份
   （如 `state.db.bak-<yyyymmdd>-<用途>`）。无备份不动手。
2. **dry-run 先行**: 列出将删的表 + 行数 + 抽样 ID，人工过目后才执行。
   PD 自带命令一律先 `--dry-run`。
3. **归档代替删除**: 对存疑数据用 `UPDATE ... SET status='archived'`
   替代 DELETE——状态可逆，行不可复生。
4. **行数账目**: 清理后核对每张表的行数变化与计划清单一致；
   出现计划外差异立即从备份恢复。
5. **活跃期禁令**: 存在 live activation 或进行中的内化链时，
   不做任何清理（等链路走完）。
6. **AI 助手附加义务**: AI 执行清理前必须向 Owner 展示本守则的
   保护清单并逐项确认目标不在其中；Owner 授权 ≠ 免检。

## 四、事故复盘索引

- **2026-08-22 rulescleanup/paincleanup**: 删除 stub 规则（合理）的同时
  物理删除了唯一 promoted live 规则 `rule-real-diagnosis-first-v2` 的
  activation 行、control_state 行与 8 条历史 approval——排查耗时 >1 小时，
  靠手工 diff 五份备份才复原。→ 直接催生本守则与 PRI-568。
- **2026-08-24 停机窗口**: llamacpp 关闭期间 consumer 继续拾取任务导致
  40 条 failed。→ 教训：停 LLM 后端时应同时暂停 auto-consumer
  （或接受 retry_wait 自愈成本）。
