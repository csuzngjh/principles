# PRI-419 实施计划 — Dreamer L2 Agent Loop

> **Status**: Approved (2026-06-16) — owner exception under ADR-0014 Amendment (2026-06-16)
> **Scope**: dreamer runner only. New `L2AgentLoopAdapter` (multi-turn loop + read-only tools), flag-gated, reversible.
> **Branch**: `feat/pri-419-dreamer-l2-agent-loop`
> **Linked**: PRI-419 (PRD), ADR-0014 amendment (2026-06-16), `spike-tool-use.mjs` (P1.0a gate)

## v1 → v2 硬修正（全部经 pi-ai 源码核实）

| # | v1 问题 | 源码证据 | v2 修正 |
|---|---|---|---|
| P0-1 | Module 2 用 `shouldStopAfterTurn` 但 Module 3 用 `Agent` 类——`Agent.createLoopConfig()` 不转发它 | `agent.ts:422-449` | L2 adapter 建在低层 `agentLoop()` 上 |
| P0-2 | submit_output 靠 `terminate:true`，但 `shouldTerminateToolBatch` 是 `.every()` | `agent-loop.ts:544-546` | 用 `shouldStopAfterTurn` 检测 capture 终止 |
| P0-3 | L2 依赖模型原生 tool-use；本地 qwen3.6 不支持 | dogfood probe | P1.0a tool-use spike 前置门 |
| P0-4 | pi-agent-core 用 `typebox@1.1.38`，PD 用 `@sinclair/typebox`，禁 `as` | `packages/agent/package.json:34` | 工具 schema 用 typebox；DreamerOutputV1 经 Check 重声明 |

## 目标架构

```
pain-signal-runtime-factory
      │
flag l2_dreamer=on? ──no──► PiAiRuntimeAdapter (L1, 不动)
      │ yes
      ▼
L2AgentLoopAdapter (implements PDRuntimeAdapter)
      │ 内部调用低层 agentLoop(prompts, context, config, signal)
      │   context.tools = [submit_output, read_principles, read_artifact]  (typebox)
      │   config.shouldStopAfterTurn = outputCaptured || turnCount>=maxTurns
      │   config.beforeToolCall = enforceReadOnlyWhitelist
      │   signal = AbortController + 总墙钟预算
      ▼
await EventStream → transcript
      │
outputCaptured? ──yes──► submit_output.details (DreamerOutputV1)
      │ no
      └──► fallback: 最后一条含 text 的 assistant 消息 → L1 三路径提取
```

不变量：`BasePeerRunner.run()` / dreamer `invokeRuntime` 不动；两路径同输出 schema、同 `validateOutput`、同 PIArtifact；只读工具注入 core 现成 store，零进程派生。

## 模块

- **M1 工具契约(core)**：`runtime-v2/tools/agent-tool-contract.ts`，typebox schema，`buildDreamerL2Tools(ctx)`。
- **M2 submit_output + 终止(core)**：shouldStopAfterTurn 检测 capture；maxTurns=5；总墙钟预算；convertToLlm；fallback 取最后含 text 的 assistant 消息走三路径。
- **M3 L2AgentLoopAdapter(core)**：`adapter/l2-agent-loop-adapter.ts`，implements PDRuntimeAdapter，kind=`pi-ai-l2`。
- **M4 flag**：`l2_dreamer` quiet 默认 off；工厂注入点 + cacheKey 含 flag 值。
- **M5 prompt 复用**：复用 `DreamerPromptBuilder.buildPrompt()` + 工具使用说明追加。
- **M6 依赖升级 + typebox 桥接**：新增 `@earendil-works/pi-agent-core@^0.79.4`；升级 pi-ai scope；DreamerOutputV1 typebox 重声明 + Check 一致性测试。
- **M7 遥测**：`dreamer_l2_turn` / `dreamer_l2_complete`（含 turnCount/toolsInvoked/usedFallback）。
- **M8 ADR amendment**：已写入 `docs/adr/0014-...md`（2026-06-16 amendment）。

## 阶段

| 阶段 | 内容 | flag | 验收 |
|---|---|---|---|
| P1.0a | tool-use spike | — | 模型发起 tool_call 并消费结果 |
| P1.0b | ADR + flag + RuntimeKind + 遥测类型 + 依赖升级 + typebox | — | amendment 合入；L1 测试绿；typebox 一致性绿 |
| P1.1 | M1+M2+M3 core 实现（基于 agentLoop） | off | unit/integration 绿 |
| P1.2 | 工厂 flag 接线 + e2e | off(test-double) | e2e 合法输出；arch-regression 绿 |
| P1.3 | PRI-407 L1 baseline | — | L1 质量基线 |
| P1.4 | 3-arm 对比（L1 baseline vs L2） | 翻 on(内部) | grounding 显著优于 L1 才上线 |

时序纪律：P1.3 先于 P1.4——避免更贵架构掩盖 prompt/模型根因。

## Follow-up notes

- **resolveL2Model / resolveModel 合并**：当前 `L2AgentLoopAdapter.resolveL2Model` 与 `PiAiRuntimeAdapter.resolveModel` 的 custom-model 构造逻辑重复，因为 L1 import `@mariozechner/pi-ai`、L2 import `@earendil-works/pi-ai`（双 scope 不能交叉 import）。**当 L1 升级到 `@earendil-works` scope 后，应合并为一个共享 resolve 函数**，消除漂移风险。升级 pi-agent-core 后须重新验证 `resolveL2Model` 返回值与 live provider 路径一致（见代码中 RUNTIME_CONTRACT 注释）。
- **principle reader 去重（P2-2 follow-up）**：`makeDreamerPrincipleReader`（pd-cli）与 plugin 内联实现几乎相同。若未来第三个消费方出现，提取到 `@principles/core` 的 `buildL2PrincipleReader(stateDir)` 共用；当前两处可接受。

## 风险

目标模型不支持原生 tool-use（高，spike 前置）；Agent 类不支持 shouldStopAfterTurn（高，改用 agentLoop）；terminate every() 语义（高，改用 shouldStopAfterTurn）；多轮放大延迟成本（中，总预算+turn cap+token cap）；typebox 类型墙+禁 as（中，typebox 重声明+Check）；升级 breaking（中，双 scope 并存退路）；复制 OpenClaw 能力（中，不做 search_codebase）；L1 baseline 未测（中，P1.3 前置）。

## ERR 核对

ERR-001/005（校验不用 as）、ERR-009/010（缺字段 fail loud）、ERR-015/018/019（loop fresh state）、ERR-014/016/017（safeStringifyPreview）、ERR-002（不静默降级）、ERR-011/012（arch-regression baseline 不丢条目）。
