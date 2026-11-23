# PD-Lab 使用指南（唯一权威）

> **本文件是 PD-Lab 行为实验基础设施的唯一权威使用指南。** AGENTS.md §25A 给出仓库级约定并链接到这里；SPEC/TECH/CONTRACT v0.3 是设计权威，本指南不复制其正文、只描述使用纪律。指南中的命令与根 `package.json` 脚本一一对应；如两者不一致，以 `package.json` 为准并修本指南。
>
> 配套工单族：PRI-1250（母工单，PD-Lab v0.3）。本指南不创建任何新的 Runner / Evaluator / Evidence / Report 系统。

---

## 1. PD-Lab 解决什么问题

单元测试与行为实验回答不同的问题：

| | 回答的问题 | 证据形态 |
| --- | --- | --- |
| 单元测试 / 契约测试 | 代码是否按设计执行 | 断言通过 |
| **PD-Lab 行为实验** | 设计是否真的**改变了 Agent 的行为**，且改变符合预期方向 | 预注册 + A/B 双臂 + 盲评 + 可复算证据 |

只要一个改动声称「让 Agent 做得更好 / 更安全 / 更符合意图」，单元测试就无法证明该主张——它只证明代码在跑。PD-Lab 是这类主张的唯一机械化验证路径。

现有能力面（全部复用，不重建）：实验配置与隔离（T3a/T3b）、准入探测（T7a）、裁判协议（jp-pd-lab@1）、T6 资格判定、A/B 双臂执行、指标、盲评包、决策输入与 Owner 决策材料。

---

## 2. 何时必须评估 PD-Lab 使用价值

| 改动类型 | 判定 |
| --- | --- |
| Agent Prompt、Intent（注入/解析/快照）、Memory 注入 | **必须评估** |
| Diagnostician / Dreamer / Philosopher / Scribe 行为链 | **必须评估** |
| Agent 决策与工具调用策略 | **必须评估** |
| 自我纠错与长期行为机制 | **必须评估** |
| 原则、安全护栏、治理规则 | **必须评估** |
| 纯 UI / CSS | 通常 NOT_REQUIRED |
| 纯文档修改 | 通常 NOT_REQUIRED |
| 不触及 Agent 行为的确定性 Bug 修复 | 按行为影响决定 |

**「必须评估」≠ 必须执行完整实验。** 它要求：在 PR 的 PD-Lab Impact 字段给出判定（REQUIRED / NOT_REQUIRED / BLOCKED）和一句话理由；判定 REQUIRED 时按 §4 流程执行或如实报告 BLOCKED。

---

## 3. 何时明确不使用

以下场景**不应**运行实验，NOT_REQUIRED 即可：

* 纯视觉样式修改（不改变 Agent 决策输入与行为）；
* 纯文档整理、注释修正；
* 不触及 Agent 行为面的确定性修复（parser 边界、schema 校验、存储读写等）——此类修复的验证手段是回归测试，不是行为实验。

两个方向的反模式同样禁止：

1. 把 PD-Lab 变成所有 PR 的仪式性负担（对非行为任务机械启动实验）；
2. 对行为面改动用「单元测试绿」冒充行为证据。

Agent 可以不使用 PD-Lab，但必须能解释原因（写进 PR Impact 字段）。

---

## 4. 标准使用流程（判定 REQUIRED 后）

1. **识别行为假设**：本次要验证的行为改变是什么？可观察的判别输出是什么？
2. **检查已有实验资产**：`experiment/prompt-v2/` 历史报告、既有 run 记录、`docs/experiments/`、同族实验的 PREREGISTRATION/DECISION_CARD——能复用就不新建。
3. **确定 baseline / candidate**：两臂唯一允许差异是什么？（必须能一句话说清；多于一个差异即设计缺陷）
4. **检查样本、配置、环境与预注册**：`experiment-config.json`、样本分母、requestCap、预注册冻结状态。
5. **核对运行授权（D2–D6 逐项）**：`lab:qualify` 的 `t6Permissions` 只机械复算 D2/D5/D6 三类审批绑定（`t6-qualification.mjs` 的 `APPROVAL_KEYS = ["d2","d5","d6"]`），**不是完整的 D2–D6 授权凭证**。通过 `lab:qualify` 后仍须人工逐项核对本轮实验适用的 D3（快照执行人/窗口/存储）与 D4（INTENT 内容与路径）Owner 决策记录；确认每条审批记录绑定**本**实验、**本**数据集/快照与**本** INTENT 哈希——跨实验/跨数据的旧授权不构成批准（§5.1）。机器验证的部分：`lab:qualify` 复算 D2/D5/D6 绑定、来源组数与统计门槛；仍须人工核验的部分：D3/D4 决策记录的存在性与绑定范围、D2 对探索性执行的明确批准、审批签名/来源（本地验证报 `AUTHORITY_PROVENANCE_UNVERIFIED` 时不得视为已验证）。`lab:preflight` 通过**不等于**有运行资格——预检只查隔离/配置/摘要绑定，不检查 T7a/T6 资格。
6. **用现有 lab CLI 执行**（§6 命令参考；不得自建执行器）。`lab:run` 的真实路径按所触及数据分级授权：模型调用/预算须 D2；读真实快照须适用的 D3；注入真实 INTENT 须适用的 D4；全保真数据须 D6；要求 Owner 盲评须 D5——不是「只有 D2 就够」。
7. **用现有 Metrics / Blindpack / Evaluator / Summary 产出结果**。
8. **检查结果、限制与副作用**：护栏是否触发、失败/降级样本是否留在分母、限制是否披露。
9. **PR 附实验证据**：结果词汇（§5）+ 证据位置 + 已知限制。

**复用纪律（硬约束）**：必须使用现有实现；不得重建 Runner、Evaluator、Evidence Store、Report 系统。

---

## 5. 授权边界（D2–D6）与结果词汇

### 5.1 授权门

| 决策 | 控制什么 | 没有授权时 |
| --- | --- | --- |
| **D2** | 模型、外部调用、预算与统计参数（α、重复次数、最低组数） | 不得发起任何真实模型调用 |
| **D3** | 真实快照治理（执行人/窗口/存储） | 不得执行真实快照 |
| **D4** | 进入实验工作区的 INTENT 内容与路径 | 不得注入真实 INTENT |
| **D5** | Owner 盲评（样本量、一致率、仲裁） | 不得要求/模拟 Owner 盲评 |
| **D6** | 全保真数据使用（范围/存储/保留/撤回） | 不得访问真实全保真数据 |

D2–D6 的权威参数清单见 [`docs/plans/PD-LAB-V03-IMPLEMENTATION-HANDOFF.md`](../plans/PD-LAB-V03-IMPLEMENTATION-HANDOFF.md) 的 Owner 决策表；每轮实验的批准以该轮独立的 Owner 决策记录为准（参数清单不等于批准记录，二者不可互替）。**口头授权、聊天摘要、旧实验授权、合成 fixture 均不构成批准。**

### 5.2 没有授权时允许做什么

* 离线合成验证：仓库 fixtures、合成双臂工作区、`buildHealthyWorld` 正控、负控注入；
* 只读探测与校验：`lab:probe`（准入探测）、`lab:judge-validate`（裁判协议记录包的结构/绑定/负控校验，不判定实验资格）、`lab:qualify`（T6 资格复算，三态结论见 §5.4）；
* **`lab:probe` 的真实数据边界（重要澄清）**：`--snapshot` 是必填项且会被无条件以只读方式打开（`admission-probe.mjs` 对任何传入路径调用 `openTrajectoryReadonly`）；不带 `--d6-decision` 时 CLI **不会**阻止你传入真实快照——`NOT_RUN_WITHOUT_D6` 只是报告里 `realDataProbe` 的状态字段，不代表 CLI 强制 synthetic-only。因此：**无有效 D6 决策时，绝不能把真实快照路径传给 `lab:probe`**；只读访问不等于已授权的数据访问，合成 fixture 模式靠传入合成快照达成，而不是靠 CLI 拒绝真实路径。已知缺口：工具入口缺少针对快照真实性的 fail-closed D6 输入校验（follow-up：在 `admission-probe.mjs` 入口对无 D6 的真实快照输入直接拒绝）。
* `lab:qualify` 与 `lab:judge-validate` fail-closed：资格结论为 `BLOCKED`、校验失败退出非零。这属预期行为，不是故障；但只有 `lab:qualify` 的 `BLOCKED` 是资格结论，`lab:judge-validate` 与 `lab:probe` 的输出不是资格结论。

### 5.3 明确禁止

* 执行未经授权的真实模型调用（含「只跑几条试试」）；
* 访问未经授权的真实全保真数据；
* 执行未经授权的 Owner 盲评；
* **把 BLOCKED 描述为 PASS**，或在 BLOCKED 时启动真实执行。

### 5.4 结果词汇（必须区分，不得混用）

| 词汇 | 含义 |
| --- | --- |
| `PASS` | 验证目标在授权范围内达成，证据可复算 |
| `PASS_WITH_LIMITATIONS` | 达成但存在已披露限制（如同族裁判、后见信息、样本受限） |
| `BLOCKED` | 资格/授权/数据完整性不满足；合成验证通过**不改变**真实执行的 BLOCKED 判定 |
| `NOT_RUN` | 某项运行/校准/评审未执行（无授权、无环境、显式跳过）；计划内未执行的样本单元不得剔除——按计分契约以 `UNKNOWN` 保留在分母 |

T6 资格判定另有协议级**三态**词汇：`CONFIRMATORY_READY` / `EXPLORATORY_ONLY` / `BLOCKED`（由 `lab:qualify` 机械输出，不得人工改写）。`NOT_RUN` 只标记校准/评审等前置事项未执行（如实时裁判校准 `NOT_RUN`），本身不是第四种资格结论。

---

## 6. 命令参考（与根 package.json 一一对应）

| 命令 | 脚本 | 职责 | 真实调用/授权 |
| --- | --- | --- | --- |
| `npm run lab:preflight` | `experiment/prompt-v2/scripts/ab/ab-preflight.mjs` | 实验配置与双臂工作区 fail-fast 预检 | 无 |
| `npm run lab:run` | `experiment/prompt-v2/scripts/ab/ab-grid.mjs` | A/B 双臂 grid 执行（每 sample×arm 驱动诊断链与 formation） | **按所触数据分级：模型调用/预算须 D2，真实快照须适用 D3，真实 INTENT 须适用 D4，全保真数据须 D6，Owner 盲评须 D5（§4 第 5 步）** |
| `npm run lab:metrics` | `experiment/prompt-v2/scripts/ab/ab-metrics.mjs` | layer1 指标提取 | 无 |
| `npm run lab:blindpack` | `experiment/prompt-v2/scripts/ab/ab-blindpack.mjs` | 盲评包生成（arm 身份入 blindmap，不进盲评材料） | 无 |
| `npm run lab:eval` | `experiment/prompt-v2/scripts/ab/ab-eval.mjs` | 裁判评估（ZAI glm-5.3，同族披露；调外部 API，需 `ZAI_API_KEY`） | **需 D2** |
| `npm run lab:summary` | `experiment/prompt-v2/scripts/ab/ab-blind-summary.mjs` | 盲评聚合 + unblinding | 无 |
| `npm run lab:card` | `scripts/dev/pd-lab/build-decision-input.mjs` | 冻结计划+裁判记录 → `decision-input.json`（决策卡输入） | 无 |
| `npm run lab:probe` | `scripts/dev/pd-lab/admission-probe.mjs` | 准入探测（数据/环境 → 各路径 READY/BLOCKED） | 只读 |
| `npm run lab:judge-validate` | `scripts/dev/pd-lab/judge-protocol-validate.mjs` | 裁判协议与评价记录校验（含篡改负控） | 只读 |
| `npm run lab:qualify` | `scripts/dev/pd-lab/t6-qualify.mjs` | T6 资格机械判定 | 只读 |

`experiment/prompt-v2/scripts/ab/ab-run.mjs` 是 `lab:run` 的单臂执行器，由 grid 驱动，通常不直接运行。

**`lab:qualify` 的真实调用格式**（`t6-qualify.mjs` 要求两个必填参数，缺省即 usage error 退出码 2，不会输出资格结论）：

```bash
npm run lab:qualify -- --input <qualification-input.json> --out <dir>
```

* `--input`：资格判定输入记录，由执行者按 `t6-qualification.mjs` 的 `validateQualificationInput` 模式组装——声明 `analysisPolicy`（α / 精度目标 / minimumIndependentSourceGroups）、`authorization`、`judgeModelCalibration`、`ownerBlindReview`、`readyIndependentSourceGroups`，并在 `evidence` 中按 `{artifactRef, sha256}` 绑定来源组、准入报告、预注册与 `evidence.approvals.{d2,d5,d6}` 审批记录。输入文件的来源是本轮实验的预注册与审批 Artifact，不存在自动生成器——按该轮证据手工组装是刻意的（判定是输入的纯函数，可机械复算）。
* `--out`：输出目录（必须尚不存在）；写入 `qualification.json`（三态结论 + `t6Permissions`）与审计文件。

**`lab:eval` 是旧版百分制评分器**：输出 0–100 dimensionScores 与 `A/B/tie` pairwise，**不是** `jp-pd-lab@1` 协议裁判记录，不能充当新版裁判证据；T6/jp-pd-lab@1 证据链以盲评包 + 协议裁判记录 + `lab:judge-validate`/`lab:card` 为准。

### 6.1 `jp-pd-lab@1` 协议裁判的操作路径与能力边界

`judge-protocol.mjs` 是纯函数模块（不调模型、不碰网络/文件系统/时钟），按 CONTRACT §5.1 / TECH §6.6 冻结。完整证据链为：

1. **生成盲评裁判包**：`buildJudgePackage(input)` 组装盲包（复用 ab-blindpack 的泄露扫描，泄露即拒绝）；`swapJudgePackage(blindPackage, secretBinding)` 做 A/B 位置交换，`secretBinding` 携带 `displayOrder` 与 `identityMap`（candidate/reference 绑定，不入盲评材料）。
2. **生成 Judge Response（人工/外部步骤）**：模块本身**不调用任何裁判模型**——谁当裁判是协议外的执行决策（预注册中固定 judge slot 与 judgeModel）。对盲包调用裁判模型得到原始文本响应。
3. **解析与成档**：`parseJudgeResponse(rawText)` 把原始响应严格解析为 `A_BETTER / TIE / B_BETTER / UNKNOWN`（非法输出拒绝，绝不降级为 TIE；UNKNOWN 必须带 reason）；`buildProtocolRecord({blindPackage, secretBinding, parsed, judgeModel, generatorModel, modelRelationDisclosure, evidence, ...})` 生成绑定原始响应的协议记录——`comparisonInputDigest` 从盲包重算，`lossyInput`/`truncation` 来自包内事实，`restoreDisplayVerdict` 只在身份绑定下还原 candidate/reference 判定；`validateProtocolRecord(record)` 做 CONTRACT §5.1 全字段校验。
4. **Owner 盲评抽查**：`node experiment/prompt-v2/scripts/analysis/owner-spotcheck-list.mjs --config <experiment-config.json> --runs <runId,runId> [--fraction 0.2] [--out <dir>]`——确定性抽取 ≥20% 盲包供 Owner 人工复核；面向 Owner 的清单是盲的，答案键（evalId→arm）写入独立 gitignored 文件，Owner 评分记录后才 unblind（须 D5）。
5. **校验与进决策卡**：裁判包+secretBinding+原始响应+协议记录（+可选仲裁记录、预注册 judgeSlots 登记表）组装为 `judge-protocol-bundle.json`（`schema: "pd-lab-judge-protocol-bundle.v1"`），`npm run lab:judge-validate -- --bundle <bundle.json> --out <dir>` 做结构/绑定/篡改负控校验；通过的记录进入 `npm run lab:card -- --plan <plan.json> --judgments <judgments.json> [--arbitrations ...] --blindmap <blindmap.json> --source-groups <source-groups.json> --out-dir <dir>`，产出 ESTIMABLE/BOUNDED_ONLY 决策输入。

**能力边界（当前仍是人工/执行者步骤的环节）**：没有现成 CLI 完成「盲包 → 裁判模型 → 协议记录」的端到端组装；`buildJudgePackage`/`swapJudgePackage`/`parseJudgeResponse`/`buildProtocolRecord` 是模块导出，需要由执行者（或实验脚本）编排调用并组装 bundle；裁判模型调用、Owner 评分录入、secretBinding 保管均为协议外的人工/执行侧职责。`lab:judge-validate` 与 `lab:card` 只校验与聚合既有记录，不产生裁判响应。

---

## 7. 记录与可追溯

* 预注册冻结后不得边跑边改；α 等分析参数变更属协议版本变更，须重新预注册。
* 冻结链（configSha256 / FREEZE-MANIFEST / digest）是实验身份的一部分：**不修改历史实验结果、哈希与已冻结协议**；修复类变更走 FREEZE-MANIFEST.remediationHistory 链并重冻结。
* 实验结果进 PR（结果词汇 + 证据位置 + 已知限制）与对应 Linear 工单；BLIND 材料不得携带 arm 身份。
