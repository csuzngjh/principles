# PD-Lab 历史实验索引 — PD-SPEC-001 Prompt V2 A/B（#2653）

> PD-Lab 第一个历史实验接入记录（SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.2 §13 Stage 2 交付）。
>
> 本索引是**纯引用层**：只指向既有权威产物，不复制数据、不改写结论、不新建
> Runner/Evaluator/Manifest/Replay。实验结果的唯一权威仍是下列原始报告与产物。
>
> 建立时间：2026-11-16 · 建立者：PRI-1245 执行会话（zcode）· 依据：PROMPT_V2_HISTORICAL_ARTIFACT_AUDIT.md（20/20 机械核验 VERIFIED）

## 1. 实验身份

| 字段 | 值 |
|---|---|
| Experiment ID | `PD-SPEC-001-prompt-v2-ab`（SPEC PD-SPEC-001 Phase 0-2 交付，Grid-2 批次） |
| 类型 | 真实 Pain 配对 A/B（同一 16 样本双臂） |
| Source PR | [#2653](https://github.com/csuzngjh/principles/pull/2653)，已合并 |
| Source Commit（合并） | `63e76a8bd6911db6d0a654897e0280e326a83e7e`（squash，2026-11-16T05:54:55Z） |
| Baseline | Prompt V1 @ `0485046e71d2aeba4769725adb4f2aac35a5dd9b`（v1BaseCommit） |
| Treatment | Prompt V2（19 变体；指纹采集 head `be7167dd9`，运行 head `520edea85`，见 §6） |
| 关联工单 | Linear `PRI-1245`（接入）、`PRI-1220`（实验缺陷来源）、`PRI-1244`（盘点） |
| 判定 | **PASS_WITH_LIMITATIONS**（原报告结论，本索引不改写；≠ PROMOTE） |

## 2. Dataset（数据集）

| 字段 | 值 |
|---|---|
| Dataset ID | `pain-dataset`（PD-SPEC-001，16 条真实 Pain：S01–S16） |
| 冻结时间 | 2026-11-15T02:45:25.423Z |
| Dataset Digest（全保真文件 SHA-256） | `0db86954ab6c22474de64188142aed10df8479ab6c797634bb27ee54baec7d6b` |
| 样本 Digest | 16 个 `inputDigest`，权威源：`experiment/prompt-v2/dataset/dataset-manifest.json`（本索引不复制） |
| 快照锚 | `snapshotSha256.state=f25c8fabb40e8406…`，`snapshotSha256.trajectory=4dcb401e79b14bc4…`（67,334,144 B / 43,515,904 B） |
| 公开副本（脱敏） | `experiment/prompt-v2/dataset/pain-dataset.json`、`pain-inventory.json` |
| 全保真副本（本地） | `…/adhoc-20261115-prompt-v2-k4wz9t/.tmp/prompt-v2-inventory/pain-dataset.full.json` + `snapshot/*.db`（gitignored；**唯一已知副本**，存储归档待 Owner 决策，见评审 F-1） |
| 授权状态 | Owner 生产数据本地授权（v0.2 §19-3）；公开面经脱敏+canary+全库扫描（`PUBLIC_DATA_REDACTION_AUDIT.md`） |

## 3. Prompt Variants（V1/V2 严格 19↔19 配对）

| 字段 | Baseline (V1) | Treatment (V2) |
|---|---|---|
| 变体清单 | `experiment/prompt-v2/baseline/prompt-hashes.json` | `experiment/prompt-v2/prompts/prompt-hashes-v2.json` |
| Prompt 文件 | `experiment/prompt-v2/baseline/runtime-prompts/*.txt` | `experiment/prompt-v2/prompts/runtime-prompts/*.txt` |
| 代码锚 | `0485046e71…`（preflight `v1-arm-frozen-base` 全等校验） | 19 变体 SHA 指纹（preflight 运行时重算比对） |
| 核验状态 | 19/19 SHA+chars 重算一致（2026-11-16 审计） | 19/19 SHA+chars 重算一致（同上） |

## 4. Run / Arm / Shard（执行记录）

| 字段 | 值 |
|---|---|
| 主 Run | `grid-2`（本地 `…/.tmp/prompt-v2-ab/runs/grid-2/`，全保真） |
| Grid manifest | `runs/grid-2/grid-manifest.json`：arms=[v1,v2]，4 shards × 4 样本，全部 exitCode=0，窗口 2026-11-15T03:37:27Z–04:28:14Z |
| Shard run-manifest | `run-manifest.{10dba94c,bcc6062c,db1bcde9,fe338e64}.json`——4/4 钉定 `datasetSha256=0db86954…` |
| 运行隔离 | `…/.tmp/prompt-v2-ab/workspaces/`：v1-s0..v2-s3 逐 shard 隔离 workspace |
| 无效批（不入统计，保留） | `runs/grid-1/`（52/52 records incomplete，VERIFIED_INVALID）、`runs/smoke-s01/`——判定依据 `EXPERIMENT_CURRENT_STATE_AUDIT.md` |
| 前置/负控制 | `runs/gate0-propagation/`（Gate 0 六负控制 6/6 PASS）、`runs/probe-shard/`、`runs/gate8-solo/`（S05 双臂单样本门） |
| 后续扩展轮（不在本索引核验范围） | `runs/grid-3/`（v2c vs v21）、`runs/paired-2/`、`runs/paired-smoke/`——Dreamer V2.1/V2.2 实验线，对应 `reports/DREAMER_V21_*`、`DREAMER_V22_*` 系列报告，证据级 PARTIAL |

## 5. Model / Evaluator / Blindpack / Evaluation / Metrics / Report

| 字段 | 值 |
|---|---|
| 模型/Provider | 两臂同档 zai glm-5.3（AMD 档位限额与 intern-ai token 过期后的 Owner 指令链披露；配置：`experiment/prompt-v2/baseline/model-config.json`） |
| Evaluator | glm-5.3 独立会话盲评（**与生成器同家族 → 评价独立性受限，已披露**；免费档评估器 ~40% 失败率会造成选择性偏差，故选同档稳定性） |
| Blindpack | `runs/grid-2/blindpack/packages.json`（109 包）+ `blindmap.json`（109 解盲映射；`missing[]`=47 条缺失 stage-artifact 槽位登记，非未评包） |
| Evaluation | `runs/grid-2/evals/*.json`：109 份结果 + 5 份评价器错误记录（不入统计） |
| Metrics | `runs/grid-2/layer1-metrics.json`（逐 sample×stage×rep×arm 配对，missing/invalid 结构化列出）+ `blind-summary.json`（109 包逐包分数） |
| Report（权威结论） | `experiment/prompt-v2/reports/AB_EXPERIMENT_ACCEPTANCE_REPORT.md` |
| 复现说明 | `experiment/prompt-v2/reports/EXPERIMENT_REPRODUCIBILITY_REPORT.md`（Phase 0 管线从空白重放 + Gate 0-8 记录） |
| 执行时点审计 | `experiment/prompt-v2/EXPERIMENT_CURRENT_STATE_AUDIT.md` |

## 6. 原始数字（照录，不改写）

照录自 `AB_EXPERIMENT_ACCEPTANCE_REPORT.md`（2026-11-15 生成，本审计逐项复核一致）：

- 16 条真实 Pain × 2 臂；盲评 109/109 包完成；
- Pipeline completion 16/16 = 1.00（两臂）；Schema pass 0.981 (V1) / 0.990 (V2)；
- 总体盲评 V1 78.86 → V2 81.50（**+2.64，未达 +5 建议门槛**）；
- 5/6 Agent 阶段改善；Pairwise：V2 胜 65 : V1 胜 27 : tie 17（decided 92，70.7%）；
- Dreamer 唯一退化 −1.25；平均阶段延迟 34.3s → 27.5s（−20%）；总字符 ~492.8K → ~423.0K（−14.2%）；
- **限制（必须随实验保留）**：不声称统计显著性；n=16 方向性证据；评价器与生成器同属
  glm-5.3 家族（评价独立性限制）；全保真数据仅本地、公开面为脱敏副本；
  早期未完整脱敏数据曾进入公开 Git 历史（Owner 决策项）；
- **结论为 `PASS_WITH_LIMITATIONS`，不得改写为 `PROMOTE`**；Owner Promotion 是独立决策
  （SPEC v0.2 §9.4）。

## 7. 复现边界（如实）

| 能力 | 状态 |
|---|---|
| 数据集确定性重建 | VERIFIED（Phase 0 从快照空白重放 16/16 inputDigest 一致；复现报告 §2） |
| Prompt 内容身份 | VERIFIED（19+19 SHA 指纹，本审计重算一致） |
| 真实模型运行重放 | **不可原地重放**——需要同一冻结数据集+同档模型+本地全保真副本；重跑将形成**新 Run**，不得混入 grid-2（SPEC §12.3） |
| 盲评复核 | 可复核（packages + blindmap 解盲；报告建议 Owner 抽查 ≥20%） |
| 跨机器可移植 | 有限——ab-lib 含单机绝对路径（SPEC §4.5 已披露）；索引引用层不依赖这些路径即可审计 |

## 8. 与 experiment-manifest.v1 的关系

`experiment-manifest.v1`（`scripts/dev/pipeline-evolution/lib/experiment-manifest.mjs`）
不承载本实验：该契约服务 Pipeline Evolution/PLE 的 scenarioId/fixtureHash/behaviorObservation
语义，强行回填 #2653 需虚构 scenarioId/fixture 字段。本索引 + 既有 run-manifest/blindpack
已满足 v0.2 §7.3 最小关联要求（Experiment ID/Run/Dataset/Baseline/Treatment/Commit/
Model/Evidence/Report 全部可追溯），**零新代码、零 Schema 变更**。

## 9. Owner Review Card

1. **Problem**：#2653 完成了真实 Pain A/B，但其历史产物从未被 PD-Lab 体系可追溯地接入。
2. **Before**：实验事实分散在已提交报告与本地全保真 `.tmp`，无统一入口；「历史实验能否被审计」无答案。
3. **After**：一个纯引用索引（本文件）+ 一份 20/20 项机械核验的审计报告；实验身份、数据集、双臂、运行、盲评、指标、报告、限制全部可从仓库内定位。
4. **复用**：既有 dataset-manifest / prompt-hashes / run-manifest / blindpack / metrics / 报告，全部原样引用；未新建任何 Runner/Evaluator/Manifest/Replay/Store。
5. **Complexity Delta**：新持久状态 NO（Markdown 索引）；新 subsystem NO；新公共抽象 NO；新 feature flag NO；新跨包依赖 NO；新 host 行为 NO；新外部能力 NO。
6. **设计原因**：最小改动 = 纯引用层；机器可读 Schema 等第二种实验类型证明需要后再议（SPEC §8.3）。
7. **Verification**：PROMPT_V2_HISTORICAL_ARTIFACT_AUDIT.md 20/20 PASS（digest 用原 canonicalization 逻辑重算）。
8. **Risk**：全保真唯一副本存储（F-1，Owner 决策）；后续扩展轮（grid-3/paired-2）证据级 PARTIAL 未逐项核验。
9. **Rollback**：删除本索引文件即完全回退；零生产影响。
10. **Follow-ups**：PRI-1246 第二类型验证；Owner 决策全保真归档与历史泄漏处置；grid-3/paired-2 的独立接入（另行工单）。
