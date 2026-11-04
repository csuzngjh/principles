# GFI Complete Removal — Stage 0 预检报告

任务：GFI-COMPLETE-REMOVAL-001
日期：2026-11-04
状态：Stage 0 完成（未修改任何生产代码）

## 1. 工作区与基线

| 项 | 值 | 证据 |
| --- | --- | --- |
| 主工作区 | `D:\Code\principles`（primary，只读控制面） | `git worktree list` |
| 主工作区 HEAD | `2f2bdf101…`，落后 origin/main 1 个提交 | `git rev-parse HEAD` |
| 最新 origin/main | `35d12815bc08e509c6e54fd908d0ae22b1395d2a`（已 fetch --prune） | `git rev-parse origin/main` |
| 本任务工作树 | `D:\Code\_worktrees\principles\adhoc-20261104-gfi-complete-removal-9da3dd` | `npm run dev:worktree -- adhoc gfi-complete-removal` |
| 本任务分支 | `ai/adhoc-20261104-gfi-complete-removal-9da3dd` | 同上 |
| 工作树基线 | `35d12815b`（与最新 origin/main 一致） | `git rev-parse HEAD` |
| 工作树就绪 | READY，L1/L2/L3 全通过，`leakage: []` | `npm run dev:worktree:ready -- --json` |
| 写入租约 | 已由 writer `trae` 持有 | `npm run dev:worktree:claim -- --writer trae` |

并发纪律：本任务全部提交只进入 `ai/adhoc-20261104-gfi-complete-removal-9da3dd`；不向 main 推送、
不合并任何 PR、不触碰其他 worktree。

## 2. 环境

| 项 | 值 |
| --- | --- |
| OS / Shell | Windows / PowerShell 7（PATH 已按项目规则修复） |
| Node | v26.12.1 |
| npm | 11.20.0 |
| SQLite（better-sqlite3 内置） | 3.53.4（支持 `ALTER TABLE … DROP COLUMN`，需 ≥3.35） |

## 3. 输入文档核实

| 文档 | 核实结果 |
| --- | --- |
| `docs/specs/GFI_COMPLETE_REMOVAL_SPEC.md` | 存在于主工作区（untracked，1304 行）。已原样复制到本工作树纳入本 PR。 |
| 任务书原始全文 | 已读取（本机 attachments `# GFI Comp....txt`），Stage 1–2 按其最高三原则执行。 |

SPEC 存在 → 不触发“SPEC 不存在则停止 Stage 2”的条件。

## 4. 真实工作区数据库只读检查（未写入）

对 Owner 真实工作区 `D:\Code\principles` 以 `readonly: true` 打开：

| 事实 | 实测值 |
| --- | --- |
| `.state/trajectory.db` schema_version | `1`（单行） |
| `tool_calls` 行数 | 161 |
| `gfi_before` 有值的行数 | 0 |
| `tool_calls` 现有列 | `…, gfi_before, gfi_after, …` |
| trajectory 表 | assistant_turns, correction_samples, gate_blocks, governance_*, pain_events, principle_events, sessions, signal_confirmations, task_outcomes, tool_calls, … |
| `.state/sessions/` 目录 | 不存在 |
| `signal_confirmations` 行数 | 0（无 pending empathy 遗留） |
| `.pd/state.db` | 无 `rules`/`rule_codes` 表；`activations` 存在但无 RuleCode 规则载荷 |
| `.state` 文件 | 仅 `trajectory.db` 与 `logs/`，无 `correction_keywords.json`、`empathy_keywords.json` |

结论（实测）：本工作区迁移风险极低（无 GFI 历史样本、无 pending、无会话 JSON）。但**不能**据此推断
其他用户工作区同样干净；迁移逻辑仍按通用路径实现。

## 5. 已知外部约束

1. **Phase A（PR #2316 已合并）**已退役旧自动 Pain 准入（`admitBareHostPains`、`admitToolFailure`、
   `consecutiveErrors>=4` 升级、RuleHost Block 自动 Pain）。本任务不恢复、不重复处理。
2. **Phase C 未实施**：GFI 健康观测面（`/pd-pain` GFI 条、Console GFI 健康度、`pd runtime health gfi`、
   `tool_calls.gfi_before/gfi_after`）仍在生产，属本任务评估对象（Stage 1 已确认仍在）。
3. **Phase B 架构冻结**：共享 Correction Detection / PainIngress / Stage-2 Pending 不作重构，仅做与 GFI
   耦合的必要语义收敛（WEAK / empathy 分类）。
4. **发布面不碰**：`runtime-version.json` 与发布链另有会话在管；本任务不修改发布面文件。

## 6. 预检结论

- 允许进入 Stage 1（独立代码调查）。此前未修改任何生产代码、配置、数据库或测试。
- 唯一新增文件：本报告、SPEC 副本（设计输入）与 `.tmp/audit/` 下的只读探测脚本（已 gitignore）。
