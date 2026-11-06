# 受控准入接线设计（仅设计，不执行）

状态：`DRAFT / NEEDS_OWNER`。本文只提交接线设计供 Owner 批准，**不包含实现、不跑宿主、不调模型、不装插件、不改生产配置、不发版**。

版本：**v1.2**（2026-11-06）。相对 v1.1 一次补齐三个设计缺口：§3.4 本轮输入可信来源、§3.5 一次性与重放边界、§3.6 默认共享入口接线；§5–§6 冻结验证语义、预算与实验协议；§3.6.6 比较原生 harness 入口。

基线：`origin/main` = `a902255e1758efa36e48adbc08c0bbea1b4f7741`（本文修订时实时核实）。历史事实：PR #2380（PRI-1114 截断修复）已合并为 `fda71df92`；PR #2384（v1.1 文档补充）已合并为 `6733497ac`；两者均不再处于 OPEN。历史宿主版本、已安装版本与两次实验额度按已消耗处理，不在本文复用。

关联：PRI-1118（受控准入接线实现）、PRI-1116（C01–C09 验收证据）、PRI-1114（行为证据读模型，已收口）、`PD-AA-G1-CONTROLLED-ADMISSION-CARD.md`（G1 历史范围）、`PD-AA-REAL-HOST-EVIDENCE-CARD-20261106.md`（七问验证卡与证据包）、`PD-AA-C01-C09-ACCEPTANCE-MATRIX-20261106.md`（验收矩阵）。

---

## 1. 已核实的事实（决定设计形态）

| 事实 | 证据位置 | 对设计的影响 |
|---|---|---|
| 已安装 OpenClaw 2026.11.1 的 embedded `before_prompt_build` producer 只构造 `prompt` 与 `messages`，不传 `currentUserMessageId` | `%APPDATA%\npm\node_modules\openclaw\dist\attempt-system-prompt-prepare-F34qAuO4.mjs` 第 3943–3946 行（静态复核） | embedded 正常入口拿不到原生消息身份；常规路径必须保持 Native |
| `resolveCurrentUserMessage(event, sessionId)` 从 `event.prompt` 解析，并会剥离 boot check / Feishu wrapper | `packages/openclaw-plugin/src/hooks/prompt.ts` 第 441–442 行；解析函数位于同文件上半部 | 解析结果是**派生正文**，不能直接当作“本轮实际提交字节”的证明 |
| 插件本地干预分支要求 own-property `currentUserMessage` 与 `currentUserMessageId`，缺省即不进入干预 | `prompt.ts` 第 760–763 行 | embedded 需要一条显式、默认关闭的替代准入分支 |
| 共享选择阶段 `adaptivePriorityProvider` 同样要求 own-property `currentUserMessageId` 非空，否则返回 `undefined` | `packages/openclaw-plugin/src/index.ts` 第 361–388 行（门在 371–373） | 只改 `prompt.ts` 时共享派发仍会绕过干预；必须同时改选择点 |
| 共享路径最终仍回调同一个插件处理器 | `index.ts` 第 389–393、503–506 行；`src/host-runtime/openclaw-host-runtime.ts` 第 190–197 行；`packages/host-runtime/src/index.ts` 第 235、421–425 行 | 两个入口汇聚在 `handleBeforePromptBuild`，但选择阶段不同 |
| core 已实现受控准入校验：`admissionId` 非空、`inputSha256 == sha256(currentUserMessage)`、`manifestSha256` 为 64 位小写 hex、原生 `currentUserMessageId/requestId` 必须缺省 | `packages/principles-core/src/runtime-v2/activation/adaptive-principle-intervention.ts` 第 52–59 行 | **无需新增 core 能力**；缺口是 hook 未把受控准入传入（连接问题） |
| 插件源码中没有任何调用点传入 `controlledAdmission` | `prompt.ts` 第 773 行的 `prepareAdaptiveIntervention` 参数 | 设计与实现之间唯一的连接缺口，属 PRI-1118 范围 |
| 共享/本地入口由 `features.abstraction_layer_v1.enabled` 决定 | `index.ts` 第 147–159 行；`shouldUseSharedHostRuntime` | 两条入口都必须覆盖，且默认关闭 |
| 读模型区分“运行关联可信”与“行为记录完整” | `packages/host-runtime/src/adaptive-behavior-linkage.ts` 第 834–842、844–893 行 | §5.2 冻结语义必须以代码行为为准 |
| 历史两次获准宿主调用已消耗，且两次均未取得目标送达确认 | `PD-AA-v0.6-IMPLEMENTATION-STATUS.md` 第 40–49 行；`PD-AA-LOCAL-AGENT-HANDOFF.md` 第 47 行 | 任何新宿主回合都必须取得新的有界批准，不能引用旧额度 |

结论不变：这是**接线任务**（Connection Before Creation），不是新子系统。

---

## 2. 目标与非目标

目标：

1. 在 embedded 缺原生消息身份时，用**一次性冻结输入 + 操作者准入**完成一次受控干预，使“干预记录 → 一条只读工具行动”的 run 级关联可被独立复核。
2. 默认行为完全不变：未显式开启时，缺身份仍然保持 Native，且 Native 基线字节不变。
3. 操作者准入、宿主身份、端点请求身份三条线严格分开记录，任何一条都不能包装成另一条。
4. 冻结本次实验的验证语义与预算，使 Owner 可以一次批准“按该版本实现并在指定检查通过后执行该预算内实验”。

非目标：

- 不把受控准入当作宿主原生消息 ID 或 HTTP 请求 ID；
- 不证明请求级送达、原则遵循、任务成功或行为改善（这些保持 `unknown`）；
- 不新增表、队列、长期状态、自动选择器、控制台或生产写入；
- 不修改 `~/.pd/runtime`、`~/.openclaw/extensions/principles-disciple` 或生产 workspace 配置（AGENTS.md §1.1）；
- 不发布、不安装、不合并、不切换研究目标或宿主模式（harness 切换的比较见 §3.6.6，需 Owner 另行决定）。

---

## 3. 接线设计

### 3.1 最小改动面与唯一写者

| 文件 | 改动 | 性质 |
|---|---|---|
| `packages/openclaw-plugin/src/hooks/controlled-admission.ts`（新增） | 读取、校验、**原子消费**准入；持有最小进程内 claim 缓存 | 新增一个小模块；准入状态的**唯一写者** |
| `packages/openclaw-plugin/src/hooks/prompt.ts` | 本地入口消费准入；共享入口读取 claim；把 `controlledAdmission` 与**精确正文**传给 core | 连接现有 core 能力 |
| `packages/openclaw-plugin/src/index.ts` | 共享选择阶段 `adaptivePriorityProvider` 接入同一准入判定并完成唯一一次消费 | 防止默认共享派发绕过 |
| `packages/principles-core/src/runtime-v2/activation/adaptive-principle-intervention.ts` | 把已有的准入校验提取为可复用纯函数并导出；`prepareAdaptiveIntervention` 继续调用它 | 去除第二事实源（P4）；行为不变 |
| `packages/openclaw-plugin/tests/hooks/controlled-admission.test.ts`（新增） | 单测：合法、哈希不匹配、缺字段、超限、路径越界/符号链接、过期、重复消费、默认关闭、并发 claim | 验证准入边界 |
| `packages/openclaw-plugin/tests/hooks/runtime-v2-prompt-activation.test.ts`（增补） | 真实本地入口正反例：无准入保持 Native；合法准入传入 core；有原生 ID 时拒绝 | 真实 hook 路径 |
| `packages/host-runtime/tests/production-host-runtime.test.ts`（增补） | 共享生产 dispatch：provider 在无原生 ID 时仍能由准入返回 target；第二次回调不重复 | 真实注册路径 |

不改 core 的干预语义、不改 journal schema、不改读模型。`controlled-admission.ts` 是准入文件 `consumedAt/consumedBy` 与进程内 claim 的唯一写者；`prompt.ts` 与 `index.ts` 只调用它，不各自维护第二份状态。

### 3.2 冻结输入、清单与准入文件

三个文件全部位于隔离实验根 `<experimentRoot>`（绝对路径，启动前由控制器写入）：

| 文件 | 上限 | 作用 |
|---|---|---|
| `input.txt` | 16 KiB | 本轮**精确输入正文**的原始字节；唯一正文来源 |
| `manifest.json` | 64 KiB | 冻结清单：目标原则、来源、夹具、预期行动、配置身份 |
| `admission.json` | 16 KiB | 操作者准入声明：绑定上述两个文件的哈希与路径 |

`admission.json`（`schemaVersion: "pd-aa-controlled-admission/v2"`）：

```json
{
  "schemaVersion": "pd-aa-controlled-admission/v2",
  "admissionId": "<operator-admission-id>",
  "operator": "<owner-or-operator-id>",
  "purpose": "<one-line experiment purpose>",
  "experimentRoot": "<absolute isolated root>",
  "inputPath": "<absolute path under experimentRoot>/input.txt",
  "inputSha256": "<sha256 of exact UTF-8 bytes>",
  "manifestPath": "<absolute path under experimentRoot>/manifest.json",
  "manifestSha256": "<sha256 of exact UTF-8 bytes>",
  "targetArtifactId": "<Runtime V2 artifact id>",
  "targetActivationId": "<Runtime V2 activation id>",
  "mappingSha256": "<sha256 of canonical mapping fields>",
  "sessionBinding": "predeclared | first_consumer",
  "expectedSessionId": "<required iff predeclared, else null>",
  "createdAt": "<UTC ISO>",
  "expiresAt": "<UTC ISO; <= createdAt + 15 minutes>",
  "consumedAt": "<UTC ISO | null>",
  "consumedBy": { "sessionId": "<id>", "runId": "<id|null>", "hookInvocationId": "<id>" }
}
```

`manifest.json` 至少包含：`targetArtifactId`、`targetActivationId`、`sourceRef`（Runtime V2 activation/artifact 的读入口）、`fixtureFile`（绝对路径）、`fixtureSha256`、`expectedToolName`、`expectedContentMarker`、`configSnapshot`（host/plugin/config 文件的路径与哈希）。清单是冻结记录，不是运行时配置。

校验顺序（任一失败即回退 Native，不重试）：

1. `PD_AA_ADMISSION_FILE` 或 `PD_AA_EXPERIMENT_ROOT` 未设置 → 不进入该分支（默认关闭）。
2. 当前事件已有 `currentUserMessageId` 或 `requestId` → 不使用受控准入（两个身份来源不得并存）。
3. 路径越界：`inputPath` / `manifestPath` / admission 自身不在 `experimentRoot` 的 realpath 之下，或任一为符号链接 → `admission_path_outside_root`。
4. 文件缺失、超过上表上限、非 JSON、字段缺失或类型不符 → `admission_file_invalid`。
5. 实际读取 `input.txt` 的字节哈希 ≠ `inputSha256` → `admission_input_mismatch`。
6. 实际读取 `manifest.json` 的字节哈希 ≠ `manifestSha256` → `admission_manifest_mismatch`。
7. 清单中的 `targetArtifactId/targetActivationId` 与准入不一致，或与当前 mapping 不一致 → `admission_target_mismatch`。
8. `mappingSha256` 与当前 mapping 规范化哈希不一致 → `admission_mapping_mismatch`。
9. `sessionBinding=predeclared` 且 `ctx.sessionId != expectedSessionId` → `admission_session_mismatch`；`first_consumer` 时在消费处记录首个 session。
10. `expiresAt` 已过期 → `admission_expired`；`consumedAt` 非空 → `admission_already_consumed`。
11. 正文证明失败（见 §3.4）→ 对应 `admission_*` 原因，不进入 core。

`mappingSha256` 的规范化对象：`{workspaceRealPath, artifactId, activationId, softTimeoutMs, expiresAt}` 的键序固定 JSON 后取 SHA-256。它绑定“准入只授权当前 workspace 下这一条 mapping”。

### 3.3 默认关闭与不可误开

- 两个环境变量只在**隔离实验进程**中设置，不写入生产配置、不写入插件默认值、不新增持久化配置项。
- 任一未设置：与今天完全一致（缺原生身份 → Native）。
- 准入/清单/输入位于隔离 workspace 的 `.tmp/aa-experiment/<run>/`，实验结束按 §6.7 处理，不进入版本库。
- 共享入口同样默认关闭：`abstraction_layer_v1` 关闭时走本地入口；开启但无准入时，provider 返回 `undefined`，保持 Native。

### 3.4 缺口一：本轮输入的可信来源

#### 3.4.1 控制器与“精确字节”提交

本轮输入不是由插件拼接，也不是从 `event.messages` 历史里挑选。控制器是仓库内的实验 launcher（PRI-1118 实现，运行于隔离 worktree）：

1. 把本轮正文一次性写入 `<experimentRoot>/input.txt`（UTF-8，无尾随改写），计算 `inputSha256`。
2. 写入 `manifest.json` 与 `admission.json`，计算两个哈希。
3. 通过**官方支持的宿主入口**把该文件作为本轮消息提交：优先使用已有的 `openclaw agent exec --message-file <绝对路径>` 形式（`scripts/dev/principle-learning-lab/lib/challenge-openclaw-host.mjs` 已用该参数传输精确文件字节）；若该入口不可用，必须使用同一宿主提供的、能按文件字节提交的文档化参数，并在证据中记录实际命令行与参数。禁止用 shell 字符串拼接、禁止把多轮历史拼成 prompt。
4. launcher 记录：`argv`、cwd、`experimentRoot`、输入/清单/准入三个哈希、宿主与插件加载路径、配置哈希。
5. launcher 不向 `input.txt` 追加标记之外的任何内容；[PD-AA:delivery-review:v1] 若是场景信号，必须由操作者写进冻结正文，而不是由插件注入。

如果该官方入口在 P0 预检中不能证明会把文件字节作为当前用户输入提交，**停止**，不换用拼接 prompt，也不临时改宿主模式。

#### 3.4.2 插件侧证明（两条同时成立）

在 `prompt.ts` 的准入分支：

1. **原始字节证明**：`event.prompt` 必须是字符串，且 `sha256(event.prompt) === inputSha256`。这条直接对“宿主交给模型的当前输入”取哈希，任何 wrapper、前缀、历史拼接都会导致不匹配。
2. **解析一致性证明**：`resolveCurrentUserMessage(event, sessionId).message === admittedText`（逐字节）。现有解析会剥离 wrapper，若二者不等，说明 `event.prompt` 不是干净的本轮正文 → 拒绝。
3. 通过后，把 `event.prompt`（而非解析后的派生串）作为 `currentUserMessage` 传给 core；core 重新计算 `sha256(currentUserMessage)` 并与 `inputSha256` 比对，形成第二道独立校验。
4. `event.messages` 只作为 lineage/turn 索引，**不参与**正文判定；不从历史中“找一条像输入的”。

#### 3.4.3 端点侧证明（传输事实）

本地假 provider 在收到 HTTP 请求时记录：

- `endpointRequestId`（端点自增序号，如 `ep-001`，仅标识端点收到的请求）；
- `receivedAt`、`bodySha256`、`userMessageSha256`（从请求体解析出的用户消息字节）、`model`、`status`；
- 若请求体结构无法可靠定位用户消息：记 `userMessageSha256: null`，该事实为 `unknown`，不得猜测。

`userMessageSha256 === inputSha256` 是“宿主确实把该正文送进请求”的**传输证据（L1）**。它不等于宿主 `requestId`，也不能把 run 级关联升级为请求级关联。

#### 3.4.4 绑定关系

| 被绑定项 | 绑定到 | 失败处理 |
|---|---|---|
| 输入正文 | `inputSha256`（准入 + 清单） | 任一哈希不符 → 拒绝 |
| workspace | `experimentRoot` realpath + `mappingSha256` | 越界或 mapping 变 → 拒绝 |
| 目标原则 | `targetArtifactId/targetActivationId`（准入 + 清单 + 当前 mapping） | 三者不一致 → 拒绝 |
| 配置 | 清单 `configSnapshot` + 运行时 `configIdentity` 快照 | 启动后配置变化 → 本次不宣称有效；旧快照不得复用 |
| session / run / hookInvocationId | **启动后**在首个消费点记录进 `consumedBy` 与 journal | 缺失 → 停止（不能唯一匹配） |

#### 3.4.5 只能启动后获得的身份与校验时点

| 身份 | 何时获得 | 何时校验 | 校验失败 |
|---|---|---|---|
| `hostVersion` / `pluginVersion` / hook 指纹 | 宿主进程启动后 | 首个消费点，写入 journal 配置身份 | 记 `partial/unknown`；不阻断运行，但不得宣称完整配置 |
| `sessionId` | 首个 hook 回调 | 消费时（`predeclared` 则比对） | 缺失/不符 → `admission_session_mismatch` / 停止 |
| `runId` | 首个 hook 回调（若宿主提供） | 消费时记录 | 缺失 → 记 `unknown`，不伪造 |
| `hookInvocationId` | 最早可记录入口 | 贯穿 open/terminal/journal | 缺失 → 不拼接、不计成功 |
| `endpointRequestId` | 端点收到请求时 | 请求记录与证据包 | 缺失 → 传输证据 `unknown` |

#### 3.4.6 三条身份线分别记录

| 线 | 字段 | 允许的结论 |
|---|---|---|
| operator admission | `admissionId`、`inputSha256`、`manifestSha256`、`target*`、`expiresAt`、`consumedBy` | 本轮输入与授权目标由操作者冻结；不是宿主身份 |
| host identity | `hookInvocationId`、`sessionId`、`runId`、`hostVersion`、`pluginVersion`、`configIdentity` | 本次运行的身份与配置快照；不等于请求身份 |
| endpoint request identity | `endpointRequestId`、`bodySha256`、`userMessageSha256`、`receivedAt` | 端点收到某次请求及其正文；不等于宿主 `requestId` |

报告与证据包必须使用这三组字段名。禁止把 `admissionId` 写进 `messageId`/`requestId`，也禁止用 `endpointRequestId` 冒充宿主请求身份。

#### 3.4.7 明确禁止

- 把拼接 prompt、历史摘要或 `event.messages` 的最后一条 user 消息当作当前正文；
- 仅凭内容相似或时间接近认定“就是本轮输入”；
- 在哈希不匹配时做 trim/大小写/Unicode 归一化后“修正”匹配；
- 用实验 token 伪造 `currentUserMessageId` 或 `requestId`。

### 3.5 缺口二：一次性与重放边界

#### 3.5.1 状态模型

- **持久状态**只有 `admission.json` 内的 `consumedAt/consumedBy`；不建表、不新增数据库、不写通用配置。
- **进程内状态**只有一个 claim 缓存（共享入口需要把 provider 的消费结果交给同一轮回调）：

| 属性 | 规则 |
|---|---|
| key | `admissionId` |
| value | `{ claimId, consumedBy, claimedAt, target }` |
| 容量 | 最多 2 条（同进程最多一次实验 + 一条陈旧项） |
| TTL | 60 秒（远小于外层 120 秒，覆盖同轮回调） |
| 写入者 | 仅 `controlled-admission.ts` |
| 清理 | 消费完成、journal close、异常 `finally` 或进程退出时删除；磁盘 `consumedAt` 为最终事实 |

#### 3.5.2 生命周期

`加载 → 校验 → 原子 claim（写 consumedAt/consumedBy）→ 放入 claim 缓存 → 交给 core/打包 → 注入 → journal close → 删除 claim 缓存`。

claim 在**使用之前**写入磁盘：先写 `*.claim.tmp`、`fsync`、`rename`；崩溃后以磁盘为准，已消费即不可重用。禁止静默重置或自动删除准入文件。

#### 3.5.3 场景矩阵

| 场景 | 处理 | 原因/记录 |
|---|---|---|
| 首次合法回调 | claim 并消费，进入 core | `admission_claimed` |
| 同一回调重复（同 `hookInvocationId`） | 拒绝，保持 Native；不写第二条干预 journal | `admission_already_consumed` |
| 同输入、新 run（同 session） | 拒绝 | `admission_already_consumed` |
| 跨 session 复用 | 拒绝；`predeclared` 时为 `admission_session_mismatch` | 同上 |
| 超时后再用 | 拒绝 | `admission_expired` 或 `admission_already_consumed` |
| 工具后的第二次模型请求（同 run） | 拒绝；第二次请求只走 Native | `admission_already_consumed`（准入在第一次请求前已消费） |
| provider 已消费但 prompt 回调未发生 | 不重试；实验记为传输失败 | `consumed_without_injection` |
| core/打包失败、异常、超时 | 不重试；消费保持 | 对应 core reason + `consumed` |
| 并发两次回调（同进程异步交错） | 文件 claim 的 O_EXCL 临时文件 + 进程内串行化；仅一个成功 | 另一个 `admission_already_consumed` |
| 中途失败后操作者想重做 | 必须生成新 `admissionId` 与新文件；旧文件保留为已消费证据 | 不自动重试 |

**默认不自动重试**：任何失败都不重新读准入、不重置消费、不追加宿主回合；重做只能由操作者发起并有新的有界批准。

#### 3.5.4 文件、字节与上限

- 读取使用 `Buffer` 原始字节；`input.txt` 16 KiB、`admission.json` 16 KiB、`manifest.json` 64 KiB；超限即拒绝。
- 所有路径 `realpath` 后必须位于 `experimentRoot` 内；拒绝 `..`、符号链接、junction、UNC 路径。
- JSON 解析失败、字段类型不符、未知 `schemaVersion` 均拒绝，不做“尽量解析”。
- 失败回退：`admission_*` 具体原因写入结构化日志；不改 Native 内容；不写第二次 journal。

### 3.6 缺口三：默认共享入口接线

#### 3.6.1 真实调用链（已核实）

```text
openclaw 宿主 before_prompt_build
  → index.ts 注册处按 features.abstraction_layer_v1 分流（147–159、503–506）
  ├─ 共享开启
  │   → sharedHostRuntime.dispatchBeforePromptBuild（openclaw-host-runtime.ts 190–197）
  │   → createProductionHostRuntime（同文件 111 起）
  │   → buildActivePrinciplePromptContext（host-runtime/src/index.ts 235 起）
  │   → options.beforePromptBuild(event, prompt)（421–425）
  │   → handleBeforePromptBuild（index.ts 389–393 回调同一插件处理器）
  └─ 共享关闭
      → handleBeforePromptBuild（index.ts 506）
```

共享路径**不会跳过** `handleBeforePromptBuild`，但会在更早的选择阶段被 `adaptivePriorityProvider` 的 `currentUserMessageId` 门挡住（`index.ts` 371–373）。所以必须同时覆盖“选择点”和“干预点”。

#### 3.6.2 真实生产者与消费者

| 角色 | 位置 | 输入 → 输出 |
|---|---|---|
| 生产者（实验控制器） | PRI-1118 launcher（隔离 worktree） | 冻结文件 → 官方宿主入口 → `event.prompt` |
| 消费者 A（共享选择） | `index.ts` `adaptivePriorityProvider` | event + 准入 → `{artifactId, activationId, hookInvocationId}` 或 `undefined` |
| 消费者 B（插件本地） | `prompt.ts` `handleBeforePromptBuild` | event + 准入/claim → core 调用或 Native |
| 共享装配 | `host-runtime/src/index.ts` | target → `adaptivePacking` → 最终 prompt |
| 最终校验 | `prompt.ts` 1052–1096 | 正文存在、deadline、`revalidateAdaptivePrinciple`、预算 |
| 证据 | `recordAdaptive` + EventLog | journal open/closed |
| 读模型 | `pd activation link` | journal + trajectory → run 级关联 |

#### 3.6.3 最小文件集合与数据流

- 共享开启：`index.ts` 先 `controlled-admission.ts` 加载/claim，provider 返回 target；claim 缓存把同一份准入交给 `prompt.ts`；`prompt.ts` **不再二次消费**，只读取 claim 并构造 core 输入。
- 共享关闭：`prompt.ts` 直接加载/claim；不经过 provider。
- 两条路径都调用 core 的同一个准入校验纯函数；`currentUserMessage` 都是 §3.4.2 证明过的原始 `event.prompt`。
- 共享路径不调用 `prepareAdaptiveIntervention` 时，`controlledAdmission` 仍由该纯函数校验；journal 记录 `operator_admission` 字段与 claim 结果。

#### 3.6.4 Native 基线 / 授权 / 预算 / 最终重验 / 停用继续生效

| 机制 | 保持方式 |
|---|---|
| Native 基线 | 无准入 → provider 返回 `undefined`；`buildActivePrinciplePromptContext` 的 no-priority 分支保持字节不变（已有测试） |
| 授权 | 目标仍必须是当前有效 Activation/Artifact；准入只声明“用本轮输入尝试这条已授权目标”，不创建授权 |
| 预算 | 继续使用 `selectionBudget` 与现有 renderer/packer；准入不新增预算通道 |
| 最终重验 | `prompt.ts` 1052–1096 的正文存在、deadline、`revalidateAdaptivePrinciple`、最终预算检查全部保留；失败按原逻辑恢复 Native |
| 停用 | 不设环境变量即停用；`abstraction_layer_v1` 关闭即走本地入口；不改治理状态 |

#### 3.6.5 真实入口正反例（必须在注册/派发层，不只测 helper）

| 入口 | 用例 | 期望 |
|---|---|---|
| 本地（flag 关闭，默认） | 无准入文件 | 不干预，Native 字节不变 |
| 本地 | 准入合法 + 冻结输入精确 | core 收到 `controlledAdmission`；未收到原生 ID；记录 claim |
| 本地 | 同时有 `currentUserMessageId` | 提前拒绝；不得把准入与原生身份混用 |
| 共享（flag 开启） | 无准入文件 | provider 返回 `undefined`；Native 不变 |
| 共享 | 准入合法 | provider 返回 target；`beforePromptBuild` 读取 claim；只消费一次 |
| 共享 | 同准入第二次回调 / 工具后第二次请求 | `admission_already_consumed`；无第二次注入 |
| 共享 | 目标撤销/正文变更 | 最终重验回退 Native；journal 记录原因 |

测试必须经过真实 `createProductionHostRuntime`/`handleBeforePromptBuild` 组装，不能只断言内部函数返回值。

#### 3.6.6 与“更简单的原生入口”比较（先比较成本，不擅自换目标）

| 选项 | 事实 | 成本 | 风险 | 结论 |
|---|---|---|---|---|
| A. 受控准入（本文） | embedded 已核实无原生 ID；core 已有准入校验；只需接线 | 1 个小模块 + 3 处接线 + 测试；无新持久化 | 准入语义需严格分层，已有设计约束 | **本轮采用** |
| B. 切换到 harness 入口 | 安装版 `agent-harness-runtime` 可由显式参数提供 `currentUserMessageId`，但它不是 embedded `before_prompt_build` 的 producer | 需重新核实官方入口、身份、hook 注册、证据链与宿主模式 | 改变研究目标/宿主模式；可能把测试 harness 当作真实入口 | **不采用**；仅当 Owner 明确改变目标并给出证据时重启 |

不采用 B 的理由是证据而非偏好：目前没有证据表明存在一个官方、用户可达、走同一 core/journal 的 harness 入口；直接切换会改变已冻结的 G1 研究目标。若后续发现这样的入口，应按 §9 重新比较，而不是在实现中悄悄替换。

---

## 4. 环境隔离

| 项 | 要求 |
|---|---|
| 配置 | 独立 `config.yaml`（隔离目录），`workspace.default` 指向隔离 workspace；插件 entry 显式 `hooks.allowConversationAccess=true`（历史 P0 已确认缺此项会导致 hookCount=0） |
| 状态 | 独立 `state.db` 与 `.pd/`，不连接生产库 |
| workspace | 独立目录，不含 Owner 真实数据；只放实验夹具 |
| provider | 仅 `127.0.0.1` 本地假 provider；`paidCalls=0` |
| 宿主 | 已安装 OpenClaw 2026.11.1，但只以隔离 workspace/config 启动；记录实际版本与 commit |
| 插件 | 使用**仓库构建产物**（`packages/openclaw-plugin` 的构建 bundle），复制到 `<experimentRoot>/plugin/` 后由官方 plugin entry 装载；记录 `bundleSha256` 与源 commit。**禁止**复制 `dist/` 覆盖 `~/.pd/runtime` 或安装目录 |
| 装载验证 | 只用 `openclaw plugins inspect --runtime` 做只读预检；必须看到 `before_prompt_build` 已注册，否则停止 |
| 并发 | 单进程、单会话；不与其他 Agent 并行写同一 checkout |

不为本次实验引入新的正式发版依赖；所有改动在仓库内构建，经官方装载路径使用。

---

## 5. 冻结验证语义与预算

### 5.1 四个独立口径（互不推导）

| 口径 | 上限 | 分配与说明 |
|---|---|---|
| 宿主回合数 | **2** | 1 正例（含 1 次只读工具）+ 1 Native 对照（无工具）。一次宿主回合可含多个模型请求。 |
| 本地假 provider HTTP 请求数 | **3** | 正例 ≤2（第一次决定工具调用，工具结果回传后第二次结束）；对照 ≤1。由端点独立计数。 |
| 工具调用次数 | **1** | 仅正例，只读工具；对照 0。工具结果不得触发额外回合。 |
| 付费模型调用 | **0** | 仅本地假 provider。 |

任一口径超限即停止；不能用“回合还有余量”解释超出的请求数。

**这是接线/运输对照，不是公平的行为效果对照。** 两臂工具安排不同（正例 1 次工具、对照 0 次），因此不得据此比较任务成功率、原则遵循或行为改善；只比较“干预记录能否与一条工具行动建立 run 级关联”。

### 5.2 journal 语义（与代码一致）

- **journal 完整且唯一性成立，仅行为来源截断**（corrections / outcomes / weakCandidates 的单会话行截断、总轨迹上限、日期范围裁剪）：可以保留运行关联（`strong_run`），但必须标注行为覆盖不完整；`coverage.complete=false` 只表示行为事实是下界，不表示关联不可信。
- **journal 本身截断、丢弃或不可读**（journal coverage 非 `complete`、`truncation.omitted>0`、`outputTruncated`、malformed/invalid envelope/invalid records 任一 >0、身份缺失、open/terminal 重复、`targetIdentityUnproven`、open/terminal 配置身份不一致）：唯一性无法证明，**不得宣称 `strong_run`**，关联降为 `unknown`（open/terminal 不可见时身份有效为 `weak`）。
- 同一 run 多次干预 → `ambiguous`；open/terminal 冲突 → `conflict`。

报告必须分三栏写：运行关联、行为记录完整性、能/不能得出的结论。

---

## 6. 实验协议（获批后才执行）

### 6.1 阶段

| 阶段 | 内容 | 模型/宿主消耗 |
|---|---|---|
| P0 预检 | 只读：核对宿主/插件版本、`plugins inspect --runtime` 的 hook 注册、隔离配置、三个冻结文件哈希、端点可达、工具白名单、进程树终止手段 | 0 宿主回放、0 模型请求 |
| P1 正例 | 1 次宿主回合；假 provider 第 1 个响应要求读取夹具文件，第 2 个响应结束 | 1 宿主回合、≤2 HTTP、1 工具 |
| P2 对照 | 1 次宿主回合；无准入、无工具；假 provider 直接结束 | 1 宿主回合、≤1 HTTP、0 工具 |
| P3 只读复核 | `pd activation link` 读取 journal/trajectory；哈希复核证据包 | 0 |

P0 若发现 hook 未注册、入口不能按文件提交、工具名/参数不明或端点不可用：**停止**，不进入 P1，不重试。

### 6.2 本地假 provider 如何产生工具调用、接收结果并结束

- 协议：OpenAI-compatible `POST /v1/chat/completions`（具体字段以 P0 对已安装宿主的只读核验为准；若字段不符，停止，不猜协议）。
- 正例响应 1：`finish_reason="tool_calls"`，`message.tool_calls=[{id:"call_1", type:"function", function:{name:"<P0 核验的只读工具名>", arguments:"{\"path\":\"<夹具绝对路径>\"}"}}]`；不返回正文。
- 宿主执行工具后发来请求 2（含 role=tool 结果）；端点记录工具结果，响应 2 返回固定结束文本（例如 `AA-DONE`）、`finish_reason="stop"`，不再要求工具。
- 对照响应：单次请求直接返回固定结束文本，不产生 `tool_calls`。
- 端点不实现流式、不实现其他模型、不回退；任何第三个请求即超预算。

### 6.3 工具白名单、固定目标与内容预期

- 只允许 P0 核验通过的一个只读工具（预期为 `read`；以实际宿主注册名为准）。
- 固定夹具：`<experimentRoot>/workspace/fixture.txt`，内容为唯一标记 `AA-FIXTURE-<runId>`，`fixtureSha256` 写入清单。
- 期望：journal/EventLog 出现且仅出现 1 条工具事件；工具声明的路径等于夹具路径；若宿主支持产物/内容回读，内容包含该标记。
- 禁止额外工具：隔离配置只注册该工具；若 journal 出现第二个工具事件或非夹具路径，停止并保留证据。
- 禁止外网：只配置一个 provider，`baseURL=http://127.0.0.1:<port>/v1`；不配置其他 provider/key。端点请求数即宿主模型请求数；无法观察的其它网络行为记 `unknown`，不得声称“已证明无外网”。

### 6.4 超时

| 项 | 上限 |
|---|---|
| P0 预检 | 25 秒 |
| 单个 HTTP 请求 | 15 秒 |
| 单个宿主回合（外层） | 120 秒 |
| Agent 内部 | 45 秒 |
| 整个实验（P0–P3） | 300 秒 |

超时即停止，不重试、不续跑。

### 6.5 停止条件

- 准入/输入/清单哈希不一致，路径越界，或身份不可信；
- `hookInvocationId`、`sessionId`、`runId` 缺失/冲突/无法唯一匹配；
- 正例工具行动未出现、出现多个工具或路径不是夹具；
- HTTP >3、工具 >1、宿主回合 >2、付费调用 >0；
- journal 不可读、端点不可用、非预期错误、任一超时；
- P0 发现 hook 未注册或入口不能按文件提交。

### 6.6 预期为 unknown、不触发失败

`requestAssociation`、`ordering`、`principleAdherence`、`behaviorImprovement`、`taskSuccess`、产物确认，以及“宿主原生 requestId”均保持 `unknown`；协议规定的“预期 unknown”不构成停止理由。

### 6.7 关闭端点、终止进程树、保留证据与回滚

1. `finally` 关闭本地端点，拒绝新连接；
2. 终止宿主进程树（Windows 使用 `taskkill /PID <pid> /T /F`；记录 pid 与退出码）；
3. 将 `.tmp/aa-experiment/<run>/` 原始证据（journal、端点请求日志、stdout/stderr 摘要、三个冻结文件、哈希）复制到证据包目录，原始目录保留；
4. 从实验根删除 `admission.json`（已消费记录先复制入证据包），不删除 journal；
5. 不删除共享状态、不改生产配置；
6. 回滚：unset `PD_AA_ADMISSION_FILE` / `PD_AA_EXPERIMENT_ROOT` 即恢复默认 Native；代码分支默认关闭；无数据库写入需回滚。

---

## 7. 关联语义（与读模型代码一致）

- **运行关联可信**：journal 中该 `hookInvocationId` 唯一，`sessionId + runId` 一致且在 run 内唯一匹配，且 `journalRangeComplete=true` → `strong_run`。
- **行为来源截断 ≠ journal 不完整**：只看 `facts` 与 `coverage`，不参与 `journalRangeComplete`；保留 `strong_run`，标注行为记录不完整。
- **journal 自身不完整/唯一性不可证** → `unknown`：见 §5.2；不能宣称 `strong_run`。
- 同一 run 多次干预 → `ambiguous`；open/terminal 冲突 → `conflict`。

---

## 8. 清理与回滚（批准与执行）

1. 实验结束后按 §6.7 执行；保留失败分母与原始证据。
2. 不修改历史批准、旧样本、冻结哈希与他人的共享指针。
3. 回滚仅需 unset 环境变量；代码分支默认关闭，不涉及 SQL/数据迁移。

---

## 9. 验证计划（获批后才执行）

| 层 | 内容 | 通过标准 |
|---|---|---|
| 单元 | 准入加载器：合法、哈希不匹配、缺字段、超限、路径越界、符号链接、过期、重复消费、并发 claim、默认关闭 | 每条有明确原因码，无静默通过 |
| 接线（本地） | flag 关闭：无准入 → Native；合法 → core 收到 `controlledAdmission` 且无原生 ID；有原生 ID → 拒绝 | 断言真实入口参数与回退原因 |
| 接线（共享） | flag 开启：provider 由准入返回 target；只消费一次；第二次回调/工具后第二请求 → `admission_already_consumed`；撤销/变更 → 最终重验回退 | 两条入口行为一致 |
| 契约 | core 准入纯函数、journal schema、配置身份 | 现有契约测试全绿，不跳过 |
| 夹具 | 合成 journal + `pd activation link` | `strong_run`、行为事实齐全、四层边界正确 |
| 隔离宿主 | P0 + 正例 1 + 对照 1 | 预算不超、身份与工具行动可关联、结论分级正确 |
| 门禁 | lint、typecheck、相关包测试、`check:runtime-contract` | 全绿；只跑定向测试，不重跑全仓 |

验证只证明“接线可用 + run 级关联可复核”，不证明真实模型送达、原则遵循或行为改善。

---

## 10. 风险与未决

| 风险 | 处理 |
|---|---|
| 准入被误认为宿主身份 | 三线字段分离；core 拒绝与原生 ID 并存；报告中禁用 `requestId` 代称 |
| `event.prompt` 含 wrapper/历史导致哈希不符 | 直接拒绝；不做归一化；停止而非改入口 |
| 共享 offer 消费后 prompt 回调未发生 | 不重试；记 `consumed_without_injection`；实验失败但不逆转消费 |
| 进程崩溃留下已消费文件 | 以磁盘为准；不自动重置；重做需新 `admissionId` |
| 假 provider 结果被当作真实行为证据 | 证据包标 `localFakeProvider=true`、`paidCalls=0`；结论仅 run 级关联 |
| hook 改动影响正常路径 | 默认关闭；原生 ID 优先；有原生 ID 即拒绝准入；现有测试复跑 |
| 宿主入口不能按文件提交 | P0 停止；不改用拼接 prompt，不改宿主模式 |

未决（需 Owner 一次决定）：

1. 是否批准按 v1.2 §3 实现（默认关闭、无新增持久化配置、core 仅提取纯校验函数）；
2. 是否批准 §5 的预算与 §6 的实验协议；
3. 是否批准 §4 的隔离环境与 §6.7 的清理/回滚；
4. 是否批准在指定检查通过后执行一次正例 + 一次对照（不自动重试）。

---

## 11. 批准卡（供 Owner 一次批准）

| 项 | 内容 |
|---|---|
| 设计版本 | v1.2（本文件；实现前以合并后的 commit 为准） |
| 实现范围 | `controlled-admission.ts`（新增）、`prompt.ts`、`index.ts`、core 准入校验纯函数提取、对应测试；默认关闭，不改安装目录 |
| 环境 | 隔离 workspace/config/state；仓库构建插件经官方 plugin entry 装载；仅 `127.0.0.1` 假 provider；宿主 OpenClaw 2026.11.1 |
| 预算 | 宿主回合 ≤2；HTTP ≤3；工具 ≤1（仅正例读夹具）；付费模型 0；无自动重试/provider 切换/超额续跑 |
| 停止条件 | §6.5；预期 `unknown` 不停止 |
| 清理/回滚 | 终止进程树、关闭端点、保留 `.tmp` 证据、删除准入文件；unset 环境变量即回滚 |
| 批准语义 | 批准后：按 v1.2 实现 → 定向测试与 P0 预检通过 → 在预算内执行一次正例 + 一次对照；任一停止条件命中即停，不追加回合 |
