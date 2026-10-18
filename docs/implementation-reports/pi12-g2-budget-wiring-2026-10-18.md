# PRI12-G2 逐请求 maxTokens 传递链路修复 — 交付报告

- 日期：2026-10-18
- 工作树：`D:\Code\_worktrees\principles\PRI12-G2-pi12-ac6-g2-actor`（分支 `ai/PRI12-G2-pi12-ac6-g2-actor`，基于上轮 `03c9a6d3d`）
- 任务模式：一次性非交互执行；零真实模型调用、零费用（含一次诚实披露的调试期 401 事件，见 §6）

## 0. 结论速览

| 验收项 | 判定 |
|---|---|
| 逐请求预算从调用方到实际 HTTP 请求完整传递 | **PASS**（wire 级测试证明序列化 body 中的 `max_tokens` 数值） |
| Actor 512 与 I0 1024 分别验证 | **PASS**（512 到 wire 的 tool-call/json/repair 三路径；1024 到 wire 的 free-form 路径；且经 real-runner 全链到 `StartRunInput`） |
| 所有输出路径覆盖 | **PASS**（tool-call / json_schema / free-form / repair 四路径均有 wire 断言） |
| HTTP 请求级离线测试证明最终预算值 | **PASS**（15 项新 wire 测试，mock 传输层捕获 `init.body`，真实 pi-ai 构造请求，零网络） |
| 全局预算/模型上限/旧调用兼容/重试行为无回归 | **PASS**（638 项既有 adapter+arch 测试全绿；PRI-1011 收缩梯从逐请求值起算有专项测试） |
| 相关单测/集成/类型检查 | **PASS**（core 665/665、scripts 866/866、build=tsc+dist 卫生、eslint 0 发现） |
| 实际模型调用次数 / 费用 | **0 次推理 / $0**（§6 披露一次调试期被 401 拒绝的外连请求，无推理、无费用） |
| G2 真实运行状态 | **NOT_RUN**（未动 OD-1/OD-2；512/1024 数值未改、未宣称校准；预注册草案未改） |

---

## 1. 实际修改的文件与关键代码位置

| 文件 | 改动 |
|---|---|
| `packages/principles-core/src/runtime-v2/runtime-protocol.ts` | `StartRunInputSchema` 新增可选 `maxTokens: Type.Number({minimum:1})`（timeoutMs 之后，~line 148-158）——契约文档明确"硬上限、只降不升、缺省不变、非法即响亮失败" |
| `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` | ① 新增 `resolveEffectiveMaxTokens(input, model)`（`resolveMaxTokens` 之后，~line 477-520）：验证正有限整数否则 `PDRuntimeError('input_invalid')`；有效值 = min(逐请求, profile config, model 上限)；无逐请求值时**原样返回 `resolveMaxTokens()`**（字节级旧行为）。② 四个请求构造点接线：`tryToolCallPath`（~1208）、`tryJsonModePath`（~1296）、`repairLLMCall`（~1420）、`completeWithRetry` 收缩梯种子（~1510）。③ **修复路径接回 PD 传输层**：`repairLLMCall` 补 `fetch: getPiAiFetchForApi(model.api)`——它是唯一漏传 `fetch` 的 completeSimple 调用点（healthCheck/三路径均已有），此前 repair 请求绕过 PD 专用 undici 传输、且 AC-6 wire 记录器计数不到它（授权请求预算在修复路径不可执行——潜在测量缺口，本次一并消除） |
| `scripts/dev/principle-learning-lab/lib/actor.mjs` | `createPiAdapterTransport` 的 `startRun` 调用新增 `maxTokens: request.maxTokens`（~line 176-180）——Actor 512 / I0 1024 不再被丢弃 |
| `packages/principles-core/src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter-budget-wire.test.ts` | **新增** 15 项 wire 级测试（§3） |
| `scripts/__tests__/principle-learning-lab-actor.test.ts` | +1 断言（transport 层 512 到 `StartRunInput`）与 +1 新测试（real-runner 全链：I0 1024 + 轮次 512） |

设计取舍：最终形态**不**穿线 `effectiveMaxTokens` 参数，而是各路径就地 `this.resolveEffectiveMaxTokens(input, model)`（四路径本就持有 input+model）——参数面零扩张、单一解析点、验证发生在各路径首个请求构建之前（`startRun` 里不再有前置解析步）。

## 2. 修复前后预算传递链路差异

```
修复前（断裂，两处丢弃/未消费）：
Actor caps.maxTokensPerRequest=512 / I0 REFLECTION_MAX_TOKENS=1024
  → transport.complete({maxTokens}) → createPiAdapterTransport 调 startRun 时【丢弃】
  → StartRunInput【无此字段】
  → PiAiRuntimeAdapter 只认实例级 config.maxTokens（实验室 profile 未设=undefined）
  → pi-ai options.maxTokens=undefined → 原生回退 model.maxTokens（借用 catalog=384000）
  → HTTP body: "max_tokens": 384000   ← 逐请求预算从未生效

修复后（贯通）：
Actor 512 / I0 1024
  → transport.complete({maxTokens})
  → startRun({maxTokens})            ← 透传
  → StartRunInput.maxTokens          ← 契约字段（可选、minimum 1）
  → resolveEffectiveMaxTokens：校验（正有限整数，非法=input_invalid 且零请求）
     有效值 = min(逐请求, config.maxTokens, model.maxTokens)   ← 只降不升
  → 四路径 completeOptions.maxTokens = 有效值（tool/json/repair/free-form+收缩梯种子）
  → pi-ai openai-completions buildParams：params.max_tokens = options.maxTokens
     （clampMaxTokensToContext 只按上下文窗口收缩；thinking 预算扩展只存在于
       anthropic/bedrock 路径，openai-completions 无 —— 逐请求值即 wire 硬上限）
  → HTTP body: "max_tokens": 512/1024  ← wire 级测试实证
```

优先级语义（任务要求逐条落地）：显式逐请求值 = 该请求硬上限；`min()` 保证不突破 profile 全局预算与模型输出上限；未传逐请求值的旧调用方走 `resolveMaxTokens()` 原路径（profile 值或 pi-ai 原生默认），行为逐字节不变；Provider 拒绝时的 PRI-1011 收缩梯保持不动，且实测从**逐请求值**起算（8192→4096，不是从原生 384000 起算）；错误分类（rate_limit/execution_failed）与超时控制未动。

## 3. HTTP 请求级测试证据

新文件 `pi-ai-runtime-adapter-budget-wire.test.ts`，**15/15 绿**。机制：mock `pi-ai-http-transport.js` 的 `getPiAiFetchForApi`（与 AC-6 harness 同一拦截点）捕获每个出站请求的 URL + 序列化 `init.body`；**其余全部真实**——真实 `resolveModel`（sensenova+baseUrl 借用 catalog 条目）、真实 pi-ai 请求构造与 SSE 解析、真实三路径+修复循环+收缩梯； canned SSE（OpenAI SDK 格式）经 `Response(text/event-stream)` 返回。零 socket、零密钥（dummy env 值非凭据）。

关键断言（均作用于 `JSON.parse(init.body).max_tokens`）：

| # | 场景 | wire 证据 |
|---|---|---|
| 1 | Actor 512，tool_call_first | `max_tokens===512` + `tool_choice==="required"` + `tools[0].function.name==="record_learning_lab_actor_action_v1"`，输出过 schema |
| 2 | Actor 512，json_mode_first | `max_tokens===512` + `response_format.type==="json_schema"` |
| 3 | I0 1024，无 schemaRef（free-form） | `max_tokens===1024` + 无 `response_format` |
| 4 | 修复路径（free_form_only+schema，首响应 `{}` 触发 repair） | 初始+repair 两个请求**都** `max_tokens===512`，第二请求 prompt 不同 |
| 5 | 旧调用兼容：无逐请求值、无 profile | `max_tokens===384000`（原生回退=借用 catalog 上限——把 AC-6 发现钉进测试） |
| 6 | 旧调用兼容：无逐请求值、profile=8000 | `max_tokens===8000` |
| 7 | 优先级：512 vs profile 4096 | wire=512 |
| 8 | 优先级：8192 vs profile 4096（free-form） | wire=4096 |
| 9 | 优先级：900000 vs 模型上限 384000（tool 路径） | wire=384000 |
| 10 | 非法值 `0/-5/12.5/NaN/Infinity`（5 例） | 各自 reject `input_invalid`，**wire 请求数=0** |
| 11 | PRI-1011：逐请求 8192 遭 400 "exceeds the maximum output tokens" | 请求 1=8192、请求 2=4096（梯子从逐请求值减半，未用原生 384000→192000）；telemetry `llm_max_tokens_downshift` from=8192 to=4096，证据串含预算拒绝签名 |

lab 侧（`principle-learning-lab-actor.test.ts`，**19/19 绿**）：fake adapter 捕获 `startRun` 入参——transport 层 512 到 `StartRunInput`；real-runner 全链 I0 调用 `maxTokens===1024`（无 schemaRef）、全部轮次调用 `maxTokens===512`（带 action ref）。

## 4. 执行的测试命令与真实结果

| 命令 | 结果 |
|---|---|
| `npx vitest run src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter-budget-wire.test.ts`（core） | **15/15 PASS**（新增） |
| `npx vitest run __tests__/principle-learning-lab-actor.test.ts`（scripts） | **19/19 PASS**（18+1 新增） |
| adapter 139 + wire 15 + arch 499 + runtime-config-contract（core 四套件） | **665/665 PASS** |
| `npx vitest run`（scripts 全量） | **866/866 PASS（47 文件）** |
| `npm run build --workspace @principles/core` | PASS（tsc 类型检查 + dist 卫生） |
| `npx eslint`（改动 core 两文件 + lab 两文件） | 0 发现 |
| `node scripts/dev/principle-learning-lab/run-pilot.mjs`（G1 重跑） | gate PASS、校准 14/14、**studyHash 与上轮逐字节一致**（`5a617d508e2f…`，确定性重放未受影响） |
| AC-6 三测试（无 LLM_E2E_ENABLED） | 3 skipped（零费用跳过路径，上轮已证；本轮未改其文件） |

## 5. 未解决风险与后续建议

1. **收缩梯下限语义**：`MIN_MAX_TOKENS_BUDGET=4096` 意味着低于 4096 的逐请求预算遭 Provider 拒绝时无法再收缩（保持原值重试至 maxRetries 耗尽）——现有机制如实保留，未改。若真实 G2 中 512 被拒，run 将以 execution_failed 失败（响亮、可观测），属预期行为。
2. **reasoning 模型注意**：openai-completions 路径逐请求值即 wire 硬上限；若未来实验室 Provider 走 anthropic/bedrock 形态，pi-ai 的 thinking 预算管理可能在 base 之上加 thinking 预算（上限仍被 model ceiling 钳住）——当前实验室路径（openai-completions）不受影响；真实 G2 若换 Provider 需重新验证 wire 值。
3. **健康探针以外仍有 `fetch` 全覆盖**：本次已消除最后一个漏网调用点（repair）；四个 completeSimple 调用点 + L2 适配器均已走 PD 传输层。
4. **512/1024 未校准**（任务 P1 保持）：两值维持上轮交付原样；真实 G2 前是否调整属 OD-2 预算决策。
5. 后续建议：`pi12-ac6-dreamer-real-llm.test.ts` 的 B1 场景仍无请求级输出上限（AC-6 解锁条件之二）——本次打通的 `StartRunInput.maxTokens` 机制可直接用于给该测试补显式预算。

## 6. PASS / NOT_RUN / 未验证事项与诚实披露

- **PASS**：§0 表中前六项（全部由上述测试证据支撑）。
- **NOT_RUN**：真实 G2 研究、真实 AC-6 三场景、任何真实模型推理——本次零调用、零费用；G2 真实运行前置（OD-1 冻结预注册、OD-2 凭据与费用上限、OD-3 种子数）未动，预注册草案与 pilot-run-config 未改，512/1024 数值未改。
- **未验证**：真实 Provider（SenseNova）对 `max_tokens` 字段的实际接受行为——无官方计费/行为文档，属 AC-6 BLOCKED_COST_GUARD 范畴，本次不在授权内。
- **诚实披露（调试期事件）**：修复前 `repairLLMCall` 不携带 `fetch`，第一次运行 repair 测试时该调用**绕过 mock 直连真实端点 `token.sensenova.cn`**，以 dummy 占位密钥被 **401 Forbidden 拒绝**——无任何模型推理、无费用、无有效凭据参与（环境变量为本测试自设占位值）。该事件即本报告 §1-③ 修复的直接动因：repair 路径现已被 mock 传输层拦截，测试套件整体不可再触网（15 项 wire 测试复跑验证请求全部落在拦截器）。
