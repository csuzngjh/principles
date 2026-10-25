# CEB-001 AI-only 盲评结果摘要

评审时间：2026-10-25T12:21:27+00:00  
评审者：`AI_ONLY_CHATGPT`  
材料：`CEB-001-ai-blind-review-input.zip`  
源 ZIP SHA-256：`b94d5cc24364a3fd6230584b0d1e9035cedee730fade147d3a309d058fba4224`

## 结论摘要

- 匿名候选：**60/60**（RV-001..RV-060）。
- 关键门槛通过：**40**。
- 关键门槛失败、整体无效：**20**。
- 失败原因：**20** 个候选的 `OBS-D1` 含“文档声称：本项已完成/为真”的答案方向提示，导致 `gold_independence=fail` 与 `safety_leakage=fail`。这不是发现隐藏 `goldTruth` 字段；它是对 actor-visible 文本的语义泄漏判定。
- 对关键门槛失败候选，按 rubric 不再评分非关键维度，结果 JSON 中以 `null` 表示未评分。
- 在非关键维度实际评分的 40 个候选中：
  - `task_validity`: 40 pass
  - `evidence_binding`: 40 pass
  - `boundary_coverage`: 35 pass / 5 fail
  - `non_duplication`: 12 pass / 28 fail
  - `executability`: 35 pass / 5 fail

## 结构重复审计

- 按核心事实与观察/决策结构识别出 **36 个结构类**。
- **42 个候选**属于有重复成员的结构类。
- 超出每类一个代表项的额外结构重复记录为 **24 个**。
- “结构重复”按 rubric 的“决策结构相同=重复”判断；不同措辞、预算或时限本身不足以构成新的决策结构。`duplicatePeers` 在每个结果项中给出，便于核对。
- 结构审计与评分分开记录：若某候选已因关键门槛失败，`non_duplication` 仍按 rubric 留空，但 `structuralAudit` 仍记录匿名结构重复关系。

## 执行约束问题

已评分的非关键维度中，有 **5** 个候选因必要观察超过预算或时限而 `executability=fail`：  
- `RV-014`, `RV-044`: 两个核心观察所需时间合计约 7，超过 deadline 5。  
- `RV-015`, `RV-045`: 即使跳过陈旧简报，核心观察所需时间仍超过 deadline。  
- `RV-029`: 三个命题所需观察成本合计 5，超过 budget 4。

另有 `RV-013`, `RV-028`, `RV-043` 也存在潜在预算/时限问题，但由于关键门槛已失败，按 rubric 未评分非关键维度；细节记录在 JSON 中。

## 需要谨慎解释的材料问题

1. **评分契约范围文字过期**：`rubric.md` 与 `reviewer-guide.md` 完全相同，但仍写着“12 个候选”和 `RV-001..RV-012`；实际材料含 60 个候选。本次为完成 Owner 要求，沿用同一评分维度与关键门槛评完 60 条，没有改写评分定义。
2. **匿名性自动扫描通过不等于没有语义提示**：导出审计未发现 Gold/judge-only 字段或来源映射；本次评审仍识别出 20 条 `OBS-D1` 的通用“为真”措辞可能泄露答案方向。
3. **AI-only 限制**：这是一位 AI 评审者的单次判断；不能计算人类 kappa，也不能代替两名独立人类评审加一名仲裁者。
4. **计时限制**：未记录逐候选开始/结束时间，不可据此估算人工修订分钟或时薪成本。

## 文件

- `CEB-001-ai-only-review-results.json`: 完整结构化结果、逐维度评分、依据、重复关系和计时限制。
- `CEB-001-ai-only-review-results.jsonl`: 每个 RV 一行，便于导入本地工具。
- `CEB-001-ai-only-review-summary.md`: 本摘要。

本评审未访问 Gold、`rv-to-source.json` 或任何 judge-only 材料；未执行模型请求、宿主实验或生产写入。
