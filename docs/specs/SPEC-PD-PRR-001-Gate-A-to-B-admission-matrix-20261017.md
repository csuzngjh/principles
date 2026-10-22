# SPEC-PD-PRR-001 — Gate A → Gate B 准入矩阵（2026-10-17）

| 项目 | 值 |
|---|---|
| 状态 | **READY FOR REVIEW** — 矩阵本身是文档 PR 交付物；矩阵显示的 Gate B 整体就绪性为 **BLOCKED**。（版本轨迹：v1.0 → v1.1 = 2026-10-18 PRI-1000 基线新鲜度复验；v1.1 → v1.2 = 2026-10-22 PRI-1001 增量审计新增 §3；v1.2 → v1.3 = 2026-10-22 晚 状态澄清（P-02 改为 `NOT_REVALIDATED_AT_CURRENT_MAIN` + 状态解释优先规则）；**v1.3 → v1.4 = 2026-10-22 深夜 P-02 复验恢复 PASS**（依据：原始 30 项夹具已入库并实跑通过，PR #2113），历史 PASS 文本与证据原样保留） |
| 用法 | 每行是一个 Gate B 启动前置条件。Owner 逐行裁决；全部 ≥ 准入行完成后，GATE_B_EXECUTION 才可从 BLOCKED 翻为可执行 |

> **状态解释优先规则（2026-10-22 增补，v1.3；v1.4 修订第 4 条）**
> 1. §1 每行的"当前状态"标注均**绑定其括号内写明的基线**；脱离基线读取该状态即误读。
> 2. **就"当前 main 是否通过准入"这一问题，§3 的增量注记优先于 §1 单元格**。凡 §3 指明的条目，以 §3 为当前准入状态；§1 单元格中的历史 PASS 只代表"在该历史基线上曾经成立"，**不单独构成当前 main 已通过**。
> 3. `NOT_REVALIDATED_AT_CURRENT_MAIN` 不是 FAIL：它表示"缺少足以完整复验的**可复现**证据"，而非审计结论被推翻。（该状态已于 v1.4 由 P-02 恢复 PASS 而解除。）
> 4. **v1.4 起**：P-02 已在 `2fb3b04c8` 恢复 PASS，Gate B 准入第 ⑤ 条随之重新成立；但 Gate B **仍为 `BLOCKED`**，因为 P-06～P-10 全 `PENDING`、P-12 未完成。P-02 PASS **不**授权 Gate B/C。

## 1. 门禁状态矩阵

| # | 准入条件 | 当前状态 | 证据位置 | 裁决归属 |
|---|---|---|---|---|
| P-01 | Gate A 仅读审计完成（A-01～A-04 交付 + 夹具可证） | ✅ COMPLETE（2026-10-17，基线 702d9223，30/30 夹具 PASS） | 审计报告 §A-01~A-03、§附证据索引 | 已完成，无需裁决 |
| P-02 | 基线无漂移（审计结论对当前 main 仍有效） | ✅ **PASS（当前 `origin/main` = `2fb3b04c8`，2026-10-22 复验）**：A-01～A-04 的 3 个核心权威文件字节同一；**30/30 Gate A 夹具于新基线逐项重放 PASS**（夹具已入库可复现，PR #2113）；定向回归 43/43 用例 PASS（0 失败）；新增读取面 `readWorkspaceRuleContextRowsBefore()` 经 18 项合成探针确认只读合同成立、不改变 read-back NOT_COVERED / transcript 未采集 / Owner 审批独占三条边界——**历史记录（保留，未改写）**：⚠️ 曾于 `f2539e07e` PASS（2026-10-18 PRI-1000 复验：origin/main 已前进至 `f2539e07e`，15 提交/168 文件；A-01～A-04 的 3 个核心权威文件字节同一，30/30 夹具于新基线逐项重放 PASS，72/72 定向断言 PASS；唯一实质新增面=WorkBuddy 显式 Owner 陈述路径，已评估为不改变 read-back NOT_COVERED / transcript 未采集 / Owner 审批独占三条边界） | `docs/implementation-reports/SPEC-PD-PRR-001-gate-a-main-freshness-delta-20261018.md`（历史 PASS）；`docs/implementation-reports/SPEC-PD-PRR-001-gate-a-incremental-audit-20261022.md` + `packages/principles-core/tests/fixtures/gate-a-reproducibility/`（当前 PASS 证据） | 已完成 |
| P-03 | SPEC 修订将 F-01～F-16 落实 | ✅ DONE（v1.3 §10.1 定案表：14 RESOLVED + F 侧待 Owner 项转决策卡） | v1.3 §10.1 | Owner 评审 PR |
| P-04 | Recall 身份权威复用冻结（禁二套 resolver） | ✅ 冻结（v1.3 §1.1/§1.6） | v1.3 §1.6 复用矩阵 | Owner 评审 PR |
| P-05 | SQLite 严格只读合同冻结（readonly/no-bootstrap/no-migration/no-WAL） | ✅ 冻结（v1.3 §5.2 六条 + 状态不变验收断言） | v1.3 §5.2 | Owner 评审 PR |
| P-06 | 真实数据与读取范围授权（字段/脱敏/外发/预算/撤回） | ❌ PENDING | 决策卡 D-01 | **Owner** |
| P-07 | 召回资格口径裁决（含已停用/撤回原则资格） | ❌ PENDING | 决策卡 D-02；v1.3 §3.3 保护性默认 | **Owner** |
| P-08 | Codex read-back NOT_COVERED 处置 | ❌ PENDING | 决策卡 D-03 | **Owner** |
| P-09 | WorkBuddy consent 立项 | ❌ PENDING（暂缓为推荐；**2026-10-18 注**：#2073 新增的 WorkBuddy 显式 Owner 陈述入口是 capture 侧治理登记、flag 门默认关，不构成 transcript 采集或 Agent read-back consent，本项维持 PENDING） | 决策卡 D-04；freshness-delta 报告 §5 A-04 | **Owner** |
| P-10 | 首个实验宿主指定 | ❌ PENDING（Codex 首选为建议） | 决策卡 D-05 | **Owner** |
| P-11 | Pilot 宿主证据读取可行性已被审计覆盖该宿主 | ⚠️ 部分（OpenClaw/Codex 静态清单完成；真实覆盖率 NOT_MEASURED——测量本身就是 Gate B 目的，非前置） | 审计报告 A-02 | 已被设计覆盖 |
| P-12 | B0 预注册（任务集/评分/预算/STOP 冻结于查看结果前） | ❌ 未做（Gate B 步骤 3；依赖 P-06~P-10） | 实验方案 §5 | Owner + 执行轮 |
| P-13 | Gate B 退出/失败/回滚条件冻结 | ✅ 冻结（v1.3 §2 Gate B + 实验方案 §3/§5） | v1.3 §2 | Owner 评审 PR |

## 2. 结论

- **GATE_A_AUDIT_COMPLETE** ✅（文档收口=本轮 PR 达成）
- **GATE_B_EXPERIMENT_PLAN_READY** ✅（方案评审=本轮 PR 达成）；**GATE_B_EXECUTION_BLOCKED** ❌→ 待 P-06～P-10、P-12
- 其中任一 Owner 拒绝（REJECTED）对应项 → Gate B 保持 BLOCKED，仅允许修复边界重提案
- 本矩阵不授权任何真实数据读取；Recall 实现不在矩阵范围
- **2026-10-18 PRI-1000 基线新鲜度复核**：Gate A 审计于 `f2539e07e` 复验成立 → **Gate A = GO（仅审计收口裁决，适用范围 = `f2539e07e`）**；GATE_B_EXECUTION 维持 BLOCKED，本行不构成 Gate B 或 Gate C 授权。证据：`docs/implementation-reports/SPEC-PD-PRR-001-gate-a-main-freshness-delta-20261018.md`。**2026-10-22 注**：该 GO 的适用范围限于 `f2539e07e`；当前 main `2fb3b04c8` 的复验状态见 §3.1。

## 3. 2026-10-22 增量基线注记（PRI-1001，v1.2）

> 本节为**追加注记**。§1/§2 的**历史事实**未被改写：P-02 的历史 PASS 文本原样保留在该单元格内，并明确标注其适用基线为 `f2539e07e`。
> **v1.3（2026-10-22 晚）修订**：为消除"历史 PASS 被读成当前 PASS"的歧义，§1 P-02 单元格的**当前状态前缀**改为 `NOT_REVALIDATED_AT_CURRENT_MAIN`，并在文首增加"状态解释优先规则"。历史证据、日期与结论原文未删除。
> **v1.4（2026-10-22 深夜）修订**：原始 30 项 Gate A 夹具已恢复入库（PR #2113）并在 `2fb3b04c8` 上实跑 30/30 通过，§1 P-02 当前状态恢复为 `PASS`（适用基线 `2fb3b04c8`）。§3.1 保留完整的分项证据与"仍不构成的事实"。

| 项 | 值 |
|---|---|
| 本轮审计基线 | `origin/main` = `2fb3b04c8fae1fc865f2297ea448dc4c531ff7cf`（`git fetch` 后 `git rev-parse` 实测） |
| P-02 原 PASS 绑定基线 | `f2539e07ee0f4d2353c5e3897da81b6ef3b787ca`（2026-10-18） |
| 增量区间 | `f2539e07e → 2fb3b04c8`，35 个提交 |
| 完整报告 | `docs/implementation-reports/SPEC-PD-PRR-001-gate-a-incremental-audit-20261022.md` |

### 3.1 P-02 的分项状态（§1 P-02 单元格的当前状态前缀以此节为准）

| 分项 | 状态 | 依据 |
|---|---|---|
| A-01 三个权威文件字节同一 | ✅ VERIFIED | `git diff --stat f2539e07e..2fb3b04c8 -- <3 文件>` 空输出 |
| A-03 只读合同 | ✅ VERIFIED（增量实测） | 18 项合成探针：缺库不创建、字节/journal/schema 不变、无 `-wal`/`-shm`、旧 schema 抛错且零迁移 |
| A-03 "五个证明对象全部零变更"表述 | ❌ 在 `2fb3b04c8` 不成立（但只读**结论**仍成立） | `workspace-behavior-evidence.ts` +45（新增 `readWorkspaceRuleContextRowsBefore()`）、`trajectory-schema.ts` +9/−1（`project_dir` 列） |
| 30/30 Gate A 夹具在新基线重放 | ✅ **PASS（13/13 + 17/17，0 失败）** | 夹具已入库：`packages/principles-core/tests/fixtures/gate-a-reproducibility/`（PR #2113），在 `2fb3b04c8` 上实跑 |
| 定向回归 | ✅ **PASS（43/43 用例，0 失败）** | 3 个文件实测；见下方"证据口径差异" |
| 新增读取面对 A-04 的影响 | ✅ 不改变三条边界 | 增量审计报告 §4/§5：读已入库 `tool_calls`，不读 transcript，无 Agent read-back |

**P-02 当前状态：`PASS`（适用基线 `2fb3b04c8`，2026-10-22 复验）**
——从 `NOT_REVALIDATED_AT_CURRENT_MAIN` 恢复为 PASS 的**唯一新增证据**是"原始 30 项夹具已恢复入库并实跑通过"；其余分项在 2026-10-22 白天即已成立。

#### 证据口径差异（如实披露）

2026-10-18 freshness-delta 报告的定向证据写作"**72/72 定向断言**"。本轮对同样三个测试文件按 **vitest 用例**计数为 **43/43**，未按"断言条数"口径重新计数，因此**不声称复现了 72/72 这个数字**。两个口径下通过率均为 100%，但数字口径不同，使用者应知悉。

#### 仍不构成的事实

- A-02 各宿主真实分母仍 `NOT_MEASURED`（需要授权才能测量，与本项无关）；
- A-05 Pilot 宿主建议仍属 Owner（D-05）裁决范围，本项不复审；
- 30/30 通过**不**证明 Gate B 已授权、**不**证明任何行为收益。

### 3.2 对 Gate B 准入的影响

- 准入条件 ⑤（"只读读取已通过准入矩阵全部条目"）在 `2fb3b04c8` 上**随 P-02 恢复 PASS 而重新成立**；
- 但 Gate B **仍为 `BLOCKED`**：P-06～P-10 全部 `PENDING`（D-01～D-05 待 Owner 裁决）、P-12 未完成。P-02 恢复 PASS **不**解除这些 Owner 决策项，也**不**授权任何 Gate B/C 动作。

### 3.3 本节不构成的授权

本节不授权任何 Gate B/C 动作，不改变 D-01～D-05 状态，不替代 Owner 对 P-02 证据等级的接受决定。

**Gate A→B 准入矩阵 v1.4 END**
