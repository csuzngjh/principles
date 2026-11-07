# PD Adaptive Activation — M2 离线调查（PRI-1117 后续）

- 日期：2026-11-07
- 范围：仅使用既有原始资产与代码，**未启动宿主回合、未调用模型、未重跑 positive**
- 前置：[PRI-1117 独立审查](PD-AA-PRI-1117-INDEPENDENT-REVIEW-20261107.md)、[最小阻断清单](PD-AA-PRI-1117-MINIMAL-BLOCKERS-20261107.md)
- 原始 run：`D:\Code\_worktrees\principles\PRI-1118-controlled-admission-impl\artifacts\aa-controlled-admission\aa-run-20261106T1258Z\`（只读，未修改）

---

## 1. 证据来源

| 类别 | 资产 | 性质 |
|---|---|---|
| 冻结输入 | `input.txt` | 原始资产，SHA-256 `458dac4f7d14…`，242 字节 |
| 宿主编译/提交 | `trajectory_runtime_events.seq=3`（`context.compiled` / `prompt.submitted`） | 原始 SQLite 记录（隔离 workspace，只读连接） |
| 宿主模型完成 | `trajectory_runtime_events.seq=6`（`model.completed`，含 `messagesSnapshot`） | 同上 |
| 宿主工具事件 | `trajectory_runtime_events.seq=4/5`（`tool.call` / `tool.result`） | 同上 |
| 宿主事件日志 | `positive/workspace/.state/logs/events_2026-11-06.jsonl` | 原始日志 |
| 端点观测 | `evidence/positive.endpoint-requests.json`（`http-003` / `http-004`） | fake provider 原始记录 |
| 运行账本 | `run-record.json` | 派生账本（与原始资产可交叉核对） |
| 夹具 | `positive/workspace/fixture.txt` | 原始资产，SHA-256 `e27b4775…` |

时间均为 UTC，来自同一台机器上的两个记录器（端点 HTTP server 与宿主进程）。

---

## 2. 身份映射裁定：`call1` 与 `call_1`

### 2.1 已知事实（逐条）

| # | 事实 | 来源 |
|---|---|---|
| E1 | 宿主 `messagesSnapshot[2]` 的 assistant tool call id = **`call_1`**，name = `read`，arguments 对象 `{path: <隔离 workspace 绝对路径>/fixture.txt}` | `trajectory seq=6` |
| E2 | 宿主工具事件 id = **`call_1`**，name = `read`，args 同一路径；随后 `tool.result` id = **`call_1`**，content = 夹具全文 | `trajectory seq=4/5`；`events_2026-11-06.jsonl` |
| E3 | 宿主 `toolCallIdRef` = `74196fe72e4c`，且 `sha256("call_1")[:12] = 74196fe72e4c`（`hashRef` 定义见 `packages/host-runtime/src/adaptive-behavior-linkage.ts#L610`）；`sha256("call1")[:12] = 78d66c1f79db`，不相等 | 计算 + 代码 |
| E4 | 端点 `http-004` 请求内 assistant tool call id = **`call1`**，name = `read`，`argumentsSha256 = 7447f13a…` | `positive.endpoint-requests.json` |
| E5 | `sha256(JSON.stringify({path: <同一绝对路径>})) = 7447f13a…`，与 E4 **逐字节相等** | 离线重算（4 种编码候选，仅单层转义命中） |
| E6 | 该对话中 assistant tool call **仅出现一次**（快照 1 条、端点 attempts 1 条、宿主 `tool.call` 1 条），name 均为 `read` | 三方交叉 |
| E7 | 工具结果 `toolMessageSha256 = e27b4775…` = `fixture.txt` SHA-256；`toolResultContainsFixture=true` | 端点记录 + 夹具哈希 |
| E8 | 时间链：端点收 `http-003` `13:00:06.313` → 宿主 `tool.call` `13:00:06.373` → `tool.result` `13:00:06.651` → 端点收 `http-004` `13:00:06.708` → `model.completed` `13:00:06.792` | 两个独立记录器 |

### 2.2 裁定

**同一次调用：成立（高置信）。** 依据是内容与结构的联合约束，而不是字符串相等：

1. 参数**逐字节相同**（E5，endpoint digest 与宿主 args 的规范序列化完全一致）；
2. 工具名相同（`read`）；
3. 全对话**唯一**一次工具调用（E6）；
4. 工具结果内容等于夹具全文（E7）；
5. 五段时间戳单调且落在同一秒内（E8）。

**ID 字符串相等：不成立。** `call1` ≠ `call_1`，且 `call_1` 的 hashRef 与 `call1` 的 hashRef 不同（E3）。

**改名发生在哪里：只可能是宿主/Provider 的 OpenAI 兼容序列化层。** 宿主内部表示与事件日志都是 `call_1`（E1–E3），端点收到的是 `call1`（E4）。仓库内检索未发现把 `call_1` 改写为 `call1` 的代码；该转换位于 OpenClaw/Provider 客户端，**其实现不在本仓库可观察范围内**。

**因此：不得以 “去掉下划线后相等” 作为证据。** 正确记法是“同一调用，两个视图 ID 不同，映射依据为内容/名称/唯一性/时间”，并显式标注 `idEquality: not_proven`。

---

## 3. 顺序裁定：请求与关键行动

### 3.1 已知事实

- 含目标正文的请求 `http-003` 于 `13:00:06.313` 到达端点；该请求的 system prompt 含目标指令 id，target-body 检查 PASS。
- 宿主 `tool.call` 于 `13:00:06.373` 发生（请求之后 60ms），`tool.result` 于 `13:00:06.651` 完成。
- 携带工具结果的第二次请求 `http-004` 于 `13:00:06.708` 到达端点。
- 端点对两个请求的 user message digest 相同（`77f64517a091…`），说明对话上下文一致。

### 3.2 裁定

**在本会话内，“含目标的请求 → 关键行动 → 结果回传”的顺序成立。** 两个独立记录器（端点接收时间、宿主轨迹事件）给出一致且单调的序列。

**限制（必须同时报告）：**

1. 两个记录器共用同一机器时钟，**没有共享的 request/message ID**，因此这是“时间 + 内容 + 唯一性”的顺序，不是密码学绑定的顺序；
2. 能证明“目标正文在行动前的请求中”，**不能证明模型“读到并采用了”**目标（注意力不可观测）；
3. 端点 `receivedAt` 是服务端接收时间，不是模型开始生成时间；二者在本 run 中相差毫秒级，但语义不同；
4. 若任一记录器缺失时间戳，顺序必须保持 `unknown`，不得用另一侧补齐。

**结论：`timely` 在 1258 上可以由现有离线资产支持，但前提是门禁显式读取宿主工具事件并写入上述顺序字段，且接受“同一机器时钟、无共享 ID”的限制。** 该结论不依赖任何新宿主调用。

---

## 4. 原在线失败的真正原因（解释，不重写历史）

`run-record.json` 记录的原始判定保持有效：positive 失败，`stopBeforeControl = ["tool-invocation","admission-identity"]`，control 从未执行。**本次不修改该历史判定。** 但离线核对显示，两项失败均可由当时的门禁语义解释：

| 检查 | 记录中的证据 | 解释 |
|---|---|---|
| `tool-invocation` | 失败证据的 `toolCalls` 同时含 `tool-001`（`runId=aa-run-20261106T1105Z`）与 `tool-002`（`runId=aa-run-20261106T1258Z`） | 当时门禁把**累计账本**当成单臂证据：要求“恰好一次”却看到两次（1105 + 1258）。该 run 本身确实只调用了一次 `read`。当前 main 的门禁已按 `runId` + `arm` 过滤（`gate.mjs#L148-L153`）。 |
| `admission-identity` | `fixtureRef: null`，`expectedSessionId: null` | 当时门禁要求 admission 文档携带 `fixtureRef`，而 `AdmissionDocument` 不保留该字段。当前 main 改为经 manifest 绑定夹具身份并解释该历史限制（`gate.mjs#L272-L280`）。 |

时间线佐证：run 发生于 `2026-11-06T13:00Z` 前后；修正提交 `c6d1dc8d8`（“scope tool-call evidence to the current run and bind fixture identity through the manifest”）时间戳为 `21:04 +0800`（= `13:04Z`）；PR #2389 合并于 `21:43 +0800`（= `13:43Z`）。即：**失败发生在修正之前，修正在同一 PR 内、合并之前完成。**

**所以：原失败是门禁取证缺陷，不是“没有发生工具调用”或“身份不匹配”。** 但历史判定仍按原样保留，事后离线 13/13 不追认原 run 为通过。

---

## 5. 门禁最小实现方案（仅方案，本轮未实施）

目标：让门禁真实检查“含目标请求 → 关键行动”的顺序，并且**不要求跨视图 ID 相等**。

### 5.1 需新增采集/读取的字段

| 字段 | 来源 | 用途 |
|---|---|---|
| `requestWithTargetAt` | 端点 `receivedAt`（target-body PASS 的那次请求） | 顺序起点 |
| `nextRequestAt` | 端点下一次 `receivedAt` | 顺序终点 |
| `hostToolCallAt` | `events_*.jsonl` 的 `tool_call` 事件 | 行动时间 |
| `hostToolResultAt` | `tool_result` 事件 | 行动完成 |
| `hostToolCallId` | 同上（`call_1`） | 宿主视图 ID |
| `requestViewToolCallId` | 端点 attempts（`call1`） | 端点视图 ID |
| `requestViewArgumentsSha256` | 端点 attempts | 与宿主 args 规范序列化比对 |
| `idEquality` | 计算 | `proven` / `not_proven` |
| `idBasis` | 计算 | `arguments` / `name` / `uniqueness` / `timeWindow` |

### 5.2 顺序检查（建议命名为 `request-action-order`）

按 `runId + arm` 过滤后：

1. 本臂恰好 1 条 `tool_call` 与 1 条 `tool_result`；否则 `unknown`。
2. `tool_call.name` 在允许集合内。
3. `sha256(canonical(hostArgs)) === requestViewArgumentsSha256`；不等则不得声称同一调用（记为 `mismatch`，不改写 digest）。
4. `requestWithTargetAt < hostToolCallAt < hostToolResultAt < nextRequestAt`。
5. `hostToolCallId` 与 `requestViewToolCallId` **分别记录**；字符串不等时 `idEquality=not_proven`，但**不判失败**（由 1–4 支撑同一调用）。
6. 任一字段缺失 → `ordering=unknown`，`timely` 不得升级。

### 5.3 最小验收

- 用 1258 现有资产离线运行该检查：期望 `ordering=PASS`、`idEquality=not_proven`、`sameInvocation=established-by-content`。
- 用 1105 资产反例：若缺少宿主工具事件或时间戳，必须返回 `unknown` 而非 PASS。
- 不新增字段来源、不引入新持久层、不改预算与冻结证据。

---

## 6. 仍未知

- `call_1 → call1` 的具体转换代码与触发条件（位于宿主/Provider 层，仓库外）。
- 端点本地是否存在可关联的 request/message ID（当前记录中没有）。
- 模型是否实际使用了目标正文（不可观测，不属 G1）。
- 两个记录器是否存在时钟漂移（本 run 未测量；仅能给出同机假设）。

---

## 7. 对 B1 的修订

- **原表述**：“M2 阻断 G1 timely 签收，需离线补齐。”
- **修订后**：M2 的**证据已足够**支持“同一调用 + 可信顺序”，但门禁**没有读取宿主工具事件**、也没有记录两个视图的 ID 与依据。阻断点是**门禁取证缺口**，不是事实缺口；可在现有资产上离线闭合，**不需要新宿主回合**。
- **符号级 ID 相等**仍为 `not_proven`，必须写入声明边界；不得用归一化宣称已证明。
