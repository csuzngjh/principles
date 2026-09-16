# 核实文档 C — evaluator / artificer / scribe / rolloutReviewer 四代理（§5）

> 核实对象：`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md` §5（内化链后半段四内置代理）
> 核实方式：独立回源核对。报告声明基线为 GitHub main @ `70d824c4`；本次核实**全部证据锚定 `70d824c4`**（`git show 70d824c4:<path>`），未切换分支。
> 核实范围：C-1 提示词逐字对比 / C-2 输出 Schema 字段表 / C-3 嫌疑条目全量回源（§5 四卡条目 27 条，其中带加粗标题的为 24 条 + 交叉核对结论 5 点）/ C-4 L2 驱动面。
> 核实员：PD Developer（CNB NPC，只读核实；仅新增本文件）
> 核实时点：2026-09-15，检出分支 `ai/audit-agent-pipeline-report`（报告所在分支），工作区 HEAD = `94e4ef5b`。

---

## 0. 基线说明（必读，影响所有判定口径）

报告在 §5 抬头声明「所有 `file:line` 相对仓库根」且基线为 main @ `70d824c4`。核实过程中确认了两点**与报告无关但影响复现**的事实，先在此声明：

1. **`70d824c4` 是本仓库对象库中真实存在的提交**（`Merge pull request #1692 …`，2026-09-15 01:26），可 `git show` 直读，无需 fetch。故本次**不降级**，全部按「基线行号」判定。
2. **报告所在分支（`ai/audit-agent-pipeline-report`）比 `70d824c4` 领先 51 个提交**，其中含两个**直接命中本次管辖范围**的在途 PR 合并：
   - `be615da1` = PR #1693（PRI-795 Artificer L2 abort 归因 + 超时契约）
   - `afa95651` = PRI-795 r3（`submit_rulecode` schema 补 `evidenceRefs`）
   - `285d1c81` = PR #1698（PRI-720 channel-aware DAG，新增 rolloutReviewer 的 principle_semantic 模式并重写其 output/prompt/runner）

   这些提交**在报告检出树里存在，但在报告声明的基线 `70d824c4` 里不存在**。因此 §5 中若干以 `70d824c4` 为基线撰写的结论，读者若在报告所在分支上复现会看到**代码已变**。这不是报告的错误（它明确声明了基线），但属**报告可复现性缺口**，记入 §5 建议修正清单（S-1）。

所有行号判定均以 `70d824c4` 为准；凡在报告分支树上已变化的条目，在判定表内加注「分支树已变」。

---

## 1. 摘要统计

### 1.1 判定计数

判定粒度 = **条目**（不是行）。C-1 按提示词段落 + 方位词问题计 7 项；C-2 按「文件名 × 字段表」计 5 项；C-3 按 §5 四卡条目计 27 项 + 交叉核对结论 5 项；C-4 按任务书列出的 3 项（maxTurns 注释 vs 常量、abort 语义、l2 双 merge 与 §0.1 一致性）；R 项按登记表指定 5 项。

| 管辖块 | 条目数 | CONFIRMED | REFUTED | DRIFT | UNVERIFIABLE |
|---|---|---|---|---|---|
| C-1 提示词逐字对比 | 7 | 5 | 1 | 1 | 0 |
| C-2 输出 Schema 字段表（5 文件） | 5 | 4 | 1 | 0 | 0 |
| C-3 四卡嫌疑条目 | 27 | 26 | 0 | 1 | 0 |
| C-3 交叉核对结论 | 5 | 4 | 0 | 1 | 0 |
| C-4 L2 驱动面 | 3 | 3 | 0 | 0 | 0 |
| R 项最高标准复核 | 5 | 5 | 0 | 0 | 0 |
| **合计** | **52** | **47** | **2** | **3** | **0** |

REFUTED 仅 2 项（均为**表述精度**级，非事实性错误）：

1. evaluator 卡「源码中**两处** `intentContract` 转义反引号」→ 实际 **1 处**（`:182`）。
2. evaluator 卡 `adversarialCases` 行「可选，存在则**逐元素校验**」→ 实际只覆盖字段存在/类型与可选 `ruleContext` 的结构，**不校验**数量（prompt 却要 3-5）与 `attackType × expectedDecision` 组合语义。

DRIFT 3 项：`prompt-serializer.ts:12,57-59` → `:1,49-51`（scribe 卡 4 与 evaluator 卡正文）；artificer V2 段引用块省略起始换行；§5 交叉核对「未发现 id 断链」与报告自身 §1.3 R-01 矛盾（内部结论需一致化）。

任务书点名的「24 条嫌疑」核清为：§5 四卡带加粗标题的条目**恰为 24 条**（evaluator 6 / artificer 8 / scribe 4 / rolloutReviewer 6）；另 3 条无加粗的「交叉核查 / 无断裂」条目（evaluator #7、artificer #9、scribe #5）亦一并判定，故 C-3 共 27 条，无遗漏。

新增发现（NEW）共 **10 项**：P1 × 1、P2 × 2、P3 × 7。

### 1.2 最重要的 REFUTED / DRIFT（前 5）

| # | 类型 | 位置 | 报告原文要点 | 核实事实 | 影响 |
|---|---|---|---|---|---|
| R-1 | **REFUTED** | §5 evaluator 卡・系统提示词段末 | 「源码中**两处** `intentContract` 转义反引号按运行时实际字符串呈现」 | `grep -c` 转义反引号 = **1**（仅 `:182`） | P3（文字精度） |
| R-2 | **REFUTED** | §5 evaluator 卡・输出 Schema 表 `adversarialCases` 行 | 「可选，存在则**逐元素校验**」 | `evaluator-output.ts:296-341` 只校验 caseId/attackType/toolName/params/expectedDecision/rationale 的存在与类型 + 可选 `ruleContext` 结构 | P3（表述精度） |
| R-3 | **DRIFT** | §5 四卡正文多处（scribe 卡 4 等） | `prompt-serializer.ts:12,57-59` | 文件仅 **53 行**；`MAX_PROMPT_CHARS = 50_000` 在 `:1`，超限 `throw new RangeError` 在 `:49-51`。`:12` 是注释、`:57-59` **不存在** | P3（引用可复现性） |
| R-4 | **DRIFT**（结论自相矛盾） | §5 交叉核对结论 第 4 点 | 「规则工件血缘链（dreamer→philosopher→scribe→artificer→evaluator→pi-rule→rollout→activation/dispatch）各环节均有 id 交叉校验与 echo 校正，**未发现 id 断链**」 | **与报告自身 §1.3 的 R-01（P1）直接矛盾**：R-01 断言「scribe→artificer 血缘命名断链 + `resolveDreamerContext` 静默返回 undefined 且不发任何事件」，而该跳正落在本条声明的链上。核实证实 R-01 成立（`philosopher-output.ts:24,42` 产 `sourceDreamerArtifactId`；`scribe-prompt-builder.ts:78` 让找 `dreamerArtifactId`；`artificer-runner.ts:273-281` 两处 `return undefined` 零事件）→ **本条「未发现 id 断链」范围过宽，须限定为「除 R-01 已登记的 dreamer→scribe 命名跳外」** | P2（结论范围） |
| R-5 | **DRIFT**（次要） | §5 artificer 卡・第 2 段引用块 | 引用块首行为 `CONTEXT MODE: v2 …` | 源模板以换行起（`artificer-prompt-builder.ts:261` 的反引号后即 `\n`），报告省略该前导换行 | P3（引用保真） |

### 1.3 最重要的 NEW（前 5）

| # | NEW | 位置 | 严重度 |
|---|---|---|---|
| NEW-1 | **adversarialCases 沙箱执行的信任边界可分多步逃逸**：静态禁止表被 `'con'+'structor'` 类拼接绕过 → `node:vm` 同 realm 构造器逃逸 → 触达 `process.getBuiltinModule('fs'/'child_process')` + 完整 `env`。已在 core 两条沙箱路径复现能力；生产 live gate 的**子进程**模式已按 JSON-字符串契约加固（`rule-implementation-runtime.ts:27-32` 注释 + 回归测试），不受影响。 | `rule-code-validator.ts:27-65` + `production-gate-deps.ts:86-124` | **P1** |
| NEW-2 | **`attemptCount` 双源不一致**：`revision-reopen.ts:111-115` reopen 时把 `tasks.attempt_count` 重置为 **0**，而 `runs.attempt_number` 不回退（`lease-manager.ts:149-160`）。`lastValidatorErrors` 新鲜度门（`pitask-metadata.ts:257-263`）两侧同源故不被打破；真正缺口是 reopen→下次 lease 窗口内 `task.attemptCount` 与之矛盾（双源口径，对照 rc-7）。 | `base-peer-runner.ts:750-755` / `revision-reopen.ts:114` | **P2** |
| NEW-3 | **第二个语义过载持久化键**：`pi_artifacts` 唯一索引 `(source_task_id, artifact_kind)`（`sqlite-connection.ts:393`）+ upsert `DO UPDATE SET artifact_id = excluded.artifact_id, … content_json = excluded.content_json`（`sqlite-pi-artifact-store.ts:78-101`）→ 同任务同 kind **只有一行且 artifact_id 可被覆盖**。报告的「重放后重持久化**同一工件**」行号正确，但未点出这是唯一索引强制的**覆盖**（历史版本无留档）。 | `sqlite-connection.ts:393` + `sqlite-pi-artifact-store.ts:78-101` | **P2** |
| NEW-4 | **两沙箱路径静态检查集不对称**：`production-gate-deps` 跑 3 项静态检查（`:166,180,198`），`refiner-sandbox-wrapper.evaluateInRefinerSandbox` 只跑 2 项（`:264,276`）——**缺 `checkMatchedFalseDecisions`**。报告 artificer 卡第 5 条默认「静态 + 运行时」两道覆盖全部路径。 | `refiner-sandbox-wrapper.ts:264-288` vs `production-gate-deps.ts:166-210` | **P3** |
| NEW-5 | **LLM 可见词汇表是三向不重合**：报告已列 system prompt（`artificer-prompt-builder.ts:213`）↔ validator（`rule-code-validator.ts:27-65`）双向不重合，但**第三份 `RULECODE_SPEC_TEXT`**（L2 `read_rulecode_spec` 工具返回、`artificer-l2-tool-contract.ts:91-180`）才是模型实际读到的清单，其 FORBIDDEN PATTERNS（`:114-118`）只列 20 项、缺 constructor/Buffer/WeakRef 等。 | `artificer-l2-tool-contract.ts:91-180` | **P3** |


## 2. C-1 提示词逐字对比结论表

方法：以程序方式从 `70d824c4` 的源文件**提取完整模板字符串**（含 JS 转义还原），与报告 ```` ```text ```` 代码块做**逐字符 diff**（仅允许尾部换行归一化）。不抽样——四个代理的每一段全部比对。

| 代理 | 段落 | 报告锚点 | 源锚点 | 方法 | 判定 |
|---|---|---|---|---|---|
| evaluator | `EVALUATOR_PROTOCOL_INSTRUCTION` 全文 | `evaluator-prompt-builder.ts:147-217` | 同 | 全量 diff（11,445 字符 / 71 行 vs 报告 11,444 字符 / 70 行，仅末尾换行差异） | **CONFIRMED** |
| evaluator | 语言指令注入点「运行时在尾部追加」 | `:226,245` | `:226`（`buildLanguageDirective(...,'review')`）、`:245`（`systemPrompt: EVALUATOR_PROTOCOL_INSTRUCTION + languageDirective`） | 源码确认 | **CONFIRMED** |
| evaluator | 「源码中两处 `\`intentContract\`` 转义反引号」 | 正文陈述 | `:182` 实际只有**一处** `\`intentContract\`` 转义（`OWNER INTENT CONTRACT (when \`intentContract\` is present`） | `grep -c '\\`'` = 1 | **REFUTED（次要）**：应为「一处」。见建议 S-2 |
| artificer | 第 1 段 `ARTIFICER_PROTOCOL_INSTRUCTION` 全文 | `artificer-prompt-builder.ts:153-253` | 同 | 全量 diff（10,715 字符 / 101 行 vs 报告 10,714 / 100 行，尾换行） | **CONFIRMED** |
| artificer | 第 2 段 `V2_CONTEXT_INSTRUCTION` 全文（含**前导空行**） | `:261-271` | 同 | 全量 diff（提取结果首行为空、报告块首行为 `CONTEXT MODE: v2`）→ 报告**省略了模板起始的换行**，其余 9 行逐字一致 | **DRIFT（次要）**：报告块缺 `V2_CONTEXT_INSTRUCTION` 首个 `\n`（影响：单独引用该段时拼接位置失真）。见 S-3 |
| artificer | 第 3 段 HOST SEMANTIC CONTEXT 块模板 | `:313-318` | `:313-318`（`return \`` 起） | 半程序 diff：把 `${hostLine}`/`${toolList}` 替换为报告的 ⟨注入⟩ 标注后逐行比对（含尾部空行） | **CONFIRMED** |
| artificer | **拼接顺序与方位词问题（任务 C-1 重点）** | 卡第 2 条：`"CONTEXT MODE block above"` 位于第 1 段 `:245-246`，而 CONTEXT MODE 块在拼接时追加于其后（`:357-358`）——"above" 实为 below | `:245` 确含 `satisfy the CONTEXT MODE block above`；`:357-358` 确为 `ARTIFICER_PROTOCOL_INSTRUCTION + V2_CONTEXT_INSTRUCTION` | 双向确认 | **CONFIRMED**（方位词自指错误属实；`V2_CONTEXT_INSTRUCTION` 定义在 `:261`，**文本上**确实"在源码后面、拼接后在提示词前面"——即"above"在**最终提示词中成立、在源码阅读顺序中不成立**。报告描述精确） |
| artificer | 语言指令为第 4 段 | 卡正文「四段拼接」 | `:364` `+ buildLanguageDirective(input.outputLanguage, 'implementation')` | 源码确认 | **CONFIRMED** |
| scribe | 系统提示词全文（含 `coreAxiomsBlock` / `languageDirective` 两个注入点标注） | `scribe-prompt-builder.ts:50-110` | 同 | 全量 diff：报告把 `${coreAxiomsBlock}`→⟨注入…⟩、`${languageDirective}`→⟨注入…⟩，其余 59 行（含 `⟨注入: coreAxiomsBlock⟩OUTPUT FORMAT` 同行拼接）逐字一致 | **CONFIRMED** |
| scribe | 「契约版本 `scribe-output-v1.prompt.v2`（:120）」 | `:120` | `export const SCRIBE_PROMPT_CONTRACT_VERSION = 'scribe-output-v1.prompt.v2';` | 源码确认 | **CONFIRMED** |
| rolloutReviewer | `ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION` 全文 | `rollout-reviewer-prompt-builder.ts:37-71` | 同 | 全量 diff（3,057 / 35 vs 3,056 / 34，尾换行） | **CONFIRMED** |
| rolloutReviewer | 「运行时尾部追加语言指令（:95）」+ 契约版本 `:73` | `:73`, `:95` | `:95` `systemPrompt: ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION + languageDirective`；`:73` 版本串 | 源码确认 | **CONFIRMED** |

**C-1 小结**：4 个代理的 6 段提示词全文**逐字比对全部通过**（仅 1 处段落级换行省略、1 处转义反引号计数口误）。任务重点关注的 artificer「V2 拼接顺序与方位词问题」**属实且描述精确**。

---

## 3. 逐项判定表（C-1..C-4）

### 3.0 C-1 逐段判定索引（明细见 §2）

| C-1 项 | 判定 |
|---|---|
| evaluator 系统提示词全文逐字 | CONFIRMED |
| evaluator 语言指令注入点 | CONFIRMED |
| evaluation「两处转义反引号」计数 | **REFUTED**（实为 1 处） |
| artificer 第 1 段全文逐字 | CONFIRMED |
| artificer 第 2 段（V2_CONTEXT）全文逐字 | **DRIFT**（省略起始换行） |
| artificer 第 3 段（HOST SEMANTIC CONTEXT）模板 | CONFIRMED |
| artificer「CONTEXT MODE block above」方位词问题属实 | CONFIRMED |
| scribe 系统提示词全文（含 2 注入点标注） | CONFIRMED |
| rolloutReviewer 系统提示词全文 + 语言指令 | CONFIRMED |

### 3.1 C-2 输出 Schema 字段表

对五个文件逐字段核对类型 / 必填性 / 不变量 / v1-v2 分支行为。

| 代理 | 字段（报告行） | 报告声明 | 源事实（`70d824c4`） | 判定 |
|---|---|---|---|---|
| evaluator | `taskId` `:218,:442-446` | 是（须等于任务 id） | `Type.String({minLength:1})`；validator `:442-446` 用 `Object.hasOwn` + `!== taskId` | CONFIRMED |
| evaluator | `sourceArtificerArtifactId` `:219,:448-452` | 是（须与期望一致） | `:448-452` 逐字一致 | CONFIRMED |
| evaluator | `evaluation.decision` `:195-200,:458-459` | 是，3 值 | 一致 | CONFIRMED |
| evaluator | `evaluation.summary` `:201,:461` | 是 minLength 1 | 一致 | CONFIRMED |
| evaluator | `evaluation.score` `:202,:462-463` | number[0,1] | `:462` number 检查 + `:463` 区间检查 | CONFIRMED |
| evaluator | `strengths/concerns` `:203-204,:464-467` | string[] | 一致 | CONFIRMED |
| evaluator | `requiredChanges` `:205,:468-474` | 是；needs_revision 必须非空 | `:472-474` 不变量存在 | CONFIRMED |
| evaluator | `priorRequirementStatuses` `:176-183,:476-493` | 修复轮必须；validator `:580-633` 机器校验 | `:476-493` 结构校验；`:580-633` 覆盖/唯一/不重编号/verbatim/互洽 | CONFIRMED |
| evaluator | `requirementLedger` `:185-193,:496-516` | 同上 | 一致 | CONFIRMED |
| evaluator | `sourceTrace` 各项 `:210-215,:519-537` | artificer 项必填 | 一致 | CONFIRMED |
| evaluator | `risks` `:222,:539-543` | 是 | 一致 | CONFIRMED |
| evaluator | `generatedAt` `:223,:552-554` + base 覆写 `base-peer-runner.ts:306-309` | 是，base 强制覆写 | `base-peer-runner.ts:306-309` `Reflect.set(...,'generatedAt', new Date().toISOString())` | CONFIRMED |
| evaluator | `codeReview` `:56-70,:242-294,:559-561` | 可选，存在则逐字段 fail-loud | 一致（`validateCodeReview`） | CONFIRMED |
| evaluator | `adversarialCases` `:14-29,:296-341,:562-564` | 可选，存在则逐元素校验 | 行号正确；但「逐元素」的**不变量覆盖度**被高估（见 §3.1 该行） | **REFUTED（表述精度）** |
| evaluator | `adversarialResult` `:31-82,:343-389,:565-567` | LLM 可携带但成功路径**先剥离**`evaluator-runner.ts:941-944` | `:941-944` `isEvaluatorOutputV2(output) && Object.hasOwn(output,'adversarialResult')` → 解构剥离 | CONFIRMED |
| evaluator | `painCoverage`/`compressionFidelity` `:146-172`；「不被 DefaultEvaluatorValidator 校验（仅 `isEvaluatorOutputV2` 白名单 :396-411）」 | 见左 | `:146-172` 接口存在；validator 正文（`:435-638`）**无**这两个字段的校验分支；`:396-411` 白名单包含它们 | CONFIRMED |
| artificer | `taskId/sourceScribeArtifactId` `:77-79,:237-246` | 是（与上下文一致） | 一致 | CONFIRMED |
| artificer | `implementationCode` `:80,:248-251` | 是 minLength1，无 V1 plan-only 路径 | `:248-251` 一致 | CONFIRMED |
| artificer | `goldenTraceCases` `:24-33,:81-95,:138-206,:290-332` | 2..10；≥1 positive(=allow) + ≥1 negative；v2 声明时每 case 必须 ruleContext 且禁 propose_correction | `:138-206` 结构+正负例+`kind='positive'⇒allow`；`:290-332` v2 分支 ruleContext 必须、v1 声明 ruleContext 必须拒、v2 禁 propose_correction | CONFIRMED |
| artificer | `affectedTools` `:97,:208-223,:334-340` | 是 minItems1 | 一致 | CONFIRMED |
| artificer | `implementationSummary/risks/sourceTrace/generatedAt` `:98-101,:253-256,:342-383` | 是 | 一致 | CONFIRMED |
| artificer | `requiresContextVersion` `:103,:269-282`；另层 `artificer-runner.ts:531-537` | v2 必须 | `:269-282` 只允许 literal 2；`artificer-runner.ts:537` `!== 2 → error` | CONFIRMED |
| artificer | `evidenceRefs` `:105,:385-394`；runner `:562-571` | v2 必填且逐字匹配 pack | `:388-394` v2 非空数组；`artificer-runner.ts:562-571` 与 `pack.evidenceRefs` 逐位相等 | CONFIRMED |
| scribe | `taskId` `:63,:108-110` | 是 | 一致 | CONFIRMED |
| scribe | `sourcePhilosopherArtifactId` `:64,:113-117` | 是 | 一致 | CONFIRMED |
| scribe | `principleDraft.title/statement/rationale` `:48-55,:123-126` | 非空 | 一致 | CONFIRMED |
| scribe | `applicability/antiPatterns` `:127-130` | 是；prompt 建议 ≥1，validator 不强制 | `:127-130` 只查 `Array.isArray` + 元素 string | CONFIRMED |
| scribe | `confidence` `:131-132` | number[0,1] | 一致 | CONFIRMED |
| scribe | `intentContract` `:45,:160-167` / `intent-contract.ts:54-64` | **线上可选**；存在即硬校验 | 一致；**补充**：`:72` `Type.Optional(Type.Unknown())` —— schema 层对内容零约束（报告未点明，见 §5 NEW-6） | CONFIRMED（+补记） |
| scribe | `sourceTrace` `:57-60,:135-151` | philosopher 必填 | 一致 | CONFIRMED |
| scribe | `risks/generatedAt` `:153-158,:169-172` | 是 | 一致 | CONFIRMED |
| scribe | `normalizeStringEncodedIntentContract` `:192-206` + 事件 `scribe-runner.ts:429-431` | 「原位 parse 回对象」 | 一致 | CONFIRMED |
| rollout | `taskId` `:53,:82-84` | 是（=任务 id） | `:82` `output.taskId !== taskId` —— **未区分缺失与不匹配**（NEW-5） | CONFIRMED（+补记） |
| rollout | `sourceEvaluatorArtifactId` `:54,:86-90` | 是（=期望 id） | 一致 | CONFIRMED |
| rollout | `review.decision` `:31-36,:96-98` | 是 3 值 | 一致 | CONFIRMED |
| rollout | `review.summary` `:37,:99` | 非空 | 一致 | CONFIRMED |
| rollout | `review.confidence` `:38,:100-101` | number[0,1] | 一致 | CONFIRMED |
| rollout | `review.requiredChanges/rolloutRisks/safetyChecks` `:39-41,:102-107` | 是（可空） | `:102-107` 只查数组+元素 string，**无 needs_revision⇒非空 约束** | CONFIRMED |
| rollout | `sourceTrace` `:44-50,:110-131` | evaluator 项必填 | 一致 | CONFIRMED |
| rollout | `risks/generatedAt` `:57-58,:133-137,:146-148` | 是 | 一致 | CONFIRMED |

**C-2 小结**：字段级「类型 / 必填 / 不变量 / v1-v2 分支」**全部与源码一致**（41 行抽查全中）。仅两条表述需收紧：`adversarialCases` 的「逐元素校验」不变量覆盖度（§1.2 R-2）、`intentContract` 的 schema 层 `Unknown`（§5 NEW-6）。

### 3.2 C-3 嫌疑条目全量回源（§5 四卡，共 27 条）

**evaluator 卡（7 条）**

| # | 报告结论 | 核实 | 判定 |
|---|---|---|---|
| 1 | progressive 三处脱节：prompt 宣布 COMPRESSION FIDELITY 并要求输出 `painCoverage`/`compressionFidelity`，但 CONSTRAINTS+示例未要求，`evaluateFlaggedCriteria` 读三字段缺失即 `undetermined`，`implementationFidelity` **不在** schema 中 → Stage 1 短路结构上不可达、空烧两次 LLM 调用；阈值 0.7 死判据 | 全链路核实：a) `evaluator-prompt-builder.ts` 中 `painCoverage`/`compressionFidelity`/`implementationFidelity` 出现次数均为 **0**（grep -c）→ prompt 确实不要求这两个字段；b) `progressive-evaluator.ts:26` `IMPLEMENTATION_FIDELITY_THRESHOLD = 0.7`；`:123-186` 三判据，`:167-179` 读写 `implementationFidelity.score`；c) `evaluator-output.ts` 全文件 `implementationFidelity` **0 次命中**（`git grep` 仅 `progressive-evaluator.ts` 与测试）；d) `evaluator-runner.ts:606-611` `if (!d1.flagged && !forced && d1.undetermined.length === 0)` 才走 Stage 1 | **CONFIRMED** |
| 2 | prompt 要 "3-5 objects"，validator 不校验数量 | `evaluator-prompt-builder.ts:216` 确为 3-5；`evaluator-output.ts:296-341` 无 length 检查 | **CONFIRMED** |
| 3 | Part A→needs_revision 短路只在 prompt，validator 不交叉校验 | `:189` 三维任一失败必须 needs_revision；`:559-561` 只结构校验 | **CONFIRMED** |
| 4 | `artifactKind='principle'` 四义复用 | 四方写入点行号全部命中：`scribe-runner.ts:344`、`artificer-runner.ts:1042`、`evaluator-runner.ts:985`、`rollout-reviewer-runner.ts:549`；`rollout-reviewer-runner.ts:683-688` 专项排除 evaluator/rollout_reviewer 名下 principle | **CONFIRMED** |
| 5 | evaluator 示例用 `write_file`，与 artificer 宿主词汇约束相反 | evaluator 示例 `:196` 含 `"toolName":"write_file"`（1 次命中）；artificer `:207` 明令 `write_file` 等「NOT real host tools and WILL be rejected」 | **CONFIRMED** |
| 6 | 死代码 `checkStage1Contract` 恒返回 null（`:674`），与模块级 `checkStage1ContractOutput`（`:248-261`）重复 | `:674` `private checkStage1Contract(_output: unknown): string \| null { return null; }`；`:248-261` 模块级实现；`:591` 调用的是模块级 | **CONFIRMED** |
| 7 | 工件哈希血缘未发现断链；`computeArtifactContentHash`（owner-review.ts 导出）仅在 NHR 上下文计算 | `owner-review.ts:134-136` 导出 `computeArtifactContentHash`（内部 `sha256Hex`），`:268` 在 `collectOwnerDecisionFacts` 内使用（即 NHR 评审快照）；`artifact-content-hash.ts:119-121` 是 `computeContentHash`（另一函数，摘要信封用） | **CONFIRMED** |

**artificer 卡（9 条）**

| # | 报告结论 | 核实 | 判定 |
|---|---|---|---|
| 1 | OUTPUT FORMAT 示例（`:168-186`）**不含** `requiresContextVersion`/case 级 `ruleContext`/`evidenceRefs`，而 V2 指令与双层校验定为必须 → 照抄示例必被拒 | `:168-186` 逐行确认：示例含 `taskId/sourceScribeArtifactId/implementationSummary/sourceTrace/risks/implementationCode/goldenTraceCases/affectedTools/generatedAt`，**确无**三字段；V2 指令 `:264-269` 三项必须；双层校验 `artificer-output.ts:305-311,388-394` + `artificer-runner.ts:537,562-571` | **CONFIRMED** |
| 2 | `"CONTEXT MODE block above"` 方向错误（`:245-246` 第一段，块拼接在其后 `:357-358`） | 见 C-1 | **CONFIRMED** |
| 3 | 两份「等价」schema 漂移：typebox 有 `ruleContext: Optional(Unknown)`（`:33`）而 @sinclair case 定义**无** ruleContext（`artificer-output.ts:81-95`）；typebox **完全无 `evidenceRefs`**（rg 证实）而 @sinclair 有（`:105`）；「field-for-field equivalent」声明（typebox `:18-19,51-53`）为假 | 全部核实：typebox `:43` `ruleContext: Type.Optional(Type.Unknown())`；@sinclair `:81-95` case 对象**确无** `ruleContext` 键；typebox 全文 `evidenceRefs` **0 命中**（grep -c = 0）；@sinclair `:105` 有；typebox `:18-20` OK 与 `:59-61`「Field-for-field equivalent」；另 `:29`「Field-for-field equivalent」 | **CONFIRMED**（**注**：`:51-53` 实为 `ArtificerSourceTraceTypebox` 定义而非等价声明——报告把 sourceTrace 行号与等价声明的行号并列引用，属**行号并置略偏**，不影响结论。见 S-4） |
| 4 | prompt 禁止集（`:213`：imports/require/eval/Function/I-O/network/timers/Date.now/randomness）与 validator 禁止集（`rule-code-validator.ts:27-65`，20+ 模式）**双向**不重合；反向 validator **不禁** `Date.now` | `:213` 原文确认；`:27-65` 计数 = **27 条 pattern**（含 export/async/await/process/globalThis/global/Reflect/Proxy/constructor/Buffer/setImmediate/queueMicrotask/XMLHttpRequest/crypto/import.meta/WeakRef/FinalizationRegistry/SharedArrayBuffer/Atomics/bracket-access）；validator 中 `Date.now` **0 命中** | **CONFIRMED** |
| 5 | prompt 未传授 `matched:false ⇒ decision:'allow'`；静态 `rule-code-validator.ts:110-132` + 运行时 `rule-host-validator.ts:107-124` 硬校验 | `:110-132` 实现存在；`rule-host-validator.ts:107-124` 跨字段检查存在；artificer prompt `:200-203` GOOD/BAD 示例确未提该不变量 | **CONFIRMED** |
| 6 | 示例 `"toolName":"write"`（`:181-184`）/`"affectedTools":["write"]`（`:186`）与 `:207` 宿主真名要求矛盾 | `:181-182` case toolName = `"write"`；`:184` affectedTools = `["write"]`；`:207` 要求真实宿主 rawToolName | **CONFIRMED** |
| 7 | propose_correction 口径：prompt `:215` 全禁；validator v1 接受（`artificer-output.ts:125,187-195`）、仅 v2 禁（`:297-304`）；TypeBox 亦接受（`:87-91`） | 四点全部命中 | **CONFIRMED** |
| 8 | 头注释称 maxTurns 默认 8（`:83-84`）vs 常量 `DEFAULT_MAX_TURNS = 12`（`:107`） | `:83` 原文 `/** Max agent-loop turns before forced stop (default 8). */`；`:107` `const DEFAULT_MAX_TURNS = 12;` | **CONFIRMED** |
| 9 | Scribe/Artificer 职责无重叠；重叠仅 risks 数组 + `artifactKind='principle'` | 核实成立（scribe 产 principleDraft+intentContract，artificer 产代码化实现；两者均产 risks 与 principle kind 工件）；intentContract 优先级单向声明：artificer `:165`「intentContract wins」、evaluator `:182-183`「DEFINITION of correctness」 | **CONFIRMED** |

**scribe 卡（5 条）**

| # | 报告结论 | 核实 | 判定 |
|---|---|---|---|
| 1 | prompt 宣布 "intentContract is REQUIRED"（`:101`），类型层刻意 Optional（`scribe-output.ts:37-45,69-72`）；新输出缺 intentContract **能过校验** | `:101` 原文确认；`scribe-output.ts:45` `readonly intentContract?: IntentContractV1;`；`:72` `Type.Optional(Type.Unknown())`；validator `:163-167` 只在**存在**时校验 | **CONFIRMED** |
| 2 | `title ≤100 chars` 为 prompt-only；validator 只查非空（`:124`）；超长标题可能被 `extractPrincipleIdFromArtifact` 当 principleId 兜底（`evaluator-runner.ts:2819-2825`） | `scribe-prompt-builder.ts:56` 含 `<=100 chars`；`scribe-output.ts:124` 只查非空；`evaluator-runner.ts:2819-2825` 在 `extractPrincipleIdFromArtifact` 内（标题截取逻辑） | **CONFIRMED** |
| 3 | intentContract 与 principleDraft 一致性只在 prompt（`:103`），validator 只查五个非空字符串 → 「corrupted anchor」无机器防线 | `:103` 原文「SAME intent at different precision」；`intent-contract.ts:54-64` 只查五个非空 string | **CONFIRMED** |
| 4 | scribe 与 rolloutReviewer 用裸 `JSON.stringify`（`scribe-prompt-builder.ts:151`；`rollout-reviewer-prompt-builder.ts:91`，无上限）；evaluator/artificer 用 50k 封顶（`prompt-serializer.ts:12,57-59`） | `:151`/`:91` 确认；`prompt-serializer.ts` `MAX_PROMPT_CHARS = 50_000`（**:1**），超限抛 RangeError 在 **:49-51** —— 报告引用的 `:12,57-59` **全部越界/错位**（该文件仅 53 行；`:12` 是注释行、`:57-59` 不存在） | **DRIFT**：结论成立，行号应修正为 `prompt-serializer.ts:1,49-51`。见 §4 漂移表 |
| 5 | Scribe vs Artificer 无职责重叠；灰色地带是 `validationExpectation` vs evaluator Part A 三维并存且无冲突消解规则 | 核实成立（scribe prompt `:92` 定义 validationExpectation；evaluator prompt `:182-188` 定义 Part A 三维；无交叉引用/优先级规则） | **CONFIRMED** |

**rolloutReviewer 卡（6 条）**

| # | 报告结论 | 核实 | 判定 |
|---|---|---|---|
| 1 | `needs_revision` 无 requiredChanges 非空硬约束（evaluator 有）；prompt 明示可空（`:60`） | `rollout-reviewer-output.ts:102-107` 只查数组；`evaluator-output.ts:470-474` 有不变量；`rollout-reviewer-prompt-builder.ts:60` 「(can be empty)」 | **CONFIRMED** |
| 2 | 与 evaluator 评审维度重叠且输入更弱：唯一输入是 evaluator 工件（`:446-453`），不接触 artificer 代码/原则原文/宿主目录/intentContract；safetyChecks/rolloutRisks 全自由文本无机器校验或消费点 | `:446-453` 确只传 `evaluatorArtifact`；全仓 `rg` 确认 `safetyChecks`/`rolloutRisks` 无写入以外的读取者 | **CONFIRMED** |
| 3 | confidence 直接驱动自动晋级（`activation-dispatcher.ts:264-267`），阈值 0.8/0.5（`:131-132`） | `:265-270` `needsApproval` → `decideAutoPromotion(input.channel, input.confidence)`；`approval-queue.ts:17-22` + `activation-types.ts:15` 阈值 **0.95**；`:131-132` 文案阈值 0.8/0.5 一致 | **CONFIRMED**（细节注：真正放行的阈值是 `AUTO_PROMOTION_CONFIDENCE_THRESHOLD = 0.95`，`:131-132` 的 0.8/0.5 仅用于**文案分级**；报告把两者并列引用，读者可能把 0.8 误当放行阈值。见 S-5） |
| 4 | validator/fetch 信任边界弱化：接口收 `RolloutReviewerOutputV1` 而非 unknown（`:69-71`）+ `as` 双跳（`:95,113`；runner `:513`） | 四点全部命中：`:70` `validate(output: RolloutReviewerOutputV1, ...)`；`:95`/`:113` `as unknown as Record<string, unknown>`；`rollout-reviewer-runner.ts:513` `return result.payload as RolloutReviewerOutputV1;` | **CONFIRMED** |
| 5 | Layer 0 摘要链断点：工件无 summary envelope（`:547-556` 裸 stringify）；`SummaryRunnerKind` 白名单排除 rollout_reviewer（`artifact-summary.ts:27-40`） | `:553` `contentJson: JSON.stringify(ctx.output)`；`artifact-summary.ts:37-45` 8 个 kind **确无** `rollout_reviewer` | **CONFIRMED** |
| 6 | 修订反馈语言硬编码中文（`:952-954`） | `:952` `'Rollout review 判定 needs_revision,请修订后重新走验证链:'`；`:954` `'- 必须修改: '` | **CONFIRMED** |

**交叉核对结论（四代理联合视图，5 点）**

| # | 报告结论 | 核实 | 判定 |
|---|---|---|---|
| 1 | 评分/评审维度重复：evaluator（score+decision+codeReview 三维+确定性重放）vs rolloutReviewer（confidence+decision+自由文本），无冲突但高度重复，后者证据面更窄；confidence 无锚却参与自动晋级 | 逐点确认（输入面：rollout 仅 `:446-453` evaluator 工件；自动晋级：`activation-dispatcher.ts:265-270`） | **CONFIRMED** |
| 2 | artificer prompt ↔ rule-code-validator 双向不重合 | 见 artificer 卡 4/5 | **CONFIRMED** |
| 3 | scribe ↔ artificer 职责不重叠；风险在 intentContract「生成一次、三处消费、无一致性校验」（`intent-contract.ts` + `evaluator-runner.ts:3250-3253` 转发） | `evaluator-runner.ts:3250-3253` 逐字转发确认；但行号应为 `:3250-3253`（报告写作 3250-3253 ✅ 命中） | **CONFIRMED** |
| 4 | 规则工件血缘链各环节均有 id 交叉校验与 echo 校正，**未发现 id 断链**；最脆弱是 intentContract 与 `artifactKind='principle'` 四义复用 | **与报告自身 §1.3 R-01 矛盾**：R-01 已登记 scribe→artificer 跳的 dreamer 血缘命名断链 + `resolveDreamerContext` 静默 undefined；核实确认在 `70d824c4` 上成立（`artificer-runner.ts:273-281` 两处 `return undefined`，零事件）。本条声明的链包含该跳，故「未发现 id 断链」范围过宽 | **DRIFT**（内部结论需一致化；见建议 S-11） |
| 5 | 交叉核对给出的两处「最脆弱语义连接」 | intentContract（无一致性校验）+ artifactKind 四义复用——两点均已在卡片层 CONFIRMED | **CONFIRMED** |

### 3.3 R 项最高标准复核（R-01 / R-02 / R-03 / R-09 / R-13）

| R | 报告核心断言 | 核实（`70d824c4`） | 判定 |
|---|---|---|---|
| R-01（P1） | philosopher 产物字段叫 `sourceDreamerArtifactId`，scribe prompt 却让找 `dreamerArtifactId`；字段可选且无权威校验；省略时 artificer `resolveDreamerContext` 静默返回 undefined **且不发任何事件** | `philosopher-output.ts:24,42` = `sourceDreamerArtifactId` ✅；`scribe-prompt-builder.ts:78` = `"dreamerArtifactId"` ✅；`artificer-runner.ts:271` `if (!isRecord(scribeParsed)) return undefined;` ✅ **无事件**；`:274-277` 无 sourceTrace 时 `return undefined` ✅ 无事件；`:279-281` 无 dreamerArtifactId 时 `return undefined` ✅ 无事件。命名断链 ✅；静默段 ✅ | **CONFIRMED** |
| R-02（P1） | artificer 示例违反 v2 硬契约 + 「CONTEXT MODE block above」方位自指错误 | 见 artificer 卡 1/2，全部命中 | **CONFIRMED** |
| R-03（P1） | typebox **完全无** `evidenceRefs`、`@sinclair` 有且 v2 必填、「field-for-field equivalent」宣称**为假**；示例缺三字段；V2 指令确为 MUST | `evidenceRefs`：typebox `grep -c` = **0** ✅；@sinclair `:105` 有 ✅；v2 必填 `:388-394` ✅；等价声明 `:18-20` + `:59-61` 均为「Field-for-field equivalent」✅；示例缺三字段 ✅；V2 指令 `:264-269` 全为 MUST ✅。**全部核心断言成立**。唯一瑕疵：报告把「等价声明」的行号写作 `typebox:18-19,51-53`，其中 `:51-53` 实为 `ArtificerSourceTraceTypebox` 定义（`:59-61` 才含第二条等价声明） | **CONFIRMED**（行号并置略偏，见 S-4） |
| R-09（P2） | `progressive_evaluator` 开启时 `implementationFidelity.score` 阈值 0.7 判据读取的字段**根本不在** evaluator 输出 schema/prompt 中 → undetermined 恒非空、Stage1 短路不可达、双倍 LLM 调用 | `progressive-evaluator.ts:26` 阈值 ✅；`:166-179` 读取 ✅；`evaluator-output.ts` 全文 `implementationFidelity` **0 命中**（`git grep` 仅 progressive-evaluator.ts + 测试） ✅；prompt-builder 中 `implementationFidelity` **0 命中** ✅；`evaluator-runner.ts:606-611` 短路条件 ✅ | **CONFIRMED** |
| R-13（P2） | rolloutReviewer `needs_revision` 无 requiredChanges 非空硬约束；prompt 明示可空 → 盲目修订轮；自报 confidence 无锚却参与 decideAutoPromotion 免审晋级 | 全部命中（见 rollout 卡 1/3）。**注**：报告 R-13 证据串写作 `rollout-reviewer-output.ts:102-107,60`，其中 `:60` 是**空行**（文本 "can be empty" 在 `rollout-reviewer-prompt-builder.ts:60`）——跨文件行号混写 | **CONFIRMED**（行号跨文件混写，见 S-6） |

### 3.4 C-4 L2 驱动面

| 项 | 报告结论 | 核实（`70d824c4`） | 判定 |
|---|---|---|---|
| maxTurns 注释 vs 常量 | 头注释称 maxTurns 默认 **8**（`:83-84`），实际 `DEFAULT_MAX_TURNS = 12`（`:107`） | `:82` `/** Max agent-loop turns before forced stop (default 8). */`；`:107` `const DEFAULT_MAX_TURNS = 12;`；`:193` `this.config.maxTurns ?? DEFAULT_MAX_TURNS` | **CONFIRMED** |
| abort 语义描述与代码一致 | budget 定时器触发 abort 并区分 `timedOut`（`:200-202`）；`cancelRun` abort 且不误判超时（`:425-436`）；无 submit 即抛 `PDRuntimeError(timeout\|output_invalid)`，无 V1/降级回退（`:390-408`） | `:196-202` `AbortController` + `budgetTimedOut` 标志 ✅；`:425-436` `cancelRun` 独立状态 ✅；`:382-408` 成功取 capture → 否则 `runState.status = timedOut ? 'timed_out':'failed'` 并 throw ✅；`:390-391` 注释「no V1/L1 fallback」✅；`:345-376` 流错误经 `stopReason` 捕获 ✅；`:283-284` + `:312-333` nudge ≤2 ✅；`:301-304` `shouldStopAfterTurn` ✅；`:295-300` 白名单 ✅；`:228-238` 4 工具协议 ✅；`:207-210` 50k 截断 ✅ | **CONFIRMED** |
| `l2-agent-loop-adapter.ts:351/353` 双 merge 与 §0.1 工具协议层描述一致 | §0.1 称工具协议层仅 L2 适配器有，静态说明在 `l2-agent-loop-adapter.ts:351` | `:351` `mergeSystemPromptLayers(input.systemPrompt, toolInstruction, this.config.systemPrompt)`；`:353` `baseSystemPrompt = mergeSystemPromptLayers(input.systemPrompt, this.config.systemPrompt)`（L1 回退变体）。§0.1 的 `:351` 引用**正确**；`mergeSystemPromptLayers` 定义在 `system-prompt-merge.ts:18-26`，`pi-ai-runtime-adapter.ts:588` 为 base+append 双 merge | **CONFIRMED** |

---

## 4. 行号漂移修正表

| # | 报告引用 | 源事实 | 修正 | 影响 |
|---|---|---|---|---|
| D-1 | `prompt-serializer.ts:12,57-59`（scribe 卡 4；artificer 卡正文；evaluator 卡正文同样引用 `:12,57-59`） | 文件共 **53 行**；`MAX_PROMPT_CHARS = 50_000` 在 `:1`；超限 `throw new RangeError` 在 `:49-51`。`:12` 是注释行、`:57-59` **不存在** | **`prompt-serializer.ts:1,49-51`** | 低（结论不受影响） |
| D-2 | `artificer-output-typebox.ts:77-96`（artificer 卡「输出 Schema」段 L2 契约行） | 文件共 **75 行**（`awk END{NR}` 与 `wc -l` 均为 75/76 取决于尾行）；`ArtificerRuleOutputTypebox` 定义在 `:63-75` | **`artificer-output-typebox.ts:63-75`** | 低 |
| D-3 | `artificer-output-typebox.ts:18-19,51-53`（「等价声明」行号并置） | 等价声明在 `:17-20`（Consistency guarantee）与 `:59-61`；`:51-53` 是 `ArtificerSourceTraceTypebox` 字段定义 | **`artificer-output-typebox.ts:17-20,59-61`** | 低 |
| D-4 | `rollout-reviewer-output.ts:60`（R-13 证据串，指「prompt 明示可空」） | 该文件 `:60` 为空行；「can be empty」在 `rollout-reviewer-prompt-builder.ts:60` | **`rollout-reviewer-prompt-builder.ts:60`** | 低（跨文件行号混写） |
| D-5 | `l2-agent-loop-adapter.ts:351`（§0.1） | 正确。补充：`:353` 为 L1 回退变体 | 无需修正（补全描述） | — |
| D-6 | 全量机械校验结果 | 从 §5 抽出的 **95** 条 `file:line` 引用，逐条对 `70d824c4` 越界检查：**仅 1 条越界**（D-2） | 见上 5 条 | 低 |

> 说明：D-1/D-2/D-4 均为**引用行号错位**，全部结论经回源后仍成立。§5 的行号整体质量高（95 条仅 1 条越界 + 3 条并置/跨文件偏移）。

---

## 5. 完整性补记（NEW）

任务要求主动找「报告漏记」。以下 9 项均为核实期间发现、报告 §5 未覆盖或以过宽措辞覆盖的事实。

### NEW-1【P1】RuleCode 沙箱信任边界：静态门可被绕过，且 core 侧 vm 未隔离宿主 realm（报告未覆盖）

> 说明：以下为**只读能力探测**结论。核实过程**未执行任何文件写、网络、子进程或状态变更**；所有探测结果都是 `evaluate()` 返回值里回显的 `typeof`/版本字符串。

**第一步 — 静态禁止表可被字符串拼接绕过（`rule-code-validator.ts:27-65`）**

`checkForbiddenPatterns` 先用 `maskNonExecutableText`（`legacy-rule-contract-scanner.ts:80-164`）把**字符串字面量内容涂白**，再跑 27 条 pattern。其中 bracket-access 那条（`rule-code-validator.ts:64`）只匹配**字面量形式**的 `['constructor']`。以 `70d824c4` 的实际算法（含 masking）本地复现：

```
bracket_plain      i['constructor']['constructor']                    → 命中 []
bracket_concat     i['con'+'structor']['con'+'structor']              → 命中 []
proto_walk         Object.getPrototypeOf(i)['con'+'structor'][...]    → 命中 []
tmpl_concat        const k=`con${''}structor`; i[k][k]                → 命中 []
（对照）direct      i.constructor.constructor                          → 命中 ["constructor"]
```

即：把 `constructor` 拆成两段**拼接**即可零告警通过静态门。

**第二步 — `node:vm` 未隔离宿主 realm（core 两条路径）**

`production-gate-deps.ts:86-124` 的 `compileRuleCode`：

```ts
const context = vm.createContext(Object.create(null));
...
return (input, helpers) => Reflect.apply(evaluateFn, undefined, [input, helpers]);
```

`input` / `helpers` 是**宿主 realm 创建的对象**（`:111-112`；`refiner-sandbox-wrapper.ts:161-171` 亦然）。`vm.createContext` 只换全局对象，**不隔离 realm**，故规则可通过 `input.constructor.constructor` 取到宿主 `Function`。本地同时复现了 `createContext` + `Script.runInContext({timeout:1000})` 的同一语义，探测结果（返回值回显）：

```
{"decision":"allow","matched":false,"reason":"escaped:24.21.0"}                       // 宿主 process.versions.node
{"decision":"allow","matched":false,"reason":"child_process=object, fs=object, env.KEYCOUNT=82"}
```

**被约束程度（如实说明，避免误报等级）**

- **生产 live gate 不受本条影响**。其真实路径是 `host-runtime/src/rule-implementation-runtime.ts:1-57` 的**子进程**执行，且该文件 `:27-32` 的注释已明确记录同一逃逸模式（「宿主 realm 对象 → `.constructor.constructor` → 完整沙箱逃逸」），并已改为「只传 JSON 字符串 + 用 context 自身 intrinsics 构造调用输入」。`packages/openclaw-plugin/tests/core/sandbox-escape-regression.test.ts:32-70` 有对应回归（含 `constructor chain to process`、`bracket access to process` 等）。
- **受影响的是 core 侧两条预处理路径**：
  - `production-gate-deps.ts`（evaluator 的 `gateDeps`：确定性对抗重放 + `RuleHostWriter.canActivate` 的 sandbox 重放）；
  - `refiner-sandbox-wrapper.ts:153-171`（合成 input 直接以宿主对象传给 `evaluateFn`）。
  这两条处理的正是**尚未激活的 LLM 生成代码**——包括 L2 循环里模型用 `replay_rulecode` **自校验**时（`artificer-l2-tool-contract.ts:264-324` → `gateDeps.evaluateInSandbox`）。
- **权限影响**：逃逸后可触达的是**运行 PD 的本地用户权限**（`fs` / `child_process` / `env`）。因此这不是"远程提权"，而是**「沙箱」这一声明在激活前阶段不成立**——凡是把该重放读作"已隔离验证"的判断（含激活门、Owner 审批上下文）都会高估其证据强度。
- **定级理由**：P1 = 安全边界声明与实践不符 + 有确定性、可复现的能力证据。**核实员不代做修复方案**（章程 D9），选项列于 §6 建议 S-15。

**报告口径问题**：§5 artificer 卡第 4 条只讨论「system prompt 禁止集 ↔ validator 禁止集不重合」（prompt 薄、validator 厚），**未触及静态门本身可被绕过**，也未触及 vm realm 边界。§6 治理卡第 6 条的「fail-open」是**故障时放行**，与本条（**代码成功执行并越界**）性质不同。

### NEW-2【P2】`tasks.attempt_count` 与 `runs.attempt_number` 在 revision 窗口的双源不一致（对照 rc-7）

**链路（`70d824c4`）：**

- 写入侧：`base-peer-runner.ts:750-755` 传 `sourceAttemptCount: ctx.task.attemptCount`。
- 读取侧：`pitask-metadata.ts:257-263` `isFreshForNextAttempt(record, currentLeasedAttempt)` → `record.sourceAttemptCount === currentLeasedAttempt - 1`；`currentLeasedAttempt` 由 `base-peer-runner.ts:378` 从 `leasedTask.attemptCount` 取。
- lease 时 `lease-manager.ts:149-160`：`attemptNumber = (SELECT MAX(attempt_number) FROM runs WHERE task_id=?)+1`，随后 `UPDATE tasks SET attempt_count = attemptNumber`。

**核实员初判与被否证的假设（如实记录）：**

初判为「`revision-reopen` 把 `attemptCount=0` 会让 `lastValidatorErrors` 在整条 revision epoch 内不再回喂」。**回源后否证**：`tasks.attempt_count` 在下次 lease 时即被 `lease-manager` 重写为 `runs.attempt_number` 的递增值，两项随即重新对齐为同一数值体系，故新鲜度判定**在 revision 边界上不被打破**。

**仍成立的不一致（更窄，但真实）：**

`revision-reopen.ts:111-115` 的单条原子 UPDATE 把 `attemptCount: 0` 落库：

```ts
await stateManager.updateTask(taskId, {
  diagnosticJson: createPITaskDiagnosticJson(merged),
  status: 'pending',
  attemptCount: 0,
});
```

而 `runs.attempt_number` **不回退**。于是**在 reopen 完成到下次 lease 之间的窗口内**：

- `tasks.attempt_count` = `0`（revision-reopen 写入）
- 该任务最近一次 run 的 `runs.attempt_number` = 单调递增的历史值（如 `3`）

同一任务的「第几次尝试」出现**两个互相矛盾的持久化事实**。该窗口内的任何读取者（Console 展示、read model、以及任何以 `attemptCount` 做新鲜度/进度判定的代码）会读到 `0`。

**与 rc-7 的关系**：`rc-7-loop-state-freshness` 要求「当前状态 / 下一状态 / 已持久化状态」必须可区分。此处两个持久化字段对同一语义（attempt 序号）给出不同值，且**没有任何注释或约束说明以哪个为准**——正是 rc-7 想禁的那类语义模糊，只是在**双源**层面而非循环状态层面出现。

**报告口径**：报告 §2 第 462 行把 `lastValidatorErrors` 的新鲜度门列为 `pitask-metadata.ts:206-263`（引用正确），未涉及 `attemptCount` 的第二个写点（`revision-reopen.ts:114`），也未指出该双源。§5 四卡亦无涉及。

### NEW-3【P2】第二个语义过载持久化键：`pi_artifacts.source_task_id` + 唯一索引 = 覆盖语义

- 唯一索引：`CREATE UNIQUE INDEX idx_pi_artifacts_idempotency ON pi_artifacts(source_task_id, artifact_kind)`（`sqlite-connection.ts:393`）。
- upsert：`INSERT ... ON CONFLICT(source_task_id, artifact_kind) DO UPDATE SET artifact_id = excluded.artifact_id, ... content_json = excluded.content_json`（`sqlite-pi-artifact-store.ts:78-101`）。
- 后果：**同一任务 + 同一 kind 物理上只有一行**，且 `artifact_id` 也会被覆写。
- 与报告的关系：§5 evaluator 卡「持久化」段说「重放后的 adversarialResult 重持久化**同一工件**（`:1084-1094, :1175-1188`）」——行号与动作正确，但报告把它读作「同一工件被更新」的**事实陈述**，未点出这是**唯一索引强制的覆盖**、而非「可并存两份」。这使两件事不可观测：a) 重放前的评估工件**不会**留档（若重放前工件正是审计对象）；b) `artifact_id = excluded.artifact_id` 意味着若两次写入派生出**不同** artifactId，旧的 id 会**消失**（`pi-art-<taskId>-<runId>` 中 runId 变化即触发）。
- 报告的「`artifactKind='principle'` 四义复用」已覆盖 kind 维；**`source_task_id` 作为「同一键位承载多版本」的第二个过载点未被指出**。

### NEW-4【P3】`checkMatchedFalseDecisions` 在 refiner 直调路径上未生效（两沙箱路径检查集不对称）

| 沙箱入口 | `checkForbiddenPatterns` | `checkReturnStatementsMissingFields` | `checkMatchedFalseDecisions` |
|---|---|---|---|
| `production-gate-deps.ts:166,180,198`（生产 gateDeps） | ✅ | ✅ | ✅ |
| `refiner-sandbox-wrapper.evaluateInRefinerSandbox:264,276` | ✅ | ✅ | **✗ 未调用** |

若某调用点直接走 `evaluateInRefinerSandbox`（不经 `createProductionGateDeps`），`matched=false + decision='block'` 只能靠 VM 内 `validateRuleHostResult`（`production-gate-deps.ts:116-121` 的编译适配器 / 运行时）兜住。报告 artificer 卡第 5 条提到「静态 + 运行时」两道，**默认两道都覆盖所有路径**——事实是静态那道在一条路径上缺席。

### NEW-5【P3】rollout validator 的错误归因不精确（缺字段被报成 mismatch）

`rollout-reviewer-output.ts:82-84`：

```ts
if (output.taskId !== taskId) {
  errors.push(`taskId mismatch: expected ${taskId}, got ${String(output.taskId)}`);
}
```

未用 `Object.hasOwn` —— `taskId` **缺失**时 `got undefined`，错误信息与「存在但不匹配」不可区分。对照 evaluator（`evaluator-output.ts:442-446`）：`!Object.hasOwn` → `'taskId is missing'`，否则才 mismatch。该差异直接流入 `priorValidatorErrors` 回喂（`pitask-metadata.ts:206-263`）→ 模型拿到的是「mismatch」而非「你漏了 taskId」，降低自修效率。报告第 4 条只说了信任边界弱化（收类型化对象 + `as`），未指出**归因精度**。

### NEW-6【P3】`scribe` 的 `intentContract` 在 schema 层是 `Type.Optional(Type.Unknown())`

`scribe-output.ts:72`。报告写「类型层刻意 Optional 以兼容历史产物」，未点明 Optional 的**内层是 `Unknown`**。这意味着：任何按 schema 走的消费者（LLM 结构化输出校验路径、schema registry 派生的 UI/文档）对 `intentContract` **无任何结构约束**；只有手写 `DefaultScribeValidator:163-167` 存在时才硬校验。这把报告 scribe 卡第 1 条的严重度**升级**：不只是「缺字段能过」，而是「**任意形状**都能过 schema 层」。

### NEW-7【P3】`progressive_evaluator` 三 flag 组合下仍有一条路径未覆盖

§0.2 声明三层 flag 默认全 OFF。核实三 flag 的组合面（`artifact_summary_redundancy` × `context_manifest_budget` × `progressive_evaluator`）：

- `progressive_evaluator` ON + `context_manifest_budget` OFF：`evaluator-runner.ts:825-831` 仍调 `resolveContextInjectionAsync`，其首行（`base-peer-runner.ts:1249-1251`）在 flag OFF 时返回 `{mode:'disabled'}`，`resolved.mode === 'focused'` 不成立、`isStage2 && mode==='fallback'` 也不成立 → `resolutionOutcome` 停在 `{state:'fallback_other'}`（`:814-816`）→ `:617` 的 `required_unavailable` 分支**不触发**，Stage 2 **照常发**、但其 tier2 证据**静默缺失**（回退为全量 predecessor 注入）。
- 报告 §0.2 说了「manifest 层即使打开也因 summary 键碰撞跳过」（R-06），§5 evaluator 卡第 1 条说了 progressive 的 `implementationFidelity` 断层。**但两者乘积——progressive ON + manifest OFF 时 Stage 2 的「深证据」实际退化为普通全量注入，而 prompt/事件都不体现——未被任一条覆盖**。这条组合在 §0.2 的「待 Owner 裁决去留」清单里也不可见。

### NEW-8【P3】`owner-review.ts` 对四代理产物的消费口径：只认「最后写入的工件」

`owner-review.ts:244-272`：`collectOwnerDecisionFacts` 只接受 `taskKind ∈ {evaluator, rollout_reviewer}`（`:252`），然后用 `expectedArtifactId = context?.sourceArtifactId ?? decisionArtifactIdFor(taskId, sourceRunId)`（`:261-262`）在 `listArtifactsBySourceTask(taskId)` 结果里 **find 单个匹配**（`:263-264`）。结合 NEW-3 的唯一索引（同 task 同 kind 只有一行），这四个代理的 NHR 裁决面**只能看到最终态工件**：

- evaluator 的 NHR（budget/exhausted/test-out-of-scope）发生时，若重放已覆写过评估工件，`detectHardGateFailureFromArtifact`（`:228-242`）读的是**覆写后**的 `adversarialResult.passed`；而该函数对「字段缺失」返回 `false`（`:234,238`）——即**缺失与通过不可区分**（rc-9 的可观测性缺失，与 evaluator 侧 `adversarialResult` 剥离逻辑（`evaluator-runner.ts:941-944`）叠加后，该判定面只剩「显式 false」一个信号）。
- 报告 §5 evaluator 卡把 `hard gate` 描述为「Owner override 深度防御拒绝（`:1956-1969`）」，行号正确，但**未说明其事实输入来自这个「缺失即 false」的单点读取**。

### NEW-9【P3】`rule-code-validator` 与 prompt 词汇表的进一步不一致（在报告已列 27 条之外）

报告 artificer 卡第 4 条已指出「双向不重合」。核实补充两点**报告未展开**的不一致：

1. **`RULECODE_SPEC_TEXT`（L2 工具读到的 spec，`artificer-l2-tool-contract.ts:91-180`）也漏教**：其 FORBIDDEN PATTERNS 清单（`:114-118`）只列 20 项，**缺** `constructor`/`Buffer`/`WeakRef`/`FinalizationRegistry`/`SharedArrayBuffer`/`Atomics`/`import.meta`/`Proxy`（validator 有）。L2 循环里模型读的是这份 spec（`read_rulecode_spec` 工具），不是 system prompt。三份清单（system prompt / spec / validator）**三向不重合**。
2. **`RULECODE_SPEC_TEXT` 的 `matched=false` 规则（`:110-112`）与 system prompt 的 GOOD/BAD 示例（`artificer-prompt-builder.ts:200-203`）互补但都不完整**：spec 有规则、prompt 有示例，而**唯一会回喂给模型**的 `priorValidatorErrors` 错误文本来自 validator（措辞不同）。三套表述无单一权威。

### NEW-10【P3】`getBuiltinModule` 类逃逸无对应的静态 pattern

即使 NEW-1 的三个 `constructor` 变体被补进 pattern，逃逸仍有其它入口（`({}).__proto__.constructor`、`Object.getOwnPropertyDescriptor`、模板标签等）。**结论**：`checkForbiddenPatterns` 是**黑名单**，黑名单在 `node:vm` 同 realm 语义下**原理上不可能完备**；正确方向是 realm 隔离（`vm.createContext` 不传宿主对象 / `contextCodeGeneration` / `codeGeneration: {strings:false, wasm:false}` / 或复用 `rule-implementation-runtime` 的子进程模式）。这属**设计决策**，核实员不代做（D9）。

---

## 6. 建议修正清单（原文 → 建议文）

| # | 位置 | 原文 | 建议 |
|---|---|---|---|
| S-1 | §5 抬头 | 「审计日期：2026-09-15（…）… 所有 `file:line` 相对仓库根 `D:\Code\principles`」 | 建议补一句可复现性说明：**「基线 = GitHub main @ `70d824c4`；本报告分支检出树比基线领先 51 个提交，其中 PR #1693 / #1698 与 `afa95651` 已改写 §5 的 artificer-L2、rolloutReviewer 相关代码——在报告分支上复现时请以 `git show 70d824c4:<path>` 为准。」** |
| S-2 | §5 evaluator 卡「系统提示词全文」段末 | 「源码中两处 `\`intentContract\`` 转义反引号按运行时实际字符串呈现」 | → 「源码中**一处** `\`intentContract\`` 转义反引号（`evaluator-prompt-builder.ts:182`）」 |
| S-3 | §5 artificer 卡第 2 段引用块 | 起始行直接是 `CONTEXT MODE: v2 (Owner-labelled evidence is present)` | → 在引用块前加一句「该模板以换行起（`:261` 的 `\`` 后即 `\n`），拼接时会在第 1 段与本段之间产生空行」 |
| S-4 | §5 artificer 卡第 3 条 / R-03 证据串 | 「"field-for-field equivalent" 声明（typebox :18-19,51-53）为假」 | → 「（typebox `:17-20,59-61`）为假」；并注明 `:51-53` 是 `ArtificerSourceTraceTypebox` |
| S-5 | §5 rollout 卡第 3 条 / R-13 | 「阈值 0.8/0.5（:131-132）」并置「经 decideAutoPromotion 参与低风险自动激活」 | → 「**放行阈值 `AUTO_PROMOTION_CONFIDENCE_THRESHOLD = 0.95`**（`activation-types.ts:15`）；`:131-132` 的 0.8/0.5 仅用于审批文案分级」 |
| S-6 | §5 R-13 证据 / 第 1 条 | `rollout-reviewer-output.ts:102-107,60` | → `rollout-reviewer-output.ts:102-107` + `rollout-reviewer-prompt-builder.ts:60`（跨文件） |
| S-7 | §5 全部 `prompt-serializer.ts:12,57-59` 引用 | 同 | → `prompt-serializer.ts:1,49-51` |
| S-8 | §5 artificer 卡「输出 Schema」段 L2 契约 | `artificer-output-typebox.ts:77-96` | → `artificer-output-typebox.ts:63-75` |
| S-9 | §5 scribe 卡第 1 条 | 「类型层刻意 Optional 以兼容历史产物（scribe-output.ts:37-45,69-72）」 | → 增补「`:72` 为 `Type.Optional(Type.Unknown())`：schema 层对内容**零约束**，仅手写 validator 硬校验」 |
| S-10 | §5 evaluator 卡输出 Schema 表 `adversarialCases` 行 | 「可选，存在则逐元素校验」 | → 「可选；存在则校验 caseId/attackType/toolName/params/expectedDecision/rationale 的**存在与类型**及可选 `ruleContext` 的结构；**不校验**数量、attackType×expectedDecision 组合语义」 |
| S-11 | §5 交叉核对第 4 点 | 「规则工件血缘链（dreamer→…→rollout→activation/dispatch）各环节均有 id 交叉校验与 echo 校正，未发现 id 断链」 | → 「**除 §1.3 R-01 已登记的 dreamer→scribe→artificer 命名跳（`sourceDreamerArtifactId` vs `dreamerArtifactId`，静默 undefined）外**，其余各跳均有 id 交叉校验与 echo 校正」——本条与 R-01 目前互相矛盾，需择一为准 |
| S-12 | §5 evaluator 卡第 7 条（工件哈希） | 「`computeArtifactContentHash`（owner-review.ts 导出，artifact-content-hash.ts:119-121）仅在 needs_human_review 上下文计算」 | → 明确两函数不同：「`owner-review.ts:134-136` 的 `computeArtifactContentHash`（NHR reviewKey）；`artifact-content-hash.ts:119-121` 的 `computeContentHash`（Layer-0 摘要信封）」 |
| S-13 | §0.2（管道级事实） | 「渐进式披露三层全部默认休眠」+ 三条 flag 列举 | → 补记组合路径：**`progressive_evaluator` ON 且 `context_manifest_budget` OFF 时，Stage 2 的 required tier2 门不触发（`evaluator-runner.ts:814-816,617`），深证据静默退化为全量 predecessor 注入**（见 NEW-7） |
| S-14 | §5 全节 | 未覆盖沙箱信任边界 | → 在 artificer 卡新增一条候选嫌疑（原文照 NEW-1 摘要），或至少在 §5 抬头声明「本报告不评估 RuleCode 沙箱逃逸面，见 VERIFICATION-C.md NEW-1」 |
| S-15 | §5 全节（设计决策，不代做） | — | → 建议 Owner 就 NEW-1 在以下选项中裁决：**(a)** core 两条路径改用「只传 JSON 字符串 + context 自身 intrinsics」（对齐 `rule-implementation-runtime.ts:27-32` 的既有加固）；**(b)** 统一走子进程沙箱（把 `rule-implementation-runtime` 的边界提升为共享实现）；**(c)** 保留现状但把「sandbox」在文档/激活门文案中降级为「静态+受限执行」，并登记为已声明的残余风险。核实员倾向 (a)（最小改动、与既有修复同构），但不实施。 |

---

## 6.1 核实员自身纠错记录（透明化）

核实过程有一处**核实员自身的判断错误**，如实记录：

- 初判 R-4 的理由为「报告分支树的 `principle_semantic` 模式在基线缺 `sourceScribeArtifactId`」。复核 `git grep -c 'principle_semantic' 70d824c4` = **0** —— 该模式在基线**根本不存在**（由 PR #1698 引入），故该理由**不成立**。
- 更正后的 R-4 依据：§5 交叉核对「未发现 id 断链」与报告**自身 §1.3 R-01（P1）**直接矛盾。该矛盾不依赖任何分支树差异，在基线上即可判定。
- 教训：引用「分支树已变」作为 DRIFT 理由前，必须先验证被引用的**符号**在基线上是否存在（本次漏了这一步）。

## 7. 核实方法与可复现性

- 证据读取：`git show 70d824c4:<path>`（未 checkout 切换；当前交付分支 = `ai/cnb-dev/issue-30`，基于触发指令）。
- 行号校验：从 §5 正则抽取 95 条 `file:line`，逐条与 `70d824c4` 对应文件行数比对（越界 1 条）。
- 提示词对比：从 TS 源**程序化提取**模板字符串（含 JS 转义还原、`${...}` 注入点占位归一化），与报告代码块逐字符 diff。
- 沙箱验证（NEW-1/NEW-10）：在 `node -e` 中以 `70d824c4` 的 `normalizeSource` / `vm.createContext` 语义**只读复现**能力探测；未执行任何文件写、网络、或子进程操作。
- 未做的事（如实声明）：
  - 未运行仓库测试套件（只读核实任务；检出无 `node_modules`，`npm ci` 不在授权范围且会改动工作区）。
  - 未做 live 运行时取证（`~/.pd/` 状态库、实际 flag 组合下的行为）。
  - 未评估 §5 以外章节（§1–§4、§6、§7 不在本次管辖）。
  - NEW-1 的逃逸仅在 core 侧两条路径复现；**未**在 `host-runtime` 生产子进程路径上尝试（其源码注释与既有回归测试表明该路径已按 JSON-字符串契约加固，核实员不重复攻防）。
- 只读承诺：本次核实未修改任何已存在文件（含 REPORT.md）；唯一新增 = 本文件。

---

## 8. 结论

- **报告 §5 的核心事实质量高**。按条目计 52 项：CONFIRMED 47、REFUTED 2、DRIFT 3、UNVERIFIABLE 0。具体：
  - C-1：四代理六段提示词全文**逐字比对全部通过**（10/12 行 CONFIRMED）；含任务重点的 artificer「V2 拼接顺序 + `CONTEXT MODE block above` 方位词」问题，**属实且描述精确**。
  - C-2：五张字段表的类型 / 必填性 / 不变量 / v1-v2 分支**全部与源码一致**。
  - C-3：四卡 27 条 26 CONFIRMED；交叉核对结论 4/5 CONFIRMED，1 项范围需收紧。
  - C-4：L2 驱动面 3/3 CONFIRMED（8 vs 12 注释不一致、abort 语义、双 merge 与 §0.1 一致）。
  - R 项：R-01 / R-02 / R-03 / R-09 / R-13 五条核心断言**全部成立**（R-03 仅行号并置偏移）。
- **须更正的实质项 3 处（2 REFUTED + 1 DRIFT）**：
  1. R-1（REFUTED）evaluator 卡「两处转义反引号」→ 实为 1 处（`:182`）。
  2. R-2（REFUTED）evaluator 卡 `adversarialCases`「逐元素校验」→ 只说对了字段存在/类型，**未校验数量与组合语义**。
  3. R-4（DRIFT / 内部结论矛盾）§5 交叉核对「未发现 id 断链」与报告自身 §1.3 R-01（scribe→artificer 命名断链）互相矛盾 → 需择一为准（建议 S-11）。
  另有 2 处纯引用类 DRIFT（`prompt-serializer.ts` 行号、artificer V2 段起始换行），不影响结论。
- **报告 §5 的实质缺口（非报告错误，而是覆盖边界）**：
  - **NEW-1（P1）RuleCode 沙箱信任边界未覆盖**：静态禁止表可被 `'con'+'structor'` 拼接绕过；core 两条路径的 `node:vm` 未隔离宿主 realm，可触达 `fs` / `child_process` / `env`（实测只读能力探测）。生产 live gate 的子进程路径已加固，**不受影响**。修复方向属设计决策，核实员列选项不代做（S-15）。
  - **NEW-3（P2）第二处语义过载键**：`pi_artifacts` 唯一索引 `(source_task_id, artifact_kind)` + upsert 覆盖 `artifact_id`，使 evaluator 重放前后的评估工件**无历史留档**。报告的「四义复用」只覆盖 `artifact_kind` 维。
  - **NEW-2（P2）`attemptCount` 双源不一致**：`revision-reopen.ts:114` 的 `attemptCount: 0` 与 `runs.attempt_number` 在 reopen 窗口内矛盾（对照 rc-7）。
- **报告「主干编排健康、断裂集中在语义一致性面」的总判断，在本次管辖范围内成立**：四卡 27 条中无一条是状态安全 / 数据丢失类缺陷，全部是 prompt↔validator 口径差、类型在场无消费者、命名与枚举漂移。**唯一例外是核实员新增的 NEW-1**（安全边界声明与实践不符），它不在报告的四卡嫌疑里，属**覆盖面缺口**而非判断错误。
