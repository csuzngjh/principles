# RuleHost / Gate 语义差异审计与安全收敛方案

> 范围：架构评审报告第 2 项「RuleHost / Gate 收敛成 1 个决策内核」。
> 性质：设计阶段只读审计。不建分支、不提交、不改产品代码。
> 日期：2026-11-12
> 基线：审计开始时本地 `main` = `f15798cf1`（落后 `origin/main` **216** 个提交，不含 PR #2546 / Task 1）。审计进行中，另一会话把工作树推进到 `38ef59848`（== `origin/main`）。**最终结论与所有行号以当前工作树 `38ef59848` 为准。**
> 关键提醒：当前工作树已包含 PR #2546（`801bc8a43`，`isRuleHostEvaluableKind` 入口契约）；legacy `handleBeforeToolCall` 已无生产接线。任何收敛方案必须以 `38ef59848` 为起点，否则会把已经修过的语义再改回去。

---

## 0. 结论摘要

1. 「4 套实现」的准确形态是 **4 个语义层**：OpenClaw 编排层（`rule-host.ts` + `gate.ts`）、host-runtime 共享门、pd-cli 生成/激活管线、core 契约件。OpenClaw 与 host-runtime 的**判定合并逻辑已经共用 core**（`mergeDecisions` / `normalizeRuleHostResult` / `validateRuleHostResult`）；pd-cli 只共用 validator / action builder。真正的分叉在「输入怎么造、入口怎么路由、失败怎么降级、副作用谁写」。
2. 当前工作树上 OpenClaw legacy 路径已经**没有生产调用者**（`handleBeforeToolCall` 只被测试调用），OpenClaw 的 `RuleHost` 类也只被这条死路径调用。所谓的「4 套并行」实际上是 **1 条活路径 + 1 条待删除死路径 + 1 条生成期路径 + 1 套共享契约**。
3. 活路径（host-runtime 共享门）与生成期路径（pd-cli refiner）在**同一份非法/边界输出上结论不同**：空 reason 的 `block` 在生成期被判为合法、在运行期被判为放行；v2 规则在生成期可被接受、在历史不可用时运行期被挂起。这不是写法差异，是产品语义分叉。
4. 最危险的不是「代码重复」，而是 **entry contract 与 path guard 自相矛盾**：`isRuleHostEvaluableKind` 明确准入 `agent`，但紧接着的空路径守卫会让无 `path/file/target/file_path` 参数的 `sessions_spawn` 永远不会被评估（当前工作树现状）。
5. 旧路径与新路径在 **RuleCode 可见输入** 上不一致：`workspace.isRiskPath`（旧恒 `false`，新按敏感路径计算）、`evolution.epTier`（OpenClaw=1，Codex/WorkBuddy=0）、`derived.estimatedLineChanges`（是否带 registry）。规则代码会读这些字段，因此这是可改变判定的差异。
6. 安全电路的状态机在 core（`rulecode-safety-circuit-breaker.ts`），但**生产观测/隔离入口只在 OpenClaw 适配层**（`rulecode-safety-circuit.ts` 的 `observeRuleCodeSafety`）；共享门只在 `auto_correct` / `requireApproval` 上调用它，`block` 分支直接 return deny，不经过电路。旧路径在 `block` 前调用电路。两者对「规则阻断恢复命令」的处理相反。
7. 收敛不应发明新的 `verdict: allow|block|degrade` 枚举（架构报告 §4.2 的形状），而应继续用现有的 `decision` 作为唯一裁决字段（`rule-host-result-normalizer.ts:21` 已明确此契约）。新增枚举会把「实现重构」变成「语义变更」。
8. 建议分 5 个阶段：冻结语料 → 入口收口 → 输入统一 → 副作用归位 → 删除死路径。每阶段以**差分语料零差异**为闸门；出现任何「新路径更放行」立即停手。

---

## 1. 取证方式与证据等级

| 等级 | 含义 | 本次使用 |
|---|---|---|
| `[命令]` | 真实命令输出 | 行数、git 祖先关系、文件命中数 |
| `[源码]` | 直接阅读生产源码 | 判定顺序、失败分支、字段 |
| `[测试源]` | 阅读测试文件，未执行 | 已锁定的行为、测试缺口 |
| `[NOT RUN]` | 未执行 | 本次所有测试均未运行 |

**为什么测试是 NOT RUN**：本工作区被标记为 untrusted folder（不得执行其中的脚本/命令），且另有会话正在改 `pd-cli` 测试。运行 vitest 会执行工作区代码并可能与其写入冲突。按任务纪律「跑不动就写 NOT RUN」，本次只做静态取证；冲突结论均指向源码行或测试文件，不依赖运行结果。

**行数复核** `[命令]`（`(Get-Content $f).Count`；Total lines，含空行）：

| 文件 | 行数（`38ef59848`） |
|---|---:|
| `openclaw-plugin/src/core/rule-host.ts` | 947 |
| `openclaw-plugin/src/hooks/gate.ts` | 987 |
| `openclaw-plugin/src/hooks/gate-block-helper.ts` | 345 |
| `host-runtime/src/production-rulehost-gate.ts` | 801 |
| `pd-cli/src/services/rulehost-pipeline-runner.ts` | 1279 |
| `pd-cli/src/services/rulehost-readiness.ts` | 326 |
| `core/.../rule-host-input-builder.ts` | 364 |
| `core/.../rule-host-validator.ts` | 194 |
| `core/.../rule-host-evaluator.ts` | 159 |
| `core/.../rule-host-contracts.ts` | 112 |
| `core/.../rule-host-result-normalizer.ts` | 67 |
| `core/.../refiner-rulehost-gate.ts` | 248 |
| `core/.../activation/writers/rule-host-writer.ts` | 445 |

> 注：审计开始时（`f15798cf1`）与 `origin/main` 的 `gate.ts` 有 635 行差异；推进到 `38ef59848` 后差异消失。本报告的所有行号均按推进后的文件读取。

架构报告写的 `842 / 802 / 705 / 1226` 与当前 HEAD 对不上（例如 `rule-host.ts` 实为 947、`gate.ts` 实为 987、`production-rulehost-gate.ts` 实为 801、`rulehost-pipeline-runner.ts` 实为 1279）。**本报告以命令输出为准，不引用报告数字。**

其他复核 `[命令]`：

- 审计开始时 `git rev-list --count HEAD..origin/main` → `216`；结束时 HEAD 已推进到 `38ef59848`，`801bc8a43` 现为 HEAD 祖先。
- `rg "apply_patch" packages/**/src/**/*.ts` → 17 个文件、36 处；其中 **9 个非测试源文件**（与架构报告一致），8 个测试文件。
- `git grep handleBeforeToolCall` → 生产源码只剩 `gate.ts:356` 定义，`index.ts` 不再导入；其余命中全是测试注释。
- 文档与代码不一致：`docs/plans/2026-11-10-b-series-tool-semantics-contract-plan.md:285` 仍称「`index.ts:507` 在 `auto_correct/requireApproval` 时回退 legacy」；该描述早于 Task 1 合并，当前 `index.ts:508` 只走共享 handler。本报告以代码为准。

---

## 2. 四套实现清点表

> 约定：所有行号以**当前工作树 `38ef59848`（== `origin/main`）**为准。「活」= 有生产调用者；「死」= 仅测试/仅被死路径调用。

### 2.1 清点

| # | 实现 | 文件（行数） | 对外入口 | 调用者与时机 | 返回形态 | 副作用 |
|---|---|---|---|---|---|---|
| A | **OpenClaw 运行时**（两层） | `core/rule-host.ts`（947）；`hooks/gate.ts`（987）；`hooks/gate-block-helper.ts`（345） | `RuleHost.evaluate`（196）、`evaluateDetailed`（211）；`handleBeforeToolCall`（356）；`handleSharedRuleHostResult`（723） | `index.ts:645` 先走共享 dispatch；`onBeforeToolResult:500` 只调 `handleSharedRuleHostResult:508`；legacy **无生产接线**（`gate.ts:356` 仅测试调用）。RuleHost 类只被 legacy `gate.ts:400` 调用 → **死**。 | RuleHost：`RuleHostResult \| undefined` / `RuleHostEvaluationReport`；gate：`{block,reason}` / `{params}` / `void` | SQLite 读 + 进程内缓存；`EventLog.recordRuleHostUnhealthy/Skipped`（rule-host 896/932）；安全隔离写库（888）；gate 写 `rulehost_evaluated/enforced/blocked/requireApproval`、receipt ledger、trajectory gate_blocks、应用 auto_correct（改 `event.params`）；共享 handler 写同一批事件 |
| B | **host-runtime 共享生产门** | `production-rulehost-gate.ts`（801） | `createProductionRuleHostGate`（153） | `host-runtime/src/index.ts:302` → `createHostRuntime` 的 `before_tool_call` dispatch；OpenClaw / Codex / WorkBuddy 三宿主每次工具调用 | `HostEventResult = { decision:'allow'\|'deny', reason?, warnings?, metadata? }`；metadata 带 `evaluatedLiveRules / ruleDecision / matched / ruleId / principleId / ruleReason / correctionProposal / evaluations` | 不写事件、不改 params；只写 workspace 外的 degraded marker（252、303）；事件由宿主适配层（A 的 shared handler）翻译 |
| C | **pd-cli 生成 / 激活管线** | `services/rulehost-pipeline-runner.ts`（1279）；`services/rulehost-readiness.ts`（326）；`core/.../refiner-rulehost-gate.ts`（248） | `runRuleHostPipeline`（259）；`createSandboxGateDeps`（237）；`evaluateRefinerRuleHostGate`（115） | `commands/runtime-internalization-run-rulehost.ts:707`；`ArtificerL2Adapter`（`artificer-l2-adapter.ts:272`）；`RuleHostWriter.canActivate`（`rule-host-writer.ts:204`）在**激活前**调用；**不是每次工具调用** | `RuleHostPipelineResult`（stage 列表 + accepted/rejected）；`RefinerRuleHostGateResult = { decision: accepted_shadow \| rejected_*, applicationMode, reasons, failedCases, failure{reasonCode,layer,evidence,nextAction} }` | 生成期写 artifact/activation/审批；sandbox 只读重放；`RuleHostWriter.activate` 固定 shadow-first（360-377） |
| D | **core 契约件** | `rule-host-contracts.ts`(112)、`input-builder.ts`(364)、`validator.ts`(194)、`evaluator.ts`(159)、`normalizer.ts`(67)、`helpers.ts`(36)、`adapter.ts`(15)、`writers/rule-host-writer.ts`(445) | `mergeDecisions`（evaluator 46）；`normalizeRuleHostResult`（normalizer 43）；`validateRuleHostResult`（validator 70）；`buildRuleHostAction`（builder 321）；`isRuleHostEvaluableKind`（builder 312）；`canActivate`（writer 204） | A/B 直接 import；C 通过 writer / refiner gate 使用 | 纯值：`RuleHostResult`、validation errors、normalized result、`CanActivateResult` | evaluator / normalizer / validator **纯函数、无 I/O**；writer 与 refiner 有 DB/文件副作用 |

### 2.2 四套的真实关系

```
host payload ──(B: registry/readToolInput)──┐
                                            ├─ buildRuleHostAction ─→ RuleHostInput ─→ mergeDecisions ─→ decision
A legacy buildRuleHostAction (dead) ────────┘                                      ↑
                                                                          normalize + validate (D)
C golden trace / sandbox ──→ compileDemoRule ─→ validateRuleHostResult (D) ─→ accepted_shadow
```

- **A、B 已经共用 D 的 merge/normalize/validate**；A 是「SQLite 读 + VM 执行 + 事件写入」的宿主外壳，B 是「SQLite 读 + 子进程 VM + 边界/预算」的另一套外壳。
- **C 不是运行时判定**：它评估的是「这条规则在历史用例上是否可信」，与「这次工具调用该不该拦」不是同一决策。把 C 并入运行时内核是范畴错误；C 只需要共用 D 的 validator / normalizer / action builder。
- 因此「收敛成 1 个决策内核」的正确目标是：**B 成为唯一运行时内核；A 删除；C 只共用契约件；D 明确为无副作用内核**。

---

## 3. 语义矩阵

### 3.1 输入契约

| 维度 | A OpenClaw | B host-runtime | C pd-cli | D core |
|---|---|---|---|---|
| 输入对象 | `RuleHostInput`（手工装配） | `RuleHostInput`（门内装配） | `{code, goldenTrace, toolSemantics, projectDir}` | `RuleHostInput`（契约定义） |
| 字段来源 | `action` 由 legacy builder；`workspace/session/evolution/derived/context` 手工填（L115-131） | 原始 payload 先 `readToolInput` 校验（O159-162），kind 由 registry 解析（O164），action 由共享 builder（O174） | golden-trace case 的 `action`；`createSyntheticRuleHostInput` 复用 builder | 定义字段与必填性 |
| 缺字段 | 无 schema 校验；缺字段由规则自己 `\|\| ''` | `tool_input_invalid` → allow + warning（`production-rulehost-gate.ts:159-162`）；缺路径 → allow（`:179`） | 无 case → `rejected_no_cases`（refiner 125-134） | validator 拒绝非法 result；input 无 runtime 校验 |
| `normalizedPath` 空值 | `null`/`''` 都继续评估（只判 `=== null`，`gate.ts:396`） | `null` 或 `''` 都 **allow**（`:179`） | 由 case 决定；无路径 case 可显式给出 | builder 对 null 返回 `''`（329-331）；write 工具返回 `<tool:name>`（253-258） |
| `workspace.isRiskPath` | 恒 `false`（`gate.ts:408`） | `isSensitiveSystemPath(path)`（`:605`） | 由 fixture 决定 | 字段定义 |
| `evolution.epTier` | 恒 `1`（`gate.ts:414, 645-649`） | 默认 `0`（`:195`），OpenClaw enrichment 覆盖为 `1`（`gate.ts:660-665`）；Codex/WorkBuddy 无 provider → `0` | 不适用 | 字段定义 |
| `derived.bashRisk` | bash 工具用共享分类器，其余 `unknown`（`gate.ts:651-657`） | 默认共享分类器（`:196`），可被 enrichment 覆盖 | fixture 提供 | `classifyBashRisk`（bash-risk 815-825） |
| `derived.estimatedLineChanges` | `estimateLineChanges({toolName,params})`（`gate.ts:417` 带 registry） | `estimateLineChanges(..., toolSemantics)`（`:608`） | fixture 提供 | 基于工具名的启发式（risk-calculator-policy 28-58） |
| `context` | flag OFF → `undefined`；flag ON 失败 → `UNAVAILABLE_RULE_CONTEXT`（`gate.ts:680-720`） | provider absent → `undefined`；invalid/failed → sentinel（`:214-235`） | fixture 提供 | `RuleContextV2` 类型 |

### 3.2 判定顺序

| 实现 | 顺序 |
|---|---|
| D `mergeDecisions` | 按 implementation 顺序遍历：`block` 立即短路 → 收集 `auto_correct`（第一个合法 proposal 胜）→ 合并 `requireApproval` → `allow` 无意见（evaluator 61-152）。注释明确优先级 `block > auto_correct > requireApproval > allow`（evaluator 8） |
| A RuleHost | live implementations 走 D 的 merge；shadow 永不参与 merge，只进 `shadowDecisions`（rule-host 214-243） |
| A legacy gate | `block`（`gate.ts:482`）→ `requireApproval`（`gate.ts:572`，只记录）→ `auto_correct`（`gate.ts:580` 起，应用 params）→ 其余放行 |
| B 共享门 | `deny`（`production-rulehost-gate.ts:759-765`）→ `auto_correct`/`requireApproval`（`:830-875`）→ allow；安全电路在非 block 分支之前（`:834`） |
| C refiner | 无 case → sandbox throw → forbidden pattern → `success=false` → timeout → runtime_error → validation_failed → 其余 rejected → `accepted_shadow`（refiner 125-235） |

**注意**：`block` 是「迭代顺序 first-wins」。A/B 的候选都按 `ORDER BY activated_at ASC`（rule-host 402；`production-rulehost-gate.ts:323`），所以顺序一致；但这是**隐式契约**，收敛时必须显式冻结排序，否则差分测试会出现「同一组规则、不同 block reason」。

### 3.3 失败模式

| 情形 | A OpenClaw | B host-runtime | C pd-cli |
|---|---|---|---|
| 宿主内部异常 / 外层 throw | `evaluationStatus='failed'`，`liveDecision=undefined` → 放行（rule-host 274-280；`gate.ts:431-435`） | provider 异常 → warning + 继续；DB 读失败 → allow + warning（`production-rulehost-gate.ts:252-253`） | sandbox throw → `rejected_runtime_error`（refiner 143-152） |
| 单条 RuleCode 抛错 | merge 跳过该条、记 unhealthy（evaluator 92-98）；`evaluationStatus` 仍 `ok` | `implementation_unhealthy` warning、跳过该条（`production-rulehost-gate.ts:709-712`） | `rejected_runtime_error`（refiner 205-219） |
| 超时 | 单实现 VM 超时 → 跳过（allow）；无总预算 | 3s gate deadline / 批量子进程超时 → allow + warning（`:40, 239-244`；测试 792-818） | soft timeout → `rejected_timeout`（refiner 190-203） |
| 未知 tool kind | 不在硬编码 Set → 不进入门（`gate.ts:367-369`）；在 Set 但 registry='other' → 仍可能评估 | `isRuleHostEvaluableKind` 只允许 write/execute/agent（`rule-host-input-builder.ts:312-314`）；随后空路径 → allow（`production-rulehost-gate.ts:179`） | 不适用（fixture 决定） |
| 非法 RuleHostResult | normalize → `requireApproval` + `degraded`（evaluator 63-75；normalizer 43-66）；shadow 直接跳过（rule-host 222-231） | 同 A（`production-rulehost-gate.ts:717-720`）；shadow 跳过（`:678-681`） | `compileDemoRule` **throw**（demo-rule-compiler 30-33）→ `rejected_*` |
| DB 不存在 | 空加载 → 放行，无持久标记（rule-host 293+） | allow + 写 degraded marker（`production-rulehost-gate.ts:252`） | 不适用 |
| 全局 pause | 跳过 live，**仍执行 shadow**（rule-host 386-388 + 214） | 全部 allow，**不执行 shadow**（`production-rulehost-gate.ts:262-268`） | 不适用 |
| 重复 `target_ref` | 跳过该组全部、记 unhealthy（rule-host 549-577） | 跳过该组全部、warning（`production-rulehost-gate.ts:361`） | 不适用 |
| v2 历史不可用 | 规则照常执行，自行处理 sentinel（无挂起） | **按条挂起**（`production-rulehost-gate.ts:532-543`），designGate 例外 | 可生成 accepted_shadow |

### 3.4 输出精度

| 实现 | 能否回答「还差什么」 |
|---|---|
| D `RuleHostResult` | 能：`decision / matched / reason / diagnostics / ruleId / principleId / correctionProposal / degraded{reasonCode,notes}`；但 `merged requireApproval` 丢 `ruleId`（见 4.2 P9） |
| A RuleHost report | 能：`skippedActivations[{activationId,ruleId,mode,reason,nextAction}]` + `liveRulesLoaded` + `evaluationStatus` |
| A legacy gate | 弱：对调用方只返回 `{block,reason}`；`requireApproval` 只写事件，不返回「缺什么」 |
| B 共享门 | 强：`warnings` 每条带 `nextAction`（`boundedWarning`），metadata 带逐条 `evaluations` 与 winner 身份 |
| C refiner | 最强：`failedCases[{caseId,errorType,message}]` + `failure{reasonCode,layer,evidence,nextAction}`（refiner 188-235） |

### 3.5 副作用时机与幂等性

| 实现 | 写什么 | 何时 | 幂等性 |
|---|---|---|---|
| A RuleHost | `rulehost_unhealthy` / skipped 事件；安全隔离 | 每次评估失败；加载期每个 fingerprint 一次；隔离首次 trip 后内存态 | unhealthy **每次评估都写**，不幂等；加载告警有 fingerprint 去重（rule-host 143, 636） |
| A legacy gate | `rulehost_evaluated/enforced/blocked/requireApproval`、receipt ledger、trajectory gate_blocks、auto_correct applied、circuit | 每个 tool call；block 带 bounded retry（gate-block-helper 185+） | 事件按调用追加，不幂等；auto_correct 先备份再回滚（`gate.ts:198, 332-334`） |
| B 共享门 | 仅 degraded marker（DB/artifact 缺失） | 每次命中缺失 | marker 覆盖写（`recordDegradedEnforcement`），幂等 |
| A shared handler | 从 B 的 metadata 翻译事件 | 每个 tool call，一次 | 一条 evaluation 一行；审计开始时的 `f15798cf1` 会在 `auto_correct/requireApproval` 回落 legacy 导致重复评估/重复写行；当前 `38ef59848` 已修复 |
| C pipeline | artifact / activation / 审批 / stage 状态 | 生成期，stage 重试 ≤2（runner 257） | 以 stage/task 状态为准；activation 版本化（writer 379-385） |
| D writer | activation / shadow-first | 激活时 | 同一 artifact 重放生成同一 identity（writer 379-385） |

---

## 4. 冲突清单

> 只列**同一输入、不同结论**。类型定义：
> - **产品语义冲突**：影响「该不该拦 / 该不该生效」，需要 Owner 一句话取舍。
> - **实现细节冲突**：结论等价或仅影响证据/性能，工程上自己可定。

### 4.1 产品语义冲突

#### P1. `{decision:'block', matched:true, reason:''}`：生成期合法，运行期放行，旧路径阻断

- D validator 只要求 `reason` 是 **string**，不要求非空（`rule-host-validator.ts:126-131`）；normalizer 原样返回（`rule-host-result-normalizer.ts:44-46`）；merge 直接返回 block（`rule-host-evaluator.ts:81-83, 101-103`）。
- A legacy gate：`hostResult.decision === 'block'` 时无条件 `recordGateBlockAndReturn(..., reason)`，不检查 reason（`gate.ts:482-577`）。
- B 共享门：`result.reason.trim().length === 0` → **allow** + `deny_reason_missing` warning（`production-rulehost-gate.ts:759-763`）。
- C refiner：空 reason 的 block 通过 `validateRuleHostResult`，sandbox 判为合法 → `accepted_shadow`（`refiner-rulehost-gate.ts:169-185`；`demo-rule-compiler.ts:30-33`）。
- **后果**：一条「想拦但没写 reason」的规则可以在生成期被接受，运行期却被静默放行；死路径则会真的拦。
- 测试缺口：`rg "deny_reason_missing" packages/**/tests` 无命中——这条分支没有直接测试。
- 类型：**产品语义冲突**。

#### P2. `agent` 类无路径工具：入口准入包含它，路径守卫让它永远不评估

- `isRuleHostEvaluableKind` 明确允许 `write | execute | agent`（`rule-host-input-builder.ts:312-314`）；PR #2546 的直接单测名为 `PRI-1184 F3': isRuleHostEvaluableKind — RuleHost entry contract` / `admits exactly the write, execute and agent families`。
- 但 builder 只对 **write** 工具生成合成路径 `<tool:name>`（`rule-host-input-builder.ts:253-258`）；`agent` 工具的 `extractFilePathInput` 返回 `null` → `normalizePathPure(null)` 返回 `''`（builder 166, 329-331）。
- B 共享门在 kind 检查之后立刻执行 `normalizedPath === null || === '' → allow`（`production-rulehost-gate.ts:179`）。
- **后果**：只要 `sessions_spawn`（OpenClaw 唯一的 agent 工具，`constants/tools.ts:37-39`）的载荷没有 `path/file/target/file_path` 参数，它在活路径上就不会被任何 RuleCode 评估；`agent` 在入口谓词里是（对无路径载荷而言的）死分支。
- 测试缺口：`gate-no-path-write-tool.test.ts` 只覆盖 write 工具（文件头 1-6），没有 agent 用例。
- 类型：**产品语义冲突**。

#### P3. RuleCode 可见输入跨宿主不一致：`isRiskPath` / `epTier` / `estimatedLineChanges`

- `workspace.isRiskPath`：旧路径恒 `false`（`gate.ts:408`）；共享门用 `isSensitiveSystemPath(action.normalizedPath)`（`production-rulehost-gate.ts:605`）。
- `evolution.epTier`：旧路径恒 `1`（`gate.ts:414, 645-649`）；共享门默认 `0`（`:195`），OpenClaw enrichment 覆盖为 `1`（`gate.ts:660-665`），Codex/WorkBuddy 无 provider → `0`。**这是活路径内部的跨宿主差异**。
- `derived.estimatedLineChanges`：旧路径 `estimateLineChanges({toolName,params})`（`gate.ts:417` 带 registry）；共享门必带 `toolSemantics`（`production-rulehost-gate.ts:608`）。
- **后果**：同一份规则代码（读取 `input.workspace.isRiskPath` 或 `getEpTier()`）在 OpenClaw / Codex / WorkBuddy 上可以得出不同 `decision`。生成期 refiner 用 fixture 造输入，无法发现这种宿主差异。
- 测试缺口：`codex-payload-action-parity.test.ts` 只比较 `action`（normalizedPath/paramsSummary/canonicalKind，文件头 1-15），**不比较完整 RuleHostInput**。
- 类型：**产品语义冲突**（`epTier` 跨宿主）；`isRiskPath` / `estimatedLineChanges` 目前是「死 vs 活」，但会让差分测试假阳性。

#### P4. 资源上限触发时：共享门放行，旧路径无上限评估

- 共享门常量：`MAX_ACTIVE_RULES=32`、`RULE_SOURCE_BYTES=64KB`、`RULE_BATCH_SOURCE_BYTES=256KB`（`host-runtime/src/rule-implementation-runtime.ts:5-7`）、`GATE_DEADLINE_MS=3000`（`production-rulehost-gate.ts:40`）、`ARTIFACT_CONTENT_BYTES=512KB`（:41）。
- 触发时一律 `decision:'allow'` + warning（`:328-337, 450-455, 620-621`；deadline `:239-244`）。
- 旧 `RuleHost` 查询无 `LIMIT`（`rule-host.ts:389-403`），逐条 VM 执行，无总预算。
- 测试明确锁定 fail-open：`production-host-runtime.test.ts:792-827`（`fails open observably when child RuleCode hits ...`、`caps active rules ...`）。
- **后果**：33 条活跃规则 / 一条超大规则 / 一条死循环规则，在共享门下全部放行；旧路径会继续评估并可能阻断。这是「更能放行」的差异。
- 类型：**产品语义冲突**（可用性 vs 治理覆盖），需要 Owner 确认 fail-open 是产品承诺。

#### P5. v2 规则在历史不可用时：共享门挂起，旧路径照常执行

- 共享门：`context === undefined || context.history.status !== 'available'` → 按条挂起，仅 designGate actionable 例外（`production-rulehost-gate.ts:532-543`）。
- 旧路径：flag ON 时把 `UNAVAILABLE_RULE_CONTEXT` 直接交给规则，不挂起（`gate.ts:680-720`；`rule-host.ts:695-697` 只检查 `requiresContextVersion`，不检查 history）。
- 测试：`production-rulehost-gate-v2-isolation.test.ts:383`（`runs qualified shadow V2 ... while a block result cannot deny`）、`:406`、`:524`（`still suspends ... when history is unavailable`）。
- **后果**：同一条 v2 规则，在新会话（无历史）里共享门不执行、旧路径执行。生成期 refiner 若用「有历史」的 fixture 验证通过，会接受一条运行期根本不跑的规则。
- 类型：**产品语义冲突**（当前产品语义应保留共享门的挂起；收敛不得恢复旧行为）。

#### P6. 规则阻断恢复控制命令：旧路径隔离并放行，共享门直接阻断

- 旧路径在任何 decision 处理前调用 `observeRuleCodeSafety`（`gate.ts:438`）——包括 `block`。该函数是 OpenClaw 适配层的生产入口（状态机在 core `rulecode-safety-circuit-breaker.ts`）。命中 `pd status` / `rulecode_deactivate` 时 trip → 隔离规则并**放行当前调用**。
- 共享 handler 先处理 `deny` 并 `return accountSharedDeny(...)`（`gate.ts:817-828`），之后才调用电路（`:830-846`，只在 `auto_correct/requireApproval`）。
- `RuleHostWriter.canActivate` 确实禁止 `affectedTools` 声明 `pd_status / rulecode_deactivate / rulecode_global_pause / owner_review_access`（`rule-host-writer.ts:345-348`），但运行时匹配并不受声明范围限制。
- **后果**：一条声明 `affectedTools=['write']` 的规则如果运行时匹配到 `pd status` 并返回 block，共享门会真的阻断恢复命令，且没有隔离兜底。测试未覆盖「block + 保护命令」。
- 类型：**产品语义冲突**（宿主可恢复性 vs 规则权威）。

#### P7. 生成期与运行期的「非法输出」结论相反

- 生成期：非法 RuleHostResult → `compileDemoRule` throw（`demo-rule-compiler.ts:30-33`）→ `rejected_runtime_error`（refiner 205-219）。
- 运行期：非法输出 → normalize 成 `requireApproval` + `degraded`（normalizer 43-66），merge 保留它（evaluator 69-79），共享门只告警，不阻断（`production-rulehost-gate.ts:717-720`）。
- **后果**：生成期认为「这条规则坏了，不能激活」；运行期认为「这条规则想要求审批」，但 `requireApproval` 在 OpenClaw 只记录、不阻断。两边对「坏规则」的处置不同。
- 类型：**产品语义冲突**（是否允许 degraded 规则继续参与合并）。

### 4.2 实现细节冲突

#### P8. 全局 pause 时的 shadow 行为

- 旧路径：live 跳过，shadow 继续评估（`rule-host.ts:386-388` + 214-215）。
- 共享门：全部 allow，不执行 shadow（`production-rulehost-gate.ts:262-268`）。
- 判定结论一致（都 allow），只是观测数据不同。类型：**实现细节**。建议冻结共享门行为（pause 时不做无效计算）。

#### P9. `requireApproval` 合并后丢失 `ruleId`，导致安全电路无法归因

- `mergeDecisions` 对 `approvals` 重新构造对象，**不带 `ruleId/principleId`**（`rule-host-evaluator.ts:131-149`）。
- `RuleHost` 用 `liveDecision.ruleId` 反查 activationId（`rule-host.ts:264-272`）→ `requireApproval` 永远查不到。
- 共享门同样用引用身份找 winner：`liveEvaluatedResults.indexOf(result)`（`production-rulehost-gate.ts:736-737`）；合并后的 approvals 是新对象，`indexOf` 返回 -1 → evaluation 不带 `activationId`（`:753`）→ OpenClaw 的 `extractLiveActivationId` 取不到（`gate.ts:58-68`）。
- `observeRuleCodeSafety` 在 `activationId` 缺失时直接 `return false`（`rulecode-safety-circuit.ts:15`）。
- `auto_correct` 返回原始 `ac`（evaluator 106-113），所以有身份；`block` 也返回原始 result。
- **后果**：`requireApproval` 的自动隔离实际不生效；若未来把 `requireApproval` 变成阻断，这会变成锁死风险。类型：**实现细节**（当前不影响 allow/deny，但必须在收敛时修）。

#### P10. unhealthy / skipped 证据的持久化归属不同

- 旧 `RuleHost` 写 `EventLog.recordRuleHostUnhealthy`（`rule-host.ts:896-908`）与 `recordRuleHostSkipped`（932+）。
- 共享门只产生 warning（`production-rulehost-gate.ts:674, 710, 718`），不写事件；degraded marker 只覆盖 DB/artifact 缺失（`:252, 303`）。
- 如果直接把 A 删掉，非法输出/超时规则会从「有持久事件」退化为「只有日志」。类型：**实现细节**（观测缺口，不是判定差异）。收敛时必须显式把 warning→event 的翻译放到适配层。

#### P11. 路由权威不同：硬编码 Set vs registry

- 旧路径用 `BASH_TOOLS_SET / WRITE_TOOLS / AGENT_TOOLS` 做「是否进入门」的粗筛（`gate.ts:363-365`），进入后用 registry 解析 kind。
- 共享门直接以 registry 的 `isRuleHostEvaluableKind` 为准（`production-rulehost-gate.ts:164-172`）。
- 当前两套名单一致（`openclaw-plugin/src/constants/tools.ts:20-39` 与 `tool-semantic-baseline.ts:22, 60`），所以结论一致；但这是两份知识，新增工具时容易漂移。类型：**实现细节**（P2/P3 的根因之一）。

#### P12. 重复 `target_ref` / digest / 版本检查

- 两边都「跳过整组」：`rule-host.ts:549-577` 与 `production-rulehost-gate.ts:361`；测试 `production-host-runtime.test.ts:779-790`。
- 两边都拒绝 digest `tampered/unverifiable` 与 `requiresContextVersion !== 2`（rule-host 657 / 695-697；`production-rulehost-gate.ts:430-441, 457-461`）。
- **结论一致**，列为已验证项，不改。类型：**无冲突（已验证）**。

#### P13. `matched=false` 的 cross-field 规则

- validator 强制 `matched=false → decision='allow'`（`rule-host-validator.ts:107-124`）；normalizer 对 `matched=false` 直接返回 allow（52-58）。
- A/B 都走同一 validator/normalizer；C 走同一 validator（`demo-rule-compiler.ts:30`）。**结论一致**。

#### P14. 审计期间的基线推进（已消失，保留为回归红线）

- 审计开始时（`f15798cf1`）：`handleSharedRuleHostResult` 对 `auto_correct/requireApproval` 直接 return，交由 `index.ts:507` 回落 legacy 重新评估 → **同一次 tool call 评估两遍**，可能写两条 `rulehost_evaluated`。
- 审计开始时：`normalizedPath === null` 的 deny 只记账、不返回 block。
- 审计进行中另一会话把 HEAD 推进到 `38ef59848`，两处均已修复：`index.ts:508` 只走共享 handler；null path deny 返回 block（`gate.ts:748-762`）。
- 类型：**实现细节**（已消失）；保留为红线：**不得重新引入 legacy 回落或空路径 deny 只记账**。

### 4.3 已验证一致（不要为了「统一」而改掉）

| 行为 | 证据 |
|---|---|
| `block` 优先级最高且短路 | evaluator 81-83, 101-103 |
| `auto_correct` 优先于 `requireApproval` | evaluator 105-150 |
| `matched=false` 必须是 allow | validator 107-124；normalizer 52-58 |
| 重复 `target_ref` 跳过整组（live+shadow 也算重复） | rule-host 549-577；`production-rulehost-gate.ts:361`；`production-host-runtime.test.ts:779-790` |
| digest `tampered/unverifiable` 拒绝该条 | rule-host 657；`production-rulehost-gate.ts:430-441` |
| `requiresContextVersion !== 2` 跳过 | rule-host 695-697；`production-rulehost-gate.ts:457-461` |
| shadow 永不影响 live 判定 | rule-host 214-243；`production-rulehost-gate.ts:662-696` |
| 无 live 规则 = `no_rules_armed`，不是 `allow` | `gate.ts:431-435`；`production-rulehost-gate.ts:747-751` |

### 4.4 需要一句话裁决的问题

1. `{decision:'block', matched:true, reason:''}` 应该阻断，还是视为无效结论、降级为 `requireApproval`？（当前共享门选择「放行 + 告警」）
2. 无路径的 `sessions_spawn`（agent 类）是否应该受 RuleCode 管辖？（入口谓词准入 agent，空路径守卫又把它放行）
3. RuleCode 是否允许阻断 `pd status` / `rulecode_deactivate` 这类恢复控制？（旧路径隔离并放行，共享门直接阻断）
4. 32 条 / 64KB / 3 秒等资源上限触发时保持「放行并告警」，是否算产品承诺？（旧路径无上限评估）
5. `epTier` 是否要求跨宿主一致？（OpenClaw 当前为 1，Codex / WorkBuddy 为 0）

---

## 5. 安全收敛方案

### 5.1 核心原则

1. **内核无副作用**：core 只回答 `decision + reasons + evaluation facts`；事件、ledger、trajectory、correction 应用全部留在宿主适配层。
2. **不新增裁决枚举**：继续用 `decision: allow|block|requireApproval|auto_correct`（normalizer 21 已声明「decision remains the only verdict field」）。架构报告 §4.2 的 `verdict: allow|block|degrade` 会把重构变成语义变更，不采用。
3. **先冻结、再改**：任何代码移动之前，先用现行活路径生成不可变语料；改完后逐字段比对。
4. **不扩大 allow**：出现「新路径 allow、旧路径 deny」立即停手，不讨论「是否合理」。

### 5.2 分阶段

#### 阶段 0：语义冻结（只加测试，不改产品）

- **改什么**：新增只读差分语料与 runner；不碰生产代码。
- **语料形状**（每条 fixture 一个目录）：
  - `case.json`：宿主、toolName、params、workspace 配置、flag（v2 on/off）、期望阶段。
  - `state.sql`：激活/SQLite 快照（live/shadow、重复 target_ref、tampered digest、32+ 规则、64KB 源码、v2 hostKinds、pause 等）。
  - `rules/*.js`：固定 RuleCode（不用 LLM 生成，避免不确定）。
  - `expected.json`：**决策元组**，字段固定为：
    `decision`、`matched`、`ruleId`、`principleId`、`degraded.reasonCode`、`skipped[].reason`（排序后）、`warnings[].reasonCode`（排序后）、`sideEffects.events[].kind`（排序后的计数）、`sideEffects.isolation`(bool)。
- **放在哪**：`packages/host-runtime/tests/fixtures/rulehost-semantics/` + `packages/host-runtime/tests/semantics/rulehost-differential.test.ts`；跨宿主 payload 复用 `packages/principles-core/src/runtime/internalization/__tests__/` 的 codex payload 语料。
- **期望值怎么来**：从当前工作树 `38ef59848` 的**活路径**生成一次，人工 review 后单独提交，记录 fixture 目录的 git hash。**不允许用 `toMatchSnapshot` 自动更新**。
- **验收**：语料覆盖 P1-P14 全部条目；对同一条 fixture，B 与 C 的「是否接受激活」结论被显式记录（允许不同，但必须写进 expected 并注明理由）。
- **回滚点**：无（纯新增）。

#### 阶段 1：入口收口（保留各实现体）

- **改什么**：
  - 在 core 增加一个**薄门面**（只做分派，不改判定）：所有宿主只能通过它进入「加载 → 执行 → merge → normalize」。
  - A 的 `RuleHost` 仅作为差分 oracle / 测试适配器保留，**不接生产**；B 的 gate、C 的 refiner 保留原实现体，只把调用入口改为门面；门面参数显式携带 host policy（`isRiskPath` 取值、`epTier` 取值、bounds、failMode）。
  - 确认 `index.ts:500-508` 只走共享 handler；**不要重新引入 legacy 回落**（这是 `f15798cf1` 的重复评估源，已在 `38ef59848` 修复）。
- **不改什么**：不改任何 policy 取值、不改 bounds、不改 merge 顺序、不改事件写入点。
- **怎么证明**：差分语料 0 差异（决策元组 + sideEffects 计数）。
- **回滚点**：门面后加 `rulehost_kernel_entry=legacy|shared` 只读开关，默认 `shared`；回滚=切开关。
- **验收**：同一次 tool call 只评估一次；`rulehost_evaluated` 行数不增加；P14 消失。

#### 阶段 2：输入统一（消除 RuleCode 可见差异）

- **改什么**：
  - 用 `buildRuleHostInput(hostPolicy, payload)` 取代 A 的手工装配与 B 的门内装配。
  - 把三个字段差异变成**显式 policy**并在配置里声明：
    - `isRiskPath`：统一为 `isSensitiveSystemPath(path)`（活路径值）。
    - `epTier`：先按 Owner 裁决（4.4 第 5 条）统一；未裁决前保持「OpenClaw=1、Codex/WB=0」，不擅自改。
    - `estimatedLineChanges`：统一带 `toolSemantics`。
  - 补 agent 路径：若 4.4 第 2 条裁决为「应管辖」，在 policy 里为 agent 生成显式 synthetic target（例如 `<agent:${toolName}>`），而不是空字符串；若裁决为「不管辖」，从 `isRuleHostEvaluableKind` 移除 agent，消灭死分支。
- **不改什么**：不改 `normalizedPath` 的既有 write/exec 语义；不改 `paramsSummary`；不改 path 归一化算法。
- **怎么证明**：新增 `RuleHostInput` 级 parity 测试（不是 action 级），对 OpenClaw/Codex/WorkBuddy 三份 payload 逐字段比对；差分语料中所有「规则读字段」的 case 必须 0 差异。
- **回滚点**：policy 以配置项落盘；回滚=恢复旧 policy 默认值。**不做 DB migration**。
- **验收**：P3 关闭或降级为「已裁决的单一取值」；P2 按裁决关闭；生成期 refiner 的 fixture 与运行期输入同一构造器。

#### 阶段 3：副作用归位（内核纯化）

- **改什么**：
  - A 的 shared handler 继续作为 OpenClaw 的事件写入器；B 只返回 evaluation facts。
  - 为 Codex/WorkBuddy 补一层最小 evidence 翻译（如果它们的宿主协议需要），**不复制 OpenClaw 的 EventLog**。
  - 把旧 `RuleHost._recordUnhealthy` 的持久化语义（unhealthy/skipped）在 B 的适配层实现：warning → event，字段映射保持现有 EventLog schema。
- **不改什么**：不改 EventLog schema；不改事件触发时机（每个失败评估一次）；不改 block 记账的重试策略。
- **怎么证明**：sideEffects 差分：事件 kind 的**计数**必须与基线一致；允许新增「以前只在日志、现在持久化」的项，但必须逐条列入 expected 并在 PR 里说明。
- **回滚点**：翻译层独立文件 + 开关；回滚=关闭翻译（退回只告警）。
- **验收**：P10 关闭；没有重复行；degraded marker 仍只在 DB/artifact 缺失时写。

#### 阶段 4：删除死路径

- **改什么**：
  - 删除 `openclaw-plugin/src/core/rule-host.ts` 与 legacy `handleBeforeToolCall`（含 `gate-block-helper` 中仅被它使用的分支）。
  - 把 `rule-host-matrix-5x5`、`rule-host-adversarial-output`、`rule-host-cache-invalidation` 等测试改为驱动共享门；无法迁移的测试删除，并在 PR 说明覆盖缺口。
  - `apply_patch` **路径解析**知识收敛到 `tool-semantic-registry` + `RuleHostWriter` 两处；目标：路径解析相关引用 ≤2 个文件（风险分级、提示词模板、测试中的合法引用不计入）。
- **不改什么**：不改共享门的任何判定；不改 owner 决策/晋升；不改三宿主 hook 注册。
- **回滚点**：删除是唯一不可逆阶段；前置条件=阶段 1-3 的差分语料连续 N 天 0 差异（建议 N=5 个工作日），且当前工作树上 legacy 已无生产接线。
- **验收**：全量窄测试通过；差分语料 0 差异；新增宿主只需实现 `resolveToolSemantics` + `toRuleHostInput` 两个函数（架构报告 §4.2 的目标，但保持现有 `RuleHostInput` 类型）。

### 5.3 差分测试的形状（具体）

**选择：逐字段元组比对，不选「黄金用例只锁输出字符串」。** 原因：字符串输出会把 `warnings` 顺序、日志文本变成断言，导致改文案就红；元组能精确区分「判定变了」和「措辞变了」。

每条 fixture 的比较规则：

| 字段 | 比较方式 | 失败含义 |
|---|---|---|
| `decision` | 严格相等 | 产品语义变更，停手 |
| `matched` | 严格相等 | 同上 |
| `ruleId` / `principleId` | 严格相等（允许同时 undefined） | 归因变更 |
| `degraded.reasonCode` | 严格相等 | 降级语义变更 |
| `skipped[].reason` | 排序后多重集相等 | 加载语义变更 |
| `warnings[].reasonCode` | 新实现必须是旧实现的**超集**；新增项需在 allowlist 里登记 | 新增告警可接受，丢失告警不可接受 |
| `sideEffects.events[].kind` | 排序后计数相等 | 证据重复/丢失 |
| `sideEffects.isolation` | 严格相等 | 安全兜底变更 |
| `reason` 文本 | **不比较** | 避免文案耦合 |

**防止「改断言迁就新实现」的机制**：

1. expected 由**旧路径**生成，旧路径在阶段 1-3 一直保留为 oracle；新路径必须向 oracle 对齐，而不是反之。
2. fixture 目录设为只读（CI 校验 `git diff --exit-code -- fixtures/`）；修改 expected 需要单独的 `[semantics-change]` PR + Owner 签字。
3. 加**灵敏度自检**：runner 随机翻转 expected 的 `decision`/`matched`/`ruleId` 各一次，必须失败；否则说明断言没生效。
4. 不用 `toMatchSnapshot` / `-u`；expected 是手写 JSON。
5. C（生成期）单独一组语料：比较「同一条 RuleCode 是否 accepted_shadow」以及「失败 reasonCode/layer」，不与运行时 decision 混比。

### 5.4 红线（出现即停手）

1. **任何 `allow` 扩大**：新路径 allow、基线 deny（含 `block` 与 `requireApproval` 的语义变化）。
2. **任何空 reason block 的翻转**：除非 4.4 第 1 条已裁决并记录。
3. **任何资源上限的移除或放宽**：32/64KB/256KB/3s/512KB；反向收紧也要单独裁决（会扩大拦截）。
4. **任何摘要/审批链变更**：digest 校验、`owner_approved`、`hostKinds`、shadow-first。
5. **任何恢复控制语义变更**：`pd status` / `rulecode_deactivate` / `rulecode_global_pause` / `owner_review_access`。
6. **任何 `ruleId/principleId` 归因丢失**（P9 必须先修再动 requireApproval 的执法）。
7. **任何 fail-open 新增**：内部错误/超时/未知 kind 的默认放行只能保持现状，不能扩大。
8. **任何重复评估或重复事件行**（P14）。
9. **任何 RuleCode 可见字段变化**未列入 policy 并经过裁决（`isRiskPath`、`epTier`、`estimatedLineChanges`、`canonicalKind`、`normalizedPath`）。

### 5.5 明确不做

- 不改授权 / 门禁默认严格度：不把 `allow` 改成 `block`，也不把 `block` 改成 `allow`。
- 不为统一返回形态引入 fail-open；`RuleHostDecision` 不新增 `degrade` 枚举。
- 不改 RuleCode 的拥有者裁决语义：Owner 审批 → shadow → 显式 promote → live；`RuleHostWriter.activate` 固定 shadow-first（writer 360-377）。
- 不一次性替换：不删除 `RuleHost` 直到阶段 3 差分稳定；不把 pd-cli 生成管线并入运行时 merge。
- 不把 `warnings` 文案、日志格式、事件顺序当成语义。
- 不在本次设计阶段改任何产品代码、建分支、提交或 push。

---

## 6. 窄范围测试与 NOT RUN 清单

### 6.1 与四套实现直接相关、未来阶段应运行的窄测试

| 测试文件 | 覆盖的语义 |
|---|---|
| `packages/openclaw-plugin/tests/core/rule-host-matrix-5x5.test.ts` | RuleHost 10 场景 block/allow；文件头 12-18 明确不证明生产 gate 端到端 |
| `packages/openclaw-plugin/tests/hooks/gate-rule-host-pipeline.test.ts` | legacy 与 shared handler 的 block/deny 记账 |
| `packages/openclaw-plugin/tests/hooks/gate-no-path-write-tool.test.ts` | 无路径 write 工具的合成路径（不含 agent） |
| `packages/host-runtime/tests/production-host-runtime.test.ts` | fail-open 预算、重复 target_ref、事件计数（:779-827） |
| `packages/host-runtime/tests/production-rulehost-gate-v2-isolation.test.ts` | v2 挂起、hostKinds、digest 绑定 |
| `packages/host-runtime/tests/degraded-enforcement-marker.test.ts` | degraded marker 幂等 |
| `packages/principles-core/src/runtime/internalization/__tests__/rule-host-input-builder.test.ts` | `isRuleHostEvaluableKind` 入口契约；`''` path |
| `packages/principles-core/src/runtime/internalization/__tests__/rule-host-result-normalizer.test.ts` | 非法输出 → degraded requireApproval |
| `packages/principles-core/src/runtime/internalization/__tests__/refiner-rulehost-gate.test.ts` | 超时/拒绝分类 |
| `packages/principles-core/src/runtime/activation/writers/__tests__/rule-host-writer.test.ts` | shadow-first、scope/protected capability |
| `packages/principles-core/src/runtime/internalization/__tests__/codex-payload-action-parity.test.ts` | action 级 parity（需扩展为 input 级） |

### 6.2 本次未运行

- 全部测试：**NOT RUN**。原因见 §1（untrusted workspace + 另一会话正在改 `pd-cli` 测试）。
- 未运行任何构建、lint、typecheck。
- 本报告的「一致/不一致」结论来自源码与测试源，不是运行结果。

---

## 7. 一句话交付

**收敛的正确对象不是「四份代码合成一份」，而是：让 host-runtime 共享门成为唯一运行时裁决者，core 只做无副作用的 merge/validate/normalize，OpenClaw legacy 与 `RuleHost` 在差分语料连续零差异后删除，pd-cli 只共用契约件；在此之前，先用旧路径生成不可变语料，任何「新路径更放行」的差异都视为回归而不是优化。**
