# EXAMINER v0.7 Gate 1 准入评估（Phase 5 交付）

日期：2026-10-31 · 评估对象：`CHALLENGE_TRUST_READY`（SPEC v0.7 §8.1）

## 结论

**`BLOCKED`** —— 不满足 Gate 1，不宣称 `CHALLENGE_TRUST_READY`。

## §8.1 逐项核对

| Gate 1 条件 | 状态 | 证据 |
|---|---|---|
| 来源链完整 | ✅ 满足 | v4 real-source 八类原件字节完整；三项 canonical hash 与恢复记录一致；source-verification/source-audit 绑定（GOLD_REVIEW_PACKAGE §1） |
| Pain → Mechanism → Principle 映射通过核验 | ✅ 内容级满足 | mappingHash `074220ab…` 绑定；Owner 内容评审 10 条记录全 APPROVED 且跨 rebind 有效；**仅内容级**，独立审核见下行 |
| **Gold 独立审核通过** | ❌ **不满足（阻塞项）** | `INDEPENDENT_HUMAN_REVIEW_PENDING`：正式独立人审未发生（盲审包已交付、审核者指定未完成）；Owner 内容评审与 AI 机械复核均不替代 |
| 合法替代路径明确 | ✅ 满足 | 8/9 可适用题各有 3 条注册替代路径；Case 6 为 UNKNOWN 真值题（by design） |
| 适用边界明确 | ⚠️ 部分满足 | NOT_APPLICABLE 语义在 v3 契约独立成态（校准 10/10）；但 **v4 九题无 BOUNDARY_NEGATIVE_CONTROL 族**（G-1），边界覆盖需 Owner 裁定补族或接受 |
| 事实骨架冻结 | ✅ 满足 | v4 包冻结 + verifyOfflinePackage 通过（rebind 后 packageHash `2f04a89b…`）；inputs/九题/goldHash 未移动 |
| 评分契约版本冻结 | ✅ 满足 | v4 冻结于 `claim-evidence-adjudication.v2`；v3 契约（`claim-evidence-adjudication.v3`）本轮已实现并校准，供后继研究使用；版本分派显式、未知版本拒绝 |
| 不存在未解决的关键语义问题 | ⚠️ 无关键阻塞，留两项已知边界 | G-2（Case 6 冲突/失效理由契约不完整——明确拒绝而非静默）；G-3（v4 全 lib 绑定对 main 漂移脆弱——归档方案待 Owner）；G-4（陈旧 ZIP hash 文档引用） |

## 阻塞项（必须解决才可重评）

1. **独立人工 Gold 审核**：Owner 指定独立审核者 → 盲审（`GOLD-BLIND-REVIEW-v4.zip`）→ 签名 receipt → `verify-exm-human-review.mjs` 验证。在此之前正式有效题数按零计（SPEC §8.1）。
2. **边界族覆盖裁定**（G-1）：补 BOUNDARY_NEGATIVE_CONTROL/CROSS_CONTEXT_TRANSFER 题族（新资产、新 hash、独立审核），或 Owner 明确接受 v4 覆盖边界并记录。

## 与其余门的边界

- Gate 2（BEHAVIOR_EVALUATION_READY）未评估：前置 Gate 1 未过；A/B 隔离契约与验证工具（本轮 Phase 3）已就绪供其后使用。
- Gate 3（LLM Authoring）可选，不阻塞：B1 确定性枚举保持默认，`ENUMERATION_SUFFICIENT` 路径保留。
- Gate 4（产品集成）本轮不开发，仅存设计边界。
- **不自动进入 Phase 6**：真实出题/真实 Actor/宿主实验均需 Owner 单独签发授权。

## Owner 下一步决策清单

1. 指定独立人工 Gold 审核者并完成盲审（唯一硬阻塞）。
2. 裁定 G-1（补族或接受边界）。
3. 裁定 G-3（v4 冻结绑定归档/分层方案）。
4. 是否将后续正式研究切换到 v3 评分契约（建议：是——七维独立 + UNKNOWN 语义 + 七类负迁移已校准）。
