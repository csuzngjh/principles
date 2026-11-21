# PD 宿主身份上下文调用链审计

- 日期：2026-11-21
- 类型：只读源码/安装态审计与文档架构决策
- 关联：PRI-1272、PRI-1273、PRI-1274、PRI-1275、PRI-1276；PRI-1260 的既有身份声明校验边界继续有效
- PD 源码基线：`origin/main@44eb2260606776dc28939a45d5375c2fb29b4a0c`
- 本报告只更新文档与 Linear 需求；不修改运行时代码、不修改已安装包、不读取或复制对话正文。

## 结论

**将宿主生成的 MCP request `_meta` 作为提交身份主路径；PostToolUse / after_tool_call 结构化提交回执作为缺失元数据时的兜底；目标轮证据补齐保持独立。** 这不是取消身份验证，也不是放宽 PRI-1260 对模型/用户 `hostSession` claim 的要求。新主路径只信任由对应宿主启动、绑定到当前 Workspace 的 stdio MCP client 注入的 `_meta`；hostKind 和 Workspace 始终由 MCP Server 启动绑定提供。

当前实现把“提交 Session 是否可信”与“目标轮正文是否已经进入授权轨迹”耦合，导致即使宿主已提供 Session，目标正文晚到也可能阻止身份绑定。另一方面，WorkBuddy/OpenClaw 的 MCP 分支仍从工具参数 `submission.hostSession` 读取 claim，而不是统一消费请求 `_meta`。因此本轮不是简单新增一个 Hook，而是先统一可信身份输入，再保留 Hook 兜底。

## 审计基线

| 组件 | 审计版本/基线 | 备注 |
| --- | --- | --- |
| PD 源码 | `origin/main@44eb2260` | 最新远端基线；原 `D:\Code\principles` 工作区有未跟踪文件，未重置或清理 |
| PD MCP Server | 安装 `@principles/pd-mcp-server@0.4.4`；源码 `0.4.4` | 安装与源码版本一致 |
| PD Host Runtime | 安装 `@principles/host-runtime@4.5.0`；源码 `4.5.1` | 安装版本落后一个 patch；本次只读审计，不升级运行时 |
| PD OpenClaw Plugin | 安装 `principles-disciple@4.2.0`；源码 `4.2.1` | 安装版本落后一个 patch；Gateway 生命周期不在本次改动范围 |
| PD WorkBuddy Adapter | 安装 `@principles/workbuddy-adapter@0.7.0`；源码 `0.7.1` | 安装版本落后一个 patch；本次只核对 MCP 接口，不改实现 |
| PD Codex Adapter | 安装 `@principles/codex-adapter@0.13.0`；源码 `0.13.1` | 安装版本落后一个 patch；PostToolUse 保留为 fallback |
| OpenClaw（安装） | `2026.11.5 (e13cf15)` | 直接检查安装包 runtime；本地 OpenClaw 源码 checkout 明显落后，不用它作为实现基线 |
| Codex 源码 checkout | `c0cc9fc820` | 2026-11-12 |
| Pi mono 源码 checkout | `a40abecaa` | 2026-11-11 |

## 关键源码与安装态发现

### 1. PD MCP Server：元数据已到入口，但没有形成统一主路径

- `packages/pd-mcp-server/src/server.ts` 已从 MCP 请求上下文读取 `ctx.mcpReq._meta`，并作为 `requestMeta` 传给 `submit-assembly.ts`。
- `packages/pd-mcp-server/src/submit-assembly.ts` 当前只有 Codex 分支消费 `requestMeta`。WorkBuddy/OpenClaw 分支仍读取 `submission.hostSession`，再用 `listGovernanceTurnTexts` 验证；工具参数是模型可见输入，不能作为宿主身份来源。
- Codex `verifyCodexTarget` 要求 `threadId/sessionId` 与 `x-codex-turn-metadata.turn_id` 同时存在，默认把提交 Turn 当作目标 Turn，并查询 `governance_observations` 中该目标轮可读的 user/assistant 正文。正文不存在时返回 `codex_target_evidence_unavailable`。这把提交 Session 身份与目标轮正文可用性耦合，必须拆分。
- 通用 `verifyHostSession` 查询 `listGovernanceTurnTexts`，而该 reader 读取 PD `governance_observations`。它不能被当作 OpenClaw/WorkBuddy 所有宿主表的统一索引。

### 2. Codex：原生 MCP `_meta` 已存在，但 Turn ID 是可选字段

- Codex `with_mcp_tool_call_ids_meta` 注入 `threadId/sessionId`，并可能附带 `windowId/itemId`；这些 window/item 字段不是 Turn ID。
- `x-codex-turn-metadata.turn_id` 可从 turn metadata payload 提供，但不是每次调用都应假定存在。缺少 Turn ID 不应否定可信 Session 绑定。
- 该 metadata helper 不注入 toolCallId；Codex PostToolUse 事件另有 `tool_use_id`，可用于回执兜底关联。
- Codex PostToolUse 的 `tool_response` 能提供 `pd_submit_pain` 结构化回执；普通 EventLog `tool_call` 记录不含完整结构化返回和 painId，不能替代它。

### 3. OpenClaw：底层支持 `_meta`，实际 MCP 调用点没有传递

- 已安装 OpenClaw `2026.11.5` 的 `agent-bundle-mcp-runtime.js` 中，`callTool(server, tool, args, options)` 已将 `options._meta` 放入 MCP `tools/call` 请求。
- 安装包 `agent-bundle-mcp-materialize-*.mjs` 的 `materializeBundleMcpToolsForRun` 调用点目前是 `t.callTool(server, tool, args)`，没有传第四个参数；因此底层能力存在，调用链未接通。
- runtime 区分 `sessionId` 与 `sessionKey`。身份只能使用真实 `sessionId`；`sessionKey` 是会话/路由键，不得作为 Session ID。
- 当前调用点未证明存在稳定的 submissionTurnId。不得用最近消息、runId、sessionKey 或轮次序号补出 Turn ID。toolCallId 只在执行上下文确实提供时传递。

### 4. WorkBuddy / Pi：MCP client 缺少通用请求元数据入口

- `D:\Code\pi-mono\packages\mcp\src\client.ts` 的 `McpRequestOptions` 当前只有 `signal/timeoutMs/onProgress`，没有 `_meta` 字段。
- `requestInternal` 仅在进度回调存在时构造包含 `progressToken` 的 `_meta`；尚无将 host context 与 progressToken 合并的请求选项。
- `packages/coding-agent/src/extensions/mcp/tools.ts` 的工具 `execute` 收到 `_toolCallId`，但当前调用链没有把活动 WorkBuddy Session context 传给 MCP client。
- WorkBuddy hook 的 `generation_id`、`call_id` 等字段必须按宿主契约逐个映射。`generation_id` 未证明与 PD `submissionTurnId` 一一对应前，不得当作 Turn ID；`_toolCallId` 可作为 toolCallId 候选。

## 统一契约

### 主路径：MCP request metadata

1. MCP Server 将宿主原生字段规范化为内部 `HostSubmissionContext`：`sessionId` 必需，`submissionTurnId/toolCallId` 可选，来源标记为 `mcp_request_meta`。
2. 非 Codex 宿主使用 `_meta["pd.host-context.v1"] = { sessionId, submissionTurnId?, toolCallId? }`；Codex 映射原生 `threadId/sessionId` 与可选 `x-codex-turn-metadata.turn_id`。
3. `hostKind` 和 `workspaceDir` 来自 MCP Server 启动绑定，不能由 `_meta` 或模型参数自报。仅同一宿主、同一 Workspace 配置启动的受信 stdio MCP client 可走此路径；远程传输必须有独立认证主体。
4. 这不是放宽 PRI-1260 对普通 `hostSession` claim 的校验。模型/用户参数中的 claim 仍按既有轨迹验证或保持 unbound；只有 host-generated `_meta` 走前置绑定路径。若 `_meta` 与参数冲突，fail closed。
5. 最小身份元数据需有一次性 Workspace 级显式披露/授权，与完整会话采集授权分离。完整 conversation ingestion 关闭时，不读 transcript；若最小元数据授权开启，仍可保存 Session identity。
6. 可信 Session 绑定不要求目标轮正文已存在；`submissionTurnId` 缺失不否定 Session。身份绑定成功但目标未知/正文晚到时，进入 `waiting_for_target_evidence`，交由 PRI-1273 的证据补齐链处理。

### 兜底路径：PostToolUse / after_tool_call receipt

1. 仅当 MCP request `_meta` 缺失时，才依赖宿主正式工具完成事件捕获 `pd_submit_pain` 结构化回执；字段来自宿主事件，不来自模型参数。
2. 按宿主真实 envelope 解析 `pd.pain-submit-receipt.v1`，严格核验 capability/schema/status/painId/taskId、Workspace、host、原任务 input_ref 和确定性 taskId 映射；可用时匹配 toolCallId。
3. `submit_unconfirmed` 必须精确读回原 Task 后才能确认；多条不同调用匹配、身份冲突、跨 host/workspace、撤回或过期来源均拒绝自动绑定。
4. 通过原 Task `diagnostic_json` expected-value CAS 更新 `sessionIdHint/verifiedHostSession/receiptRef`；不创建第二条 Pain/Task，不新增全局队列或第二证据库。
5. 已授权 `governance_observations` 仅作兼容回放来源，必须按 host/tool/painId/taskId 精确查询；不得扫描通用 500/2000 行列表、宿主私有历史数据库或未登记目录。

## 安全与状态边界

- `submissionSessionId`、可选 `submissionTurnId` 与 `targetTurnId` 是不同概念；提交 Turn 只在明确的当轮语义下可作为目标 Turn。
- 不把 `sessionKey`、`generation_id`、`runId`、`turn_index`、最近消息或文本相似度自动映射成 Session/Turn。
- 身份和目标证据分别 CAS；身份恢复不伪造 `evidenceClass`。原任务活动租约、已验证冲突身份和终态任务不得被覆盖或重开。
- `waiting_for_receipt` 表示提交身份尚未恢复；`waiting_for_target_evidence` 表示 Session 已绑定但目标证据尚未满足。两者不得合并为无原因 pending。
- 任何宿主未通过真实入口、真实安装版本、持久化读回与 fallback 反例验收前，不得声明完整支持。

## 实施边界与工单映射

| 工单 | 更新后的职责 |
| --- | --- |
| PRI-1274 | 共享 `HostSubmissionContext`、MCP request metadata 主路径、Codex 身份/证据解耦、receipt fallback 和原 Task CAS |
| PRI-1275 | WorkBuddy/Pi MCP client 增加 `_meta` 请求选项，并从活动 Session context 传递 `sessionId` 与 `_toolCallId`；完成事件作为 fallback |
| PRI-1276 | OpenClaw MCP materializer 将 `sessionId/toolCallId` 传入 runtime 已支持的第四参数 `_meta`；完成事件作为 fallback |
| PRI-1273 | 只处理已绑定 Session 下的目标轮正文晚到；不负责恢复提交身份 |
| PRI-1272 | 汇总所有宿主的实际安装版本、字段支持矩阵和最后一个可证明的治理节点 |

本次 PR 仅更新 SPEC、技术设计、审计报告与 Linear 工单，不实现上述运行时代码。代码实现必须按各宿主独立分支评审，不能用文档声明替代真实安装验收。

## 可复核的源码位置

- PD：`packages/pd-mcp-server/src/server.ts`、`packages/pd-mcp-server/src/submit-assembly.ts`、`packages/host-runtime/src/governance-observation-store.ts`
- Codex：`codex-rs/core/src/mcp_tool_call.rs`、`codex-rs/core/src/responses_metadata.rs`
- Pi：`packages/mcp/src/client.ts`、`packages/coding-agent/src/extensions/mcp/tools.ts`
- OpenClaw 安装态：`dist/agents/agent-bundle-mcp-runtime.js`、`dist/agent-bundle-mcp-materialize-*.mjs`
