# PRI-1119 交付证据最小设计（wire 边界存在性核验）

- 文档 ID：`pd-aa-pri-1119-delivery-evidence-minimal-design-20261107`
- 版本：v1.0（2026-11-07，设计稿，**未实现**；实现需 Owner 按 §9 批准卡批准）
- 性质：可审阅、可批准的最小接线方案 + 离线验收反例；不是实现报告，不宣称任何验证已通过
- 上游事实来源：[PD-AA-PRI-1119-PROVIDER-EVIDENCE-20261107.md](./PD-AA-PRI-1119-PROVIDER-EVIDENCE-20261107.md) §3.1（2026.11.1 安装产物逐文件核实的边界图）

## 0. 目标与不目标

**目标**：让 SPEC G1/C04 的 D（独立确认目标正文位于同一决策的实际模型请求，且送达先于关键行动）从"永远 unknown"变为"可判定"——对每一次模型请求尝试，记录目标正文在**最终序列化请求**中的存在性。

**不目标**：
- 不记录、不落盘任何 prompt 正文（含 system prompt、注入块、消息内容）；
- 不因记录了存在性/摘要就自动升级 confirmed/timely（D 还要求机会身份绑定与时序，见 §2/§7）；
- 不新建代理服务、证据平台、census 系统；
- 不改变请求内容、路由、重试语义——核验是纯只读观察。

## 1. 前提事实（均已按 2026.11.1 安装产物核实）

1. `openai-responses` 路径已有 wire 边界观测钩子：`createResponsesPromptEgressObserver`（`@openclaw/ai/dist/openai-responses-request-lifecycle-*.mjs`）在每次尝试发出前被调用，拿到**最终请求体** `request`（`instructions` / `input[]`）。
2. `openai-completions` 路径（`client.chat.completions.create`，`openai-completions-transport-*.mjs:3320`）**没有任何观测钩子**——这是交付 run 无事件的根因（交付会话模型全部走 completions）。
3. 存储 prompt（`context.compiled` / `prompt.submitted`）与最终请求**不在同一边界**；`model.completed.finalPromptText` 只是本轮 user-turn 文本。
4. 截断发生在轨迹记录器入库前（逐字符串 32,768；`finalPromptText` 4,096 字节）。
5. 目标 activation 正文可从冻结已授权来源取得（PD `state.db`：`activations`+`pi_artifacts`+`approvals`，revision/epoch 一致性可校验）；样本期正文 `content_json` 长度 ≈ 2.2 KiB。

## 2. 七点设计要求逐条回答

### 2.1 在哪个边界检查

**两个检查点，均落在传输 wire 边界（请求序列化完成后、发出前）**：

| 路径 | 检查点位置 | 复用情况 |
|---|---|---|
| `openai-responses` | 现有 egress observer 的调用帧内（`observePrompt?.(attempt.request, {egress, payloadVariant})` 之后、`encodeBody` 之前） | **复用现有钩子**，不新增调用链 |
| `openai-completions` | `client.chat.completions.create(params, requestOptions)` 调用前一步（`params` 已是最终序列化请求） | **新增一个调用点**（该路径今天完全无观测） |

不在 agent 装配边界检查（那里看不到 wire），不在记录器里检查（那里只剩截断残片）。

### 2.2 检查结构化消息的哪些字段和角色

| API | 检查字段 | 角色 |
|---|---|---|
| responses | `request.instructions`（string）；否则 `request.input[]` 中第一个 `role ∈ {"system","developer"}` 的 `content`（string 或 `input_text` 部件拼接） | system/developer |
| responses（负例覆盖） | 若目标正文出现在 `input[]` 的 `role="user"` / tool 消息中 → 记 `presentInWrongRole=true`，不计为 system 存在 | user/tool |
| completions | `params.messages[]` 中第一个 `role="system"` 的 `content`；无 system 消息则 `source=missing` | system |
| completions（负例覆盖） | 同上，user/tool 角色命中记 `presentInWrongRole=true` | user/tool |

匹配语义：**对"完整注入块文本"与"单条 activation 正文"分别做精确子串检查**（`includes`，逐 activation 一次）；不做正则、不做归一化、不做模糊匹配。

### 2.3 目标正文与 revision 的冻结来源

- **来源（唯一权威）**：PD 工作区 `state.db`（`activations` → `pi_artifacts` → `approvals` 联表），即注入事件同一管线的授权读取路径（`runtime-prompt-activation-reader.ts` 同源）。
- **冻结时机**：每次注入（prompt 构建）时，PD 插件把当轮 `prependSystemContext` 全文与每条 activation 的 `{activationId, revision, bodySha256, bodyChars}` 投影到一次**进程内传递**（随现有注入返回值走，不新增存储）。
- **wire 侧期望值**：检查点收到的期望集 = `[{activationId, revision, bodySha256, bodyText}]`。`bodyText` 仅在内存中用于 `includes`，**永不落盘**。
- **授权校验**：期望集附带注入事件 id（`eventId`/`runId`）与 revision；wire 侧只核验"本次请求的期望集"，不回读历史期望集。

### 2.4 如何记录存在、缺失、变更、不可解析、失败

新增事件字段（挂在**现有** `provider.prompt.observed` 事件上 + completions 路径发射同名事件，信封已含 `modelApi/provider/modelId`）：

```jsonc
{
  // 现有字段保持：promptSource, expectedChars, observedChars, matchesAssembledPrompt, model, ...
  "presenceCheck": {
    "checked": true,                    // false = 未启用/期望集为空（诚实记录，不静默）
    "reason": null,                     // checked=false 时：disabled | empty_expectations
    "systemRegionChars": 61234,         // 被检查的 system 区域长度
    "systemRegionSha256": "…",          // system 区域全文摘要（双边界投影之一）
    "assembledBlockSha256": "…",        // 注入块全文摘要（装配边界投影；与上一条对照可检"装配→wire 是否漂移"）
    "results": [
      { "activationId": "act_prompt_…", "revision": 0, "bodySha256": "…",
        "presentInSystem": true,        // 精确子串命中
        "presentInWrongRole": false }   // 出现在 user/tool 角色
    ],
    "checkFailed": false,               // 检查本身抛错
    "checkFailedReason": null           // unparseable_content | exception:<class>
  }
}
```

- **存在**：`presentInSystem=true`；**缺失**：`false`（装配了却没进 wire → 明确可见）；
- **变更**：`systemRegionSha256 ≠ 装配端 assembledBlockSha256` 的对照差异 + revision 不匹配；
- **不可解析**：`content` 既非 string 也非可拼接部件数组 → `checkFailed=true, checkFailedReason=unparseable_content`；
- **失败**：检查代码 try/catch 包裹，异常 → `checkFailed=true`，**绝不向传输路径抛错**。
- 所有字段有界（见 §4），`results` 只含本次注入的 activation（≤18）。

### 2.5 如何绑定宿主 run、请求尝试、配置与后续行动

- **run/尝试**：事件信封已有 `sessionId/runId/seq/ts/modelApi`；观察回调按**每次尝试**触发（`payloadVariant=attempt.kind`，含 retry），事件逐尝试落盘——重试与首次不合并；
- **配置**：期望集内含 `revision` 与注入事件 id；信封 `modelId/modelApi` 记录当时路由；
- **后续行动**：与现有联结相同（session+seq+runId → 工具/声明事件的时间序）；D 的"送达先于关键行动"仍按 transcript seq 对序判定；
- **机会身份**：D 仍**不自动升级**——wire 存在性 + 时序只是 D 的必要条件；把某次请求绑定到"某个机会"仍需观察方案 §4 的机会键与人工联结。存在性记录不冒充机会识别。

### 2.6 如何避免把重试、后续请求或旧 revision 的证据借给当前机会

1. **逐尝试记录**：retry/continuation-rejected/第二次模型请求各自产生独立事件（`payloadVariant` 区分）；复盘按"机会键 + 事件 ts + attempt kind"取**早于关键行动的最早尝试**，不允许事后挑任意一条；
2. **revision 绑定**：期望集只在注入时冻结；原则改版后的新请求携带新 revision，旧 revision 的命中不会出现在新请求事件里（期望集不跨 run 复用）；
3. **不回填**：事件只在请求发出前生成，`ts` 为发射时点；观察方案已禁止用事后信息倒填事前字段；
4. **跨 run 不借证**：期望集与注入事件同 run 生命周期；没有"上次注入过所以这次也算"的路径。

### 2.7 证据来源分类（独立观测 vs PD 自身声明）

| 证据 | 分类 | 说明 |
|---|---|---|
| wire 边界 `presenceCheck`（存在性 + system 区域摘要） | **宿主传输边界观测**——独立于 PD 的返回片段（PD 无法通过返回片段伪造），但**运行在宿主进程内，属宿主自录，非第三方**。信任边界：相信宿主进程代码如实执行检查（由代码评审 + fixture 保证），不假设 PD 可信 | D 的核心新增 |
| 注入事件（eligible/injected/dropped） | PD 自身声明 | 装配事实 |
| `prependSystemContext` / 装配端 `assembledBlockSha256` | PD 自身声明 | 装配投影 |
| `matchesAssembledPrompt`（现有长度/全等） | 宿主传输边界观测 | 既有 |
| PD `intervention_evidence_records` / receipt | PD 自身声明 | 不作 D 依据 |
| 模型实际收到什么（provider 侧服务器日志） | **不可得**（第三方，未授权访问） | 本设计的信任上界到此为止，如实声明 |

## 3. 具体接线（文件级，生产者/消费者）

| # | 文件（2026.11.1 产物对应源文件） | 改动 | 角色 |
|---|---|---|---|
| 1 | `@openclaw/ai/dist/openai-responses-request-lifecycle-*.mjs`（源 `packages/ai/src/transports/openai-responses-prompt-observer-internal.ts`） | `createResponsesPromptEgressObserver` 返回的回调内追加 `presenceCheck` 计算（收到期望集时） | **生产者（responses）**：wire 边界检查 |
| 2 | `@openclaw/ai/dist/openai-completions-transport-*.mjs` 的 `client.chat.completions.create` 调用帧 | 发出前调用同一检查函数（新增 ~10 行） | **生产者（completions）**：wire 边界检查 |
| 3 | 嵌入 runner（`wrapStreamFnWithProviderPromptState`，`src/agents/embedded-agent-runner/`） | 把期望集从注入返回值传递到检查函数（进程内参数传递） | 传递者 |
| 4 | `@openclaw/ai/dist/openai-completions-*.mjs`（completions 客户端） | 新增与 responses 对齐的 `promptObserver` 选项槽位（同一事件名） | 生产者支撑 |
| 5 | 轨迹记录器（`src/…/trajectory`） | 无改动（`presenceCheck` 作为 `provider.prompt.observed` 的 data 字段自然通过现有 sanitize；字段全部 ≤ 上限） | 消费者（落盘） |
| 6 | PD 侧 | **零改动**（期望集来自现有注入返回值；不新增 PD 写侧） | 现有边界复用 |

**明确不做**：不新增事件类型、不新增存储表、不新增进程/服务；期望集不落盘；检查函数无状态（每次调用独立）。

## 4. 上限（单次读取/输出/保存）

| 项 | 上限 | 依据 |
|---|---|---|
| 检查的 activation 数 | ≤ 当轮 injectedCount（实测最大 18） | 期望集=本次注入 |
| 单条正文参与 `includes` 的长度 | ≤ 16 KiB（超长截断期望并记 `bodyTruncated=true`；实测 ≈2.2 KiB） | 防御性上限 |
| `includes` 扫描次数 | 每 activation × 每尝试 2 次（system 区域 + 错误角色区域） | 最小 |
| 事件新增体积 | ≤ ~1.5 KiB/事件（18 条 results 时） | 相对现有事件可忽略 |
| 新增落盘正文 | **0** | 只有布尔、长度、摘要 |
| 新增时延 | 每 activation 一次线性扫描（µs 级）；无 I/O | 不阻塞普通任务 |

## 5. 隐私与回退

- **隐私**：正文永不落盘/入日志/入遥测；摘要为不可逆投影；错误角色命中只记布尔，不记上下文片段。
- **失败回退**：检查异常 → `checkFailed=true` + 原因，请求照常发出（观察失败不影响业务）；未启用/期望集为空 → `checked=false` + reason，**不静默**（rc-9）。
- **普通任务不阻塞**：同步检查在请求发出前的关键路径上，但为纯内存字符串扫描（无 I/O、无锁）；最坏情况（18×16KiB×2 次扫描）< 1ms。

## 6. 离线验收反例（每例给出期望事件；均为**设计示例 fixture**，非已实现测试）

用手工构造的请求体 + 期望集驱动检查函数（抽出为纯函数以便离线测试），比对输出事件。实现时这批用例必须先红后绿：

| # | 反例 | fixture 输入 | 期望事件内容 |
|---|---|---|---|
| A1 | 目标存在 | responses `input[0].role=system` 含目标正文（bodySha256=X） | `presentInSystem=true`；`systemRegionSha256` 为该区域全文摘要 |
| A2 | 目标缺失 | system 区域不含目标正文（装配端声称注入） | `presentInSystem=false`；与 `assembledBlockSha256` 对照可显示装配→wire 漂移 |
| A3 | 截断/字段不可读 | `content` 为对象且无 `input_text` 部件 | `checkFailed=true, reason=unparseable_content`；请求照常发出 |
| A4 | revision/配置变化 | 期望集 revision=1，注入块为 rev0 文本 | `presentInSystem` 按**实际文本**判定；results 内 revision 与装配差异可见（不匹配不算命中） |
| A5 | 错 run/错请求 | 期望集属于 run-1，检查发生在 run-2 | 构造上不可能（期望集随 run 传递）；测试断言事件 `runId` 与期望集来源一致，不一致 → 检查拒绝执行并记 `checkFailed` |
| A6 | 重试/第二次模型请求 | 同一 run 内 attempt1 失败 → attempt2（full-history） | **两条独立事件**，`payloadVariant` 分别为 initial / continuation-rejected（或 full-history）；复盘取早于行动的最早尝试 |
| A7 | 正文在 user/tool 角色 | 目标正文只出现在 `role=user` 消息 | `presentInSystem=false` + `presentInWrongRole=true`；不得计为 system 存在 |
| A8 | 仅 PD 返回片段存在 | PD 返回 prependSystemContext 片段，但宿主最终请求未包含（构造：宿主丢弃注入块） | responses/completions 事件均 `presentInSystem=false`——**这正是当前样本期无法检测的情形，设计后可检测** |

fixture 标注：以上为**设计示例**（输入/期望的规范说明），未经批准不进入仓库测试树；实现时按 §9 转为真实测试。

## 7. 验收与结束条件

- **设计验收（本 PR 内）**：Owner 审阅七点回答 + 反例表 + 接线表，确认与 PROVIDER-EVIDENCE §3.1 边界图一致；
- **实现验收（批准后另票）**：A1–A8 fixture 全部先红后绿；生产路径冒烟（1 次真实 responses + 1 次 completions 请求产生带 `presenceCheck` 的事件）；事件体积与时延符合 §4 上限；
- **D 判定启用条件**：`presenceCheck` 事件存在 + 机会键联结成立 + 事件 ts 早于关键行动——三者齐备才可判 D=yes；任一缺失记 unknown；**记录哈希/存在性本身永不升级 confirmed/timely**；
- **回滚**：改动集中在 2 个传输文件的检查调用 + 期望集传参；revert 即移除，事件回落到现有字段（无 schema 迁移、无状态残留）；`OPENCLAW_TRAJECTORY=false` 可整体关闭落盘。

## 8. 成本

| 项 | 估算 |
|---|---|
| 开发 | 检查纯函数 + 2 个调用点 + 期望集传参 ≈ 数百行内（含测试） |
| 运行时 | 每请求 <1ms CPU、0 I/O、0 网络增量 |
| 存储 | 每请求事件 +≤1.5 KiB |
| 风险 | 传输热路径被异常打断 → 由 try/catch + 请求照发消除；无配置变更、无模型/provider 变更 |

## 9. 批准卡（一次勾选）

| 层 | 内容 | 范围 |
|---|---|---|
| L1 设计 | 本文档（七点 + 反例 + 接线） | ☐ |
| L2 宿主代码 | `@openclaw/ai` 两条传输路径的检查点 + 期望集传参；**不含** PD 写侧改动 | ☐ |
| L3 fixture | A1–A8 进入仓库测试树（先红后绿） | ☐ |
| L4 生产冒烟 | 1 responses + 1 completions 真实请求产生带 `presenceCheck` 事件；不换模型/provider、不改配置 | ☐ |

> 明确排除：census 系统、证据平台、代理服务、PD 新增存储、机会识别机制（O 的缺口只能由 controlled admission 类机会级登记解决，属另一设计）。
