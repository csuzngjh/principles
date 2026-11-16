# PD-SPEC-001 Round 2 — Experiment A：Dreamer 独立配对 A/B 报告（SPEC §7.2）

运行：`.tmp/prompt-v2-ab/runs/paired-2`（2026-11-15，zai glm-5.3，与 grid-2 同档）
臂：v2c（对照 = 第一轮 Dreamer V2，worktree 钉 9b87e9bc4）/ v21（实验 = Dreamer V2.1）
执行器：`experiment/prompt-v2/scripts/ab/ab-dreamer-paired.mjs`；分析：`scripts/analysis/paired-analysis.mjs`

## 配对设计（Dreamer 是唯一变量）

- 上游诊断每样本只跑一次（对照臂 dist；两臂诊断提示词逐字节同——preflight 指纹 19/19 证明），post-diagnosis 工作区（state.db 含 wal/shm + trajectory + memory）按 (样本, rep, 臂) 克隆，config 按新路径重派生。
- 因此 Dreamer 的 predecessorOutput / contextRefs / taskId / 候选 uuid 跨臂逐字节相同；每对记录 `upstreamArtifactsSha`（20/20 对一致，打包器强校验，不一致即拒绝出包）。
- S15/S16（stage-a-only）无 Dreamer 上游 → 如实记 N/A，未伪造输入（SPEC §7.2）。
- 重复轮：S02/S07/S10/S12/S14 × rep0-2；其余样本 rep0。重复轮只观察稳定性，不计独立样本。

## 覆盖

- 上游 14 样本：admitted 10（S02/S03/S04/S05/S07/S09/S10/S12/S13/S14），no-dreamer-input 4（S01/S06/S08/S11——admission gate 拒绝，SPEC §4.4 合法终态）。
- 克隆 40（20 对 × 2 臂），**20/20 对双臂 verification.ok**，0 失败。
- 盲评：60 包（dreamer/philosopher/scribe × 20），60/60 成功（2 例首评失败重试后全绿）。
- Candidate Diversity 专项评估：20 包 × 2 slot = 40 评估，40/40 成功。

## 结果（主 rubric，盲评，A/B 随机翻转）

| Dreamer 维度 | V2 对照 | V2.1 | Δ |
|---|---:|---:|---:|
| Root Cause Relevance | 87.15 | 87.55 | +0.40 |
| Candidate Diversity | 79.60 | 77.15 | **−2.45** |
| Strategy Effectiveness | 84.40 | 83.95 | −0.45 |
| Feasibility | 86.00 | 87.95 | +1.95 |
| Risk Awareness | 79.35 | 81.00 | +1.65 |
| **均分（等权）** | **83.30** | **83.52** | **+0.22** |

- Pairwise（dreamer）：V2.1 9 : V2 6 : 平 5（decided 15，V2.1 占 60%）。
- 对照参考：第一轮 V1 81.63 / V2(full-chain grid-2) 80.38；本轮两臂均高于该线，但**对照组同样高于该线**——提升不可归因于 V2.1（运行间方差 ±1.6，见全链路报告）。

## 下游（同 V2 Philosopher/Scribe，仅输入随 Dreamer 变）

| 阶段 | V2 均分 | V2.1 均分 | pairwise |
|---|---:|---:|---|
| Philosopher | 81.25 | 81.66 (+0.41) | 9 : 9 : 平 2 |
| Scribe | 85.78 | 85.93 (+0.15) | 11 : 6 : 平 3（偏 V2） |

## 候选数量与结构

- 候选数/对：V2 7.45（6–12）vs V2.1 6.70（4–12）；每链（均值）≈3.5 vs 3.1。
- **单候选崩塌链（第一轮 S02/rep2 灾难模式）：V2 1 例，V2.1 0 例**——V2.1 每链最少 2 个候选（"normally surface 2-4"规则生效）。
- needs_human_review：每对每臂恒 1（克隆态治理门，对称，0 attempts，非 harness 失败）。

## 局限披露

- 评估器与生成模型同族（glm-5.3，thinking disabled 独立会话）——SPEC §八 layer 4 同模型限制，≥20% 抽检清单已备（35/174 包）。
- lexical duplication 代理（字符 bigram Jaccard）不能捕捉换说法的语义重复，反之亦然；语义重复结论以专项评估器为主、代理为辅，两者在本轮方向不一致（见 Diversity 报告）。
- S06 等 4 样本因 admission gate 拒绝而无 Dreamer 输入：真实门控行为，不补造数据。
