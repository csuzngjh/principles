# SPEC-PD-PRR-001 — Gate A → Gate B 准入矩阵（2026-10-17）

| 项目 | 值 |
|---|---|
| 状态 | **READY FOR REVIEW** — 矩阵本身是文档 PR 交付物；矩阵显示的 Gate B 整体就绪性为 **BLOCKED**。（2026-10-18 PRI-1000 修订：P-02 基线新鲜度复验更新，v1.0 → v1.1） |
| 用法 | 每行是一个 Gate B 启动前置条件。Owner 逐行裁决；全部 ≥ 准入行完成后，GATE_B_EXECUTION 才可从 BLOCKED 翻为可执行 |

## 1. 门禁状态矩阵

| # | 准入条件 | 当前状态 | 证据位置 | 裁决归属 |
|---|---|---|---|---|
| P-01 | Gate A 仅读审计完成（A-01～A-04 交付 + 夹具可证） | ✅ COMPLETE（2026-10-17，基线 702d9223，30/30 夹具 PASS） | 审计报告 §A-01~A-03、§附证据索引 | 已完成，无需裁决 |
| P-02 | 基线无漂移（审计结论对当前 main 仍有效） | ✅ PASS（**2026-10-18 PRI-1000 复验更新**：origin/main 已前进至 `f2539e07e`，15 提交/168 文件；A-01～A-04 的 3 个核心权威文件字节同一，30/30 夹具于新基线逐项重放 PASS，72/72 定向断言 PASS；唯一实质新增面=WorkBuddy 显式 Owner 陈述路径，已评估为不改变 read-back NOT_COVERED / transcript 未采集 / Owner 审批独占三条边界） | `docs/implementation-reports/SPEC-PD-PRR-001-gate-a-main-freshness-delta-20261018.md` | 已完成 |
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
- **2026-10-18 PRI-1000 基线新鲜度复核**：Gate A 审计于 `f2539e07e` 复验成立 → **Gate A = GO（仅审计收口裁决）**；GATE_B_EXECUTION 维持 BLOCKED，本行不构成 Gate B 或 Gate C 授权。证据：`docs/implementation-reports/SPEC-PD-PRR-001-gate-a-main-freshness-delta-20261018.md`

**Gate A→B 准入矩阵 v1.1 END**
