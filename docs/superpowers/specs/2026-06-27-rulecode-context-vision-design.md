# RuleCode 上下文视力与策略编译设计

> 文档版本：3.0（2026-06-27 评审修订）
>
> 实施能力版本：RuleContext v2
>
> 状态：Design ready for maintainer review，尚未批准实施
>
> 代码基线：main@89c0cd09

## 0. 决策摘要

本设计升级 PD 的 code_tool_hook / RuleHost，使规则可以基于有边界的行为上下文做确定性判断，而不再只能检查当前一次工具调用。

本次只推进 RuleContext v2：

- 读取当前 session 的近期工具轨迹；
- 提供经过验证的历史调用和确定性行为事实；
- 让 Golden Trace、Artificer、Evaluator 和生产 RuleHost 使用同一上下文契约；
- 通过 Owner 审批、feature flag 和 activation deactivate 保持可治理、可回滚。

本次不交付 dialogSignals。恒为默认值、没有产品行为的字段不满足 MVP 门，也会把 unknown 误写成 false。对话语义视力必须等到有 Owner 标注样例和可验证需求后单独设计。

本设计不会把 PD 变成任务执行器。PD 可以阻止不符合 Owner 原则的工具调用，并解释缺少的前置条件；是否真正访谈、计划或执行下一步仍由宿主 Agent 负责。

## 1. 问题定义

### 1.1 当前问题

当前 RuleHostInput 主要描述当前 action。规则可以拦截写系统目录等单点危险行为，但无法可靠判断：

- 是否读过目标文件再修改；
- 是否在连续失败后仍未调查；
- 是否在缺少全局搜索时跨多个文件写入；
- 是否在被同一规则拦截后继续重试同一动作。

问题不只是 RuleHost 缺少字段。现有 Golden Trace 只能表达 toolName + params，Artificer 只看到 Scribe 的抽象原则，无法生成并验证真正依赖历史上下文的规则。

### 1.2 决策问题

如何在不引入热路径 LLM、不增加规则级可变状态、不跨越 PD 产品边界的前提下，把 Owner 的纠正编译为可验证、可版本化、可回滚的上下文策略代码？

### 1.3 成功标准

交付成功必须同时满足：

1. 生产 RuleHost 能读取有界、可信、可降级的历史上下文。
2. Artificer 能看到来源证据，并生成上下文规则与正反 Golden Trace。
3. replay 和生产 gate 对同一场景构造相同的 RuleHostInput。
4. 上下文不可用时不会被解释为“没有调研”。
5. v1 规则、prompt 和 defer_archive 通道不受影响。
6. Owner 能看到规则依据、预期影响和停用路径。

## 2. 产品与架构边界

### 2.1 属于 PD 的范围

- Owner 关注的行为证据；
- 行为模式到 RuleCode 候选的编译；
- 正例、反例和对抗样例 replay；
- Owner 审批、拒绝、停用和版本升级；
- 后续同类行为是否被规则改变的可观察证据。

### 2.2 不属于 PD 的范围

- 通用任务规划和执行；
- 自动替 Agent 发起需求访谈；
- 通用记忆或宿主工具重试；
- 未经 Owner 审批的自主价值判断；
- model_training、Trainer、BALM、LRAS、GAP 或 MissionScheduler。

### 2.3 核心原则

高级智能放在冷路径的“证据理解、策略编译和测试”阶段。

热路径 RuleHost 保持同步、确定、快速、无 I/O 能力。它只读取预先构造的 JSON 快照并返回 allow、block、requireApproval 或 auto_correct。

本版本生产验收只承诺 allow 和 block。当前 requireApproval 只记录事件并放行，不能当作真实中间档。

## 3. 当前代码基线

### 3.1 已有资产

| 资产 | 当前状态 | 本设计用法 |
|---|---|---|
| TrajectoryDatabase.tool_calls | 已存 session_id、tool_name、outcome、params_json、created_at | RuleContext v2 的唯一工具历史数据源 |
| WorkspaceContext.trajectory | 生产 hook 已有懒加载实例 | gate 直接复用，不创建 ControlUiDatabase |
| buildRuleHostAction | 纯函数，统一路径提取和归一化 | 生产与 replay 共用 |
| ArtificerL2Adapter | 已有 read spec、validate、replay、submit 工具循环 | 扩展上下文规范和场景测试 |
| Evaluator adversarial replay | 已有对抗回放 | 增加上下文缺失、截断和误伤样例 |
| code_rule_capability | 已注册且默认开启 | 保持现状，不代替本次上下文 flag |

### 3.2 当前缺口

- GoldenTraceCaseInput 没有上下文字段。
- createSyntheticRuleHostInput 的 session 只有默认值。
- refiner sandbox 无法重放历史场景。
- ArtificerRunner 只读取 Scribe artifact，没有行为样例包。
- gate 手工构造 action，未完全复用 buildRuleHostAction。
- session-tracker.blockedAttempts 是会话总数，不能证明同一动作重试。

## 4. RuleContext v2 契约

### 4.1 版本化原则

RuleHostInput 保留现有 action、workspace、session、evolution 和 derived 字段，并新增可选 context。

旧规则不读取 context，行为保持不变。新规则必须声明 requiresContextVersion: 2，并在 input.context 不可用时返回 allow。

~~~typescript
export interface RuleHostInput {
  // existing fields unchanged
  context?: RuleContextV2;
}

export interface RuleContextV2 {
  version: 2;
  history: RuleHistoryWindow;
  facts: RuleBehaviorFacts;
}
~~~

### 4.2 历史窗口

~~~typescript
export interface RuleHistoryWindow {
  status: 'available' | 'unavailable';
  unavailableReason?: string;
  truncated: boolean;
  calls: ReadonlyArray<RuleToolCallRecord>;
}

export interface RuleToolCallRecord {
  sequenceId: number;
  toolName: string;
  canonicalKind: 'read' | 'search' | 'write' | 'execute' | 'agent' | 'other';
  normalizedPath: string | null;
  paramsSummary: Record<string, unknown>;
  outcome: 'success' | 'failure' | 'blocked';
}
~~~

sequenceId 使用 SQLite tool_calls.id，不使用可能重复的 created_at 排序，也不伪装成“相对 session 时间”。

历史默认最多返回 20 条。查询读取 limit + 1 条来计算 truncated，输出仍限制为 limit 条。

### 4.3 确定性行为事实

原始 calls 保留通用表达能力；facts 只提供当前验收场景所需的确定性结果。

~~~typescript
type EvidenceState = 'yes' | 'no' | 'unknown';

export interface RuleBehaviorFacts {
  priorReadOfTarget: EvidenceState;
  readCount: number | null;
  writeCount: number | null;
  uniqueWritePathCount: number | null;
  sameActionBlockCount: number | null;
}
~~~

当 history.status 为 unavailable 时：

- priorReadOfTarget 必须为 unknown；
- 所有计数必须为 null；
- 规则不得把 unknown/null 当作没有调研；
- 生产路径记录结构化降级原因，但继续执行现有 action-only 规则。

### 4.4 工具规范化

RuleCode 不应硬编码 write/edit/read/grep 等少数名称。宿主必须用统一工具分类生成 canonicalKind，覆盖现有 aliases：

- read、read_file、read_many_files；
- grep、grep_search、search_file_content、glob；
- write、write_file、edit、edit_file、replace、apply_patch；
- bash、exec、execute、run_shell_command；
- sessions_spawn 等 agent tool。

工具分类纯逻辑应放在 principles-core，openclaw-plugin 与 Golden Trace 共用，避免生产和 replay 漂移。

## 5. 数据源与生产装配

### 5.1 唯一数据源

在 TrajectoryDatabase 增加 getRuleHostContextRows(sessionId, limit)。

不得在 ControlUiDatabase 增加运行时读取。ControlUiDatabase 是 analytics read model，其构造会打开数据库并初始化视图，不适合 before_tool_call 热路径。

不得新增 params_summary 或 normalized_path 列。现有 params_json 已是经过脱敏和边界限制的证据快照。

### 5.2 查询与验证

查询使用：

~~~sql
SELECT id, tool_name, outcome, params_json
FROM tool_calls
WHERE session_id = ?
ORDER BY id DESC
LIMIT ?
~~~

读取后反转为 FIFO。

SQLite row 和 JSON.parse 结果都按 unknown 处理：

- params_json 必须解析为非数组对象；
- outcome 必须显式校验枚举；
- tool_name 必须为非空字符串；
- 任一关键字段异常时返回 history.status=unavailable，并记录原因；
- 禁止用 as 绕过验证。

是否新增复合索引由真实 EXPLAIN QUERY PLAN 和基准决定，不在未测量前宣称“实测小于 5ms”。

### 5.3 gate 装配顺序

before_tool_call 的顺序是：

1. 用 buildRuleHostAction 构造当前 action。
2. 在独立 try/catch 中读取并验证历史。
3. 构造 context 或结构化 unavailable 状态。
4. 调用 RuleHost.evaluate。
5. 对 block 使用现有 recordGateBlockAndReturn。

历史读取失败不得跳过 RuleHost.evaluate，否则一个 analytics 查询故障会让所有既有安全规则失效。

### 5.4 同一动作拦截计数

不使用 session-tracker.blockedAttempts。

sameActionBlockCount 必须来自持久化 gate_blocks，并至少按以下键匹配：

~~~text
sessionId + canonicalKind + normalizedPath
~~~

如果生产数据无法可靠构造该键，本版本删除 sameActionBlockCount 和对应验收，不使用会话总 block 数冒充。

## 6. Golden Trace 上下文场景

### 6.1 场景契约

GoldenTraceCaseInput 和 GoldenTraceCase 新增可选 ruleContext。

~~~typescript
export interface GoldenTraceCaseInput {
  // existing fields unchanged
  ruleContext?: RuleContextV2;
}
~~~

声明 requiresContextVersion: 2 的规则，其 Golden Trace 每个 case 都必须显式提供 ruleContext。禁止由测试工具静默填充“看起来合理”的历史。

### 6.2 必须同步修改的路径

- GoldenTraceCaseSchema；
- GoldenTraceCaseInput TypeBox 镜像；
- ArtificerRuleOutput schema；
- buildGoldenTraceFromArtificer；
- createSyntheticRuleHostInput；
- refiner-sandbox-wrapper；
- replay_rulecode tool；
- Evaluator positive/adversarial trace 合并；
- rule artifact assembly；
- RuleHostWriter canActivate 兼容性检查。

### 6.3 生产一致性

至少一条测试必须从生产 schema 初始化的临时 workspace 开始：

~~~text
recordToolCall
→ before_tool_call
→ TrajectoryDatabase query
→ RuleHostInput.context
→ active SQLite RuleCode
→ block/allow
~~~

只测试 helper、手工 RuleHostInput 或字符串包含关系不算生产验收。

## 7. Artificer：从代码生成器升级为策略编译器

### 7.1 必须联动

只扩展 RuleHostInput 会形成“运行时看得见，生成器和测试看不见”的断链。Artificer、Golden Trace 和 Evaluator 必须与 RuleContext v2 同一交付。

### 7.2 BehaviorExamplePack

Artificer 输入新增一个有界、经过验证的 BehaviorExamplePack：

~~~typescript
export interface BehaviorExamplePack {
  sourceNegativeCase: GoldenTraceCaseInput;
  ownerDesiredOutcome: string;
  positiveCounterexamples: ReadonlyArray<GoldenTraceCaseInput>;
  evidenceRefs: ReadonlyArray<string>;
  redactionNotes: ReadonlyArray<string>;
}
~~~

它只包含当前 pain 链路中的证据，不引入通用记忆或任意代码库搜索。

I/O 装配由 openclaw-plugin 的 BehaviorExamplePackAssembler 负责。它沿 sourcePainId / sourceTaskId 读取现有 pain lineage 与 trajectory，并把经过脱敏、限长和 runtime validation 的 pack 交给 Artificer。

principles-core 只定义类型、validator 和纯转换逻辑，不读取 SQLite。若 lineage 缺失或 pack 无法验证，v2 RuleCode 生成必须 fail loud；已有 prompt / defer_archive 价值链继续可用。

首版最多：

- 1 个来源负例；
- 3 个正例；
- 5 个 evidenceRefs；
- 每个字符串沿用现有 evidence sanitizer 边界。

### 7.3 Artificer 工具协议

保留现有四个工具，不新增通用 I/O：

1. read_rulecode_spec：读取 RuleContext v2 ABI、unknown 处理规则和示例。
2. validate_rulecode：静态检查代码和 requiresContextVersion。
3. replay_rulecode：使用带 ruleContext 的正反场景回放。
4. submit_rulecode：提交代码、场景、affectedTools 和上下文版本。

ARTIFICER_PROTOCOL_INSTRUCTION 不再写“只检查 input.action”，而应明确：

- 只读取 input.action 与 input.context；
- context 缺失或 unavailable 时必须 allow；
- 优先使用 canonicalKind 和 facts；
- 原始 calls 只用于 facts 无法表达的场景；
- 不得根据空数组推断“没有做过”。

### 7.4 Evaluator 职责

Evaluator 除现有 intentConsistency、scopePrecision、traceCoverage 外，必须检查：

- unavailable context 不误拦；
- truncated history 的边界行为；
- 工具 alias 规范化；
- 同路径与相似路径不会被 substring 误判；
- 正例不会因扩大历史窗口而转为 block；
- 新规则与当前 action-only 规则组合后仍符合预期。

本版本不引入 N 个候选、择优、变异的演化搜索。先证明一条真实 Owner 规则能稳定通过生产闭环。

## 8. 运行时决策与能力上限

### 8.1 本版本能做到

- 对有界工具历史做确定性模式判断；
- 将 Owner 原则编译为可持久化 RuleCode；
- 在 replay 与生产使用相同上下文；
- 对上下文缺失、截断和不可信输入明确降级；
- 通过 activation deactivate 即时停用单条规则。

### 8.2 本版本不能做到

- 理解任意自然语言对话；
- 自动判断所有任务是否“复杂”或“模糊”；
- 被 block 后自动规划或访谈；
- 基于规则私有状态运行状态机；
- 在未覆盖的 read-only tool 上拦截；
- 保证“任意 Owner 不喜欢的行为”都可表达。

准确定位是：

> RuleContext v2 让 PD 从单点危险谓词，升级为有证据、有上下文、可验证的工具调用策略。

它不是通用行为执行引擎。

### 8.3 requireApproval

当前 gate 对 requireApproval 只记录事件后放行。

因此本版本：

- 产品文案不得宣称三级拦截已生效；
- 验收只使用 allow/block；
- 中风险但不适合硬拦的行为继续使用 prompt 通道；
- 真正的 Owner 一次性授权流程必须单独立项和审批。

## 9. Feature flag、兼容与回滚

### 9.1 新 flag

注册：

~~~yaml
rulecode_context_v2:
  category: quiet
  enabled: false
  since: 2026-06-27
~~~

只有生产 loader 和测试真实消费该 flag 后，才算完成注册。

### 9.2 行为

flag 关闭时：

- gate 不查询 RuleContext v2；
- v1 规则继续运行；
- requiresContextVersion: 2 的 activation 不加载，并记录 reason + nextAction；
- Artificer 不得生成 v2 rule artifact。

flag 开启时：

- gate 提供 input.context.version=2；
- Artificer/Evaluator 接受并验证 v2 场景；
- Owner 可审批 v2 规则。

### 9.3 晋级条件

满足以下条件后，maintainer 才能考虑将 flag 从 quiet 默认关闭改为默认开启：

1. 至少一条真实 Owner 规则通过端到端闭环。
2. 至少 10 个正例和 10 个负例 replay 全部通过。
3. 上下文 unavailable 时零误拦。
4. 生产 context 构造 p95 达到约定预算。
5. Owner 能在 Console 或 CLI 看到规则依据和 deactivate 路径。

本 PR 至少通过现有 approval summary / effectDescription 和 CLI 提供这些信息，不新增审批 UI 或新 route。

## 10. 验收场景

### 10.1 必须通过

| 场景 | 负例 | 正例 |
|---|---|---|
| 读后再写 | 未读目标文件的大写入被 block | 已读同一 normalizedPath 后 allow |
| 写多读少 | 达到 Owner 批准阈值后 block | 调研充分或未达阈值 allow |
| 失败后调查 | 多次失败且无 read/search 被 block | 失败后调查再写 allow |
| 跨文件写入 | 多路径写且无 search 被 block | 有全局 search 后 allow |
| 同一动作硬闯 | 同 session、kind、path 多次 block 后升级 | 其他路径的 block 不计入 |
| 上下文不可用 | history unavailable | 必须 allow，不得解释为没调研 |
| 历史截断 | truncated=true | 规则按明确保守策略处理 |
| 工具别名 | write_file/grep_search 等 | 与 canonicalKind 行为一致 |
| 路径边界 | src/auth.ts.bak | 不得被当作已读 src/auth.ts |
| v1 回归 | context flag 开关 | 现有规则结果不变 |

### 10.2 四层验证

1. Contract：runtime guards、TypeBox 和 canonical validator。
2. Pure replay：Golden Trace 正反例和边界例。
3. Production VM：SQLite activation + 子进程 RuleCode。
4. Hook E2E：真实 trajectory 写入到 before_tool_call block。

### 10.3 性能与故障

需要记录：

- context query p50/p95；
- context 构造总字节；
- history unavailable 次数及原因；
- v2 rule 因版本不兼容被跳过的次数；
- 规则 block reason 与 evidence summary。

性能预算必须先基准再定值。文档不得把未执行的目标写成“实测结果”。

## 11. 实施文件清单

### principles-core：纯逻辑

- rule-host-contracts.ts；
- rule-context-v2.ts（新增，纯类型、validator 与 facts 计算）；
- behavior-example-pack.ts（新增，纯契约与 validator）；
- rule-host-input-builder.ts；
- golden-trace.ts；
- artificer-output.ts；
- artificer-output-typebox.ts；
- artificer-l2-tool-contract.ts；
- artificer-prompt-builder.ts；
- refiner-sandbox-wrapper.ts；
- evaluator-runner.ts；
- rule-host-writer.ts；
- feature-flag-contract.ts；
- 对应 barrel exports 与 tests。

### openclaw-plugin：I/O 与生产装配

- trajectory.ts；
- behavior-example-pack-assembler.ts（新增，pain lineage / trajectory I/O 装配）；
- gate.ts；
- 生产 hook E2E tests。

首版不新增 RuleHost helper。规则直接读取 input.context，避免同时维护 core helper、VM 子进程 helper 和 sandbox helper 三份表面。

## 12. MVP 四问

### mvp-q-1-what-if-skip

不做则真实 RuleCode 仍只能可靠检查当前 action，无法沉淀“先读再写、失败后调查”等 Owner 已明确提出的行为原则。该问题会在 30 天内再次出现。

结论：通过。

### mvp-q-2-how-observed

Owner 激活一条上下文规则后，在可比较场景中观察：

- 未满足前置证据时被 block；
- 满足前置证据时 allow；
- EventLog/Console 显示规则、reason 和 evidence summary；
- Golden Trace 展示至少一个允许和一个拒绝场景。

结论：通过。

### mvp-q-3-how-disabled

- 全局关闭 rulecode_context_v2；
- 对单条 activation 执行 deactivate；
- v1 规则和其他 activation 通道继续运行；
- 不需要数据迁移或 PR revert。

结论：通过，前提是 flag 生产消费测试完成。

### mvp-q-4-emotional-value

主要减少：

- 失控感；
- 重复纠正的疲惫感；
- 对黑箱规则的不信任感。

主要创造：

- 掌控感：Owner 决定规则和阈值；
- 沉淀感：纠正变成版本化策略代码；
- 安心感：上下文缺失不会误拦；
- 清醒感：Owner 看到的是规则依据，不是全部原始日志。

如果只展示 block 次数、不展示证据和停用路径，情绪价值不成立。

## 13. ERR 防复发清单

| ERR | 本设计的防复发要求 |
|---|---|
| ERR-001 | SQLite row、params_json、LLM output 始终以 unknown 进入 canonical validator |
| ERR-024 | context validator 必须由 gate 真实调用，不能只存在于 helper tests |
| ERR-025 | 至少一条测试覆盖 recordToolCall 到 before_tool_call 的生产链 |
| ERR-026 | SQLite 测试复用生产 schema initializer，不手写漂移 schema |
| ERR-069 | Artificer happy、failure、retry 输出都通过同一 schema |
| ERR-076 | VM 边界使用结构校验，不依赖 host realm prototype |

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 空历史造成误拦 | available/unavailable + unknown 三态 |
| 读取历史使全部规则 fail-open | 独立降级，仍执行 action-only 规则 |
| 工具 aliases 漂移 | core canonicalKind 单一实现 |
| replay 与生产不一致 | 共用 buildRuleHostAction 和 RuleContext schema |
| 规则过严增加 Owner 疲惫 | 正反例、Owner 审批、deactivate、默认 quiet |
| 历史窗口过短产生假结论 | truncated 明示；规则必须定义截断策略 |
| Artificer 编造阈值 | BehaviorExamplePack + Owner 审批阈值 |
| 多规则组合误伤 | Evaluator 增加组合正例回放 |

## 15. 延后项与重启条件

### 15.1 对话语义视力

本版本不增加 dialogSignals。

只有同时满足以下条件才重新设计：

1. 至少 10 个 Owner 标注的“任务模糊/明确”真实样例。
2. 至少一次真实事故证明工具轨迹不足以表达该原则。
3. 有冷路径计算、缓存、版本、置信度和失败降级方案。
4. Owner 能验证分类是否符合自己的判断。

未来语义信号必须包含：

~~~text
status + label + confidence + evidenceRef + classifierVersion + computedAt
~~~

不得使用 taskComplexity + false 这类把 unknown 混入负值的裸契约。

### 15.2 演化搜索

本版本不实现多候选生成、真实轨迹批量择优和规则变异。

[AutoHarness](https://arxiv.org/abs/2603.03329) 说明“代码 harness + 环境反馈”可能产生高质量策略，但它依赖明确的环境反馈。PD 必须先积累 Owner 标注的允许/拒绝样例，不能把论文结果当作当前重启条件。

### 15.3 真正的 requireApproval

一次性 Owner 授权、授权 token 和重试语义属于新的运行时治理流程。

在没有产品观察路径、停用路径和 maintainer 显式批准前，不与 RuleContext v2 同 PR 实施。

## 16. 实施顺序

1. 记录 maintainer 对 MVP-Core 变更的显式批准。
2. 注册并接通 rulecode_context_v2。
3. 先扩 Golden Trace 与 synthetic input，建立可测试 ABI。
4. 实现 core 工具分类、RuleContext validator 和 facts 计算。
5. 在 TrajectoryDatabase 增加严格验证的查询。
6. 在 gate 独立装配 available/unavailable context。
7. 接通 Artificer BehaviorExamplePack、spec、prompt、replay 和 submit。
8. 接通 Evaluator 与 rule artifact contextVersion 检查。
9. 完成生产 Hook E2E、回归、性能和故障测试。
10. 用一条真实 Owner 规则 dogfood，再决定是否默认开启。

## 17. 最终定位

本设计的目标不是让 PD 写出越来越复杂的 if。

目标是建立一个闭环：

~~~text
Owner 纠正
→ 有标签的行为证据
→ Artificer 编译上下文策略
→ Golden Trace 与 Evaluator 验证
→ Owner 审批
→ RuleHost 确定性执行
→ 误拦/漏拦成为下一版证据
~~~

当策略代码拥有稳定 ABI、真实证据、正反例、版本兼容和可撤回能力时，PD 的内化才从“保存规则文本”升级为“保存经过治理的行为能力”。
