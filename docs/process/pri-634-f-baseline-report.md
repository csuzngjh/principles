# PRI-634-F v1.3 Phase 0 — Baseline Report

日期：2026-09-03
基准：`origin/main @ 50dd5b75df151e5cf1cb8847e8f0485eaf33b64f`
状态：只读调查完成，无代码改动。所有 file:line 均在基准 commit 上核实。

---

## 0. TL;DR — SPEC 假设核对结果

| SPEC 假设 | 判定 | 事实 |
|---|---|---|
| Problem A：工具语义漂移（Artificer 用 `execute_command`，生产用 `exec`） | **成立** | 全仓存在 4 套互不一致的工具词表，且 `canonicalizeToolKind` 对 Artificer 常用名（`execute_command`/`run_script`/`code_interpreter`）与生产 bash 别名（`shell`/`cmd`）均返回 `other` |
| Problem B：Replay 与生产输入生成路径不同 | **部分成立（需修正表述）** | 路径提取/归一化函数 `buildRuleHostAction` **已经是**生产与回放共用的单一纯函数（PRI-439 Phase 3 早已交付）。真实缺口在两处：(1) 回放侧调用时不传 `isBashTool`/`isWriteTool` 提示，导致 bash 命令提取/写工具合成路径在回放中永不触发；(2) 激活门回放不传 `projectDir`，`normalizedPath` 恒为 `null` |
| Problem C：失败责任不清 | **成立** | 现有失败结构（gate 六值决策、sandbox 六值 errorType、PDErrorCategory 19 值）都描述"怎么失败的"，没有任何字段回答"哪一层负责修复"。`repairHint`/`failureReason` 是自由文本 |
| Phase 1 需要新增 ToolSemanticMapping | **成立且与代码自身规划一致** | `rule-context-v2.ts:112-116` 注释已声明"权威来源应为宿主声明，core 只拥有封闭枚举 + 纯查找，后续阶段让宿主声明 override"——SPEC 是该 TODO 的执行 |
| Phase 2 需要合并出 `buildRuleHostAction` | **已存在，改为"补齐调用一致性"** | 函数已存在并被生产使用；Phase 2 的实际工作是让回放侧以与生产完全相同的语义调用它 |
| Phase 3 需要新增 failureLayer | **成立（真缺口）** | 全仓无 `failureLayer` 概念；最接近的是 `AdversarialAttackType`（用例分类学）与自由文本 repairHint |

---

## 1. RuleHostInput — 生产与回放的输入生成路径

`RuleHostInput` 契约：`packages/principles-core/src/runtime-v2/internalization/rule-host-contracts.ts:21-49`。
`action: { toolName, normalizedPath, paramsSummary }` —— **没有 canonicalKind 字段**。

### 1.1 生产路径（2 条）

| 路径 | 构建 | 提示来源 | 工具过滤 |
|---|---|---|---|
| OpenClaw 插件 hook | `openclaw-plugin/src/hooks/gate.ts:53` → `buildRuleHostAction(toolName, params, wctx.workspaceDir, {isBashTool, isWriteTool})` | `openclaw-plugin/src/constants/tools.ts` 的 `BASH_TOOLS_SET`/`WRITE_TOOLS` | gate.ts:39 —— 仅 write/bash/agent 工具进门，read/search 直接放行 |
| host-runtime 共享生产门 | `host-runtime/src/production-rulehost-gate.ts:127` → 同一 builder | **同文件 :125-126 内联硬编码集合**（bash={bash,exec,execute,run_shell_command}；write={write,write_file,edit,edit_file,replace,apply_patch}） | 不过滤工具类别；仅 `normalizedPath === null` 时放行 |

**两条生产路径自身就不一致**：内联集合缺少 openclaw 词表的 `shell`/`cmd`（bash）与 `insert`/`patch`/`delete_file`/`move_file`（write）。

### 1.2 回放路径（2 条）

| 路径 | 构建 | projectDir | 提示 |
|---|---|---|---|
| **激活门回放（权威生产链路）** | rule-host-writer:251 → `evaluateRefinerRuleHostGate` → `createProductionGateDeps().evaluateInSandbox`（production-gate-deps.ts:247）→ `evaluateInRefinerSandbox`（refiner-sandbox-wrapper.ts:98-101）→ `createSyntheticRuleHostInput({toolName, params}, ctxOverrides)` | **不传** | **不传** |
| 纯回放校验器 | `golden-trace-replay-validator.ts:209-213` → `createSyntheticRuleHostInput(..., {projectDir})` | 可选（`ReplayValidatorConfig.projectDir`） | **不传（且无此选项）** |

另有 `openclaw-plugin/src/core/principle-compiler/compiler.ts:233`（demo/手工编译路径）调用 `replayGoldenTrace`，不传 projectDir。

### 1.3 具体 parity 缺口（同一 case 输入下，回放 ≠ 生产）

1. **提示缺口**：`extractFilePathFromParams`（rule-host-input-builder.ts:174-205）的 bash 命令变异正则与"整条命令兜底"、写工具合成路径 `<tool:X>`，全部依赖 `isBashTool`/`isWriteTool` 提示。生产传、回放不传 → bash/write 类 case 在回放中 `normalizedPath` 为空，在生产中为命令文本/合成路径。
2. **projectDir 缺口**：激活门回放恒 `normalizedPath: null`（golden-trace.ts:186-193 的 fallback 分支）；生产恒非 null（至少是原始路径串）。路径类规则在激活门回放中从未被真实路径测试过。
3. **提示判定词表三方漂移**：同一个 `toolName='shell'`，openclaw hook 视为 bash（提取命令路径）、host-runtime 门不视为 bash（不提取）、core `TOOL_ALIAS` 映射为 `other`。
4. `canonicalKind` 在 `RuleHostInput.action` 上不存在，仅存在于 flag 门控的 `RuleContextV2.history.calls[]`（rule-context-v2.ts:34），v1 规则在回放与生产中都看不到 canonical 语义。

### 1.4 接线约束（Phase 2 设计输入）

- `createProductionGateDeps()` 在 4 个生产调用点全部零参调用：`host-runtime/src/internalization-consumer-cycle.ts:480`、`internalization-consumer-governance.ts:108`、`pd-cli/src/commands/runtime-activation.ts:299/533/1308`、`pd-cli/scripts/llm-dogfood.ts:285`。
- `WriterInput`（activation-types.ts:98-104）不含 workspace/projectDir —— 激活门核心层是 workspace 无关的。
- Artificer L2 自验循环的 `replay_rulecode` 工具走同一个 gate（artificer-l2-tool-contract.ts:285）。

---

## 2. Tool Alias — 全部工具语义来源（4 套，无权威）

| # | 来源 | 位置 | 内容 | 消费者 |
|---|---|---|---|---|
| 1 | core `TOOL_ALIAS` 静态表 | `principles-core/src/runtime-v2/internalization/rule-context-v2.ts:118-137` | 17 个 raw 名 → `CanonicalKind`（read/search/write/execute/agent/other）；缺 `execute_command`/`run_script`/`shell`/`cmd`/`insert`/`patch`/`delete_file`/`move_file`/`code_interpreter` | `canonicalizeToolKind` → 生产 RuleContextV2 facts（openclaw-plugin/src/core/rule-context-assembler.ts:117）、evaluator 对抗用例（evaluator-runner.ts:2311）、v2-adversarial-cases |
| 2 | openclaw-plugin 常量 | `openclaw-plugin/src/constants/tools.ts` | BASH_TOOL_NAMES（含 shell/cmd）、WRITE_TOOLS（含 insert/patch/delete_file/move_file）、AGENT_TOOL_NAMES、READ_ONLY... | gate.ts 工具过滤与提示、风险分类 |
| 3 | host-runtime 内联集合 | `host-runtime/src/production-rulehost-gate.ts:125-126` | bash 4 名、write 6 名（#2 的真子集，额外缺 shell/cmd/insert/patch/delete_file/move_file） | 共享生产门的提示计算 |
| 4 | Artificer 自由输出 | `ArtificerRuleOutput.affectedTools`（artificer-output.ts:56）与 `goldenTraceCases[].toolName` | LLM 自由字符串；`validateAffectedTools`（:208-223）仅校验"非空字符串"，**无任何存在性/可映射性校验** | 元数据声明（当前无 gate 强制消费） |

漂移实例（全部核实）：

- `shell` / `cmd`：#2=bash → #1=`other` → #3 不识别。
- `delete_file` / `move_file` / `insert` / `patch`：#2=write → #1=`other`。
- SPEC 点名的 `execute_command` / `run_script` / `code_interpreter`（Artificer 产出）：#1=`other`。
- 规则若按 `context.facts`/history 的 `canonicalKind==='execute'` 匹配，对 `toolName='shell'` 的真实调用**永远不触发**，而该工具在生产门里确实被当 bash 处理 —— 这正是 SPEC Problem A 的实例。

Artificer prompt（artificer-prompt-builder.ts:102-129）教的是 `write_file` 等词表 #1 风格名称，但无强制约束，LLM 仍可产出词表外名称。

`rule-context-v2.ts:110-116` 注释（原文）：*"the authoritative source for canonical kinds SHOULD be a host declaration (spec §4.4 anti-drift note), so that core never owns a growing hardcoded tool list … a later phase will let hosts declare `ruleCanonicalKind` overrides. core only owns the CLOSED CanonicalKind enum + this pure lookup function."* —— SPEC §5 的 Core/Host 所有权划分与该既定设计完全一致。

---

## 3. GoldenTrace — 从 Artificer 到 replay/validator 的流向

```
Artificer L2 submit_rulecode
  └─ DefaultArtificerValidator.validate (artificer-output.ts:225)   [仅结构校验]
       goldenTraceCases: 2..10、≥1 正 ≥1 负、positive→allow、
       propose_correction 需 expectedProposedParams+Mode；v2 规则禁 propose_correction
  └─ 工件 contentJson 持久化（含 goldenTraceCases）
激活阶段 (rule-host-writer.ts)
  └─ parseContentJson + validateGoldenTrace (golden-trace.ts:148)
  └─ evaluateRefinerRuleHostGate (refiner-rulehost-gate.ts:94)
       ├─ evaluateInSandbox = createProductionGateDeps() (production-gate-deps.ts:169)
       │    ├─ 静态检查（禁用模式/return 形状/matched=false）
       │    ├─ compileRuleCode (node:vm, timeout 1000ms)
       │    └─ evaluateInRefinerSandbox (refiner-sandbox-wrapper.ts:198)
       │         └─ createSyntheticRuleHostInput —— 无 projectDir、无提示（§1.2）
       └─ 六值决策：accepted_shadow / rejected_validation_failed /
            rejected_forbidden_pattern / rejected_timeout /
            rejected_runtime_error / rejected_no_cases
Artificer 自验循环 replay_rulecode (artificer-l2-tool-contract.ts:258) → 同一 gate
Evaluator 对抗重放 (evaluator-runner.ts:2246-2331)
  └─ 自建输入（不走 sandbox wrapper），canonicalizeToolKind 只覆盖 write 类工具生成对抗用例
```

失败结构现状：`RefinerSandboxFailedCase {caseId, errorType(6 值), message, stack?}` + gate `reasons: string[]`；`ReplayValidatorCaseResult` 有 `failureReason`/`repairHint` 自由文本。**没有任何"层"概念**（rule / test / adapter / runtime / unknown 均不存在）。

---

## 4. 与既有审计的关系

本报告聚焦 v1.3 MVP 的三个 Phase 0 问题。更宏观的 ABC 能力审计见同日 `docs/audit/pri-634f-abc-phase0-capability-audit-2026-09.md`（针对已废弃的 ABC 版 SPEC；其 §1/§2 事实核对本报告全部复用并重新验证，file:line 在基准 commit 上仍然成立）。

---

## 5. Phase 1-3 实施含义（从基线推导，不引入新概念）

1. **Phase 1（工具语义闭环）**：新增宿主声明的 `ToolSemanticMappingV1` 层 + core 封闭枚举（复用 `CanonicalKind`），core 基线表保留为默认；`resolveToolSemanticKind` 纯查找。生产两处提示计算（gate.ts 集合、production-rulehost-gate 内联集合）与回放输入构建改从同一解析结果推导 `isBashTool`/`isWriteTool`（execute→bash 提示、write→write 提示），消除"提取行为依赖三方词表"。
2. **Phase 2（输入 parity）**：`buildRuleHostAction` 增加由 canonical kind 推导提示的能力（或在调用方统一用共享 helper），回放三处（refiner-sandbox-wrapper、golden-trace-replay-validator、golden-trace.createSyntheticRuleHostInput）与生产同语义调用；以 fixture 断言同输入同输出。
3. **Phase 3（失败归因）**：新增纯函数 `validateRuleReliability(ArtificerRuleOutput, registry)`（SPEC §7 的 Rule Reliability Validation）：affectedTools 可映射性（adapter/tool_unknown）+ goldenTraceCases toolName 可映射性；激活门失败结果挂 `failureLayer {rule|test|adapter|runtime|unknown}`。不新增修复系统。

## 6. 明确非目标（v1.3 SPEC §3 重申）

不建 BehaviorContract / Observation DSL / Receipt / 新 feature flag；不自动修复路由；不降低 replay 标准；`RuleHostInput` 现有字段的语义不变。
