# PD Adaptive Activation — 正例 / 对照臂成功与停止判据（权威澄清）

- 日期：2026-11-07
- 性质：**定义澄清**。只修正“control 臂无准入”与“必须消费准入才算成功”之间的冲突。
- 权威来源（实现真相）：`scripts/dev/aa-controlled-admission/lib/gate.mjs`
  - `evaluatePositiveGate`：13 项检查（L177-L328）
  - `evaluateControlGate`：10 项检查（L331-L384）
  - `runPositiveThenControl`：正例失败则不启动对照（L491-L515）
  - `run-experiment.mjs`：control 隔离环境不注入 admission 路径（L690-L699）
- 不改变：实验预算 caps（4 host / 5 HTTP / 2 tool / 0 paid）、已用额度（3/4/2/0）、冻结证据、历史判定。
- 本文件不启动任何运行。

---

## 1. 冲突原文与裁定

**冲突**：执行卡 §7 硬停止第 6 条把“admission 未被一次性消费”写成整轮停止条件；但对照臂按设计**不提供 admission**，因此无论对照臂跑成什么样，都会触发该条，永远无法被判定。

**裁定：该停止条件按臂限定，不是整轮无条件条件。**

| 判据 | 适用臂 | 依据 |
|---|---|---|
| `admission-consumed` / `admission-identity` | **仅正例臂** | `evaluatePositiveGate` 接收 `admission` 参数；`evaluateControlGate` 签名中**没有** `admission` |
| “对照臂无准入” | 对照臂的**定义**，不是失败 | `runControl` 的 `buildIsolatedHostEnv` 不传 `admissionPath`；端点侧用 `no-intervention` 直接验证没有指令 |
| “正例失败 → 对照不启动” | **时序规则** | `runPositiveThenControl` 在正例门禁 `!ok` 时直接返回 `stoppedAt: 'positive'` |
| “对照成功” | 对照臂自身 10 项全部 PASS | `evaluateControlGate` 的 `summarize(checks)` |

---

## 2. 正例臂（positive）

### 2.1 成功判据

必须同时满足：`evaluatePositiveGate` 的 **13 项全部 PASS**，且 `deliveryPath === 'controlled'`。

| # | 检查 id | 通过条件（严格） |
|---|---|---|
| 1 | `process` | `exitCode === 0`、`timedOut === false`、`spawnError === null` |
| 2 | `http-count` | 正例臂恰好 **2** 个 HTTP 请求 |
| 3 | `provider-anomalies` | `anomalies.length === 0` |
| 4 | `http-response` | 请求 1 = 200 + `tool_calls`；请求 2 = 200 + `stop` |
| 5 | `tool-exposure` | 每个请求都暴露完整工具定义；仅允许工具 + 固定 meta 工具 |
| 6 | `tool-permission` | 冻结策略拒绝固定 meta 工具；`dispatch_action` 只从有效 surface catalog 解析 id |
| 7 | `tool-invocation` | 本 run 正例臂恰好 1 次工具调用；名称 = `read`；端点 attempts = 1；两侧账本 id 一致；结果回传且含夹具字节 |
| 8 | `intervention` | 第一个请求 `directivesBlockPresent === true`，且 `directiveIds` 含冻结目标 id |
| 9 | `target-body` | 冻结目标**正文**（不只 id）到达**每一个**请求；normalized SHA 匹配 |
| 10 | `admission-consumed` | `consumedAt` 非空且可解析，`consumedBy.sessionId` 与 `hookInvocationId` 非空 |
| 11 | `admission-identity` | session 绑定匹配；artifact/activation；`manifestSha256` 与 plan 一致；manifest fixture 与 plan 一致；`consumedAt` 在 `createdAt` 与 `expiresAt` 之间 |
| 12 | `budget` | 正例臂 `hostTurns=1`、`httpRequests=2`、`toolCalls=1`、`paidCalls=0`，且 `withinBudget === true` |
| 13 | `model` | 每个请求 `model === local-fake-model` |

路由附加判据：`deliveryPath === 'controlled'`。若 admission 未消费但检测到 Native 投递，`deliveryPath = 'native_not_controlled'`，**不得**报告为受控成功。

### 2.2 停止判据

- **任一检查 FAIL** → `stoppedAt = 'positive'`，`stopBeforeControl = [失败项 id]`，对照臂**不启动**。
- 原始 1258 运行的历史判定保持：`stopBeforeControl = ["tool-invocation","admission-identity"]`；本文件不追认、不改写。
- 硬停止（配置/插件/清单/宿主身份不符、路径越界、环境残留可覆盖 key、额度超限、外部 provider、超时/静默回退）对正例臂同样生效。

---

## 3. 对照臂（control）

### 3.1 成功判据

必须 `evaluateControlGate` 的 **10 项全部 PASS**。

| # | 检查 id | 通过条件（严格） |
|---|---|---|
| 1 | `process` | `exitCode === 0`、`timedOut === false`、`spawnError === null` |
| 2 | `http-count` | 对照臂恰好 **1** 个 HTTP 请求 |
| 3 | `provider-anomalies` | `anomalies.length === 0` |
| 4 | `http-response` | 唯一请求 = 200 + `finishReason === 'stop'` |
| 5 | `no-tool` | 本 run 对照臂账本 `toolCalls.length === 0`，且请求未观察到工具结果 |
| 6 | `no-intervention` | 请求 `directivesBlockPresent === false` 且 `directiveIds.length === 0` |
| 7 | `budget` | 对照臂 `hostTurns=1`、`httpRequests=1`、`toolCalls=0`、`paidCalls=0`，且 `withinBudget === true` |
| 8 | `tool-exposure` | 与正例相同的完整工具定义（允许工具 + 固定 meta 工具） |
| 9 | `tool-permission` | 与正例相同的冻结工具策略 |
| 10 | `model` | 唯一请求 `model === local-fake-model` |

### 3.2 对照臂在没有准入消费时依据什么判定有效

三点，均来自代码而非约定：

1. **准入的缺席是臂的定义**：`runControl` 构造隔离环境时不传 `admissionPath`（`run-experiment.mjs#L690-L699`），因此插件不会进入受控准入路径。
2. **对照门禁不读取准入**：`evaluateControlGate` 的参数表没有 `admission`（`gate.mjs#L331-L333`），不存在 `admission-consumed` / `admission-identity` 检查。要求对照臂消费准入在实现上不可满足。
3. **“没有干预”由端点直接证明**：`no-intervention` 检查模型可见请求中的 `directivesBlockPresent === false` 且 `directiveIds.length === 0`，不依赖准入文件推断。

因此对照臂的有效性判定是：**同一宿主/配置/端点/工具暴露下，无准入、无指令、无工具、恰好一次请求且正常结束**。这是一条**负向接线对照**，不是“原则缺失导致行为差异”的因果证据。

### 3.3 停止判据

- **任一检查 FAIL** → `stoppedAt = 'control'`，该轮以 `control-gate` 失败结束。
- 对照臂**不**复查正例门禁；正例结果保持其历史状态。
- 硬停止同样适用，但 §7 第 6 条（准入未消费）**不适用于对照臂**。

---

## 4. 两类“停止”必须分开

| 说法 | 含义 | 是否可用于判定对照臂 |
|---|---|---|
| “正例失败 → 对照不启动” | `runPositiveThenControl` 的**结构时序**：正例门禁失败时根本不调用 `runControl` | 否。它不说明对照臂会失败，只说明本轮不会执行 |
| “对照门禁 FAIL” | 对照臂实际运行后 10 项中任一失败 | 是 |
| “admission 未消费” | 正例臂失败点 | 否。对照臂按设计无准入 |

**补充边界**：在原始 1258 运行上执行 control-only，属于**非成对协议**。必须标注 `control-only`，并保持正例为历史 FAIL；不得表述为“positive + control 协议通过”。

---

## 5. 对照臂能力边界（不得夸大）

- fake provider 对 control 分支**硬编码**返回 `AA-DONE`（`fake-provider.mjs#L394-L401`），因此 `returned` 是 harness 构造结果，不是模型行为结果。
- 对照任务指令与正例不同（`AA-DONE` vs 读取夹具），因此不能把两臂差异归因于原则注入。
- 当前门禁**不校验**最终答案文本是否含 `AA-DONE`；`http-response` 只校验 200 + `stop`。这是现有实现的已知限制，不在本轮扩大实现。
- 结论上限：`control = returned (harness)`，不能升级为“无原则 → 无工具”的因果结论。

---

## 6. 同步位置

| 文档 | 同步内容 |
|---|---|
| `PD-AA-PRI-1117-OWNER-DECISION-CARD-20261107.md` | §7 硬停止第 6 条按臂限定；§10 对照判据改为引用本文件；新增 control 决策价值段 |
| `PD-AA-PRI-1117-MINIMAL-BLOCKERS-20261107.md` | B2 增加“对照臂有效性依据”与 `control-only ≠ 成对协议`；N1 更新为已审计 |
| `PD-AA-G1-CONTROLLED-ADMISSION-CARD.md` | 增加适用边界注记（不改预算/授权/历史判定） |
| `aa-handoff` 新检查点 | 记录本判据与审计结论 |

---

## 7. 一句话

**正例按 13 项 + `deliveryPath=controlled` 判定；对照按 10 项独立判定，准入缺席是对照臂的定义而非失败；两者共用硬停止，但准入类判据只属于正例。**
