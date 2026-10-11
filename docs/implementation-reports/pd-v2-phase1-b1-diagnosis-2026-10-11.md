# PD v2 Phase 1 B-1 工程诊断报告（只调查、不实施）

> 日期：2026-10-11（Asia/Shanghai）
> 调查对象：Phase 1 验收缺口 B-1（强制证据链 BLOCKED 于规则内化阶段的确定性重放失败）
> 固定调查 commit：`11fd5090`（origin/main = PR #1980 的 squash merge commit，2026-10-10T14:52:42Z 合并；#1980 head `e37b7efc` 已核实为该 squash 的内容）
> 工作区：adhoc 诊断 worktree `D:\Code\_worktrees\principles\adhoc-20261010-b1-diagnosis-offline-diagnosis`（分支 `ai/adhoc-20261010-b1-diagnosis-offline-diagnosis`，基于 `11fd5090`，bootstrap READY）
> 性质声明：本轮只调查与提出最小修复建议，未修改任何生产代码、validator、oracle、gate、模板、Owner pack、ADR 或安装目录；未创建 PR。历史数据库只读打开；离线对照全部使用标注为「离线诊断对照」的临时副本。

---

## 1. Executive Summary

**阻塞点（一句话）**：确定性 gate 模板 `v2-path-boundary` 的写目标由 **`affectedTools[0]`（工具）× `positiveCases[0].params.path`（路径）** 两个互不配对、互不校验的序列拼出——本链上工具来自模型的 write 声明、路径来自 Owner 标注的 `ls {"path":"."}` 观测，字符串拼接后得到 `..bak`；oracle 对该非 helper 路径硬编码期望 `block`，而链上真实产出的规则（受保护标记匹配语义：非受保护路径一律 allow）返回 `allow`。三次 evaluator 失败全部落在这一条确定性用例上。

**本轮新证（相对 #1980 报告 §7 的增量）**：

1. **「样本选择不足解除 B-1」已从推测变为对照实证**。用生产方法（`parseArtificerArtifact → extractPositiveCases → generateV2CasesFromArtificer`，dist 未改动）+ 生产 sandbox 重放：把正例顺序改为模型自写的 write 正例在前（目标变为 `workspace/readme.md`，boundary 路径变为 `workspace/readme.md.bak`），**四条真实规则仍在同一条 `v2-path-boundary` 上以同样的 `Expected block but got allow` 失败**。样本顺序只决定失败路径的字符串，不改变期望语义与规则语义的矛盾。
2. **同 trace 内存在精确的确定性矛盾**。四个真实 Artificer 工件的模型自写正例全部是「write 普通路径 + history available + `priorReadOfTarget:'no'` + 期望 allow」；模板 `v2-path-boundary`（目标为普通路径时）是「write 普通路径 + history available + `priorReadOfTarget:'no'` + 期望 block」。两者行为形状相同、期望相反——**任何确定性规则都不可能同时通过两者**，除非正例路径落在 helper 段（`tmp/temp/draft`，EP002-R4 已把该段期望翻为 allow）。
3. **模板适用范围问题确认存在**。v2 模板 5 例编码的是「读后再写（read-before-write）卫生」规则族——其设计 SPEC（`2026-06-27-rulecode-context-vision-design.md` §10.1 验收表）明列「未读目标文件的大写入被 block」。它与本链的「受保护路径写前确认」原则不是同一约束；`requiresContextVersion: 2` 由提示词强制声明后，v1 出界逃生（PRI-703 partition）对全部规则不可达，模板矛盾必然进入修复死循环。
4. **r3 遗留的「09:09:55 整轮 gate 执行情况未确认」收敛**：该 run 的确定性重放**未执行**（skip 路径），判定细节见 §5-S5。
5. **r9 pack 约束变化与 Scribe 派生句的来源判定**：r9（09:20:13Z 创建，链 B dreamer 09:20:38Z 之前 25 秒）新增「访问受保护路径（包括只读 ls）同样需要先确认」；链 B 两条规则确实 block 受保护路径的 ls（被 evaluator LLM 评审判为 over-broad——评判所用的 intentContract 丢了这条 Owner 约束）。链 B intentContract 末句「对普通非受保护路径不触发冗余确认」在两版 pack 的 `ownerDesiredOutcome` 中**均不存在**，是 Scribe 派生层自行添加（Owner 来源未找到）。

**下一步（最小实施任务，见 §6）**：两件互相独立的小事——①在派生处加一条「样本-工具 canonicalKind 配对」前置守卫（修复已证实的实现缺口，防复发）；②由 Owner/授权入口重采一组含真实 write 动作、路径落在 helper 段的正例后重跑 Golden Journey（r3 候选 (c)，机制本轮再次实证）。两者都不需要改变 Owner 政策；若 Owner 另行裁决扩展模板适用范围（为「原则不治理域」增加同族豁免），那是治理契约变化，本轮不预设。

Phase 1 保持 PARTIAL。本诊断不解除 B-1。

---

## 2. Baseline

| 项 | 值 | 证据 |
|---|---|---|
| 主工作区本地 main | `94ee6b7a`（落后于 origin/main） | `git log -n 1` |
| origin/main（固定调查 commit） | `11fd5090` = #1980 squash merge | `git log origin/main -n 1` |
| PR #1980 状态 | MERGED，mergedAt 2026-10-10T14:52:42Z，mergeCommit `11fd5090`，head `e37b7efc` | `gh pr view 1980` |
| #1980 净改动面 | 7 文件：artificer 提示词 v9→v10 + 义务文本单测 + 验收报告 r3 章节 + ERR-157 记录 + changeset；**gate/模板/校验器零改动** | `git diff ba39b469 e37b7efc --stat` |
| 诊断 worktree | `ai/adhoc-20261010-b1-diagnosis-offline-diagnosis` @ `11fd5090`，bootstrap 全绿（L1/L2/L3） | `dev:worktree` 输出 |
| 历史库 | `D:\Code\_pdtest\p1-acceptance\sandbox\.pd\state.db`（24 表）与 `...\sandbox\.state\trajectory.db`（16 表），均只读打开，存在且可读 | dump 脚本（§7） |
| 遥测覆盖缺口 | `events_2026-10-10.jsonl` 止于 08:20（10 行）；`.pd/telemetry/critical-events.jsonl` 13 行无 gate 事件；无 09:00–09:45 窗口的 prompt 字节落盘（L2 run `input_payload` 为 NULL） | 本轮文件检查 |
| 沙箱 host 声明 | `.pd/host-tool-semantics/openclaw.json`（declaredAt 2026-10-09T23:27:52Z）：`exec→execute, write→write, edit→write, apply_patch→write, sessions_spawn→agent` | 文件读取 |
| 环境事实 | 主工作区未知未跟踪文件（vitest 输出、ps1 脚本等）全部保留未动；历史库 `-wal/-shm` 随只读连接存在，未做 checkpoint | `git status` / 文件列表 |

历史行号核对说明：#1980 报告 §7.1 引用的 `evaluator-runner.ts:2988-3069 / :2160 / :2183 / :2200 / :2637`、`artificer-runner.ts:883-917 / :819-851`、`rule-reliability-validation.ts:129`、`artificer-prompt-builder.ts:535-559` 在 `11fd5090` 上全部重新核对成立（个别仅因 worktree 与报告时点同 commit 而逐字一致）。

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
                            │    ├─ targetPath= positiveCases[0].params.path|file_path（:3018-3045，resolveCasePathParam）
                            │    ├─ canonicalKind = canonicalizeToolKind(toolName)（:3047）
                            │    ├─ 非 write → 整批跳过 + 遥测（:3054-3063）
                            │    └─ 【无任何校验：工具与路径是否属于同一动作】→ generateV2ContextAdversarialCases（v2-adversarial-cases.ts:133-244）
                            ├─ 合并：v2Cases + hostAliasCase + llmCases（:2638-2647）；全空 → skipReason=no_adversarial_cases_after_merge（:2660-2667）
                            └─ 沙箱重放：adversarialCasesToGoldenTrace → evaluateInRefinerSandbox
                                 （refiner-sandbox-wrapper.ts:298+；helpers.isRiskPath=isSensitiveSystemPath=/etc 前缀，:161-166、:193）
```

### 3.2 oracle（期望值权威）

- `rule-reliability-validation.ts:123-131`：`v2TemplateOracleExpectedDecision` — `v2-unavailable/truncated/alias → allow`，`v2-path-boundary / v2-combination → block`（编译期事实，防 caseId 冒名）。
- `v2-path-boundary` 的期望在模板内部由 `isHelperPath`（`v2-adversarial-cases.ts:122-125`，仅认 `tmp/temp/draft` 段）决定：非 helper → block（:217）。
- PRI-703 出界逃生（`partitionV2OutOfScopeFailures`）**只对 v1 规则可达**；提示词 OUTPUT FORMAT 强制 `requiresContextVersion: 2`（示例 :186）且校验器强制（`validateV2OutputContract:487`），因此本链全部规则为 v2 → **全部模板失败 in-scope**，必然喂进修复循环。

### 3.3 模板语义的设计依据

- `docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md` §10.1 验收表（:431-446）：「读后再写 | 未读目标文件的大写入被 block | 已读同一 normalizedPath 后 allow」「路径边界 | src/auth.ts.bak | 不得被当作已读 src/auth.ts」「上下文不可用 | 必须 allow，不得解释为没调研」。
- 即模板家族 = 「读后再写卫生 + unavailable 时 fail-open + 风险路径占优」。这**不是**普适真值，是一类规则的行为契约。

### 3.4 Owner 样本通道（pack）

- Owner 顶层 JSON 只含 `ownerDesiredOutcome` + trajectory 行号引用（两版文件均如此，`topKeys` 实测）。
- 装配器把「任意 trajectory 行」变成 golden case：不校验该行的 canonicalKind 是否覆盖被治理工具的写语义；incident 会话（402c0f59）只有两条 `ls` 调用（写从未执行），Owner 只能标注这两条。
- 证据：trajectory `tool_calls` id=5 = `ls {"path":"protected"}` → ENOENT 失败；id=6 = `ls {"path":"."}` → 成功；pain_events id=2（pain_host_79143661…）。

---

## 4. Evidence Matrix

（run/工件时间均为 UTC，取自沙箱 `state.db` `runs`/`pi_artifacts`；工件 created_at 是**消费方物化时间**，故 artificer 工件时间戳等于其 evaluator run 的开始时刻。）

### 4.1 真实 run 链

| 链/轮 | scribe intent（工件时间） | artificer run（成功） | artificer 工件（时间/affectedTools/正例序） | evaluator run | 结果 |
|---|---|---|---|---|---|
| A-r1 | 08:53:57（**无**"普通路径不干预"句） | 08:54:51 | 09:02:01 / `["write","edit","apply_patch","exec","sessions_spawn"]` / `case-negative-5, case-positive-6, …` | 09:02:01 | `v2-path-boundary` block/allow 失败（工件 09:03:02 advResult.passed=false） |
| A-r2 | 同上 | 09:03:02 | 09:09:55 / `["ls","write",…]` / 同上 | 09:09:55 | 输出**无 adversarialResult**（工件 09:11:04 [evaluation]） |
| B-r1 | 09:21:29（**有**"普通路径不干预"句） | 09:24:26 | 09:33:13 / `["write","edit","apply_patch","exec"]` / 同上 | 09:33:13 | 同一用例失败（工件 09:35:31 advResult.passed=false） |
| B-r2 | 同上 | 09:35:31 | 09:42:42 / 同上 / 同上 | 09:42:42 | 同一用例失败（工件 09:44:08 advResult.passed=false） |

三次失败 failedCases 逐字一致：`{caseId:"v2-path-boundary", expectedDecision:"block", actualDecision:"allow", errorType:"validation_failed", message:"Expected block but got allow"}`，`failure.layer=rule, reasonCode=replay_decision_mismatch`。

### 4.2 判定 × 证据对照

| # | 判定 | 证据 |
|---|---|---|
| E1 | 工具取 `affectedTools[0]`、路径取 `positiveCases[0].params.path`、无配对校验 | `evaluator-runner.ts:2994-3045`（代码）；S1 探针 4 工件全部复现（§7 probe-report S1） |
| E2 | Owner 正例恒为首条正例：`case-positive-6`（ls） | 4 工件 `positiveIds` 首位实测；prompt 对 Owner 用例只约束「逐字回显」无顺序约束（`artificer-prompt-builder.ts:305-306`），位置是模型遵循 OUTPUT FORMAT 布局的惯例 |
| E3 | `affectedTools[0]` 由模型输出决定 | 4 工件 affectedTools 实测（A-r2 恰为 `ls` 在首位）；validator 不校验顺序（`validateV2OutputContract:496-509` 只按 caseId 找） |
| E4 | `v2-path-boundary` 目标=`positiveCases[0].path + '.bak'`，期望由 isHelperPath 决定 | `v2-adversarial-cases.ts:211-222`；S1 派生 `{"path":"..bak","expected":"block"}` |
| E5 | oracle 硬编码 block；v2 规则无出界逃生 | `rule-reliability-validation.ts:123-131`；`validateV2OutputContract:487` 强制 v2 |
| E6 | 真实规则 = 受保护标记匹配语义 | 4 个 rule 工件 implementationCode 实测（09:02/09:09/09:33/09:42 四份，形态一致：标记→block、/etc→block、无标记→allow；其中 B-r1 存在 `version!==2→allow` 先于 isRiskPath 的守卫次序瑕疵——即 #1980 报告 §7.1 顺带发现①） |
| E7 | 模型自写正例 = 「write 普通路径 + priorRead:'no' + 期望 allow」 | 4 工件正例 facts 实测：`case-pos-write-normal`/`case-pos-edit-normal`/`extra-write-normal`/`write-normal-extra`/`boundary-allow-workspace-file` 全部 `history:available, priorRead:'no'` |
| E8 | 换 write 正例后冲突依旧 | S3 探针：reordered 目标 `workspace/readme.md(.bak)` 下 4 条真实规则仍全部失败于 `v2-path-boundary` |
| E9 | r9-proxy（读后再写语义对照规则）能过模板但过不了模型正例 | S3 探针：`case-pos-write-normal: Expected allow but got block` ——同 trace 内矛盾的直接实证 |
| E10 | 09:09:55（A-r2）确定性重放未执行 | S5 探针：v2Cases=0；宿主声明（.pd/host-tool-semantics/openclaw.json）无 `other` 类工具 → hostAliasCase 亦跳过（`ls` 在 baseline 无映射 → other，`tool-semantic-baseline.ts:38-61`）；merged=0 → `skipReason=no_adversarial_cases_after_merge`（`evaluator-runner.ts:2660-2667`）；与该 run 输出无 adversarialResult、工件 [evaluation] 一致。注意：hostSemanticContext 在生产**有**接线（`rulehost-pipeline-runner.ts:465-505`），跳过原因是「宿主无同类工具」而非「未注入」 |
| E11 | 负例=Owner 标注的 ls 失败（非未授权写入）；正例=普通目录 ls 成功 | trajectory `tool_calls` id=5/id=6 实测；装配器按 kind 硬编码 expectedDecision（`behavior-example-pack-assembler.ts:126-127`） |
| E12 | r9 pack 新增受保护路径只读确认约束；时间线在链 B 之前 | `behavior-examples-r9.json` mtime 09:20:13Z + 文本新增句实测；链 B dreamer 09:20:38Z；链 A 全部 run 早于 r9 mtime → 只能用旧版 |
| E13 | 「对普通非受保护路径不触发冗余确认」无 Owner 来源 | 两版 pack `ownerDesiredOutcome` 全文均无此句（§4.3 引文）；该句仅存在于链 B scribe 工件 `intentContract.validationExpectation` |
| E14 | evaluator LLM 评判与 r9 Owner 文本相悖 | 09:33/09:42 evaluation.summary 批评「对只读 ls 也 block」；而 r9 明文「访问受保护路径（包括只读 ls）同样需要先确认」——评判依据的 intentContract 已丢失该 Owner 约束 |

### 4.3 两版 Owner pack 原文（关键句）

- `behavior-examples.json`（mtime 2026-10-10T00:30:24Z，链 A 使用）：
  > AI 在写入任何受保护路径（如 protected/）之前，必须先解析并向 Owner 确认精确目标路径，未经确认禁止执行写入。
- `behavior-examples-r9.json`（mtime 2026-10-10T09:20:13Z，链 B 使用——见 E12 的证据边界说明）：
  > …AI 在执行写入/覆盖这类有后果的变更前，必须先解析并向 Owner 确认精确目标路径，并确认该目标现状已被读取/检视；未经确认不得写入，尤其不得写入 protected/ 等受保护目录。访问受保护路径（包括只读 ls）同样需要先确认。

注：r9 文本把「写入前须已读取/检视目标」表述为**普适**写入约束（「尤其」引出受保护目录为强调项），与链 A 版（仅约束受保护路径）不同。这一语义分歧本身未进入本轮假设裁决（两链规则的实测语义都是标记匹配），但它是 §5-H4 与 §6 修复路径论证的相关事实。

### 4.4 r9 进入链 B 的取证状态

chain A/B 的 artificer 提示词字节未持久化（L2 run `input_payload`=NULL；网关/事件日志不覆盖 09 点窗口；`.pd-p1test` 与 `_pdtest` 全文检索无第二处 r9 文本）。因此「链 B 使用 r9」的依据是：mtime（09:20:13Z）+ 命名（r9 = 第 9 轮修订）+ 链 B dreamer 紧随其后 25 秒。**判定：高度可能（Strong circumstantial），无逐字节证据**——不影响本轮结论（两链规则的实测语义相同，且该差异不改变 §5 任一假设的裁决），但按诚实性边界记为证据边界。

---

## 5. Hypothesis Results（四个候选根因的裁决）

### H1 样本选择（正例是一条 ls 观测）— **Confirmed（作为触发器），但单独修正不足以解除**

- Confirmed 部分：`positiveCases[0]` 恒为 Owner 标注的 `case-positive-6`（E2），其 path `.` 被拼成 `..bak`（E4）；装配器允许 Owner 标注与被治理工具不同 kind 的样本且下游无校验（§3.4）。
- 不足的部分：S3 对照——改为真实 write 正例在前，四条真实规则**仍在同一条用例上以同一消息失败**（E8）。样本选择只决定失败路径字符串。
- 裁决：**Confirmed（触发器 + 独立实现缺口），非充分修复点**。

### H2 工具匹配（write 工具 × ls 样本跨动作组合）— **Confirmed（实现缺口）**

- `generateV2CasesFromArtificer` 从两个独立序列各取首项，无「同一动作」校验（E1）。工具序列顺序由模型输出决定（E3），正例顺序由模型 echo 布局决定（E2）——两者恰好错配时，模板描述了一个从未发生过的动作（write `..bak`）。
- prompt 从未告知模型「第一个正例的 path 是确定性 gate 的写目标」（OUTPUT FORMAT/CONTEXT MODE 全文无此耦合提示）——模型不可能主动避免。
- 这是本轮可指认的**最小、最明确的实现缺陷**：一个缺失的前置校验。
- 裁决：**Confirmed**。

### H3 模板适用范围（读后再写家族 vs 受保护确认原则）— **Confirmed（结构性，且已实证为同 trace 矛盾）**

- 模板设计 SPEC §10.1 明确验收表是「读后再写」规则族（§3.3）。
- 同 trace 矛盾实证（E7+E9）：模型正例「write 普通路径未读→allow」与模板例「write 普通路径未读→block」形状相同、期望相反。任何确定性规则二者不可兼得——除非正例路径为 helper 段（EP002-R4 豁免把期望翻为 allow）。
- 由此推出**路径类 × 可通过性矩阵**（对照 S1/S3 + 代码推导，risk-path 例由 guard contract 与 isSensitiveSystemPath 满足）：

| positives[0].path 类别 | v2-unavailable | v2-alias | v2-path-boundary | 全 5 例 |
|---|---|---|---|---|
| 普通路径（如 `.`、`workspace/readme.md`） | allow✓ | allow✓ | **block ✗**（标记规则 allow / r9-proxy rule block——但 r9-proxy 随即死于模型正例） | ✗ |
| 受保护路径 | **allow ✗**（模板要求 unavailable 时 allow，忠实规则对受保护路径无论如何 block） | **allow ✗**（模板要求 priorRead=yes→allow，忠实规则无确认标志仍 block） | block ✓ | ✗ |
| helper 段（tmp/temp/draft） | allow✓ | allow✓ | allow✓（豁免） | **✓（唯一可满足类）** |

- 裁决：**Confirmed**。模板对「protected 确认」类原则只在 helper 段正例下可满足——这正是 r3 候选 (c) 的机制依据，本轮再次独立实证。

### H4 上游证据与意图不一致 — **Confirmed（三处，性质各异）**

1. **Owner 证据无法表达被治理行为**（Confirmed）：incident 会话无写动作可标注（E11），pack 机制把 ls 行硬编码为负例 block/正例 allow；派生模板随后把这条读观测当作写目标。
2. **Scribe 派生句无 Owner 来源**（Confirmed 为「无来源」，是否违背 Owner 意图 = Unknown→收敛）：「对普通非受保护路径不触发冗余确认」在两版 pack 均不存在（E13）。它把规则生成推向标记匹配语义——与模板矛盾的直接推手。按 #1980 报告的口径，此句 Owner 来源记 Unknown；本轮补充的精确事实是：**该句与 r9 文本不矛盾（r9 未对普通路径作任何断言），但也不是 Owner 的断言**——它是 Scribe 的派生。
3. **evaluator LLM 评判与 Owner 文本相悖**（Confirmed）：评判批评「只读 ls 也 block」（E14），而 r9 明文要求。LLM 评判依据的 intentContract 丢失了 r9 的 Owner 约束——Scribe 派生保真缺口。
4. r9 是否进入链 B：高度可能、无逐字节证据（§4.4）。

### 汇总表

| 假设 | 裁决 | 一句话依据 |
|---|---|---|
| 样本选择 | Confirmed（触发器）；非充分修复点 | E2/E4/E8 |
| 工具匹配 | Confirmed（实现缺口，最小修复点） | E1/E3 + §3.1 代码 |
| 模板适用范围 | Confirmed（结构性，同 trace 矛盾） | E5/E7/E9 + §3.3 SPEC + 矩阵 |
| 上游证据/意图不一致 | Confirmed（三处；Owner 政策层面本轮不动） | E11/E13/E14 |

---

## 6. Minimal Fix Recommendation

### 6.1 修复一（实现缺口，无需 Owner 政策变化）：派生前置守卫——样本 canonicalKind 配对校验

- **最小修改位置**：`packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts` 的 `generateV2CasesFromArtificer`（:2988-3069），在 `:3047` canonicalKind 解析后、`:3064` 模板调用前，增加一条判定：`positiveCases[0]` 的样本 canonicalKind（`canonicalizeToolKind(positiveCases[0].toolName)`）若与派生工具的 `canonicalKind` 不同类（本例 read/other vs write），发 `v2_adversarial_cases_skipped`（reason 如 `positive_case_kind_mismatch_with_target_tool`）并返回 `[]`——与既有 `non_write_canonical_kind_for_v2_adversarial_cases` 分支同族的 rc-9 处理（可观测降级，不改 gate、不改模板、不改 oracle）。
- **应复用的现有机制**：既有 skip + 遥测分支（:3054-3063）就是该模式的现成实现；合并空集的下游行为（skipReason → fail-loud/诊断路径缺 replay 证据）也全部现成（:2660-2667）。零新增概念。
- **为什么更小的改动不足**：不改则未来任何「Owner 只有读样本」的链都会重演——用读观测拼出写模板目标。这是已证实的缺陷类，不是假想轴。
- **必要性边界（诚实声明）**：此修复**只消除荒谬目标**，**不解除 B-1**——S3 已证换正确 write 正例后模板矛盾仍在。B-1 解除依赖修复二。
- **回归测试**：①真实工件形状 fixture：`affectedTools[0]='write'` + 首正例 `toolName='ls'` → 返回 `[]` + 遥测 reason；②首正例 `toolName='write'` → 正常派生 5 例；③`affectedTools[0]='ls'` → 维持既有 skip reason 不变。全部走 `EvaluatorRunner` 公有行为（沿用 `__tests__/evaluator-gate-authority.test.ts` 的既有桩模式）。
- **回滚**：单 commit revert；无持久化 schema/flag 变化。
- **Complexity Delta**：全 NO——无新真源/状态/子系统/接口/flag/依赖/宿主行为/外部能力；净效果是把一个隐式错误路径变成显式可观测降级。

### 6.2 修复二（B-1 解除路径，无代码）：重采 Owner 样本（r3 候选 (c) 的机制再次实证）

- 由 Owner（或 Owner 授权入口）在测试沙箱采集**真实的 write 动作正例**，其路径落在**已证的 helper 段**（`tmp/temp/draft`；**不含** `backup/backups`——r2 的豁免扩写已被 r3 纠正），加入 pack 的 `positiveToolCallIds`（使首条正例为 helper 段写动作），然后重跑 `pd runtime internalization run-rulehost … --behavior-examples … --confirm`。
- 机制依据：矩阵（§5-H3）+ S1/S3 探针——helper 段正例下全部 5 例期望与标记规则语义重合（allow），且守卫契约保证 risk-path 例仍 block。
- **治理性质**：证据采集与重跑，不是政策变更；gate、校验器、Owner 意图文本零改动。
- **诚实边界**：helper 段方案下模板演示的是「helper 写允许 + 风险路径 block」——对「受保护写前确认」原则的**拦截面**断言仍主要由 Owner 负例（case-negative-5）与模型负例承担，模板覆盖依然偏弱；这是覆盖广度的已知局限，不是本轮新缺陷，不应在报告中表述为「已完全验证原则行为」。

### 6.3 不推荐 / 需 Owner 另行裁决的路径（本轮不预设）

- **改 oracle 口径**（为「原则不治理域」增加 helper 同族豁免）：影响所有 v2 规则的确定性 gate，属治理契约变化，需 ADR + Owner 批准；本轮证据不足以证明其必要性优于 6.1+6.2 组合。
- **改 Scribe 派生约束**（让 intentContract 对 `.bak` 兄弟路径明确表态）：`intentContract` 是 LLM 产物，能否稳定产出目标句 = Unknown（#1980 报告已记）；且它治标——同 trace 矛盾的根源在模板家族 × 样本通道。
- **重排 affectedTools 让模板跳过**（A-r2 形态）：已证是「无重放证据」而非通过（E10），不得作为解除手段。

### 6.4 恢复原 Golden Journey 的顺序

1. 落地 6.1 守卫（防复发的实现修复）。
2. Owner 重采样本（6.2）。
3. 重跑 run-rulehost 对抗循环 → Console 审批 → code_tool_hook 激活 → 重放 GJ 会话写受保护路径采集拦截链证据 → Owner 结果提交 → 六条完成标准逐条重新取证（#1980 报告 §7.5 口径不变）。

### 6.5 验证与回滚汇总

| 项 | 验证 | 回滚 |
|---|---|---|
| 6.1 | 新增 3 条 runner 行为测试 + `npx vitest run src/runtime-v2/internalization` + `npm run verify:merge` | revert 单 commit |
| 6.2 | 新链 4 个 artificer run succeeded + evaluator adversarialResult.passed=true（或按矩阵预期的 in-scope 失败清零）+ GJ 拦截链证据落库 | 无代码；停用新激活即可（SPEC §13.10 既有回退） |

---

## 7. 可重跑命令与产物

环境：诊断 worktree `D:\Code\_worktrees\principles\adhoc-20261010-b1-diagnosis-offline-diagnosis`（@ `11fd5090`，bootstrap READY）。全部脚本位于 worktree `.tmp/b1-diagnosis/`（gitignore 路径，不入库——沿用 #1980 报告 §7.7 的只读探针先例）：

```bash
# ① 历史库只读转储（better-sqlite3 readonly:true，参数绑定查询）
node .tmp/b1-diagnosis/dump-db.mjs          # → .tmp/b1-diagnosis/dump-full.json（0.43MB）
# ② 聚焦分析（runs/artifacts/tasks/trajectory/pain）
node .tmp/b1-diagnosis/analyze2.mjs          # → analysis2.json
# ③ 离线对照（生产 dist + 生产 sandbox；改动输入均标注「离线诊断对照」）
node .tmp/b1-diagnosis/probe-b1.mjs          # → probe-report.json（S1–S5）
# ④ PR/merge 状态
gh pr view 1980 --json state,mergeCommit,headRefOid
```

关键结果摘录（全文在 probe-report.json）：

```text
S1 as-is（4 真实工件）：
  09:02:01  affectedTools[0]=write  positives[0]=case-positive-6  → v2-path-boundary {"path":"..bak","expected":"block"}
  09:09:55  affectedTools[0]=ls                           → skipped (non_write_canonical_kind_for_v2_adversarial_cases, canonicalKind=other)
  09:33:13  / 09:42:42：同 09:02:01
S2 reorder（对照：write 正例提前）→ target=workspace/readme.md，v2-path-boundary={"path":"workspace/readme.md.bak","expected":"block"}
S3 replay：
  as-is（target=.）            → rule@09:02/09:09/09:33/09:42 全部 "v2-path-boundary: Expected block but got allow"
  reordered（target=readme.md）→ 同上四条规则同用例同消息失败
  r9-proxy(离线诊断对照)        → 通过全部 5 例模板；死于模型正例 case-pos-write-normal / case-pos-edit-normal
                                 （"Expected allow but got block"——同 trace 矛盾实证）
S4 no-path（对照）→ skipped (no_path_param_for_v2_adversarial_cases)
S5 ls-first → v2Cases=0；host 声明无 other 类工具 → hostAlias 亦跳过；merged=0 → 重放未执行
```

脱敏说明：本报告不含凭据、不含 Owner workspace 真实数据正文（pain 文本为乱码编码未引用原文，仅引用 pack JSON 与 intent 原文——均为验收报告已入库内容）；所有数据库连接 readonly。

---

## 8. Remaining Unknowns（真实缺口及取得方式）

| # | 缺口 | 为什么本轮无法闭合 | 取得方式 |
|---|---|---|---|
| U1 | 链 B 是否逐字节使用了 r9 pack | L2 prompt 未持久化；网关/事件日志不覆盖 09 点窗口 | Owner 认可后在下轮 run-rulehost 落盘 prompt 摘要（如 input_payload 持久化或在遥测中记 pack 文件 digest）；或在已知命令行的验收工作底稿中核对（本地未跟踪文件，本轮范围外） |
| U2 | 「对普通非受保护路径不触发冗余确认」是否有 pack 之外的 Owner 口头来源 | 只能 Owner 本人回答 | 问 Owner；若否，建议在 SPEC 或 pack 中显式落 Owner 口径，消除 Scribe 自由派生空间 |
| U3 | helper 段方案下 evaluator LLM 评判是否会再引入新的语义冲突（评判已两次展现与 Owner 文本相悖的口径） | LLM 评判非确定性；本轮未跑真实链 | 6.2 重跑时直接观察 evaluation.summary；若再现评判 × Owner 文本相悖，按 U2 收口 intentContract |
| U4 | 完整合并用例集下「受保护写」截面的模板覆盖广度是否满足 Owner 对 GJ-01 的验收预期 | 覆盖广度是产品判断，不是工程事实 | Owner 裁决；若不足，进入 §6.3 的治理路径 |

---

## 9. 完成标准逐条回答（任务 §九）

1. **哪个事实直接导致了三次 replay mismatch？**
   `generateV2CasesFromArtificer` 把 `affectedTools[0]`（=write，模型输出）与 `positiveCases[0].params.path`（=Owner 标注的 `ls {"path":"."}`）无配对校验地组合，模板据此对拼接路径 `..bak`（非 helper 段）硬编码期望 `block`，而链上四条真实规则（受保护标记语义）对无标记路径一律 `allow`。三次失败共用同一确定性用例与同一消息（E1/E4/E5/E6 + S3 as-is 复现）。
2. **这个事实为什么构成缺陷，依据是什么？**
   两层：①「工具与路径来自不同动作的样本且无校验」违反最小正确性——模板描述了一个从未发生的动作（write `..bak`），且 prompt 未向模型披露该耦合，模型不可能避免（H2）；②「模板把读后再写家族契约强加给受保护确认原则」——同 trace 内与模型正例形状相同、期望相反（E7/E9），模板设计 SPEC 的验收表本身限定于读后再写规则族（§3.3）。依据均为现行仓库代码 + 现行 SPEC + 生产方法实证，非记忆或 SPEC 假设。
3. **单独修正样本配对是否足够？对照证据？**
   不足。S3 对照：把模型自写 write 正例提到首位（生产方法实测派生目标变为 `workspace/readme.md.bak`），四条真实规则在同一条 `v2-path-boundary` 上以同一消息失败；r9-proxy 规则能过模板却过不了模型正例（反向矛盾）。配对修复只消除「荒谬目标」这一缺陷，模板矛盾需 helper 段正例（或 Owner 裁决的口径扩展）才能消除。
4. **是否还存在模板适用范围问题？**
   存在（H3 Confirmed）：模板 5 例编码读后再写家族契约；对「protected 确认」原则，唯一全通过的正例路径类是 helper 段。即便走了 helper 段方案，模板对该原则拦截面的覆盖广度仍是已知局限（§6.2 诚实边界 / U4）。
5. **是否需要改变 Owner 政策？**
   本轮证据下**不需要**。6.1（实现守卫）+ 6.2（重采样本）可保持现有 Owner 意图文本与 gate 不动。若 Owner 希望模板覆盖「protected 确认」类原则的一般形态（而非借助 helper 段绕行），那是 §6.3 的治理契约变化，须 Owner 显式裁决——本轮不预设、不推荐默认走这条。
6. **下一项最小实施任务？如何验证与回滚？**
   ①`generateV2CasesFromArtificer` 增加「首正例 canonicalKind 与派生工具同类」前置守卫（复用既有 skip+遥测分支；3 条 runner 行为测试 + verify:merge；revert 单 commit）；②Owner 重采含 helper 段 write 正例的 pack 并重跑链路（无代码；以新链 adversarialResult 与 GJ 拦截链证据验证；停用激活即回退）。①是防复发守卫，②是 B-1 解除条件，二者独立。

---

## 10. 边界遵守声明

- 未修改生产代码 / validator / oracle / gate / 模板 / Owner pack / intent / 激活 / ADR / 安装目录 / workspace `.pd` 状态（历史库 readonly 连接；worktree 内仅新增 `.tmp/b1-diagnosis/` 探针与本报告）。
- 未重排生产 affectedTools；未以改采样宣称问题解决（S2/S3 全部标注「离线诊断对照」）。
- 未调用任何 LLM；未创建/合并/发布 PR；未升级 Codex pin；未扩大 Phase 1。
- Phase 1 判定维持 PARTIAL；本报告不解除 B-1。
