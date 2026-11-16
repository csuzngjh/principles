# AB_EXPERIMENT_ACCEPTANCE_REPORT — PD-SPEC-001 Prompt V2

> Grid-2 (remediated harness, per-shard isolation, zai glm-5.3 profile — disclosed deviation) · 16 real pains × 2 arms + repeat runs · blind evaluation 109/109 packages · generated 2026-11-15.
> Verdict: **PASS_WITH_LIMITATIONS**（总体质量改善 +2.64 分，未达 +5 的建议门槛；5/6 阶段改善、pairwise 70.7% 胜率、无 >3 分退化、无契约破坏——方向性证据成立，不声称统计显著性，SPEC §8.3）。

## 1. 第一层：管道运行质量（真实生产链，严格终态验证）

| 指标 | V1 | V2 | 判读 |
|---|---|---|---|
| Pipeline completion | 16/16 = 1.00 | 16/16 = 1.00 | 两臂全通（含 7 个 admission-refused 合法终态） |
| Schema pass rate | 104/106 = **0.981** | 104/105 = **0.990** | V2 ≥ V1 ✓（门槛 §8.2-6） |
| Stage failures (A/B/C) | 0 / 0 / 0 | 0 / 0 / 0 | 诊断链零失败 |
| Avg stage latency | 34.3 s | **27.5 s** (−20%) | V2 更快 |
| Run-level failures | 2 | **1** | |
| Blood/lineage | strict verification all-true per record | 同左 | lineage 由 receipt/前置 schema 门保证 |

## 2. 第二层：单 Agent 盲评（独立评估上下文，109 包全评）

总体：**V1 78.86 → V2 81.50（+2.64）**；pairwise（decided 92）：**V2 胜 65（70.7%）: V1 胜 27 : tie 17**。

| Agent | V1 | V2 | Δ | 判读 |
|---|---|---|---|---|
| RootCause | 77.74 | 78.28 | +0.54 | 证据有界链小幅改善 |
| Distiller | 78.88 | **82.49** | **+3.61** | 双向验证+scope 校准显著生效 |
| Router | 80.53 | **82.32** | **+1.79** | raw 输出契约修复（V1 的 schema 拒绝/修复循环缺陷消除） |
| Dreamer | **81.63** | 80.38 | **−1.25** | 唯一退化（<3 分门槛 ✓）——全局候选上限疑似压缩了多样性 |
| Philosopher | 75.08 | **83.16** | **+8.08** | 最大改善——批判性评估改写直接见效 |
| Scribe | 79.65 | **82.49** | **+2.84** | executionConditions 默认空 + 意图保真指引改善 |

§8.2 门槛核对：①+2.64 < +5（未达建议门槛→LIMITATIONS）；②≥4 Agent 改善 = 5/6 ✓；③无 >3 分退化 ✓；④⑤ Owner-intent/Evidence-fidelity 未下降（RootCause/Scribe 分数上升且无 veto 类别反转）；⑥ schema 0.990 ≥ 0.981 ✓；⑦ completion 1.00 ≥ 1.00 ✓；⑧⑨ 见 §3；⑩ token 见 §3 ✓。

Vetoes（否决）：V1=6 / V2=7（类别均为 owner-intent-conflict/no-evidence-support 边缘案例；逐条理由在 `runs/grid-2/evals/*.json`）。

## 3. 成本与稳定性

| 维度 | V1 | V2 | §8.2-10 判读 |
|---|---|---|---|
| 提示词输入（19 变体合计字符） | 131,076 | 148,739 (**+13.5%**) | <20% ✓ |
| 管道输出（stage+formation artifacts 字符） | 361,678 | **274,238 (−24.2%)** | 输出更精炼（全局候选上限+批判筛选的预期效果） |
| 总量（输入+输出） | ~492.8K | ~423.0K (−14.2%) | ✓ |

稳定性：5 样本 × 3 reps 的 rep 间波动数据在 `runs/grid-2/layer1-metrics.json` perSample.reps；重复轮聚合按 (sample, stage, rep) 主键，不虚增样本量。

## 4. 第三/四层要点（数据文件）

- 最终原则质量与协作层：`runs/grid-2/blind-summary.json`（逐包 unblinded 分数）、`layer1-metrics.json`（per-sample×rep 状态、逐阶段对配 21/21/21/20/20/12 + missing 结构化列出）。
- 语义漂移/重复原则率：评估逐包 rationale 中未出现跨阶段矛盾判定（blind 包无 veto 指向漂移）；重复候选率由 Dreamer −1.25 分与候选数变化间接反映，精确语义重复率需下一轮人工抽样（列为 follow-up）。

## 5. 结论与建议

**PASS_WITH_LIMITATIONS**：
1. V2 在不改动任何 Schema/Runner/Flag/契约的前提下，5/6 阶段盲评改善、pairwise 70.7% 胜率、schema pass 与延迟均优于 V1、token 总量下降；
2. 总体 +2.64 分未达 +5 建议门槛、Dreamer −1.25、重复候选率精确量化待人工抽样——均为明示限制；
3. 小样本（16 pains）只形成方向性证据（SPEC §8.3），不声称统计显著性；
4. 建议：**采纳 V2 提示词**（工程缺陷修复——Router raw 输出契约冲突/示例诱导/上限矛盾——本身即独立成立的行为学依据），并以下一轮更大样本+Dreamer 多样性调优作为后续实验。

评估独立性限制（§7.4）：评估器与生成器同为 glm-5.3 家族（独立会话、无隐藏推理、顺序随机化、包元数据盲化）——免费档评估器（nemotron/ling/ernie）失败率 ~40% 会造成选择性偏差，故选择稳定性；**建议 Owner 抽查 ≥20% 盲评包**（packages.json + blindmap.json 解盲）。
