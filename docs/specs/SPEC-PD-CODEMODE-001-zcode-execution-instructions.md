# SPEC-PD-CODEMODE-001 v0.2 — Zcode 后端一次性源码复核与价值门禁指令

> **执行模式**：一次性完整任务；不要拆成反复等待人工审批的会话。
> **权威文件**：SPEC-PD-CODEMODE-001-v0.2.md。
> **当前默认裁决**：PD 内部 Code Mode 生产接入 NO-GO，现有候选场景资格门尚未通过。先证明真实场景，不能为了“完成 Code Mode 开发”先写集成代码。
> **授权范围**：只读源码复核、读取可合法访问的脱敏聚合报告、在独立 worktree 产出报告和文档修订。仅当 U-01 至 U-05 全部有证据时，才可继续隔离 P0/P1。**不授权真实付费 LLM、生产数据库写入、生产接线、Owner 审批、PR 合并或发版。**

## 0. 你需要回答的唯一核心问题

不要以“Code Mode 可以运行 JavaScript”作为成功。你要证明：

**PD 是否存在一个真实、重复、工具结果可由确定性脚本处理、且普通确定性组合工具不足以解决的工作流；在该工作流中，Code Mode 能否产生比简单方案更大的净收益，并且不丢证据、不绕治理边界？**

当前源码复核已发现：
- Artificer 有 4 个工具，read spec → draft → static validate → golden-trace replay → submit。validate/replay 的确定性步骤可由 B1 组合工具压缩，模型必须先语义理解 RuleCode 规范；当前没有证据证明 Code Mode 比 B1 更有价值。
- Dreamer 有 read_principles/read_artifact 两个独立读取工具和 submit_output。Pi runAgentLoop 支持一个 assistant turn 的并行工具调用；没有已证明的大输出/重复查询瓶颈。
- Diagnostician 目前没有已验证的多工具轨迹检索接口，主要是 one-shot；先为 Code Mode 增建检索层和 Agent Loop 会提高复杂度。
- Pi 官方 Code Mode 是单独 npm 包和接线示例，不是 PD 当前已有能力；官方示例基于 Agent 类，而 PD 的 L2 有意使用低层 runAgentLoop。

这些是起始假设。你必须复核最新源码和现有可访问证据；如果发现反证，按证据更新裁决。如果没有可验证候选，**立即停止代码开发，交付 NO-GO 报告**。

## 1. 工作区与安全边界

- PD primary/control plane：D:\Code\principles。它当前包含其他未跟踪文件和临时目录，严禁在 primary 修改业务文件、覆盖、清理、stash、reset 或提交。
- Pi 参考仓库：D:\Code\pi-mono。仅使用 git show、git grep、git diff 读取 v1.3.0 与 origin/main；不要 checkout、rebase 或改动此仓库。
- 当前 SPEC 来源：D:\Code\_worktrees\principles\adhoc-20261019-codemode-spec-alignment-369e05\docs\specs\SPEC-PD-CODEMODE-001-v0.2.md。
- 当前执行指令来源：同目录下 SPEC-PD-CODEMODE-001-zcode-execution-instructions.md。
- 禁止写入/恢复真实工作区状态、.pd 数据库、OpenClaw/Codex/WorkBuddy 已安装运行时、D:\.openclaw\workspace\.pd\state.db、真实轨迹库或用户私有证据。可使用 repo 内脱敏聚合报告、测试 fixture、临时数据库。
- 不调用付费模型，不读取/打印 API key，不设置 LLM_E2E_ENABLED=true，不启用额外模型 globals，不做网络/文件系统工具的 sandbox escape 测试。
- 不改 AGENTS.md、Owner Evidence Gate、RuleHost、Pain 关键词检测、Console 审批、激活、生产 Feature Flag 或任何默认运行路径。
- 不请求常规工程审批；在本授权范围内自主完成，遇到需要真实 Owner 证据/特权时标为 BLOCKED 并继续其他只读审计。

## 2. 最新基线（必须重新验证）

1. 读取 AGENTS.md、根 package.json、错误模式索引和本规范。
2. 在 primary 只读执行 git status -sb、git fetch origin、git rev-parse origin/main；不要假定当前 local main 是最新。
3. Pi 仓库执行 git fetch origin；用 git rev-parse origin/main、git show -s v1.3.0 和 git diff v1.3.0..origin/main -- packages/codemode 确认上游版本。不要改 Pi checkout。
4. PD 当前基线在撰写本指令时为 origin/main ec66d23385b88a7f36442702ea862432435aa470；Pi main 为 73f8de80bc87021375f8b525292ac07492253002；Code Mode v1.3.0 tag 为 71023aec1546d6d677a65669c5665c0927ce0dd0。若 ref 前进，使用最新源码并在报告中记录实际 SHA。
5. 相关 PD 实现文件在 bf5aed354 与 ec66d2338 之间未变化，但 package/lockfile 更新了。确认当前 pi-agent-core 仍是 1.2.0、PD 尚无 pi-codemode 依赖。
6. 检查 package engines：pi-agent-core 1.2.0 已声明 Node >=22.19.0；pi-codemode 1.3.0 也声明 >=22.19.0；create-principles-disciple 仍声明 >=22.0.0。这是现有的元数据约束不一致，不能误报为 Code Mode 新增的 Node 门槛，也不要在本任务顺带升级 Agent Core。

## 3. 必须复核的源文件与 API

PD：
- packages/principles-core/package.json：pi-agent-core/pi-ai 版本，是否有 pi-codemode。
- packages/principles-core/src/runtime-v2/adapter/artificer-l2-adapter.ts：工具协议、runAgentLoop、beforeToolCall、finishTurn、预算与 telemetry。
- packages/principles-core/src/runtime-v2/tools/artificer-l2-tool-contract.ts：四个工具真实执行语义、静态验证、回放、submit validator 和 whitelist。
- packages/principles-core/src/runtime-v2/adapter/l2-agent-loop-adapter.ts：runAgentLoop 的选择原因、工具并行/顺序、beforeToolCall、finishTurn。
- packages/principles-core/src/runtime-v2/tools/agent-tool-contract.ts：read_principles、read_artifact、submit_output 的实际数据范围与输出大小。
- packages/host-runtime/src/internalization-consumer-cycle.ts：Owner Evidence/Scope preflight 必须先于模型和 runner。
- 当前 telemetry/report/测试是否有脱敏的 Artificer L2 turn count、tool count、token usage、output size 和 latency 证据。不得为找数据直接读生产 state.db 或原始私有轨迹。

Pi：
- v1.3.0:packages/codemode/package.json、README.md、CHANGELOG.md。
- v1.3.0:packages/codemode/src/types.ts、runtime/host.ts、runtime/execution.ts、runtime/vm.ts、runtime/worker.ts、runtime/prelude-source.ts。
- v1.3.0:packages/agent/examples/mcp-codemode/tools.ts。
- v1.2.0:packages/agent/src/agent-loop.ts 和 src/index.ts，确认 runToolCall 在 PD 当前版本可用以及它的 RunToolCallOptions。
- 确认 CodemodeTool 的 JSON schema 仅用于脚本声明而不是 runtime validation；默认 timeout/memory/output/worker 语义来自实际源码，不靠猜测。

## 4. G0 — 使用场景资格门（最重要；必须先完成）

给每个候选填下表，证据必须来自源码、测试、脱敏聚合遥测或可重复 fixture，不能只是“可能更快”。

- U-01 真实工作负载：是否存在多次依赖工具调用、重复查询或大结果上下文瓶颈？给出调用序列、次数/结果大小、来源和时点。
- U-02 可脚本化：中间结果能否由普通 JavaScript 做确定性处理？若需要模型语义理解或重新规划，Code Mode 不能替代该推理回合。
- U-03 可测收益：减少的是模型回合、真实 Token、上下文、延迟还是费用？必须明确基线和测量方式。
- U-04 简单方案不足：必要时可在 fixture/测试范围构造一次性 B1 确定性组合原型，不得改生产 Adapter 或新增依赖；如果它能以更少依赖和更小权限面做到同样事情，选择 B1 并停止 Code Mode 方向。
- U-05 安全桥可行：是否可通过 pi-agent-core 1.2.0 的 runToolCall 复用参数校验、before/after hooks、PD whitelist 和 audit？不能直接 tool.execute，也不能绕过 Owner Evidence/finishTurn。

如果任何一项缺证据，或 B1 尚未证明不足，结果为 NO-GO / NO CANDIDATE。**此时不安装 pi-codemode，不创建运行时 flag，不写 adapter/tool-contract 代码，不跑 P0/P1 集成 PoC。** 仅在独立工作树输出审计报告并结束任务。这是正确完成，不是失败。

## 5. 只有 G0 GO 才可进入 P0/P1

### P0：隔离兼容性 PoC
- 固定 @earendil-works/pi-codemode 1.3.0；不升级 @earendil-works/pi-agent-core 1.2.0。
- 真正启动 QuickJS/WASM/worker，禁止用 eval、Node vm 或 mock 冒充 sandbox pass。
- 官方示例使用 Agent 类，而 PD 使用 runAgentLoop。需要捕获外层 codemode 调用时的 assistantMessage/context，再调用 runToolCall 并传入当前 tools、beforeToolCall/afterToolCall、signal；不能把示例直接复制过来。
- 每个嵌套调用都重新过参数 schema 验证、现有白名单和 hook。不要直接 tool.execute。不能把 submit_rulecode/submit_output 暴露给脚本。
- 要求 codemode 是其 assistant message 中唯一的外层 tool call；禁止与任何其他外层工具同批，尤其是 submit_*。写测试验证混合批次被拒绝。因为 runAgentLoop 默认可并行执行工具，且 finishTurn 在工具批次之后检查 outputCapture，同轮组合可能造成竞争/越权语义。
- 显式设置 timeoutMs、memoryLimitBytes、宿主级最大嵌套调用数/并发数/嵌套工具结果字节数与费用/墙钟预算。上游 16 Mi 字符/100000 items 输出上限是固定常量，不是每实例可调；宿主可限制嵌套工具结果，并在执行后拒绝超限最终输出，但更严格的脚本输出实时中止需要上游支持或维护补丁。若这项成本不可接受，判 NO-GO。
- 1.3.0 的执行结果/close 返回不等于 worker 真正退出；使用 acquireWorker release 或 onWorkerStarted(exited) 直到实际退出才释放并发槽。
- 只注入无副作用读取/静态验证/隔离回放工具。无有效 Owner Evidence 时模型=0、脚本=0、回放=0、治理写入=0。
- Windows Node >=22.19 必须验证。若 Linux clean install 未跑，标 NOT_RUN。不要更改生产安装器或 release-locks。

### P1：B0/B1/B2 对照（仅在 P0 PASS 后）
- B0：现有 L2 workflow。
- B1：确定性组合工具，复用原有验证器/回放器，不复制第二套规则。
- B2：Code Mode 脚本调用相同白名单工具并返回同等质量的精简结果。
- 三组用同一候选任务、证据、权限、GoldenTrace、模型配置（如无真实模型则全部是 fixture）和预算。
- 离线 fixture 可验证合同与确定性结果，不能证明真实 LLM 会生成正确脚本，也不能证明 Token/美元费用下降。不能把 fixture PASS 写成产品 GO。
- 记录任务正确性、evidenceRefs、scope、工具调用、模型回合（只有真实计数才填）、Token/费用（provider usage 才填）、p50/p95、worker 实际退出、错误率和复杂度增量。
- 任何越权、证据丢失、跨 scope、未授权副作用、未释放 worker 或预算失守都直接 NO-GO。若 B1 与 B2 收益相当，选 B1。

## 6. 真实模型与生产边界

- P2 真模型 Pilot 必须由 Owner 单独授权模型、样本、费用上限、运行环境和停止条件；本指令未授权。未获授权必须 NOT_RUN。
- P3 生产接线需 P2 真实 PASS、独立 Owner 批准、CI/打包/回滚验收；本指令未授权。不能默认开启、不能发版、不能 merge。
- 没有候选场景时不要建议“为了测量效果先加生产 flag”。零新增代码和零新增依赖是当前正确的默认结果。
- 不检查/改写真实生产 DB、不伪造 Owner Evidence、不让 Code Mode 审批或激活原则。

## 7. 报告与最终裁决

在自己的独立 worktree 生成：
docs/implementation-reports/SPEC-PD-CODEMODE-001-source-audit-20261020.md（若实际执行日期变化，文件名按实际日期更新）。

报告至少包含：
1. PD/Pi/Code Mode 精确 commit/tag、工作树状态和依赖版本。
2. 每项关键结论的文件路径、行号/符号、真实源码事实。
3. U-01 至 U-05 候选场景矩阵；清楚写明哪些证据缺失。
4. Artificer / Dreamer / Diagnostician 为什么适合或不适合；B1 对比。
5. P0/P1 是否进入；如未进入，写 NO-GO / NO CANDIDATE，不要为了完成任务造 PoC。
6. 若 P0/P1 进入，列每条实际测试命令、退出码、失败详情和 fixture 原始结果。
7. 离线与真实模型证据严格分离；未获授权的 P2/P3 必须 NOT_RUN。
8. Complexity Delta、残余风险、重新打开 G0 所需的最小证据。

工作流程：
- 用仓库官方 npm run dev:worktree、npm run dev:lease、bootstrap/ready 脚本；不要在 primary 写文件。
- 从本任务 SPEC 来源工作树复制 v0.2 SPEC、此执行指令、IAER/Pi 兼容附录和相关审计材料到新工作树前，检查目标文件是否已存在且是否归属他人；不覆盖未知文件，复制后比较 SHA-256。
- 只在自己的分支修改报告/文档；不自动 merge、push main、关闭 hooks 或清理别人的文件。
- 执行 git diff --check、仓库文档结构检查和必要的报告链接检查。记录实际命令/退出码。
- 若 G0 NO-GO，只交付报告与文档，不安装 Code Mode、不运行真实模型、不修改 PD 生产代码。

最终回复仅汇报事实：G0 裁决、候选与证据、是否产生代码/依赖增量、实际验证、未完成/NOT_RUN 项、报告路径与下一步所需证据。不要将“成功写了报告”描述成 Code Mode 已经可用于 PD。
