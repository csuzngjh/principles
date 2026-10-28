# Owner 决策记录 — Phase 2a 终局裁定（2026-10-28）

> 决策来源：Owner 2026-10-28 对 PR #2195 决策卡（`CEB-001-PHASE-2A-FINAL-ADJUDICATION.md` §7）的裁定消息。
> 本记录为研究治理决策凭证，随 PR #2195 入库；不修改任何冻结研究资产的四哈希（本文件不在冻结哈希计算范围）。

## 决策 1 — Phase 2a 出题路径：**A1 `ENUMERATION_SUFFICIENT`（采纳）**

采用确定性枚举（B1 v2 = exhaustive-verify-then-select）作为当前阶段出题路径；**不恢复当前 E 臂**。

Owner 裁定理由（记录，非转述）：

1. 现有可判维度未显示 E 臂优于 B1 v2；
2. 已有题集（CEB-002/CEB-003-P）已基于 B1 基线构建并被真实执行消费；
3. 恢复 E 臂意味着额外授权、付费通道和双盲验证投入，目前缺乏足够的增量收益证据支持这笔成本。

生效边界：

- E 臂维持暂停（PR #2174 决策记录继续有效）；Stage G 真实生成授权维持 **NOT_AUTHORIZED**，本决策不构成恢复授权。
- B1 v2 为当前阶段出题基线；后续如需表达层多样化，按决策 2 的修改纪律另行提案。
- SPEC §12.5.17 生效路径：Examiner 不优于枚举 → `ENUMERATION_SUFFICIENT`。
- PRI-1035 验收据此可收口（可复核报告+明确推荐+Owner 裁定齐备）；收口动作随 PR #2195 合并完成。

## 决策 2 — 对照协议 v2：**批准冻结（附条件）**

`protocol-b0-b1-e-comparison.frozen.v2.json` 自本记录起冻结（源草案 `protocol-b0-b1-e-comparison.draft.json` 保持原样、sha256 绑定，status 仍为 PROPOSED_NOT_APPROVED 作为冻结前历史记录）。

Owner 附加条件（冻结纪律，逐条生效）：

1. **冻结的是协议与可复现基线，不是宣布它在所有未来场景中都是最优方案**——冻结文件的 `conclusionBoundaries.cannotAdjudicate`（『LLM 优于所有/任意确定性方法』不可判）与此条件一致，继续有效；
2. **冻结后任何修改都必须有明确的变更理由、版本记录和可比较的验证结果**——修改只能以新版本文件（v3+）+决策记录形式进行，禁止原地改写已冻结文件；
3. **禁止在看到结果后反复调整基线**（results-driven baseline adjustment）。

## 未决事项（不在本次裁定范围）

- PRI-1039 延期认可（PR #2197）——Owner 未在本消息中裁定，维持待决；期间 SPEC 禁令持续生效（不得声称 Principle 优于 Summary）。
- PRI-1038（F2 真实宿主 A/B）——前置（PRI-1035 收口落地、Owner F2 执行授权、PRI-1037 真实宿主探针通过）不变。
