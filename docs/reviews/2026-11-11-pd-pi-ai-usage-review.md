# PD 内置代理的 pi-ai 使用现状与优化空间

- 日期：2026-11-11
- 范围：只读调查。未修改 PD 与 `D:\Code\pi-mono` 的任何代码，未建 PR，未触发发布。
- 读者：不要求懂技术。结论先行，术语第一次出现时用日常话解释一句。
- 证据约定：PD 侧文件路径相对仓库根；pi-ai 侧路径相对 `D:\Code\pi-mono`。行号是本次调查时的实际位置。

---

## 一、结论摘要

1. **PD 对 pi-ai 的使用是"扎实但不均衡"的**：结构化输出（要求模型按固定格式返回结果）这一块做得相当成熟——三条兜底路径、类型校验、自动修复、截断识别都有；但**成本计量、取消、并发、上下文预算**这四块基本是空白。
2. **最大的稳定性缺口不是"模型答不好"，而是"错了之后怎么处理"**：重试判定靠正则匹配错误文本，用 `401/403/400` 这类配置错误也会被当成临时故障重试 3 次；供应商返回的 HTTP 状态码在适配层被丢掉了。
3. **最大的成本盲区是"看得见 token，看不见钱"**：pi-ai 已经算好了每次调用的美元成本（`usage.cost.total`），PD 只读了输入/输出 token 数，从不读取成本字段。也就是说，现在没有任何一处能回答"这次诊断花了多少钱"。
4. **最大的时延浪费在"三层输出路径各自发请求"**：一次调用最多可能发 5 个完整请求（工具路径 1 次 + JSON 路径 1 次 + 自由文本重试 3 次），而这三次尝试之间的失败原因往往是同一个。
5. **外部世界的主流做法是"把 pi 当底盘，自己只写上层"**：最成熟的使用者（OpenClaw）不做 fork、不重写模型层，而是在外面补会话、压缩、上下文裁剪、密钥轮换、模型故障转移。PD 目前只补了"输出修复"，没补"运行期降级"。

---

## 二、调查方法

- PD 侧：全仓搜索 `@earendil-works/pi-ai` 的 import 与调用点，逐个读适配层、runner、host-runtime、CLI 装配代码。
- pi-ai 侧：只读 `D:\Code\pi-mono` 的 `packages/ai` 公开导出面与关键实现（重试、溢出判定、用量、缓存、faux 测试替身）。
- 外部：公开网页与仓库文档，逐条给链接。查不到的部分明确写"未核实"。

---

## 三、现状盘点

### 3.1 模块地图（谁在用 pi-ai）

| 模块 | 职责 | 用到的 pi-ai 能力 |
| --- | --- | --- |
| `packages/principles-core/src/runtime/adapter/pi-ai-runtime-adapter.ts` | L1 一次性调用适配器（绝大多数 runner 都走这里） | `getModel`、`completeSimple`、`onPayload` 改写请求体、`usage` |
| `packages/principles-core/src/runtime/adapter/l2-agent-loop-adapter.ts` | L2 多轮智能体循环（dreamer） | `streamSimple`、`runAgentLoop`、工具定义、`finishTurn`/`beforeToolCall` |
| `packages/principles-core/src/runtime/adapter/artificer-l2-adapter.ts` | 原则落地阶段的带沙箱反馈循环 | 复用 `runAgentLoop` + `pdStreamSimple` |
| `packages/principles-core/src/runtime/adapter/pi-ai-http-transport.ts` | 专用 HTTP 传输层（关掉 Node 默认 300 秒空闲上限） | pi-ai 的 `fetch` 注入点 |
| `packages/principles-core/src/runtime/adapter/pi-ai-catalog.ts` | 模型目录（给 UI/配置用） | `getModels`、`getProviders` |
| `packages/principles-core/src/runtime/adapter/tools/diagnostician-tool.ts` | 把输出 schema 包装成"工具" | pi-ai 的 `Tool` 类型 |
| `packages/pd-cli/src/services/runtime-adapter-resolver.ts` | 从 `.pd/config.yaml` 装配适配器 | —（装配层） |
| `packages/host-runtime/src/signal-classifier.ts` | 痛点信号的分类（数据管道入口） | 经适配器 `startRun` |
| `packages/host-runtime/src/adaptive-selection.ts` | 原则的自适应选择 | 经适配器 `startRun` |

装配逻辑在 [runtime-adapter-resolver.ts](../../packages/pd-cli/src/services/runtime-adapter-resolver.ts) 第 287–328 行：只有 `runnerKind === 'dreamer'` 且 `l2_dreamer` 开关打开时才用 L2 循环，其余一律 L1。

### 3.2 能力使用矩阵

| 能力 | 状态 | 证据与说明 |
| --- | --- | --- |
| 模型调用 | 用了 | L1 全部走 `completeSimple`（[pi-ai-runtime-adapter.ts](../../packages/principles-core/src/runtime/adapter/pi-ai-runtime-adapter.ts) 第 581、1217、1312、1417、1517 行）；L2 走 `runAgentLoop` |
| 流式 | 用了，但只在 L2 | 只有 `pdStreamSimple` 一处（[l2-agent-loop-adapter.ts](../../packages/principles-core/src/runtime/adapter/l2-agent-loop-adapter.ts) 第 285–287 行）。L1 是阻塞式：等到完整响应再解析 |
| 工具调用 | 用了，但分两种"假/真" | 真：L2 用 `runAgentLoop` + 白名单工具（第 480–522 行）。假：L1 把输出 schema 伪装成唯一工具并强制 `tool_choice: 'required'`（第 1200–1219 行），模型并不会真的执行工具 |
| 多 provider | 用了 | 三级解析：内置目录 → 自定义 baseUrl 借用目录元数据 → 保守兜底（第 196–264 行）；`pi-ai-catalog.ts` 暴露 `getModels`/`getProviders` |
| 结构化输出 | 用了，且较成熟 | 三路径：工具调用 → `json_schema` 模式 → 自由文本 + 修复（第 770–1005 行）；TypeBox 校验；修复循环；截断识别 |
| Prompt 缓存 | **完全没用** | 全仓没有传 `cacheRetention` / `sessionId`（pi-ai 侧入参定义见 `packages/ai/src/types.ts` 第 252–258 行） |
| 重试 | 自己手写 | pi-ai 内建重试被显式关闭：`maxRetries: 0`（第 1510 行）。退避 1s×2ⁿ、上限 30s，限流再乘 2（第 1472–1476、1621–1623 行） |
| 超时 | 用了，但只有"总超时" | L1 用 `AbortSignal.timeout`（第 681 行）；L2 用 `AbortController` + 预算定时器（第 370–372 行） |
| 取消 | L1 实际不可取消 | `cancelRun` 是空实现（第 1143–1150 行），注释写明"一次性调用已阻塞，取消永远是 no-op" |
| 用量统计 | 用了，但只见 token | `usageSummaryOf` 只取 `input`/`output`（第 86–92 行）；Artificer L2 汇总 token（[artificer-l2-adapter.ts](../../packages/principles-core/src/runtime/adapter/artificer-l2-adapter.ts) 第 156–184 行） |
| 成本统计 | **完全没用** | 全仓没有读取 `usage.cost` / `model.cost` 的消费点（pi-ai 侧字段见 `packages/ai/src/types.ts` 第 467–493 行） |
| 错误分类 | 用了，靠正则 | 限流：`/rate.?limit\|429\|quota\|too many requests/i`（第 1577、1695 行）；输出预算被拒：`MAX_TOKENS_REJECTED_PATTERN`（第 77–78 行） |
| 降级 | L2 有，L1 没有 | L2 失败可回退到 L1（默认开，`l2FallbackToL1`）；L1 失败直接抛错，没有备用模型 |
| 并发/限流 | **没有** | 自动消费者每 120 秒串行跑一轮（[internalization-auto-consumer-service.ts](../../packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts) 第 21、209 行）；L2 能力声明 `supportsConcurrentRuns: false`（第 318 行） |
| 上下文管理 | **没有** | 没有 token 估算、没有 `contextWindow` 前置检查、没有历史压缩。唯一一处截断是把 Artificer 的输入砍到 5 万字符（[artificer-l2-adapter.ts](../../packages/principles-core/src/runtime/adapter/artificer-l2-adapter.ts) 第 428 行） |
| faux 测试替身 | 用了 | `pi12-spike-*`、`l2-adapters-g2-maxtokens` 等用 `registerFauxProvider` / `fauxAssistantMessage` / `fauxToolCall` |
| 真实 LLM 端到端测试 | 默认关闭 | `pi12-ac6-*-real-llm.test.ts` 需 `LLM_E2E_ENABLED=true` 才跑（[llm-e2e-config.ts](../../packages/principles-core/src/runtime/__tests__/fixtures/llm-e2e-config.ts) 第 21 行）；作为补偿，已有本地 HTTP 桩的 wire 测试（[pi-ai-runtime-adapter-budget-wire.test.ts](../../packages/principles-core/src/runtime/adapter/__tests__/pi-ai-runtime-adapter-budget-wire.test.ts) 第 1–19 行） |

### 3.3 数据管道各阶段的调用点

| 阶段 | LLM 调用点 | 输出 schema | 备注 |
| --- | --- | --- | --- |
| 痛点采集/分类 | `host-runtime/src/signal-classifier.ts` 第 97 行 | `SIGNAL_CLASSIFICATION_SCHEMA_REF` | 走 L1，无工具 |
| 观察/纠正 | `principles-core/src/runtime/observer/correction-observer.ts` 第 155 行 | `correction-observer-output` | 自带 30 秒超时 |
| 诊断-路由 | `diag-router-runner.ts` 第 357 行 | `diagnostician-output` | 走 L1 |
| 诊断-根因 | `diag-rootcause-runner.ts` 第 228 行 | `diag-rootcause-output` | 走 L1 |
| 诊断-蒸馏 | `diag-distiller-runner.ts` 第 189 行 | `diag-distiller-output` | 走 L1 |
| 原则生成 | `dreamer-runner.ts` 第 214 行 | `dreamer-output` | 唯一走 L2 的 runner |
| 原则加工 | `philosopher-runner.ts`、`scribe-runner.ts` | `philosopher-output`、`scribe-output` | 走 L1 |
| 原则落地 | `artificer-runner.ts` 第 1065 行 / `artificer-l2-adapter.ts` | `artificer-rule-output` | 可走带沙箱反馈的 L2 |
| 原则选择/复用 | `adaptive-selection.ts` 第 454 行、`reuse-evaluation-runner.ts` 第 271 行 | 选择调用**没有** schemaRef；复用评估有 `reuse-evaluation-output` | 前者无结构约束，靠自由文本 |
| 证据链 | `evaluator-runner.ts` 第 712 行、`rollout-reviewer-runner.ts` 第 549 行 | `evaluator-output`、`rollout-reviewer-output` | 走 L1 |

> 注意：`adaptive-selection.ts` 那次调用没有 `outputSchemaRef`，等于**绕过了整套结构化输出保护**。这是管道里唯一的"裸调用"。

---

## 四、现有用法的薄弱点与优化空间

### 4.1 超时与取消

- **现状**：L1 用 `AbortSignal.timeout(总预算)`，超时值优先级为 运行器传入 > 配置 > 30 万毫秒（[pi-ai-runtime-adapter.ts](../../packages/principles-core/src/runtime/adapter/pi-ai-runtime-adapter.ts) 第 676–681 行）。`cancelRun` 是空实现（第 1143–1150 行）。输出修复调用另起一个固定 60 秒的独立计时器（第 1394–1395 行）。
- **风险**：① 用户在 Console 上"取消"不会真正中断请求，只是关掉界面；② 修复调用不受主预算约束，一次 run 的实际耗时可以是"主超时 + 多个 60 秒"，与运行器以为的截止时间不一致；③ 进程退出时无法优雅收尾。
- **建议**：适配器自己持有 `AbortController`，把"外部取消"和"总超时"合并成一个信号（Node 的 `AbortSignal.any`）；修复调用继承剩余预算而不是固定 60 秒。
- **预期收益**：稳定性（不再出现"取消无效"），成本（避免已放弃的请求继续计费）。

### 4.2 失败重试策略

- **现状**：pi-ai 自带的重试被关掉，PD 自己写循环。判定依据是错误文本正则：限流靠 `429/quota/rate limit` 字样，预算被拒靠 `max_tokens exceeded` 字样（第 1577、1581、1695 行）。HTTP 状态码在适配层不可见——`AssistantMessage` 只带 `stopReason` 和 `errorMessage`。
- **对照**：pi-ai 自带策略按状态码判断（408/409/429/5xx 可重试），并且优先读响应头的 `x-should-retry`，还会按 `retry-after` 等待（`packages/ai/src/utils/provider-retry.ts` 第 24–37、53–61 行）。
- **风险**：① `401/403`（密钥错、权限错）和 `400`（参数错）会被当成临时故障重试满 3 次，纯浪费；② 供应商要求"等 30 秒再来"时被忽略，加剧限流；③ 错误消息里恰好出现 "quota" 的非限流错误会被误判。
- **建议**：在已有的 fetch 包装层（`pi-ai-http-transport.ts`）记录 HTTP 状态码与关键响应头，随响应带回适配层；按状态码分类，非 429 的 4xx 不重试，尊重 `retry-after` 且设上限。**不要**重新开启 pi-ai 的内建重试（会变成双重重试）。
- **预期收益**：稳定性（少发无意义请求），成本（少花 2/3 的无效重试）。

### 4.3 三层输出路径的请求放大

- **现状**：默认策略 `tool_call_first`。工具路径失败 → JSON 路径 → 自由文本（第 770–796 行）。前两条路径**各自只发一次请求且不重试**，只有第三条走 `completeWithRetry`（默认重试 2 次）。最坏情况：1 + 1 + 3 = 5 次完整请求。
- **风险**：一次限流或一次网络抖动，会被放大成 5 倍成本和 5 倍时延；而且这 5 次里前两次失败的原因常常和第三次相同（同一个供应商故障）。
- **建议**：给"整个 run"设一个请求次数/金额预算，三条路径共享；当失败原因是可重试的传输类错误时，先重试当前路径，而不是换路径重来。
- **预期收益**：时延（最坏路径缩短约 60%），成本（同比例下降）。需要 characterization 测试锁定现有行为。

### 4.4 并发与限流

- **现状**：自动消费者每 120 秒醒一次，串行处理（第 21、209 行）；每个工作区一个循环；没有按 provider 的并发上限或速率控制。
- **风险**：① 一个 5 分钟的诊断会堵住后续所有任务；② 多工作区同时跑时可能同时打同一个供应商，触发 429；③ 没有任何"排队中"的可见性。
- **建议**：先测量真实并发（同一时间挂起的任务数、429 比例）。若确有必要，引入"按 provider 的并发上限 + 公平队列"，而不是全局并行。**这是有条件再做项**——当前串行并没有被证据证明是瓶颈。
- **预期收益**：时延（吞吐），风险：调度复杂度上升。

### 4.5 上下文拼装与截断

- **现状**：输入就是把 `inputPayload` 直接 `JSON.stringify` 成一条用户消息（第 683–691 行）；没有任何 token 估算，也不检查模型的 `contextWindow`。唯一截断是 Artificer 的 5 万字符（第 428 行），而且截断后不记录"砍掉了什么"。
- **风险**：① 上下文超限只能在供应商那里失败，白花一次请求；② 证据链很长时被静默截断，诊断输入不完整却无人知道；③ 不同模型的上下文窗口差异（12.8 万 vs 100 万）完全没有被利用。
- **建议**：发请求前用模型的 `contextWindow` 做一次估算；超限时按"证据优先级"截断并写入证据包（明确记录被丢弃的条目 id）。pi-ai 已提供溢出判定 `isContextOverflow`（`packages/ai/src/utils/overflow.ts` 第 144 行），可用于把"上下文溢出"从普通失败里区分出来。
- **预期收益**：稳定性（少一类莫名失败），可解释性（截断有据可查）。

### 4.6 结构化输出校验

- **现状**：这是 PD 做得最好的部分——三条路径 + TypeBox 校验 + 修复循环 + 截断识别 + 血缘字段剥离（第 861–1004 行）。薄弱点有三个：① 工具/JSON 路径校验失败后直接落到下一条路径，不尝试修复；② `tool_choice: 'required'` 和 `response_format: json_schema` 是**无条件**注入的（第 1215、1300 行），不支持的供应商只能靠失败回退；③ 校验错误最多带 10 条（第 867 行）。
- **风险**：① 一次"差一个字段"的输出会白白触发两次额外请求；② 对不支持该参数的供应商，第一条路径注定失败。
- **建议**：把"修复循环"提到路径选择之前——任何一条路径拿到可解析但 schema 不匹配的输出，先就地修复一次；按模型能力（pi-ai 的 `compat` 元数据）决定要不要注入 `tool_choice`。
- **预期收益**：时延/成本（少两次请求），稳定性（少一次"全链失败"）。

### 4.7 成本与用量可观测

- **现状**：只记录输入/输出 token（第 86–92 行），仅出现在 `runtime_invocation_succeeded` 这一个事件里；修复调用、重试调用、L2 的每一轮各自不单独记账。
- **风险**：无法回答"哪个阶段最贵""一次诊断平均多少钱""本月成本趋势"；无法给预算告警。
- **建议**：读取 pi-ai 已算好的 `usage.cost.total`（`packages/ai/src/types.ts` 第 481–493 行）。注意 1.2.0 **没有**"供应商实收 / 目录估算"标记（1.5.1 才加 `totalFromProvider`），因此只能当作**估算值**使用。补上 `totalTokens`、模型名、阶段名，落到现有遥测里；该数值只代表**最终成功响应**，不含修复/回退/重试的中间调用。
- **预期收益**：成本（可归因、可设预算）。这是**投入产出比最高的一项**：pi-ai 已经算好了，PD 只是没读。收益边界是"最终成功响应的成本"，不是"一次诊断的真实总成本"。

### 4.8 错误分类与降级

- **现状**：错误被归一化为 PD 自己的类别（`timeout` / `rate_limit` / `output_invalid` / `runtime_unavailable` / `execution_failed`）。L1 没有备用模型；L2 有"回退到 L1"。
- **风险**：① 密钥/权限错误被归到 `execution_failed`，然后重试；② 没有"换一个模型再试一次"的能力，供应商单模型故障时整条管道停摆。
- **建议**：先把分类做准（见 4.2）；模型级故障转移属于"有条件再做"，前提是先有失败率数据。
- **预期收益**：稳定性。

---

## 五、pi-ai 里没用上、但值得考虑的能力

| 能力 | 值得程度 | 为什么 | 引入成本 / 冲突点 |
| --- | --- | --- | --- |
| `usage.cost.total` + `totalTokens` | **高** | 已经算好，只差读取（`packages/ai/src/types.ts` 第 467–493 行） | 极低。冲突：无 |
| `cacheRetention` / `sessionId`（Prompt 缓存） | **中高** | 修复循环和 L2 多轮会重复发送相同前缀；缓存能把重复部分按折扣计费（`packages/ai/src/types.ts` 第 252–258 行，Anthropic 实现见 `api/anthropic-messages.ts` 第 82–97 行） | 低（传两个参数）。冲突：需要确认所用 OpenAI 兼容端点是否支持；缓存计费规则因供应商而异，需实测 |
| pi-ai 的重试**判定**（非重试循环） | **中高** | 状态码 + `x-should-retry` + `retry-after`，比正则可靠（`utils/provider-retry.ts` 第 24–61 行） | 中：需要先让状态码可见。冲突：PD 已有自己的循环，只借判定 |
| `isContextOverflow` | **中** | 把"上下文太长"从普通失败里分出来（`utils/overflow.ts` 第 144 行） | 低。冲突：无 |
| `onResponse` 钩子 | **中低** | 可拿到供应商请求 id / 请求状态，补进证据链 | 低。冲突：无 |
| `validateToolArguments` | **低** | 只有 PD 真的执行模型选择的工具时才需要（`utils/validation.ts` 第 37–54 行） | 低但当前无用武之地——L1 的工具是"假工具" |
| `StreamingJsonParser` / `ToolCallArgumentsStream` | **低** | 适合边流边解析；PD 的 L1 是阻塞式，没有增量 UI 需求（`utils/streaming-json.ts` 第 109、452 行） | 中。冲突：会改变输出处理架构 |
| faux provider 更多场景 | **低** | PD 已用它覆盖单元测试；边际收益小（`providers/faux.ts` 第 42–145 行） | 低 |
| pi-durable 的会话压缩 | **不建议** | 它是完整会话持久化 + 压缩子系统（`packages/durable/src/harness/compaction.ts` 第 112 行起） | 高：引入新的持久化与后台任务，PD 的 runner 都是无状态一次性调用，没有长会话 |
| `createAgentSession`（pi-coding-agent） | **不建议** | OpenClaw 用它是因为要完整编码智能体；PD 只需要"一次结构化问答"或"受控多轮" | 高：会引入文件系统工具、会话生命周期、权限边界 |
| Agent 类的 steering / 会话恢复 | **不建议** | PD 的 L2 已有 `finishTurn` 硬停止，够用 | 中高：无对应需求 |

---

## 六、外部实践调研

> 说明：pi 生态公开资料不算多，下面每条都附可核实链接，并标明"这条链接支持什么结论"。查不到的部分在最后统一列出。

### 6.1 谁在用它、怎么用

| 项目 | 链接 | 它做了什么（对应结论） |
| --- | --- | --- |
| pi 官方站 | https://pi.dev/ | 自我定位是"最小智能体底盘（minimal agent harness）"：只提供底盘，工作流由使用者自己长出来。对应结论：**上层编排应该由使用方拥有** |
| pi 官方迁移公告 | https://pi.dev/news/2026/5/7/pi-has-a-new-home | `@mariozechner/pi-*` 已迁到 `@earendil-works/*`。对应结论：PD 现在用的包名是正确的，不必回退 |
| OpenClaw（PD 的宿主） | https://docs.openclaw.ai/pi | 直接 `import` pi SDK 并用 `createAgentSession()` 嵌入，注入自定义工具、自定义系统提示词、订阅会话事件。**不 fork、不重写模型层** |
| OpenClaw 智能体运行时 | https://openclaw-ai.com/docs/concepts/agent | 明确写着"复用 pi-mono 的模型/工具部分，但会话管理、发现、工具接线是 OpenClaw 自己的"。对应结论：**边界划分：底层用现成的，运行期治理自己写** |
| AnEntrypoint/foph | https://raw.githubusercontent.com/AnEntrypoint/foph/HEAD/AGENTS.md | 项目规约里专门有一节叫 "Substrate (do not reimplement)"，要求基于 pi 的 `AgentSession`/`Agent` 做上层，并用状态机（xstate）包住。对应结论：**别重写底盘，用状态机管流程** |
| ruvnet/agent-harness-generator | https://raw.githubusercontent.com/ruvnet/agent-harness-generator/HEAD/docs/adrs/ADR-004-host-integration-model.md | 把 pi.dev 当作要适配的宿主之一，用"宿主适配器"隔离差异。对应结论：**宿主差异应该收敛在一层适配器里** |
| pi-loop-guard | https://raw.githubusercontent.com/solknight48/pi-loop-guard/HEAD/test/run-tests.cjs | 一个社区扩展，专门处理"输出被截断后遗留的工具调用"。对应结论：**截断是这类系统的共性坑，值得做成显式机制** |

### 6.2 共性做法（以及 PD 的对照）

1. **嵌入而非 fork**：成熟项目都直接依赖 pi 的包，把定制放在自己的层。PD 已经是这样，方向正确。
2. **会话与上下文自理**：OpenClaw 有一整套 `history.ts`（历史裁剪）、`compact.ts`（溢出后自动压缩）、`context-pruning.ts`（按缓存有效期裁剪）。PD 目前**完全没有**这一层。
3. **故障转移是一等公民**：OpenClaw 用 `FailoverError` 触发换模型，用"认证配置轮换 + 冷却"处理密钥级故障。PD 只有 L2→L1 的路径回退。
4. **运行要有"排队 + 中止"**：OpenClaw 的 `runs.ts` 负责"活跃运行追踪、中止、排队"。PD 的取消是空实现。
5. **超时是预算而不是单点**：OpenClaw 的入口参数就是 `timeoutMs: 120_000`，配合运行队列统一约束。PD 是"每个适配器自己算"，修复调用还会突破预算。
6. **评测依赖替身 + 少量真实调用**：pi 仓库自带 `packages/evals`；PD 已经用 faux + 本地 HTTP 桩，这一点不比公开项目差。

### 6.3 能直接借鉴的 / 不该照搬的

- 直接借鉴：②（上下文预算）、③（分类准确的降级）、④（真正可用的取消）。这三项都不需要引入新框架。
- 不该照搬：OpenClaw 的会话持久化与压缩——它服务的是"长期聊天会话"，PD 的 runner 是一次性任务，照搬会引入不必要的状态。

---

## 七、建议清单（按影响排序）

> 排序依据：先看"是否影响管道正确性"，再看"是否白花钱"，最后看"是否只是变快"。
> 每条都标了收益维度、成本、风险。

### 立刻值得做

| # | 问题 | 证据 | 改法 | 收益 | 成本 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 成本不可见 | 只读 token（适配器第 86–92 行），pi-ai 已算好 `cost.total`（`types.ts` 第 481–493 行） | 读取 `usage.cost.total` + `totalTokens`，补进成功遥测，按 阶段/模型 归集 | 成本（可归因、可告警） | 小 | 低。字段缺失时保持 null，不猜 |
| 2 | 重试判定错误 | 正则判限流（第 1577、1695 行）；pi-ai 有状态码策略（`provider-retry.ts` 第 24–61 行） | 在 fetch 包装层记录 HTTP 状态/响应头，按状态码分类；4xx（非 429）不重试；尊重 `retry-after` 并设上限 | 稳定性 + 成本 | 中 | 中。重试次数会变，需回归测试锁定 |
| 3 | 输出路径请求放大 | 三条路径各自发请求，仅第三条重试（第 770–796 行；重试上限第 1455 行） | 给整个 run 设请求数/金额预算并共享；可重试的传输错误就地重试而非换路径 | 时延 + 成本 | 中 | 中。属行为变更，需 characterization 测试 |
| 4 | 取消无效 | `cancelRun` 空实现（第 1143–1150 行） | 适配器自持 `AbortController`，与总超时合并；`cancelRun` 真正 abort | 稳定性 + 成本 | 小 | 低。会让"假取消"变成真取消 |
| 5 | 唯一裸调用没有结构约束 | `adaptive-selection.ts` 第 454 行没有 `outputSchemaRef` | 补一个 schema，走同一套三路径保护 | 稳定性 | 小 | 低。需要定义 schema，会暴露现有输出的不规范 |

### 有条件再做（先有数据再动手）

| # | 问题 | 触发条件 | 改法 | 收益 | 成本 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | 没有 Prompt 缓存 | 确认主力供应商支持，且修复/多轮调用占比高 | 传 `cacheRetention`/`sessionId`，实测命中率与账单差异 | 成本 + 时延 | 小 | 中：计费规则差异 |
| 7 | 上下文无预算 | 出现"上下文超限"失败或证据被静默截断 | 前置估算 + 按优先级截断 + 用 `isContextOverflow` 分类 | 稳定性 | 中 | 中：截断策略需要产品判断 |
| 8 | 串行导致排队 | 实测到任务积压或 429 占比上升 | 按 provider 的并发上限 + 公平队列 | 时延 | 中高 | 中高：调度复杂度 |
| 9 | 无模型故障转移 | 观测到单模型故障导致的整链失败 | 在适配器外层做"换模型重试一次"，借鉴 OpenClaw 的 failover 思路 | 稳定性 | 中 | 中：需要第二套模型配置与成本口径 |

### 不建议做

| # | 动作 | 理由 |
| --- | --- | --- |
| 10 | 引入 pi-durable 的会话压缩/持久化 | 引入新的持久化子系统，PD 的 runner 是无状态一次性任务，没有长会话需求 |
| 11 | 迁移到 `createAgentSession` 全量智能体运行时 | 会引入文件系统工具、会话生命周期与权限边界；PD 的 L1/L2 边界已经足够 |
| 12 | 接流式 JSON 增量解析 | L1 是阻塞式，没有增量展示需求；改动输出处理架构，收益不成立 |
| 13 | 为"未来可能的多 provider 并行"预建抽象 | 目前没有第二个 provider 的运维数据，属于投机抽象 |
| 14 | "顺便升级 pi-ai 版本" | 没有收益论证。除非某项能力（如缓存字段）在现版本不可用，才单独立项 |

---

## 八、局限与未核实项

1. **外部项目的行为细节有限**：除 OpenClaw 与 pi 官方文档外，其余项目多为仓库内的规约/ADR 文本，能证明"设计取向"，但不能证明"生产运行效果"。本文没有把这些当成绩效证据使用。
2. **未核实**：OpenClaw 的评估（eval）实践细节没有找到公开文档；只能确认 pi 仓库自带 `packages/evals`。
3. **未核实**：PD 所用供应商对 `json_schema`、`tool_choice: 'required'`、`cacheRetention` 的实际支持度。本文只根据代码里的"失败即回退"推断，没有做真实供应商探测。
4. **未实测**：并发是否为瓶颈、429 占比、缓存命中率、修复循环的真实触发率。这些都需要运行时数据；文中相关建议已标为"有条件再做"。
5. **行号会漂移**：本报告的所有行号对应 2026-11-11 的 `main`（`59a23707c` 之后的工作树）。
