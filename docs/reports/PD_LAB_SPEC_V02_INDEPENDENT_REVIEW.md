# PD_LAB_SPEC_V02_INDEPENDENT_REVIEW — SPEC v0.2 反向评审（自评 + 独立复核）

> 阶段 1（Stage 1）输出 · Gate 1 · 初版 2026-11-16 · **r2 修订（同日，Owner 评审后）**：按 Owner 指令修正独立性表述与统计口径，追加独立 agent 复核记录（§B）
>
> 被评审对象：`docs/specs/SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.2.md`（本 PR 内附原文本）。
> 核验基线：初版为 `origin/main @ 23f2c17fd`；§B 独立复核为 `origin/main @ 11b6859a0`（更新 tip，
> SPEC 基线至该 tip 仍为零 Lab 路径变化，两次实测）。

## 0. 评审构成与诚实声明（r2 修正）

| 部分 | 执行者 | 性质 |
|---|---|---|
| §A 五视角评审（Reviewer A–E） | **本执行会话**（与 SPEC 无历史关系的同一 AI 会话，全新阅读 SPEC 后以推翻为目标执行） | **多视角反向自评**——不是独立 Agent 评审，不声称独立性 |
| §B 独立复核 | **fresh-context 独立 agent**（Explore 子代理，全新上下文，明确禁止阅读本会话的其他评审产物，独立对照 `origin/main` 逐项核验） | **独立执行记录**（agentId `agent_1c55fac3`，44 次工具调用，约 10.5 分钟，完整报告在案） |

Owner 评审指出的表述问题已修正：初版把 §A 称为「独立反向评审」是**过度声称**——实际是
多视角反向自评；本 r2 如实区分两部分证明力，Gate 1 判定建立在**两部分之和**上。

## 0.1 结论汇总（两部分合计）

| 项 | §A 多视角反向自评 | §B 独立 agent 复核 | 合计 |
|---|---|---|---|
| P0 | 0 | 0 | **0** |
| P1 | 0 | 0 | **0** |
| P2 | 3（F-1/F-2/F-3） | 0 | 3 |
| P3 | 3（F-4/F-5/F-6） | 7（IND-F1…F7，其中 F7 为备注级） | 10 |
| 推翻尝试 | **9 次**（A1–A4 + B1–B5） | 6 组清单核验 + 全文矛盾扫描 | — |
| 总体判定 | 未推翻 | **SUPPORTED_WITH_FINDINGS**（原文见 §B） | — |
| **Gate 1** | **PASS**——无未处理的 P0/P1；保留 v0.2 原文、不生成 v0.2.1（两部分均未发现「重大事实错误或架构问题」） | | |

---

## §A 多视角反向自评（本执行会话，初版内容，r2 修正计数）

### A-1：推翻「PD-Lab 定位 = 治理/关联层，不是新平台」
核验：PRI-1244 报告五项发现逐条对照源码（`experiment-manifest.mjs` 的
`MANIFEST_SCHEMA:17`、`lab-payload.mjs:15-24` 七模块、五套 Evaluator 零共享 import）。
结果：**推翻失败**。

### A-2：推翻「Pipeline Evolution 适合作为核心管道 Benchmark 首要基础」
核验：`docs/pipeline-evolution/` 15 文件、S001–S006 场景文件、6 份 episode/round 报告、
`scripts/dev/pipeline-evolution/`（manifest/evidence/init/collect 四文件 + 602 行测试）、
`scripts/dev/pipeline-closure-lab/` 6 个确定性夹具全部在位。结果：**推翻失败**——资产真实存在。
但注意：**没有任何场景处于 `validated` 或 `behavioral-verified` 状态**
（`git grep behavioral-verified origin/main` 全树仅 README.md:83 的阶段定义一处命中），
三个 episode 的 Activation/Behavior 全部 `NOT_REACHED`。v0.2 §4.2 已如实声明。

### A-3：推翻「现有 Manifest 能承担最小关联职责」
核验：`experiment-manifest.v1` 必填字段仅 `experimentId/scenarioId/host/startedAt/pdCommit`
（`experiment-manifest.mjs:19,58-60`）。结果：**推翻失败**——v0.2 判断准确。

### A-4：遗漏已有研究模块？
核验：对照 §4.1 资产表与目录实查——PLE、PRR、Challenge/Examiner、Closure Lab、
Adaptive Selector Lab、`docs/experiments/`（behavior signature，含 pri-836 唯一在册行为
观察实验）均已列入或被正确归类。结果：**部分成立但不构成架构缺陷**（pri-836 属 Stage 7
Longitudinal 范畴，v0.2 处理正确）。

### B-1：推翻「#2653 配对 A/B 可复核」
实际执行 20 项只读核验（20 个独立检查 ID 与逐项结果见
`PROMPT_V2_HISTORICAL_ARTIFACT_AUDIT.md` §3 表格，脚本与 verify-results.json 按 Owner
指令归档于主检出 `artifacts/pri-1245-prompt-v2-verification/`，不进 PR）：全保真数据集
SHA、16/16 样本 inputDigest 重算、两快照 DB SHA、V1/V2 各 19 prompt SHA、grid-2 head、
4/4 shard datasetSha256、109/109/109 盲评链、pairwise 65:27:17、records 52、grid-1 无效批
52/52 incomplete 保留。**推翻失败，20/20 PASS（r2 当日二次复跑确认）。**

### B-2：评价器是否独立？
**不独立（已披露）**：评估器与生成器同为 glm-5.3 家族（独立会话、盲化、顺序随机化）。
v0.2 §4.5 如实记录；验收报告 §7.4 披露了偏差理由并建议 Owner 抽查 ≥20%。
**驳回以此为由推翻 SPEC 的尝试**，同时确认该限制必须随历史实验进入 PD-Lab 索引（已执行）。

### B-3：样本泄漏与过度推断？
配对设计：同一 16 条真实 Pain 双臂（digestSource 逐样本钉定）；盲评 arm 盲化 + 随机序；
`missing`（47 个缺失 stage-artifact 槽位）结构化登记而非静默丢弃；+2.64 < +5 门槛、
n=16 不声称统计显著性、Dreamer −1.25 如实报告。**推翻失败**。

### B-4：能否区分「Pipeline 未到达」与「Actor 行为失败」？
v0.2 §12.2/§16 铁律与三个 episode 实际判定一致（PARTIAL_EPISODE / NOT_REACHED ×2，
approvals/activations 恒 0）。**推翻失败**。

### B-5：能否支持长期行为改善结论？
**不能，v0.2 也没说能**：Longitudinal 在 Stage 7（未来）；在册唯一行为观察实验（pri-836）
自述「变化归因于该原则本身不可得」。一致。

### Reviewer C/D/E 检查（§A 内）

- **F-1（P2）**：全保真冻结数据唯一副本位于 worktree 池 gitignored `.tmp`，与 v0.2 §6.3
  自身原则冲突；池有 2026-11-08 外部清除事件前科，git-8 清理会删除。**r2 状态更新：Owner
  已裁决——归档与 SHA 复核完成前禁止清理源 worktree；归档已按 git-16 执行并逐文件哈希
  复核（见审计报告 §8 与 `artifacts/pri-1245-prompt-v2-fidelity-backup/README.md`）。**
- **F-2（P2）**：v2 臂指纹 head `be7167dd9` 与运行 head `520edea85` 双值缺和解说明
  → 已在历史索引 §6 记录双 head 与指纹锚定关系（Stage 4 落地）。
- **F-3（P2）**：Stage 2「引用索引」无约定落点 → 已固化
  `experiment/prompt-v2/reports/PD_LAB_HISTORICAL_EXPERIMENT_INDEX.md`（Stage 4 落地）。
- **F-4（P3）**：SPEC 记录基线 `592f50b4a` 已过时（现 ca271423b，持续零 Lab 路径变化）→ v0.3 刷新。
- **F-5（P3）**：`missing=47` 易误读为「47 包未评」→ 审计报告 §6 已澄清 + v0.3 术语表建议。
- **F-6（P3）**：§10.3 发布闭包验收对 docs-only 阶段的豁免无说明 → v0.3 注明。

### §A 修正计数（r2 修正）

- 推翻尝试：A-1…A-4（4 次）+ B-1…B-5（5 次）= **9 次**（初版误写 6 次）；
- SPEC §1.3 关键修正表：**7 条**（初版误写 6 条；两条计数错误均为初版笔误，已修正并同步
  最终验收报告与 PR 描述）。

---

## §B 独立 agent 复核记录（fresh-context，r2 新增）

**执行方式**：Explore 类型子代理，全新上下文；指令明确要求不阅读本会话其他评审产物
（保持独立性），以 `origin/main` 为唯一事实基线对 SPEC 六组清单逐项核验 + 全文矛盾扫描。
执行记录：agentId `agent_1c55fac3-1682-420f-a8b0-0242634a1945`，44 次工具调用，
约 627 秒，核验基线 `origin/main @ 11b6859a0`（该 agent 自行 fetch 到的更新 tip，
并自行验证了 `592f50b4` 为其祖先——核验强于 SPEC 自我声明基线）。

**逐项核验结果（agent 报告原文要点）**：

1. §2.3 事实表逐行抽查 — **PASS**（含 manifest.mjs:18、PRR :45「本阶段零条」、
   README.md:164-169 六场景状态、25 份报告存在性；2 处 P3 措辞见下）；
2. §3.1.C 七模块白名单 — **PASS**（lab-payload.mjs:15-24 逐字一致 + bundle-plugin.mjs:11,556 同白名单）；
3. §4.5 Prompt V2 全部数字 — **PASS，13/13 逐字一致**（对照验收报告原文）；
4. §1.3 修正表 — **PASS，共 7 行**，逐行与正文对应，全文交叉扫描无自相矛盾
   （并独立证实 #2670 是 #2672 后唯一提交且 56 文件全部不触 Lab 路径）；
5. §4.2 三 Episode 转述 — **PASS**（EP001 :16/:42、R2 :10、R3 :12/:32/:33）；
6. 清单外扫描 — 未发现 P0/P1；附加核验成立（§4.6 六级注入链、§8 词汇表、§10.2、§11.1、三个基线 SHA）。

**独立发现（7 条 P3，全部不阻塞）**：

| # | Severity | 问题 | 建议（均并入 v0.3 建议清单） |
|---|---|---|---|
| IND-F1 | P3 | §4.2 权威入口 4 链接中 2 个用被截断的 34 位 SHA（行 246/248 vs 242/244） | 统一完整 SHA |
| IND-F2 | P3 | §2.3 PRR 行把 UNKNOWN 与 TRUE_ZERO 并置（仓库无字面 `= 0` 常量，报告表述为「本阶段零条」） | 改写为「授权真实样本数=0（TRUE_ZERO）；真实样本结果 UNKNOWN/未测量」 |
| IND-F3 | P3 | §4.5「总 Token 字符统计」混用 Token 与字符（报告以字符计） | 改「总字符量（输入+输出）」 |
| IND-F4 | P3 | §4.2 R3 摘要省略 Owner Decision 为**模拟代投**的关键限定（治理 SPEC 不应省略） | 补一句 owner-mode 模拟代投说明 |
| IND-F5 | P3 | §17 Linear 工单状态无法用仓库证据核验（外部系统） | 标注证据来源为 Linear |
| IND-F6 | P3 | §10.2「不打包整个 lib」的概括略超测试字面断言（实际机制=白名单+负向排除+注释声明） | 措辞对齐测试实际断言 |
| IND-F7 | P3（备注） | §4.7 ReplayEngine：类仍被实例化（promote-impl.ts:24），退役的是重放语义、保留只读报告查询 | 可选加「代码保留、仅作历史报告查询」 |

**独立复核总体判定（agent 原文）：`SUPPORTED_WITH_FINDINGS`**——7 条 P3，核心事实与
架构判断全部成立，未发现任何可推翻核心的陈述。

---

## §C Gate 1 决定（r2）

**PASS。** 两部分评审（多视角反向自评 9 次推翻尝试 + 独立 agent 六组核验）均未发现
P0/P1；SPEC §1.3 的 7 条关键修正全部经受住核验；v0.2 保留原文、不生成 v0.2.1。
10 条 P3（§A 3 + §B 7）与 3 条 P2 全部不阻塞：P2 中 F-2/F-3 已在 Stage 4 落地、F-1 已获
Owner 裁决并完成归档复核；P3 全部列入 v0.3 修订建议（IND-F1…F4、F6 + §A F-4…F-6），
随本报告交 Owner。
