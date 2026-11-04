# SPEC-PD-AGENT-CAPABILITY-API-001
## PD Application Capabilities：宿主无关业务能力契约与可选 MCP Adapter

| 字段 | 内容 |
|---|---|
| SPEC ID | `SPEC-PD-AGENT-CAPABILITY-API-001` |
| 版本 | `v0.2-draft` |
| 状态 | `DRAFT — OWNER REVIEW REQUIRED` |
| 类型 | 架构与接口契约 SPEC；不是 MCP Server 实施授权 |
| 调查基线 | `csuzngjh/principles` 的远端 `main`：`64568651dc753ff43afc4989440f599769c021f4` |
| 复核日期 | `2026-10-28` |
| 基线链接 | [64568651dc753ff43afc4989440f599769c021f4](https://github.com/csuzngjh/principles/commit/64568651dc753ff43afc4989440f599769c021f4) |
| 本版目标 | 冻结能力抽象方向、CLI/MCP 边界、候选契约、安全不变量、决策 Gate 和验收标准 |
| 本版非目标 | 不修改代码、不新增 MCP Server、不改变 Hook/RuleHost 行为、不批准历史敏感证据的 Agent read-back |

> **重要声明：** 本文是基于源码调查提出的架构 SPEC。文中“现状”表示在所列基线源码或文档中核实到的事实；“要求/建议”是本 SPEC 提出的目标约束，不代表代码已经实现。只有 Owner 明确批准相应 Gate 后，才能进入对应实施阶段。
>
> **v0.2 自查修订记录：** 本版基线更新至 `64568651dc753ff43afc4989440f599769c021f4`；纳入 Codex `pd pain explicit` 的最新 Skill+CLI 路径；澄清 release lock 中可选 MCP SDK peer dependency 不等于已有 PD MCP Server；将“能力契约设计”“MCP 必要性验证”“应用服务抽取”“生产 MCP Pilot”拆分为独立 Gate；补充 MCP 与 Hook 的职责边界、响应契约一致性、工作区路径安全和不可信历史文本处理。

---

## 1. 摘要与核心决策

PD 应建立一个稳定的 **Application Capabilities（应用业务能力）层**，供 CLI、未来可选的 MCP Adapter 以及其他经过批准的入口复用。

核心决策：

1. **内部共享业务用例，外部入口独立。** CLI 与未来 MCP 共享业务逻辑、Schema、权限规则、来源语义与错误语义；不共享命令行解析、终端格式、MCP 工具注册或协议处理。
2. **MCP 不是 CLI 的包装器。** MCP 不得通过启动 `pd ... --json`、解析 stdout 或依赖 CLI 进程来实现业务；CLI 也不得依赖 MCP Server 才能工作。
3. **MCP 工具不是 CLI 命令的机械副本。** MCP 是从应用能力目录中经过筛选、授权和 Agent 化设计的一组工具。两者部分重叠，但不要求严格包含或一一映射。
4. **MCP 不是治理执行层。** Hook、Host Runtime、RuleHost、Pain 准入和 Owner 审批继续拥有各自的权威职责。MCP 不能替代真实宿主事件和强制执行路径。
5. **先冻结能力契约，再验证 MCP 必要性。** 在具体场景证明 Skill + CLI / 宿主原生工具不足前，不新增生产 MCP Server。
6. **能力抽象不等于立即重构。** 不因未来可能有第二个入口，就提前创建应用包或移动业务代码；代码抽取必须有独立 Gate 和回滚条件。
7. **首版优先只读。** 不在首版暴露 Pain 写入、任意执行、审批、激活、回滚或 RuleHost 权威决策。现有 `pd pain explicit` 仍走 Skill+CLI 与宿主绑定的 turn-context 路径，不自动转为 MCP 工具。
8. **只读必须是可验证的安全属性。** 不得仅凭函数名、类名或“查询命令”认定无副作用；需要严格只读连接配置和文件/数据库不变性测试。
9. **数据披露权限与功能可用性分离。** 某数据能被内部服务读取，不代表允许 Agent 获取；尤其是历史原始纠错文本、Owner 原话和其他敏感证据。

### 1.1 预期结果

- 一套版本化、宿主无关、权限明确的 PD 业务能力契约。
- CLI 和 MCP（如果后续获准）调用同一业务用例，而非各自实现一遍。
- 既有 Hook / RuleHost 的自动治理行为保持不变。
- 新能力可按需接入新的宿主，而无需重新实现原则查询、Pain 关联或业务错误语义。
- 是否需要 MCP 由真实场景和可测量的增量价值决定，而不是为了架构统一而预先建设。

---

## 2. 背景与问题陈述

### 2.1 当前需要解决的问题

PD 已经有若干可复用的核心模块与查询服务，但能力散落在 `principles-core`、`host-runtime` 和 `pd-cli` 等包中。部分宿主事件路径仍有差异，现有架构文档与最新代码之间也存在事实漂移。

当前的关键问题不是“PD 没有 MCP”，而是：

- 还没有统一定义一份供不同入口使用的、稳定的 PD 业务能力契约；
- 现有 CLI 服务并不都位于中立应用层，直接让 MCP 依赖 CLI 会倒置依赖方向；
- 某些读模型在默认构造时可能初始化状态存储，不符合严格只读接口的要求；
- 原则指导需要区分“可用候选”“符合当前宿主资格的指导”与“有证据确认本轮实际注入的指导”；
- Pain 的人工登记、宿主事件证据与治理信号准入不是同一个业务动作，不能合并为一个通用写入接口；
- 历史 Pain 的可查询性不等于历史原始文本可向 Agent 披露；
- MCP 工具颗粒度需要面向 Agent 的任务与权限设计，而不是按内部函数数量设计；
- 需要保留 Skill + CLI 的低依赖、可脚本化优势，同时避免 Agent 需要自行拼接多个底层查询。

### 2.2 本 SPEC 要回答的问题

1. 哪些 PD 业务能力适合形成稳定的应用层用例？
2. CLI 和 MCP 应共享什么、各自保留什么？
3. MCP 工具颗粒度如何按业务任务、权限、副作用和输出预算平衡？
4. 如何避免 MCP 与 CLI 出现两套业务实现？
5. 如何避免 MCP 误报健康状态、泄露历史证据或绕过 Hook/RuleHost？
6. 在什么条件下值得建设 MCP，什么条件下应停留在能力抽象和 Skill + CLI？
7. 如何验证这次抽象没有破坏现有宿主行为？

### 2.3 必须先澄清的架构边界

“让 PD 彻底插件化”不能仅靠 MCP 完成。PD 至少有两条彼此独立的集成面：

- **宿主生命周期 / Hook 集成面：** 接收真实宿主事件、注入原则、执行 `before_tool_call` 门禁、维护会话与来源身份。它依赖各宿主的 Hook / Plugin API 和现有 Host Adapter。
- **业务能力访问面：** 让 Agent 按需调用 Pain Recall、状态查询等业务用例。CLI 是一种入口；MCP 可以是另一种可选入口。

MCP 只能改善第二类集成面。它不会自动注册 Hook、获得真实宿主事件、补齐提示注入或替代 RuleHost。若某宿主缺少 Hook 能力或现有 Hook 适配不完整，那是单独的 Host Adapter / 插件交付问题，不能把它算作引入 MCP 后自然解决的问题。

---

## 3. 当前源码事实、推断与建议

本节区分三类陈述。**源码事实**可由基线代码直接验证；**推断**是基于这些事实作出的架构判断；**建议**是本 SPEC 要求后续实现遵循的目标。

### 3.1 源码事实

| 事实 | 证据（固定到调查基线） | 对架构的含义 |
|---|---|---|
| `principles-core` 提供纯逻辑、账本、轨迹与 Runtime V2 等导出 | [`packages/principles-core/package.json`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/principles-core/package.json)，包版本 `1.297.2` | 可复用核心存在，不应在 MCP 中复制领域逻辑 |
| `host-runtime` 是共享宿主无关编排包，并依赖 `@principles/core` | [`packages/host-runtime/package.json`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/package.json)，包版本 `0.13.5` | 现有运行时可复用，但不能将所有生命周期 API 当成业务 API |
| `HostRuntime` 有固定生命周期路由 | [`host-runtime/src/index.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/src/index.ts)，`HOST_RUNTIME_ROUTES`、`createProductionHostRuntime()` | `dispatch()` 属于宿主事件执行契约，不应接受模型任意构造的 `HostEvent` |
| `HostRuntime.health()` 存在，但其当前检查不足以代表所有治理数据源均健康 | [`host-runtime/src/index.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/src/index.ts)，`health(workspaceDir)` | 不得直接将其包装成完整的 `pd_health` 工具 |
| Pain Recall 已有 CLI 服务及版本化结果 | [`pd-cli/src/services/pain-recall.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/pd-cli/src/services/pain-recall.ts)，`recallPains()`、`pd.pain-recall.v1` | 应复用其关联规则与查询语义，而不是重写 Recall |
| Pain Recall 已实现严格只读连接约束 | 同上，`recallPains()` 中 `RuntimeStateManager({ readonly: true, bootstrapIfMissing: false })`；`readLedgerFileState()`、`openTrajectoryDbReadonly()` | 可作为首批共享应用用例的候选 |
| Pain Recall 有严格只读契约测试 | [`pain-recall-readonly.test.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/pd-cli/tests/commands/pain-recall-readonly.test.ts) | 现有测试应保留，并扩展到抽取后的共享服务与新入口 |
| `PainChainReadModel` 默认创建 `RuntimeStateManager` 时没有显式设置只读参数 | [`pain-chain-read-model.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/principles-core/src/runtime-v2/pain-chain-read-model.ts)，`getStateManager()` | 不可直接把默认实例包装成严格只读 MCP 工具 |
| SQLite 连接选项默认 `readonly=false`、`bootstrapIfMissing=true` | [`sqlite-connection.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/principles-core/src/runtime-v2/store/sqlite-connection.ts) | 查询路径必须显式传入只读配置，并验证无副作用 |
| 原则指导有候选读取和提示上下文构建函数 | [`active-principle-prompt.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/src/active-principle-prompt.ts)，`readPromptActivationCandidates()`、`buildActivePrinciplePromptContext()` | 可复用其实现，但需定义对外语义和来源证明 |
| 宿主原则提示路径存在差异，OpenClaw 有 `abstraction_layer_v1` 分流 | [`prompt-injection-projection.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/src/prompt-injection-projection.ts) | 不可把某个候选列表声称为所有宿主本轮实际注入的原则 |
| Runtime Feature 查询已有结构化输出，且注明不输出密钥 | [`runtime-features.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/pd-cli/src/commands/runtime-features.ts)，`buildRuntimeFeaturesStatus()` | 可作为低风险能力候选；`configPath` 等本地路径需在对外投影时脱敏 |
| Pain 入口语义判定与宿主治理信号准入是不同路径 | [`pain-ingress.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/principles-core/src/runtime-v2/pain-ingress.ts)、[`governance-signal-admission.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/src/governance-signal-admission.ts) | 不得设计一个接受任意 JSON 并伪装为可信宿主事件的通用 Pain 写入接口 |
| Pain Recall CLI SPEC 明确不新增 MCP Server | [`SPEC-PD-PAIN-RECALL-CLI-001.md`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/docs/archive/specs/SPEC-PD-PAIN-RECALL-CLI-001.md) | 新 MCP 必须由新的具体场景证据与 Owner 决策授权，不能视为既有 Recall SPEC 的默认延伸 |
| PRR v1.3 仍要求先证明 Skill + CLI / Host Tool 不足；Gate B 尚未获授权 | [`SPEC-PD-PRR-001-principle-pain-recall-v1.3.md`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.3.md) 与第 259 行附近 MCP 条款 | MCP 不是默认交付路线；历史证据披露与真实数据读取授权仍须单独处理 |
| ADR-0020 否决“用 MCP Server 替代 Codex Hook” | [`ADR-0020`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/docs/adr/0020-codex-cli-host-adapter.md) | MCP 可以作为附加能力入口，但不得替代 Hook 的自动治理角色 |
| 旧 Host Capability Matrix 中仍有与当前代码不一致的宿主描述 | [`HOST_CAPABILITY_MATRIX.md`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/docs/audit/pri-807-phase0/HOST_CAPABILITY_MATRIX.md)；当前 `workbuddy-adapter/src/host-adapter.ts` 与 `prompt-injection-projection.ts` 已包含 WorkBuddy 相关实现 | Gate 0 必须更新架构事实矩阵，不能直接复制旧矩阵作为现状 |
| 当前源码树未发现独立 PD MCP Server 生产实现 | 在固定基线 Git tree（5620 个条目）与生产源码检索中未发现独立 PD MCP Server 实现；但 release lock 中出现 `@google/genai` 对 `@modelcontextprotocol/sdk` 的可选 peer dependency（例如 [core release lock](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/create-principles-disciple/release-locks/core/package-lock.json)） | 可选 peer dependency 不是 PD MCP Server 已实现的证据；也不能声称仓库中完全没有 MCP SDK 字符串 |
| 最新 Codex 路径已有 `pd pain explicit` Skill+CLI 显式登记流程 | [`pain-explicit.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/pd-cli/src/commands/pain-explicit.ts)、[`turn-context.ts`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/codex-adapter/src/ingestion/turn-context.ts)、[`pd-pain-signal/SKILL.md`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/plugins/principles-disciple/skills/pd-pain-signal/SKILL.md) | 该路径依赖宿主 Hook 写入的当前 turn 身份与既有准入链；不是 MCP 能力，也不能作为 Skill+CLI 不足的证据 |
| Host Capability Matrix 是历史审计快照，不是当前权威矩阵 | [`HOST_CAPABILITY_MATRIX.md`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/docs/audit/pri-807-phase0/HOST_CAPABILITY_MATRIX.md) 使用旧 checkout 基线；当前 [`WorkBuddyHooksHostAdapter`](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/workbuddy-adapter/src/host-adapter.ts) 已实现 `HostAdapter` | Gate 0 必须按当前源码重建矩阵；“接口已实现”不等于“已在生产安装并通过真实宿主验证” |

### 3.2 架构推断

基于上述事实，可得出以下推断：

1. PD 已有领域逻辑和部分查询服务，**潜在缺口是跨入口契约、权限语义与可靠性验证**；当前证据不支持“缺少 MCP Server 本身就是问题”的结论。
2. Pain Recall 是现有契约基础相对完整的候选用例，但 PRR v1.3 明确要求先验证历史证据的行为增量与实现收益；它不是自动获批的 MCP 首个工具。
3. `recallPains()` 位于 `pd-cli` 包中，意味着未来第二个生产入口可能遇到依赖边界问题；这并不自动证明现在值得抽取新包。应先证明第二个消费者真实存在且有增量价值。
4. 当前 Codex 已有 `pd pain explicit` Skill+CLI 路径，并通过宿主写入的 live-turn context 绑定真实会话；因此 Pain 写入不是首个 MCP 验证场景，不能把它复制为通用 MCP 写工具。
5. 原则指导、Recall、状态读取和 Pain 追踪的数据敏感级别不同，不能仅以“只读”为由采用相同披露策略。
6. 暴露内部类会泄漏实现结构；通用 `pd_execute` 则难以审计权限与副作用。
7. MCP 传输层不会自动解决宿主准入、证据身份或原则注入差异；这些仍属于独立的 Host Adapter / Reality Audit 任务。

### 3.3 本 SPEC 的设计建议

- 先冻结候选能力契约和现有实现映射，不要求创建新包或移动代码。
- 不预设 `packages/pd-application` 必须存在；只有 Gate 2 证明需要第二个生产入口，且依赖审计证明现有包边界无法干净复用时，才评估是否新建应用包。
- 如果 Gate 2 未证明 MCP 有增量价值，保留现有 CLI/Skill，不为未使用的入口抽取新层。
- 如果 Gate 2 通过，优先提取一个被批准的窄用例；CLI 与 MCP 复用同一服务，不复制关联、权限或来源逻辑。
- 现有 `pd pain explicit` 保持 Codex Skill+CLI / host-bound turn-context 路径；除非另立写入 SPEC 并独立获批，不纳入 MCP 白名单。
- Hook / RuleHost 始终保留原有权威路径。

---

---

## 4. 目标与非目标

### 4.1 目标

1. 定义稳定的宿主无关业务能力接口。
2. 定义 CLI、MCP 与应用服务的依赖方向。
3. 为每项能力定义输入、输出、状态、权限、来源、数据披露和只读语义。
4. 为共享应用服务建立单元测试和入口契约测试。
5. 保证 CLI 的既有参数、输出和退出码行为不因抽象而无意改变。
6. 保证未来 MCP 仅暴露经批准的能力，不自动继承所有 CLI 命令。
7. 建立是否建设 MCP 的可验证 Gate 和回滚策略。
8. 更新宿主能力矩阵，区分“源码存在”“生产路径接入”“真实宿主已验证”“Agent 可可靠调用”四个层次。

### 4.2 非目标

本 SPEC 不授权或要求：

- 新增通用 MCP Server、远程 MCP 服务或公网服务；
- 把 `HostRuntime.dispatch()` 暴露为任意工具；
- 用 MCP 替代 OpenClaw、Codex、WorkBuddy 的 Hook / Plugin 生命周期；
- 用 MCP 返回的建议替代 RuleHost 强制门禁；
- 在首版开放 Pain 信号写入、人工声明提升、审批、激活、回滚、策略修改或任意命令执行；
- 新建第二套原则账本、Pain 身份体系、诊断任务系统或学习管线；
- 在没有授权的情况下读取真实用户历史样本或扩大 `correctionEvidence` 等字段的披露范围；
- 为了“统一接口”而强制重写所有宿主实现；
- 为了降低工具数量而把不同权限或副作用的操作合并；
- 以 MCP 工具数量、代码行数或是否新增独立包作为成功指标。

---

## 5. 架构决策

### 5.1 目标分层

```text
Trusted Host / Human / Agent
          |
          +--------------------+
          |                    |
      CLI Adapter          MCP Adapter (optional; Gate 4)
          |                    |
          +----------+---------+
                     |
          PD Application Capabilities
          - use cases
          - request/response contracts
          - authorization & disclosure policy
          - status/error semantics
          - read-only guarantees
                     |
          +----------+----------------------+
          |                                 |
   principles-core                    approved host-runtime
   - domain logic                    - existing guidance projection
   - read models                     - existing shared runtime services
   - ledger/trajectory                (only through stable public APIs)
          |
   Existing stores / ledger / trajectory DB

Separate authoritative path:
Host Hooks -> Host Adapter -> Host Runtime / RuleHost -> actual enforcement
```

该图表示目标边界，不代表当前所有模块已经按此分层完成。

### 5.2 依赖方向

目标依赖规则：

1. `principles-core` 不依赖 CLI、MCP SDK 或宿主入口。
2. 应用能力层不依赖 `@principles/pd-cli`、MCP SDK 或具体 Agent SDK。
3. CLI 依赖应用能力层；CLI 负责命令行解析、终端输出、退出码、交互确认与批处理。
4. MCP Adapter（若获批）依赖应用能力层和 MCP SDK；它负责协议注册、工具 Schema、结构化结果和传输生命周期。
5. MCP Adapter 不通过 CLI 子进程完成业务。
6. 应用能力层可以调用经审查的现有 Core / Host Runtime 公共服务，但不得形成依赖环。若当前包边界无法满足，只有在 Gate 2 通过且 Gate 3 获得 Owner 授权后，才评估抽取窄接口或移动单个用例。
7. Hook / RuleHost 不依赖 MCP Server 是否运行；MCP 停止或卸载不影响 Hook 的权威执行语义。
8. 业务用例不接受任意内部对象、数据库句柄或未经验证的宿主事件作为公共请求参数。

### 5.3 应用能力层职责

应用能力层负责：

- 一个业务任务的完整编排；
- 请求验证和默认值；
- 权限检查与数据披露策略；
- 对多个已批准只读数据源的安全组合；
- 业务结果状态、警告、来源与版本化 Schema；
- 限制结果大小、分页和字段范围；
- 明确区分空结果、部分可用、权限拒绝、数据缺失与执行失败；
- 提供可被 CLI 和 MCP 独立调用的稳定接口。

应用能力层不负责：

- MCP 协议握手、工具发现和 transport；
- CLI 参数解析、终端格式或命令帮助；
- 代替宿主 Hook 捕获实际工具事件；
- 代替 RuleHost 执行强制门禁；
- 从任意模型输入推断可信宿主身份；
- 自行扩大 Owner 已批准的数据披露范围。

### 5.4 包名与位置

`packages/pd-application` 仅是备选，不是默认方案。

**本版不批准立即创建该包。** 先通过 Gate 0 与 Gate 2，确认有真实的第二个生产消费者和可量化收益；再根据依赖图决定是将单个用例放在现有合适包、抽取窄的 application facade，还是新建独立包。不能把“未来可能接 MCP”当作新包的充分理由。

任何选择都必须满足：应用服务不依赖 CLI、MCP SDK 或具体 Agent SDK；没有循环依赖；不会把宿主特定的会话身份流程错误地抽象成 host-neutral 能力。禁止仅为“看起来分层清晰”而新建没有独立职责的空包。
---

## 6. CLI 与 MCP 的关系

### 6.1 关系定义

**内部合并，外部独立。**

- 内部：共享业务用例、业务规则、Schema、权限与来源语义。
- 外部：CLI 和 MCP 具有各自独立的入口契约与交互方式。
- 能力集合：部分重叠，而非严格子集或超集。MCP 是应用能力目录的受控投影。
- CLI 可以提供更多运维和调试命令；这些命令不会自动暴露给 Agent。
- MCP 可以提供更适合 Agent 的组合型业务工具，但只能组合已批准的应用用例，不能绕过授权边界。
- MCP 与 CLI 不要求一一映射：多个 CLI 操作可以被一个 MCP 业务工具组合；某些 CLI 命令可以完全不出现在 MCP 中。

### 6.2 禁止的实现方式

| 禁止模式 | 原因 |
|---|---|
| MCP 调用 `pd ... --json` 并解析 stdout | 依赖进程、工作目录、退出码、输出格式与环境；容易产生双重错误语义 |
| CLI 通过 MCP 调用业务 | CLI 被迫依赖 MCP 生命周期和 transport |
| MCP 直接访问 SQLite / ledger 并复制查询逻辑 | 产生第二套关联、权限、排序与只读实现 |
| 将每个 CLI 命令机械注册为 MCP 工具 | 暴露过多运维能力，增加工具发现成本和攻击面 |
| `pd_execute({ command, args })` 或任意 SQL / 文件路径工具 | 无法可靠限制权限和副作用 |
| MCP 直接调用 `HostRuntime.dispatch()` 并由模型提供事件身份 | 允许模型伪造宿主事件，混淆观察事实和自报信息 |
| MCP 返回“允许执行”并将其视为 RuleHost 放行 | MCP 不是强制门禁路径 |

### 6.3 共享与独立清单

| 项目 | 共享？ | 规则 |
|---|---|---|
| 业务用例与领域规则 | 是 | 单一权威实现 |
| 输入校验与业务 Schema | 是 | 版本化、可测试 |
| 权限和数据披露规则 | 是 | 不能由入口自行放宽 |
| 关联、排序与证据语义 | 是 | 入口不得各自重写 |
| 状态码、部分可用语义 | 是 | 业务结果语义一致 |
| CLI flags / 命令帮助 | 否 | CLI 自己管理 |
| 终端表格、颜色、确认提示 | 否 | CLI 自己管理 |
| MCP 工具描述与 JSON Schema | 否（但与业务契约一致） | MCP Adapter 负责协议呈现 |
| MCP transport / lifecycle | 否 | 只存在于 MCP Adapter |
| MCP 工具可见清单 | 否 | 必须是明确批准的白名单 |
| Hook 事件与 RuleHost 执行 | 不由 MCP 共享 | 保留独立权威路径 |

---

## 7. MCP 工具颗粒度准则

### 7.1 设计原则

一个 MCP 工具应当对应一个**目标明确、权限边界一致、副作用等级一致、结果范围可控**的业务任务。

不按内部函数逐个暴露，也不创建一个包办所有事情的通用工具。

### 7.2 合并与拆分规则

可以合并的条件：

- 操作服务于同一个用户/Agent 目标；
- 权限要求相同；
- 副作用等级相同；
- 错误与部分可用语义可以统一表达；
- 组合结果能减少 Agent 自行拼接和推断；
- 输出仍可限制在合理预算内。

必须拆分的条件：

- 一个动作读取摘要，另一个动作读取敏感原文；
- 一个动作只读，另一个动作写入；
- 一个动作是建议，另一个动作会改变持久状态；
- 不同动作需要不同 Owner 授权；
- 结果体量或数据披露范围明显不同；
- 合并会迫使工具暴露通用 SQL、路径或任意命令参数。

### 7.3 工具数量不作为目标

首版不以“最少工具数”为 KPI。三到五个边界清晰的工具可以优于一个超级工具，也可以优于十几个底层函数工具。真正的验收目标是：Agent 能正确选择工具、理解返回状态、不过度读取数据，并且不能越权。

---

## 8. 能力目录与候选接口

下列名称是建议的外部工具名，尚未注册、实现或冻结。最终命名需在 Gate 1 通过后固定。首版建议采用 `pd_` 前缀和 snake_case，以便在不同宿主中保持一致。

### 8.1 候选能力矩阵

下列能力是候选，不代表已批准为 MCP 工具。是否暴露取决于真实工作流、Skill+CLI 对照、数据披露授权和 Owner 决策。

| 能力 / 候选工具 | 当前实现映射 | 目标用途 | 当前决策 |
|---|---|---|---|
| `pd_recall_principle_pains` | `recallPains()` in `pd-cli/src/services/pain-recall.ts` | 按规范原则 ID 查询有来源关联的历史 Pain | **最有现成契约基础的候选**；仍须证明 Skill+CLI 不足，并先解决字段披露授权 |
| `pd_get_runtime_features` | `buildRuntimeFeaturesStatus()` in `pd-cli/src/commands/runtime-features.ts` | 查询有效 Feature Flags 与配置错误 | **内部能力候选，不默认暴露为 MCP 工具**；须有具体 Agent 工作流证明其价值 |
| `pd_get_applicable_guidance` | `readPromptActivationCandidates()`、`buildActivePrinciplePromptContext()` | 按需查询原则指导 | **暂缓外部暴露**；当前宿主可能已自动注入，不应默认重复提供 |
| `pd_trace_pain` | `PainChainReadModel.traceByPainId()` | 查询 Pain 到诊断、候选、原则及后续状态的关联链 | **暂缓**；先满足严格只读和来源语义要求 |
| `pd_get_capability_status` | 目前没有已冻结的统一业务用例 | 查询能力可用性 | **从首批候选移除**；待具体工作流出现后再设计 |
### 8.2 `pd_get_runtime_features`（内部能力候选，不是首个 MCP 工具）

目的：返回 PD 的有效 Feature Flag 与配置状态，不声称覆盖所有治理数据源的完整健康情况。除非 Gate 2 证明某个 Agent 工作流确实需要此查询且现有 Skill+CLI 不足，否则只保留为内部应用能力/CLI 复用候选，不注册为 MCP 工具。

建议输入：
- 无业务参数。
- 可选 `includeDisabled` 仅在 Owner 批准且有明确使用场景时提供；默认返回有限的有效配置摘要。

要求：
- 工作区由可信 MCP Server 配置绑定。
- 不接受模型提供任意 `workspaceDir`。
- 对外响应不得包含本机绝对路径、密钥、环境变量或不必要的内部配置内容。
- 明确区分配置缺失并采用默认值、配置有效、配置降级、配置错误。
- 不得将 Feature Flag 的启用状态解释为该功能的端到端运行已被验证。
- 复用 `buildRuntimeFeaturesStatus()` 的配置计算逻辑；需要把业务结果构建与 CLI 的终端输出分开。

### 8.3 `pd_get_applicable_guidance`（暂缓外部暴露）

目的：获取当前工作区下的原则指导候选。由于宿主 Hook 可能已经自动注入原则，不能把重复读取作为默认需求；只有 Gate 2 找到当前注入机制无法满足的真实场景，才继续评估 MCP 暴露。

建议输入：
- `purpose`：受限枚举，用于说明调用目的；默认值需经评审。
- `maxItems`：有上限的正整数；默认小集合，不能由模型请求无限结果。

要求：
- 不允许模型自行声明可信 `hostKind`、Hook 事件或本轮注入回执。
- 响应必须区分 `eligible_candidates` 与 `confirmed_injected`。
- 只有在存在可信宿主回执或权威上下文时，才允许返回 `confirmed_injected`。
- 如果当前宿主的实际提示路径无法被确认，返回 `unconfirmed`，不得猜测。
- 必须保留现有资格、预算和宿主分流规则，不得为了 MCP 方便而重新实现一套原则筛选。
- 默认只返回必要的原则文本和来源引用；不得顺带返回未授权的历史原始 Pain 文本。

### 8.4 `pd_recall_principle_pains`

目的：复用现有 Recall 关联规则，返回可验证地关联到指定原则的历史 Pain。

建议输入：
- `principleId`：必填，规范原则 ID。
- `limit`：可选，默认 3，允许范围 1–10（与现有服务限制保持一致，最终以实现时主干为准）。
- `painId`：可选的精确筛选项，只有在必要且通过授权评审后开放。

要求：
- 必须复用 `recallPains()` 的权威关联规则；不得通过文本相似度猜测关联。
- 保留现有 `pd.pain-recall.v1` 的业务语义或提供显式、可测试的版本映射；不允许两个入口各自重新定义关联关系。
- 首版默认只返回经过批准的摘要、关联类型、证据引用、时间和来源状态。
- `text`、`correctionEvidence`、Owner 原话、完整诊断证据等敏感字段不得默认对 Agent 暴露。
- 原始文本字段的披露必须由单独的 Owner 决策和数据披露策略明确授权；“原则已激活”不等于“历史文本可披露”。
- 对缺失、不可读、部分可用和无关联结果分别返回状态；不得把读取失败转换为 `no_matches`。
- 保留严格只读属性：缺失的数据库保持缺失；不创建目录、数据库、表、锁文件、WAL/SHM sidecar；已有文件内容和数据库 schema 不变。

### 8.5 `pd_trace_pain`

目的：为已知 Pain ID 查询可信的处理链路。

开放前置条件：
- 修复或绕过 `PainChainReadModel` 默认 `RuntimeStateManager` 初始化行为，确保服务使用 `readonly: true`、`bootstrapIfMissing: false`。
- 完成缺库不创建、文件哈希不变、schema 不变、无 sidecar 文件的测试。
- 对返回的每个关联边提供证据来源；不允许把候选 ID、任务 ID、产物 ID误当成 Pain ID。
- 默认不返回原始私人文本。
- 对无关联、部分来源缺失、来源不可读和未授权分别返回明确状态。

在这些条件通过之前，不得在 MCP 工具白名单中注册该能力。

### 8.6 首版明确排除的工具

最新 Codex 主干已有 `pd pain explicit` Skill+CLI 路径：它要求 Owner 在当前消息中明确请求登记，并使用宿主 Hook 写入的 live-turn context 绑定真实会话身份，再进入既有准入链。该路径属于**宿主绑定的写入用例**，不应为追求入口统一而转成通用 MCP 写工具。

以下工具不属于本版首批范围：

- `pd_submit_pain_signal`
- `pd_record_owner_statement`
- `pd_promote_evidence`
- `pd_approve`
- `pd_activate`
- `pd_rollback`
- `pd_execute_rule`
- `pd_dispatch_host_event`
- 任意 SQL、文件系统、Shell、脚本或通用命令执行工具

原因是它们涉及信任来源、状态变化、审批或强制执行，必须拥有独立的写入契约与授权决策，不能搭载在首版只读能力层上。现有 `pd pain explicit` 的存在也不能作为 MCP 必要性的证据；Gate 2 必须评估当前 Skill+CLI 在目标宿主上的实际效果。

---

## 9. 通用业务契约

### 9.1 契约设计要求

- 请求和响应必须版本化。
- 业务层使用普通类型与 Schema，不依赖 MCP SDK 类型。
- MCP Adapter 根据 MCP 协议输出工具定义和结构化内容。
- CLI 可将同一业务结果映射为 `--json` 输出或人类可读终端输出。
- 不允许通过文本匹配解析另一个入口的 stdout 作为业务接口。
- 输入字段必须有明确的类型、范围、默认值与未知字段策略。
- 不接受任意文件路径、数据库路径、SQL、命令名或任意对象属性路径。
- 输出必须有限长；列表有最大条数，文本有长度上限，必要时使用游标分页。
- 不应返回本机绝对路径、环境变量、密钥、内部 token、任意堆栈或非必要的内部目录结构。

### 9.2 建议的业务结果信封

下列 JSON 是契约示意，不代表当前代码已经实现：

```json
{
  "schemaVersion": "pd.capability.v1",
  "capability": "pd_get_runtime_features",
  "status": "ok",
  "data": {
    "features": [],
    "enabledCount": 0,
    "disabledCount": 0
  },
  "provenance": {
    "workspaceBinding": "configured",
    "sources": [
      { "name": "pd-config", "status": "ok" }
    ]
  },
  "warnings": [],
  "error": null,
  "nextAction": null
}
```

字段语义：

- `schemaVersion`：业务结果契约版本，不等同于 MCP 协议版本。
- `capability`：实际执行的业务能力标识。
- `status`：稳定的业务状态枚举。
- `data`：经权限与披露策略过滤后的业务数据。
- `provenance`：来源和可信绑定的最小必要说明；`sources` 使用 `{name,status}` 结构，不暴露绝对路径。
- `warnings`：对象数组 `{code,message}`；不能在一个能力中定义字符串、另一个能力中定义原因码。
- `error`：`null` 或 `{code,message}`；只包含稳定、可公开的业务错误，不含堆栈、路径或敏感内容。
- `nextAction`：`null` 或 `{code,message}`；不得指示绕过安全门禁。

Gate 1 必须为每个能力冻结字段与版本兼容策略。拟议默认防护上限为：列表最多 10 项、单次结构化响应最多 32 KiB、单个自由文本字段最多 2,000 字符、只读查询默认 10 秒截止时间；这些数值在实现前须经评审冻结。超过限制时必须返回明确的 `partial` 状态和 `result_limit_reached` 警告，不得静默截断或悄悄丢弃证据。
### 9.3 状态语义

建议业务状态至少支持：

| 状态 | 含义 |
|---|---|
| `ok` | 查询成功且结果完整 |
| `no_matches` | 查询成功，但没有符合条件的记录 |
| `partial` | 部分来源可用或结果不完整；必须指出缺失来源 |
| `unconfirmed` | 现有证据不足以确认所请求的语义，例如无法确认本轮实际注入原则 |
| `denied` | 当前调用没有权限读取该数据或执行该能力 |
| `unavailable` | 必需的数据源或服务不可用 |
| `invalid_input` | 输入不满足 Schema 或业务约束 |
| `not_found` | 精确标识的对象不存在；仅在不会与 `no_matches` 混淆时使用 |

`source_missing`、`source_unreadable` 等既有 Recall 原因码可保留在领域结果中，并按以下规则映射到外层状态：

- 必需来源缺失/不可读，导致查询主体无法建立：`unavailable`，并设置 `error.code`（例如 `source_missing` / `source_unreadable`）。
- 可选来源缺失，但结果仍可部分建立：`partial`，并列出缺失来源。
- 查询成功且没有匹配记录：`no_matches`。
- 精确 ID 指向的对象不存在：`not_found`。
- 因披露策略拒绝敏感字段：`denied`，不得降级成空结果。
- 结果因大小或数量上限而受限：`partial` + `result_limit_reached`。

映射规则必须有测试；不能将缺失、不可读、未授权和真实空结果混为一谈。

MCP 协议级错误（例如无效工具名、协议错误）与业务状态必须区分。不能把权限拒绝、数据库故障或无结果一律包装为成功，也不能把业务上正常的 `no_matches` 误报为 transport 故障。

### 9.4 来源与证据

- 来源字段只能由可信服务端根据实际读取路径产生。
- 模型不能通过参数伪造 `hostKind`、`sessionId`、`rolloutId`、工具调用 ID 或 Hook 事件身份。
- 对“宿主观察到的事件”与“模型主动报告”必须使用不同的来源类别。
- 返回关联证据引用时，必须说明其含义和关联类型；不得把引用存在等同于内容已披露授权。
- 日志只记录最小必要元数据；不得无意将敏感原始文本复制到 MCP 调试日志。

---

## 10. 工作区绑定、授权与安全不变量

### 10.1 工作区绑定

1. 单工作区 Pilot 中，MCP Server 在启动时绑定到可信配置确定的工作区。
2. 工具参数不得覆盖工作区路径。
3. Server 启动时校验工作区绑定与安装配置；绑定失败时工具不可用。
4. 如果未来支持多工作区，必须由可信的配置/授权层选择工作区，不能让模型传入任意路径。
5. 不得跨工作区读取 ledger、trajectory DB 或 state DB。
6. 必须遵守现有 workspace leak guard 和安装布局约束；不能自行推断替代路径。
7. 启动时解析工作区规范化绝对路径；所有数据源路径必须从该绑定根目录派生。若符号链接或路径解析导致读取越出已批准工作区，必须拒绝。
8. 工具参数或未经验证的环境变量不得在调用期间覆盖工作区绑定。环境变量仅可用于启动时显式配置解析，并须在服务启动后冻结。

### 10.2 最小权限

- 首版默认只读。
- MCP 工具只注册白名单中的能力。
- 工具的权限在服务端执行，不能依赖工具描述中的自然语言告诫。
- 不允许任意命令执行、任意 SQL、任意路径读取或通用对象分发。
- 只读能力不得在后台创建任务、修复数据、迁移 schema 或更新缓存文件。
- 未来若引入写入能力，必须另立写入 SPEC，逐项定义授权、幂等、审计、回滚和失败语义。

### 10.3 只读不变量

对所有被标记为只读的应用用例，必须验证：

- 缺失数据库保持缺失；
- 缺失目录保持缺失；
- 不创建 schema、表、迁移记录、锁文件、WAL/SHM/journal sidecar；
- 现有 ledger、SQLite 文件的字节哈希与大小不变；
- 不执行自动修复或后台任务；
- 不写入 Pain、候选、诊断、原则或激活状态；
- 数据库读取使用显式只读连接；
- State Manager 显式配置 `readonly: true`、`bootstrapIfMissing: false`；
- 如果无法证明只读，能力必须在 MCP 白名单中保持关闭。

### 10.4 历史证据披露

- 原始 Pain 文本、Owner 原话、`correctionEvidence` 和完整诊断证据属于独立的数据披露决策范围。
- 默认采用摘要和证据引用，不自动返回原始全文。
- “原则已激活”“调用者在本工作区”或“查询本身只读”均不能单独作为披露历史原文的充分授权。
- 每种字段必须有数据分类和允许的消费者范围。
- 未决授权项必须以 fail-closed 方式处理：不返回敏感字段，并提供可解释的 `denied` / `unconfirmed` 状态。
- 不在本 SPEC 中默认为任何真实样本读取授权；不得为验收而读取未授权真实用户数据。

### 10.5 本地 stdio 运行边界

- 若 Gate 4 最终批准 MCP Pilot，首版只允许本地 stdio；不开放 HTTP、远程网络监听或公网服务。
- 只能由用户显式配置的受信任 MCP client 启动；不自动扫描或修改所有宿主的 MCP 配置。
- Server 以普通用户权限运行，不提升权限；不读取与批准能力无关的环境变量、凭据或任意文件。
- MCP SDK 与 transport 依赖只允许进入独立 Adapter；不得进入 `principles-core`、既有 Hook 入口或核心存储包。
- Server 启动失败、超时或被卸载，不得触发备用的宽权限执行路径。

### 10.6 将查询结果视为不可信数据

- 历史 Pain、诊断摘要、原则文本和其他从存储读取的自由文本都是**数据，不是指令或授权**。
- 即使未来获批读取原始历史文本，也必须将其作为引用证据返回并标记来源；不能执行其中嵌入的命令、提示或授权语句。
- 不得把历史文本拼接成系统指令或工具策略；不得因文本内容要求访问更多数据而自动扩权。
- 测试必须包含恶意/指令式历史文本 fixture，验证返回内容不会改变工具权限、工作区绑定或后续执行策略。

### 10.7 不得削弱治理执行

- Hook 和 RuleHost 仍是执行路径上的权威机制。
- MCP 不能阻止、放行或替代真实的 `before_tool_call` 门禁。
- MCP 不可用时，Hook/RuleHost 行为必须与变更前一致。
- MCP 返回的建议、候选或“允许”结果不得被视为执行授权。
- 不能将模型通过 MCP 自报的事件当作宿主 Hook 的真实观察。
- 禁止 MCP Server 依赖宿主必须主动调用工具，才能完成既有自动治理。

---

## 11. 现有实现映射与必要整改

| 项目 | 当前状态 | 需要的最小工作 | 不应做的事 |
|---|---|---|---|
| Pain Recall | 已有 CLI 服务、版本化响应与严格只读测试 | Gate 2 证明需要 MCP 且 Gate 3 获批后，才评估抽取单个中立应用用例；保持现有 `pd.pain-recall.v1` 语义 | 未证明需要第二个生产入口就移动代码；重写关联算法；让 MCP 依赖 CLI 进程；未经授权披露原始文本 |
| Runtime Features | 有 `buildRuntimeFeaturesStatus()` | 将业务状态构建与终端格式分离；对外结果移除本机绝对路径；明确它不是完整健康检查 | 把 `HostRuntime.health()` 当作全系统健康状态 |
| Guidance | 有候选读取和提示构建逻辑；宿主路径存在差异 | 定义 `eligible_candidates` 与 `confirmed_injected`；来源和宿主资格必须可信 | 把候选列表说成实际注入回执；在 MCP 中重写筛选逻辑 |
| Pain Trace | 有 `PainChainReadModel` | 先提供严格只读构造路径与文件不变性测试 | 默认构造后直接开放 MCP |
| Pain Ingress / `pd pain explicit` | 存在多种准入路径；最新 Codex 已有使用 host-written live-turn context 的 Skill+CLI 显式登记命令 | MCP 首版保持只读；现有 `pd pain explicit` 继续走 Codex CLI/Hook 与既有准入链 | 将模型提供的 session/turn ID 当可信身份，或复制为通用 MCP 写工具 |
| Host Runtime | 已处理生命周期事件 | 仅供可信宿主适配器按现有契约调用 | 把 `dispatch()` 作为通用 MCP 工具 |
| Host Capability Matrix | 部分描述落后于当前实现 | Gate 0 更新并附源码证据与测试状态 | 直接把旧矩阵复制到新 SPEC 当作当前事实 |

### 11.1 必须解决的包边界（仅在 Gate 2 通过后进入代码抽取）

当前 `recallPains()` 位于 `packages/pd-cli/src/services/pain-recall.ts`，但它的业务语义并不只属于 CLI。若 Gate 2 证明需要第二个生产入口，抽取时应：

1. 先建立依赖图和 import 审计；
2. 将业务查询、结果类型和状态映射移至中立应用服务；
3. 让 CLI 命令继续调用新服务；
4. 保留旧 CLI 参数、输出和退出码；
5. 确保新应用服务不依赖 `@principles/pd-cli`；
6. 如果提取需要移动共享 helper，应采用最小移动，不重写核心存储模块；
7. 在 Gate 2 通过之前，不要求移动此服务；现有 CLI 服务可继续作为契约分析与只读测试的基准。

### 11.2 必须修复的严格只读风险

`PainChainReadModel.getStateManager()` 当前默认使用 `new RuntimeStateManager({ workspaceDir: this.workspaceDir })`。而 `sqlite-connection.ts` 默认 `readonly` 为 `false`、`bootstrapIfMissing` 为 `true`。

因此：
- 在 `pd_trace_pain` 被允许注册之前，必须提供明确只读的构造/注入路径；
- 不能只用 mock 验证调用结果；
- 必须用真实临时文件 fixture 检查数据库、ledger、schema 与 sidecar 不变；
- 若无法证明严格只读，宁可不暴露 trace 工具，也不能降低门槛。

---

## 12. 分阶段实施与决策 Gate

阶段顺序刻意将**契约设计、MCP 必要性、代码抽取、生产 MCP**分开。前一个 Gate 未通过，不进入后一个 Gate。

### Gate 0 — Reality Audit 与 Owner 场景冻结

**目标：** 确认最新源码事实、目标宿主和具体任务，防止以过时文档或抽象愿望驱动架构升级。

必须完成：
- 核对最新 `main`、包版本、依赖方向、公共 exports、安装包、Feature Flag 与现有 MCP client 能力；
- 更新 Host Capability Matrix，明确源码实现、生产路径、安装状态、真实宿主验证、Agent 可调用性；
- 将现有 Skill+CLI 能力纳入基线；Codex 场景应评估 `pd pain recall`、`pd pain explicit` 等相关真实入口；
- 指定一个高价值真实工作流，说明使用者、触发时机、输入、期望结果和失败代价；
- 明确历史 Pain 原始文本与 Owner 原话的数据分类及授权状态；
- 对照 PRR v1.3、Pain Recall CLI SPEC、ADR-0020，记录兼容边界；
- 确认诉求究竟是业务工具可调用，还是 Hook / lifecycle 接入缺口；二者不得混为一谈。

通过条件：
- 每项关键结论都有当前源码路径、符号或测试证据；
- 事实、推断、建议分开；
- 目标工作流与当前 Skill+CLI 基线明确；
- Owner 批准继续进入契约设计。

未通过：停止在只读调查阶段，不改运行时代码。

### Gate 1 — Application Capability Contract（纯设计阶段）

**目标：** 冻结候选业务能力的语义，但不预先承诺新包或生产代码重构。

必须完成：
- 冻结候选能力目录、请求/响应 Schema、错误状态、来源语义、权限与数据披露；
- 对每项候选能力标记权威实现、必需/可选数据源、副作用等级和输出限制；
- 明确应用能力目录与 MCP 工具白名单是两份不同清单；
- 为现有 Recall 建立契约映射，不改写其关联规则；
- 明确 Hook / RuleHost 不由该能力层替代；
- 不创建 `packages/pd-application`，不引入 MCP SDK，不移动源代码。

通过条件：
- 业务契约可以独立于 CLI 参数和 MCP SDK 描述；
- 所有状态、警告、错误与数据披露规则无歧义；
- Owner 审阅候选工具及其真实使用场景。

未通过：保留现有实现，不进行代码抽取。

### Gate 2 — MCP 必要性与增量价值证明

**目标：** 证明 MCP 对一个具体场景有必要，而非因为“支持 MCP”本身。

必须提供：
- 一个可复现的目标宿主任务；
- 当前 Skill+CLI / 原生 Host Tool 无法可靠完成任务的具体证据，而不是“工具调用不够统一”；
- 对照实验：现有方式与一个**一次性、非生产** MCP 技术验证的任务成功率、错误率、调用轮次、结果体量、配置步骤、恢复方式和维护成本；
- 技术验证仅使用合成 fixture 或明确授权的数据；不得读取未授权的真实历史样本；
- 明确目标宿主的 MCP client 支持、安装机制、权限边界与卸载方式；
- 如果测试只能通过启动 CLI 子进程、复制业务逻辑或放宽权限实现，必须将其作为失败/成本证据，不得直接带入生产。

通过条件：
- Skill+CLI 的不足可复现，且无法通过小幅修复现有入口合理解决；
- MCP 在该场景提供可量化的净增量；
- 增量大于新增依赖、安装复杂度、安全风险与维护成本；
- Owner 明确批准生产 MCP Pilot。

如果 Skill+CLI 已可靠满足需求，或目标宿主无法安全支持 MCP：Gate 2 失败即为有效结论；停止 MCP 建设，不视为架构项目失败。

### Gate 3 — 最小共享应用用例抽取（仅 Gate 2 通过后）

**目标：** 为被批准的首个 MCP 工具建立唯一业务实现，同时保持 CLI 兼容。

必须完成：
- 根据依赖图选择最小的 host-neutral application service；新建独立包不是默认选项；
- 抽取一个被批准的用例（Recall 可作为候选），让 CLI 与未来 MCP Adapter 调用同一业务服务；
- 应用服务不依赖 CLI、MCP SDK 或具体 Agent SDK；
- 不复制关联规则、权限、来源或错误映射；
- 保留既有 CLI 参数、JSON 语义、终端输出与退出码；
- 对被标记为只读的路径完成真实文件/数据库不变性测试；
- `PainChainReadModel` 在任何对外开放前必须满足严格只读要求。

通过条件：
- CLI 回归测试通过；
- 应用服务与 CLI 的业务结果一致；
- 无依赖环、无重复业务实现；
- 只读、来源、错误与字段披露测试全部通过；
- Owner 审阅抽取 diff 与测试证据。

若 Gate 2 未通过，默认不执行 Gate 3。若有独立证据证明应用服务抽取本身对现有 CLI 有价值，须由 Owner 单独批准，不得借 MCP SPEC 自动授权。

### Gate 4 — 单宿主只读 MCP Pilot（仅 Gate 3 通过后）

**目标：** 验证生产 MCP Adapter，不改变治理核心。

范围：
- 本地 stdio；
- 一个明确的目标宿主、一个绑定工作区；
- 默认只读，仅注册批准的白名单工具；
- 不包含写入、审批、激活、回滚、RuleHost 或通用执行能力；
- MCP SDK 仅存在于独立 MCP Adapter 的依赖边界，不进入 `principles-core`、Hook 路径或存储包。

通过条件：
- 工具发现与输入 Schema 验证通过；
- MCP 与 CLI 共用同一应用服务，业务语义一致；
- 错误、部分可用、拒绝、无结果与数据源缺失可区分；
- 输出大小、路径边界和敏感字段过滤符合契约；
- 只读不变性测试通过；
- 恶意历史文本 fixture 不会改变工具权限或触发其他动作；
- Hook/RuleHost 回归测试证明治理行为未改变；
- 安装、禁用、卸载、崩溃和恢复均有测试证据。

### Gate 5 — 扩展其他宿主（单宿主 Pilot 通过后）

- 每个宿主独立验证安装、工具发现、参数传递、错误处理和卸载；
- 不允许从一个宿主的成功推断所有宿主可用；
- 保持统一业务契约，但允许宿主安装配置和 transport 细节不同；
- MCP 能力支持与 Hook/lifecycle 支持分别记录；
- 只有在跨宿主真实安装与调用证据充分后，才更新“多宿主支持”声明。

---

## 13. 测试与验收矩阵

### 13.1 应用服务层

- [ ] 输入 Schema 的必填字段、范围、未知字段与边界值；
- [ ] 同一输入在不同入口得到相同的业务结果与来源语义；
- [ ] `ok`、`no_matches`、`partial`、`unconfirmed`、`denied`、`unavailable` 与 `invalid_input` 的映射；
- [ ] 排序、关联规则和限制条数保持确定性；
- [ ] 不通过文本相似度猜测 Pain 与原则之间的关联；
- [ ] 数据源缺失与不可读不会被误报为空结果；
- [ ] 敏感字段过滤在应用服务层完成，而不是只依赖 MCP UI；
- [ ] 输出长度、列表上限、超时和分页边界；
- [ ] 超限返回明确状态/警告，不静默截断；
- [ ] 错误不包含堆栈、密钥或不必要的绝对路径；
- [ ] 工作区路径不能通过符号链接逃逸到未授权目录；
- [ ] 历史文本中的指令式内容被视为不可信数据，不改变工具权限或执行策略。

### 13.2 严格只读

- [ ] 所有数据源缺失时，不创建任何目录或文件；
- [ ] 缺失 `state.db` / `trajectory.db` 时保持缺失；
- [ ] 查询前后 SQLite 文件 SHA-256、文件大小不变；
- [ ] schema/table 列表不变；
- [ ] 不生成 WAL/SHM/journal sidecar；
- [ ] ledger 与锁文件不变；
- [ ] 不运行迁移、自动修复、诊断任务或写入；
- [ ] 只读配置由服务端强制设置；
- [ ] 真实文件 fixture 测试通过，不能只依赖 mock。

### 13.3 CLI 兼容

- [ ] 现有命令名称、flags、默认值、帮助信息不意外改变；
- [ ] `--json` 输出保持兼容，或按明确的版本迁移策略更新；
- [ ] 终端输出仍由 CLI Adapter 负责；
- [ ] 退出码语义不因共享应用服务抽取而改变；
- [ ] CLI 在 MCP SDK 未安装、MCP Server 未启动或不可用时仍能正常工作；
- [ ] CLI 不启动 MCP 子进程来执行普通业务。

### 13.4 MCP Adapter（仅 Gate 4 后）

- [ ] 只注册显式白名单工具；
- [ ] 不存在任意 SQL、任意路径、Shell 或命令执行入口；
- [ ] 参数 Schema 与应用服务契约一致；
- [ ] 工作区绑定不能由工具参数覆盖；
- [ ] MCP 调用结果与 CLI 共用同一业务服务；
- [ ] transport 错误与业务状态分离；
- [ ] 响应大小、文本长度、列表数有上限；
- [ ] 未授权字段不会出现在结构化响应或文本 content 中；
- [ ] Server 禁用/崩溃不影响 Hook 和 RuleHost；
- [ ] Server 只通过显式配置以本地 stdio 启动，不开启网络监听；
- [ ] 工作区路径被规范化，符号链接越界时 fail-closed；
- [ ] 工具调用审计日志最小化，不记录敏感原文；
- [ ] MCP Adapter 可独立卸载，不破坏 CLI 安装；
- [ ] 对照测试证明目标工作流相较当前 Skill+CLI 有净增量。

### 13.5 宿主与治理回归

- [ ] OpenClaw 的既有 Hook / prompt 注入路径不变；
- [ ] Codex 的既有 Hook / RuleHost 路径不变；
- [ ] WorkBuddy 的既有 Hook / RuleHost 路径不变；
- [ ] MCP 不可用时治理行为与变更前一致；
- [ ] 模型通过 MCP 自报事件不能伪装为 Hook 观察；
- [ ] 不新增真实模型调用或真实数据读取，除非有独立 Owner 授权；
- [ ] 测试报告区分源码覆盖、模拟宿主测试与真实宿主验证。

---

## 14. 失败处理、降级与回滚

### 14.1 业务查询失败

- `source_missing`：明确指出缺失来源，不创建来源；
- `source_unreadable`：明确指出无法读取，不降级成空列表；
- `partial`：列出缺失或不可读来源；
- `denied`：不返回敏感内容；提示需要经过批准的授权流程；
- `unconfirmed`：不把未知事实伪装成已确认；
- `invalid_input`：返回稳定原因码与合法参数范围；
- transport 故障：由 MCP 协议层表达，不改变业务状态。

### 14.2 MCP 故障

- MCP Server 不启动、崩溃、卸载或连接断开时，CLI 必须继续工作；
- 不允许 MCP 失败触发隐式写入、自动修复或回退到更宽松的权限；
- 不允许 MCP 故障改变 Hook/RuleHost 的门禁；
- MCP 工具不可用时，Agent 可以按既有批准路径使用 CLI/Skill；不能因此开放更高权限的备用接口。

### 14.3 回滚

- 应用能力抽取与 MCP Adapter 必须能独立回滚；
- 若 CLI 迁移后出现行为回归，恢复 CLI 对旧服务路径的调用，但不保留重复业务实现作为长期状态；
- MCP Pilot 通过独立 Feature Flag 或安装选项关闭/卸载；
- 回滚不应要求修改或重建用户数据库；
- 任何回滚都必须证明现有 Hook/RuleHost 行为没有变化。

---

## 15. 可观测性与成功指标

不以 MCP 工具数、SDK 使用量或新增代码量衡量成功。建议采集最小、非敏感的指标：

- 任务完成率：相同业务任务在 Skill + CLI 与 MCP 路径的成功率；
- 误调用率：Agent 选错工具或提供非法参数的比例；
- 部分可用识别率：是否正确区分空结果、来源缺失与读取失败；
- 权限拒绝正确率：敏感字段是否被正确拒绝；
- 工具调用数量与总结果字节数；
- 完成同一任务所需的 Agent 轮次与上下文 token（如可可靠测量）；
- 安装、配置、故障恢复和卸载所需步骤；
- CLI 兼容性回归；
- Hook / RuleHost 回归；
- 严格只读不变性测试结果；
- 每个宿主的独立验证状态。

不得记录未经授权的原始 Pain 文本、Owner 原话或完整敏感证据以计算指标。

---

## 16. 风险登记

| 风险 | 严重性 | 缓解措施 | 停止条件 |
|---|---|---|---|
| MCP 被当成 Hook 替代品 | 极高 | 架构隔离与治理回归测试 | 任一既有强制门禁依赖 MCP 可用性 |
| 通过工具参数切换工作区 | 极高 | 可信配置绑定，参数禁止覆盖 | 存在任意路径读取路径 |
| 历史原始文本越权披露 | 极高 | 默认摘要；字段级披露门禁；Owner 明确批准 | 无法证明授权或响应包含未批准字段 |
| 只读接口初始化/修改数据库 | 高 | 显式只读连接与文件不变性测试 | 缺失文件被创建或已有文件改变 |
| MCP 与 CLI 业务语义漂移 | 高 | 单一应用服务、契约测试 | 两入口重复实现关联/权限逻辑 |
| 应用层抽取造成依赖环 | 高 | Gate 0 依赖图审计，禁止入口反向依赖 | 无法解释或解除循环依赖 |
| 工具颗粒度过细 | 中 | 按业务目标与权限边界评估 | Agent 需要自行拼接内部存储细节 |
| 工具颗粒度过粗 | 高 | 禁止通用执行器，按副作用拆分 | 工具可任意调用内部操作 |
| 仅一个宿主通过就声称全宿主支持 | 中 | 每宿主单独 Gate | 没有实际安装/调用证据 |
| 为了架构统一而无必要地建设 MCP | 高 | Gate 2 量化对照与停止条件 | Skill + CLI 已充分满足真实需求 |
| 将 MCP 误认为 Hook / lifecycle 插件化方案 | 高 | 将两类适配面分开设计、分开验收 | 方案声称 MCP 可替代 Hook 或 RuleHost |
| 在 MCP 必要性未证明前创建应用包/移动代码 | 中 | Gate 1 仅冻结契约，Gate 2 通过后才抽取 | 没有第二个生产消费者或可量化收益 |
| 历史文本包含提示注入内容 | 高 | 将存储文本视为不可信数据；默认摘要并限制披露 | 文本内容能改变权限、工作区或执行路径 |
| workspace 符号链接越界 | 高 | 规范化根路径并检查每个来源路径 | 读取到已批准工作区之外的数据 |

---

## 17. Owner 决策项

以下事项必须由 Owner 明确决定，不能由实现者自行推断：

1. **本 SPEC 是否批准进入 Gate 0 / Gate 1？** 这只授权能力抽象和契约设计，不代表批准建设 MCP Server。
2. **第一个真实目标场景是什么？** 必须指出当前 Skill + CLI 或宿主原生工具的具体不足。
3. **第一个真实目标场景是什么，哪项能力真正需要 MCP？** 当前不应把 `pd_get_runtime_features` 自动列为首个 MCP 工具；Pain Recall 只是有现成契约基础的候选，仍需通过 Gate 2。
4. **历史 Pain 原始文本、`correctionEvidence` 与 Owner 原话是否允许任何 Agent read-back？** 如允许，必须明确字段、宿主、目的和审计要求；默认答案为未授权。
5. **MCP Pilot 是否限定为本地 stdio、单工作区、只读？** 建议是；远程/公网 MCP 不在本 SPEC 范围内。
6. **是否需要独立应用包？** 建议在 Gate 2 通过后按依赖图决定；不默认新建 `packages/pd-application`。
7. **首个 MCP 目标宿主是哪一个？** 必须有明确的宿主版本与安装路径证据。
8. **MCP 的增量价值如何度量？** 建议以相同任务下的成功率、调用轮次、错误率、配置成本和安全测试为对照。
9. **是否保留 `pd.pain-recall.v1` 作为业务结果 Schema？** 建议保持既有业务语义，若需调整则明确版本迁移。
10. **是否确认 MCP 只解决业务工具访问，不承担 Hook/lifecycle 插件化？** 建议明确确认；Hook 覆盖缺口应另立 Host Adapter / 插件交付工作。
11. **是否允许未来单独提出写入类 MCP SPEC？** 本 SPEC 不批准写入工具，只允许未来另立 SPEC 进行审查。

---

## 18. 最终验收标准

本 SPEC 的批准分为两个阶段：满足以下前置条件可标记为 `APPROVED_FOR_DISCOVERY`（仅授权 Gate 0/1）；只有 Gate 2 证明 MCP 有必要、Owner 批准生产 Pilot，且 Gate 3 的代码抽取范围明确后，才可标记为 `APPROVED_FOR_IMPLEMENTATION`：

- [ ] 最新主干与相关源码证据已再次核实；
- [ ] 现有 Host Capability Matrix 已更新，事实与推断明确分开；
- [ ] CLI / MCP / Application Capabilities 的关系被明确批准；
- [ ] 已明确是否需要抽取应用服务；不以新建包作为默认前提；
- [ ] 首批能力的请求、响应、状态、权限和数据披露契约已冻结；
- [ ] Recall 的严格只读契约与历史文本披露政策已分开处理；
- [ ] `PainChainReadModel` 的只读风险已明确列入整改并在开放前验证；
- [ ] CLI 兼容与治理路径不变的验收要求已冻结；
- [ ] Gate 2 的 MCP 必要性判据被接受，且明确允许在证据不足时不建设 MCP；
- [ ] Owner 明确批准下一阶段范围。

如果 Gate 0 / Gate 1 通过但 Gate 2 不通过，则契约文档和现有实现映射仍可交付；默认不移动代码、不创建应用包、不建设 MCP Server。**“证明暂时不需要 MCP”是有效的架构结论，不是项目失败。**

---

## 19. 参考证据索引

以下链接固定到本次调查基线 `64568651dc753ff43afc4989440f599769c021f4`，避免后续主干前进后证据链接悄然指向新内容。

1. [最新主干提交](https://github.com/csuzngjh/principles/commit/64568651dc753ff43afc4989440f599769c021f4)
2. [principles-core package manifest](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/principles-core/package.json)
3. [host-runtime package manifest](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/package.json)
4. [pd-cli package manifest](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/pd-cli/package.json)
5. [Pain Recall service](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/pd-cli/src/services/pain-recall.ts)
6. [Pain Recall CLI command](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/pd-cli/src/commands/pain-recall.ts)
7. [Pain Recall strict read-only tests](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/pd-cli/tests/commands/pain-recall-readonly.test.ts)
8. [Runtime features command](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/pd-cli/src/commands/runtime-features.ts)
9. [Pain ingress semantic evaluator](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/principles-core/src/runtime-v2/pain-ingress.ts)
10. [Pain ingress payload schema](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/principles-core/src/runtime-v2/pain-ingress-payload.ts)
11. [Pain chain read model](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/principles-core/src/runtime-v2/pain-chain-read-model.ts)
12. [SQLite connection defaults](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/principles-core/src/runtime-v2/store/sqlite-connection.ts)
13. [Active principle prompt builder](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/src/active-principle-prompt.ts)
14. [Prompt injection projection](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/src/prompt-injection-projection.ts)
15. [Host Runtime](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/src/index.ts)
16. [Governance signal admission](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/host-runtime/src/governance-signal-admission.ts)
17. [Pain Recall CLI SPEC](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/docs/archive/specs/SPEC-PD-PAIN-RECALL-CLI-001.md)
18. [PRR v1.3 SPEC](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.3.md)
19. [ADR-0020 Codex CLI Host Adapter](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/docs/adr/0020-codex-cli-host-adapter.md)
20. [Host Capability Matrix（历史快照，需更新）](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/docs/audit/pri-807-phase0/HOST_CAPABILITY_MATRIX.md)
21. [Codex `pd pain explicit` CLI command](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/pd-cli/src/commands/pain-explicit.ts)
22. [Codex live-turn context bridge](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/codex-adapter/src/ingestion/turn-context.ts)
23. [PD Pain Signal Skill](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/plugins/principles-disciple/skills/pd-pain-signal/SKILL.md)
24. [WorkBuddy HostAdapter implementation](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/workbuddy-adapter/src/host-adapter.ts)
25. [`@google/genai` optional MCP SDK peer dependency in release lock](https://github.com/csuzngjh/principles/blob/64568651dc753ff43afc4989440f599769c021f4/packages/create-principles-disciple/release-locks/core/package-lock.json)

---

## 20. 本版结论

本 SPEC 的第一目标不是“把 MCP 做出来”，而是判断 PD 是否需要一个可复用、可验证、权限清晰的业务能力访问面，并避免为尚未证明的需求提前重构代码。

**v0.2 相较 v0.1 的关键修订：**
1. 调查基线更新至 `64568651dc753ff43afc4989440f599769c021f4`；
2. 纳入最新 Codex `pd pain explicit` Skill+CLI 路径；
3. 明确 MCP 不解决 Hook/lifecycle 插件化，避免对架构收益过度承诺；
4. 将能力契约、MCP 必要性、应用服务抽取、生产 MCP Pilot 拆分为独立 Gate；
5. 取消“先抽取应用层，再证明 MCP 必要”的默认顺序；
6. 将工具候选从内部功能清单改为真实 Agent 工作流驱动；
7. 修正响应信封的字段类型一致性，并补充状态映射、输出上限、路径边界与不可信历史文本约束；
8. 更新 MCP Server 与 Host Capability Matrix 的源码事实表述。

**建议的实施顺序：**
1. Gate 0：核对最新代码、宿主能力与一个具体目标工作流；
2. Gate 1：冻结业务能力契约，不改代码；
3. Gate 2：比较当前 Skill+CLI 与一次性 MCP 技术验证，证明是否存在净增量；
4. 仅当 Gate 2 通过时，Gate 3 才抽取最小共享应用服务；
5. Gate 4 建设一个宿主、本地 stdio、只读 MCP Pilot；
6. Gate 5 按宿主逐个验证；写入能力和敏感历史文本披露另立 SPEC。

最终架构原则：

> **一套权威业务逻辑、多个独立入口、严格的数据与权限边界；MCP 是可选的能力访问适配器，不是新的治理核心。**
