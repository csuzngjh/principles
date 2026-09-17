# PRI-751 桶面数字勘误（extractor 注释污染）— Erratum

> 状态：勘误注记（erratum）。PRI-751 审计的架构结论不变；仅桶面导出名的精确计数修正。
> 对应工单：PRI-794 · 起源：PR #1671 评审轮（PRI-775）。

## 1. 背景

PRI-751 审计（AI Developer Complexity Audit）的桶面提取与 PRI-775 护栏初版（PR #1671，commit `9180f01e`）使用了同一款 regex。该 regex 把 `export { }` 块内注释文本并入了"导出名"。#1671 评审轮已确认污染并在 commit `dbd19e55` 修复 extractor、重生成 fixture。本注记以修复版 extractor 对同一起源快照重跑，给出正式勘误数字。

## 2. 勘误数字

提取对象：`@principles/core` 两个公共桶（与 #1671 冻结的两个 bucket 完全一致）。
起源快照：`9180f01e`（#1671 初版冻结 commit，即 "audit 同款 regex" 产出 1719/197 的那份桶源码；`9180f01e` 与 `dbd19e55` 之间两个桶源码逐字节一致）。

| Bucket | 旧报告数字（audit regex） | 修复版 extractor（同一快照） | 净差 |
| --- | --- | --- | --- |
| `src/runtime-v2/index.ts` | 1719 | **1718** | −1 |
| `src/index.ts`（core） | 197 | **197** | 0 |

净差 −1 的构成（runtime-v2 桶）：**−12 条注释污染 token，+11 个被旧 regex 漏提的真实导出名**（同一根因：注释含逗号时被逗号切分切断，既产生污染又吞掉紧随的真实符号）。

## 3. 逐条 delta 分类（完整清单）

旧 extractor 独有（12 条，全部为非标识符的注释污染，无一为合法标识符）：

| # | 污染 token（注释文本 + 被裹挟的符号名） | 裹挟的真实导出 |
| --- | --- | --- |
| 1 | `/** @deprecated Internal implementation detail — use PainToPrincipleService instead */ PainSignalBridge` | PainSignalBridge |
| 2 | `/** @deprecated Internal — use PainToPrincipleOutput.status */ PainSignalBridgeStatus` | PainSignalBridgeStatus |
| 3 | `/** @deprecated Use PainToPrincipleOutput instead */ PainSignalBridgeResult` | PainSignalBridgeResult |
| 4 | `/** @deprecated Use PainToPrincipleServiceOptions instead */ PainSignalBridgeOptions` | PainSignalBridgeOptions |
| 5 | `/** Minimal interface for a diagnostician runner (monolith or split pipeline). */ DiagnosticianRunnerLike` | DiagnosticianRunnerLike |
| 6 | `/** PRI-642 §10: aggregate progress (at-least-one semantics). */ PainProgressReport` | PainProgressReport |
| 7 | `/** PRI-642 §10: per-candidate disposition — the authority for mixed results. */ PainCandidateOutcome` | PainCandidateOutcome |
| 8 | `// PRI-469: pure validator for untrusted intentTension from artifacts. validateIntentTension` | validateIntentTension |
| 9 | `// PRI-510: re-export so the CLI plugin layer can reference the seeder contract // without importing the runner source file directly (EP-02: production path // wiring must use the barrel` | （无 — 纯注释残片，被注释内逗号切开的左半） |
| 10 | `// PainStats export removed (PRI-451 Wave 1.5): no live reader. EmpathyEventStats` | EmpathyEventStats |
| 11 | `not deep imports). SeedArtificerRepairParams` | SeedArtificerRepairParams（#9 注释右半与符号粘连） |
| 12 | `unknown. */ GovernanceHostKind` | GovernanceHostKind |

修复版 extractor 独有（11 条，全部为真实标识符，且逐一经起源快照源码验证确为该桶导出）：PainSignalBridge、PainSignalBridgeStatus、PainSignalBridgeResult、PainSignalBridgeOptions、DiagnosticianRunnerLike、PainProgressReport、PainCandidateOutcome、validateIntentTension、EmpathyEventStats、SeedArtificerRepairParams、GovernanceHostKind。

算术闭合：1719 − 12 + 11 = 1718。core 桶两侧 delta 均为空集。

分类汇总：**12/12 污染条目均为注释文本；0 条"other"；另 11 条为同根因导致的真实导出漏提（已找回）**。

## 4. 不变的部分

* PRI-751 审计的架构结论不变：桶面仍是幽灵导出积累点、零消费者家族结论、高风险区域判定均不受 ±11/12 条（1719 的 0.7%）影响。
* core 桶（197 名）无偏差。
* 现 fixture（1718/197）即为修复版 extractor 的正确产物；#1671 评审轮已随合并修正。当前 main 上的 1721（@`fad746fc`）是冻结后经 PRI 标签的合法表面演进（PRI-720/776/802/809/812/813 更新 fixture），与本勘误无关。

## 5. 旧数字的现存位置（读到 1719 时以本注记为准）

* PR #1671 描述（"1719 名/197 名，与 PRI-751 审计同款提取 regex"）；
* commit `9180f01e` 提交信息；
* Linear PRI-775 工单描述（"~1792 个导出名"为审计时点近似值，且早于 PRI-770 幽灵家族清扫，非 extractor 精确声明）；
* PRI-751 审计原报告（`docs/architecture/PRI-751-ai-developer-complexity-audit.md`）为未跟踪交付物，已随任务 worktree 清理灭失，无法内联勘误——本文件即其桶面数字的替代勘误记录。

## 6. 复现

```bash
# 修复版 extractor（含合同测试）：
npx vitest run src/runtime-v2/__tests__/architecture-regression.test.ts -t "barrel export surface"
# 当前 main 4/4 绿（2 fixture 对照 + 快照自洽 + extractor 合同），无回归。

# 重跑脚本：对 9180f01e 桶源码分别施加旧版/修复版 extractor，输出上表全部数字与清单。
# 提取逻辑以 packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts
# 的 extractExportNames（修复版）为准；旧版见 git show 9180f01e 同文件。
```

* 勘误日期：2026-09-17
* 审计工作基线：`fad746fcdb4de8df05c8c692da08bad7865c3847`（origin/main）
* 提取快照：`9180f01e61944d5c21b73b7421064376a8d4d00c`；修复参照：`dbd19e556ab0055b4aee9d080b88b6f294bdcf3b`（PR #1671 合并头 `5ea9ae0acd09cfd577e0286dc75c24f85bdbaf78`）
