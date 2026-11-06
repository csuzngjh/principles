# 受控准入接线设计（仅设计，不执行）

状态：`DRAFT / NEEDS_OWNER`。本文只提交接线设计供 Owner 批准，**不包含实现、不跑宿主、不调模型、不装插件、不改生产配置**。

版本：v1.1（补充 §3.4–§3.6 的当前输入来源、单次消费、默认共享入口接线说明，并修正 §7 的关联语义；仍只设计）。

关联：PRI-1118（真实宿主证据链）、PRI-1114（行为证据读模型）、`PD-AA-G1-CONTROLLED-ADMISSION-CARD.md`（G1 已确认范围）、`PD-AA-REAL-HOST-EVIDENCE-CARD-20261106.md`（七问验证卡与证据包）。

定位：本文属于 PRI-1114 的收口文档；§3.4–§3.6 所述接线**实现**归 PRI-1118 独立推进，不在本 PR 或 PRI-1114 内编码。

---

## 1. 已核实的事实（决定设计形态）

| 事实 | 证据位置 | 对设计的影响 |
|---|---|---|
| 已安装 OpenClaw 2026.11.1 的 embedded `before_prompt_build` producer 只构造 `prompt` 与 `messages`，不传 `currentUserMessageId` | `%APPDATA%\npm\node_modules\openclaw\dist\attempt-system-prompt-prepare-F34qAuO4.mjs` 第 3943–3946 行（静态复核） | 正常入口在 embedded 场景拿不到原生消息身份，常规路径必须保持 Native |
| core 已实现受控准入校验：`admissionId` 非空、`inputSha256` 必须等于 `sha256(currentUserMessage)`、`manifestSha256` 为 64 位小写 hex、且 `currentUserMessageId` / `requestId` 必须缺省 | `packages/principles-core/src/runtime-v2/activation/adaptive-principle-intervention.ts` 第 52–59 行 | **无需新增 core 能力**；缺口是 hook 未把受控准入传进去（连接问题，不是能力缺失） |
| OpenClaw hook 的干预分支要求 `currentUserMessageId` 为非空字符串，缺省即不进入干预 | `packages/openclaw-plugin/src/hooks/prompt.ts` 第 760–763 行 | 需要一条**显式、默认关闭**的替代准入分支 |
| `controlledAdmission` 不是宿主消息 ID 或请求 ID，只是操作者对本次输入的准入声明 | `adaptive-principle-intervention.ts` 第 16–17 行注释 | 报告字段必须保持真实来源，禁止把准包装成 `requestAssociation` |
| G1 范围为无工具、仅 `127.0.0.1` 假 provider；历史两次假模型额度已用 | `PD-AA-G1-CONTROLLED-ADMISSION-CARD.md` 第 11–19 行；`PD-AA-v0.6-IMPLEMENTATION-STATUS.md`；handoff 第 47 行 | 本设计的实验预算必须重新批准，不能复用历史额度 |

结论：这是一个**接线**任务（Connection Before Creation），不是新子系统。

---

## 2. 目标与非目标

目标：

1. 在 embedded 缺原生消息身份时，用一次性冻结的准入文件完成**一次**受控干预，让“干预记录 → 工具行动”的 run 级关联可被独立复核。
2. 默认行为完全不变：未显式开启时，缺身份仍然保持 Native。
3. 准入身份与宿主身份、请求身份三条线严格分开记录。

非目标：

- 不把受控准入当作宿主原生消息 ID 或 HTTP 请求 ID；
- 不证明请求级送达、原则遵循或行为改善（这些保持 `unknown`）；
- 不新增表、队列、自动选择器、控制台或生产写入；
- 不修改 `~/.pd/runtime`、`~/.openclaw/extensions/principles-disciple` 或生产 workspace 配置（AGENTS.md §1.1）；
- 不发布、不安装、不合并。

---

## 3. 接线设计

### 3.1 最小改动面

| 文件 | 改动 | 性质 |
|---|---|---|
| `packages/openclaw-plugin/src/hooks/controlled-admission.ts`（新增） | 纯函数：读取、校验并**原子消费**准入文件，返回冻结字段或结构化拒绝原因 | 新增一个小模块；文件路径由调用方传入，无 I/O 注入问题 |
| `packages/openclaw-plugin/src/hooks/prompt.ts` | 在现有干预分支前增加一个**默认关闭**的受控准入分支（插件本地入口） | 连接现有 core 能力 |
| `packages/openclaw-plugin/src/index.ts` | 共享入口的选择阶段（`adaptivePriorityProvider`）接入同一准入判定，避免只改 `prompt.ts` 时共享路径绕过 | 连接，不改 core |
| `packages/openclaw-plugin/tests/hooks/controlled-admission.test.ts`（新增） | 单测：合法、哈希不匹配、缺字段、超限、路径不可读、会话/运行不匹配、过期、重复消费、默认关闭 | 验证真实边界 |
| `packages/openclaw-plugin/tests/hooks/prompt-*.test.ts`（增补） | 接线断言：无 `currentUserMessageId` 且未开启时不干预；开启且准入合法时传入 `controlledAdmission`；同时带 `currentUserMessageId` 时必须回退 | 真实 hook 路径 |
| `packages/openclaw-plugin/tests/**`（增补） | 共享入口：`abstraction_layer_v1` 开/关两条路径的选择阶段与干预阶段 | 真实注册路径 |

不改 `packages/principles-core`。core 的 `prepareAdaptiveIntervention` 已经覆盖校验与回退语义，重复实现会产生第二事实源（P4）。两条入口共用同一个准入加载器与同一份消费状态，只在最早的路由边界消费一次（见 §3.6）。

### 3.2 准入文件（操作者冻结，非宿主身份）

路径由环境变量 `PD_AA_ADMISSION_FILE` 指定，指向隔离目录中的单次文件；未设置即视为未开启。文件最大 16 KiB，必须是合法 JSON：

```json
{
  "schemaVersion": "pd-aa-controlled-admission/v1",
  "admissionId": "<operator-invocation-id>",
  "inputSha256": "<sha256 of the exact admitted user message bytes>",
  "manifestPath": "<absolute path to the frozen manifest in the isolated dir>",
  "manifestSha256": "<sha256 of that manifest file's exact bytes>",
  "expectedSessionId": "<OpenClaw session id this admission is bound to>",
  "expectedRunId": "<optional; required when the host provides a run id>",
  "expiresAt": "<UTC ISO; must be <= createdAt + experiment window>",
  "createdAt": "<UTC ISO>",
  "consumedAt": "<UTC ISO | null>",
  "consumedBy": { "sessionId": "<id>", "runId": "<id|null>", "invocationId": "<hookInvocationId>" }
}
```

`consumedBy` 在未消费时为 `null`。`inputSha256` 按 UTF-8 原始字节计算，不做 trim、大小写或 Unicode 归一化。

校验顺序（任一失败即回退，不重试）：

1. 环境变量未设置 → 不进入该分支（默认关闭）。
2. 当前事件已有 `currentUserMessageId` 或 `requestId` → **不使用受控准入**（core 会以 `ambiguous_admission` 回退；hook 侧也提前拒绝，避免两个身份来源并存）。
3. 文件缺失、超过 16 KiB、非 JSON、字段缺失或类型不符 → `admission_file_invalid`。
4. `inputSha256` 与当前解析后的用户正文实际哈希不一致 → `admission_input_mismatch`（正文来源见 §3.4）。
5. `manifestSha256` 与 `manifestPath` 实际字节不一致 → `admission_manifest_mismatch`。
6. `currentUserMessage` 首行不是 `[PD-AA:delivery-review:v1]` → 交给 core 场景匹配，最终为 `scene_not_matched`。
7. `expectedSessionId` 与当前 `ctx.sessionId` 不一致 → `admission_session_mismatch`。
8. `expectedRunId` 存在且宿主提供了 run id 但不一致 → `admission_run_mismatch`；宿主未提供 run id 时跳过该项（唯一性仍由消费状态保证，见 §3.5）。
9. `expiresAt` 已过期 → `admission_expired`；`consumedAt` 非空且 `consumedBy` 不属于当前 invocation → `admission_already_consumed`。

通过后，hook 以如下组合调用现有 core：

```ts
prepareAdaptiveIntervention({
  ...existingInputs,
  // 关键：不传 currentUserMessageId / requestId
  controlledAdmission: { admissionId, inputSha256, manifestSha256 },
  sessionId: ctx.sessionId,
  // 其余字段保持现状
}, deps)
```

`admissionId` 只写入实验记录，字段名明确标注 `operator_admission`，不得写入宿主 messageId 或请求 ID 字段。

### 3.3 默认关闭与不可误开

- 未设置 `PD_AA_ADMISSION_FILE`：与今天完全一致。
- 环境变量只在**隔离实验进程**中设置，不写入生产配置、不写入插件默认值、不新增持久化配置项。
- 准入文件位于隔离 workspace 的 `.tmp`，实验结束删除；不进入版本库。
- 共享入口同样默认关闭：`abstraction_layer_v1` 关闭时走本地入口；开启但未设置准入文件时，选择阶段仍返回 `undefined`，保持 Native。

### 3.4 当前输入从哪里来（embedded 无显式字段）

旧稿直接使用 `currentUserMessage`，但没有写清它在 embedded 侧从哪里来、凭什么算“本轮实际输入”。接线必须按下面的口径：

1. **唯一来源**：插件在 `prompt.ts` 第 441–442 行用 `resolveCurrentUserMessage(event, sessionId)` 得到本轮正文。embedded producer 只传 `prompt` 与 `messages`（`attempt-system-prompt-prepare-F34qAuO4.mjs` 第 3943–3946 行），因此该函数走 `event.prompt` 分支；`event.prompt` 是 OpenClaw 对本轮的模型可见输入，`event.messages` 只用于 lineage 与 turn 索引（`prompt.ts` 第 385–387 行注释）。
2. **不要再用第二个字段**：现有干预分支读 `getOwnValue(event, 'currentUserMessage')`（第 760–761 行）；embedded 侧该字段不存在，所以新分支必须使用第 1 步解析出的正文，并把**同一个字符串**传给 `prepareAdaptiveIntervention.currentUserMessage`——core 用它计算 `inputSha256`（`adaptive-principle-intervention.ts` 第 55–56 行），两者不能是两份文本。
3. **冻结正文**：隔离目录中的清单保存 `admittedText`；`inputSha256 = sha256(admittedText)`，按 UTF-8 原始字节计算，不做 trim、大小写或 Unicode 归一化。
4. **证明它就是本轮输入**（以下四条同时成立；任一不成立即回退 Native，不重试）：
   - 来源：`event.prompt` 是字符串；embedded 场景下 `event.currentUserMessage` 必须缺省（若宿主显式提供，则必须与解析结果逐字节相同，否则拒绝）；
   - 内容：`sha256(resolveCurrentUserMessage(event, sessionId).message) === inputSha256`；
   - 会话：`ctx.sessionId === expectedSessionId`；
   - 运行/消费：宿主提供 run id 时 `ctx.runId === expectedRunId`；文件未被消费（见 §3.5）。
5. **不把 `event.messages` 当正文**：不从历史消息里“找一条像输入的”，也不把最后一条 user 消息当当前输入；那会把旧消息伪装成本轮准入。

### 3.5 如何保证“只用一次”

文件哈希只证明内容一致，不能证明这是唯一一次消费。准入必须把“内容绑定”升级为“内容 + 运行绑定 + 消费状态”：

1. **绑定规则**：`admissionId` 一次性使用；`expectedSessionId` 必填并与当前会话一致；宿主提供 run id 时 `expectedRunId` 必填并必须一致。只有 session 时，消费状态本身即可阻止下一轮复用，因此不额外引入不可信的 turn ordinal。
2. **有效期**：`expiresAt` 必填，且不得晚于 `createdAt + 实验窗口`（建议 ≤ 15 分钟，覆盖单次实验外层 120 秒超时）。超过即 `admission_expired`，不延长、不重写。
3. **消费规则（先占后使用）**：hook 在调用 core **之前**先把 `consumedAt`、`consumedBy.sessionId/runId/invocationId` 写回准入文件；写入成功后才把准入交给 core。core 因任何原因回退，消费仍然有效——不重试、不二次准入。
4. **原子性**：同目录写临时文件（`*.claim.tmp`）→ `fsync` → `rename` 覆盖原文件；读取与消费在单进程内完成。进程崩溃时以磁盘文件为准：已写 `consumedAt` 即视为已消费，**禁止静默重置或自动删除**；需要重做实验时由操作者生成新的 `admissionId` 与新文件。
5. **拒绝原因**：`admission_already_consumed`（重复回调、跨 run、下一轮均命中）、`admission_expired`、`admission_session_mismatch`、`admission_run_mismatch`。任一命中均回退 Native，不写第二次干预 journal。

### 3.6 默认共享入口如何接通

真实调用链（已核实）：

1. `packages/openclaw-plugin/src/index.ts` 在 `before_prompt_build` 注册处按 `runtimeGateFor(workspaceDir)` 分流（第 503–506 行）；`runtimeGateFor` 缓存 `shouldUseSharedHostRuntime` 的结果，后者只由 `features.abstraction_layer_v1.enabled` 决定（第 147–159、325–336 行）。
2. 共享开启 → `sharedHostRuntime.dispatchBeforePromptBuild(event, hookContext)`（`host-runtime/openclaw-host-runtime.ts` 第 190–197 行）→ `createProductionHostRuntime`（第 111 行起）→ `buildActivePrinciplePromptContext`（`host-runtime/src/index.ts` 第 235 行起）→ `options.beforePromptBuild(event, prompt)`（第 421–425 行）。
3. 共享关闭 → `handleBeforePromptBuild(event, { ...hookContext, api })`（`index.ts` 第 506 行）。

关键事实：共享路径**不会绕过** `handleBeforePromptBuild`——它在 `index.ts` 第 389–393 行仍回调同一个插件本地处理器。但它会在更早的选择阶段被另一个门挡住：`adaptivePriorityProvider`（第 361–388 行）要求 own-property `currentUserMessageId` 为非空字符串（第 371–373 行）；embedded 没有该字段，因此共享路径直接返回 `undefined`，`adaptivePacking` 不会产生，`handleBeforePromptBuild` 也就拿不到 target。

因此只改 `prompt.ts` 不够，接线必须同时覆盖两个点：

- **选择点**：`index.ts` 的 `adaptivePriorityProvider` 在受控准入合法时返回 `artifactId / activationId / hookInvocationId`，使共享路径产生 `adaptivePacking`；
- **干预点**：`prompt.ts` 的干预分支在准入合法时传入 `controlledAdmission`（且不传 `currentUserMessageId / requestId`）；
- **只消费一次**：准入判定与消费在路由边界统一完成一次（§3.5），两个点共用同一份结果；同一准入的第二次回调直接 `admission_already_consumed`。

测试点（两个 `runtimeGate` 状态都必须覆盖）：

| 入口 | 用例 | 期望 |
|---|---|---|
| 本地（`abstraction_layer_v1` 关闭，默认） | 无准入文件 | 不干预，保持 Native |
| 本地 | 准入合法 | `prepareAdaptiveIntervention` 收到 `controlledAdmission`，且未收到原生 ID |
| 本地 | 同时有 `currentUserMessageId` | 提前拒绝；core 记录 `ambiguous_admission` |
| 共享（`abstraction_layer_v1` 开启） | 无准入文件 | `adaptivePriorityProvider` 返回 `undefined`，保持 Native |
| 共享 | 准入合法 | provider 返回 target；`beforePromptBuild` 走准入分支并只消费一次 |
| 共享 | 同一准入第二次回调 / 下一轮 | `admission_already_consumed`，不产生第二次干预 |

---

## 4. 环境隔离

| 项 | 要求 |
|---|---|
| 配置 | 独立 `config.yaml`（隔离目录），`workspace.default` 指向隔离 workspace |
| 状态 | 独立 `state.db` 与 `.pd/`，不连接生产库 |
| workspace | 独立目录，不包含 Owner 真实数据；只放实验夹具 |
| provider | 仅 `127.0.0.1` 本地假 provider；`paidCalls=0` |
| 宿主 | 已安装 OpenClaw 2026.11.1，但只以隔离 workspace/config 启动 |
| 插件 | 使用仓库构建产物，经官方装载路径注册；**禁止**复制 `dist/` 覆盖安装目录 |
| 并发 | 单进程、单会话；不与其他 Agent 并行写同一 checkout |

---

## 5. 预算（三个独立口径，互不推导）

| 口径 | 上限 | 分配与说明 |
|---|---|---|
| 宿主回合数 | **2** | 1 正例（含 1 次只读工具）+ 1 Native 对照（无工具）。一次宿主回合可以包含多个模型请求。 |
| HTTP 请求数 | **3** | 正例最多 2（第一次模型请求决定工具调用，工具结果回传后需要第二次模型请求）；对照 1。请求计数由本地端点独立记录。 |
| 工具调用次数 | **1** | 仅正例，只读工具；对照 0。工具结果不得触发额外回合。 |
| 付费模型调用 | **0** | 假 provider，不产生费用。 |

三个口径彼此自洽：2 个宿主回合最多产生 3 次 HTTP 请求和 1 次工具调用；任一口径超限即停止，不用“回合数还有余量”解释超出的请求数。

超时：配置预检 25 秒、宿主外层 120 秒、Agent 45 秒。

---

## 6. 停止条件

只在**本次必须确认的运行身份或工具行动缺证**时停止：

- `hookInvocationId`、`sessionId`、`runId` 缺失、冲突或无法唯一匹配；
- 正例中工具行动没有出现在 journal / EventLog 中，或无法与该 run 关联；
- 准入文件与冻结输入/清单哈希不一致（身份不可信）；
- HTTP 请求数超过 3、工具调用超过 1、付费调用大于 0；
- journal 不可读、端点不可用、非预期工具错误、超时。

以下**不构成停止理由**（属设计预期）：

- 请求级关联 `requestAssociation = unknown`；
- 送达时序 `ordering = unknown`；
- 原则遵循 `principleAdherence = unknown`；
- 行为改善 `behaviorImprovement = unknown`；
- 任务结果只读到“模型输出完成记录”（`taskSuccess = unknown`）。

停止后不重试、不放大时间窗口、不追加回合；保留失败分母。

---

## 7. 关联语义（与读模型代码一致）

- **运行关联可信**：journal 中该 `hookInvocationId` 唯一，`sessionId + runId` 一致且在 run 内唯一匹配，且 journal 读取范围完整（`journalRangeComplete`）→ `strong_run`。
- **行为来源截断 ≠ journal 不完整**：corrections / outcomes / weakCandidates 的单会话行截断、总轨迹上限或日期范围裁剪只影响 `facts` 与 `coverage.complete`，不参与 `journalRangeComplete`，因此不会把 `strong_run` 降级；此时只标注行为记录不完整（是下界）。
- **journal 自身不完整或唯一性无法证明** → `unknown`：journal coverage 非 `complete`、`truncation.omitted > 0`、`outputTruncated`、malformed / invalid envelope / invalid records 任一大于 0；身份缺失；open/terminal 记录重复；`targetIdentityUnproven`；open 与 terminal 配置身份不一致。open/terminal 在范围内不可见时，身份有效为 `weak`，否则 `unknown`。
- 同一 run 多次干预 → `ambiguous`；open/terminal 分类冲突 → `conflict`。

报告中三件事分开写：运行关联、行为记录完整性、能/不能得出的结论。

---

## 8. 清理与回滚

1. 实验结束终止宿主进程树，`finally` 关闭本地端点并删除准入文件。
2. 保留 `.tmp` 原始证据（journal、端点请求计数、宿主 stdout/stderr 摘要），不删除共享状态。
3. 不修改生产配置、生产 workspace、安装目录。
4. 回滚：删除 `PD_AA_ADMISSION_FILE` 环境变量即恢复默认 Native；代码分支默认关闭，无需回滚 SQL 或数据。

---

## 9. 验证计划（获批后才执行）

| 层 | 内容 | 通过标准 |
|---|---|---|
| 单元 | 准入加载器：合法、哈希不匹配、缺字段、超 16 KiB、不可读、默认关闭、会话/运行不匹配、过期、重复消费 | 每条都有明确原因码，无静默通过 |
| 接线（本地） | `abstraction_layer_v1` 关闭：无原生 ID + 未开启 → 不干预；开启 + 合法 → 传入 `controlledAdmission`；同时有原生 ID → 回退 | 断言实际调用参数与回退原因 |
| 接线（共享） | `abstraction_layer_v1` 开启：选择阶段准入合法 → provider 返回 target；干预阶段只消费一次；第二次回调 → `admission_already_consumed` | 两条入口行为一致，无重复干预 |
| 夹具 | 合成 journal + `pd activation link` 读链 | `strong_run`、行为事实齐全、四层声明边界正确 |
| 隔离宿主 | 正例 1 + 对照 1，假 provider | 预算不超、身份与工具行动可关联、结论分级正确 |
| 门禁 | lint、typecheck、host-runtime / pd-cli 测试、`check:runtime-contract`、release-intent | 全绿，不跳过 |

验证只证明“接线可用 + run 级关联可复核”，不证明真实模型送达或行为改善。

---

## 10. 风险与未决

| 风险 | 处理 |
|---|---|
| 准入文件被误认为宿主身份 | 字段命名与报告分层强制区分；core 已拒绝与原生 ID 并存 |
| 环境变量泄漏到生产进程 | 只在隔离进程设置；不写入配置；默认关闭 |
| 假 provider 结果被当作真实行为证据 | 证据包 `model.localFakeProvider=true`、`paidCalls=0`，结论分级明确 |
| 一次实验成功被过度概括 | 报告只声明本次 run 级关联；不声明通用选择或长期收益 |
| hook 改动影响正常路径 | 分支默认关闭 + 原生 ID 优先 + 同时存在即回退 + 现有测试全量复跑 |

未决（需 Owner 决定）：

1. 是否批准按 §3 的接线实现（含 §3.4–§3.6 两个入口接线；默认关闭、无新增持久化配置、不改 core）。
2. 是否批准 §5 的预算（2 宿主回合 / 3 HTTP 请求 / 1 只读工具 / 0 付费调用）。
3. 是否批准 §4 的隔离环境与 §8 的清理方式。
4. 是否批准在获批后执行一次隔离宿主正例 + 一次对照。

在上述四项获批前，不写接线代码、不跑宿主、不装插件。
