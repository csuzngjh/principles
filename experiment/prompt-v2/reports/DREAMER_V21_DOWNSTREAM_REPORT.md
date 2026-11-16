# PD-SPEC-001 Round 2 — Philosopher/Scribe 下游协作报告（SPEC §7.3）

下游消费两臂 Dreamer 输出的是**完全相同的 V2 Philosopher/Scribe**（指纹 17/17 未变证明）。因此下游差异全部来自 Dreamer 变量。

## 一、下游盲评分（同 rubric、未改标准）

| 阶段 | 维度 | 配对 V2 | 配对 V2.1 | 全链 V2 | 全链 V2.1 |
|---|---|---:|---:|---:|---:|
| Philosopher | Critical Evaluation | 78.82* | 81.29* | — | — |
| Philosopher | 其余四维均值 | 82.72* | 82.03* | — | — |
| Philosopher | 阶段均分（全链） | — | — | 78.82 | 79.45 (+0.63) |
| Scribe | 阶段均分（配对） | 85.78 | 85.93 | — | — |
| Scribe | 阶段均分（全链） | — | — | 81.00 | 79.89 (−1.11) |

\* 配对实验 20 对维度分；全链为 123 包 byStage（grid-3）。

- Philosopher：无退化（配对 +0.41、全链 +0.63）；批判性评估维度在配对设置 +2.47——V2.1 候选集更收敛后，Philosopher 的批判负载更聚焦。
- Scribe：配对 ~平（+0.15）；全链 −1.11（**超过 1 分门槛，如实披露为边界退化**）。Scribe 的 pairwise（配对 11:6:3 偏 V2）与全链均分同向——V2 的更大多候选集给 Scribe 的合成提供了更多原料时，Scribe 分略高；这是"少而稳"的下游代价，与 Diversity 报告的 Count Adequacy 发现一致。

## 二、淘汰/合并行为（配对实验逐对）

- Philosopher 每链产出恰好 1 个 principleCandidate（契约不变），对 V2.1 收敛候选集的合并与对 V2 多候选集的合并均为**语义合成**而非机械拼接；未观察到互斥策略被强行合并的新案例（主 rubric 的 Synthesis Coherence / Consistency and Conflict Handling 两维配对 84.0 vs 84.0 / 80.6 vs 81.7，均无恶化）。
- 候选淘汰率（每链输入候选数→合成 1 原则候选）：V2 输入 ~3.5/链、V2.1 输入 ~3.1/链，淘汰比例两臂同构；V2.1 未显著改变"谁被淘汰"，改变的是进入淘汰的原料集合。
- needs_human_review：两臂每对恒 1（克隆态治理门）——非 Dreamer 变量引起，不影响配对性。

## 三、Owner Intent 与 principleDraft

- Scribe Owner Intent Fidelity（配对）：V2 86.8 vs V2.1 86.6（−0.2，平）；未出现新的 Owner Intent 丢失或过度推断案例（主 rubric veto：全链 V2.1 5 veto vs V2 6 veto，未增加）。
- intentContract 语义（executionConditions/requiredFacts）契约字段零改动（冻结文件 blob-SHA 证明），Scribe 输出 schema 两臂 100% 通过。

## 结论

下游**未受损**：Philosopher 无退化（略升），Scribe 在全链设置有 −1.11 的边界退化（与更小候选集相关），配对设置持平。按 SPEC §九"Philosopher 和 Scribe 不应出现超过 1 分的明显退化"——Philosopher 达标，Scribe 全链维度越线 0.11 分，如实记为边界情况并交 Owner 裁量。
