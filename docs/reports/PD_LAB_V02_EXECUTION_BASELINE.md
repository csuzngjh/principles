# PD_LAB_V02_EXECUTION_BASELINE — SPEC-PD-LAB v0.2 执行基线核验

> 阶段 0（Stage 0）输出 · 只读核验 · 核验时间 2026-11-16
>
> 本报告回答一个问题：**SPEC v0.2 所依据的事实基线，在本次执行开始时是否仍然成立。**
> 所有判断以执行时刻的 `origin/main` 为准，不沿用 SPEC 记录的基线 SHA。

## 1. 执行环境

| 项目 | 值 | 备注 |
|---|---|---|
| 仓库 | `csuzngjh/principles`（origin） | 工作目录 `D:\Code\principles` |
| 主检出分支 | `main` @ `2927acefae31905d00a12800d004a275f970ff19` | 落后 origin/main 37+ 提交，仅作只读调查 |
| 主检出未提交内容 | 仅 untracked 文件（历史报告/评审稿/SPEC 草案等 52+ 项） | 未覆盖、未清理、未 reset |
| **执行时 origin/main** | `23f2c17fdccb617cb7cc757c214cf494b92d4589` | 本次任务全部事实判断的基线 |
| 本任务工作分支 | `ai/PRI-1245-pd-lab-v02-integration`（worktree `D:\Code\_worktrees\principles\PRI-1245-pd-lab-v02-integration`，基于 `23f2c17fd`） | git-1/git-9：唯一写入点，writer=zcode |

## 2. SPEC v0.2 基线 → 执行时 origin/main 的漂移

SPEC v0.2 记录基线 `592f50b4aa0c…`。执行时 origin/main 已前移两次：

```text
592f50b4a  (#2670, SPEC 基线)
  → 0e53de742  (#2679 changesets bump + #2676 vue bump + 5ebfebcc3 version packages)
  → 23f2c17fd  (#2680 product version bump 2.8.8)
```

**Lab 相关路径变化：零。** `git diff --name-only 592f50b4a..23f2c17fd` 对
`experiment/`、`scripts/dev/pipeline-evolution/`、`scripts/dev/principle-learning-lab/`、
`scripts/dev/pipeline-closure-lab/`、`scripts/build/lab-payload.mjs`、
`docs/pipeline-evolution/` 的 grep 过滤为空。漂移仅为 version-packages 与依赖升级。

结论：**SPEC v0.2 对其调查范围内源码的全部判断，在 `23f2c17fd` 上仍然成立。**

## 3. 关键 PR 状态（执行时实测）

| PR | 标题 | 状态 | 合并 SHA |
|---|---|---|---|
| #2653 | PD-SPEC-001 Prompt V2 — 六 Agent 提示词优化 + 真实 Pain A/B 实验底盘（Phase 0-2） | **MERGED** 2026-11-16T05:54:55Z | `63e76a8bd6911db6d0a654897e0280e326a83e7e`（squash，单 parent） |
| #2672 | [PRI-1244] PD Lab Capability Inventory — Read-only Architecture Audit | **MERGED** 2026-11-16T08:32:53Z | `2af0110a47acc8c48eec9bd04b55b5826f3f4588` |
| #2670 | PRI-1243 Phase 7.2 Ledger 精确查重 + Reuse Park + 种子拦截 | **MERGED** 2026-11-16T09:01:18Z | `592f50b4aa0c6135128dc63e951efe1496ac8356` |

三个 PR 均已合并，与 SPEC v0.2 记录一致，无新实现 PR 提前落地 v0.2 计划中的能力
（`592f50b4a..23f2c17fd` 区间内没有任何 commit 触及 Lab/实验路径）。

## 4. 关键路径存在性（origin/main @ 23f2c17fd 实测）

| 路径 | 状态 | 要点 |
|---|---|---|
| `docs/reports/PRI-1244_PD_LAB_CAPABILITY_INVENTORY.md` | 存在（1010 行） | v2 修订版；五项架构发现；数据治理风险 §9.1 |
| `docs/pipeline-evolution/` | 存在（15 文件） | README + baseline-report + episode-playbook + 6 份报告 + S001–S006 |
| `scripts/dev/principle-learning-lab/` | 存在 | PLE G1/G2、Challenge/Examiner、PRR、fixtures、lib |
| `experiment/prompt-v2/` | 存在（123 文件，全部来自 #2653） | dataset/prompts/baseline/reports/scripts/snapshots/isolation |
| `scripts/build/lab-payload.mjs` | 存在 | `LAB_ENTRY_MODULES` 七模块白名单，逐字核实（见 §6） |
| `scripts/__tests__/lab-payload-closure.test.ts` | 存在 | 发布闭包负向测试 |
| `scripts/dev/pipeline-evolution/` | 存在（4 文件） | experiment-manifest.mjs / evidence-package.mjs / init-experiment.mjs / collect-evidence.mjs |

## 5. PRI-1244 盘点报告与 SPEC v0.2 的一致性

PRI-1244（v2 修订版，代码基线 `45a7fd7`）的五项核心发现与 SPEC v0.2 的引用逐条一致：

1. 三套实验定义契约并存（`experiment-manifest.v1` / `preregistration.v0.1-draft` / #2653 ad-hoc run manifest），无跨实验身份关联 —— SPEC §2.3、§7.1 采信。
2. 无统一 Runner/Evaluator 且不应强行统一（Evaluator ≥5 套，零代码复用）—— SPEC §8 采信。
3. 生产桥仅覆盖 7 个 Examiner/Challenge 模块 —— SPEC §10.2 采信。
4. "Replay" 是四种不同语义，无真实宿主 Trace Replay —— SPEC §4.7 采信。
5. #2653 是自洽但高度一次性的 A/B 底盘，盲评 blind ≠ independent（同 glm-5.3 家族）—— SPEC §4.5 采信。

## 6. 发布边界白名单逐字核实

`scripts/build/lab-payload.mjs` 的 `LAB_ENTRY_MODULES` 恰为七项，与 SPEC §3.1.C 完全一致：

```text
lib/examiner-study.mjs
lib/challenge-runner.mjs
lib/challenge-behavior-report.mjs
lib/challenge-actor.mjs
lib/examiner-injection-evidence.mjs
lib/examiner-v07-cases.mjs
lib/examiner-v2-cases.mjs
```

闭包算法 fail-loud（缺模块或越出 `lib/` 即抛错），未发现产品化边界被改动。

## 7. 本地历史实验产物定位（Stage 2 前置事实）

SPEC v0.2 §19-3 假设全保真产物在「Owner 本机 `.tmp`」。实测结论：

- **主检出 `D:\Code\principles\.tmp\` 下不存在** `prompt-v2-ab/` 或 `prompt-v2-inventory/`。
- 实际位置：**#2653 源 worktree** `D:\Code\_worktrees\principles\adhoc-20261115-prompt-v2-k4wz9t\.tmp\`：
  - `prompt-v2-ab/`（约 1.7 GB：runs/ ×9、workspaces/ ×72、analysis、spotcheck、upstream-snapshots）
  - `prompt-v2-inventory/`（约 108 MB：`pain-dataset.full.json`、`pain-inventory.full.json`、
    `dataset-manifest.local.json`、`snapshot/state.db` 67,334,144 B、`snapshot/trajectory.db` 43,515,904 B）
- 两个执行臂 worktree（`adhoc-20261115-prompt-v2-v1arm-v1-base`、`adhoc-20261115-prompt-v21-v2control`）**无本地 `.tmp`**；
  运行产物按 ab-lib 的绝对路径集中写入源 worktree。

治理含义（详见独立评审报告 F-3）：冻结快照与全保真数据集的**唯一已知副本**位于 worktree 池的
gitignored `.tmp` 内，而该池 2026-11-08 曾发生外部 `robocopy /MIR` 清空事件；git-8 的 worktree
清理同样会删除它。该风险须 Owner 决策处置。

## 8. Linear 工单现状（执行时实测）

| 工单 | 状态 | 描述要点 | 与 v0.2 §17 的关系 |
|---|---|---|---|
| PRI-1244 | Done | 盘点已完成 | 一致 |
| PRI-1245 | Backlog | 仍按「复用现有 Manifest、Fixture、Runner、Evaluator、Replay」的旧假设表述 | **与 v0.2 修订方向冲突，需按本任务 Stage 3 更新** |
| PRI-1246 | Backlog | 仍要求「第二案例使用相同 Runner/Evaluator/Replay/Report 契约」 | **与 v0.2 §7.3「最小关联」冲突，需更新** |

两票 `blockedBy` 关系完好（1246←1245←1244），未发现其他会话已更新（描述 createdAt/updatedAt
均为 2026-11-16T06:2x 建票时刻）。

## 9. 结论

| 事项 | 结论 |
|---|---|
| SPEC v0.2 事实基线 | **仍然成立**（origin/main 前移但零 Lab 路径变化） |
| 是否已有其他 PR 实现 v0.2 能力 | **没有** |
| PRI-1245/1246 是否已被他人更新 | **没有**（仍为旧假设描述，待本任务 Stage 3 修订） |
| 本地历史产物 | **存在且可定位**（在 #2653 源 worktree `.tmp`，1.7 GB + 108 MB） |
| 遗留未解决问题 | ① 全保真唯一副本的存储治理风险；② #2653 公开 Git 历史早期脱敏缺口（Owner 决策项，SPEC §19-2）；③ 两票描述与 v0.2 冲突 |

**Stage 0 = PASS。** 可进入 Stage 1（独立反向评审）。

---

## 更新后记（r2，2026-11-16 Owner 评审轮）

1. **Stage 3 已完成**：PRI-1245 描述更新并经 handoff 置 **In Review**（PR #2682）→
   **r3 更新（2026-11-17）：#2682 已合并，Linear 实态 = Done**；
   PRI-1246 描述更新、保持 **Backlog**。本文 §8 的「两票 Backlog、待更新」为**当时的
   时点快照**，现状态以上述为准。
2. **main 持续前移、Lab 路径持续零变化**：`592f50b4a → … → 23f2c17fd → … → ca271423b`
   （#2680 版本 bump + 一批依赖升级 PR），三次区间实测（含独立 agent 复核 @ `11b6859a0`）
   均确认零 Lab 路径变化。本报告正文所记 SHA 均为时点值。
3. **Owner 评审轮处置**：全保真数据已按 git-16 归档复核（`artifacts/pri-1245-prompt-v2-fidelity-backup/`，
   1,332/1,332 文件哈希一致，本地不推送）；k4wz9t 源 worktree 归档完成前禁止清理（Owner 指令）。
