# PROMPT_V2_HISTORICAL_ARTIFACT_AUDIT — #2653 历史实验产物只读核查

> 阶段 2（Stage 2）输出 · Gate 2 · 核查时间 2026-11-16 · 只读，未修改任何原始数据
>
> 目标：确认 PR #2653（Prompt V2 真实 Pain A/B）的历史实验能否被完整追溯、验证和接入
> PD-Lab。**不重新实验、不重新运行、不伪造历史完整性。**
>
> 隐私边界：本报告只记录路径/类型/大小/必要 Hash/关联 ID/验证状态/授权与脱敏状态；
> 不含任何 Pain 原文、评价原文或个人敏感内容。

## 1. 结论（先行）

| 问题 | 结论 |
|---|---|
| 本地历史数据是否完整 | **核心 A/B 批次（grid-2）完整**：数据集、两臂 prompt、运行记录、盲评包、评价、指标、报告全链在位且 Digest 逐项匹配 |
| 可复核程度 | **VERIFIED（20/20 机械核验通过）**——用原实验的 canonicalization/hash 逻辑（非文件字节猜测）重算 |
| 哪些只有报告 | 无核心项 REPORT_ONLY；后续扩展轮（Dreamer V2.1/V2.2 相关 grid-3/paired-2）有独立报告与本地运行产物，未纳入本次逐项核验范围（如实标注） |
| 哪些已丢失 | **无核心丢失**。全保真副本、冻结快照、盲评解盲映射均在位 |
| 全保真 vs 脱敏区分 | 清晰：公开 Git 只含字段级脱敏副本；全保真副本仅在本地 gitignored `.tmp`，且由 preflight fail-closed 保证实验只能读全保真版 |
| Gate 2 | **PASS**——真实存在/可复核/丢失清单全部明确 |

## 2. 产物位置与授权状态

| 位置 | 内容 | 授权/脱敏状态 |
|---|---|---|
| 仓库内 `experiment/prompt-v2/`（123 文件，#2653 合并 `63e76a8bd`） | 脱敏数据集+manifest、V1/V2 prompt 快照+哈希清单、25+ 份报告、ab 脚本 | 公开脱敏版；redaction audit §3：81 文件 vs 1,508 原文扫描 0 泄漏 |
| `D:\Code\_worktrees\principles\adhoc-20261115-prompt-v2-k4wz9t\.tmp\prompt-v2-inventory\`（108 MB） | `pain-dataset.full.json`、`pain-inventory.full.json`、`dataset-manifest.local.json`、`snapshot/state.db`（67,334,144 B）、`snapshot/trajectory.db`（43,515,904 B）、`snapshot-report.json` | **全保真，Owner 授权本地保存**（生产快照来源 `D:/.openclaw/workspace/`，integrityCheck ok，v0.2 §19-3 前提） |
| 同 worktree `.tmp\prompt-v2-ab\`（1.7 GB） | runs/×9（gate0-propagation、gate8-solo、grid-1、grid-2、grid-3、paired-2、paired-smoke、probe-shard、smoke-s01）、workspaces/×72（两臂逐 shard 隔离）、analysis/、spotcheck/、upstream-snapshots/ | **全保真运行产物**；grid-1 + smoke-s01 为 VERIFIED_INVALID 无效批（审计保留，不入统计） |

`.tmp` 均为 gitignored；两个执行臂 worktree（`…v1arm-v1-base`、`…v21-v2control`）无本地
`.tmp`，运行产物按 ab-lib 绝对路径集中写入源 worktree（单机实验特征，SPEC §4.5 已披露）。

## 3. 机械核验结果（20/20 PASS）

核验脚本：`.tmp/pd-lab-v02/verify-prompt-v2.mjs`（本次执行留档，只读）；
逐项结果：`.tmp/pd-lab-v02/verify-results.json`。核验遵循 **原实验实际采用的
canonicalization/hash 逻辑**（`freeze-dataset.mjs:115-135` 的 `digestSource` 构造 +
`sha256(JSON.stringify(...))`），不以文件原始字节猜测领域 Digest。

| # | 核验项 | 结果 | 证据 |
|---|---|---|---|
| A | 全保真数据集文件 SHA-256 = `dataset-manifest.local.json.datasetFullSha256` | **VERIFIED** | `0db86954ab6c2247…` 双侧一致（frozenAt 2026-11-15T02:45:25.423Z） |
| B | 16/16 样本 `inputDigest` 用原 digestSource 逻辑从全保真副本重算 = 已提交 `dataset-manifest.json` | **VERIFIED** | 16/16 逐字节一致 |
| B2 | 已提交脱敏 `pain-dataset.json` 各样本携带相同 `inputDigest` 字段 | **VERIFIED** | 16/16 |
| C-state | 冻结快照 `state.db` SHA = manifest.snapshotSha256.state | **VERIFIED** | `f25c8fabb40e8406…`，67,334,144 B |
| C-trajectory | 冻结快照 `trajectory.db` SHA = manifest.snapshotSha256.trajectory | **VERIFIED** | `4dcb401e79b14bc4…`，43,515,904 B |
| D-v1 | V1 基线 19 个 runtime prompt 变体 SHA+chars = `baseline/prompt-hashes.json` | **VERIFIED** | 19/19（锚定 v1BaseCommit `0485046e71d2aeba…`） |
| D-v2 | V2 19 个 runtime prompt 变体 SHA+chars = `prompts/prompt-hashes-v2.json` | **VERIFIED** | 19/19（19 变体指纹即内容锚，preflight 运行时已重算比对） |
| E | grid-2 `heads.v1` = 数据集 `v1BaseCommit` | **VERIFIED** | `0485046e71…` 双侧一致 |
| E2 | grid-2 4 shards 全 exitCode=0，arms=[v1,v2]，窗口 2026-11-15T03:37:27Z–04:28:14Z | **VERIFIED** | `grid-manifest.json` |
| F | 4/4 shard run-manifest 钉定 `datasetSha256` = 全保真副本 SHA | **VERIFIED** | `0db86954ab6c…` ×4 |
| G | 盲评汇总：109 包；V1 78.86 / V2 81.50；vetoes 6/7 | **VERIFIED** | `blind-summary.json` = 验收报告逐字一致 |
| G2 | `evals/` 109 个评价结果文件（另有 5 个 `.error.json` 评价器错误记录，未被计入统计） | **VERIFIED** | 文件计数 |
| G3 | `blindpack/packages.json` 109 条；`blindmap.json.map` 109 条 + `missing[]` 47 条结构化缺失登记（reason=stage-artifacts-missing），warnings=0 | **VERIFIED** | 见 §5 术语说明 |
| H | `layer1-metrics.json` 含 completion 与 schema 0.981/0.990 字段 | **VERIFIED** | 指标文件顶层键 runId/generatedAt/full/perAgent/pairs/invalidFiles |
| I | Pairwise：V2 胜 65 : V1 胜 27 : tie 17（decided 92，70.7%） | **VERIFIED** | `blind-summary.json.summary.pairwise` 与报告一致 |
| J | `records/` 52 = 32 基线（16 样本×2 臂）+ 20 重复轮 | **VERIFIED** | 文件计数 |
| K | 9 个 run 目录全部在位（gate0-propagation/gate8-solo/grid-1/grid-2/grid-3/paired-2/paired-smoke/probe-shard/smoke-s01） | **VERIFIED** | runs-inventory.json 留档 |
| L | grid-1 无效批按审计要求保留：52/52 records `status=incomplete` | **VERIFIED** | `EXPERIMENT_CURRENT_STATE_AUDIT.md` VERIFIED_INVALID 判定与现状一致 |
| M | 两臂逐 shard 隔离 workspaces（v1-s0..v2-s3 等 72 个目录）在位 | **VERIFIED** | 目录清单 |

核验过程中修正过两处**核验脚本自身**的误判（非原始数据问题）：
① prompt manifest 的 `chars` 是 JS 字符串长度（UTF-16 code units）而非 UTF-8 字节数；
② `blindmap` 顶层是信封对象，计数对象是 `.map`。原始实验数据零修改。

## 4. 关联链（Run / Arm / Shard / Blindpack / Evaluation / Metrics / Report）

```text
Experiment: PD-SPEC-001 Prompt V2 A/B（PR #2653，合并 63e76a8bd）
Dataset:    pain-dataset.json（16 样本 S01–S16，frozen 2026-11-15T02:45:25Z，
            datasetFullSha256=0db86954…，快照 state=f25c8fab…/trajectory=4dcb401e…）
Baseline:   Prompt V1 @ 0485046e71d2aeba4769725adb4f2aac35a5dd9b（19 变体 prompt-hashes.json）
Treatment:  Prompt V2（19 变体 prompt-hashes-v2.json；指纹采集 head be7167dd9）
Run:        grid-2（4 shards × 4 样本；v1 head=0485046e7，v2 head=520edea85；
            每 shard run-manifest 钉定 datasetSha256）
Blindpack:  runs/grid-2/blindpack/{packages,blindmap}.json（109 包，arm 盲化+随机序）
Evaluation: runs/grid-2/evals/*.json（109 份结果 + 5 份评价器错误记录）
Metrics:    runs/grid-2/layer1-metrics.json + blind-summary.json
Report:     experiment/prompt-v2/reports/AB_EXPERIMENT_ACCEPTANCE_REPORT.md
            （PASS_WITH_LIMITATIONS）
Environment: 模型/Provider 记录于 baseline/model-config.json（zai glm-5.3 档位，
            Owner 指令链披露；两臂同档）；执行环境指纹由 Gate 0 负控制 +
            preflight（childEnv 剥离生产指针/workspace 包含断言）保证
```

v2 臂 head 双值说明（评审 F-2）：`be7167dd9` 是 19 变体**指纹采集** head；
`520edea85` 是 grid-2 运行时 v2 臂 worktree head（harness 修复：formation-artifact
join via candidate uuid、admission-refused 合法终态、diagnoseOk 接受 CLI partial-exit）。
提示词内容身份由 19 变体 SHA 指纹承担（本审计已 19/19 重算匹配），运行时 preflight
`v2-prompt-fingerprint-matches-manifest` 已做同断言。两 head 之间 delta 为 harness
修复，不影响提示词内容锚定。

## 5. 证据分级（按任务规定的六级）

| 产物 | 级别 | 说明 |
|---|---|---|
| 冻结快照 DB ×2、`pain-dataset.full.json`、`pain-inventory.full.json` | **VERIFIED** | SHA 与 manifest/local 指纹逐项匹配 |
| V1/V2 prompt 快照与哈希清单 | **VERIFIED** | 19+19 SHA/chars 重算一致 |
| grid-2 运行记录/盲评包/评价/指标 | **VERIFIED** | 计数、配对、汇总数字与报告逐字一致 |
| 已提交脱敏数据集与 manifest | **VERIFIED** | inputDigest 16/16 + 重建等价断言（redaction audit §3） |
| 验收报告/复现报告/现状审计报告 | **VERIFIED** | 其引用的全部数字与产物均可在本地复核 |
| grid-3 / paired-2 / paired-smoke / gate8-solo 等**后续扩展轮**产物 | **PARTIAL** | 在位且有对应报告（DREAMER_V21_*/V22_* 系列），属 Dreamer V2.1/V2.2 后续实验线；本次未逐项重算其 Digest（超出口径范围，如实标注，不冒充 VERIFIED） |
| grid-1、smoke-s01 | **VERIFIED_INVALID** | 审计判定无效批（formation 链断裂+限流污染+共享 workspace），按要求保留，已排除出统计 |

无 MISSING / MISMATCH / REPORT_ONLY 级核心项；无 UNKNOWN 需升级调查的项。

## 6. 术语澄清（评审 F-5）

- **packages = 109**：盲评包总数（候选全集 + 逐 attempt 标注）。
- **evals = 109**：109 包全部有评价结果（另有 5 份评价器调用失败记录，不入统计）。
- **missing = 47**：`blindmap.missing[]` 登记的是**缺失 stage-artifact 槽位**
  （每条含 sid/stage/rep/missingArm/reason），不是「47 包未评」。109/109 包均有评价。

## 7. 治理风险交接

1. **唯一副本风险（评审 F-1）**：全保真与冻结快照唯一已知副本在 worktree 池 `.tmp`
   —— 需要 Owner 决策归档（`BLOCKED_OWNER_AUTHORIZATION`）。
2. **公开历史早期脱敏缺口**：redaction audit §5 记录的三种处置选项，Owner 决策，
   Agent 不 force-push（v0.2 §11.1 一致）。
3. 本审计只读，未删除、未修改、未复制任何全保真数据；核验脚本与结果留档于
   主检出 `.tmp/pd-lab-v02/`（gitignored）。

**Gate 2 = PASS。**
