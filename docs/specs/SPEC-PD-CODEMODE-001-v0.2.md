# SPEC-PD-CODEMODE-001 v0.2 — PD Code Mode 价值门禁与最小兼容性验证

**复核日期**：2026-10-20
**状态**：Draft / Owner Review Required。当前裁决为 **生产接入 NO-GO；候选场景证据门未通过**。
**PD 基线**：远端 origin/main @ ec66d23385b88a7f36442702ea862432435aa470。与本规范相关的 Artificer、Dreamer、Host Consumer 源文件在 bf5aed354 与该基线之间未改变；版本和依赖元数据已更新。
**Pi 基线**：origin/main @ 73f8de80bc87021375f8b525292ac07492253002；Code Mode 正式发布 tag v1.3.0 @ 71023aec1546d6d677a65669c5665c0927ce0dd0。最新 Pi main 与 v1.3.0 的 packages/codemode 源代码无差异，仅 changelog 增加 Unreleased 标题。
**PD 当前依赖**：@earendil-works/pi-agent-core 1.2.0、@earendil-works/pi-ai 1.2.0；PD 未依赖 @earendil-works/pi-codemode。
**取代关系**：本版取代尚未合入的 v0.1 草稿，修正版本基线、Node 约束描述和场景优先级。它不改变 IAER、RuleHost、Owner Evidence Gate 或 Pi 1.2 兼容 SPEC 的授权语义。

## 0. 结论先行

**Code Mode 是一个可选的 JavaScript 工具编排包，不是 Pi Agent 自动具备的 PD 功能，也不是更高级的推理模型。** 模型先生成一段脚本，QuickJS 沙箱执行脚本并调用被注入的工具；中间工具结果不会自动交给模型逐步推理，只有脚本的输出和返回值回到模型。它适合可由确定性脚本处理的多工具链，不适合每一步都必须让模型理解结果、改变计划的工作流。

本次源码复核没有找到一个已由证据证明、明显值得在 PD 内部引入 Code Mode 的现成场景：

- **Artificer：不再默认列为优先候选。** 它有四个工具，验证和回放是固定的确定性前后步骤。普通组合工具可以实现同样的调用压缩，且不需要 QuickJS/worker/新依赖。
- **Dreamer：不列为候选。** 两项读取彼此独立，Pi 的 Agent Loop 支持同一轮并行工具调用；Code Mode 未证明能进一步减少模型往返。若问题是输出过大，先评估更简单的受限读取/摘要接口。
- **Diagnostician：暂不具备接入条件。** 当前路径主要是 one-shot 诊断，没有已验证的精确只读工具面。先增加 Code Mode 会同时增加检索 API、Agent Loop 和证据桥接复杂度，违背最小化原则。
- **RuleHost、关键词 Pain 检测、Owner 审批/激活：不适用或禁止。** 这些是确定性治理与授权边界，不应交给模型生成脚本。

因此，**当前不批准增加依赖、不批准生产接线、不批准默认开启**。Zcode 的第一步必须是证明存在真实候选任务；如果现有源码、脱敏聚合遥测和测试样本不能证明候选存在，应停止并交付 NO-GO 报告，不为了“完成开发”而制造 PoC 或复杂度。

## 1. 最新源码事实与校正

| 事实 | 复核结果 | 证据位置 |
|---|---|---|
| PD 依赖 | core 1.294.2 声明 pi-agent-core 1.2.0、pi-ai 1.2.0；没有 pi-codemode | packages/principles-core/package.json，依赖行 108–109；远端主干 package-lock.json |
| Artificer 工具合同 | read_rulecode_spec、validate_rulecode、replay_rulecode、submit_rulecode 四个工具；顺序写在系统协议中 | packages/principles-core/src/runtime-v2/adapter/artificer-l2-adapter.ts，约 425–434；tools/artificer-l2-tool-contract.ts，约 221–415 |
| Artificer 语义 | 静态验证不执行代码；回放依赖验证后的 RuleCode 与 2–10 个 GoldenTrace 案例；提交还有独立的权威 ArtificerValidator | tools/artificer-l2-tool-contract.ts，约 246–325、361–406 |
| Dreamer 工具合同 | read_principles、read_artifact、submit_output 三个工具；前两者只读，最后一项捕获最终结果 | packages/principles-core/src/runtime-v2/tools/agent-tool-contract.ts，约 132–212 |
| PD 的 Agent Loop | 两个 L2 Adapter 使用 runAgentLoop，而非 Agent 类；现有白名单和 finishTurn 承担安全/终止合同 | packages/principles-core/src/runtime-v2/adapter/l2-agent-loop-adapter.ts；artificer-l2-adapter.ts，约 527–545 |
| Pi 1.2 嵌套工具 API | pi-agent-core 1.2.0 已导出 runToolCall；其 RunToolCallOptions 需要 tools、assistantMessage、context、hooks 和 signal，并运行参数准备、schema 验证、before/after hooks | Pi tag v1.2.0，packages/agent/src/agent-loop.ts，约 790–819；packages/agent/src/index.ts |
| 官方 Code Mode 示例 | createNestedToolRunner 使用 Agent 实例的 state.messages/state.tools/hooks；createCodemodeTool 通过嵌套 runner 调工具。它不是 PD runAgentLoop 的即插即用适配器 | Pi tag v1.3.0，packages/agent/examples/mcp-codemode/tools.ts，约 83–169 |
| Code Mode 包 | @earendil-works/pi-codemode 1.3.0 是独立包，依赖 quickjs-wasi 3.6.2；不是 PD 已安装能力，也没有声明 pi-agent-core 作为依赖 | Pi tag v1.3.0，packages/codemode/package.json |
| schema 语义 | CodemodeTool 的 inputSchema/outputSchema 用于生成脚本声明，不会自动验证实际参数 | Pi tag v1.3.0，packages/codemode/src/types.ts，约 24–27 |
| Worker 生命周期 | 1.3.0 中结果或 close() 已返回不代表 worker 真正退出；需跟踪 acquireWorker 释放或 onWorkerStarted(exited) | Pi tag v1.3.0，packages/codemode/CHANGELOG.md；src/runtime/host.ts；src/types.ts，约 150–162 |

### Node 版本的正确解释

Pi 的 pi-agent-core 1.2.0 本身已声明 Node >=22.19.0；pi-codemode 1.3.0 也声明 Node >=22.19.0。PD 的 create-principles-disciple 安装器仍声明 Node >=22.0.0。这是 Pi 1.2 迁移之后已有的元数据约束不一致，**不能说成是 Code Mode 首次引入的 Node 版本门槛**。本 SPEC 不批准顺手升级 Agent Core，也不把这个既有问题隐藏掉；如未来进入 P3，应单独核对安装器、锁文件和发布合同。

## 2. Code Mode 什么时候才有价值

Code Mode 的有效工作形态是：

1. 模型先生成一段脚本；
2. 脚本调用多个已授权工具；
3. 中间结果可以由普通 JavaScript 做筛选、聚合或条件分支，不需要模型在每一步重新理解；
4. 只把精简后的、仍保留来源和证据引用的结果交回模型。

它不具备自己的模型推理能力。若步骤 B 必须根据步骤 A 的语义结果由模型重新规划，脚本本身不能替代这个推理回合，除非再开放模型调用；本 SPEC 禁止为实验开放 models.* 等额外计费能力。

### 使用场景准入门 U-01 至 U-05

必须全部有证据，才允许开展 Code Mode 适配实验：

- **U-01 真实工作负载**：现有代码、脱敏聚合遥测或可复现样本证明某个任务确实存在多次依赖调用/重复查询/大结果上下文成本。三次以上的依赖调用可作筛选提示，不是单独的 GO 标准。
- **U-02 可脚本化**：调用之间的条件与中间结果处理可以由确定性代码完成；不是把需要语义判断的步骤藏在脚本里。
- **U-03 价值可测量**：明确要减少哪项真实成本，例如模型回合、输入 Token、结果上下文或端到端耗时；不能只以“工具调用代码变少”作为收益。
- **U-04 简单替代方案不足**：先评估 B1 确定性组合工具。必要时可在测试/fixture 中写一次性、不可进入生产路径的 B1 原型；不得为此修改生产 Adapter 或新增依赖。如果 B1 可以提供相同的调用压缩和输出精简，则优先 B1，不引入 Code Mode。
- **U-05 安全桥可行**：能复用 Pi 的 runToolCall 参数验证与 hook pipeline、PD 现有白名单和审计，不绕过 Owner Evidence、提交验证或 finishTurn。

任一项没有证据、只是推测或需要先新建一套通用检索平台，结论均为 **NO-GO / NO CANDIDATE**。不安装 pi-codemode、不新增运行时抽象、不创建 feature flag。

## 3. 对现有 PD 场景的裁决

| 场景 | 当前实际机制 | Code Mode 的理论作用 | 本次裁决 |
|---|---|---|---|
| Artificer L2 | 先读取 RuleCode 规范；模型语义理解后起草；再静态验证；再 GoldenTrace 回放；最后独立提交并经 ArtificerValidator | 可在模型给定候选后，把 validate → 若通过再 replay 合成一次脚本调用，隐藏中间工具响应 | **当前 NO-GO 候选**。规范必须由模型先读懂；validate/replay 的确定性步骤可由 B1 组合工具实现同样的压缩。只有真实工作负载证明 B1 不够且 Code Mode 有额外收益才重开 |
| Dreamer L2 | 读取核心原则/激活原则、读取一个指定 artifact 或 sourceTask 的 artifacts、提交输出；读取操作互相独立 | 可筛选大型结果或合并输出 | **当前 NO-GO 候选**。前两项可在同一模型回合发起，runAgentLoop 可并行执行未标记 sequential 的工具；尚无大输出/重复查询收益证据 |
| Diagnostician | 现有 PiAiRuntimeAdapter 主要 one-shot，持久化诊断产物；本 SPEC 未找到已验证的多工具轨迹检索工具面 | 将来可能对多次精确轨迹读取、Pain/Correction/artifact 引用做确定性筛选 | **暂不接入**。先证明精确只读检索接口的独立价值；否则为 Code Mode 增建 tool loop 和 retrieval layer 会扩大架构 |
| RuleHost / 关键词 Pain | 确定性执行/检测 | 无合理优势 | 不适用 |
| Console Owner 审批、原则激活、恢复 | 权威治理操作 | 无可委托的脚本路径 | 禁止脚本化 |
| Pi Coding Agent 外部调用 PD 工具 | 与 PD 内部 Agent Runtime 不同的集成边界 | 若未来由 Pi 宿主编排大量 PD 只读工具，可单独评估上游示例 | 不在本 SPEC；不得宣称 PD 内部已支持 |

**Artificer 的关键比较**：B0 是现有 validate/replay 两次依赖调用；B1 是复用相同验证器与回放门的一个确定性组合工具；B2 是 Code Mode 脚本调用同一工具桥。若 B1 已把两个确定性步骤合并、保留全部错误详情和证据引用，B2 没有独特收益时应直接 NO-GO。不要为了“脚本可以并行”把有依赖的验证和回放并行执行。

## 4. 兼容性与安全要求（仅在 U-01 至 U-05 通过后适用）

- **不是即插即用**：官方示例依赖 Agent 实例及其 state/hooks；PD L2 使用 runAgentLoop，现有源码注释说明选择它是因为需要 finishTurn、beforeToolCall、abort signal 和精确终止语义。若适配，需要在外层 codemode 工具调用时捕获当前 assistantMessage/context，并用 pi-agent-core 1.2.0 的 runToolCall 对每个嵌套调用重新执行 schema 验证、before/after hooks 和白名单。不能直接调用 tool.execute。
- **工具批次互斥**：codemode 必须是该 assistant message 中唯一的外层 tool call；不允许它与任何其他外层工具同批，尤其是 submit_rulecode/submit_output。现有 runAgentLoop 可并行执行未标记 sequential 的工具，而 finishTurn 在整轮之后检查 outputCapture；必须显式拒绝混合批次并测试失败路径。
- **最小注入**：只允许必要的只读检索、静态校验和隔离回放；禁止 submit_*、Owner 标注/审批、原则激活、生产写入、文件系统、Shell、任意网络和递归 codemode。
- **运行时验证**：Codemode 的 JSON schema 仅为脚本生成声明，实际参数必须通过 runToolCall 运行时验证。structuredContent、文本错误、isError、部分成功、异常必须有明确的统一语义；错误文本不能伪装成成功。
- **资源预算**：每次执行显式设置有限 timeoutMs 与 memoryLimitBytes；Code Mode 默认内存上限没有细粒度限制（WASM 32 位空间），不能依赖默认值。Pi 上游的脚本输出上限为固定的 16 Mi 字符/100,000 items，并非 per-sandbox 可配置选项。宿主可以限制每个嵌套工具结果和累计输入字节、限制调用数/并发，并在返回后拒绝超出更小阈值的最终输出；但若要求脚本输出在达到更小阈值时立即被中止，就需要上游支持或维护补丁/分支，这会增加复杂度。禁止无限 Promise.all。
- **真实 worker 退出**：v1.3.0 的执行结果/close 结束不代表 worker 已退出；并发槽要由 acquireWorker 的 release 或 onWorkerStarted(exited) 真实退出信号释放。测试无限循环、Promise 微任务循环、Abort、超时和 worker 关闭竞态。
- **证据和副作用**：Owner Evidence/Scope Preflight 必须先于模型与脚本。脚本失败不会撤销已成功的嵌套工具调用；第一阶段所有工具必须无不可逆副作用，并从宿主侧记录调用审计与 evidenceRefs。
- **版本边界**：固定 pi-codemode 1.3.0，不升级 pi-agent-core 1.2.0 来照搬示例；先证明当前版本的 runToolCall 兼容。worker/WASM 打包问题未验证前不能加进安装器/生产包。

## 5. 分阶段执行

| 阶段 | 内容 | 出口 |
|---|---|---|
| G0：候选场景资格审查 | 只读检查最新 PD/Pi 源码、脱敏聚合报告和现有 telemetry；填 U-01 至 U-05 证据表 | 任一门不通过：NO-GO，停止，不添加依赖、不写运行时代码。当前默认处于此阶段 |
| P0：隔离兼容 PoC | 只有 G0 GO 才运行真实 QuickJS/WASM/worker；证明 pi-codemode 1.3.0 能与 PD pi-agent-core 1.2.0 的 runToolCall + runAgentLoop hooks 正确协作 | COMPATIBLE / BLOCKED；不触及生产路径 |
| P1：B0/B1/B2 对照 | 同一候选任务、同一工具权限/输入/证据，对比现有 L2、确定性组合、Code Mode；先固定离线 fixture，再记录质量/证据/调用与延迟 | GO / NO-GO / INCONCLUSIVE；如果 B1 同等或更简单，选择 B1 |
| P2：真实模型试点 | 配对任务真实模型调用、真实 Token/费用与质量评估 | 需 Owner 单独批准模型、样本、费用上限和停止条件；未授权必须 NOT_RUN |
| P3：生产接线 | 仅在 P2 有可复核净收益时，进行最小 Adapter 改动、打包、回滚和发版验证 | 需独立 Owner 批准；不默认开启 |

### 测量标准

- 质量：任务输出有效率/正确率、关键 evidenceRefs 保留率、证据 scope 错误、工具权限违规。
- 效率：模型回合、真实 Token usage、实际费用、端到端 p50/p95、嵌套工具数、worker 实际退出延迟。
- 复杂度：新增生产依赖、公共接口、安装资产、运行时开关、跨宿主差异、维护代码与故障分类数量。
- 离线 fixture 可验证安全合同与确定性结果，**不能证明真实模型会生成正确脚本，也不能证明真实 Token/费用节省**。usage 未提供时标 unavailable，禁止用字符数推算 Token。
- “延迟或 Token 成本改善 >=15%”仅是待预注册的候选阈值，不是已经批准的 AC；必须在真实模型试点之前由 Owner 冻结。
- 安全硬门：越权/未授权写入/跳过 Evidence Gate/跨 scope/关键证据丢失/未释放 worker = 0。任一失败直接 NO-GO，不允许用速度收益抵消。

## 6. 验收清单

- **AC-00**：U-01 至 U-05 都有源文件、聚合数据或可复现样本证据；没有候选时结论为 NO-GO，且依赖/运行时代码变更数为 0。
- **AC-01**：基线使用 PD origin/main ec66d2338…、Pi origin/main 73f8de80b… 和 Code Mode tag v1.3.0 71023aec…；报告明确本地 checkout 与远端 ref 的差别。
- **AC-02**：若进入 P0，证明 CodemodeSandbox 真正使用 QuickJS/WASM/worker，并与现有 pi-agent-core 1.2.0 的 runToolCall/hooks 兼容；不升级 Agent Core。
- **AC-03**：外层/内层授权、运行时参数验证、scope、审计均不能绕过；codemode 与 submit_* 同轮冲突被阻断。
- **AC-04**：无有效 Owner Evidence 时模型=0、脚本=0、回放=0、治理写入=0。
- **AC-05**：timeout、memory、输出字节、嵌套调用数、并发及 worker 真正退出有负面测试。
- **AC-06**：原有 submit_*/finishTurn/Evaluator/RuleHost/Console Owner 审批语义不变。
- **AC-07**：B0/B1/B2 使用同一冻结样本与权限；B1 是必须的复杂度/收益比较对象。
- **AC-08**：离线 fixture 与真实模型结果分开报告；未获授权的真实模型阶段为 NOT_RUN。
- **AC-09**：质量/证据/Token/费用/延迟未知值如实记录；不以工具调用数量减少冒充模型成本下降。
- **AC-10**：若 B1 提供同等收益且复杂度更低，选择 B1 并判 Code Mode NO-GO。
- **AC-11**：无 P2 PASS 与 Owner 独立批准，不接入生产、不新增默认行为、不发版。
- **AC-12**：最终报告列出最小改动、复杂度增量、残余风险和明确的 GO/NO-GO/INCONCLUSIVE。

## 7. Complexity Delta 与停止规则

在没有 U-01 至 U-05 证据前，预期的正确复杂度增量应为 **零**：不加依赖、不加公共 API、不加数据库字段、不加默认开关、不改 Adapter、不改变跨宿主行为。

如果未来候选通过资格门，新增依赖、QuickJS/WASM/worker 发布资产、runToolCall 桥接、嵌套审计、调用/并发/输出预算、工具批次互斥和对应回归测试都必须计入成本。只要简单的 B1 可以达到同样结果，便停止 Code Mode 方案。

立即停止条件：候选任务不存在、依赖/打包不兼容、必须绕过现有 hooks/白名单、证据无法溯源、worker 无法可靠回收、结果正确性下降、或对 B1 没有可复核的独特收益。

## 8. 相关规范

- [IAER v1.0](SPEC-PD-IAER-001-v1.0.md)：Owner Evidence、恢复和 RuleHost 的权威合同不变。
- [Pi 1.2 兼容 v0.2](SPEC-PD-PI12-COMPAT-001-v0.2.md)：本研究不能替代原 SPEC 的真实 LLM E2E 验收。
- [Code Mode 上游 README](https://github.com/earendil-works/pi/blob/v1.3.0/packages/codemode/README.md)、[1.3.0 changelog](https://github.com/earendil-works/pi/blob/v1.3.0/packages/codemode/CHANGELOG.md)、[嵌套工具示例](https://github.com/earendil-works/pi/blob/v1.3.0/packages/agent/examples/mcp-codemode/tools.ts)。
- [本次源码复核报告](../implementation-reports/SPEC-PD-CODEMODE-001-source-audit-20261020.md)：记录基线、证据、限制和修正理由。

**Owner 裁决请求**：当前建议保持生产集成 NO-GO。只有未来出现满足 U-01 至 U-05 的真实候选任务时，才授权 P0/P1；真实模型 P2 和生产 P3 始终需要单独授权。
