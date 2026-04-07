# Subagent Workflow Helper 设计方案

**日期**: 2026-03-31  
**状态**: Revised after OpenClaw runtime audit on 2026-04-02  
**适用范围**: `packages/openclaw-plugin`

## 1. 背景

PD 当前最痛的问题，不是“不会启动子代理”，而是：

- 启动能力、完成信号、回收逻辑、落库逻辑被分散在多个模块里
- `runtime_direct` 和 `registry_backed` 两套语义被混用
- empathy / deep-reflect 在生产故障时几乎不可解释，只能翻日志猜
- timeout、boot session、hook fallback、cleanup 互相污染

这导致一个本来很简单的需求：

> 启动一个分析子代理，等待结果，读结果，写业务状态，安全清理

被实现成了一个高度脆弱的多路径系统。

## 2. 这次重新核实后的关键事实

以下结论来自当前本地 `D:/Code/openclaw` 源码核验。

### 2.1 默认 plugin runtime 的 `subagent` 不可用

在 `src/plugins/runtime/index.ts` 中，默认 plugin runtime 的 `subagent` 方法会直接抛错：

`Plugin runtime subagent methods are only available during a gateway request.`

这说明：

- plugin runtime 里的 `api.runtime.subagent` 不是默认总可用
- 如果没有额外绑定，插件不能假设所有入口都能直接跑 sidecar subagent

### 2.2 但“只有 gateway request scope 才能用”已经不是完整事实

当前 OpenClaw 还有一层 **process-global gateway subagent runtime**：

- gateway 启动时会安装 process-global gateway subagent runtime
- `createPluginRuntime({ allowGatewaySubagentBinding: true })` 会返回 late-binding proxy
- 这个 proxy 会优先解析：
  1. 显式 subagent
  2. process-global gateway subagent runtime
  3. 默认 unavailable runtime

这意味着：

- request scope 仍然是第一优先级
- 但某些非 request-scope 路径，只要启用了 `allowGatewaySubagentBinding`，仍可能通过 gateway fallback 成功运行

### 2.3 Feishu 不是“天然不能派生子代理”

当前 Feishu 路径并不是直接证明“插件 sidecar 永远不可用”。

相反，OpenClaw 的 auto-reply / embedded runner 路径已经显式把：

- `allowGatewaySubagentBinding: true`

传进运行链路。

所以更准确的结论是：

- Feishu 路径里的 plugin sidecar **不是绝对不可用**
- 但它依赖 gateway binding / fallback context，稳定性边界比纯 request-scope 路径更复杂

### 2.4 `subagent_ended` / `expectsCompletionMessage` 属于 registry-backed 语义

OpenClaw 里 `expectsCompletionMessage`、`registerSubagentRun(...)`、`subagent_ended` 的主要语义中心在：

- `sessions_spawn`
- subagent registry
- registry completion / announce / cleanup

而 plugin runtime 的 `runtime.subagent.run()` 本质上只是通过 gateway `agent` 方法启动一个 run，并不天然等价于：

- 注册 registry entry
- 自动进入 registry lifecycle
- 自动获得可依赖的 `subagent_ended` 完成协议

### 2.5 `boot-*` 不是普通用户消息的标准 session 形态

当前 OpenClaw 文档和代码能证明的是：

- `boot-*` 和 `BOOT.md` / gateway startup 相关

但不能证明：

- 普通飞书/聊天用户消息本来就应该落到 `boot-*` session

因此在 PD 里看到 `boot-*` 污染普通业务链路，应当视为：

- 特殊启动链路残留
- session/source 映射异常
- 不支持的 sidecar 入口

而不是“官方正常行为”。

## 3. 根因判断

这次复杂度爆炸，不是简单的“hooks 机制有毒”，而是 3 个问题叠在一起：

### 3.1 子代理能力边界没有先钉死

PD 过早假设：

- 所有入口都能稳定使用 `api.runtime.subagent`
- 所有 run 都能借 `subagent_ended` 做可靠回收

这两个假设都不成立。

### 3.2 混用了两套生命周期模型

当前代码同时混用了：

1. **plugin-owned runtime_direct**
   - `run(sessionKey, message)`
   - `waitForRun(runId)`
   - `getSessionMessages(sessionKey)`
   - `deleteSession(sessionKey)`

2. **OpenClaw-owned registry_backed**
   - `sessions_spawn`
   - `registerSubagentRun`
   - `expectsCompletionMessage`
   - `subagent_ended`

这两套模型可以共存，但不能在同一个 workflow 里混成一个“看起来都能用”的主协议。

### 3.3 业务需求远比实现简单

empathy / deep-reflect 的真实需求是：

- 启动
- 等待
- 读结果
- 落业务状态
- 尝试清理

但现在实现同时承担了：

- hook fallback
- boot 规避
- timeout 恢复
- completion announce
- sidecar cleanup
- 双路径 finalize

这是过度设计带来的复杂度，而不是业务本身复杂。

## 4. PR2 的明确目标

PR2 要解决的是：

> 把 PD 的 plugin-owned subagent 工作流统一成一套可观察、可恢复、可调试的 `runtime_direct` 主模型。

PR2 **不**解决这些事情：

- 不修改 `D:/Code/openclaw`
- 不把 OpenClaw 的 registry lifecycle 改成另一套协议
- 不保证所有入口都永远可用 sidecar subagent
- 不在第一阶段统一 Diagnostician / Evolution / Nocturnal

## 5. PR2 v1 的硬边界

### 5.1 helper v1 只支持 `runtime_direct`

第一阶段 helper 只建模：

- `transport = runtime_direct`

不把 `registry_backed` 作为并列 transport 一起做进来。

### 5.2 plugin-owned workflow 的主路径必须唯一

PR2 v1 的唯一主路径是：

1. `run(sessionKey, message)`
2. 记录 `runId`
3. `waitForRun(runId)`
4. `getSessionMessages(sessionKey)`
5. `finalizeOnce()`
6. `persistResult()`
7. `deleteSession(sessionKey)` 或显式进入 `cleanup_pending`

### 5.3 `subagent_ended` 只能是 fallback / observation

对 plugin-owned `runtime_direct` workflow：

- `subagent_ended` 不能作为主完成协议
- 它最多只能是：
  - fallback
  - observation
  - future compatibility hook
  - `UNPROVEN` signal

### 5.4 workflow 必须显式区分身份链

至少要统一持久化这些字段：

- `workflowId`
- `workflowType`
- `parentSessionId`
- `childSessionKey`
- `runId`
- `transport`
- `dedupeKey`

### 5.5 timeout / error 不能直接等于失败

helper 必须支持中间态：

- `waiting`
- `timeout_pending`
- `error_pending`
- `finalizing`
- `cleanup_pending`
- `completed`
- `completed_with_cleanup_error`
- `expired`

### 5.6 可观测性是强制交付物

PR2 不是“多写点日志”，而是必须新增 workflow 级可观测能力：

- `subagent_workflows`
- `subagent_workflow_events`
- workflow debug summary

至少要能回答：

- 这个 workflow 现在在哪个状态
- 最近一次 wait 发生了什么
- 最近一次读消息发生了什么
- 有没有 persist
- cleanup 成功还是失败
- 为什么没有完成

## 6. Surface 策略

PR2 需要明确区分“允许 sidecar”的 surface 和“必须降级”的 surface。

### 6.1 允许 sidecar 的 surface

仅当满足下面条件时，允许启动 helper 管理的 `runtime_direct` workflow：

- `api.runtime.subagent` 经 probe 检测为可用
- 当前不是 `boot-*` session
- 当前入口不被标记为不支持 sidecar
- workflow manager 能记录完整 identity chain

### 6.2 必须降级的 surface

以下情况必须降级，而不是硬跑 sidecar：

- `api.runtime.subagent` 不可用
- `boot-*` session
- 只能拿到不稳定/不可证明的 lifecycle 信号
- 无法保证 `runId` / `sessionKey` / `parentSessionId` 归因

## 7. 模块边界

### 7.1 helper 层负责什么

- workflow identity
- lifecycle 状态机
- wait/result/finalize/cleanup 编排
- idempotency / dedupe
- observability / event log / debug summary

### 7.2 workflow spec 负责什么

- prompt 构造
- 结果解析
- 业务持久化
- cleanup 策略
- timeout/finalize policy

### 7.3 业务模块负责什么

- empathy 的 pain/emotion 业务语义
- deep-reflect 的反思结果业务语义

## 8. 实施顺序

### 8.1 Task A: `subagent-helper-empathy`

只做：

- helper 最小内核
- empathy adapter
- workflow store / event log / debug summary

### 8.2 Task B: `subagent-helper-deep-reflect`

只在 Task A 收敛后开始：

- 接入 deep-reflect
- 修正 `runId/sessionKey`
- 验证第二条 `runtime_direct` 路径

## 9. 架构闸门

`architecture-cut` 阶段必须明确回答：

1. 当前 workflow 是否是 plugin-owned `runtime_direct`
2. 是否已经证明 `subagent_ended` 只能作为 fallback/observation
3. 主 finalize 路径是否唯一
4. 当前 surface 是否允许 sidecar
5. 如不允许，降级策略是什么

如果这 5 条里有任意一条无法回答，则不允许进入 `implement-pass-1`。

## 10. 成功标准

PR2 成功不是“helper merged”，而是：

- empathy / deep-reflect 不再混用两套生命周期模型
- `runId` / `sessionKey` / `parentSessionId` 归因清晰
- timeout/error 后 workflow 仍可解释
- `subagent_ended` 不再被当作 plugin-owned workflow 的主完成协议
- 维护者能按 `workflowId` 直接定位失败原因，而不是去日志里猜

## 11. 失败标准

出现以下任意情况，就说明 PR2 还没有成功：

- 仍然把 `subagent_ended` 当 empathy/deep-reflect 的主完成信号
- 仍然需要靠 hook 链来证明 `runtime_direct` 完成
- 仍然混淆 `runId` 和 `sessionKey`
- 仍然不能按 workflow 定位 timeout / persist / cleanup 问题
- 仍然在 `boot-*` 或 runtime unavailable surface 上强行跑 sidecar
