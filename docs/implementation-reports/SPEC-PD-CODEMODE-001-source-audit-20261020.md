# SPEC-PD-CODEMODE-001 v0.2 — PD/Pi 源码复核报告

**复核日期**：2026-10-20
**复核类型**：只读源码审计 + SPEC/执行指令修订。
**最终裁决**：**生产接入 NO-GO；现有场景资格门未通过。** 这不是说 Code Mode 技术上不能运行，而是当前没有足够证据证明它比更简单的确定性组合工具更值得进入 PD 内部运行时。
**真实模型 / 生产数据库 / Code Mode 集成 PoC**：未运行；本次任务没有执行付费模型调用，也没有修改生产代码、生产数据或 Pi 源码。

## 1. 基线与工作区状态

| 项目 | 复核值 |
|---|---|
| PD 本地 main（只读审计时） | bf5aed354f04a04437e67518f4efadd2937369f2，落后最新 origin/main 8 个提交；工作区有其他未跟踪文件，未修改或清理 |
| PD 最新 origin/main | ec66d23385b88a7f36442702ea862432435aa470，2026-10-19，提交说明：chore: version packages (#2091) |
| Pi 本地 checkout（只读审计时） | b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6，落后 origin/main 59 个提交；未切换分支或修改 |
| Pi 最新 origin/main | 73f8de80bc87021375f8b525292ac07492253002，2026-10-19 |
| Pi Code Mode 发布版本 | tag v1.3.0 @ 71023aec1546d6d677a65669c5665c0927ce0dd0，2026-10-15 |
| Pi Code Mode 与 tag 的源码差异 | git diff v1.3.0..origin/main -- packages/codemode：仅 CHANGELOG.md 新增 Unreleased 标题；Code Mode 源码未变 |
| PD 核心依赖 | @earendil-works/pi-agent-core 1.2.0、@earendil-works/pi-ai 1.2.0；没有 @earendil-works/pi-codemode |
| 目标 PD 源码漂移 | bf5aed354 与 ec66d2338 之间，artificer-l2-adapter、artificer-l2-tool-contract、l2-agent-loop-adapter、agent-tool-contract、internalization-consumer-cycle 均未变化；版本/依赖元数据已更新 |

## 2. 关键结论与证据

### F-01：Code Mode 是独立可选包，不是 PD 当前功能

- Pi tag v1.3.0 的 packages/codemode/package.json：包名 @earendil-works/pi-codemode，版本 1.3.0，依赖 quickjs-wasi 3.6.2；没有 pi-agent-core 依赖。
- Pi tag v1.3.0 的 packages/agent/examples/mcp-codemode/tools.ts，约 111–169 行：createCodemodeTool 把模型生成的 JavaScript 交给 CodemodeSandbox；脚本内工具结果不会逐项回到模型，只返回脚本输出和返回值。
- 该能力只在宿主主动注册 codemode 工具、注入工具集合后存在。PD 的 packages/principles-core/package.json 第 108–109 行仍只声明 pi-agent-core 1.2.0 和 pi-ai 1.2.0，没有 codemode。

**判断**：不能把“Pi 仓库有 Code Mode 包/示例”描述成“PD 已具备 Code Mode”。

### F-02：官方嵌套工具示例不是 PD 的即插即用实现

- Pi tag v1.3.0 的 packages/agent/examples/mcp-codemode/tools.ts，约 83–102 行：createNestedToolRunner 接收 Agent 实例，读取 agent.state.messages、agent.state.tools、agent.beforeToolCall、agent.afterToolCall，再调用 runToolCall。
- Pi tag v1.2.0 的 packages/agent/src/agent-loop.ts，约 790–819 行：runToolCall API 已存在，RunToolCallOptions 要求 tools、assistantMessage、context、可选 signal 与 before/after hooks；它执行参数准备、schema 验证、hook、工具执行和结果处理。
- PD 的 packages/principles-core/src/runtime-v2/adapter/l2-agent-loop-adapter.ts 和 artificer-l2-adapter.ts 使用 runAgentLoop，而不是 Agent 类。Artificer 约 527–545 行使用 beforeToolCall 白名单和 finishTurn；源注释解释其选择低层 loop 是因为需要精确控制 finishTurn、abort 与最终提交终止。

**判断**：不需要预设升级 pi-agent-core；1.2.0 有 runToolCall。但需要自建一个正确的低层 loop 上下文桥，不能直接复制依赖 Agent.state 的示例。若桥接需要复制/绕过 Pi 的参数校验或 PD 权限逻辑，应判 NO-GO。

### F-03：Node >=22.19 不是 Code Mode 新引入的门槛

- Pi tag v1.2.0 的 packages/agent/package.json：pi-agent-core 1.2.0 的 engines.node 已是 >=22.19.0。
- Pi tag v1.3.0 的 packages/codemode/package.json，约 66–68 行：pi-codemode 1.3.0 同样声明 >=22.19.0。
- PD 最新 origin/main 的 packages/create-principles-disciple/package.json 第 83–84 行仍声明 >=22.0.0。

**判断**：安装器声明与 Pi 依赖声明之间的差异是既有合同不一致，不应误报为 Code Mode 独有新增成本。未来 P3 若涉及安装器，需单独处理此问题；本次不扩大范围。

### F-04：Artificer 当前不构成明确的 Code Mode 优先候选

- PD 最新 origin/main 的 packages/principles-core/src/runtime-v2/adapter/artificer-l2-adapter.ts，约 425–434 行：系统协议明确四个工具及顺序：read_rulecode_spec → validate_rulecode → replay_rulecode → submit_rulecode。
- packages/principles-core/src/runtime-v2/tools/artificer-l2-tool-contract.ts，约 221–244 行：read_rulecode_spec 返回规范文本，模型需要在起草之前理解它。
- 同文件约 246–289 行：validate_rulecode 做确定性静态检查，不执行代码。
- 同文件约 292–358 行：replay_rulecode 构造 GoldenTrace 并调用现有 RuleHost gate；失败时返回案例与原因。
- 同文件约 361–406 行：submit_rulecode 仍运行权威 ArtificerValidator，并只捕获最终输出；约 409–415 行维护原有 whitelist。
- RuleCode 规范要求 GoldenTrace 为 2–10 个案例；当前源码没有提供证据说明 validate/replay 输出已构成显著上下文瓶颈。

**判断**：Code Mode 最多可能把 validate → 若通过则 replay 包成一次脚本调用。但这两个步骤是确定性步骤，B1 组合工具可以复用相同验证器/回放器并返回紧凑结果。read_rulecode_spec 的语义理解必须留给模型，不能靠一个先于读取结果就已生成的脚本替代。当前未证明 B2 相比 B1 有独特收益。

### F-05：Dreamer 当前不构成明确候选

- PD 最新 origin/main 的 packages/principles-core/src/runtime-v2/tools/agent-tool-contract.ts，约 132–168 行：read_principles 读取核心公理和激活原则；约 170–190 行：read_artifact 读取一个指定 artifact 或 sourceTask 相关 artifacts；约 192–212 行：submit_output 捕获最终输出。
- Pi tag v1.2.0 的 packages/agent/src/agent-loop.ts 实现 executeToolCalls / executeToolCallsParallel；没有被标记 sequential 的工具可以在一个 assistant turn 中并行执行。PD Dreamer 两个读取工具没有设置 executionMode: sequential。

**判断**：两个独立读取本来就可以在一个模型回合中并行发起，Code Mode 没有明确的回合节省空间。read_artifact 返回 contentJson，可能出现大输出；但本次未找到可用的聚合数据证明其实际大小或成本足以支持新依赖。应先测量或改善只读查询接口，而不是先引入 Code Mode。

### F-06：Diagnostician 是未来研究点，不是当前集成点

- PD 的 packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts 是 one-shot 调用路径。
- 本次审计没有找到已验证、可供 Diagnostician 使用的多步只读轨迹检索工具合同，足以支持通过 Code Mode 精确查询多个原始轮次。
- 先建立轨迹检索工具和 Agent Loop 再引入 Code Mode，会同时增加检索 API、执行循环、授权桥、审计与预算管理，尚无证据证明收益可覆盖复杂度。

**判断**：暂不适用。只有未来精确检索能力独立存在，并有重复多次检索/大结果上下文的真实证据，才重新评估。

### F-07：沙箱安全仍需要宿主治理

- Pi tag v1.3.0 的 packages/codemode/src/types.ts，约 24–27 行：inputSchema/outputSchema 主要用于声明/类型生成，不代表运行时自动验证。
- 同文件约 122–131 行：timeoutMs 默认 300000 ms，memoryLimitBytes 默认没有细粒度限制。
- 同文件约 150–162 行及 src/runtime/host.ts：acquireWorker / onWorkerStarted 用于把并发席位维持到 worker 实际退出。脚本输出上限来自 prelude-source.ts 固定常量，不能通过 CodemodeSandbox options 调低。
- Pi v1.3.0 CHANGELOG 的 1.0.1 项记录输出上限 16 Mi 字符和 100000 items；1.3.0 breaking change 明确 close()/结果 settle 与 worker 实际退出不同步。

**判断**：如未来进入 P0，必须显式设内存/墙钟/调用数/并发预算，并在嵌套工具桥处限制结果字节。上游 16 Mi 字符/100000 items 是固定上限，不是 per-sandbox 可配置值；执行后拒绝更小的超限最终输出不能阻止其在执行中累积。若实时更小输出上限必须靠 fork/补丁，须把它计入复杂度并重新过 U-04。每次嵌套调用仍要走 pi-agent-core 1.2.0 的 runToolCall 与 PD whitelist。脚本失败不能撤销之前已经执行的副作用。

### F-08：必须增加“先资格门、后 PoC”的流程

之前 v0.1 把 Artificer 直接列为优先实验候选，且让 P0/P1 看起来是默认要做的工程任务。这会把“能接入”误当成“值得接入”。

**修正**：v0.2 先要求 U-01 至 U-05：真实工作负载证据、可脚本化、可测收益、B1 简单方案不足、安全桥可行。任一门无证据就 NO-GO，零新增依赖、零生产代码。只有资格门 GO 后才执行真实沙箱 PoC 和 B0/B1/B2 对照。

## 3. U-01 至 U-05 当前状态

| 门 | 当前状态 | 原因 |
|---|---|---|
| U-01 真实工作负载 | NOT PROVEN | 本次只检查了源码与可用仓库材料，没有读取生产数据库或原始私有轨迹；未找到可引用的聚合数据证明回合/结果大小瓶颈 |
| U-02 可脚本化 | 部分成立 | Artificer validate/replay 是确定性步骤；但 B1 也可处理。Dreamer 读取可并行，Diagnostician 尚无合适工具面 |
| U-03 可测收益 | NOT PROVEN | 没有授权真实模型调用；fixture 不能证明真实 Token/费用/生成质量改善 |
| U-04 简单方案不足 | NOT PROVEN | 尚无对照证据证明确定性组合工具不足 |
| U-05 安全桥可行 | 技术上有可用 API，集成未验证 | pi-agent-core 1.2.0 有 runToolCall；PD runAgentLoop 的上下文/钩子桥、同轮 codemode + submit 冲突尚未实现或测试 |

**G0 裁决：NO-GO / NO CANDIDATE（证据门未通过）**。这是“当前不应增加 Code Mode 生产复杂度”的结论，不是对上游沙箱本身的安全认证。

## 4. 修订文件

- docs/specs/SPEC-PD-CODEMODE-001-v0.2.md：更新基线；纠正 Node 约束；不再默认优先 Artificer；增加 U-01–U-05 场景准入门；明确当前生产接入 NO-GO；说明官方 Agent 示例与 PD runAgentLoop 的适配差异；增加同轮提交冲突和宿主级资源预算要求。
- docs/specs/SPEC-PD-CODEMODE-001-zcode-execution-instructions.md：将任务改为资格门优先；没有候选时禁止安装依赖/写运行时代码/运行 P0/P1 集成 PoC；只有 U 门全部通过才进入隔离测试。
- docs/specs/SPEC-PD-IAER-001-v1.0.md 与 SPEC-PD-PI12-COMPAT-001-v0.2.md：更新到 v0.2 链接，并保持既有治理/兼容验收边界不变。

## 5. 实际执行与限制

- 已运行 git fetch origin，刷新 PD 与 Pi 的远端 refs；没有切换或修改 primary checkout、Pi checkout。
- 已运行 git diff 检查，确认目标 PD 实现文件在旧基线与最新 origin/main 间无变化；Pi Code Mode 的 v1.3.0 与最新 main 源码无差异。
- 已复核 package manifests、官方 nested tool 示例、runToolCall API、L2 adapters 和工具合同。
- 未运行 Code Mode 沙箱 PoC、Node/WASM/worker 兼容测试、B0/B1/B2 代码对照或真实模型 Pilot。原因是当前 G0 未通过；在没有真实候选时做这些测试会把技术可行性误当成产品价值。
- 未改生产代码、生产数据库、PD/Pi 运行时依赖或默认行为。
- 文档检查将在本次修改完成后执行并记录；Git commit/PR/merge 均未执行。

## 6. 最终建议

1. 保持当前生产接入 NO-GO。
2. 如果 Owner 希望重新打开 Code Mode 议题，先提供一条脱敏的真实工作流/聚合 telemetry：当前模型回合数、依赖工具序列、工具输出大小、实际 token usage/耗时，以及失败/证据丢失情况。
3. 用同一任务实现 B1 确定性组合工具并与现有路径比较。只有 B1 不足、且 Code Mode 的独特收益可测量时，才授权 P0/P1。
4. 真实模型效果必须经单独授权的 P2 试点确认。没有 P2 真实 PASS 与独立 Owner 批准，不进入 P3。

结论：**不要为了使用 Code Mode 而寻找任务；只有 PD 已存在、且简单方案解决不了的真实任务，才值得让 Code Mode 进入 PD。**
