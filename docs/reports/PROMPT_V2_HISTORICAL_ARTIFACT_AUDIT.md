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

## 3. 机械核验结果（20/20 PASS，r2 修订：按脚本真实检查 ID 列满 20 项）

核验脚本：`.tmp/pd-lab-v02/verify-prompt-v2.mjs`；逐项结果：`.tmp/pd-lab-v02/verify-results.json`。
**r2（Owner 评审后）**：①脚本与结果 JSON 已按 Owner 指令归档到主检出
`artifacts/pri-1245-prompt-v2-verification/`（本地、不进 GitHub）；②核验表格从 19 行合并展示
修订为**按脚本真实检查 ID 列满 20 行**（初版 G3 行合并了 `G.blindpack-packages` 与
`G.blindmap-entries` 两项检查）；③当日二次复跑确认 20/20 PASS（2026-11-16）。
核验遵循**原实验实际采用的 canonicalization/hash 逻辑**（`freeze-dataset.mjs:115-135` 的
`digestSource` 构造 + `sha256(JSON.stringify(...))`），不以文件原始字节猜测领域 Digest。

| # | 检查 ID（=脚本输出 ID） | 结果 | 内容与证据 |
|---|---|---|---|
| 1 | `A.dataset-full-sha` | **PASS** | 全保真数据集文件 SHA-256 = `dataset-manifest.local.json.datasetFullSha256`：`0db86954ab6c2247…` 双侧一致（frozenAt 2026-11-15T02:45:25.423Z） |
| 2 | `B.sample-input-digests` | **PASS** | 16/16 样本 `inputDigest` 用原 digestSource 逻辑从全保真副本重算 = 已提交 `dataset-manifest.json` |
| 3 | `B2.committed-dataset-digest-fields` | **PASS** | 已提交脱敏 `pain-dataset.json` 16/16 样本携带 manifest 一致的 `inputDigest` 字段 |
| 4 | `C.snapshot-state` | **PASS** | 冻结快照 `state.db` SHA = manifest.snapshotSha256.state：`f25c8fabb40e8406…`（67,334,144 B） |
| 5 | `C.snapshot-trajectory` | **PASS** | 冻结快照 `trajectory.db` SHA = manifest.snapshotSha256.trajectory：`4dcb401e79b14bc4…`（43,515,904 B） |
| 6 | `D.v1-prompt-hashes` | **PASS** | V1 基线 19 个 runtime prompt 变体 SHA+chars 重算 = `baseline/prompt-hashes.json`（锚定 v1BaseCommit `0485046e71…`） |
| 7 | `D.v2-prompt-hashes` | **PASS** | V2 19 个 runtime prompt 变体 SHA+chars 重算 = `prompts/prompt-hashes-v2.json`（19 变体指纹即内容锚） |
| 8 | `E.grid2-v1-head` | **PASS** | grid-2 `heads.v1` = 数据集 `v1BaseCommit` = `0485046e71…` |
| 9 | `E.grid2-shards` | **PASS** | grid-2：4 shards 全 exitCode=0，arms=[v1,v2]，窗口 2026-11-15T03:37:27Z–04:28:14Z |
| 10 | `F.run-manifests-dataset-pin` | **PASS** | 4/4 shard run-manifest 钉定 `datasetSha256` = `0db86954…` |
| 11 | `G.blind-summary` | **PASS** | 盲评汇总：109 包；V1 78.86 / V2 81.50；vetoes 6/7（= 验收报告逐字一致） |
| 12 | `G.evals-files` | **PASS** | `evals/` 109 个评价结果文件（另有 5 个 `.error.json` 评价器错误记录，不入统计） |
| 13 | `G.blindpack-packages` | **PASS** | `blindpack/packages.json` 109 条 |
| 14 | `G.blindmap-entries` | **PASS** | `blindmap.json.map` 109 条 + `missing[]` 47 条结构化缺失登记（reason=stage-artifacts-missing），warnings=0 |
| 15 | `H.layer1-metrics` | **PASS** | `layer1-metrics.json` 含 completion 与 schema 0.981/0.990 字段（顶层键 runId/generatedAt/full/perAgent/pairs/invalidFiles） |
| 16 | `I.pairwise` | **PASS** | Pairwise：V2 胜 65 : V1 胜 27 : tie 17（decided 92，70.7%） |
| 17 | `J.records` | **PASS** | `records/` 52 = 32 基线（16 样本×2 臂）+ 20 重复轮 |
| 18 | `K.runs-inventory` | **PASS** | 9 个 run 目录全部在位（gate0-propagation/gate8-solo/grid-1/grid-2/grid-3/paired-2/paired-smoke/probe-shard/smoke-s01） |
| 19 | `L.grid1-invalid-preserved` | **PASS** | grid-1 无效批按要求保留：52/52 records `status=incomplete`（= `EXPERIMENT_CURRENT_STATE_AUDIT.md` VERIFIED_INVALID 判定一致） |
| 20 | `M.workspaces` | **PASS** | 两臂逐 shard 隔离 workspaces（v1-s0..v2-s3 等 72 个目录）在位 |

初版核验过程中修正过两处**核验脚本自身**的误判（非原始数据问题）：① prompt manifest 的
`chars` 是 JS 字符串长度（UTF-16 code units）而非 UTF-8 字节数；② `blindmap` 顶层是信封
对象，计数对象是 `.map`。原始实验数据零修改。

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
   —— **r2 状态：Owner 已裁决（2026-11-16 评审轮）**：归档与 SHA 复核完成前禁止清理
   k4wz9t 源 worktree；归档已完成（见 §8）。
2. **公开历史早期脱敏缺口**：redaction audit §5 记录的三种处置选项，Owner 决策，
   Agent 不 force-push（v0.2 §11.1 一致）。**仍待 Owner 裁决。**
3. 本审计只读，未删除、未修改、未复制任何全保真数据到 Git；核验脚本与结果留档见 §8。

## 8. Owner 评审轮处置记录（r2 新增，2026-11-16）

Owner 对 PR #2682 的评审提出「高价值数据移入仓库目录但不推送」的指令，已按 git-16 执行：

| 动作 | 结果 |
|---|---|
| 全保真数据归档 | `artifacts/pri-1245-prompt-v2-fidelity-backup/`（主检出仓库根，`/artifacts/` gitignore 规则覆盖，`git check-ignore -v` 已验证，**永不 commit/推送**） |
| 归档内容 | `prompt-v2-inventory/`（13 文件，112,872,820 B）+ `prompt-v2-ab/`（1,319 文件，1,779,742,965 B），来自 k4wz9t worktree `.tmp` |
| 复核 | 相对路径 + 字节数 + **逐文件 SHA-256** 源↔目标比对：1,332/1,332 文件一致，0 mismatch；manifest 见该目录 `copy-verification-manifest.json`，索引见 `README.md` |
| 核验证据归档 | `artifacts/pri-1245-prompt-v2-verification/`：`verify-prompt-v2.mjs`、`verify-results.json`（20 项）、`runs-inventory.json`（本地、不推送） |
| 源 worktree 处置 | 按 Owner 指令**禁止清理** `adhoc-20261115-prompt-v2-k4wz9t`（归档与 SHA 复核均已完成，清理与否仍由 Owner 明确裁决） |

**Gate 2 = PASS（r2 维持）。**
