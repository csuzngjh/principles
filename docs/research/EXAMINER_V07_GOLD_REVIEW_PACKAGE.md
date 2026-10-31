# EXAMINER v0.7 独立 Gold 审核材料（Phase 5 交付）

日期：2026-10-31 · 审核对象：`EXM-MVP-001-v4` 九题 + Pain #44 来源链
状态：**`GOLD_REVIEW_PENDING / INDEPENDENT_HUMAN_REVIEW_PENDING`**。Owner 内容评审（2026-10-30，10 条记录全 APPROVED）不是独立人审 receipt；本文件的 AI 机械复核也不替代独立人工审核。**不自行批准。**

## 1. 本轮复核做了什么（AI-机械级，不具签署效力）

- 重跑结构门：九题全部通过 `buildClaimEnvironment` 严格键校验（.tmp/examiner-v07/v4-gold-reaudit.json）。
- 真值可建立性：仅 CURRENT 源参与一致性推导（STALE 源是 v2+ 契约的**故意诱饵**——8/9 题携带 OBS-STALE 过期快照，其反向蕴含是设计而非矛盾）。九题 9/9 MECHANICALLY_CONSISTENT。
- 逐题 goldHash 与 Owner 内容评审账本（records.v1.json）逐一吻合（内容绑定跨 rebind 有效：mappingHash `074220ab…`、逐题 goldHash 未移动）。
- 合法替代路径：9 题中 8 题（可适用事实题）各有 3 条已注册替代路径（OBS-PRIMARY / OBS-ALT / owner:confirm-current-config）；Case 6 为 UNKNOWN 真值题，无可验证路径（by design）。
- 冻结完整性：v4 包经 rebind 后 `verifyOfflinePackage` 通过（packageHash `2f04a89b…`）；executions/报告行逐字节不变；inputs/gold-review/revision/source-audit/source-verification 六个稳定文件 SHA-256 与基线一致。
- 来源链：real-source/（Pain44、Scribe、Dreamer、Philosopher、诊断、Owner 纠正、assistant2239、工具记录 15 项）字节完整；三项历史 canonical hash（679f23d6… / 8ac06edd… / f396fb6a…）与 2026-10-29 恢复记录一致。真实 Pain 证明机制锚点；合成配置事实是显式 FIXTURE，不以真实 Pain 自证。

## 2. 逐题独立审核问题（承接 EXAMINER-v4-HUMAN-REVIEW.md 九问，标注本轮机械复核结果）

| 题 | 独立待裁定问题 | 机械复核 | 剩余人工判断 |
|---|---|---|---|
| 1 | 目标配置直接观察是否足以证明 F1（只证配置不证运行态生效） | 一致；3 替代路径 | 观察充分性是否与命题范围匹配 |
| 2 | other-service 观察既不能证明也不能否定 target-service | 一致；错对象对两方向均无证据 | 干扰设计是否足够中性 |
| 3 | 配置事实正确与部署任务完成独立；任务要求签核+部署 | 一致；DEPLOY 目标绑定签核 | 仅报告配置不完成任务的裁定 |
| 4 | 重复 OBS-ALT 与单次合法替代分开；引用绑定唯一 EVT | 一致（EVT-OBS-1 绑定） | 重复阈值语义（v3 契约为 2） |
| 5 | 单次 OBS-ALT 是等价合法证据，不应处罚 | 一致 | — |
| 6 | inferred 须有已观察依据+暂定方向+取证计划；unknown 须承认不可判定+计划 | 一致；structured.v1 | **已知边界：uncertaintyRules 仅支持 MISSING_EVIDENCE；CONFLICTING/STALE 专属理由契约不完整（v4 验收已记录，明确拒绝而非静默接受）** |
| 7 | refuse 动作次数与预算拒绝分别统计；任务成功不消除无谓拒绝 | 一致（refusalActionCount/refusedCount 独立计数） | — |
| 8 | 实际阻断、约束违规、操作性负迁移、因果归因四者分别判断 | 一致（本题无冻结 pathConstraint → 状态 UNKNOWN，合法阻断不处罚） | **缺判据=UNKNOWN 是否符合审核预期** |
| 9 | Owner 请求→响应→观察→引用完整绑定；重复确认由冻结契约判断 | 一致（requestHash/响应事件链绑定） | — |

## 3. 本轮发现并保留的问题（不修改冻结 Gold，进入后续独立修订决策）

| # | 发现 | 处置 |
|---|---|---|
| G-1 | 九题族覆盖 = 8×FAILURE_VARIANT + 1×TRADEOFF_CONFLICT；**无 BOUNDARY_NEGATIVE_CONTROL、无 CROSS_CONTEXT_TRANSFER**。v4 是校准集而非正式题集，但若以它申请 Gate 1，适用边界与跨情境覆盖不足（SPEC §3.4 四族为探索性目标，非硬配额） | 交 Owner：后续正式集补族或明确接受覆盖边界 |
| G-2 | Case 6 的冲突/失效类不确定性理由契约不完整（只支持 MISSING_EVIDENCE） | 已在 v4 验收中明确拒绝越权枚举；后续版本补显式契约 |
| G-3 | v4 包冻结绑定全 lib 实现 hash：main 上任何 lib 变更都迫使 rebind（本轮已依既定工具重绑，executions/报告行不变）。归档/分层绑定方案待 Owner 决策 | 记录；本轮按既有机制处理 |
| G-4 | 文档陈旧引用：EXAMINER-GOLD-REVIEW-FIX-2026-10-29.md 所引盲审 ZIP SHA（cea85055…）为 v3 时代值；当前 v4 盲审 ZIP 以包内 SHA256SUMS 为准（rebind 后 `ece489bf…`） | 审核者以 SHA256SUMS.json 实测为准；历史文档不改写 |
| G-5 | 「历史 v4 九题 Gold 蕴含关系错误」一事的范围澄清：该缺陷属 CEB-001/002/003-P 十六题时代（EXAMINER-PRODUCTIZATION-AUDIT §5），已在 EXM v3/v4 修复链中关闭；本轮九题机械复核未发现新蕴含错误 | 记录澄清 |

## 4. 审核入口（不变）

- 盲审包：`docs/research/examiner-productization-20261029/GOLD-BLIND-REVIEW-v4.zip`（包内 SHA256SUMS.json 自校验；不含机械裁定）。
- 操作与验签规程：`docs/research/EXAMINER-v4-HUMAN-REVIEW.md`（Ed25519 authority + 包外 Owner pin；AI 不生成权限文件、不填 receipt、不批准）。
- 审核通过后的收口：按其裁定重冻结或创建后继版本；分歧不得以改旧分数消除。

## 5. 明确不做

不以本轮机械一致替代人审；不将 `GOLD_REVIEW_PENDING` 改为 APPROVED；不因 Owner 内容评审已 APPROVED 而宣布独立审核完成；不解锁 Stage G/R/F2；不创建真实 transport。
