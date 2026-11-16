# DREAMER_V22_ROUND3_PREREGISTRATION.md — 第三轮实验预注册（2026-11-15）

状态：**预注册（未执行）**。本文档在第三轮任何代码/实验开始前冻结；执行中不得修改成功标准（预注册纪律 §6）。执行前提：Owner 批准本预注册 + Phase 5 方案选型。

## 一、实验问题（源自本轮审计的唯一已证实缺口）

同一 Pain 的多条候选链各自探索同一诊断，产生跨链重复机制（Pain 级冗余率 50%，MECHANISM_DIVERSITY_AUDIT §三/§五），并以近义原则候选的形式传播到下游（DOWNSTREAM_VALUE_AUDIT §二）。**多样性缺口在链间，不在链内**（链内重复率 0%）。

## 二、实验组（按 Owner §九结构，依审计结论裁剪）

| 组 | 内容 | 状态 |
|---|---|---|
| Baseline | 当前稳定版 Dreamer V2.1（快照指纹 `2d5ec3be…`/builder blob `23fefc96…`），全链其余五 Agent 不动 | 固定 |
| **Treatment A：跨候选协调（最小形态=播种侧去重）** | 在 intake 播种前对同一诊断的 recommendations 做去重/合并（Phase 5 方案 M2：router/distiller 提示词级自去重，Schema 不动）→ 同 Pain 链数下降。**不做** pain 级扇入 Coordinator（Phase 5 裁定拒绝，需独立 SPEC） | 待 Owner 批准后实现 |
| Treatment B：独立证据验证 | **不进入实验**——审计证明无必要（EVIDENCE_FIDELITY_AUDIT §三：Unsupported 2/73，且无法确定性实现）。预注册即排除，理由存档 | 排除 |
| Treatment C：组合 | 仅一组处理保留（A），C 不适用 | 排除 |

预注册变更控制：若实现 A 时必须触碰 Schema/Runner 冻结面，实验升级为独立 SPEC，本轮预注册作废重写——不允许边做边改。

## 三、主要评价指标（冻结；预注册阈值按实测基线设定）

基线 = V2.1（paired-2 rep0 实测，10 admitted Pain）：

| 主指标 | 公式 | 基线 | Round-3 通过阈值 |
|---|---|---:|---|
| M1 有效独立机制数 | Pain 级语义归并 | 31/10 Pain | **≥ 37**（+20%）且不得以牺牲证据忠实性为代价（见 M3 门） |
| M2 Pain 级语义重复率 | (N−M)/N | 50.0% | **≤ 40%** |
| M3 证据支持率 | Supported+(Partially 且标注合理泛化) / 全机制 | 97.3% | **≥ 95%**（防止靠编造机制刷 M1） |
| M4 Philosopher 合成质量 | 同 rubric 盲评阶段均分（同族模型限制披露） | 81.66（配对口径） | ≥ 80.66（下降不得 >1 分） |
| M5 Scribe 原则稿质量 | 同上 | 85.93（配对口径） | ≥ 84.93（同上） |

## 四、次要评价指标（观察，不作判定）

Token 消耗（字符级）、单任务耗时、失败率、重试次数、候选淘汰率、下游保留率（显式引用率，代理局限披露）、**机制冲突率（预期仍为 0）**、rule 链人审门完成率。

## 五、实验纪律（冻结）

1. 样本集：第一轮冻结数据集全保真副本（SHA `0db86954…`），S15/S16（stage-a-only）与 intake 拒绝样本按预注册排除规则处理——**排除不计入分子分母，单独披露**。
2. 输入固定：同一 snapshot（state `f25c8fab…` / trajectory `4dcb401e…`）。
3. 模型与运行配置固定：zai glm-5.3（`pi-ai.glm` 绑定），不得中途更换；评估器同配置（同族限制照披露）。
4. Prompt 版本固定：实现完成后生成 5 变体指纹清单并入 `snapshots/`；执行前 preflight 指纹校验（参照 ab-preflight-v21 模式，14 项 fail-fast）。
5. 盲评与模型评估分离：打包走 ab-blindpack 契约（随机翻转+泄漏自检）；Owner ≥20% 抽检沿用 35 包机制。
6. 配对设计沿用：上游诊断每 Pain 一次（对照臂 dist），post-diagnosis 工作区克隆 per (样本,rep,臂)，`upstreamArtifactsSha` 逐对校验。
7. 重复轮：5 个代表性样本 ×3 轮（S02/S07/S10/S12/S14），只测稳定性不计独立样本。
8. **预注册排除规则**：intake 拒绝（intake_failed）的样本不计机制指标；机制归并由 AI 按 MECHANISM_DIVERSITY_AUDIT §二 六类定义执行，归并结果在盲评前冻结存档（`.tmp/round3/`），Owner 可抽查。
9. **不允许看完结果改阈值**；如需改，作废本预注册并注明版本。
10. 可复现：执行器=ab-dreamer-paired.mjs（配对）+ ab-grid（全链），均已在 PR #2653 分支；round-3 新增脚本入 `experiment/prompt-v2/scripts/`，指纹入 manifest。

## 六、样本量与阈值依据（如实，不编造显著性）

- 机制计数在 rep0 的跨臂差（42 vs 31，Δ=11，26%）远大于跨轮家族波动（家族级稳定，计数波动 ±1-2/链）；设 +20% 阈值（Δ≥6）高于噪声带。
- 16 样本规模**不支持统计显著性声明**——阈值是预注册的**工程判定线**（与 round-2 PASS_WITH_LIMITATIONS 同一诚实口径），不是 p 值。
- 若 Owner 需要更强证据，先做 M1 演练（ledger 注册演练量化 U3）再扩样本。

## 七、执行顺序（批准后）

1. Owner 批准本预注册 + 选定 Treatment A 实现形态（M2 提示词级 vs M1 先演练）；
2. 实现 + 指纹清单 + preflight + 单测（照 round-2 标准）；
3. 冒烟（单样本双臂）→ 配对实验（pa3）→ 全链（grid-4）→ 盲评 → 机制归并（盲评前冻结）→ 报告；
4. 全程 PR #2653 保持 OPEN，新增提交不合并。
