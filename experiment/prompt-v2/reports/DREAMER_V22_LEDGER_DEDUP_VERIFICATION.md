# DREAMER_V22_LEDGER_DEDUP_VERIFICATION.md — Phase 1 Principle Ledger 去重能力验证（2026-11-15）

回答上轮审计遗留的 **U3**：现有 Ledger 能否拦截同一 Pain 多条候选链产生的近义 Principle？

**总判定：PARTIAL_SUPPORT。** 候选级幂等与高词法重叠重复的"检测"半场真实存在且本次实测有效；但注册写层零内容查重、语义判定半场依赖 LLM 评估且失败时按 Rule 4 降级为 CREATE——**生产 Ledger 中已存在门启用后注册成功的近逐字重复对**（2026-11-11 实证）。跨 Pain 近义检测与冲突检测 NOT_SUPPORTED。

方法：全部结论来自（a）最新源码 `161763546` 的真实调用路径阅读（附文件:行号）；（b）用真实生产代码在隔离副本上执行的注册演练（零代码修改、零模型 API、零生产写入）；（c）生产 Ledger 只读巡检。中间产物：`.tmp/prompt-v2-ab/next-task/ledger-drill/`（drill-texts.json / drill-shortlist-results.json / drill-intake-results.json / drill-production-pair.json + 4 个脚本）。

## 一、真实 Ledger 调用路径与九问答案

### 1.1 数据模型与写层

| 事实 | 证据 |
|---|---|
| Ledger = 单一 JSON 文件 `{stateDir}/principle_training_state.json`（生产 `workspaceDir/.state/`）；`tree.principles` 以 principle id（intake 时 `randomUUID()` 新铸）为键 | `packages/principles-core/src/principle-tree-ledger.ts:69,144-146`；`candidate-intake-service.ts:846-859` |
| **写层盲写**：`addPrincipleToLedger` 直接 `store.tree.principles[principle.id] = principle`，无任何文本/语义比对；同 ID 静默覆盖 | `principle-tree-ledger.ts:509-515` |
| 唯一性只存在于 **candidate 级**：`existsForCandidate` 扫描 `derivedFromPainIds.includes(candidateId)`（D-11 血缘匹配，非文本匹配）；重复 resolution 走 `findReuseResolutionForCandidate` 幂等回放 | `candidate-intake-service.ts:477-511`；`adapter/principle-tree-ledger-adapter.ts:154-177,202-217` |
| Rule/Implementation 有 **ID 级**唯一性（createRule 对同 ID fail-loud），但这是 rule 树不是 principle 查重 | `principle-tree-ledger.ts:702-721,723-738` |

### 1.2 注册入口（生产自动路径）

`pd diagnose run` / `pd pain-retry` / PainSignalBridge 自动内化在诊断完成后对每个 candidate 调 `CandidateIntakeService.intake()`（`pd-cli/src/commands/diagnose.ts:654-762`；人工路径 `pd candidate intake` 经 `pd-cli/src/services/reuse-gated-intake.ts` 组装同一服务）。intake 流程（`candidate-intake-service.ts:450-884`）：

```
1 输入校验 → 2 existsForCandidate 幂等 → 2b reuse 回放
→ 3 读 candidate → 3b kind 门（fail-closed：仅 'principle' 可写 Ledger，
   recommendation-kind-resolver.ts:29-30,63-65；rule/prompt/implementation/defer 一律拒绝）
→ 4a Diagnostician V2 血缘验证（strict kinds={diagnostician,diag_router}）
→ 4d 复用门（见 1.3） → 5 铸新 UUID+status='probation' 11 字段条目
→ 6 writeProbationEntry → addPrincipleToLedger（盲写，adapter 实际落库 status='candidate'，
   adapter:36-62,143-152）
```

注：内化链（Dreamer→Philosopher→Scribe）**不写 Ledger**——链产物只是工件；Owner 批准后 `activatePrinciple` 仅把既有条目 status 翻成 active（`ApprovalsConsoleModel.ts:778-823` 经候选血缘解析 principleId）。因此 Ledger 里的重复风险恰好落在"recommendation → intake"这一层。

### 1.3 复用门（唯一的内容级查重机制）

- 配置：`reuseEvaluation.enabled` 默认 **true**（`pd-config-defaults.ts:121-123`），生产 config.yaml 无覆盖节 → 生产自动路径门已启用；hook 工厂 `pain-signal-runtime-factory.ts:459-525`。
- 检索半场（确定性，纯函数）：`reuse-shortlist.ts` —— 中文 CJK 字符 bigram + 拉丁词元、停用词表、字段对加权覆盖评分（text×3/action×3/trigger×2/交叉×1），topK=3、minScore=0.15；**明确声明非语义**（"no embedding, no vector store, no semantic search"，`reuse-shortlist.ts:8-12`）。
- 判定半场（LLM）：`ReuseEvaluationRunner`（proposal-only、fail-closed，`reuse-evaluation-runner.ts`）经 pi-ai profile 调模型；verdict=reuse+有效选中 → intake 返回 `refused/reuse_pending_owner`（候选 PENDING、零写入，`candidate-intake-service.ts:699-719`）；create/uncertain/**unavailable**/幻觉 ID → 一律放行 CREATE（Rule 2-4，`:736-739`）。
- Owner 通道：`pd candidate review --decide reuse|create` 注入 `reuseDecision`（`pd-cli/src/commands/candidate.ts:858-864`）；reuse → `appendReuseEvidence` 落账（唯一写 `principle-tree-ledger.ts:627-670`）。

### 1.4 九问逐答

| # | 问题 | 实测答案 |
|---|---|---|
| 1 | 按 ID 还是按内容去重？ | **均不是按 Principle 文本**。ID：新铸 UUID 无碰撞意义；candidate 级幂等按血缘（candidateId）；内容级只有复用门的词法评分 |
| 2 | 是否存在语义相似性判定？ | **两半场**：检索=确定性词法（bigram，非语义）；判定=LLM 语义评估（建议性，Owner 决定） |
| 3 | 是否只检测完全相同文本？ | 连完全相同文本也没有专门的精确匹配检查——1.0 分是 bigram 全覆盖的自然结果 |
| 4 | 不同表述同机制？ | **词法阈值下大多漏检**：低于 0.15 根本不进短名单（T4 实测 0 分）；0.15-1.0 进短名单后依赖 LLM/Owner |
| 5 | 检测发生在注册前还是后？ | 前（4d 门在 5/6 写之前）——但降级路径（unavailable/no_candidates）直接落写 |
| 6 | 近义原则：拒绝/合并/警告/允许？ | **机器从不自动合并**：gate=reuse → 候选挂起等 Owner；Owner=reuse → 证据落账不建新条目；其余→注册 |
| 7 | 不同 Pain 相同原则是否拦截？ | 语料库级比较（全部 candidate/probation/active 条目，`reuse-retrieval.ts:35-39,89-102`）——**词法重叠高才拦**；跨 Pain 近义改写实测 0 分（T4） |
| 8 | 人工审核状态是否影响？ | status∈{candidate,probation,active} 均可比对；archived/deprecated 排除；未知状态 fail-closed |
| 9 | 跨来源统一去重边界？ | 有——门读**同一** Ledger 全库，与来源任务/Pain 无关；但仅覆盖走到 intake 的 principle-kind 候选 |

（§二起为注册演练实测）

## 二、零代码 Ledger 注册演练（T0-T6）

### 2.1 演练设置（隔离性与真实性声明）

- **隔离**：全部操作在 `.tmp/prompt-v2-ab/next-task/ledger-drill/ws-*/`（`v2c-sup-S03` 实验工作区的完整副本，含 state.db+WAL）上进行；生产 Ledger/生产数据库零写入；生产 Prompt/Runtime/Schema 零改动。
- **真实入口**：变体 `nc` = 裸 `CandidateIntakeService`（T11 回滚形态，测写层本体）；变体 `pa` = `createReuseGatedIntakeService`（pd-cli 生产组装：默认配置门启用 + `reuseStateDir`）。两者均为本 worktree dist 的**真实生产代码**，非 Mock。
- **fixture 披露**：T1/T2 的输入候选行（`cand-drill-*`，owning task kind=`manual_candidate_review`——非 strict V2 血缘 kind，走 4b/4c 合法 legacy 提取路径）为插入隔离副本的夹具数据；注册逻辑本身未做任何改动。
- **模型 API**：`pa` 变体进程内清除 21 个 API key 环境变量 → 复用评估按真实代码路径返回 `unavailable`（`ZAI_API_KEY is not set`），**零网络调用、零费用**。
- 语料=4 条真实注册文本（来自实验上游工作区 Ledger：S02/S03/S07/S12 的 principle-kind recommendation 注册产物，实况=每 Pain 恰 1 条，因为 3b kind 门把 rule/prompt kind 全部拒于 Ledger 外）；主张文本=冻结实验产物中的真实链稿（drill-texts.json）。

### 2.2 逐场景实测

| 场景 | 输入（真实文本来源） | 短名单（真实评分） | 真实 intake 结果（nc / pa） | 判定 |
|---|---|---|---|---|
| **T0** 同候选重放 | 真实已注册候选 `897ad4c5`（S03） | —（步骤2 直达） | `written:false`、返回既有条目、**零新写** / 同 | ✅候选级幂等真实有效 |
| **T1** 逐字重复 | P_S03 原文 | **1.0000**→P_S03 | **注册成功**（新 UUID 60796401…，status=probation）/ **注册成功**（eb063264…；reuseCheck=`recommended_create`，reuseRecommendation=`{status:'unavailable',reason:'ZAI_API_KEY is not set'}`） | 写层零文本查重；拦截完全依赖判定半场，判定不可用即放行 |
| **T2** 同机制异措辞 | S03 v21 链 2 Philosopher thesis（上轮审计认定的真实跨链 Duplicate） | **0.3265**→P_S03（第 2 名 P_S12 0.175） | 注册成功 / 注册成功（同样 unavailable→CREATE） | 检索半场**能**命中该真实重复；最终拦截取决于 LLM+Owner（离线未验证，BLOCKED） |
| **T3** 同目标异机制 | S03 dreamer #2（owner 纠正最高优先级信号） | **无**（0 分） | （无需实跑：无短名单→直接 CREATE） | 检索层无误拦；机器层无"错误合并"路径（合并只能由 Owner 决定） |
| T3b | S03 dreamer #0（等待前状态核查——P_S03 已内含该机制） | **0.1579**（贴线命中 P_S03） | 同上（若实跑则进评估） | 边界案例：恰好过线，处置交给 LLM/Owner |
| **T4** 跨 Pain 同机制族 | P_S12 原文 vs {P_S02,P_S03,P_S07}；S03 状态核查 vs P_S12 | **两个探针均 0 分** | （无短名单→CREATE） | **跨 Pain 近义检测 NOT_SUPPORTED**（词法阈值下不可见） |
| **T5** 同 Pain 互补机制 | S02 dreamer #1（失败阈值止损）/#2（官方能力盘点） vs P_S02 | **均 0 分** | （无短名单→CREATE） | ✅无误拦——互补机制正常共存 |
| **T6** 互斥策略 | 冻结数据集中**不存在真实冲突对**（上轮审计 Conflict Rate=0） | — | **NOT_EXECUTABLE**（拒绝编造输入） | 代码层另证：`conflictsWithPrincipleIds` 无任何自动写者（intake 恒写 `[]`，`adapter:58`）→ **冲突识别 NOT_SUPPORTED** |

### 2.3 总判定

**PARTIAL_SUPPORT** —— 分项：

- `EXACT_DUPLICATE`（候选级，同一 candidateId 重放）：**SUPPORTED**（T0 实测）。
- `EXACT_DUPLICATE`（不同候选、逐字文本）：**NOT_SUPPORTED at write layer**（T1 双变体均注册成功）；检索半场可标记（1.0），最终拦截依赖 LLM+Owner。
- `SEMANTIC_DUPLICATE`（近义改写）：**PARTIAL**——词法重叠足够高时进短名单（T2=0.3265 实测命中），但 (a) 大部分近义改写低于 0.15 根本不可见（T4=0），(b) 命中后依赖 LLM 评估，评估失败按 Rule 4 放行 CREATE（生产默认路径下可复现）。
- 跨 Pain 近义：**NOT_SUPPORTED**（词法阈值）。
- 冲突识别：**NOT_SUPPORTED**（无机制 + 无真实输入）。
- 误拦截：**未发现**（T3/T5 互补机制 0 分共存；机器从不自动合并）。

（§三为生产环境实证）

## 三、生产 Ledger 只读巡检（重复是否实际发生）

`D:/.openclaw/workspace/.state/principle_training_state.json`（62,818 B，lastUpdated 2026-11-13）：**54 条 principle（46 candidate + 8 active）**，0 rules，2 条带 reuseEvidence。

### 3.1 实证重复对（门启用状态下注册成功）

- `946754bf`（**active**，createdAt 2026-11-11T17:27Z）："技术安全评估（无引用、改动小）不能替代 Owner 的显式授权，高敏感、有后果的变更必须先提案并获取明确许可后再执行。"
- `26858b6f`（candidate，createdAt 2026-11-11T18:08Z——**晚 40 分钟**）："确立跨场景通用原则：技术安全评估（如引用面探查、改动范围小）不能替代 Owner 的显式授权；凡涉及他人所有权或有后果的变更，必须先提案并获得明确许可后再执行。"

以生产评分器（同版本 dist）量化：**0.6842**（阈值 0.15 的 4.5 倍）——若 18:08 那次 intake 走到评估，检索半场必然命中。两 entries 仍同时存在 ⇒ 当时（a）评估不可用（Rule 4 放行）或（b）评估判 create/uncertain 或（c）Owner 在 review 中判 create。三种路径都导向同一事实：**近逐字重复在 2026-11-11 真实进入了生产 Ledger**。该对与 S07 实验链的机制同族（S07 的 ledger 条目即"技术验证不能替代授权确认"），即上轮审计发现的跨链重复模式在生产层面同样发生。

### 3.2 语义家族重叠（同目标多候选并存）

只读巡检可见至少三个多成员家族，例如：交付验证族（`8ba3d168`"交付前对照预期意图逐项核查" / `09013216`"交付的定义必须内含主动验证" / `94ab7557`"接收者可自行验证成功的最小产物设为交付前门禁"）；可观察证据族（`b0a6c433` / `37f819a6` / `14a76608`，互分 0.22）；以及 §3.1 的授权族（含 `2e42ef1b`"先复述确认再执行" 0.38）。与实验侧每 Pain 2-3 条近义候选的结论互为印证。

### 3.3 门成功拦截的真实记录（对照面）

生产 Ledger 存在 **3 条真实 Owner 复用裁决**（reuseEvidence，INV-R07 全链路走通的实证）：

1. `3824d083`（2026-09-30）："R6验证冲刺·Owner复用裁决：**Reuse Review Gate挂起后Owner裁决复用**原始资产3824d083…避免重复创建同类原则；R5与R6语义评估均判reuse。"
2. `96608bec`（PRI-939-P3 ScenarioA）：语义评估 recommendation=reuse（confidence 0.95）→ Owner 复用裁决。
3. `96608bec`（R7-OC02）：语义评估 recommendation=reuse（confidence 0.92）→ Owner 复用裁决。

结论：门**具备**端到端拦截能力（评估可用+Owner 裁决时真实工作过 3 次），但其可用性不是持续保证的——评估不可用时系统按设计放行（Rule 4"评估失败永不阻塞学习"），且放行可观察（diagnose 会打 `semantic reuse evaluation unavailable — learning proceeded without duplicate protection` 警告，`diagnose.ts:935`）。

## 四、回答 Owner 问题（Phase 6 §A 预答）

| 问题 | 答案（证据） |
|---|---|
| 能否拦截完全重复的原则？ | 候选级（同 candidateId）：**能**（T0）。跨候选逐字文本：写层**不能**；检索半场能标记（1.0），拦截取决于评估+Owner |
| 能否拦截语义近似的原则？ | **部分**——词法重叠≥0.15 才可见（真实跨链重复 T2=0.3265 可见），低于阈值不可见（跨 Pain 家族 0 分）；可见后依赖 LLM 评估与 Owner 裁决 |
| 会否误拦截真正不同的原则？ | 实测**未见**（T3/T5 互补机制 0 分共存；机器无自动合并路径） |
| 是否需要进一步开发？ | 需要（若要闭环 U3）：缺口=①写层零文本查重；②评估不可用时的 Rule-4 放行；③跨 Pain 词法盲区；④冲突识别缺失。修复方向属 V2.2 预注册 M1 后续决策，本轮不改代码 |
| 当前是否存在重复进入系统的实际风险？ | **是——已发生**：生产 Ledger 实证近逐字重复对（§3.1，2026-11-11）+ 多个语义家族并存（§3.2） |

## 五、局限与未验证项（如实）

1. **BLOCKED——判定半场离线不可验证**：`ReuseEvaluationRunner` 的 LLM 评估（生产 profile=pi-ai.glm）需要付费模型 API，本轮指令禁止调用。因此"评估可用时 T1/T2 是否必然拒绝注册"无法实测；可引证的间接证据是 §3.3 的 3 次生产成功拦截记录。
2. `pa` 变体验证的是"评估不可用"这一真实生产分支（含 21 个环境变量清洗后的真实报错路径），不是"评估成功"分支。
3. fixture 候选走 legacy 提取路径（非 Diagnostician V2 血缘验证）——这是非诊断来源候选的真实生产路径，但不代表 `pd diagnose` 主路径的 4a 血缘验证行为（该行为与去重无关，纯 lineage 校验）。
4. 生产 Ledger 巡检为只读快照（2026-11-15），重复家族的完整清点（全库 54×54 语义归并）不在本轮范围，仅列代表对。
