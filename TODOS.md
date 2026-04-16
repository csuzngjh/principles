# TODOS.md

## [DESIGN-1] 补充 Nocturnal 系统定位说明
**What**: 在设计文档中明确 Nocturnal 系统在通用 SDK 中的角色和时间线。
**Why**: 当前设计文档完全没提 Nocturnal，但它占代码库 ~7200 行，是"自我进化"承诺的核心。
**Pros**: 让读者对范围有准确预期。
**Cons**: 无。
**Context**: Nocturnal（三一反思流水线）和编程耦合极深，通用化是独立大工程。已决议纳入 Phase 2 范围。涉及文件：nocturnal-trinity.ts (2429行)、nocturnal-service.ts (1584行)、nocturnal-compliance.ts (1146行)、nocturnal-arbiter.ts (710行)、nocturnal-runtime.ts (654行)、nocturnal-target-selector.ts (545行)、nocturnal-config.ts (214行)。
**Depends on**: 无
**Blocked by**: 无

## [DESIGN-2] 定义 Principle 质量评估方法
**What**: 为第 3 个成功标准（"principles rated useful >70%"）定义具体的评估方法。
**Why**: "useful" 是主观的，没有测量方法就没法验证。这是 LLM eval 问题。
**Pros**: 可量化的成功标准。
**Cons**: eval 设计需要额外时间。
**Context**: 参考 principle-tree-schema.ts 中的 valueScore 和 adherenceRate 字段。需要定义评分标准（自动 vs 人工）和采集方式（显式评分 vs 行为推断）。
**Depends on**: Phase 1 接口契约定义
**Blocked by**: 无

## [DESIGN-3] 补充竞争风险应对策略
**What**: 讨论如果 OpenAI/Anthropic 在模型层内置自我进化能力，PD 的价值主张怎么转变。
**Why**: 设计文档 Open Question 5 没有讨论。影响技术决策和产品定位。
**Pros**: 提前思考应对方案，指导技术选型。
**Cons**: 可能过早担忧。
**Context**: PD 的护城河不在于 LLM 能不能自我改进，而在于跨 session 的持久化原则存储 + 框架级别的注入机制。即使模型层有类似能力，也需要外部系统来持久化和注入。
**Depends on**: 无
**Blocked by**: 无

## [SECURITY-1] 安全威胁模型 + Principle 文本清洗
**What**: 为设计文档增加安全章节，定义威胁模型和 Principle 文本清洗策略。
**Why**: Principle 文本被注入 prompt，存在存储型 prompt injection 攻击链。
**Pros**: 防止原则成为攻击向量。
**Cons**: 增加提取管道复杂度。
**Context**: /plan-ceo-review Section 3。需定义清洗规则（禁止注入模式、长度限制、特殊字符过滤）。
**Depends on**: Phase 0 接口设计 | **Blocked by**: 无 | **Priority**: P1 | **Effort**: S

## [ARCH-1] SDK 生命周期管理
**What**: 定义 SDK init/shutdown/reconnect 生命周期事件处理。
**Why**: 没覆盖适配器未注册、存储不可用、队列未处理信号 shutdown、并发写入竞争。
**Pros**: SDK 优雅处理启动和关闭。
**Cons**: 增加接口复杂度。
**Context**: /plan-ceo-review Section 4。SDK 抽取后需自己管理生命周期。
**Depends on**: Phase 0 适配器接口设计 | **Blocked by**: 无 | **Priority**: P2 | **Effort**: S

## [ARCH-2] EvolutionHook 异步签名
**What**: 将 EvolutionHook 从同步 void 改为异步或 event emitter 模式。
**Why**: 同步 void 不适合真实副作用（记录、审计、异步存储）。当前签名要么 fire-and-forget 要么吞错。
**Pros**: 正确处理异步副作用。
**Cons**: 增加适配器实现复杂度。
**Context**: 外部意见第 4 点。
**Depends on**: Phase 0 适配器接口设计 | **Blocked by**: 无 | **Priority**: P1 | **Effort**: S

## [ARCH-3] 多 Agent 并发模型
**What**: 定义多 agent 共享原则库的隔离、竞争学习、污染传播策略。
**Why**: Pain Protocol 没保留 agent_id，多 agent 共享库会碰到隔离和竞争。
**Pros**: 支持多 agent 场景。
**Cons**: 增加存储和锁定复杂度。
**Context**: 外部意见第 29 点。
**Depends on**: Phase 1 跨域验证 | **Blocked by**: 无 | **Priority**: P2 | **Effort**: M

## [ARCH-4] Pain/Principle 协议治理规则
**What**: 定义协议治理：谁有权修改、breaking 定义、字段冻结、实验字段处理。
**Why**: 无治理则每接一个框架就扩字段，协议漂移。
**Pros**: 防止协议腐化。
**Cons**: 增加流程开销。
**Context**: 外部意见第 21 点。
**Depends on**: Phase 0 接口设计 | **Blocked by**: 无 | **Priority**: P1 | **Effort**: S

## [ARCH-5] 数据迁移策略
**What**: 定义从现有 PainFlagData/trajectory.db 到新 Pain Protocol/Storage Adapter 的迁移路径。
**Why**: 新协议会破坏现有持久化状态。现有用户数据需要迁移。
**Pros**: 数据不丢失。
**Cons**: 迁移脚本开发和测试。
**Context**: 外部意见发现。per-workspace SQLite 有完整历史数据。
**Depends on**: Phase 0 接口设计 | **Blocked by**: 无 | **Priority**: P1 | **Effort**: M

## [ARCH-6] 版本/状态双状态机定义
**What**: 明确 Principle 版本演进和生命周期状态的交互规则。
**Why**: rollback API 引入版本维度 + 现有 candidate/probation/active/deprecated 状态 = 双重状态机。无交互规则会状态爆炸。
**Pros**: 状态管理清晰。
**Cons**: 需仔细设计状态转换矩阵。
**Context**: 外部意见第 19 点。
**Depends on**: Phase 0 接口设计 | **Blocked by**: 无 | **Priority**: P2 | **Effort**: S

## [ENG-1] PainSignal schema 重新设计
**What**: 重新设计 PainSignal 的通用 schema，将编码特定字段抽象为通用字段。
**Why**: CEO Plan Phase 0b 的 capture(toolName, error, context) 接口有编码偏见，对写作/客服 agent 无意义。
**Pros**: 真正的跨域通用抽象。
**Cons**: 需要重写 pain.ts hook 的信号构造逻辑。
**Context**: 通用 PainSignal 应包含：trigger (error|user_feedback|self_reflection|outcome_mismatch)、domain、severity (0-100)、context (Record<string, unknown>)。由 adapter 负责将框架原生信号转换为通用 PainSignal。
**Depends on**: Phase 0b 适配器接口设计 | **Blocked by**: 无 | **Priority**: P1 | **Effort**: M

## [ENG-2] evolution-worker.ts 拆分重新设计
**What**: 重新评估 evolution-worker.ts 的拆分策略，而非保留 as-is。
**Why**: 外部意见发现：保留 as-is 会把 OpenClaw 耦合烘焙进 SDK 接口。需要拆分但保持职责完整。
**Pros**: 避免"Wrapper Hell"陷阱，接口更干净。
**Cons**: 拆分会增加跨模块状态管理复杂性。
**Context**: 应拆分为：queue-consumer (消费 pain events)、detection-service (检测逻辑)、extraction-service (原则提取)、promotion-service (升降级)。保留事务边界在 queue-consumer 层级。
**Depends on**: Phase 0a | **Blocked by**: 无 | **Priority**: P1 | **Effort**: M

## [ENG-3] Phase 1.5 跨域极端案例验证
**What**: 在接口冻结前增加一个"极端案例"领域（创意写作/客服）来压力测试通用接口。
**Why**: N=2 偏见(coding + 1 领域)不足以验证"Universal"。真正的跨域验证应在接口冻结前执行。
**Pros**: 在破坏性变更成本最低时发现接口问题。
**Cons**: 增加 Phase 1 范围和复杂度。
**Context**: 选择一个与 coding 差异最大的领域（创意写作或客服），验证 PainSignal schema 和 Principle injection 的通用性。根据结果决定是否需要调整接口设计，再冻结 Semver。
**Depends on**: Phase 1 adapter 实现完成 | **Blocked by**: 无 | **Priority**: P2 | **Effort**: M
