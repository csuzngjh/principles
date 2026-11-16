# PD-SPEC-001 Round 2 — Dreamer V2.1 总裁定报告（SPEC §十）

日期：2026-11-15。分支：`ai/adhoc-20261115-prompt-v2-k4wz9t`（PR #2653，保持 OPEN）。对照臂：`ai/adhoc-20261115-prompt-v21-v2control` @ 9b87e9bc4。

## 判定：PASS_WITH_LIMITATIONS（依 SPEC §九矛盾条款如实裁定）

一句话：**V2.1 无退化（总分 +0.81 全链 / +0.22 配对）、消除了第一轮的单候选崩塌失败模式、风险校准一致改善；但其核心目标（候选多样性/语义重复改善）未达成**（专项指标两设置方向相反、幅度在噪声带内）。是否接受"少而稳"的收敛倾向交 Owner 裁决。

## 交付物索引（SPEC §十）

| # | 交付物 | 位置 |
|---|---|---|
| 1 | Dreamer V2.1 生产 Prompt | `packages/principles-core/src/runtime/internalization/dreamer-prompt-builder.ts`（Owner 原文逐字） |
| 2 | 运行时 Prompt 快照 | `experiment/prompt-v2/snapshots/dreamer-v2.1-runtime-prompt--*.txt`（5 变体） |
| 3 | SHA-256 指纹清单 | `experiment/prompt-v2/snapshots/dreamer-v2.1-fingerprints.json`（模板 2d5ec3be…；指令 provenance cf33a2ded4…；builder blob 23fefc96…） |
| 4 | Prompt Builder 测试 | dreamer 套件 99/99 + verbatim 5 变体逐字节锁 + principles-core 全量 exit 0 + tsc 0 错 |
| 5 | Schema/Runner/Flag 不变证明 | round-2 preflight：非 dreamer 指纹 17/17 == round-1 manifest；frozen 16 文件 0 失败 |
| 6 | Dreamer 独立配对 A/B 报告 | `reports/DREAMER_V21_PAIRED_AB_REPORT.md` |
| 7 | Candidate Diversity 专项评估报告 | `reports/DREAMER_V21_CANDIDATE_DIVERSITY_REPORT.md` |
| 8 | Philosopher/Scribe 下游协作报告 | `reports/DREAMER_V21_DOWNSTREAM_REPORT.md` |
| 9 | 全链路稳定性报告 | `reports/DREAMER_V21_FULLCHAIN_STABILITY_REPORT.md` |
| 10 | V2 vs V2.1 盲评对比报告 | `reports/DREAMER_V21_BLIND_EVAL_COMPARISON.md` |
| 11 | Owner Review Card | 见下 |

## Phase 0 数据审计（Owner 指令：先核对，不得预设根因）

第一轮"语义重复率上升"假设**未被数据证实**（lexical 零对 ≥0.5；均值 0.049 vs 0.054）；真实根因指向**单候选崩塌**（S02/rep2：1 候选、diversity 20）叠加 Risk Awareness −2.3。审计脚本：`scripts/analysis/audit-dreamer-round1.mjs`，聚合输出 `.tmp/prompt-v2-ab/analysis/dreamer-round1-audit.json`。

## 硬门槛（§九）核查

| 门槛 | 结果 |
|---|---|
| 1 Dreamer schema 通过率不低于 V2 | **达标**（Dreamer 阶段两臂 100%；总体首轮 0.945 vs 1.0 的差异全部位于提示词相同的 rootcause/distiller 阶段=采样方差，阶段归因入稳定性报告） |
| 2 管道完成率不低于 V2 | 达标（1.00 = 1.00） |
| 3 无新 lineage 破坏 | 达标（invalidFiles 0；配对上游 SHA 20/20 一致） |
| 4 Philosopher/Scribe 契约 | 达标（schema 100% 通过，契约字段零改动） |
| 5 其余五 Agent Prompt 不受影响 | 达标（指纹 17/17 == round-1 manifest） |
| 6 无生产污染 | 达标（上游只读快照；工作区全在 EXPERIMENT_ROOT；一次 grid 误启被有据终止并披露，round-1 已交付证据不受影响） |
| 7 哈希可复核 | 达标（records 携带 artifactsSha256；paired 携带 upstreamArtifactsSha；指纹清单入库） |

质量门槛：81.63 最低线达标（83.52/82.53，但对照组亦过线，不归因）；+2 分理想目标未归因达成；语义重复下降未达成；证据忠实性 mixed（−2.25 配对 / +0.8 全链）；Philosopher 无退化；Scribe 全链 −1.11 越线 0.11（披露为边界）；全链总分未实质下降（+0.81）。

## 评估配置披露（§八 layer 4）

- 生成与评估均为 zai glm-5.3（与 grid-2 同档；未中途切换）；评估器独立会话 + thinking disabled + 随机翻转 + 泄漏自检。
- 同族模型限制继续存在：**Owner 人工抽检 ≥20% 已备**（35/174 包，清单+答案键分离，盲态评分后解盲）。
- 评估失败处理：全部 pass 最终 0 失败（grid-3 123/123、paired 60/60、diversity 78/78），2 例首评失败重试成功，无静默删除。

## 实验期间发现并修复的缺陷（不属于本轮变量，全部有据）

1. `ab-grid` 不转发 `--arms` + `ab-run` 不向 armOrderFor 传臂 → 非默认臂集静默降级为 v1/v2（首次 grid-3 被终止，27 条错臂记录为证）。
2. ab-run 的 PRI-1222 陷阱（exit 1 误判 admission-refused 为失败）——本轮修复后 11 条 refused 全部正确分类。
3. 既有 dreamer 示例解析测试为空转（正则不匹配嵌套示例 + `expect(null).toBeDefined()` 通过）——改为平衡大括号提取 + 真解析。
4. `ab-blind-summary`/`ab-blindpack` 硬编码 v1/v2（round-2 兼容修复；grid-2 回归 109 包/78.86/81.50 逐位复现）。
5. vitest `expect(null).toBeDefined()` 语义陷阱（null 视为 defined）记入执行坑清单。

## Owner 待决事项

1. **采纳与否**：V2.1 按本轮证据可安全采纳（无退化+崩塌修复），但若 Owner 优先追求多样性聚合分，可回到 V2 或要求第三轮（在 V2.1 的崩塌防护上叠加多样性机制）。
2. **Scribe −1.11 边界退化**与 **提示词 +144.4%** 的接受度。
3. **抽检**：35 包盲评清单待 Owner 评分（评分后 Agent 解盲对照）。
4. 历史暴露清理、INTERN_AI_API_KEY、PR 合并裁决——延续第一轮待决清单。
