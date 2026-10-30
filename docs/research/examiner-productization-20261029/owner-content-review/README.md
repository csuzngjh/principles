# EXM-MVP-001-v4 Owner 内容评审记录

2026-10-30，Owner 通过逐题阅读完成了 Mapping 与 Case 1–9 的**内容评审**，本目录将该评审以可验证的形式固化入仓库。评审意见原文随当日「Examiner 产品化离线阶段最终收口」Goal 指令交付，`records.v1.json` 的 `ownerComment` 字段逐字保留，未扩写（Case 6/7 的原始回复仅为「认可」）。

## 文件

- `records.v1.json` — 评审账本：Mapping + 九题共 10 条记录，每条含 reviewId / reviewerRole=OWNER / subjectId / subjectHash / mappingHash 或 goldHash / decision / ownerComment / reviewedAt / sourceReference / packageVersion / schemaVersion。
- `SHA256SUMS.json` — 账本文件的独立 SHA-256。
- `semantic-consistency-audit.md` — 逐题语义一致性审计（Owner 意见 ↔ Gold/评分器/负迁移判定的实现证据）。
- 绑定验证测试：`scripts/__tests__/principle-learning-lab-owner-content-review.test.ts`。

## 绑定规则

**内容哈希是强绑定**：每条记录的 `goldHash`（九题）与 `mappingHash` 与冻结包内 `gold-review.json` / `receipts.template.json` 及 `compileCase` 权威计算逐项相等，由上述测试在 CI 强制。这两类哈希在包级重生成（如 main 刷新后的 freeze 重绑定）中保持不变，因此 Owner 认可的内容效力跨包级重生成持续有效。

**包级哈希是记录时上下文（provenance）**：`bindingContext.packageHash` / `subjectHash` / `baseCommit` 记录评审固化时的包状态，不作为内容效力条件，测试不对其做漂移断言。每次 freeze 重绑定（`scripts/dev/principle-learning-lab/rebind-exm-v4-freeze.mjs`）把这三项刷新到重绑定点，账本决策、意见、时间与内容哈希不变。

## 治理边界（必须区分）

本账本是 **Owner 内容评审**（reviewerRole=OWNER，无签名义务），**不是独立人工审核 receipt**：

- 不含 Ed25519 签名，不构成 `examiner-mapping-review.v1` / `examiner-gold-review.v1`；
- 不改变 `review-subject.json` 的 `PENDING` 状态；
- 不满足 `EXAMINER-v4-HUMAN-REVIEW.md` 的独立人工审核准入条件。

正式独立人工审核仍由 Owner 指定的真实独立人类审核者按盲审包签署，当前状态：`INDEPENDENT_HUMAN_REVIEW_PENDING`。

## 追加式规则

账本只能追加新记录（如后继版本的 Owner 评审），不得修改或删除既有记录；每次变更须同步更新 `SHA256SUMS.json`。历史版本以 Git 历史为准。
