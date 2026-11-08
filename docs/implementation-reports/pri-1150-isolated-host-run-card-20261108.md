# PRI-1152 Path A 隔离宿主验证运行卡 v3（`pri1152-run-card-v3`）

- 文档 ID：`pri-1150-isolated-host-run-card-20261108`（文件名沿用，保护既有指针；v3 取代 v1/v2 全部内容）
- 状态：**🔴 当前不可执行、待 Owner 决定**。阻断项 B1（§0）未解决前，启动器 `--execute` 的离线复核会因 `presence-durability FAIL` 自动拒绝。本卡**未获批准、真实宿主/模型零启动**。
- 批准对象（两项必须同时绑定）：卡版本 `pri1152-run-card-v3` + 执行清单 sha256 `b16e81284bd1975036c3560f022d28610f1c43550d245e0e4610f926e383b895`。B1 修复后重新 prepare 会产生新的清单 sha256（卡升 v3.1），**须对新值重新批准**。
- 执行包（PACK）：`D:\Code\_worktrees\principles\PRI-1152-isolated-host-exec-pack\artifacts\pri-1152-isolated-host\pp-20261108T095217Z`
- 机器可读清单：`PACK\manifest.json`；本卡全部数值抄自该清单与离线复核报告 `PACK\preflight\verify-20261108T095712Z.json`。

## 0. 阻断项 B1：presence 事件在一次性宿主退出时丢失（已离线复现）

| 项 | 事实 |
|---|---|
| 机制 | 插件 `EventLog` 把事件放在内存缓冲区，满 20 条或每 30s（unref 定时器）才写盘；`recordPromptPresenceObserved` 只缓冲不写盘（`packages/openclaw-plugin/src/core/event-log.ts`）。插件与宿主都没有退出时写盘：`EventLogService.flushAll/disposeAll` 在生产代码中无调用方，PD 服务的 stop 也不写盘 |
| 宿主行为 | `openclaw agent exec` 是一次性命令，输出结果后让 Node 自然退出，不等插件定时器（OpenClaw `4ffdd2047d1`：`src/cli/one-shot-exit.ts`、`src/runtime.ts`） |
| 离线复现 | `node .tmp/pri1152-flush-probe/probe.mjs <worktree>\packages\openclaw-plugin\dist\core\event-log.js <dir> natural`（exit 0）：`logs\` 下**没有** `events_*.jsonl`；同一命令换成 `flush` 参数（exit 0）：写入 1 行 presence 事件 |
| 后果 | 即使 R1 中观察真实发生，E1 证据也不会落盘，R1 会因"事件缺失"失败，白白消耗已批预算 |
| 构建产物检查 | `presence-pack.presenceDurability()` 对候选 bundle 的判定为 `buffered_lost_on_one_shot_exit`，复核项 `presence-durability FAIL` |

**最小修复（需 Owner 批准；本任务未实施，因为指令要求不修改已收口的观察功能）**：

```ts
recordPromptPresenceObserved(data: PromptPresenceObservedEventData): void {
  this.record('runtime_v2_prompt_presence_observed', 'injected', data.sessionId, data);
  this.flushEvents(); // 一次性宿主退出时不写盘；与 recordAdaptiveDelivery 的既有先例一致
}
```

配套回归测试：子进程记录一条事件后自然退出，断言事件行已落盘。修复以独立小 PR 合入后，按 §12 重新 prepare（候选 bundle 哈希会变）并 verify；`presence-durability` 应为 PASS，再以 v3.1 清单 sha256 提交批准。备选方案是在 `EventLogService` 注册 `process.on('exit')` 统一写盘，但它影响所有事件和所有宿主，范围大，**不推荐**。

## 1. 目标与结论上限

在**未修改**的官方 OpenClaw 2026.11.1 上，确认候选 PD 的正式 `llm_input` 注册、shared 装配快照、关联裁决与自有 presence 事件端到端连通。**只验证宿主装配观察连通**。结论上限：D 保持 `unknown`；不签收 G1/C04/G2；不证明请求送达、原则遵循或行为改善。

## 2. 冻结身份

| 项 | 值 | 依据 |
|---|---|---|
| 工具源码 SHA | `aabbd4550aa54c23e969de1e73eac1eeb76b1cae`（分支 `ai/PRI-1152-isolated-host-exec-pack`，tracked tree clean） | prepare 记录的 `source` |
| 候选源码 | 与 main `f7cdc5a1515e7dcdb9ed4c0a5bf4da30f831e77d`（含 #2412）一致：`git diff --stat f7cdc5a15 HEAD -- packages/{openclaw-plugin,host-runtime,principles-core}/src` 输出为空 | 离线核对 |
| 候选 bundle | `PACK\candidate\principles-disciple\dist\bundle.js`，sha256 `773c5965f02f13a6419156b530d0289abe792b470b54bcd3b6ff8da3d47b4192`，39216175 B；两次 `npm run build:bundle` 产物哈希相同 | manifest.candidate |
| 候选入口 | `package.json` 中 `openclaw.extensions = ["./dist/bundle.js"]`；插件 id `principles-disciple`；版本 3.0.1 | manifest.candidate |
| 依赖解析 | 唯一外部依赖 `better-sqlite3@13.0.3` 已复制到 `PACK\candidate\principles-disciple\node_modules\better-sqlite3`，从包内解析；`bufferutil`、`utf-8-validate` 不存在（ws 用 try/catch 加载的可选加速模块），包外也没有可被解析到的副本 | `auditBundleExternals` |
| 候选树 | 193 个文件，treeSha256 `3455e4110300d5e7bea765ab914bfdd1d451d911682e4a7aa73f6e7e39e16bbf`（`PACK\candidate-files.json`） | manifest |
| 官方宿主 | openclaw 2026.11.1；build commit `4ffdd2047d192dd65554de3c8c46c0e0197c6e2a`（即 tag v2026.11.1）；buildId `2026.11.1-release-4ffdd2047d19-2026-11-05T01-26-26.075Z` | `dist/build-info.json` |
| 宿主产物 | 从全局安装 `C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw` 逐字节复制到 `PACK\host\node_modules\openclaw`：44592 个文件，530686533 B，treeSha256 `d0d151c116919ed6f2411611e0baae79c804fe7e96855cf7b653a00b5dc27495`，不含链接。全局安装只读、未改动 | `PACK\host-files.json` |
| 官方产物依据 | npm 缓存中的 registry tarball `openclaw-2026.11.1.tgz`，SRI 为 `sha512-2pSbt/taBKM/ofPXsiOEmVefgUdVHYRZOmcWNDyx67WUfeGFXqtfqLvtwYOiH4NcLolDSLMUgsno2oYhTVXptw==`（112927779 B，内容按 SRI 复算一致）。逐文件对照 **15180** 个打包文件：0 不一致、0 多余；唯一缺失的是官方 lifecycle 完成后会删除的 `.openclaw-lifecycle-pending` | manifest.host.tarballVerification |
| 宿主入口 | `PACK\host\node_modules\openclaw\openclaw.mjs`，sha256 `469e60c9f60b615ff71c985a54238ee532a8f949866d76aebe7d6e4bc7219902` | host-profile |
| Node | `D:\Program Files\nodejs\node.exe`，v26.12.1，sha256 `1c63f1417e2e26d83ca9a9ec1d548524ab1305bc7209d90ebca56257ff0d84ed` | manifest.node |

## 3. 插件加载机制与生产插件排除（官方依据：OpenClaw `4ffdd2047d1`）

- **加载方式**：冻结配置 `plugins.load.paths = [PACK\candidate\principles-disciple]`，并设 `plugins.allow = ["principles-disciple"]`。同一 id 被多处发现时，`config` 来源优先级为 0，高于 bundled（3）、workspace（4）和普通 global（5）（`src/plugins/manifest-registry-build.ts:168-196`、`src/plugins/discovery.ts:917-928`）。
- **所有发现根都在 PACK 内，或已核实不含 PD**：
  - global 扩展目录 = `<OPENCLAW_STATE_DIR>\extensions` = `PACK\state\R1|R2\extensions`，不存在；
  - workspace 扩展目录 `PACK\workspace\.openclaw\extensions`，不存在；
  - bundled 根 `PACK\host\...\dist\extensions` 共 69 个 id，不含 `principles-disciple`；
  - 配置中没有 install records；
  - `OPENCLAW_HOME`、`HOME`、`USERPROFILE` 均为 `PACK\home`。
- **候选代码执行的判据**：生产 PD（`C:\Users\Administrator\.openclaw\extensions\principles-disciple`，2.6.4，bundle sha256 `f599cd89…3d09`）的 bundle 中 `runtime_v2_prompt_presence_observed` 出现 **0 次**。因此隔离日志中只要出现该事件，就说明候选代码在隔离宿主内执行了。
- **NOT RUN**：宿主"确实加载了候选"无法离线证明。`plugins inspect --runtime` 本身会启动宿主并初始化插件，属于待批运行。这一项作为 R1 的首项判定（§7 `presence-event`）。

## 4. 宿主配置、PD 配置与宿主会话设置（分开冻结）

| 文件 | sha256 | 要点 |
|---|---|---|
| 宿主配置 `PACK\config\openclaw.json` | `dc0fa286e749f4e0fe9b5ca1ac6fe59f892ae979136cc37ecb4b8efccba70cb3` | 只加载候选路径；`allowConversationAccess`、`allowPromptInjection` 为 true；不设 `adaptiveActivation`；`tools.deny=["*"]`（宿主把空 allow 解释为全部允许，所以不用空 allow）；`mcp.servers.pd-recall.enabled=false`；两个回环 provider；primary 为 `pdpresence-responses/isolated-presence-model` |
| PD 配置 `PACK\workspace\.pd\config.yaml` | `994969763b88938dfc1b5513b21b7dbf595dc86c76edf214865fe2a8dac92e3b` | 内容为 core 默认配置，只关闭 `signal_collector` 和 `internalization_auto_consumer`；`correction_observer`、`anonymous_product_telemetry` 默认已关；`prompt` 开启。经真实 `loadPdConfigForPlugin` 解析，来源为 `user_config`。默认 runtime profile 的 provider/model/apiKeyEnv 都为空 |
| 宿主会话设置 `PACK\workspace\.openclaw\settings.json` | `562490ff2868b555cfda9d7db07ec8daf9f0acb6753f655bde057cc46a7d9766` | `retry.provider.maxRetries=0`，关闭默认最多 8 次的瞬时恢复重试。项目设置在默认 `sanitize` 策略下保留（该策略只剥离 shellPath/shellCommandPrefix） |

## 5. 原则夹具（经正式存储入口写入）

- **写入路径**：`SqliteTaskStore.createTask` → `SqlitePIArtifactStore.createArtifact`（validated principle）→ `SqliteActivationStateStore.recordActivation`（prompt）。**不写 approvals 行**（approvals 计数为 0），shared 路由据此派生 `authority="system_policy"`。这如实反映了隔离测试夹具的授权来源，不声称有 Owner 批准。
- **身份**：principleId `pri1152-presence-fixture`；artifactId `art-pri1152-presence-fixture`；activationId `act_prompt_pri1152-presence-fixture`；`revision_epoch=0`。
- **正文**：`PRI-1152 隔离验证夹具：交付前必须核对 <presence> 标记、& 符号与 "引号"。`
  - raw sha256 `6b90ac20…dec9a`；转义后 sha256 `d7be82f7…5bdc`。
  - 在冻结的 directive 片段中：转义正文出现 1 次，raw 正文 0 次，二次转义 0 次。
  - 冻结 directive 片段 sha256 `f69e1373adce8456f268d361aa46d6095049dea8f13cce38ca1900d50bf4bb45`，278 字符，`bodyComplete=true`。
- `PACK\workspace\.pd\state.db` sha256：`72dcc4cf1fa078f41d56ae34783f216cca652947321053173862caec8dae5ed9`。
- **装配条件**：普通 shared 路由（非 adaptive），`legacy_fifo_prefix_v1`，预算 4000，未截断。
- **用户输入**：A1 取自冻结金标数据集 `scripts/dev/pain-real-llm-bdd/golden-dataset.json`（sha256 `2043116826d8…a8e`），正文 sha256 `d9bad085…8298`，前面加一行回合标记。**A1 只是用户输入，不是 activation**。

## 6. 本地假 provider（127.0.0.1:8652）

| 项 | R1 | R2 |
|---|---|---|
| provider / API | `pdpresence-responses` / `openai-responses` | `pdpresence-completions` / `openai-completions` |
| 路径 | `POST /v1/responses` | `POST /v1/chat/completions` |
| 模型 | `isolated-presence-model` | 同左 |
| 终止响应 | SSE，以 `response.completed` 结束 | SSE 内容块 → `finish_reason:"stop"` → `data: [DONE]` |

- **凭证**：每个执行包生成一个假 key（sha256 `40e13f55…e8d2`），写在冻结配置里，不来自环境变量。端点只记录请求是否携带该 key（`authMatchesFakeKey`）。
- **端点规则**：不向任何地方转发，只服务两个固定路径。拒绝在读取请求体之前判定，拒绝原因包括 `no_active_round`、`api_mismatch`、`over_budget`、`tool_budget`、`off_protocol`。**从不返回 429**，因为宿主会把 429 当作可重试错误。端点只记录传输事实：方法、路径、API、模型、stream 标志、请求体大小与 sha256、工具定义名；不保存正文。
- **协议自测**：这是记账的本地回环自测，**不是宿主启动，也不计入运行预算**（独立账本 `PACK\preflight\selftest-ledger-20261108T095711Z.json`，共 5 次请求）。用包内官方 `@openclaw/ai` 传输层实测：
  - responses 完整流：accepted（stop，`PRESENCE-ACK`）；
  - 只有 `[DONE]` 的 responses 流：**rejected**（"OpenAI Responses stream ended before a terminal response event"）；
  - completions 完整流：accepted；
  - 既无 `finish_reason` 也无 `[DONE]` 的 completions 流：**rejected**（"Stream ended without finish_reason"）；
  - 只有 `[DONE]` 的 completions 流（仅作记录）：官方传输层接受为**空文本** stop。因此回合判定要求最终文本必须是 `PRESENCE-ACK`，不会把这种片段当作有效响应。

## 7. 两个回合

宿主命令（spawn，不经 shell；工作目录 `PACK\workspace`；环境按 §8 的允许列表构造）：

```
"D:\Program Files\nodejs\node.exe" D:\Code\_worktrees\principles\PRI-1152-isolated-host-exec-pack\artifacts\pri-1152-isolated-host\pp-20261108T095217Z\host\node_modules\openclaw\openclaw.mjs agent exec --config D:\Code\_worktrees\principles\PRI-1152-isolated-host-exec-pack\artifacts\pri-1152-isolated-host\pp-20261108T095217Z\config\openclaw.json --state-dir D:\Code\_worktrees\principles\PRI-1152-isolated-host-exec-pack\artifacts\pri-1152-isolated-host\pp-20261108T095217Z\state\R1 --model pdpresence-responses/isolated-presence-model --cwd D:\Code\_worktrees\principles\PRI-1152-isolated-host-exec-pack\artifacts\pri-1152-isolated-host\pp-20261108T095217Z\workspace --timeout 120 --code-mode direct --json --message-file D:\Code\_worktrees\principles\PRI-1152-isolated-host-exec-pack\artifacts\pri-1152-isolated-host\pp-20261108T095217Z\inputs\R1.txt
```

R2 只改三处：`state\R1`→`state\R2`，`--model pdpresence-completions/isolated-presence-model`，`inputs\R1.txt`→`inputs\R2.txt`。输入 sha256：R1 `3ca51e26…c119`，R2 `dc043a71…7f09`。

| 期望（每回合全部满足才通过） | 禁止 |
|---|---|
| `host-exit`：退出码 0，未超时 | 超时、spawn 失败 |
| `host-envelope`：`--json` 输出 ok=true、status=ok，final 含 `PRESENCE-ACK` | 空文本（例如只有 `[DONE]` 的片段） |
| `endpoint-one-request`：本回合恰好 1 次 served，0 次 refused | 第 2 次请求（宿主内部重试）、任何 refused |
| `endpoint-api-path`：R1 为 `/v1/responses`，R2 为 `/v1/chat/completions` | 另一种 API 的路径 |
| `endpoint-fake-key`、`endpoint-model` | 继承来的凭证、其他模型 |
| `presence-event`：本回合 provider/model 对应的 presence 事件恰好 1 条（兼作"候选已加载"证明） | 0 条或多条 |
| `presence-boundary=post_assembly_system_prompt_via_llm_input`；`binding=unique`、`checked=true`、无降级 reason | ambiguous/none、`empty_snapshot`、`missing_expectations`、`history_incomplete`、`check_failed` 等 |
| `presence-fixture-full-hit`：夹具 activationId 的结果为 `full_hit` | `checked_missing`、`unknown` |
| `presence-no-body`：事件行不含 raw 正文，也不含转义正文 | 正文进入事件 |

**不断言**：presence 事件没有 `egress`/API 字段，API 路径只由端点请求记录证明。也不检查请求正文中是否含有原则——送达不在本卡范围内。

## 8. 环境隔离

- **继承范围**：子进程环境按允许列表构造，只继承 `COMSPEC LANG NUMBER_OF_PROCESSORS OS PATH PATHEXT PROCESSOR_* SYSTEMDRIVE SYSTEMROOT WINDIR`，其余全部丢弃，包括所有 `*_API_KEY`/`*TOKEN*`、`NODE_OPTIONS`、`NODE_PATH`、`PD_*`、`OPENCLAW_*`、`XDG_*`。
- **显式设置**：
  - `HOME`/`USERPROFILE`/`OPENCLAW_HOME`=`PACK\home`
  - `APPDATA`=`PACK\home\AppData\Roaming`，`LOCALAPPDATA`=`PACK\home\AppData\Local`
  - `TEMP`/`TMP`/`TMPDIR`=`PACK\tmp`，`XDG_*`=`PACK\home\...`
  - `OPENCLAW_STATE_DIR`=`PACK\state\R1|R2`，`OPENCLAW_CONFIG_PATH`=冻结配置
  - `OPENCLAW_WORKSPACE_DIR`/`PD_WORKSPACE_DIR`=`PACK\workspace`
  - `PD_TELEMETRY_DISABLED=1`，`PD_MCP_LOG=0`
  
  `OPENCLAW_PROFILE`、`PD_STATE_DIR`、`OPENCLAW_WORKSPACE` 不设置，取默认值，默认值也在 PACK 内。
- **最终路径**（全部已证明位于 PACK 内）：
  - 插件发现：见 §3；
  - PD 数据库：`PACK\workspace\.pd\state.db`；PD 日志：`PACK\workspace\.state\logs`；
  - 宿主状态与会话：`PACK\state\Rn`、`PACK\state\Rn\agents`；
  - 插件经 `os.homedir()` 写入的位置：`PACK\home\.openclaw\openclaw.json`、`PACK\home\.openclaw\cron\jobs.json`、`PACK\home\.pd\**`；
  - 编译缓存：`PACK\tmp\node-compile-cache`；
  - MCP：已按官方开关关闭（没有 binding 文件不足以证明 MCP 安全）；
  - 子进程：每回合结束后清扫（§9）。
- **离线反例**（`scripts/__tests__/aa-presence-run.test.mjs`）：
  - 父进程环境中，workspace/home/state/config/bundled/dev-source 都指向生产路径，另带 `NODE_OPTIONS` 和 4 个凭证：全部被重定向或丢弃；
  - 路径越出 PACK，或 extra 中出现类凭证键：在返回环境之前拒绝；
  - 假宿主在子进程中实测：`os.homedir()` 位于 PACK 内，无凭证键，`NODE_OPTIONS` 为空。

## 9. 预算、超时、停止、清理（待批范围，本轮未消耗）

| 预算 | 上限 | 拒绝点 |
|---|---|---|
| 宿主启动 | 2（每回合 1） | spawn 前在账本预留；启动失败也计账 |
| provider HTTP | 2（每回合 1） | 端点读请求体之前预留；超出返回 403 `over_budget` |
| 工具 | 0 | 宿主配置 deny-all；端点一旦看到工具活动，返回 403 `tool_budget` 并记账 |
| 付费 | 0 | 只用回环 provider，没有可用的真实凭证 |

- **预算语义**：额度用满不算超预算；**下一次**尝试在发出前被拒绝。账本 `PACK\run\budget-ledger.json` 永不重置。同一执行包只执行一次：`run\` 目录已存在就拒绝。
- **超时**：宿主 `--timeout 120`（秒）；外层 180000 ms 后执行 `taskkill /PID <pid> /T /F`，结束整个进程树。
- **停止**：R1 任何一项判定失败，**不启动 R2**。不自动重试，不切换 provider，不用 fallback。
- **清理**：
  - 每回合结束后，用 PowerShell CIM 查找命令行中引用 PACK 的残留进程，全部结束；发现任何残留即判该回合失败；
  - 最后关闭端点，并确认端口拒绝连接；
  - **保留全部证据，不删除执行包**。
- **离线反例**（假宿主）：
  - 正常两回合：用量 2/2/0/0，第二次 execute 被拒绝；
  - 多发 1 次请求：被拒绝，R1 失败，R2 不启动；
  - 宿主崩溃：启动已计账，运行停止；
  - 宿主挂起：4s 外层超时后结束进程树，孙进程已不存在；
  - 遗留孤儿进程：被清扫并判定停止；
  - 未批准、哈希不符或批准缺字段：在任何启动之前拒绝，不创建 `run\`。

## 10. 证据（`PACK\run\`，只有获批执行才会生成）

- `verification-before-run.json`、`approval-used.json`、`pollution-before.json`
- `evidence\Rn.environment.json`、`Rn.host.stdout.txt`、`Rn.host.stderr.txt`、`Rn.endpoint.json`、`Rn.presence-events.json`、`Rn.gate.json`
- `budget-ledger.json`
- `run-record.json`：含账本快照、端点关闭结果、最终清扫结果、污染对照

## 11. 生产污染审计（范围与限制）

- **对象**：
  - 全局宿主的 package.json/openclaw.mjs/build-info；
  - 生产 PD 插件的 package.json/bundle/mcp-binding.json；
  - `~\.openclaw\openclaw.json`、`~\.openclaw\cron\jobs.json`（当前不存在）、`~\.pd\product-telemetry.json`；
  - 两个生产 workspace（`D:\.openclaw\workspace`、`C:\Users\Administrator\.openclaw\workspace`）下的 `.pd\state.db` 和 `.state\logs`。
- **判定规则**：
  - 哈希不变：`unchanged`；
  - 静态安装文件变化：`changed-static-install-review`，需人工复核；
  - 活动库变化：`changed-independent-writer-possible`。**不按哈希归因**，因为可能有其他合法写入方；
  - 配置或日志出现本次运行的唯一标记（packId、夹具 id、provider/model id、`127.0.0.1:8652`、PACK 路径）：`changed-attributed`；
  - 有变化但未命中标记：`changed-no-run-marker-found`。
- **限制**：哈希不变或未检索到标记，**都不能证明零写入**；mtime 变化也不直接归因。

## 12. 执行步骤（只有 v3.1 获批后才执行）

1. 合入 B1 修复并重建候选，然后运行 `node scripts/dev/aa-controlled-admission/presence-run.mjs --prepare --repo D:\Code\_worktrees\principles\PRI-1152-isolated-host-exec-pack`，得到新的 PACK 和清单 sha256。
2. 运行 `node scripts/dev/aa-controlled-admission/presence-run.mjs --verify --pack <新 PACK> --full --selftest`，要求退出码为 0，13 项全部 PASS。
3. Owner 批准该卡版本和清单 sha256 后，按 `approval.template.json` 填写 `approvedBy`、`approvedAt`、`approvalEvidence`（批准记录所在位置），另存为 `approval.json`。
4. 运行 `node scripts/dev/aa-controlled-admission/presence-run.mjs --execute --pack <新 PACK> --approval <新 PACK>\approval.json`。

## 13. 尚缺事项

1. **B1（阻断）**：需要 Owner 决定 §0 的最小修复，或给出其他方案。
2. **只能由获批真实运行给出的事实（NOT RUN）**：
   - 官方宿主是否确实加载了候选；
   - 真实的 `llm_input` 派发；
   - 宿主的真实请求形状，以及有无额外调用（标题、压缩等）；
   - 宿主退出时序；
   - `tools.deny` 下实际暴露的工具面；
   - 污染前后对照。
3. **端口**：8652 在 prepare 时分配并冻结。执行时若被占用会失败关闭，需要重新 prepare。
4. **worktree**：执行包位于本任务 worktree 的 `artifacts\` 下，**真实运行完成之前不得清理该 worktree**。
5. **安全审计**：Mimosa 完整审计未得出结论（scanner_enobufs），本卡不作安全性声明。

## 14. 变更记录

- **v1/v2**（PRI-1150 期间）：只有说明性运行卡，端口、key、路径留了占位；v2 中的 "egress=completions" 是不存在的事件字段；没有覆盖 HOME/USERPROFILE/APPDATA 等回落来源。
- **v3**（本卡）：
  - 所有数值来自生成的执行清单；
  - 加载机制和产物来源均可核验；
  - 夹具经正式存储入口写入；
  - 两种协议都用官方传输层自测；
  - 环境改为允许列表；
  - 预算、停止、清理都有离线反例；
  - 新增阻断项 B1。
