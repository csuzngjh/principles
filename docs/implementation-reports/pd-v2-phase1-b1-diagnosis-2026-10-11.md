# PD v2 Phase 1 B-1 工程诊断报告（只调查、不实施）

> 日期：2026-10-11（Asia/Shanghai）；**r2 修订：2026-10-11（同日，按独立复核修正过度推断并补齐有限证据）**
> 调查对象：Phase 1 验收缺口 B-1（强制证据链 BLOCKED 于规则内化阶段的确定性重放失败）
> 固定调查 commit：`11fd5090`（origin/main = PR #1980 的 squash merge commit，2026-10-10T14:52:42Z 合并；#1980 head `e37b7efc` 已核实为该 squash 的内容）
> 工作区：adhoc 诊断 worktree `D:\Code\_worktrees\principles\adhoc-20261010-b1-diagnosis-offline-diagnosis`（分支 `ai/adhoc-20261010-b1-diagnosis-offline-diagnosis`）
> 版本：r1 = `5604e30c`；r2 = 评审修正轮；r3 = 最后两项修正（r9-proxy 失败位置更正 + S8b/c 重做为 A-r1 Before=5/After=0 同规则同投影对照，见 §11）
> 性质声明：本轮只调查与提出建议，未修改任何生产代码、validator、oracle、gate、模板、Owner pack、ADR 或安装目录；未创建 PR。历史数据库只读打开；离线对照全部使用标注为「离线诊断对照」的临时副本；未运行真实宿主或 LLM。
> 独立复核记录：`D:\Code\_worktrees\principles\adhoc-20261010-pr1980-review-82bd4e-contract-review\.tmp\B1-DIAGNOSIS-5604e30c-REVIEW.md`（本轮的全部修正由此触发，逐项回应见 §11）。

---

## 1. Executive Summary

**阻塞点（维持 r1 结论）**：确定性 gate 模板 `v2-path-boundary` 的写目标由 **`affectedTools[0]`（工具）× `positiveCases[0].params.path`（路径）** 两个互不配对、互不校验的序列拼出——本链上工具来自模型的 write 声明、路径来自 Owner 标注的 `ls {"path":"."}` 观测，字符串拼接后得到 `..bak`；oracle 对该非 helper 路径硬编码期望 `block`，而链上真实产出的规则（受保护标记匹配语义）返回 `allow`。三次 evaluator 失败全部落在这一条确定性用例上。该解释在生产忠实投影下与两种投影下均稳健（§4.5-S9/S3b）。

**r2 修正（相对 r1 的实质变化）**：

1. **撤回「任何确定性规则不可能同时通过正例与模板」「helper 段是唯一可满足类」两条普遍化结论**。独立复核构造的反例规则（risk→block；available∧未截断∧priorRead=no∧readCount>0→block；其余 allow）在本轮同一生产 sandbox 中对「真实正例 + 5 条非 helper 模板」两组（原目标 `.` 与重排目标 `workspace/readme.md`）均 8/8 通过（`accepted_shadow`，`sandboxSuccess=true`）。r1 的错误在于只比较了两个字段（`history.status`/`priorReadOfTarget`）就断言「形状相同」——完整输入在 `params.path`、`history.calls`（0 vs 1）、`facts.readCount`（0 vs 1）三处不同，确定性规则完全可区分。**修改后的限定结论**：已证实的是「四条现有规则在该链证据集上失败于 `v2-path-boundary`；r1 的 r9-proxy 对照规则则通过全部五条模板、失败于模型自写正例 `case-pos-write-normal` / `case-pos-edit-normal`（`Expected allow but got block`）」——代理规则的失败位置与四条真实规则不同，二者不能混述；**测试通过与符合 Owner 意图是两个不同问题**——同一反例规则对完整原集失败于全部受保护负例（它不实现受保护拦截）（§4.5-S6）。
2. **r9 与 Owner 意图全部条件化**。r9 是否进入链 B 仍是 Unknown（mtime/命名/时间接近仅为旁证）；「Scribe 丢失该次 Owner 约束」改写为条件假设（若链 B 使用 r9，则存在待核查的派生保真问题）。r1 中「r9 是普适写前确认」与「r9 对普通路径没有断言」两处表述互相矛盾，r2 统一为一个解读（§4.3）。
3. **S5 升级为真实合并链取证（S5R）**。不再手工加 0+0：用持久化的 evaluator 输出确定 llmCases=0（输出键列表实测无 `adversarialCases`）、用当前宿主声明调用真实 `generateHostAliasCase`（四个工件全部 skip，reason=`no_host_tool_with_kind:other`，因为 alias 基准例恒为 case-negative-5=`ls`→other，而宿主声明无 other 类工具）、按生产合并顺序得到 merged=0。**结论限定**：「当前代码与当前声明可复现这一解释；历史 run 的实际执行情况尚未证实」——不再以「无 adversarialResult」单独证明历史 replay 未执行（§4.5-S5R）。
4. **r1 的「派生前置守卫」建议撤回，改为契约选项比较**。S8 离线对照证明：canonicalKind 不匹配即返回 `[]` 时，若 host-alias 或 LLM 用例非空，重放仍可 `accepted_shadow`——即**遥测不等于检查保持**。r3 补做的 Before/After 对照（真实 A-r1 工件 × 生产派生五条模板 × 生产 factory 投影）：**Before（正例＋5 条模板＋alias/LLM 用例）`rejected_validation_failed` 于 `v2-path-boundary`；After（同正例＋同 alias/LLM 用例、模拟守卫移除 5 条模板）`accepted_shadow`**——同一规则、同一投影，唯一差别是 5 条模板检查的有无（§4.5-S8）。且 canonicalKind 相同只证明类别相同、不证明同一动作（S8e 实测：edit→write 同类，模板目标取自 edit 样本路径）。本轮不实施守卫；「选择有效配对样本 / 明确拒绝无法派生的输入 / 可观测降级」三个选项的契约符合性比较见 §6.1，交 Owner 裁决。
5. **helper 重采降级为未验证的验收候选**。r1 的「B-1 解除依赖修复二」「唯一可满足类」表述全部删除。现有证据只覆盖：模板期望在 helper 段翻为 allow（代码 + 离线派生）；没有新内化链、没有受保护 write 拦截的实宿主闭环。原验收要求（protected write → runtime_verified → Behavior Episode → Effect Evidence → Owner Outcome Observation）保持不变（§6.2）。
6. **模板依据重新分级**。被引用的设计 SPEC（2026-06-27）顶部明示「本文其余内容保留为设计历史，不再是当前实施指令」；其 §10.1 验收表是设计历史，不能作为现行权威把全部 v2 模板限定为某规则族。可主张的现行事实是**代码级**的：`v2-path-boundary` 的期望值推导与 `v2-alias` 的场景构造在当前模板代码中编码了「写前先读」假设（含 EP002-R4 helper 豁免注释自证的先例）；现行 ADR（2026-06-28，Accepted）只建立 v2 契约与对抗 gate，未对 5 条模板的适用范围作出语义限定。模板调整是否需要 Owner 政策变化由 Owner 权衡，本轮不断言（§4.6）。
7. **复核补充观察的机制分解（§4.5-S7）**。「A 链两条规则分别失败 3 条和 2 条负例、B 链两条通过」仅在**未线程化 projectDir 的退化投影**下复现；生产 gate 调用链实际经 `createProductionGateDeps` 工厂默认线程化 `projectDir`+`toolSemantics`（production-faithful），在该投影下**四条规则全部通过各自完整原集**（`accepted_shadow`）。差异根源：A 链规则只读 `input.action.normalizedPath`，B 链规则另有 `paramsSummary.path` 回退；退化投影下 normalizedPath=null。「源码看起来要拦截 protected」与「真实 RuleHostInput 下确实返回 block」在本例中一致（生产忠实投影下四条规则都 block），但二者必须是两个独立检查——本轮已用输入转储实证（S7 inputDump）。

**下一步（最小实施建议，见 §6）**：本轮不给出「守卫＋重采即可解除」类结论。给 Owner 的是：①三个派生缺口处理选项的契约比较（待裁决）；②helper 段重采作为**未验证候选**的取证路径；③两项与 B-1 解除无关但已被证据指认的观测（evaluator 未显式传递 PRI-634-F 对齐字段、Scribe 派生保真）留作 follow-up 候选。Phase 1 保持 PARTIAL，B-1 未解除。

---

## 2. Baseline

| 项 | 值 | 证据 |
|---|---|---|
| 主工作区本地 main | `94ee6b7a`（落后于 origin/main） | `git log -n 1` |
| origin/main（固定调查 commit） | `11fd5090` = #1980 squash merge | `git log origin/main -n 1` |
| PR #1980 状态 | MERGED，mergedAt 2026-10-10T14:52:42Z，mergeCommit `11fd5090`，head `e37b7efc` | `gh pr view 1980` |
| #1980 净改动面 | 7 文件：artificer 提示词 v9→v10 + 义务文本单测 + 验收报告 r3 章节 + ERR-157 记录 + changeset；**gate/模板/校验器零改动** | `git diff ba39b469 e37b7efc --stat` |
| 诊断 worktree | `ai/adhoc-20261010-b1-diagnosis-offline-diagnosis` @ `11fd5090`；r1 提交 `5604e30c`（唯一改动=本报告）；工作区在 r2 开工时干净 | `git log`/`git status` |
| 历史库 | `D:\Code\_pdtest\p1-acceptance\sandbox\.pd\state.db`（24 表）与 `...\sandbox\.state\trajectory.db`（16 表），均只读打开，存在且可读 | dump 脚本（§7） |
| 遥测覆盖缺口 | `events_2026-10-10.jsonl` 止于 08:20（10 行）；`.pd/telemetry/critical-events.jsonl` 13 行无 gate 事件；无 09:00–09:45 窗口的 prompt/skip 事件字节落盘（L2 run `input_payload` 为 NULL） | 本轮文件检查 |
| 沙箱 host 声明 | `.pd/host-tool-semantics/openclaw.json`：declaredAt=2026-10-09T23:27:52.432Z，**文件 mtime 与 declaredAt 一致**（先于全部内化 run，首 run 2026-10-09T23:28:02Z）；mappings：`exec→execute, write→write, edit→write, apply_patch→write, sessions_spawn→agent`（无 read/search/other 类） | 文件读取 + `stat` |
| 环境事实 | 主工作区未知未跟踪文件全部保留未动；历史库只读连接 | `git status` |

历史行号核对说明：#1980 报告 §7.1 与本报告 r1 引用的 `evaluator-runner.ts:2988-3069 / :2638-2647 / :2660-2667 / :2755-2758`、`artificer-runner.ts:893-915 / :481-523`、`v2-adversarial-cases.ts:122-125 / :211-222`、`rule-reliability-validation.ts:123-131`、`refiner-rulehost-gate.ts:14-59 / :136`、`production-gate-deps.ts:325-332`、`evaluator-runtime-context.ts:80-98`、`rulehost-pipeline-runner.ts:453-505` 均在 `11fd5090` 上重新核对成立。

---

## 3. Production Reality Map

### 3.1 派生链（producer → consumer）

```text
Owner（人工）
  └─ --behavior-examples <file>            # 顶层 JSON：ownerDesiredOutcome + sourceNegativeToolCallId + positiveToolCallIds
      └─ pd-cli runtime-internalization-run-rulehost.ts:524-600
          └─ BehaviorExamplePackAssembler.assemble()   # openclaw-plugin/.../behavior-example-pack-assembler.ts:107-145
              │   # 从 trajectory.db 取 tool_call 行 id=5(负例)/id=6(正例)
              │   # caseId = `case-${kind}-${row.id}` → case-negative-5 / case-positive-6（buildCaseFromRow:232）
              │   # expectedDecision 由 kind 硬编码：negative→block、positive→allow（:126-127）
              │   # ruleContext 由行前历史装配（buildSelectedCase:147-162）
              └─ rulehost-pipeline-runner.ts（pd-cli services）:673 behaviorExamplePack 传入
                  ├─ ArtificerRunner（deps.behaviorExamplePack）
                  │    ├─ buildPrompt：pack 经 boundPackForPrompt 进入提示词；Owner 用例义务=v10 逐字回显（:305-306），
                  │    │   但【无任何位置/顺序/配对约束】；OUTPUT FORMAT 示例 affectedTools=["write"]（:201）
                  │    ├─ fetchAndParseOutput（artificer-runner.ts:893-915，EP002-R4）：同 caseId 条目在校验前被 pack 权威字节原位覆盖
                  │    └─ validateV2OutputContract（:481-523）：按 caseId 匹配存在性 + evidenceRefs 全等；【无顺序、无工具-路径配对校验】
                  └─ EvaluatorRunner（gateDeps + hostSemanticContext 同一 registry 快照，pipeline-runner.ts:465-505）
                       └─ executeDeterministicReplay（evaluator-runner.ts:2561-2760）
                            ├─ parseArtificerArtifact（:2808-2831）→ extractPositiveCases（:2886-2891，保序过滤 kind='positive'）
                            ├─ generateV2CasesFromArtificer（:2988-3069）
                            │    ├─ toolName  = affectedTools[0]（:2994-3008，回退正例 toolName）
                            │    ├─ targetPath= positiveCases[0].params.path|file_path（:3018-3045）
                            │    ├─ canonicalKind = canonicalizeToolKind(toolName)（:3047）
                            │    ├─ 非 write → 整批跳过 + 遥测（:3054-3063）
                            │    └─ 【无任何校验：工具与路径是否属于同一动作】→ generateV2ContextAdversarialCases（v2-adversarial-cases.ts:133-244）
                            ├─ generateHostAliasCase（:2913-2969）：基准=首个负例；本链恒为 case-negative-5（ls→other）
                            │    → 宿主声明无 other 类工具 → 全部工件 skip（S5R 实测）
                            ├─ 合并：v2Cases + hostAliasCase + llmCases（:2638-2647）；全空 → skipReason=no_adversarial_cases_after_merge（:2660-2667）
                            └─ gate 调用（:2755-2758）：evaluateRefinerRuleHostGate({code, goldenTrace}, gateDeps)
                                 └─ gateDeps=evaluatorContext.gateDeps=createProductionGateDeps({projectDir:workspaceDir, toolSemantics:registry})
                                      （evaluator-runtime-context.ts:96；工厂默认在 gate 未传 opts 时生效，production-gate-deps.ts:325-332）
                                      → 合成输入经 buildRuleHostAction 提取 params.path 并 normalize（rule-host-input-builder.ts:184-215/255-272）
```

### 3.2 oracle（期望值权威）

- `rule-reliability-validation.ts:123-131`：`v2TemplateOracleExpectedDecision` — `v2-unavailable/truncated/alias → allow`，`v2-path-boundary / v2-combination → block`（编译期事实）。
- `v2-path-boundary` 的期望在模板内部由 `isHelperPath`（`v2-adversarial-cases.ts:122-125`，仅认 `tmp/temp/draft` 段）决定：非 helper → block（:217）。
- PRI-703 出界逃生（`partitionV2OutOfScopeFailures`）只对 v1 规则可达；提示词强制 `requiresContextVersion: 2` 且校验器强制（`validateV2OutputContract:487`），本链全部规则为 v2 → 模板失败 in-scope，必然喂进修复循环。

### 3.3 模板语义的依据分级（r2 重写）

| 层级 | 内容 | 地位 |
|---|---|---|
| 设计历史 | `2026-06-27-rulecode-context-vision-design.md` §10.1 验收表（读后再写/路径边界/上下文不可用等 10 行） | 该 SPEC 顶部明示：除 flag 默认姿态被 ADR-2026-06-28 Amendment（PRI-780）取代外，「本文其余内容保留为设计历史，不再是当前实施指令」。**不能作为现行权威引用** |
| 现行 ADR | `2026-06-28-rulecode-context-v2.md`（Accepted）+ ADR-0014 amendment（对抗 gate/Evaluator 升 Core） | 建立 v2 上下文契约与对抗重放 gate 的存在与治理；**未对 5 条模板的语义适用范围作出限定** |
| 当前实现 | `v2-adversarial-cases.ts`：`v2-alias` 场景=「read targetPath 后 write targetPath → allow」；`v2-path-boundary`=「read targetPath、write targetPath.bak → 非 helper 段 block」，其代码注释自述「the template hard-coded block, but when the artificer's OWN positive case picked a helper path … rules that correctly allow helper-path writes then fail the case forever」（EP002-R4 先例：曾因 helper 正例把期望改为 allow——**代码级先例证明期望值可随样本路径类别调整**） | 可主张的现行事实：**boundary/alias 两例的期望值构造编码了「写前先读」假设**；这不是 5 条模板整体的权威性家族限定，也不自动等价于「调整模板=改变 Owner 政策」 |

---

## 4. Evidence Matrix

（run/工件时间均为 UTC，取自沙箱 `state.db` `runs`/`pi_artifacts`；工件 created_at 是**消费方物化时间**，故 artificer 工件时间戳等于其 evaluator run 的开始时刻。）

### 4.1 真实 run 链（r1 事实，r2 复核无变化）

| 链/轮 | scribe intent（工件时间） | artificer run（成功） | artificer 工件（时间/affectedTools[0]/正例序） | evaluator run | 结果 |
|---|---|---|---|---|---|
| A-r1 | 08:53:57（**无**"普通路径不干预"句） | 08:54:51 | 09:02:01 / `write` / `case-negative-5, case-positive-6, …` | 09:02:01 | `v2-path-boundary` block/allow 失败（工件 09:03:02 advResult.passed=false） |
| A-r2 | 同上 | 09:03:02 | 09:09:55 / `ls` / 同上 | 09:09:55 | 输出无 adversarialResult（工件 09:11:04 [evaluation]） |
| B-r1 | 09:21:29（**有**"普通路径不干预"句） | 09:24:26 | 09:33:13 / `write` / 同上 | 09:33:13 | 同一用例失败（工件 09:35:31 advResult.passed=false） |
| B-r2 | 同上 | 09:35:31 | 09:42:42 / `write` / 同上 | 09:42:42 | 同一用例失败（工件 09:44:08 advResult.passed=false） |

三次失败 failedCases 逐字一致：`{caseId:"v2-path-boundary", expectedDecision:"block", actualDecision:"allow", errorType:"validation_failed", message:"Expected block but got allow"}`。

### 4.2 判定 × 证据对照（E1–E14 为 r1 事实；E15–E20 为 r2 新增）

| # | 判定 | 证据 |
|---|---|---|
| E1 | 工具取 `affectedTools[0]`、路径取 `positiveCases[0].params.path`、无配对校验 | `evaluator-runner.ts:2994-3045`；S1 探针 4 工件复现 |
| E2 | Owner 正例恒为首条正例：`case-positive-6`（ls） | 4 工件 `positiveIds` 首位实测；prompt 对 Owner 用例只约束「逐字回显」无顺序约束（`artificer-prompt-builder.ts:305-306`），位置是模型遵循 OUTPUT FORMAT 布局的惯例 |
| E3 | `affectedTools[0]` 由模型输出决定 | 4 工件实测（A-r2 恰为 `ls` 在首位）；validator 不校验顺序 |
| E4 | `v2-path-boundary` 目标=`positiveCases[0].path + '.bak'`，期望由 isHelperPath 决定 | `v2-adversarial-cases.ts:211-222`；S1 派生 `{"path":"..bak","expected":"block"}` |
| E5 | oracle 硬编码 block；v2 规则无出界逃生 | `rule-reliability-validation.ts:123-131`；`validateV2OutputContract:487` |
| E6 | 四条现有规则源码为受保护标记匹配语义；**生产忠实投影下实测确实 block 受保护路径**（r2 强化：S7-PF 全过原集） | 4 个 implementationCode + S7 rows（PF 全 `accepted_shadow`）；字段读取实测（S7 inputDump.ruleFieldReading） |
| E7 | 模型自写正例 = 「write 普通路径 + calls=0 + readCount=0 + priorRead:'no' + 期望 allow」 | 4 工件正例 facts 实测（r2 补齐完整 facts，含 calls/readCount） |
| E8 | 对四条现有规则，把普通 write 正例提前仍失败 | v1-S3（退化投影）+ r2-S3b（生产忠实投影，target=`workspace/readme.md.bak`，4 规则同用例同消息失败） |
| E9 | r1 的 r9-proxy 对照规则**通过全部五条模板**、失败于模型自写正例 `case-pos-write-normal` / `case-pos-edit-normal`（`Expected allow but got block`）；失败位置与四条真实规则（`v2-path-boundary`）不同 | v1-S3（既有输出 probe-report.json）；**r2 限定**：这只否定「该代理规则可过整集」，不否定存在可通过全部模板+正例的确定性规则（见 E15） |
| E10 | 09:09:55（A-r2）判定改写（r2）：真实合并链 merged=0 可由当前代码+当前声明复现；历史执行未证实 | S5R（§4.5）：持久化输出无 `adversarialCases` 键→llmCases=0；真实 alias 生成 skip（`no_host_tool_with_kind:other`）→alias=0；v2 skip→0；**历史 skip 事件未落盘** |
| E11 | 负例=Owner 标注的 ls 失败（非未授权写入）；正例=普通目录 ls 成功 | trajectory `tool_calls` id=5/id=6 实测；装配器按 kind 硬编码 expectedDecision |
| E12 | r9 pack 新增受保护路径只读确认约束；时间线在链 B 之前（旁证） | `behavior-examples-r9.json` mtime 09:20:13Z + 文本实测；链 B dreamer 09:20:38Z；链 A 全部 run 早于 r9 mtime |
| E13 | 「对普通非受保护路径不触发冗余确认」句在两版 pack 中均不存在 | 两版 `ownerDesiredOutcome` 全文实测 |
| E14 | evaluator LLM 评判批评「对只读 ls 也 block」 | 09:33/09:42 evaluation.summary 实测；评判依据的 intentContract 是否等价于 Owner 文本=Unknown（E12 未证实） |
| E15 | **反例规则 8/8 通过「真实正例+5 条非 helper 模板」**（两组目标），同时**对完整原集失败于全部受保护负例** | S6：as-is `accepted_shadow`/success=true；reordered 同；full=`rejected_validation_failed`（3 负例 allow）——**撤回普遍不可满足论断；测试通过≠Owner 意图** |
| E16 | 复核补充观察 = 退化投影产物：PF 配置下四条规则全过各自完整原集；no-projectDir 对照下 A 链规则失败 3/2 条负例、B 链（有 paramsSummary 回退）通过 | S7 rows + inputDump（PF normalizedPath='protected/secret.txt' vs 对照 null）+ 字段读取实测 |
| E17 | 生产 gate 调用链实际线程化 projectDir+toolSemantics（工厂默认）；gate input 的 PRI-634-F 字段存在但 evaluator 未显式传递 | `evaluator-runner.ts:2755-2758`（仅 code+goldenTrace）→ `refiner-rulehost-gate.ts:136`（opts 空）→ `production-gate-deps.ts:330-331`（工厂默认补齐）；`evaluator-runtime-context.ts:96` |
| E18 | 守卫「mismatch→返回[]」在 alias/LLM 非空时可删 5 条模板检查而重放仍 accepted——**Before/After 实证**：真实 A-r1 工件、生产派生 5 条模板、生产 factory 投影，Before（5 模板）`rejected_validation_failed` 于 `v2-path-boundary`，After（0 模板，alias/LLM 用例保留）`accepted_shadow`（`sandboxSuccess=true`） | S8b/S8c（§4.5）|
| E19 | canonicalKind 相同 ≠ 同一动作 | S8e：edit→write 同类，守卫不触发，模板目标取自 edit 样本路径 `workspace/app.js(.bak)` |
| E20 | 设计 SPEC §10.1 为设计历史；现行 ADR 未限定模板适用族 | SPEC 头部声明实测；ADR-2026-06-28 全文扫描无模板语义条款 |

### 4.3 两版 Owner pack 原文（关键句）与统一解读（r2 重写）

- `behavior-examples.json`（mtime 2026-10-10T00:30:24Z；链 A 各 run 均早于 r9 mtime → 只能用此版）：
  > AI 在写入任何受保护路径（如 protected/）之前，必须先解析并向 Owner 确认精确目标路径，未经确认禁止执行写入。
- `behavior-examples-r9.json`（mtime 2026-10-10T09:20:13Z）：
  > …AI 在执行写入/覆盖这类有后果的变更前，必须先解析并向 Owner 确认精确目标路径，并确认该目标现状已被读取/检视；未经确认不得写入，尤其不得写入 protected/ 等受保护目录。访问受保护路径（包括只读 ls）同样需要先确认。

**统一解读（替代 r1 的两处矛盾表述）**：r9 文本对「写入/覆盖这类有后果的变更」（含普通路径）给出了**正面**约束（写前须确认精确目标 + 目标现状已被读取/检视），并对受保护路径追加了**含只读访问**的确认要求；r9 文本**没有**「对普通非受保护路径不触发冗余确认」这类**负面**断言——该句只存在于链 B scribe 工件，两版 pack 均无（E13）。r1 §4.3 注所称「r9 未对普通路径作任何断言」是错误表述，予以撤回。按 r9 文本，普通路径的写入同样落入「有后果的变更」约束——但这属于对当前文件文本的解读；**历史 run 收到的是哪个版本、Owner 当时是否另有口头口径，均为 Unknown**，不据此要求 Owner 作政策裁决。

### 4.4 r9 进入链 B 的取证状态（维持 Unknown）

chain A/B 的 artificer 提示词字节未持久化（L2 run `input_payload`=NULL；网关/事件日志不覆盖 09 点窗口；`.pd-p1test` 与 `_pdtest` 全文检索无第二处 r9 文本）。依据仅为：mtime（09:20:13Z）+ 命名（r9）+ 链 B dreamer 紧随其后 25 秒。**判定：Unknown（旁证倾向于「是」，无逐字节证据）**。推论全部条件化：「若链 B 使用 r9，则链 B 规则 block 受保护路径只读访问这一行为与 r9 文本一致、却被 evaluator 评判批评（E14）——若此前提成立，存在待核查的 Scribe/评判派生保真问题；此前提本身未证实。」

### 4.5 r2 新增探针结果（完整输出见 probe-report-r2.json；命令见 §7）

#### S5R — A-r2 真实合并链（当前代码 × 当前声明 × 持久化输出）

| 组成 | 实测 | 证据 |
|---|---|---|
| llmCases | **0** | 持久化 evaluator 输出（run 09:09:55）键列表无 `adversarialCases` → V1 形态 → `:2638` 取 `[]` |
| v2Cases | **0** | 真实派生 skip，遥测 `non_write_canonical_kind_for_v2_adversarial_cases`（toolName=ls, canonicalKind=other） |
| hostAliasCase | **0**（四个工件全部如此） | 真实 `generateHostAliasCase` + 当前宿主声明：基准例恒为首个负例 case-negative-5（`ls`→baseline 无映射→other），宿主 mappings 无 other 类 → skip `no_host_tool_with_kind:other` |
| merged | **0** → `skipReason=no_adversarial_cases_after_merge` 分支 | 生产合并顺序 `:2638-2647` |

**历史快照依据与限定**：声明 `declaredAt=2026-10-09T23:27:52Z` 与文件 mtime 一致、先于全部内化 run；但历史 run 时点的声明字节与 skip 事件均未落盘。**结论**：「当前代码与当前声明可复现 merged=0 解释；历史 run 的实际执行情况尚未证实。」r1 以「输出无 adversarialResult」单独证明 replay 未执行的表述，降级为「与该解释一致」。

#### S6 — 反例规则（撤回普遍化结论的直接证据）

- 反例（离线诊断对照，复核构造）：`risk→block；available∧未截断∧priorRead=no∧readCount>0→block；其余 allow`。
- 对「A-r1 真实正例(3) + 5 条模板（原目标 `.`）」：`accepted_shadow`，`sandboxSuccess=true`，8/8。对重排目标组（`workspace/readme.md`）：同，8/8。
- 对 A-r1 **完整原集**（含 3 条受保护负例）：`rejected_validation_failed`，3 条负例全部 `Expected block but got allow`——反例不实现受保护拦截。
- 输入差异实证（推翻 r1「形状相同」）：case-pos-write-normal 与（重排目标的）v2-path-boundary 在 `params.path`（readme.md vs readme.md.bak）、`history.calls`（0 vs 1）、`facts.readCount`（0 vs 1）三处不同；相同的是 status/truncated/priorRead——r1 只比较了后者。
- **限定表述**：四条现有规则失败于 `v2-path-boundary` = 实证；r9-proxy 通过五条模板但失败于模型正例（`Expected allow but got block`）= 实证（失败位置不同，不得混述）；「不可能存在可通过的规则」= 撤回；「反例可过」≠「反例符合 Owner 意图」= 实证区分。

#### S7 — 完整原集 × 各自规则 × 两种投影（复核补充观察的机制分解）

| 工件 | 生产忠实投影（PF） | 退化投影（无 projectDir 对照） |
|---|---|---|
| 09:02:01（A-r1 规则） | `accepted_shadow`，success=true，0 失败 | 失败 3 条负例（case-negative-5 / case-neg-write-secret / case-neg-edit-guard） |
| 09:09:55（A-r2 规则） | `accepted_shadow`，success=true，0 失败 | 失败 2 条负例（case-negative-5 / extra-write-protected） |
| 09:33:13（B-r1 规则） | `accepted_shadow`，success=true，0 失败 | 全过（有 paramsSummary 回退） |
| 09:42:42（B-r2 规则） | `accepted_shadow`，success=true，0 失败 | 全过（同上） |

输入转储（case-neg-write-secret）：PF 投影 `normalizedPath="protected/secret.txt"`、`canonicalKind="write"`；对照投影 `normalizedPath=null`、`canonicalKind=null`、`paramsSummary.path` 均在。字段读取实测：规则 09:02/09:09 只读 `normalizedPath`；09:33/09:42 另读 `paramsSummary`。
**结论**：复核观察复现于退化投影，根源=规则字段读取 × 输入投影差异；生产 gate 调用链经工厂默认线程化二者（E17），PF 行才是生产忠实投影。**该对照不构成对四条规则生产行为的新结论**（原集负例在生产合并集中本就不参与重放，见 §3.1）；它揭示的是「若合并集包含这些负例，A 链规则对投影方式更脆弱」这一**规则健壮性观测**，以及投影一致性必须显式检查的方法论要求。

#### S9 / S3b — 历史失败解释的投影稳健性

- S9（as-is 模板 × 4 规则 × PF 投影）：4 规则全部失败于 `v2-path-boundary`（target=`..bak`）——与三次历史失败一致。
- S3b（重排 write 正例 × 4 规则 × PF 投影）：target=`workspace/readme.md.bak`，4 规则同用例同消息失败。
- **结论**：r1 的核心重放结论（换正例仍失败；失败与投影方式无关）在生产忠实投影下成立，r1 该部分无需撤回。

#### S8 — 「mismatch 即返回 []」守卫的后果分析（全部为离线诊断对照）

公共设置（S8b/c，r3 重做）：真实 **A-r1 工件**（`affectedTools[0]="write"`，首正例 `case-positive-6`=`ls {"path":"."}`）× **真实生产派生**（5 条模板，未手工制造）× **生产 factory 投影**（`createProductionGateDeps({projectDir:验收沙箱, toolSemantics:宿主声明 registry})`）；规则=该工件自身规则（`rule@09:02:01`），每组前后不变。Before=真实正例＋5 条模板＋对照用例；After=同正例＋同对照用例、模拟守卫移除 5 条模板。

| 场景 | Before（5 条模板） | After（0 条模板） | 含义 |
|---|---|---|---|
| (a) mismatch + 其余集合全空 | — | — | 与 A-r2 现状一致：merged=0 → `no_adversarial_cases_after_merge`；此场景无检查可删 |
| (b) alias 非空（对照：负例基准 toolName ls→write_file 喂真实 alias 生成器 → `v2-host-alias` write protected→block） | 9 用例（3 正例＋5 模板＋alias）→ `rejected_validation_failed`，success=false，failedCases=[`v2-path-boundary`: Expected block but got allow] | 4 用例（3 正例＋alias）→ **`accepted_shadow`**，success=true，failedCases=[] | **同一规则同一投影，5 条模板检查的有无翻转 accepted/rejected**——遥测≠检查保持 |
| (c) LLM 用例非空（合成对照 `llm-custom-对照`，不调用真实 LLM） | 9 用例（3 正例＋5 模板＋llm）→ `rejected_validation_failed`，success=false，failedCases=[`v2-path-boundary`] | 4 用例（3 正例＋llm）→ **`accepted_shadow`**，success=true，failedCases=[] | 同上 |
| (d) 存在有效 write 正例但首正例为 ls（A-r1 原件） | 按首正例配对 → 守卫触发 → 5 条模板被删；「选择有效配对样本」则可从 case-pos-write-normal 派生完整 5 条（实测派生表） | | 按首正例配对的守卫会**误删本可保留的检查** |
| (e) 多个 write 类工具、不同路径参数（对照：edit 正例提前） | edit→write 同类 → 守卫不触发；模板 target=`workspace/app.js(.bak)`（取自 edit 样本路径） | | **canonicalKind 相同只证明类别相同，不证明同一动作**——守卫通过≠配对正确 |

---

## 5. Hypothesis Results（r2 修订裁决）

### H1 样本选择（正例是一条 ls 观测）— **Confirmed（触发器）；非充分修复点**

- Confirmed：`positiveCases[0]` 恒为 Owner 标注的 `case-positive-6`（E2），其 path 被拼成 `..bak`（E4）；装配器允许 Owner 标注与被治理工具不同 kind 的样本且下游无校验（§3.4）。
- 非充分：S3b（PF 投影）——改为真实 write 正例在前，四条现有规则仍在同一条用例上以同一消息失败（E8）。
- r2 限定：以上均为「现有规则」上的实证；存在可通过的规则（S6 反例），因此「换样本失败」不等于「问题在模板不可满足」。

### H2 工具匹配（write 工具 × ls 样本跨动作组合）— **Confirmed（实现缺口：无配对校验）；修复方案待裁决**

- `generateV2CasesFromArtificer` 从两个独立序列各取首项，无「同一动作」校验（E1）；prompt 未向模型披露「首正例 path 是模板写目标」的耦合。
- r2 修正：修复方案本身不再是「最小守卫即可」——S8 证明按首正例 canonicalKind 的守卫有误删（S8d）与检查架空（S8b/c）风险，且同类≠同动作（S8e）。三个契约选项的比较移交 §6.1，本轮不实施。

### H3 模板适用范围 — **部分 Confirmed（代码级事实）；普遍化论断撤回**

- 维持（代码级）：`v2-path-boundary` 期望值推导与 `v2-alias` 场景构造编码「写前先读」假设；对本链产出的标记语义规则，helper 段是**当前已实证**的正例路径类中唯一与全部 5 例期望相容的（对照矩阵对这四条规则成立）。
- 撤回：「任何确定性规则不可能通过」（S6 反例）；「helper 唯一可行」作为普遍定理（反例表明存在其他可区分输入的规则；`readCount>0∧priorRead=no` 这类组合判据不在 helper 豁免之列也能同时满足正例与模板）。
- 依据分级：设计 SPEC §10.1=设计历史（E20）；现行 ADR 未限定；代码注释与期望值常量=现行实现事实。
- 附带实证（S6-full）：可通过模板的规则与符合 Owner 意图的规则是两个谓词——本链 Owner 负例要求 block 受保护路径，反例规则做不到。**测试通过与意图符合必须分开验证。**

### H4 上游证据与意图不一致 — **部分 Confirmed（有限定）；r9 相关全部条件化**

1. **Owner 证据无法表达被治理行为**（Confirmed）：incident 会话无写动作可标注（E11），pack 机制把 ls 行硬编码为负/正例；派生模板随后把读观测当作写目标。
2. **Scribe 派生句**：「对普通非受保护路径不触发冗余确认」在两版 pack 均不存在（E13）——这是文件层面事实。**该句是否违背 Owner 意图 = Unknown**：r9 文本未含此句，但 Owner 是否另有口头口径不可考（U2）。「Scribe 丢失了 r9 的 Owner 约束」为**条件假设**：仅当链 B 确实使用 r9（Unknown，E12/§4.4）且 r9 的只读确认约束被评判否定（E14 实测）时才成立。
3. **evaluator LLM 评判与 r9 文本相悖**（条件事实）：评判批评「对只读 ls 也 block」（E14）；r9 文本明文要求。若链 B 使用 r9（未证实），则评判依据的 intentContract 丢失了该 Owner 约束——派生保真缺口待核查。
4. r9 的统一解读见 §4.3；r9 是否进入链 B 见 §4.4（Unknown）。

### 汇总表

| 假设 | 裁决 | 一句话依据 |
|---|---|---|
| 样本选择 | Confirmed（触发器）；非充分修复点 | E2/E4/E8/S3b |
| 工具匹配 | Confirmed（实现缺口）；修复方案待 Owner 裁决 | E1/E3 + S8 全部 |
| 模板适用范围 | 部分 Confirmed（boundary/alias 代码级假设成立）；普遍不可满足与 helper 唯一论撤回 | E15/E20 + §3.3 |
| 上游证据/意图不一致 | 部分 Confirmed（证据通道缺陷成立）；r9/Scribe/评判链全部条件化或 Unknown | E11/E12/E13/E14 + §4.4 |

---

## 6. Minimal Fix Recommendation（r2 重写：本轮不实施，交 Owner 裁决）

### 6.1 派生缺口（工具 × 样本无配对校验）的三个处理选项——契约符合性比较

现行契约基线（代码事实）：`generateV2CasesFromArtificer` 对三种无法派生的输入（无工具名 / 无正例 / 无路径参数）已有「返回 `[]` + 结构化遥测」的降级分支；合并集为空时 code-bearing 工件 fail-loud（`:2660-2667`）；host-alias 与 LLM 用例独立于 v2 模板参与重放。

| 选项 | 行为 | 与现行契约的关系 | 已证实的代价/收益 |
|---|---|---|---|
| (a) 选择有效配对样本 | 派生时在正例中找 canonicalKind 与目标工具匹配的首个样本（如 case-pos-write-normal）作为模板目标来源；找不到再降级 | 改变「取 positives[0]」这一未成文惯例；prompt 从未承诺 positives[0] 为权威，改动不破坏已陈述契约 | S8d 实测：A-r1 场景下可保留全部 5 条模板；但 canonicalKind 匹配≠同一动作（S8e），只是收窄而非消除缺口；需要一个「样本选择优先级」的新微契约 |
| (b) 明确拒绝 | 无法派生可靠配对时 fail-loud（拒绝该轮派生而非降级） | 现行契约对派生缺口一律降级（三种既有 skip 分支），拒绝是**更严格的新姿态**；PRI-634 R3 的 fail-loud 先例针对「合并集为空的 approved 链」，不覆盖派生阶段 | 最诚实（不产出低置信证据）；但会把「可降级运行」的链变成硬失败，影响面需 Owner 评估 |
| (c) 可观测降级（r1 的守卫建议） | mismatch → 返回 `[]` + 遥测，其余集合照常重放 | 与三种既有降级分支同族，契约上最顺 | **S8 实测的代价**：alias/LLM 非空时 5 条模板检查被删而 approved 仍可达（检查架空）；首正例错配时误删本可保留的检查（S8d）。**r1「无 gate 行为变化」的表述撤回** |

**本轮结论**：三个选项都不改变 Owner 政策，但 (a)(b) 各引入一个新微契约，(c) 有已证实的检查架空风险。**不实施任何一项**；由 Owner 选择方向后再谈最小实现。（补充：若选项 (c) 被选中，其遥测必须携带「因本分支被跳过的模板检查数」，使检查架空可审计——这是 S8 的直接教训，属实现细节，非本轮授权。）

### 6.2 helper 段重采——**未验证的验收候选**（r2 降级）

- 已证实的只有两层：①模板期望在 helper 段（`tmp/temp/draft`；不含 `backup/backups`）翻为 allow——代码 + 离线派生（v1-S1 + r3 分支取证）；②对**现有标记语义规则**，helper 段正例下全部 5 例期望与规则行为相容（对照矩阵，限定于这四条规则）。
- **未证实的**：helper 段样本能否通过真实内化链（artificer 校验、evaluator LLM 评判、对抗循环）、能否走完 protected write → runtime_verified → Behavior Episode → Effect Evidence → Owner Outcome Observation 的原验收链。**没有任何实验运行过这条新链。**
- 原验收要求不变：Golden Journey 的断言对象是「受保护写入被真实拦截并留下完整证据链」，helper 段样本只改变模板目标路径的类别，**不能替代根因修复，也不能把更容易通过的样本当作原问题已解决的证据**。
- 性质：候选验收采样（取证用），是否值得投入由 Owner 裁决；实施前需按 §6.1 先定派生缺口处理方向（否则新样本仍经由未修复的派生缺口）。

### 6.3 维持 r1 判断的路径

- **改 oracle 口径**（为「原则不治理域」增加豁免）：影响所有 v2 规则的确定性 gate，属治理契约变化，需 ADR + Owner 批准；本轮不推荐也不预设。EP002-R4 的 helper 豁免是**代码级先例**（证明期望值可调），但它是否足以授权同族扩展，由 Owner 判断。
- **重排 affectedTools 让模板跳过**：E10/S5R——「无重放证据」而非通过，不得作为解除手段。

### 6.4 验证与回滚（若 Owner 之后授权实施）

| 项 | 验证 | 回滚 |
|---|---|---|
| §6.1 任一选项 | 对应选项的 runner 行为测试（真实工件形状 fixture）+ `npx vitest run src/runtime-v2/internalization` + `npm run verify:merge`；选项 (c) 另需「检查架空可审计」的遥测断言 | revert 单 commit |
| §6.2 重采 | 新链 artificer succeeded + evaluator adversarialResult + GJ 拦截链证据落库 + 六条完成标准逐条重新取证 | 无代码；停用新激活（SPEC §13.10 既有回退） |

---

## 7. 可重跑命令与产物

环境：诊断 worktree（@ `11fd5090`）。探针位于 worktree `.tmp/b1-diagnosis/`（gitignore 路径，不入库——沿用 #1980 报告 §7.7 先例）：

```bash
# ① 历史库只读转储（better-sqlite3 readonly:true，参数绑定查询）
node .tmp/b1-diagnosis/dump-db.mjs            # → dump-full.json（0.43MB）
# ② r1 探针（S1–S5；S5 注记已在 r2 修正，指向 S5R）
node .tmp/b1-diagnosis/analyze2.mjs && node .tmp/b1-diagnosis/probe-b1.mjs
# ③ r2 探针（S5R 真实合并链 / S6 反例 / S7 双投影 / S9+S3b 投影稳健性 / S8 守卫后果）
node .tmp/b1-diagnosis/probe-b1-r2.mjs        # → probe-report-r2.json
# ④ PR/merge 状态
gh pr view 1980 --json state,mergeCommit,headRefOid
```

探针输出规范（r2 起）：真实输入与对照输入逐项标注；每次重放检查 `sandboxSuccess`/gate `decision`（不只看 failedCases）；全部输出保留在两个 JSON 中；不写回历史数据库。

关键结果摘录（全文见 JSON）：

```text
S5R：llmCases=0（持久化输出无 adversarialCases 键）；v2Cases=0（skip 遥测）；
     alias=0（四工件全部 skip no_host_tool_with_kind:other）→ merged=0 → skipReason 分支
S6  ：反例 vs 正例+模板（as-is / reordered）= accepted_shadow×2（8/8，success=true）；
     反例 vs A-r1 完整原集 = rejected_validation_failed（3 条受保护负例 allow）
S7  ：PF 投影下 4 规则全过各自完整原集（accepted_shadow×4）；
     no-projectDir 对照下 A 链规则失败 3/2 条负例、B 链全过（paramsSummary 回退）；
     inputDump：PF normalizedPath='protected/secret.txt' vs 对照 null；字段读取 09:02/09:09 仅 normalizedPath，09:33/09:42 +paramsSummary
S9  ：as-is 模板 × 4 规则 × PF 投影 → 4 规则均失败 v2-path-boundary（target='..bak'）
S3b ：重排 write 正例 × 4 规则 × PF 投影 → target='workspace/readme.md.bak'，4 规则同消息失败
S8  ：(r3 重做，A-r1 × 生产派生 5 模板 × 生产 factory 投影，规则不变)
     (b) alias 非空：Before=9 用例 rejected_validation_failed（v2-path-boundary, success=false）
         → After=0 模板 4 用例 accepted_shadow（success=true）
     (c) LLM 用例非空：同型 Before/After 翻转；
     (d) 有效 write 正例存在时首正例守卫误删；(e) edit→write 同类不触发守卫
```

脱敏说明：本报告不含凭据与 Owner workspace 无关数据；数据库连接 readonly；未写回任何治理数据。

---

## 8. Remaining Unknowns（真实缺口及取得方式）

| # | 缺口 | 为什么无法闭合 | 取得方式 |
|---|---|---|---|
| U1 | 链 B 是否逐字节使用了 r9 pack | L2 prompt 未持久化；日志不覆盖 09 点窗口 | Owner 认可后在下轮 run-rulehost 落盘 prompt 摘要/pack digest；或核对验收工作底稿（本地未跟踪文件，本轮范围外） |
| U2 | 「普通路径不干预」句是否有 pack 之外的 Owner 口头来源 | 只能 Owner 回答 | 问 Owner；若否，建议将 Owner 口径显式落盘，消除 Scribe 自由派生空间 |
| U3 | 历史 A-r2 run 的实际 gate 执行（skip 事件是否发生） | skip 事件未落盘；仅能复现解释 | 后续 run 为 gate skip/调用补遥测落盘（S5R 教训）；历史 run 不可追溯 |
| U4 | helper 段候选能否通过真实内化链与完整 GJ | 未运行过（本轮禁止实宿主） | §6.2 若被授权，按原验收标准取证 |
| U5 | 派生缺口处理方向（§6.1 a/b/c） | 属 Owner 契约裁决 | Owner 裁决后实施 |
| U6 | evaluator LLM 评判在新链上是否再现与 Owner 文本相悖的口径 | LLM 评判非确定性；本轮未跑真实链 | §6.2 重跑时观察 evaluation.summary |

---

## 9. 完成标准逐条回答（任务 §八）

1. **哪些事实已确认，哪些旧结论已撤回？**
   确认：无配对校验的派生缺口（E1）；三次历史失败在 v2-path-boundary 的 block/allow（E5/4.1）；对四条现有规则换普通 write 正例仍失败（E8，PF 投影下 S3b 复核）；helper 机制现仅认 tmp/temp/draft（E4）；边界负例/正例的样本语义缺陷（E11）；alias 全 skip 与 llmCases=0 的当前态事实（S5R）；反例规则可同时通过正例与模板（S6）。
   撤回：「任何确定性规则不可能同时通过」（S6 反例推翻）；「helper 段唯一可满足」（同）；「守卫=无 gate 行为变化的最小修复」（S8b/c 证明检查架空）；「r9 对普通路径没有断言」（与另一处矛盾，统一为 §4.3）；「以无 adversarialResult 单独证明历史 replay 未执行」（降级为一致解释，S5R 限定）。
2. **现有四条规则失败，与「所有规则不可能通过」有什么区别？**
   前者是 4 条真实规则加 1 条代理规则各自在具体证据集上的实测结果（且失败位置不同：四条真实规则失败于 `v2-path-boundary`，r9-proxy 通过模板、失败于模型正例）；后者是需要遍历所有可能规则的普遍命题。完整输入差异（path/calls/readCount）使确定性区分成为可能，反例规则即实证。普遍命题被一个反例即告无效——已撤回。此外「可通过模板」与「符合 Owner 意图」是两个谓词：反例规则可过模板却放过全部受保护负例（S6-full）。
3. **历史 replay 状态究竟证实到哪一层？**
   三层：①失败用例与失败值——证实（落库 failedCases 逐字一致）；②失败用例由模板派生——证实（生产方法派生 + 消费输出无 adversarialCases 字段）；③**A-r2 那轮 replay 是否真的未执行——未证实**：当前代码+当前声明+持久化输出可复现 merged=0 的解释（S5R），但历史 skip 事件未落盘，只能表述为「与该解释一致」。对三条失败 run：合并集=5 条模板（无 alias/llm）在当前态复现成立，失败值与落库一致。
4. **返回空集是否可能减少必需检查？**
   可能，且已实测：mismatch 守卫在 host-alias 或 LLM 用例非空时，合并集仍非空、重放仍可 `accepted_shadow`（S8b/c）——5 条模板检查被删除而批准路径可达；「模板检查已执行」在此形态下不可证明。只有合并集全空才触发现有 fail-loud。且 canonicalKind 相同不证明同一动作（S8e）。因此 r1 的守卫建议不构成「保持检查」的安全修复，三个选项的契约比较见 §6.1。
5. **下一项修复如何保持原 Owner 行为要求和原验收目标？**
   不把「更容易通过的样本」当作修复：helper 段重采只是未验证的取证候选（§6.2）；无论选哪条路，验收断言始终是 protected write → runtime_verified → Behavior Episode → Effect Evidence → Owner Outcome Observation 的完整链（SPEC §13.9），且派生缺口处理方向（§6.1）须先经 Owner 裁决——三个选项都不触碰 Owner 意图文本、gate、oracle 与验收标准。

---

## 10. 边界遵守声明

- 未修改生产代码 / validator / oracle / gate / 模板 / Owner pack / intent / 激活 / ADR / 安装目录 / workspace `.pd` 状态（历史库 readonly；worktree 内仅新增 `.tmp/b1-diagnosis/` 探针与本报告修订）。
- 未运行真实宿主或 LLM；未重排生产 affectedTools；所有修改输入均标注「离线诊断对照」。
- 未创建/合并/发布 PR；未处理 Codex pin/OOM 等旁支。
- Phase 1 判定维持 PARTIAL；本报告不解除 B-1。

## 11. r2 修订记录（对独立复核的逐项回应）

| 复核条目 | r1 状态 | r2 处置 | 证据 |
|---|---|---|---|
| P1 普遍不可满足被反例推翻 | §1/§5-H3/§9 多处断言「任何规则不可能」「helper 唯一」 | **撤回**；限定为「四条现有规则失败于 `v2-path-boundary`；r9-proxy 通过模板、失败于模型正例（位置不同，不得混述）」；补 S6 反例复现（8/8 + 完整原集失败于受保护负例）；新增「测试通过≠Owner 意图」 | S6 |
| P1 同 trace 矛盾论证 | 只比较 status/priorRead 两字段即称「形状相同」 | 更正：完整输入在 path/calls/readCount 三处不同，r1 论证不成立；用完整差异表替代 | S6 inputDiff |
| P2 r9 未证明进入链 B | 一处按已证事实书写 | 全部条件化：「若链 B 使用 r9，则…」；§4.4 维持 Unknown | §4.4 |
| P2 r9 解释自相矛盾 | §4.3「普适写前确认」 vs §5-H4「对普通路径没有断言」 | 统一为 §4.3 单一解读；撤回错误半句 | §4.3 |
| P2 S5 未实测完整合并链 | v2Cases 实测=0 但 alias/llm 手工加 0；探针注记「生产未注入 hostSemanticContext」错误 | 重做 S5R：持久化输出定 llmCases=0；真实 `generateHostAliasCase`+当前声明（全 skip）；生产合并顺序；结论限定；旧注记修正 | S5R + probe-b1.mjs 注记修正 |
| P2 守卫可能取消检查 | 6.1 直接推荐守卫（称复用 skip 分支、无 gate 行为变化） | **撤回推荐**；S8 后果实测（r3 重做为 A-r1 Before=5 模板/After=0 模板的同规则同投影对照：accepted 与 rejected 被 5 条模板检查的有无翻转；另有误删/同类≠同动作）；改为三选项契约比较，不实施 | S8 |
| P2 helper 重采过度声明 | 「B-1 解除依赖修复二」「再次实证」 | 降级为未验证候选；删除解除依赖表述；保留原验收链要求 | §6.2 |
| P2 设计历史误作现行权威 | 引 §10.1 限定模板族 | 依据重分级（设计历史/现行 ADR/代码事实三层，§3.3）；ADR 扫描补证；模板调整与 Owner 政策的关系改为开放问题 | E20/§3.3 |
| 补充观察（A 链负例失败/B 链通过） | r1 未覆盖 | 机制分解：仅复现于退化投影；PF 投影下四条规则全过原集；输入转储 + 字段读取实证；「源码像拦截」与「真实输入返回 block」两个检查分开陈述 | S7 |

---

## 12. 最小实施计划（r4，2026-10-11）——**尚未实现，待授权后编码**

> 定位：工程实施计划，只约束派生配对这一个缺口的修复。不动 gate、oracle、模板期望、Owner pack、ADR 与验收标准。Phase 1 保持 PARTIAL；本计划即使完整落地也不解除 B-1（配对修复不是完整解——诊断已证换正确 write 正例后四条现有规则仍失败于 boundary，该失败必须原样保留）。

### 12.1 推荐行为契约（一句话）

> 模板目标来源从「两个独立清单各取首项」改为「**先在正例中确定性选出与 `affectedTools[0]` 同 canonicalKind 的样本作为配对正例，其 toolName 作精确工具名、其 path/file_path 作目标路径**；无合格正例时该轮模板派生判定为 `derivation_failed`（新增区分态），由**现有** PRI-634 R3 fail-loud 通道按路径区分处置——不再静默返回 `[]` 伪装成「工具不适用的正常跳过」。

### 12.2 契约细则（实现 AI 不得自行裁量）

**R1 什么样的正例可作为模板来源？**
`kind==='positive'` 且 `canonicalizeToolKind(toolName)==='write'` 且 `resolveCasePathParam(params)!==null`。三项全部复用现有函数（`rule-context-v2.ts` 的 canonicalizeToolKind、`evaluator-runner.ts:195` 的 resolveCasePathParam），零新解析。

**R2 样本工具与 affectedTools 的一致关系如何建立？**
目标工具仍取 `affectedTools[0]`（该字段是规则对治理面的声明，validateV2OutputContract 已要求非空字符串数组）；配对要求 = `canonicalizeToolKind(positive.toolName) === canonicalizeToolKind(affectedTools[0])`。只要求同类——同名要求会拒绝 edit 样本配 write 规则这类合法组合，且 artificer 校验器从不保证样本工具名与声明工具名一致。

**R3 精确工具名与 canonicalKind 各承担什么？**
canonicalKind 决定**是否可派生**（非 write → 既有 `non_write_canonical_kind_for_v2_adversarial_cases` 分支不变）与**正例是否合格**（R1）；精确工具名只作**生成参数**透传（`generateV2ContextAdversarialCases({toolName, targetPath, canonicalKind})`，模板用例的 toolName/params 字段）。canonicalKind 同类 ≠ 同一动作——本契约只声称消除**跨 kind 拼接**（write 工具 × ls 路径），不声称消除同 kind 内的动作歧义（S8e）；后者记录为已知边界。

**R4 多个合格样本如何确定性选择？**
取**正例序中的第一个合格者**（保序扫描，`extractPositiveCases` 已保序）。不用最相似/最长公共前缀等新启发式。确定性由输入顺序保证：Owner 样本在 pack 顺序中恒在模型自写样本之前（四个真实工件实测），因此「第一个合格 write 正例」在 A-r1 上就是 `case-pos-write-normal`（r3 探针 S8d 已实测该选择派生出完整 5 条、目标 `workspace/readme.md.bak`）。

**R5 只有 ls 正例、没有合格 write 正例怎么办？**
进入 §12.3 的 `derivation_failed`（reason=`no_write_kind_positive_case_for_v2_adversarial_cases`）。**不降级为空数组跳过**：只要目标工具是 write（即模板本应适用），缺失即缺失。

**R6 首个 affectedTool 为 ls、后续含 write 怎么办？**
维持现状——canonicalKind(ls)=other ≠ write → 走既有 `non_write_canonical_kind_for_v2_adversarial_cases` 跳过分支。规则声明以 affectedTools[0] 为准是现行契约（doc comment :2975-2978 明示），本计划不引入「扫描后续工具」的第二真源（那是行为面变更，超出最小修复，不在本计划内）。

**R7 路径缺失、参数 schema 不兼容怎么办？**
配对正例无 path/file_path → 不再回退扫描其他正例拼凑，而是 `derivation_failed`（reason=`paired_positive_case_has_no_path_param`）。「回退扫描」会重新制造跨样本拼接（工具来自 A、路径来自 B），正是本修复要消除的形态。

**边界声明（不越权）**：R1–R7 全部不改变 Owner 行为要求、检查强度与验收目标——五条模板的期望值、oracle、gate、merge 顺序、alias/LLM 用例语义全部不动。唯一行为变化是「write 规则 + 无合格 write 正例」从「静默 0 模板 + 其他用例可能照常通过」变为「可观测的派生失败」。

### 12.3 「无法派生」的结果区分（本轮重点）

四态与现行机制的对应：

| # | 状态 | 现行表现 | r4 后 | 改动 |
|---|---|---|---|---|
| 1 | 正常生成并执行 | 5 模板进 merged → gate 执行 | 不变 | 无 |
| 2 | 目标工具确实不适用模板 | `non_write_canonical_kind_for_v2_adversarial_cases` → `[]` + 遥测 | **不变**（这是正常跳过，不是失败） | 无 |
| 3 | **本应生成（目标工具为 write）但输入不足/配对失败** | 同样返回 `[]`，与态 2 在数据上不可区分 | 新增区分：返回**带 reason 的失败对象**（`derivation_failed`），reason ∈ {`no_write_kind_positive_case_for_v2_adversarial_cases`, `paired_positive_case_has_no_path_param`}，遥测 `v2_adversarial_cases_derivation_failed`（沿用现有 emitEvent 端口与 rc-9 字段：reason+nextAction） | 见下「最小接口变化」 |
| 4 | 模板生成了但 replay 未执行 | `executeDeterministicReplay` 的既有 skipReason 族（`no_adversarial_cases_after_merge` 等） | **不变**——态 3 的失败会**流经**这里：merged 为空时 skipReason 照旧产生，且**新增区分点：skipReason 携带派生失败原因**，消费侧据此分流 | 无新机制 |

**缺失时对两条生产路径的影响（复用现有通道，不新增机制）：**

- **approved 路径**：现有 PRI-634 R3 终态守卫（`:1145-1168`）本就把「code-bearing + approved + replay 未跑」转为 `input_invalid` 永久失败并携带 skipReason。态 3 在 approved 路径上**自动落入该守卫**——唯一需要的改动是 R3 失败信息从「原因不可知」变为「reason 指明 no_write_kind_positive_case」，failureReason 文本把修复动作指向 Owner 样本（提供含路径的 write 正例）。**检查强度不变：approved + 模板缺失 = 任务失败**，与 R3 现行语义一致。
- **needs_revision 路径**：现行语义是诊断证据缺失不影响 verdict（`:1006-1009` 注释明示），维持不变；但 `diagnosticReplayEvidence` 的缺省（= 重放未真正执行）在修复轮 seed 时已 fail-closed（`repairPayload` 不含 diagnosticReplay 字段），无需改动。
- **alias/LLM 用例为何不能补足**：S8b/c 已实证（Before=5 模板 rejected / After=0 模板 accepted，同规则同投影）——剩余集合通过只证明「alias/LLM 检查通过」，不能证明「模板检查执行」。因此态 3 的判据**只看模板派生本身**，与合并集是否非空无关；「merged 非空」永远不能把态 3 升级为「检查已执行」。

**最小接口变化**：`generateV2CasesFromArtificer` 的私有返回类型从 `readonly AdversarialCase[]` 扩为 `readonly AdversarialCase[] | { derivationFailed: true; reason: string }`（模块内私有类型，无公共 API 变化、无跨包契约变化）。唯一消费者 `:2639` 分流：正常数组 → 现行合并；derivationFailed → 发遥测（新 reason+nextAction=`supply_write_kind_positive_case_with_path_or_accept_missing_template_checks`）、v2Cases 记 `[]`、**并把该 reason 附加到本函数后续产生的 skipReason 前缀**（如 `template_derivation_failed:no_write_kind_positive_case_for_v2_adversarial_cases`），使态 3 与态 2/4 在 runs.output/skipReason 层可区分。不新增服务、不新增持久化状态、不新增 feature flag、不新增检查计数系统——可区分性由「既有 skipReason 字符串承载结构化 reason」实现，遥测只负责过程可观测。

### 12.4 模块改动面

| 文件 | 改动 | 保持不变 |
|---|---|---|
| `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts` | `generateV2CasesFromArtificer`（:2988-3069）按 R1–R7 重写选样与返回；`:2639` 调用点分流 + skipReason 前缀；R3 fail-loud 的 failureReason 文本携带结构化 reason | `parseArtificerArtifact`/`extractPositiveCases`（:2808/:2886）；`resolveCasePathParam`（:195）；gate 调用与 merge 顺序（:2638-2758）；alias/LLM 派生；oracle/gate/模板/validator |
| `packages/principles-core/src/runtime-v2/internalization/__tests__/evaluator-v2-derivation-pairing.test.ts`（新增） | §12.6 的场景测试 | — |
| 受影响的既有测试（回归面，预计小改 fixture） | `evaluator-out-of-scope-governance.test.ts`、`evaluator-approved-replay-failed-repair.test.ts` 等含 `affectedTools+goldenTraceCases` fixture 的用例：凡「首正例非 write 但存在 write 正例」的 fixture，模板目标路径会按新契约改变（A-r1 形态：`.`→`workspace/readme.md`） | 断言强度不得放宽——目标路径断言更新为对应合法目标；任何「期望 0 模板」的用例若因配对改善变为 5 模板，须逐个核对是语义正确化而非放水，并在 PR 描述逐条列出 |

消费者核查结论（已验证）：`generateV2CasesFromArtificer` 唯一调用者是 evaluator-runner 内部 `:2639`；`resolveCasePathParam` 为模块私有；无跨包消费者——改动面封闭于 `@principles/core` 单包。

### 12.5 PR 拆分

**单 PR（一个可独立验证的最小变更）**：core 包配对契约 + 遥测区分 + R3 文本 + 新测试 + 既有 fixture 校准 + changeset（`@principles/core` patch）。不拆多 PR——接口变化、行为变化、测试三者在同一审查面内才能验证「不静默消失」。

### 12.6 验证计划（全部经 `EvaluatorRunner` 公有行为 `runner.run()`；gateDeps 用真实 `createProductionGateDeps({projectDir, toolSemantics})` 生产 factory，保持真实投影；断言 gate decision + `sandbox.success` + failedCases + 模板派生数）

| # | 场景（fixture 形态） | 验证意图 | 归属 |
|---|---|---|---|
| T1 | 首正例 ls、后续含合格 write 正例（A-r1 真实工件形态） | 选 `case-pos-write-normal` 为配对样本；5 条模板派生且目标=`workspace/readme.md(.bak)`；**若规则违背模板期望，`rejected_validation_failed` 原样保留（真实失败，不改 expectedDecision 造绿灯）** | 配对修复验收 |
| T2 | 只有 ls 正例、无合格 write 正例；无 alias/LLM | 模板缺失可见：approved 路径任务 `failed`（R3 通道，reason=no_write_kind_positive_case…）；needs_revision 路径 verdict 保持但无诊断 replay 证据 | 配对修复验收 |
| T3 | 配对失败（同 T2 形态）+ alias 非空 | 剩余用例**即使全过**，approved 路径仍 `failed`——其他用例通过不能掩盖模板缺失 | 配对修复验收 |
| T4 | 配对失败 + LLM 用例非空 | 同 T3 | 配对修复验收 |
| T5 | 多个 write/edit 类正例（write 正例在后） | 确定性选第一个合格者；工具/参数/路径同源自一样本；重排不变性（交换两个 write 正例顺序 → 目标取第一个） | 配对修复验收 |
| T6 | path/file_path 两种拼写 + 无路径 + 非字符串路径 | 现有 resolveCasePathParam 为唯一解析权威；无效输入 → derivation_failed（reason=paired_positive_case_has_no_path_param），不回退扫描 | 配对修复验收 |
| T7 | 原 boundary 不匹配规则（真实 A-r1 规则）+ 新配对（目标 workspace/readme.md.bak） | **修复后仍失败于 v2-path-boundary 且失败被如实记录**——成功标准是「不消失」，不是「通过」 | 配对修复验收 |
| T8 | approved 与 needs_revision 双路径 × T2/T3 形态 | 证据语义一致：两路径都不产生「模板缺失 + 任务 succeeded/可晋级」状态；approved 走 R3 fail-loud；needs_revision 保持诊断语义 | 配对修复验收 |
| — | protected write 拦截 → runtime_verified → Episode → Effect → Owner Outcome | **不在本 PR**：属实宿主 Golden Journey（B-1 解除条件），按 SPEC §13.9 另行取证 | 实宿主 GJ |

遥测断言：态 3 必发 `v2_adversarial_cases_derivation_failed`（含 reason+nextAction）；skipReason 字符串含 `template_derivation_failed:` 前缀；合并/执行遥测不变。

### 12.7 Complexity Delta

```text
New durable source of truth: NO
New persisted schema/state: NO
New subsystem/service/background process: NO
New public abstraction/interface: NO（私有返回类型联合，无公共 API 变化）
New runtime feature flag: NO
New cross-package dependency: NO（改动封闭于 @principles/core；openclaw-plugin/pd-cli 无接口变化）
New host/platform-specific behavior: NO
New external/network capability: NO
```

### 12.8 回滚

单 commit revert（连同 changeset）。无 schema/flag/persisted-state 变化；rollback 后行为精确回到 `deafee04` 形态（含其已知静默性）。风险窗口仅存在于「派生配对改善导致部分既有 fixture 的模板目标变化」——由 12.4 的回归面清单逐项覆盖。

### 12.9 真正未决事项（不阻塞本 PR，但须记录）

1. **同 kind 动作歧义**（S8e）：canonicalKind 配对不消除「edit 样本配 write 规则」的路径语义漂移；是否需要第二级配对（精确工具名或参数 schema 相容性）属行为面扩展，**不在本计划**，留作 follow-up 候选。
2. **`affectedTools[0]` 的权威性**：R6 维持「只看首项」；是否应让声明与正例集交叉校验（如 affectedTools 含 write 而样本全为 ls 时在 artificer 校验层拒收）属生成侧契约变更，**不在本计划**。
3. **B-1 解除路径**：本计划只修复配对缺口；拦截链实宿主取证（helper 候选或其他 Owner 认可样本）仍待 Owner 启动；原验收链 protected write → runtime_verified → Behavior Episode → Effect Evidence → Owner Outcome Observation 原样保留。
4. **须 Owner 知情的边界（非阻塞）**：本计划无实质治理契约变化——不改 Owner 行为要求、不改检查强度（R3 fail-loud 是现行语义的精确化而非新增）、不改验收目标；故不需要 Owner 三选一裁决。唯一请 Owner 知悉的行为变化：write 规则 + 无合格 write 正例的链将从「可能静默通过」变为「approved 路径任务失败」。
