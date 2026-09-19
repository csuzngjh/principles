# PRI-841 Formation Context Propagation Validation

> **报告类型**：只读实验 + 审计（Read-Only Experiment & Audit）
> **研究命题**：PR #1756 恢复 Formation Context 后，信息能否有效穿透 PD Pipeline 并最终改善 RuleCode 质量？
> **日期**：2026-09-18/19
> **纪律**：未修改生产代码 / 数据库 / artifact / feature flag / RuleHost / Owner authority / Approval flow；未创建第二套 pipeline；未创建 Linear 工单；未创建生产代码 PR。生产 `state.db` 全部访问为 `{ readonly: true, fileMustExist: true }`。

## Executive Summary

三臂配对实验（A = PR #1756 前完整代码路径；B = 仅 Scribe 恢复 formation context；C = 再加 Artificer 有界候选集 = 当前 main 行为）在**两个真实 Owner 标注包族**上运行；Artificer 生成走**真实生产 L2 write-test-fix 循环**（模型自主 validate/replay/submit，canonical sandbox gate），评价四层（原则盲评 / RuleCode 盲评 / Owner 案例沙箱回放 / token 成本），判官含**独立家族模型**（本地 Qwen3.8-27B）。

```text
PRI_841_RESULT = 3. ARTIFICER_EXPANSION_REQUIRED

核心发现（glm-5.3 生产模型地层，F1 族 4 个配对重复 + 双判官）：
  ① Scribe 质量提升复现：原则盲评 B 6胜1负 A（双判官方向一致，承接 PRI-838 的 +51.3pp）
  ② 但提升未转化为 RuleCode 评判质量：rule B vs A = B 2胜4负（同族判官 0-2 偏 A，独立判官 2-2）
  ③ Artificer 候选集扩张把它转化了回来：rule C vs B = C 5胜1负（同族 2-0 + 独立 3-1，方向一致）
  ④ 传播确实发生了，但形态是"效率"而非"评判质量"：
     A→B 使 Artificer L2 修复环轮次 −32%（7.75→5.25）、token −33%、延迟 −34%（4/4 重复方向一致）
  ⑤ 回放门天花板：三臂 11/11 全 PASS（fp=0 fn=0）——L2 循环把 Owner 案例迭代到过，
     生产历史锚点 15/16 PASS（1 例 fn），该层无法区分臂间质量
结论：PR #1756 的 Scribe 半边收益被 Artificer 的 candidates[0] 单值消费面吸收/截断；
     打开有界候选集（PRI-839，当前 main 已实装）才是 RuleCode 质量层面的传播路径。
强度披露：EXPLORATORY——formation 数=2、glm 地层完整三元组=3（+1 双臂部分），
     ZAI 配额中断（429 code 1310，2026-09-22 重置）截断了原计划 16 三元组；
     方向证据 = 双独立判官家族一致 + 机械成本指标一致 + 与 PRI-835 DC-3 诊断闭合。
```

---

## Research Question

PR #1753（Trinity Phase A）证明 formation evidence 提升 Scribe 输出（+85.7pp，EXPLORATORY）；PR #1756（PRI-838/839）把修复产品化（Scribe prompt v3→v4 + Artificer prompt v7→v8）。PRI-838 的配对验证测得 Scribe 层 +51.3pp，但其 **Artificer 半边未运行**（BLOCKED：生产不持久化 BehaviorExamplePack，替代即注入合成证据）。

本任务回答两个分离的问题：

1. **B vs A**：Scribe 的提升是否传递到 RuleCode（PR #1756 的净价值）？
2. **C vs B**：Artificer 消费有界候选集是否继续提升（未来优化价值）？

**本次实验解开了 PRI-839 的阻塞**：发现生产 57 个 artificer 工件全部为 v2 形状并**回显 Owner 标注包**（goldenTraceCases 的 `case-(negative|positive)-<toolCallId>` 子集 + `pain:N|tool_call:M` 形式 evidenceRefs）。配合仍在磁盘上的两次真实运行的原始标注文件，可以**只读恢复真实 BehaviorExamplePack**（恢复后过真 `validateBehaviorExamplePack`，且回显 case id 与标注文件 tool call id **交叉核对一致**）——不产生任何合成证据。

## Pipeline Before / After（Phase 1）

完整代码级管线图（file:line 证据）见 `D:/pd-labs/pri841/CURRENT_PIPELINE_MAP.md`。要点：

```text
BEFORE (89eb275e)                            AFTER (a07981c9, current main)
Dreamer ─▶ Philosopher ─▶ Scribe ─▶ Artificer   Dreamer ─▶ Philosopher ─▶ Scribe ─▶ Artificer
 (1–5 候选)  (thesis)    (仅philosopher)         (1–5 候选)   │formation context(v4)│候选集(v8)│
                        DC-1: 候选/诊断/痛感                          ▲                    ▲
                        全部结构性丢弃                              └────────┬────────────┘
                        DC-3: Artificer 只取 candidates[0]  ──────────────────┘
```

- **Scribe v3→v4**：payload 增加可选 `formationContext`（dreamerProposals 全候选 + sourceDiagnosis + provenance；分段 4000/3500、总硬帽 8000 字符，ERR-134 回归锁定）；缺证据时 prompt 回到 v3 形态（仅版本串变化）。
- **Artificer v7→v8**：`ArtificerDreamerContext` 由 candidates[0] 五维单值变为 `{candidates[](≤5 有界排序), differenceSummary, omittedCandidateCount}`；输出 schema 不变。
- **Artificer 供给现实（审计确认）**：consumer cycle 的 runnerOptions 不含 behaviorExamplePack → 自动链路 Artificer 任务 fail-loud（`behavior_example_pack_missing`，PRI-780 v2-only）；唯一供包路径是 CLI `pd internalization run-rulehost --behavior-examples`（Operator 提供 Owner 标注，宿主装配器运行时组装，不按链持久化）。生产仅有的两族带真实 Owner 标注的 artificer 运行正是经此路径产生。

## Experiment Design（Phase 2）

| | Scribe 输入 | Artificer dreamerContext | Artificer prompt | 代码树 |
|---|---|---|---|---|
| **Arm A**（历史基线） | 仅 philosopher artifact | candidates[0] 五维（v7 逻辑逐字段复刻） | v7 | git archive `89eb275e` 自建 dist |
| **Arm B**（PR #1756 验证） | + 真实 resolveFormationContext | candidates[0] 五维（**不变**） | v7（**不变**） | Scribe=head，Artificer=pre1756 |
| **Arm C**（候选集验证） | 同 B | 有界候选集 + differenceSummary（v8 构造逐字段复刻） | v8 | git archive `a07981c9` 自建 dist |

- **代码基线**：两棵 `git archive` 树在实验室目录各自 `tsc` 构建（node_modules junction 到主仓 node_modules，principles-core 零 `@principles/*` 依赖，无交叉泄漏）；主 checkout 未动（其 dist 为陈旧 v7 构建，不可信）。
- **配对**：同 formation、同模型、同配置（temperature 0 / maxTokens 49152 / reasoning high / budget 900s = 生产 config.yaml `pi-ai.glm` profile 实际值，**纠正了 PRI-838 报告中 16000 的旧口径**）。
- **保真度证明（MEASURED）**：Arm A Scribe 系统 prompt 哈希 = `a47db8f47552` —— 与 PRI-815 冻结基线及 PRI-838 实验逐字节一致；Arm B = `1203f5574457`（= PRI-838 worktree Arm B）。本 harness 独立复现了两代实验的 prompt。
- **Artificer 生成 = 生产路径**：预实验证明单发生模式回放 FAIL（fn=1，无修复环即非生产行为），故全部切换为真实 `ArtificerL2Adapter`（模型自主 validate_rulecode/replay_rulecode/submit_rulecode 的 write-test-fix agent loop），配置镜像生产 CLI 构造（canonical `createProductionGateDeps` + 真 `DefaultArtificerValidator` + budget 900s + profile maxTokens/reasoning 转发 + telemetry token 捕获）。
- **输出处理镜像生产**：Owner 案例机械回填（EP002-R4 `fetchAndParseOutput` 语义）→ 真验证器 → v2 输出契约（evidenceRefs 精确匹配 + 保护字段逐字，复刻 runner 私有函数）→ Owner 案例沙箱回放。
- **历史锚点**：两族 16 个真实历史 artificer 工件（生产修复环生成）用同一 gate 回放作为生产基线参照。

## Dataset（Phase 3）

**数据集 = 2 个真实 Owner 标注包族；glm 产地层 4 个配对重复（3 完整 + 1 双臂）；另有 1 个本地模型 scribe 配对点。**

| 族 | 痛 | 包主题 | Owner 标注原件 | 历史轮 | dreamer 候选 |
|---|---|---|---|---|---|
| F1-pain20-ep002r4 | pain:20 | 基线固化后才能改产物（EP002-R4） | `D:/pd-labs/ep002r4-behavior/behavior-examples.json` | 18 scribe / 14 artificer | 5 |
| F2-pain18-manual | pain:18 | 状态文件合并前须核对权威源 | `D:/pd-labs/ep002r3-bep.json` | 7 scribe / 2 artificer | 5 |

**N < 15（formation 层面）的原因（记录，非选择）**：生产 57 个 artificer 工件中仅 16 个带 `pain:N|tool_call:M` 形式的 Owner 标注 evidenceRefs 且标注文件仍在磁盘；其余 41 个是 pre-owner-label 旧契约的语义字符串引用（模型自创），使用它们即注入无效证据（任务明令禁止）。两族的 formation context 均以真实 resolver 解析成功（5 提案 + 诊断）。

**统计独立性披露**：16 个计划重复不等于 16 个独立 formation——族内重复共享同一 dreamer/philosopher/诊断输入，衡量"同一 formation 下的生成方差 + prompt 臂效应"。实际因配额中断只完成 glm 地层 4 重复（1 formation），外推须谨慎。

## Evaluation Metrics & Judges（Phase 4/5）

| Layer | 指标 | 判定者 | 偏差 |
|---|---|---|---|
| 1 原则质量 | 5 维盲评（B vs A） | glm-5.3（同族，披露）+ Qwen3.8-27B 本地（**独立家族**） | 种子化 X/Y 盲序，判官不可见臂身份 |
| 2 RuleCode 质量 | trigger/condition/action/exception/implementationQuality 盲评（B vs A、C vs B） | 同上双判官 | 同上 |
| 3 运行时 | Owner 案例沙箱回放 PASS/fp/fn；验证器；v2 契约 | **机械**（真 gate + 真验证器） | 零判官偏差 |
| 4 成本 | scribe token、L2 token/轮次/延迟 | API usage + telemetry | 机械 |

判官通道现实：GPT6 不可达；lmstudio 服务实际存活于 **12341** 端口（1234 为误判）——使 Qwen3.8-27B 成为可用的独立家族判官（且 glm 同族判官作为对照保留）。本地 27B **可做判官与 scribe 单发**，但**无法驱动 L2 生成循环**（900s 预算内每轮 7 分钟+，3 臂全部 `pd_budget_timeout`，实测 token 26-37K in/turn）。

## Arm A / Arm B / Arm C（结果）

### glm-5.3 产地层（F1，4 配对重复；r4 的 C 死于配额边界）

| 指标（均值） | Arm A | Arm B | Arm C |
|---|---|---|---|
| scribe 验证器通过 | 4/4 | 4/4 | （共享 B） |
| scribe tokens | 8,340 | 9,792（**+17.4%**） | 共享 B |
| artificer 验证器 + v2 契约 | 4/4 + 4/4 | 4/4 + 4/4 | 3/3 + 3/3 |
| L2 收敛轮次 | **7.75** | **5.25（−32%）** | **4.50（再 −14%）** |
| L2 总 token | **103,881** | **69,426（−33%）** | **97,906（vs B +41%）** |
| L2 延迟 | ~567s | ~380s（−34%） | ~550s（vs B +45%） |
| Owner 案例回放 | 4/4 PASS，fp0/fn0 | 4/4 PASS，fp0/fn0 | 3/3 PASS，fp0/fn0 |

配对轮次明细（A vs B）：7/5、10/5、9/6、5/5 —— **4/4 重复 A 需要更多修复轮次**；token 同向（4/4）。

### 判官汇总（首臂=关注臂；glm=同族判官，local=Qwen3.8-27B 独立判官）

| 比较 | glm 判官 | local 判官 | 合计 |
|---|---|---|---|
| Scribe **B vs A**（原则质量） | B 2–0 | B 3–1（F1）+ B 1–0（F2 本地层） | **B 6–1** |
| Rule **B vs A**（RuleCode 质量） | A 2–0 | 2–2 | **B 2–4 A** |
| Rule **C vs B**（RuleCode 质量） | C 2–0 | C 3–1 | **C 5–1** |

C vs B 独立判官逐维（F1 均值，C/B）：trigger 3.0/2.7 · condition 3.0/2.3 · action 3.0/2.7 · exception 2.8/2.3 · implementationQuality 3.0/2.7 —— C 全面占先。

### 历史锚点（生产真实工件，同 gate 回放）

16 个工件：**15 PASS / 1 FAIL（fn=1）**= 93.75%——生产基线本身并非满分；实验三臂 11/11 全 PASS 说明 L2 循环 + 修复环在 Owner 案例层面收敛良好（天花板效应，区分度为零）。

### 定性证据（上下文真实到达工件层）

Arm B 的 implementationSummary 直接内嵌 formation 证据中的中文原则短语（"认可即锚定，改动可对比验收，劣化即回退"）；Arm C 进一步展开 dreamer 的 anchor→小步→对比→回退 工作链语义。

## Results / B vs A Analysis

**问题 1：PR #1756 是否有效？**

**有效，但传播形态是"效率与上游质量"，不是"RuleCode 评判质量"：**

1. **原则层**（上游）：B 6–1 A，双判官一致 —— 独立复现 PRI-838 的 +51.3pp 方向。✅
2. **RuleCode 评判质量层**：B 2–4 A —— 无提升证据（同族判官两次都偏好 A 的规则）。❌
3. **运行时正确性层**：回放全对齐（4/4 vs 4/4，fp=fn=0）—— 无回归也无提升（天花板）。➖
4. **成本/效率层**：Artificer L2 轮次 −32%、token −33%、延迟 −34%（4/4 重复同向）—— **更好的原则让 Artificer 更快收敛**，净效应是 scribe +17.4% 换 artificer −33%：**链级净省**。✅

## C vs B Analysis

**问题 2：Artificer candidate expansion 是否值得？**

**值得 —— 它是缺失的质量传播环节：**

1. RuleCode 评判质量 C 5–1 B（双判官一致：glm 2–0、local 3–1；五维全面占先）。
2. 收敛轮次再降（5.25→4.50），但单轮更贵（候选集 prompt 变大）：token vs B +41%。**质量换 token 的显式权衡**。
3. C vs A（完整 PR #1756 栈 vs 历史基线）：轮次 −42%、token −6%、质量（经 B 中转 + C>B 直接）方向为正。
4. 该结论与 PRI-835 的 DC-3 诊断（"已有能力被人为收窄"）和 PRI-839 的 prompt 级实测（1.0→4.9 候选送达）闭合。

## Token Cost

见 Arm 表。质量增益/token 增量：

```text
B vs A：quality(rule) ±0 · scribe +1.45K tok · artificer −34.5K tok  → 净省（效率传播）
C vs B：quality(rule) ↑（5–1） · artificer +28.5K tok（+41%）      → 每 +1 质量胜局的显式代价
对照：PRI-838 scribe-call 口径 +59.9%（8000 帽）在本实验的生产 49152 帽下压缩为 +17.4%
```

## Runtime Impact

- 三臂生成规则全部通过 Owner 案例沙箱回放（11/11），无 forbidden pattern / return-shape 违规。
- 生产 RuleHost 零改动（本实验不触激活/RuleHost）。
- 回放门作为区分器已饱和：Owner 案例过少（3 例/包）且 L2 循环专门迭代它们；更细的运行时区分需要更长的 golden trace（见 Follow-ups）。

## Failure Cases（Phase 7 分类）

| 现象 | 分类 |
|---|---|
| 单发生 artificer 回放 FAIL（fn=1，预实验） | **C. Artificer 无法在无修复环下利用 context** —— 生产本有 L2 循环，实验必须走生产路径（已修正） |
| B 的 RuleCode 评判质量未随 Scribe 提升 | **B. Scribe 提升，但 Artificer[candidates[0]] 丢失/吸收** —— 单值消费面没有承载面去利用更丰富的原则 |
| C 打开后质量恢复传播 | 与 B 同因的反证：瓶颈确实在 Artificer 消费面，而非 evidence 本身 |
| ZAI 配额 429（code 1310）截断 16→4 重复 | 环境事件，非机制缺陷；两把 key 同账户共享配额（同重置时间） |
| 本地 27B 无法驱动 L2（budget timeout） | 环境限制（27B 工具循环过慢）；可作独立判官，不可作生成器 |
| F2 一次有效 glm 冒烟三元组被 harness 字段补齐前的 `rm -rf` 误删 | 实验操作损失（教训：先加字段后删数据的顺序反了）；已在方法上披露 |

**不是发现**：formation context 无效（A 类）—— 上游 6–1 与效率 −33% 排除之；Evaluator 无法反映质量（D 类）—— 本实验未触 evaluator 评分面（repair 循环是 L2 内部）。

## Recommendation

1. **保留并默认启用 PR #1756 的两半**（已合并于 main）：Scribe 侧改善上游质量并净省 Artificer 成本；Artificer 侧（候选集）是 RuleCode 质量传播的实际载体。无需回滚。
2. **候选集的 token 代价（+41%）是 Owner 可调策略**：`FORMATION_PROPOSALS_MAX_CHARS` / 候选数上限是显式旋钮（PRI-838 §7.1 遗留），如需收紧应基于本实验的质量-成本曲线而非默认值。
3. **Follow-up 候选（记录，未实施）**：
   - 配额重置后（2026-09-22）续跑 harness 至原计划 16 三元组（脚本可断点续跑：`runs/` 已有文件自动跳过）—— 把 EXPLORATORY 结论升格；
   - 更长 golden trace（>3 Owner 案例或引入 trajectory 回放案例）打破回放天花板，使 Layer 3 可区分；
   - PRI-835 DC-2（Philosopher 不落盘被否候选）与本实验 C 臂收益叠加的联合验证；
   - Evaluator 是否"看见" C 的质量优势（DC-4 修复的前置测量）。

## Final Verdict

```text
PRI_841_RESULT = 3. ARTIFICER_EXPANSION_REQUIRED

说明：主要瓶颈在 Artificer。
依据：Scribe 质量提升复现（B 6–1 A）但未转化为 RuleCode 评判质量（B 2–4 A）；
     Artificer 打开有界候选集后质量传播恢复（C 5–1 B，双独立判官家族一致）；
     A→B 的实际传播形态是效率（L2 轮次 −32% / token −33%，4/4 重复同向）。
强度：EXPLORATORY（2 formations，glm 地层 4 配对重复，配额截断）；
     方向由双判官 + 机械成本指标 + PRI-835/838/839 先行证据三角支撑。
```

---

# 附录 A — 证据资产

| 资产 | 路径 | 说明 |
|---|---|---|
| 双代码树 | `D:/pd-labs/pri841/head/`、`D:/pd-labs/pri841/pre1756/` | git archive a07981c9 / 89eb275e 自建 dist（主 checkout 未动） |
| 管线图 | `D:/pd-labs/pri841/CURRENT_PIPELINE_MAP.md` | Phase 1 交付（file:line 级） |
| 数据集 | `D:/pd-labs/pri841/dataset.json` + `extract-dataset.cjs` | 只读提取 + 包恢复 + 交叉核对 |
| 实验记录 | `D:/pd-labs/pri841/runs/` | F1 r1-r4（glm 地层）+ quota-dead/（配额死壳）+ historical-anchors.json |
| 盲评 | `D:/pd-labs/pri841/judged/`（glm）、`judged-b/`（Qwen 独立） | 种子化盲序原始记录，0 解析失败 |
| 聚合 | `D:/pd-labs/pri841/aggregate.json` + `aggregate.mjs` | 全指标 |
| 本地通道证据 | `runs/F2-local-scribe-rep-01.json` | 本地 27B scribe 可行 / L2 不可行（budget timeout 记录） |

# 附录 B — MEASURED vs ESTIMATED

| 指标 | 类别 |
|---|---|
| prompt 哈希（a47db8f47552 / 1203f5574457）、包恢复+交叉核对、历史锚点 15/16、三臂全部主表数字 | **MEASURED** |
| C vs A 的质量判断（经 B 中转的传递性推断） | **INFERRED**（未直接配对评判） |
| 链级净省的外推（scribe +17.4% vs artificer −33% 的合并口径） | **ESTIMATED**（两口径均为 scribe-call / artificer-loop 实测，合并为净效应是算术推导） |

# 附录 C — 纪律声明

```text
CODE_CHANGES        = NONE（主 checkout 唯一新增 = 本报告文件，未提交）
PRODUCTION_DB       = READ ONLY（readonly + fileMustExist）
SYNTHETIC_EVIDENCE  = NONE（包=真实回显+真实标注文件；案例载荷=真实生产数据）
AGENT_RUNS          = 仅离线 harness 调用（未触发生产 consumer/auto cycle）
CONFIG/FLAG/SCHEMA  = NONE
LINEAR              = NONE（按任务指令不建单）
PR                  = NONE
```
