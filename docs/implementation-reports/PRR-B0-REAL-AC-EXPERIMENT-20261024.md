# PRR B0 真实 A/C 实验报告（PRR-B0-AC-REAL-001 · 2026-10-24）

| 项 | 值 |
|---|---|
| 执行基线 | worktree `PRI-1002-prr-ac-offline` @ commit `9f70fc599`（含 creator-id 回退），数据集 fixtureHash `a65f4ebb…`（r3 修订版：附 citable ID 清单与合法 decisionId 清单） |
| 模型 | ZAI Coding Plan · **glm-4.7**（`glm-5.3-flash` 与 5.x 系列实测 429 Insufficient balance——编程套餐不含；glm-4.6 同 429；glm-4.7 实测可用，连通性+形状已验证） |
| 执行轮次 | r1（作废：投递协议缺 citable ID 清单 → 22/25 INCONCLUSIVE）；r2（作废：同缺口另一半——未公开合法 decisionId 清单 → 25/25 decision_not_in_gold）；**r3（有效）：修复投递协议后全部 25 行可判定** |
| 裁定依据 | 冻结记录 digest `cd6d1676…`（Linear PRI-1001 Owner 签署，authorId `50010d8e…` = 工单创建者，creator-id 回退信任根） |

## 有效分母与结果（r3）

| 组 | 入册 | 排除（未授权） | 完成 | ALIGNED | ACCEPTABLE | MISALIGNED | INCONCLUSIVE |
|---|---|---|---|---|---|---|---|
| A（仅原则） | 13 | 1 | 12 | 11 | 1 | 0 | 0 |
| C（原则+历史） | 13 | 0 | 13 | 11 | 1 | 0 | 0 |

- AC-M1（正确率）：A = 12/13；C = 12/12。
- 逐配对方向：T1 改善 1 对（A:ACCEPTABLE→C:ALIGNED，t1-history-decides——正是预注册预期的"历史填补原则抽象不足"场景）、同 4；T2 退化 1 对（A:ALIGNED→C:ACCEPTABLE，t2-principle-sufficient——历史无关任务被历史轻微干扰）、同 4；T3 同 2（**NT-1 = 0**：模型在历史冲突场景正确拒绝过时结论，未被旧历史带偏）。
- NT-2 = 0（无 T1/T2 溢出性误用）；NT-3 信号 1 条（C:t2 退化伴随措辞谨慎化）。
- 预算：0 次触顶；请求计数基准 = budget_ledger；零失败行；行级 token/时延未由 adapter 回传（null，如实标注）。

## 裁定（按冻结 FZ-09）

| 判据 | 阈值 | 实测 | 判定 |
|---|---|---|---|
| T1 改善对 ≥ 2 | 2 | **1** | ✗ |
| T2 无退化 | 0 退化 | **1 退化**（ALIGNED→ACCEPTABLE，正确性未失） | ✗ |
| NT-1 = 0 | 0 | **0** | ✓ |

**结论：UNPROVEN（不满足预注册 GO 阈值；亦不构成 STOP——NT-1=0，无硬负迁移）。**

方向性信号（不改变 UNPROVEN 判定）：唯一的历史敏感任务（t1-history-decides）呈现预注册预期的正向迁移；唯一的退化发生在历史-无关任务且为轻度（正确性保持）。样本量（T1 有效 6 配对）低于方向性结论所需的统计效力。

## 对功能开发的决定（阶段 E3）

UNPROVEN → **不进入全量三宿主功能开发**。存在一个具体、可修复且会改变开发决策的原因：**统计效力不足**（有效配对 12，T1 类仅 6——检测 ≥2 对改善的效力不够）。该原因的修复路径是扩大任务集（增加 T1 类边界任务）后重签重跑，而非实现一个价值未证实的功能。

按任务书纪律（E3"不得无限追加任务拖延结论"），本轮不自动扩样本；扩样本决策移交 Owner。

## 完整性声明

- 本轮为**真实模型调用**（ZAI glm-4.7，26 请求经 PI 授权链+预算账本），非 mock/离线预演。
- 全部签署经独立 resolver 对真实 Linear 数据核验（creator-id 回退信任根，authorId `50010d8e…`）。
- 原始产物：`.tmp/prr-launch-final/run-r3/real-run-result.json`（26 行全分母 + 逐行裁定）。
- C-A/C-E 历史结论未受影响、未重跑。
