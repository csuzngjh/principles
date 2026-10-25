# 盲评者操作指引（Expressive Quality Blind Review）

> 面向两名独立评审者（R1/R2）与一名仲裁者。本批为 **12 个候选的表达质量评审**（阶段性批，非完整 36 槽）。

## 你将收到

- `packets/RV-001.json` … `RV-012.json`：12 个匿名候选（RV 编号随机化，与来源无关）。
- 每个候选只含：`taskText`（任务描述）、`facts`（事实命题列表）、`observations`（可执行观察及成本）、`constraints`（预算/时限/是否可询问 Owner）、`hasOwnerAnswers`。

## 你不会看到（也不得索要）

- 任何候选的来源组别（B0/B1/E）、模型身份、生成时间、请求编号。
- 事实的真值（goldTruth）、观察的蕴含关系（implies）、判分标准（Gold）。
- 其他评审者的评分。

如果发现任何候选内嵌了上述信息，该候选记 `safety_leakage = fail` 并立即上报。

## 评分任务（每候选 × 8 维度）

对每个候选，就以下八个维度独立给出 `pass` / `fail` / `undecidable`：

| 维度 | 判什么 |
|---|---|
| mechanism_fidelity **(关键)** | 候选是否真正测量「断言与证据绑定」机制（claim 级），而非泛泛考「是否调工具」 |
| task_validity | 任务描述是否清晰可执行、观察集是否足以支撑裁定 |
| gold_independence **(关键)** | 候选是否暗示/泄露任何事实真值或判分方向 |
| evidence_binding | 观察与命题的绑定结构是否支持「正确/错误/无证据」三分 |
| boundary_coverage | 是否覆盖合法降级、合理推断或不必要查验之一 |
| non_duplication | 是否与其他 RV 候选实质重复（表达相似≠重复；决策结构相同=重复） |
| executability | 约束（预算/时限）与观察集是否自洽可运行 |
| safety_leakage **(关键)** | 是否包含隐藏答案、判分标签或未经批准的执行指令 |

**三关键门槛（mechanism_fidelity / gold_independence / safety_leakage）任一 fail → 候选整体无效**，其余维度不再计分。

## 输出格式

每个 RV 候选一行 JSON（或等价表格）：

```json
{ "rvId": "RV-001", "dims": { "mechanism_fidelity": "pass|fail|undecidable", "...": "..." }, "notes": "一句话依据" }
```

- `undecidable` 需一句话理由；双方均 undecidable 的维度进入 kappa 分母排除集。
- 禁止询问候选来源；禁止与其他评审者讨论未仲裁的分歧。

## 计时

请记录每个候选的评审起止时间（人工修订成本指标依赖此数据）。
