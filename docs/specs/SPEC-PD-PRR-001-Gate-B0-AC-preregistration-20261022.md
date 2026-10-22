# SPEC-PD-PRR-001 — Gate B0 A/C 行为价值实验预注册（v0.2，2026-10-22）

| 项目 | 值 |
|---|---|
| 文件状态 | **DRAFT_NOT_OWNER_APPROVED** — 本文件是待 Owner 审阅的预注册草案，**不是冻结版本，不产生任何授权** |
| 阶段 | PRR / Gate B / **B0 预注册（行为侧 A/C）**；关联 Linear **PRI-1001**（B0）、PRI-1002（B1） |
| 版本 | v0.2（20261022） |
| 上游权威 | `docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.3.md`（§2 Gate B、§7.2、§11.2/§11.4）；`docs/specs/SPEC-PD-PRR-001-Gate-B-experiment-plan-20261017.md`（数据侧 M1–M5/V1–V5）；`docs/specs/SPEC-PD-PRR-001-Gate-B-owner-decision-card-20261017.md`（D-01～D-05）；`docs/specs/SPEC-PD-PRR-001-Gate-A-to-B-admission-matrix-20261017.md`（P-01～P-13）；`docs/implementation-reports/SPEC-PD-PRR-001-gate-a-main-freshness-delta-20261018.md` |
| 核验基线 | `origin/main` = `a821a6fe469e297285c206a53f5175a6de679aa7`（2026-10-22 本机 `git fetch` 后 `git rev-parse`） |
| 前置票状态 | PRI-1000 Linear = **Done**；PR #2076 = **MERGED**（2026-10-18T07:12:16Z，merge commit `24be0c90`，为 `origin/main` 祖先） |
| 真实实验 | **NOT_RUN**（本文档交付不执行任何真实数据读取、真实历史读取、外部模型调用或生产库操作） |
| Gate B | **BLOCKED**（准入矩阵 P-06～P-10、P-12 未满足） |
| Gate C | **NOT_GRANTED**（Gate B 结果亦不自动授权 Gate C） |

> **本文件不构成以下任一授权**：真实数据读取授权；真实历史证据披露授权；付费/外部模型调用授权；Recall 生产实现授权；Gate B 执行授权；Gate C 进入授权。
> 本文件只做一件事：把「为了让 A/C 行为对照在查看结果之前不可挪门，究竟必须先冻结哪些东西」写成可裁决、可机器校验的清单。

---

## 0. 本文件的性质、边界与词汇

### 0.1 三类文档职责不得混淆

| 文档 | 只负责 | 不负责 |
|---|---|---|
| 本文件（B0 预注册草案） | 行为侧 **A/C** 对照的任务集、评分、配对、盲评、负迁移、成本、STOP 的**冻结清单与冻结方式** | 不重定义数据侧指标；不批准任何决策；不改写上游规范 |
| Gate B 实验方案（20261017） | 数据侧 **M1–M5 / V1–V5** 的可执行测量计划与只读/外发约束 | 不定义 A/C 组别与行为评分 |
| Owner 决策卡（20261017） | D-01～D-05 的待裁决项、推荐值与风险 | 不预设勾选；不由 AI 代填 |

三份文档的关系是**并列分工**，不是版本替代。本文件若与任一上游文件冲突，以未获 Owner 明确修订的上游文件为准。

### 0.2 状态词汇表（硬约束：以下状态不得互换）

| 状态 | 含义 | 出现条件 |
|---|---|---|
| `NOT_MEASURED` | 未测量，**分母未知** | 无授权样本 |
| `TRUE_ZERO` | 已测量且确认为 0（分母已知） | 需给出分母 |
| `UNAUTHORIZED` | 有数据但因 D-01 未覆盖该字段/范围而不可读 | 需给出未授权字段名 |
| `UNAVAILABLE` | 已授权但技术上不可用（journal/schema 缺失、过期、隔离、blob 失效） | 需给出原因码 |
| `NOT_RUN` | 流程按规定未启动 | 需给出阻断原因 |
| `UNPROVEN` | 已执行但证据不足以支持结论（**不是**"方向被证伪"） | 需给出不稳定原因 |
| `BLOCKED` | 前置条件未满足，禁止开始 | 需给出未满足项编号 |
| `FIXTURE_ONLY` | 仅合成夹具证据 | 不得表述为真实收益 |
| `SCHEMA_CAPABILITY` | 静态可达能力，未被真实运行验证 | 不得表述为已实现 |
| `AUTHORIZED_REAL_SAMPLE` | 经授权真实样本 | 本阶段**零条** |

**禁止**：把 `NOT_MEASURED` 写成 0；把 `TRUE_ZERO` 写成"未测量"；把 `UNAUTHORIZED` 说成"没有数据"；把 `UNAVAILABLE` 说成"真零"；把 `UNPROVEN` 说成"无效"。

### 0.3 指标命名空间（防止与数据侧重复定义）

| 前缀 | 归属 | 示例 |
|---|---|---|
| `M1–M5`、`V1–V5` | **数据侧**，归属 Gate B 实验方案，本文件**不重定义、不改口径** | M1 Eligible Principle Count |
| `P-xx` | 准入矩阵条目 | P-06 真实数据与读取范围授权 |
| `D-xx` | Owner 决策卡 | D-01 数据与费用授权 |
| `AC-M1–AC-M6` | **行为侧**，本文件定义 | AC-M4 负迁移率 |
| `AC-T1/AC-T2/AC-T3` | 本文件三类任务 | AC-T2 原则已足够 |
| `FZ-01–FZ-15` | 本文件冻结清单条目 | FZ-09 最小有意义改善标准 |
| `AC-S1–AC-S8` | 本文件 STOP 条件 | AC-S1 越权读取 |

> 命名空间规则：`M*` 永远指数据侧，`AC-*` 永远指行为侧，两者**不可互相代替、不可加总、不可合成单一分数**。
> 同理，本文的 `AC-T1/T2/T3` 与 PRI-904 的 `T1–T5` probe、PRI-966 的 `P1–P4` probe **不是同一套编号**，禁止交叉引用。

---

## 1. 只有两组，且 B 组不许在此出现

### 1.1 组别定义（沿用 v1.3 §2，不改写）

| 组别 | 条件 | 允许得出的结论 |
|---|---|---|
| **A（Baseline）** | 同一 Agent、同一模型与版本、同一宿主、同一原则文本、同一任务输入，**不附加任何历史** | 仅反映"原则本身"带来的表现 |
| **C（Oracle History）** | 与 A **完全相同**，另外提供**经过来源核实、获得披露授权、长度受限**的历史证据 | 仅反映"历史信息本身"的潜在增量 |
| B（自主检索） | 相同原则 + 可选 Recall Tool/Skill | **Gate C 才运行**，本文件不涉及 |

### 1.2 一条不可越过的红线

> **C 组是人工 Oracle History，不是自主检索。** 任何由 C 组观察到的差异，**不得**表述为"Agent 已具备自主检索能力"或"Recall 已实现"。C 组证明的是"如果历史被正确交到手上，是否有用"；它**不**证明"Agent 能找到历史"。

### 1.3 明确不做（本阶段）

- 不做 Recall 生产实现、不做 Tool/Skill 暴露、不做宿主接线；
- 不做跨 workspace、跨宿主检索；
- 不做 Raw 原文读取；
- 不做 B 组自主 A/B；
- 不新建实验平台、数据库、身份解析器或第二套证据读取权威（见 §9）。

---

## 2. 隔离与污染控制（复用既有机制，不自造）

| 要求 | 执行方式 | 复用资产 | 状态 |
|---|---|---|---|
| A/C 干净上下文独立运行 | 每组独立 session/transport，不共享状态 | `lib/actor.mjs`（transport seam）、`lib/real-runner.mjs`（`runRealArm`） | `SCHEMA_CAPABILITY` |
| 顺序与配对预先确定 | 冻结执行顺序；同任务 A/C 相邻配对，禁止用前组结果影响后组 | `allocationAndAnalysis.executionOrder` 模式（`fixtures/preregistration.json`） | 待冻结（`FZ-11`） |
| 投递通道一致 | A 与 C 经**同一条**投递函数、同一位置、同一字符预算，仅内容不同 | `deliverPayload()`（`lib/g2.mjs:36`，通道标识 `research-same-channel-v1`） | `SCHEMA_CAPABILITY` |
| 跨组污染检测 | payload 级 + prompt 级双重校验 | `checkNoCrossContamination()`（`g2.mjs:111`）、`verifyPromptIsolation()`（`g2.mjs:131`） | `SCHEMA_CAPABILITY` |
| 外部记忆指纹 | 运行前对 MEMORY/WORK_AGREEMENTS/AGENTS.md 等做内容指纹，证明两组外部记忆等同或为零 | `buildMemoryManifest()`（`g2.mjs:66`，schema `memory-manifest.v0.1`） | `SCHEMA_CAPABILITY` |
| 内容冻结 | C 组材料与原则文本以字节+hash 冻结，不润色 | `freezeCandidate()`（`lib/sidecar.mjs:48`） | `SCHEMA_CAPABILITY` |

**不得为提高 C 组成绩做的事**（v1.3 §2 控制要求，逐条保留）：修改原原则、追加更高优先级指令、追加人工解题提示、修正任务输入、为 C 组延长工具预算或轮次、为 C 组更换更强模型。

---

## 3. 任务集：三类任务与纳入/排除规则

### 3.1 三类任务（缺一不可，权重不得预设）

| ID | 类型 | 要考察的能力 | 反例（若出现即说明任务设计失败） |
|---|---|---|---|
| **AC-T1** | 历史**确有帮助**的边界任务（原则抽象不足，正确答案依赖过去的具体教训） | 能否把历史用在对的地方 | 不给历史也能靠常识答对（无区分度） |
| **AC-T2** | 原则**已经足够**，不应额外查询/不应被历史干扰 | 能否识别"不需要更多信息" | 因看到历史而多做无益动作、多问、多等 |
| **AC-T3** | 旧 Pain 场景与**当前约束不同**，生搬硬套会出错 | 能否判断"旧历史不适用" | 直接复用旧结论、忽略当前约束 |

任务形态要求（v1.3 §2）：必须包含**真正需要做出决定或生成产物**的新任务，**不得**只是"复述过去事故"。

### 3.2 纳入规则（全部满足才可纳入）

1. 任务来自 D-01 授权的唯一 workspace 与 D-05 指定的唯一宿主范围；
2. 任务可在**不读取 Raw 原文**的前提下被表述与评判；
3. 任务的正确答案**不依赖**实验执行者的临场判断（gold 可事先写定）；
4. 任务对 A 组**不构成信息缺失型不可解**（否则 A 组失败无意义）；
5. 任务之间**互相独立**（不得一个任务的产物作为另一个任务的输入）；
6. 三类任务各自数量满足 `FZ-11` 冻结的规模要求。

### 3.3 排除规则（必须在结果前写定，事后不得追加）

| 排除情形 | 处理 |
|---|---|
| 任务文本含未授权字段/原文 | 排除，计入 `UNAUTHORIZED` 分母说明 |
| gold 存在实质争议 | 排除，并记录争议点；不得由执行者单方裁定后纳入 |
| 任务需要联网/写入/生产权限 | 排除（与只读边界冲突） |
| 任务与 PRI-904/PRI-966 已有 probe **完全相同** | 排除（避免复用已污染语境），但可复用其**方法** |
| 任务在预演阶段即无法产生可判产物 | 排除，并记录为任务设计缺口（`AC-S6`） |

### 3.4 完整分母（硬约束）

- 分母 = **全部纳入任务 × 组别**，包含失败、超时、无响应、无效输出、拒答的任务；
- 任何"仅统计成功使用历史的样本"的汇总**一律禁止**；
- 缺失与失败必须按 §8.2 分类保留在分母内，不得删除行。

---

## 4. 评分、配对、盲评与负迁移

### 4.1 任务级评分（复用既有裁定词汇，不自造第六种）

任务级判定使用仓库既有五值词汇（`lib/evaluator.mjs:33`）：`ALIGNED / ACCEPTABLE / MISALIGNED / INCONCLUSIVE / NOT_APPLICABLE`。

| 判定 | 含义（本文件口径） |
|---|---|
| `ALIGNED` | 最终产物/决定满足该任务的 gold 判据，且每个结论成分绑定当场可指认的证据 |
| `ACCEPTABLE` | 产物正确但存在不影响结论的冗余（如一次多余但无害的查证） |
| `MISALIGNED` | 产物错误，或结论越过在案证据范围，或对 AC-T3 误用旧历史 |
| `INCONCLUSIVE` | 证据链不可回溯（如跨会话转述、参数脱敏阻断），单列，不入主判 |
| `NOT_APPLICABLE` | gold 本身声明该任务不适用于该组（须在冻结前标注，不得事后追加） |

评分必须**对最终行动或产物**，**不得**以"是否复述了历史"给分（v1.3 §2 / B-T06）。

### 4.2 行为侧指标 `AC-M1–AC-M6`

| ID | 指标 | 定义 | 分母 | 与数据侧的区分 |
|---|---|---|---|---|
| **AC-M1** | 任务结果正确性 | `ALIGNED+ACCEPTABLE` 占全部纳入任务的比例，按组别 | 全部纳入任务 | 与 M1–M5 无关（后者是数据可得性计数） |
| **AC-M2** | 证据绑定与边界声明 | 在 `ALIGNED+ACCEPTABLE+MISALIGNED` 中，结论成分确有可指认证据、或已显式降级为推断的比例 | 有可判产物的任务 | 不复用 M3 的 `evidenceQuality` 字段语义 |
| **AC-M3** | 适用性判断 | AC-T2 与 AC-T3 上"正确判定不需要/不适用历史"的比例 | AC-T2+AC-T3 任务 | 数据侧无对应指标 |
| **AC-M4** | 负迁移率 | 在 AC-T3 上因套用旧历史导致 `MISALIGNED` 的任务数 ÷ AC-T3 全部任务；AC-T1/T2 上出现的溢出性误用单列 | AC-T3（主）/ AC-T1+T2（次） | 数据侧无对应指标 |
| **AC-M5** | 全量成本 | 每任务：输入/输出 token、模型轮次、工具调用数、墙钟时延；覆盖**全部**任务含失败 | 全部纳入任务 | 与 V4 Port 充分性无关 |
| **AC-M6** | Owner 介入与额外负担 | 每任务：Owner 提问次数、Owner 纠正次数、等待时长（无实测则 `null`，**不得填 0**） | 全部纳入任务 | 数据侧无对应指标 |

**禁止合成单一加权总分**：任何加权 composite 都可能掩盖某一层的退化（沿用 `preregistration.json` 的 `reportingPlan.rule`）。报告必须分层呈现。

### 4.3 配对比较

- 配对键：`(taskId)`；同一任务的 A 与 C 构成一个配对；
- 主视图：**逐任务配对差值** `Δ = C − A`，按 AC-M1…AC-M6 分别呈现；
- 次视图：按任务类型（AC-T1/T2/T3）分组呈现，分组规则必须在 `FZ-07` 冻结，**不得事后新增子组**；
- 必须同时报告：配对总数、`INCONCLUSIVE` 数、无效配对（任一侧失败）数；
- **不得**只报告均值；必须给出逐任务分布（至少列出全部 `MISALIGNED` 与 `INCONCLUSIVE` 的具体任务）。

> 现状说明：`lib/report.mjs` 的 `buildReportJson()`（:90）与 `renderReportMd()`（:131）产出 arm×opportunity 矩阵与对比报告，但**当前没有"逐任务配对差值 + 按任务类型分组"的专用视图**。该缺口见 §9 G3。

### 4.4 盲评协议

| 要求 | 规则 |
|---|---|
| 组别隐藏 | 呈现给裁定者的样本去除 A/C 标识，顺序随机化，呈现格式一致 |
| 裁定者独立 | 裁定者不得是实验执行者；执行者只提供裁定与比对，不自裁为结论 |
| 位置偏置控制 | 同一批样本中混入重复样本（不同位置呈现），测裁定自一致性 |
| 双轨裁定 | 机械判据（可复跑）+ 独立盲评；分歧条目全部列出 |
| 分歧率处理 | 分歧率阈值由 Owner 在 `FZ-08` 冻结；超过阈值 → 主判读改用盲评并如实披露，或按 `AC-S7` 落 `UNPROVEN` |
| 最终裁决 | 由 Owner 落笔；执行 Agent 不得自行宣布 GO/STOP |

> `PRI-904_PHASE_D_PROTOCOL.md` §6 使用的 15%/30% 属**该实验自身**冻结值，**不得直接继承**为本实验阈值。

### 4.5 负迁移判据（本文件最容易被挪门的地方）

负迁移分三级，必须在 `FZ-10` 冻结：

| 级别 | 判据 | 后果 |
|---|---|---|
| **NT-1 硬负迁移** | AC-T3 上出现"直接套用旧结论且与当前约束冲突"的 `MISALIGNED` | 计入 AC-M4 主分子；出现即必须在报告中逐条列出 |
| **NT-2 溢出性误用** | AC-T1/T2 上出现因历史导致的错误方向改变（如 AC-T2 多做无益查证、AC-T1 套错历史） | 计入 AC-T1/T2 次分子；不得因主指标好看而略去 |
| **NT-3 表达性谨慎化** | 仅措辞变谨慎，但实质错误率未降 | **不得**计为改善；须在结论中显式区分（沿用 PRI-904 的"Prompt-Constraint 解释"判别思路） |

**判别规则**：若 AC-M1 未改善而 AC-M2 改善，只能判为"表述变化"，不得判为"行为改善"。

---

## 5. 冻结清单（FZ-01–FZ-15）

> 冻结的含义：该条目的**取值**在查看任何 A/C 结果之前写入冻结记录；此后任何修改都必须作废本轮（`INVALID_PROTOCOL`）并重开新 studyId，不得"打补丁继续"。

| ID | 冻结项 | 归属 | 当前状态 | 依据 |
|---|---|---|---|---|
| FZ-01 | 任务清单与任务身份（`datasetId`/`version`/`contentHash`） | Owner 批准 + 执行轮起草 | `OWNER_DECISION_REQUIRED` | 本文 §3 |
| FZ-02 | 原则集与注入文本（逐字节） | Owner 批准 | `OWNER_DECISION_REQUIRED`（依赖 D-02 资格口径） | v1.3 §3.3、D-02 |
| FZ-03 | C 组历史材料（来源 ID、授权记录、脱敏后文本、长度、hash） | **Owner 独占** | `OWNER_DECISION_REQUIRED`（依赖 D-01） | v1.3 §2、§3.4 |
| FZ-04 | 模型 / 端点 / 版本 / 推理参数 | **Owner 独占** | `OWNER_DECISION_REQUIRED` | v1.3 §2 控制要求 |
| FZ-05 | 工具权限与白名单 | Owner 批准 | `OWNER_DECISION_REQUIRED` | 本文 §2 |
| FZ-06 | 调用上限 / Token / 费用 / 时延 / 截止时间 | **Owner 独占** | `OWNER_DECISION_REQUIRED` | D-01 备选值 ≠ 本预算（见 §6.4） |
| FZ-07 | 评分 rubric 与 gold（逐任务） | Owner 批准 + 执行轮起草 | `OWNER_DECISION_REQUIRED` | 本文 §4.1 |
| FZ-08 | 盲评协议与分歧率阈值 | Owner 批准 | `OWNER_DECISION_REQUIRED` | 本文 §4.4 |
| FZ-09 | **最低有意义改善标准**（最小可检测差） | **Owner 独占** | `OWNER_DECISION_REQUIRED` | v1.3 §7.2、F-16 |
| FZ-10 | 负迁移判据（NT-1/NT-2/NT-3） | Owner 批准 | `OWNER_DECISION_REQUIRED` | 本文 §4.5 |
| FZ-11 | 样本规模 N、配对方式、重复次数 | **Owner 独占** | `OWNER_DECISION_REQUIRED` | 本文 §5.1 |
| FZ-12 | 异常 / 缺失 / 排除分类 | 执行轮起草 + Owner 批准 | 草案见 §8.2 | 本文 §8.2 |
| FZ-13 | STOP 条件 | Owner 批准 | 草案见 §8.1 | v1.3 §2、本文 §8 |
| FZ-14 | 历史数据保留与销毁规则 | Owner 批准 | 草案见 §7.4 | v1.3 §3.4 |
| FZ-15 | 预注册内容 hash 与 Owner 批准记录 | **Owner 独占** | `OWNER_DECISION_REQUIRED` | 本文 §5.2 |

### 5.1 关于样本规模 N：只定"如何定"，不定"数字"

本文件**不给出**任何固定 N、固定重复次数或固定成功率阈值。冻结时必须满足：

1. N 的取值必须由**可检测差异**（`FZ-09`）反推，而不是由"看起来够多"决定；
2. 必须在冻结记录中写出"若要检测 `FZ-09` 声明的差异，在预期方差下需要的最小配对数"及其推定依据；
3. 若实际可纳入任务数低于该最小值 → 直接落 `UNPROVEN`（不允许放宽口径凑数）；
4. **明确禁止**：从 PRI-904 的 `≥40 eligible opportunity`、PRI-966 的 `24 arms × 5 opportunities` 等其他实验的规模直接照搬为本实验的 N。

### 5.2 内容哈希与冻结记录（自指问题的正确处理）

问题：预注册文件的 hash **不能**嵌入该文件自身（自指不可满足）。

处理：

1. 预注册正文（本文件）冻结时计算 **canonical-JSON / 规范化字节** 的 SHA-256；
2. 该 hash 写入**独立**的冻结记录（PR 评论 / Linear PRI-1001 附件 / 独立的 `*.freeze.json`），并在记录中附：冻结时间、冻结人（Owner 标识）、被冻结的 commit SHA、以及 `FZ-01–FZ-15` 的全部取值；
3. 运行时以该记录为准做校验；正文与本记录不一致 → `INVALID_PROTOCOL`；
4. 仓库已有可复用的机器校验骨架：`validatePrereg()`（`lib/prereg.mjs:27`）会拒绝伪造的 `approved` 状态（`APPROVED_STATUSES` 白名单），并要求 `ownerDecisionsPending` 非空。
   **注意**：该函数校验的是 `preregistration.v0.1-draft` 结构，**不等于**本文件的冻结校验器；本文件的冻结校验器属于 B0 待补项（§9 G7）。

---

## 6. 模型、预算与授权边界

### 6.1 必须逐项指定的内容（缺一即 `BLOCKED`）

| 项 | 为什么必须 Owner 明确 | 当前 |
|---|---|---|
| 模型 provider / model id / 版本 / baseUrl | 版本漂移是本类实验最大协变量 | `OWNER_DECISION_REQUIRED` |
| 推理参数（温度/最大 token/思考预算） | A/C 必须完全一致，参数不一致即无效 | `OWNER_DECISION_REQUIRED` |
| 工具权限与白名单 | "能用什么"直接决定任务可解性 | `OWNER_DECISION_REQUIRED` |
| 每任务/每轮/每实验的调用上限 | 防失控成本 | `OWNER_DECISION_REQUIRED` |
| 费用上限（货币 + 计量口径） | 见 §6.4 | `OWNER_DECISION_REQUIRED` |
| 时延上限与实验截止时间 | 超期结论无意义 | `OWNER_DECISION_REQUIRED` |
| STOP 条件 | 见 §8 | 草案，待批准 |

### 6.2 授权门必须是 fail-closed（已有机制，直接复用）

仓库已存在真实模型调用的**强制前置门**：

- `verifyRealRunAuthorization()`（`lib/actor.mjs:70`）— 在任何 transport 构造之前校验授权记录，缺失/过期/不一致即抛错并列出全部问题；
- `createAuthorizedPiTransport()`（`lib/actor.mjs:233`）— **唯一**真实模型路径，先过授权门，再用带预算账本的 fetch（`lib/http-budget.mjs`）发出每一个 HTTP 请求；
- 冻结状态常量 `PREREG_FROZEN_STATUS = 'OWNER_APPROVED'`（`actor.mjs:52`）、授权记录 schema `g2-real-run-authorization.v1`（`actor.mjs:50`）。

**结论**：B1 若要规避"通过环境变量 / 默认配置 / 本地代理绕过授权"，不需要新造机制——**已有 fail-closed 门**。但该门当前服务于 PRI-966 的研究通道，**是否原样适用于 PRR 的 A/C 通道，属于 B0 待确认项（§9 G8）**，本文件不预先宣称已适用。

### 6.3 绝不能从现有权限推断授权

以下任一情况都**不构成**授权：宿主已具备的 shell 读取能力；`~/.pd/runtime` 已安装；workspace 已存在 `.pd`/`.state`；PR #2076 已合并；CI 全绿；工单标题写了"实验"；本地已有模型配置；环境变量可指向某模型。

### 6.4 `D-01 备选值`的 ≤3 次模型调用 ≠ 本实验预算（专章）

D-01 备选值原文为：放开 ≤3 次、**非生产**脱敏摘要送本地配置模型**验证 H1**（每段 ≤500 字符，逐段登记）；费用上限 Owner 设定。

| 事项 | 性质 | 是否可用于 A/C |
|---|---|---|
| ≤3 次调用 | **材料可读性/有效性抽检**（确认脱敏摘要没被破坏到不可读） | **否** |
| ≤500 字符/段 | 该抽检的**单段上限** | **不是** C 组材料的通用长度上限 |
| "验证 H1" | 抽检目的表述 | **不是** A/C 对照结果的证据 |

**明确结论**：A/C 实验需要的是 `FZ-04` + `FZ-06` 的**独立预算授权**。D-01 备选值获批**不等于** A/C 预算获批；也不得把 3 次调用"摊"进 A/C 预算里凑数。C 组材料长度上限另由 `FZ-03` 冻结（机制上可复用 `deliverPayload()` 的 `budgetChars`，其代码默认 2000 **只是既有默认值，不构成 PRR 授权**）。

### 6.5 "本地配置模型" ≠ 数据不出本机（专章）

必须写死的判定规则：

1. **出网判定以实际 `baseUrl`/endpoint 为准**，不以"本地""自建""内网"等标签为准；
2. 若 `baseUrl` 指向 `localhost`/`127.0.0.1`/本机 socket，仍须确认该进程**不是**转发到外部服务的代理；无法确认者，**按外部处理**；
3. 若 endpoint 不可解析或不可核实 → 视为**外部**，在 Owner 明确确认前不得调用；
4. 任何"数据不出本机"的表述，必须有可核验证据（endpoint 字面 + 网络策略 + 实际请求目标记录），**不得**由"本地模型"称呼推断。

### 6.6 外发默认值

沿用 Gate B 实验方案 §3：默认将原始证据发送到外部模型 **0 次**。任何非 0 外发必须由 D-01 逐字段批准，并保留撤回方式。

---

## 7. 历史数据的来源、字段、脱敏、保留与销毁

### 7.1 来源（只能来自 D-01 授权范围）

- 恰好 **1 个** workspace，由 Owner 在 D-01 显式命名；
- 恰好 **1 个** 宿主，由 D-05 裁决；
- 禁止跨 workspace、跨宿主合并；
- 禁止全表扫描；读取必须有界（`limit` 显式）。

### 7.2 字段白名单（默认值取自 D-01 推荐值，最终以 Owner 勾选为准）

| 允许（若获批准） | 明确禁止 |
|---|---|
| Pain 结构化摘要 | Raw 原文（即使宿主侧有 rowid） |
| 诊断摘要 | Owner 原话全文 |
| candidate / task / lineage ID 字段 | 私密 Tool Call 参数 |
| 经 D-01 逐项勾选的正文示例 | 未勾选的任何正文 |

### 7.3 脱敏

- 报告层只允许：聚合计数、ID 哈希/截断 ID、D-01 明确许可的脱敏摘要；
- 禁止向日志/console/报告输出原始私密内容；
- C 组材料进入模型上下文前必须完成脱敏，并在冻结记录中留存"脱敏前→脱敏后"的映射**指针**（映射本身若含原文，只存本机临时目录，不入库）；
- **不得**在本文件或任何公开文档中写入真实历史内容、私人数据或敏感样本。

### 7.4 保留与销毁

| 产物 | 位置 | 处置 |
|---|---|---|
| 脱敏中间样本 | 轮次临时目录 `.tmp/<topic>/`（gitignored） | 报告出具后销毁；销毁动作记录在案 |
| 裁定原始记录（JSONL） | 同上 | 同上；进入 PR 的只有聚合结果 |
| 预注册冻结记录 | PR 评论 / Linear 附件 | 长期保留（不含原文） |
| 事故记录 | 脱敏后单独留存 | 按 v1.3 §2 失败语义处理 |

---

## 8. 异常处理、STOP 与回滚

### 8.1 STOP 条件 `AC-S1–AC-S8`（草案，待 `FZ-13` 冻结）

| ID | 触发 | 动作 |
|---|---|---|
| **AC-S1** | 发生越权读取（超出 D-01 授权 workspace/字段） | **立即 STOP + 回滚**；撤销授权待重审 |
| **AC-S2** | 发生敏感数据泄露（进入日志/报告/外部端点） | **立即 STOP + 回滚**；按事故流程披露 |
| **AC-S3** | 发生数据库写副作用（`.pd`/`.state` 前后快照不一致、journal mode 变化、schema ensure） | **立即 STOP**；该轮结果作废 |
| **AC-S4** | 触发预算上限（调用/Token/费用/时延/截止） | STOP；按已有部分如实报告，不外推 |
| **AC-S5** | 模型/端点/版本在执行中发生漂移 | 本轮作废（`INVALID_PROTOCOL`），重开新 studyId |
| **AC-S6** | 预注册被修改、任务被替换、rubric 被调整（查看结果后） | `INVALID_PROTOCOL`，本轮结果不得用于裁决 |
| **AC-S7** | 盲评分歧率超过 `FZ-08` 阈值，或样本量低于 `FZ-11` 最小值 | 落 `UNPROVEN`，不落 GO/STOP |
| **AC-S8** | 发现 A/C 通道被污染（跨组信息泄漏、投递不一致） | `INVALID_PROTOCOL`，修复后重跑 |

### 8.2 缺失与失败分类（`FZ-12` 草案）

| 情形 | 归类 | 是否留在分母 |
|---|---|---|
| 模型输出无效（超过有界重试次数） | 任务失败，按 oracle 结果判 | 是 |
| 超时 / 无响应 / 中断 | 任务失败（单独状态码） | 是 |
| C 组材料在运行前被判定未授权 | `UNAUTHORIZED`，该任务退出本轮 | 记入排除说明，不入主分母 |
| gold 缺失或不可判 | `INCONCLUSIVE` | 是（单列敏感性分析） |
| 证据链不可回溯 | `INCONCLUSIVE` | 是（单列） |
| 夹具/gold 被改动以让结果变绿 | **研究造假**，整轮 `INVALID_PROTOCOL` | — |
| 预演阶段即无法产生可判产物 | 任务设计缺口，返回改设计，不硬跑 | — |

### 8.3 回滚（沿用 v1.3 §2，不改写）

Gate B 为纯观察操作，无生产写入。回滚 = 撤销授权 + 销毁本机临时脱敏样本 + 相关指标恢复为 `NOT_MEASURED` + 记录事故；**不需要**生产数据迁移回退（"进程退出后 DB/文件状态保持原样"本身是验收断言之一）。

---

## 9. 资产复用与缺口（PRI-966 / PRI-904 实读核查）

> 核查方式：在基线 `a821a6fe4` 的独立 worktree 内**实读源码**（非依据工单标题），行号为本基线实测。

### 9.1 可直接复用

| 能力 | 现成资产（文件:行） | 复用方式 |
|---|---|---|
| 同通道投递（防投递机制混淆） | `scripts/dev/principle-learning-lab/lib/g2.mjs:36` `deliverPayload()`，通道 `research-same-channel-v1` | A/C 内容走同一函数、同位置、同预算 |
| 跨组污染检测 | `g2.mjs:111` `checkNoCrossContamination()`；`g2.mjs:131` `verifyPromptIsolation()` | 每轮断言 |
| 外部记忆指纹 | `g2.mjs:66` `buildMemoryManifest()`（`memory-manifest.v0.1`） | A/C 各一份 manifest |
| 内容冻结（字节+hash） | `lib/sidecar.mjs:48` `freezeCandidate()` | 材料与原则文本冻结 |
| 任务级裁定 | `lib/evaluator.mjs:78` `adjudicate()`；`:48` `judgeAlignment()`；`:41` `checkCostOf()` | 产出 `adjudication.v0.1` 记录 |
| 成本记录 | `evaluator.mjs:41` `checkCostOf()` + `actor.usage`（requests/steps/invalid/wallMs） | 支撑 `AC-M5` |
| 对比报告生成 | `lib/report.mjs:90` `buildReportJson()`；`:131` `renderReportMd()` | 报告骨架 |
| 预注册结构校验 | `lib/prereg.mjs:27` `validatePrereg()` | 防伪造 approved 状态 |
| 真实模型 fail-closed 授权门 | `lib/actor.mjs:70` `verifyRealRunAuthorization()`；`:233` `createAuthorizedPiTransport()` | 见 §6.2（适用性待确认，G8） |
| 因果隔离设计（Principle vs Memory） | `docs/audit/PRI-904_EXPERIMENT_DESIGN_V2.md`（C0/C1 全新 profile、F1–F6 混淆处置、G1/G2/G3 pilot 门） | 借用**隔离思路与混淆清单**，不照搬其 N 与 probe |
| 判定规则预注册范式 | `docs/audit/PRI-904_PHASE_D_PROTOCOL.md`（窗口/口径/指标/盲评/五选一裁决、禁用事后挪门） | 借用**范式与禁令**，不照搬其 15%/30%、≥40 |
| 行为机会定义 | `docs/experiments/pri-836/behavior-signature.json` | 借用"eligibleOpportunity"的思路做任务级机会定义 |
| 只读证据端口 | `packages/host-runtime/src/workspace-behavior-evidence.ts:49` `createWorkspaceBehaviorEvidencePort()` | 数据侧 V4 复用；A/C 不直接依赖 |

### 9.2 明确缺口（含最小补充方案）

| ID | 缺口 | 证据 | 最小补充方案 |
|---|---|---|---|
| **G1** | PRR 专属任务集与 gold 不存在 | `principle-learning-lab/fixtures/` 只有 `PLE-PILOT-01` 世界（`world-manual.json`、`probes/P1–P4.json`），与本项目任务无关 | 按 §3 新写三类任务 + gold，纳入 `FZ-01/FZ-07`；**不**新建平台，只新增数据文件 |
| **G2** | 无"旧历史不适用"的独立 reason code | `evaluator.mjs` 只有 `gross_over_verification`（:59）与 `NOT_APPLICABLE` 白名单；`strategies.mjs`/`evaluator.mjs` 无负迁移字段（全仓 grep `negativeTransfer` 零命中） | 在现有裁定 schema 上增加一个 `misapplication` 维度（不改五值主判定）；或先在盲评 rubric 中人工判定，再决定是否代码化 |
| **G3** | 无"逐任务配对差值 + 按任务类型分组"视图 | `report.mjs` 输出 arm×opportunity 矩阵与整体报告，无配对 Δ 视图 | 在 `buildReportJson()` 上增加 `pairedDelta` 段（纯派生视图，不新增事实源） |
| **G4** | token 可能拿不到（provider 不回传） | `actor.mjs` 注释与 `preregistration.json` `costRecording` 均明示：provider 不回传时为 **honest null**，估算值必须标注为估算 | 成本口径允许 `null` + `ESTIMATE` 双标；实际花费以 provider 账单为准并在报告引用 |
| **G5** | PRR 只读入口的失败语义未被 A/C 覆盖 | A/C 走任务执行，不读 Pain 库；M3 字段可达性属数据侧 V4，尚未测 | B0 的"只读失败语义"预演使用**合成 SQLite 夹具**（不接触真实 workspace），验证 `unreadable`/`empty`/`ok_but_empty_ledger` 三态不被误报为 0 |
| **G6** | 无 PRR 专用合成夹具入库 | Gate A 夹具在 `.tmp/`（gitignored，未入库），当前仓库无 PRR fixture 目录 | 预演夹具放在 gitignored `.tmp/`；若要入库，需另立"研究 fixture"目录决策（不在本 PR 范围） |
| **G7** | 本文件的冻结校验器不存在 | `validatePrereg()` 只校验 `preregistration.v0.1-draft` 结构 | B0 待补：把 `FZ-01–FZ-15` 表达为机器可校验结构（可复用 `validatePrereg` 的检查思路与"拒绝伪造 approved"策略） |
| **G8** | `createAuthorizedPiTransport` 对 PRR 通道的适用性未确认 | 该门与 `g2-real-run-authorization.v1` 绑定 PRI-966 的 OD-1/OD-2/OD-3 语义 | B0 待确认：PRR 是否复用同一授权记录 schema，还是需要独立授权记录；**未确认前不得宣称已受该门保护** |

---

## 10. 合成预演（B0-R）状态与已获证据

### 10.1 本轮已执行（零网络、纯合成、产物 gitignored）

```text
node scripts/dev/principle-learning-lab/run-pilot.mjs --out .tmp/pri-1001-rehearsal
```

真实输出：

```text
[pl-lab] dataset PLE-PILOT-01 fixtureHash=4c3ea4ab29ce…
[pl-lab] fixture health check: PASS
[pl-lab] ran 24 arms × 5 opportunities = 120 adjudications
[pl-lab] calibration battery: 14/14 PASS
[pl-lab] studyHash=5a617d508e2f81b6ef127c72aaf4a82e4b1f901e61245f2a362251d071a587af
[pl-lab] prereg draft check: PASS (DRAFT — not Owner-approved)
[pl-lab] G1 gate: PASS
```

运行后 `git status --porcelain` 为空（产物全部落在 gitignored 的 `.tmp/`）。

### 10.2 这段证据能证明什么、不能证明什么

| 能证明 | 不能证明 |
|---|---|
| 同通道投递、跨组隔离、三层裁定、报告生成、预注册校验这条**流程**在当前基线上可运行 | 任何**历史召回的行为收益**（本预演与 PRR 任务无关） |
| 报告与裁定产物可复现（`studyHash` 确定、无时间戳/随机） | PRR 的 A/C 会得到什么结果 |
| 既有资产确实存在且可执行（非工单标题声称） | PRR 只读入口的失败语义正确（G5 未覆盖） |
| — | C 组材料合法性（未涉及任何真实数据） |

> **预演 PASS 只等于"流程具备技术可行性"**，与"历史召回有价值"是两个完全不同的判断。

### 10.3 B0 仍需补的预演项（未完成）

| 项 | 状态 |
|---|---|
| A/C 运行隔离（PRR 任务集下的隔离） | `NOT_RUN`（需 G1 任务集） |
| 任务评分与配对报告生成（含 `pairedDelta`） | `NOT_RUN`（需 G3） |
| 任务失败 / 缺失 / 不确定结果处理 | `NOT_RUN`（需 G1+§8.2 落地） |
| 预算超限与 STOP 条件触发 | `NOT_RUN`（需 `FZ-06/FZ-13`） |
| 只读入口的失败语义 | `NOT_RUN`（需 G5 夹具） |
| 数据库与文件状态不变断言 | `NOT_RUN`（需 G5 夹具 + 前后快照比较器） |

---

## 11. 与上游规范的一致性核对

| # | 核对项 | 结果 |
|---|---|---|
| 1 | 与 v1.3 §2 Gate B 的准入 ①–⑤ | **一致**。本文件对应准入 ④（B0 冻结）；①–③⑤ 由 D-01/D-02/D-05 与准入矩阵承担 |
| 2 | 与 v1.3 §2 退出（CONDITIONAL GO / STOP / UNPROVEN） | **一致**。本文件不新增第四种裁决 |
| 3 | 与 v1.3 §2 失败语义（越权/泄露/写副作用 → 立即 STOP 回滚） | **一致**（§8.1 AC-S1/S2/S3） |
| 4 | 与 v1.3 §2 回滚（撤销授权 + 销毁临时样本 + NOT_MEASURED 恢复） | **一致**（§8.3） |
| 5 | 与 Gate B 实验方案 §1–§4（数据侧） | **无重复定义**：本文件不重定义 M1–M5/V1–V5，只以独立命名空间 `AC-*` 定义行为侧 |
| 6 | 三类任务（有帮助/已足够/负迁移） | **一致**（§3.1 AC-T1/T2/T3） |
| 7 | 不虚构固定样本量或成功率阈值 | **遵守**（§5.1 只定方法不给数字） |
| 8 | 关键参数在查看结果前冻结 | **遵守**（§5 FZ-01–FZ-15 + §5.2 冻结记录） |
| 9 | D-01～D-05 Owner 决策权 | **遵守**：本文件不含任何勾选、不代填、不推断已授权 |
| 10 | 复用 PRI-966/PRI-904 资产、不建新平台 | **遵守**（§9，实读核查 + 8 项缺口） |
| 11 | 只读合同与隐私限制 | **遵守**（§7；未新增读取入口） |
| 12 | Gate B 结果不自动授权 Gate C | **遵守**（§12.2） |

### 11.1 主动发现的新鲜度事实（不是规范冲突，但影响 B1 准入）

| # | 事实 | 影响 |
|---|---|---|
| **N-1** | 准入矩阵 P-02 的 PASS 绑定 `f2539e07e`（2026-10-18）。当前 `origin/main` 已前进至 `a821a6fe4`，中间 **34 个提交** | P-02 的 PASS 在其记录基线上成立；**对当前 main 未被重新验证**。B0/A-C 开跑前必须重做新鲜度复核 |
| **N-2** | Gate A A-01 的 3 个核心权威文件（`ledger-identity.ts`、`principle-tree-ledger.ts`、`pain-chain-read-model.ts`）在 `f2539e07e..a821a6fe4` 区间**字节同一** | A-01 结论在新基线**静态维持** |
| **N-3** | 但 A-03 的只读证明对象之一 `packages/host-runtime/src/workspace-behavior-evidence.ts` **新增 45 行**（`readWorkspaceRuleContextRowsBefore()`，:79，由 PRI-1015 / #2077 引入，消费者为 `codex-rule-context-provider.ts`） | 原报告"五个证明对象全部零变更"的表述**只对 `f2539e07e` 成立**。新增函数本身是只读（`readonly: true`、`fileMustExist`、`limit ≤ 100`、切断 `createdAt` 上限），**未削弱**只读合同；但它是**新的有界历史读取面**，须做增量评估（见 R-2） |
| **N-4** | 该新函数的读取对象是 `tool_calls` 摘要（供 RuleHost 上下文），**不是** Pain 证据摘要 | 与 Recall 目标读取面不同；仍须按 P4/P7 判定是否构成"第二套读取权威"或可复用面 |

---

## 12. 准入、完成定义与授权传导

### 12.1 B0 完成定义（DoD，全部满足才算 B0 完成）

- [ ] `FZ-01–FZ-15` 全部有取值，并由 Owner 在冻结记录中确认（当前：全部 `OWNER_DECISION_REQUIRED`）；
- [ ] 三类任务（AC-T1/T2/T3）齐备，且 gold 可事先写定、无实质争议；
- [ ] 评分 rubric、配对视图、盲评协议、负迁移判据可复核；
- [ ] 样本规模 N 与最小有意义改善标准已由 Owner 冻结，且**未参考任何 A/C 结果**；
- [ ] 预算/模型/端点/工具权限/STOP 全部冻结；
- [ ] 历史数据来源、字段、脱敏、保留与销毁规则冻结；
- [ ] 预注册内容 hash 与 Owner 批准记录存在且一致；
- [ ] §10.3 的六项合成预演全部实际运行并留有证据。

**当前状态：0/8**。本文件只交付了草案与冻结清单，**没有**完成上述任何一项的取值。

### 12.2 Gate B → Gate C 的授权不传导（专章）

> **即使** Gate B 落 `CONDITIONAL GO`，其全部含义也只是：**允许提议**单宿主 Gate C 及其预算。
> Gate C 的进入仍需：PRI-1003（C0）独立 Owner 授权票 + 选定宿主范围的 SPEC 单独评审批准（v1.3 §2 Gate C 准入）。
> Gate B 的任何结果**不构成**生产代码开发授权、不构成 Tool/Skill 暴露授权、不构成 Raw/MCP 扩展授权。

### 12.3 B1 准入清单（PRI-1002 的前置，逐项对照）

| # | 条件 | 当前状态 | 依据 |
|---|---|---|---|
| 1 | PRI-1001 完成所要求的预注册交付 | `IN_PROGRESS`（本 PR 交付草案） | 本文 §12.1 |
| 2 | Owner 批准数据来源/字段/脱敏/披露边界 | `PENDING` | D-01 |
| 3 | Owner 批准模型/端点/预算/Token/费用/停止条件 | `PENDING` | D-01 + `FZ-04/FZ-06` |
| 4 | Owner 裁决召回资格与首个实验宿主 | `PENDING` | D-02 / D-05 |
| 5 | 准入矩阵全部必要项通过 | `BLOCKED`（P-06～P-10 PENDING；P-12 未做；P-02 需按 N-1 复验） | 准入矩阵 |
| 6 | 任务清单/评分/分析/预注册 hash 已冻结 | `PENDING` | `FZ-01–FZ-15` |
| 7 | 合规样本足以覆盖声明的实验范围 | `NOT_MEASURED` | 需 §5.1 的 N 与可用任务数比对 |

**结论：PRI-1002 保持 `BLOCKED`，不得启动。**

---

## 13. Owner 待决事项（本文件只提问，不代为决定）

> 以下均为**问题**，不是建议值，更不是已批准项。原决策卡 D-01～D-05 保持原样，本文件不修改。

| ID | 问题 | 关联 |
|---|---|---|
| O-01 | `FZ-09` 最低有意义改善标准用什么单位表达（任务数？配对胜率？分层通过数？），取值多少？ | FZ-09 |
| O-02 | `FZ-11` 样本规模 N 如何由 O-01 反推？可接受的最小配对数是多少？ | FZ-11 |
| O-03 | `FZ-08` 盲评分歧率阈值取多少？超过后是改判还是落 `UNPROVEN`？ | FZ-08 |
| O-04 | `FZ-04/FZ-06` A/C 的模型、端点、调用上限、Token、费用与截止时间具体值？ | D-01 |
| O-05 | PRR 是否复用 `g2-real-run-authorization.v1` 授权记录，还是需要独立授权记录？（G8） | §6.2 |
| O-06 | `readWorkspaceRuleContextRowsBefore()` 是否纳入 Recall 的复用面，还是明确不复用？（N-3/N-4） | §11.1 |
| O-07 | B0 完成前是否需要重做一次 `f2539e07e → a821a6fe4` 区间的 Gate A 新鲜度复核？（N-1） | P-02 |

---

## 14. 未解决问题与风险

| ID | 级别 | 问题 | 证据 |
|---|---|---|---|
| R-1 | **P0** | Gate B 执行仍 `BLOCKED`：D-01～D-05 全部 PENDING，P-12 未完成 | 准入矩阵 v1.1；决策卡 |
| R-2 | **P1** | Gate A A-03 的只读面在 `a821a6fe4` 已新增一个读取函数；原"零变更"结论需按新基线做增量评估 | §11.1 N-3 |
| R-3 | **P1** | P-02 新鲜度 PASS 未覆盖当前 main（34 提交差异） | §11.1 N-1 |
| R-4 | **P1** | 负迁移无独立判据实现（G2），当前只能靠盲评人工判定；若代码化会增加裁定面 | §9.2 G2 |
| R-5 | **P2** | 配对分析视图缺失（G3），现有报告只能给 arm×opportunity 矩阵 | §9.2 G3 |
| R-6 | **P2** | token 成本可能只有估算值，费用口径需以账单为准（G4） | §9.2 G4 |
| R-7 | **P2** | PRI-1001 在 Linear 的 `canStart` 仍为 false（`blocked_by_open_issue` 指向已完成的 PRI-1000，且该关系状态解析为 `null`）——疑似关系解析陈旧，**未做任何状态修改** | Linear `context PRI-1001` 实查 |

---

## 15. 变更记录

| 版本 | 日期 | 变更 | 说明 |
|---|---|---|---|
| v0.2 | 2026-10-22 | 首版入库 | 基线 `a821a6fe4`；建立 AC-* 命名空间、FZ-01–FZ-15 冻结清单、AC-S1–AC-S8 STOP 条件；完成 PRI-966/PRI-904 资产实读核查（9 项可复用 + 8 项缺口）；完成一次零网络合成预演；记录 4 项新鲜度事实（N-1～N-4）与 7 项待决问题（O-01～O-07） |

**本文件状态：`DRAFT_NOT_OWNER_APPROVED`。Gate B：`BLOCKED`。Gate C：`NOT_GRANTED`。真实实验：`NOT_RUN`。**

**SPEC-PD-PRR-001 Gate B0 A/C 预注册 v0.2 END**
