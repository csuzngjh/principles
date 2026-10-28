# SPEC-PD-AGENT-CAPABILITY-API-001

## PD Application Capabilities：宿主无关业务能力契约与可选 MCP Adapter

| 字段 | 内容 |
|---|---|
| SPEC ID | SPEC-PD-AGENT-CAPABILITY-API-001 |
| 版本 | v0.4-draft |
| 状态 | DRAFT — OWNER REVIEW REQUIRED |
| 类型 | 架构与接口契约；不构成 MCP Server 的生产实施授权 |
| 调查基线 | csuzngjh/principles main：3a2de95c84047e720317cc66c9568d5da37843c5 |
| 日期 | 2026-10-28 |
| 前置修复 | PR #2214 已合并，merge commit 为 3a2de95c84047e720317cc66c9568d5da37843c5 |
| 本版目标 | 将现有能力抽象、MCP 边界、首个候选工具、安全契约、Gate 与验收条件落为仓库内可评审的正式草案 |
| 明确非目标 | 不实现 MCP Server、不添加 MCP SDK、不抽取应用包、不修改 Hook/RuleHost、不授权历史敏感文本披露、不授权任何写入工具 |

> 本文中的“当前事实”指调查基线内可定位的代码或文档；“要求/建议”是待 Owner 审阅的目标契约，不代表已经实现或获批。Owner 于 2026-10-28 批准按建议默认方案继续收口 Gate 0/1：Codex CLI 作为候选宿主、按需查询原则关联 Pain、本地 stdio、单一可信工作区、只读工具白名单、默认不披露敏感原文，以及 Gate 2 价值证明前不在仓库引入 MCP SDK 或新应用包。该批准只冻结设计方向，不代表 Gate 0/1 已通过，不授权 Gate 2 真实数据实验、生产代码、宿主安装或 MCP Pilot。

### 版本沿革与证据边界

- 此前工作文档中已有 v0.2-draft，定义了 Application Capabilities、CLI/MCP 分离、只读优先和 Gate 0–5。
- 2026-10-28 的 PR #2214 实施报告引用了一个外部工作区的 v0.3-draft 快照（SHA256：16f827f60610c2387f70cf3d5c4adec03d2679ef36804f6ecbef4f29f79f94f5），但该完整 v0.3 文件此前没有进入仓库主干。
- 因此 v0.4 是将可取得的 v0.2 设计与 v0.3 报告中可验证的决策、代码事实和未决项进行显式整合；不声称逐行继承了未入库的 v0.3 原文。后续若找回 v0.3 原件，应对差异做一次明确对账，而不是静默覆盖历史。
- PR #2214 已修复 pain recall 的 WAL 只读副作用，并合入本版调查基线。该修复是只读安全前置，不是 MCP 实现，也不自动批准 MCP 数据披露或生产接入。

### Owner decision record（2026-10-28）

Owner 已批准继续采用以下设计默认值：

- 候选宿主为 Codex CLI；这是目标工作流的验证候选，不等于已批准生产宿主或已验证 MCP Client 版本。
- 候选工作流为 Agent 在任务中按需查询与指定规范原则有真实来源关联的历史 Pain。
- 如果未来进入 Pilot，传输限制为本地 stdio、单一可信工作区、只读工具白名单。
- 历史 Pain 原文、Owner 原话、correctionEvidence、诊断根因和支持证据正文默认禁止披露。
- Gate 2 证明 MCP 有净增量前，不在仓库添加 MCP SDK 依赖、不创建独立应用包、不移动生产业务代码。

本次批准**未**冻结以下事项：

- 对外精确字段白名单，尤其 painId、occurredAt、source/host、证据引用 ID、原则正文或任何脱敏摘要是否可披露。
- MCP SDK / Codex Client 的精确版本与真实安装兼容性。
- Gate 2 数值阈值与允许成本。
- 访问真实历史数据、运行 PRR v1.3 Gate B 实验或实施生产 MCP 的授权。

**与 PRR v1.3 的边界：** `docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.3.md` 明确将首版 MCP 与 Raw 列为范围外。本 SPEC 是一个独立、后续的应用能力适配器提案，不修改 PRR v1.3，不替代其 Gate B，不授予 Raw 访问权限。MCP Gate 2 只评估集成效用，使用合成夹具；它不是 PRR 的行为收益实验。

---

## 1. 摘要与核心决策

PD 可以建立一套宿主无关的 Application Capabilities（应用业务能力）契约，供 CLI 与未来经过批准的 MCP Adapter 复用。但 MCP 是可选的业务能力访问入口，不是新的治理核心。

核心决策：

1. **内部共享业务用例，外部入口独立。** CLI 与 MCP 必须共享业务语义、关联规则、权限、来源和错误语义；各自保留入口解析、协议注册、呈现与生命周期。
2. **MCP 不包装 CLI。** MCP 不得启动 pd 子进程、解析 CLI stdout 或把命令行输出伪装成应用接口；CLI 也不能依赖 MCP Server 才能工作。
3. **MCP 工具不是 CLI 命令的机械镜像。** MCP 工具白名单必须从业务能力目录中按真实 Agent 工作流、权限、副作用和输出预算单独筛选。
4. **MCP 不替代 Hook / Host Runtime / RuleHost。** 真实宿主事件、提示注入、治理信号准入、强制门禁和 Owner 审批继续走现有权威路径。
5. **先冻结业务契约，再证明 MCP 的净增量。** 先完成当前代码 Reality Audit 和契约设计；生产 MCP 之前，必须证明目标场景不能由现有 Skill + CLI 或宿主原生工具以更低成本可靠满足。
6. **不预先创建 packages/pd-application。** 只有当 MCP 的增量价值通过 Gate 2，且依赖审计证明有必要时，才决定复用现有包、抽取窄应用服务或创建独立包。
7. **首版只读，且“只读”必须可证明。** 缺失数据源保持缺失，现有数据库/ledger 字节不变，不创建 WAL/SHM/journal sidecar，不自动修复或迁移。
8. **数据可读不等于允许 Agent 获取。** 原始 Pain 文本、Owner 原话、correctionEvidence、诊断根因和支持证据正文均不默认对 MCP 暴露。
9. **失败必须可区分。** 空结果、未找到、来源缺失、来源不可读、部分可用、权限拒绝和协议故障不得混为一谈。
10. **一项 Gate 未通过，不推进下一阶段。** 证明 MCP 暂时不值得建设也是有效结论；不得用“架构统一”作为新增服务或依赖的充分理由。

### 1.1 预期结果

- 一套宿主无关、版本化、权限明确的业务能力契约。
- CLI 与 MCP（如获批）共用同一业务实现，而非复制 Recall 或权限逻辑。
- 一个可复现的目标工作流，以及现有 Skill + CLI 与 MCP 的可量化对照。
- 如 MCP 确有净增量，能够在单宿主、本地 stdio、单工作区、只读范围内安全试点。
- 不改变现有 Hook、RuleHost、Pain admission、Owner approval 和原则激活语义。

---

## 2. 背景与问题陈述

当前仓库已有原则账本、轨迹、宿主运行时和 CLI 查询能力，但尚未在主干中交付 PD MCP Server。可选 SDK 依赖或其他产品的 MCP 配置示例都不构成 PD Server 已实现的证据。

当前需要解决的不是“把所有 CLI 命令搬到 MCP”，而是：

- 统一定义哪些业务用例可以被不同入口调用；
- 避免 MCP 依赖 pd-cli 或复制其业务实现；
- 明确每个用例的数据来源、只读等级、权限、披露字段和错误语义；
- 证明 MCP 对一个真实 Agent 工作流带来现有 Skill + CLI 无法合理获得的收益；
- 防止 MCP 被误当成 Hook/lifecycle 插件化、自动注入或治理执行的替代品。

“让 PD 更容易被 Agent 使用”至少有两条彼此独立的集成面：

- **Host Lifecycle Adapter：** 接收真实宿主事件、注入原则、执行现有 RuleHost 门禁、维护可信会话/turn 来源。
- **Application Capability Adapter：** 让 Agent 按需调用已批准的业务查询能力。CLI 是一种入口；MCP 可以是另一种可选入口。

MCP 只覆盖第二条集成面。它不会自动接入 Hook、获得真实宿主事件、补齐 lifecycle 支持或替代 RuleHost。若真实诉求是 Hook 覆盖缺口，应另立 Host Adapter 工作，而不是将其计入 MCP 的收益。

---

## 3. 当前基线事实

以下事实以主干提交 3a2de95c84047e720317cc66c9568d5da37843c5 为调查基线。

| 事实 | 证据与含义 |
|---|---|
| Pain Recall 已有业务读取入口 | packages/pd-cli/src/services/pain-recall.ts 导出 recallPains()，业务 schema 为 pd.pain-recall.v1；应复用既有关联规则，而非重写。 |
| Recall 关联有明确权威边 | principle.reuseEvidence 中的真实 painId；以及 derivedFromPainIds 经 candidate → task → tasks.input_ref 的可验证链路。禁止文本相似度猜测关联，禁止将 candidateId/taskId/artifactId 冒充 painId。 |
| Recall 当前响应包含敏感自由文本 | PainRecallEntry 可包含 pain.text、diagnosis.rootCause、supportingEvidence.note、correctionEvidence.text，原则响应也可能包含文本。MCP 不得直接透传整个 PainRecallResult；必须先经过字段白名单投影。 |
| PR #2214 已合并 | 修复了 WAL 数据库只读打开导致的工作区 sidecar 副作用；对 WAL 库使用暂存快照，并以 main → wal → main 复检建立可说明的时点一致性边界。它不承诺“返回瞬间绝对最新”；后者需要 writer 协调层和独立设计。 |
| PRR v1.3 的范围边界 | `docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.3.md` 明确把首版 MCP 与 Raw 列为范围外。本 SPEC 是独立的后续适配器提案，不修改 PRR v1.3，也不替代其 Gate B 或授权 Raw。 |
| 只读风险不能泛化为“所有查询已安全” | PR #2214 的修复范围是 pd pain recall；其他读模型、连接路径必须按各自契约单独验证，不能因为 Recall 已修复就默认全部安全。 |
| CLI 已有 Pain 显式登记路径 | Codex 的 pd pain explicit 依赖受信任的 live-turn context 和现有准入链；它是宿主绑定的写入路径，不自动变成 MCP 写工具。 |
| Hook 与 MCP 边界已有架构约束 | docs/adr/0020-codex-cli-host-adapter.md 和 docs/architecture/CODEX_CLI_ADAPTER_SPEC.md 将 Codex Hook 与 MCP 工具访问视为不同扩展面；MCP 不得取代 Hook。 |
| 首个宿主与首个业务场景仍需裁决 | 实施报告提出 Codex + 按需 Pain Recall 为候选，但没有证据表明 Owner 已批准该目标场景或 MCP Pilot。 |
| v0.3 Gate 决策仍未全部获批 | PR #2214 的实施报告记录 7 项实施就绪核查仍有 Owner 未决项，包括目标宿主/工作流、资格、披露字段、能力层 WAL 策略、协议兼容矩阵、价值实验判据和可进入的 Gate。 |

重要区分：PR #2214 证明 Recall 只读契约的一项缺陷已被修复；它没有实现 MCP Server、公共应用服务接口、MCP 工具注册、协议握手或宿主安装接线。

---

## 4. 目标与非目标

### 4.1 目标

- 定义宿主无关的业务能力目录、请求/响应 Schema、状态和来源语义。
- 为每项候选能力标注权威实现、数据源、副作用、权限和输出限制。
- 定义 CLI 与可选 MCP Adapter 如何调用同一业务服务。
- 为首个候选工具定义严格输入、字段白名单和失败语义。
- 定义 Gate 0–5、测试矩阵、回滚和成功指标。
- 以真实工作流判断 MCP 是否值得进入生产试点。

### 4.2 非目标

- 本版不实现或部署 MCP Server。
- 不默认创建 packages/pd-application，不移动业务代码，不引入 MCP SDK。
- 不通过 MCP 调用任意 Shell、SQL、文件路径、脚本、CLI 命令或通用执行器。
- 不暴露 Pain 写入、Owner statement 登记、证据提升、审批、激活、撤回、回滚或 RuleHost 决策。
- 不将工作区原则候选冒充为当前宿主实际注入的原则。
- 不默认披露原始 Pain 文本、Owner 原话、完整纠错证据、诊断根因或支持证据正文。
- 不开放远程 HTTP / 公网 MCP。
- 不改变现有 Hook、Host Runtime、RuleHost、Pain admission、激活和 Owner 审批的权威语义。
- 不将 MCP 工具数、SDK 引入或新增代码行数作为成功指标。

---

## 5. 目标架构与依赖规则

~~~text
Trusted Host / Human / Agent
          |
          +-------------------------+
          |                         |
      CLI Adapter             MCP Adapter (optional)
          |                         |
          +-------------+-----------+
                        |
            Host-neutral Application Use Cases
            - request/response contracts
            - authorization and disclosure projection
            - source/status/error semantics
            - bounded outputs and read-only guarantees
                        |
              approved public services
               /                   \
      principles-core           host-runtime
               \                   /
               existing stores / ledger / trajectory DB

Separate authoritative path:
Host Hooks -> Host Adapter -> Host Runtime / RuleHost -> enforcement
~~~

该图是目标边界，不代表当前已经存在 Application Use Cases 包或 MCP Adapter。

### 5.1 依赖规则

1. principles-core 不依赖 CLI、MCP SDK 或 Agent SDK。
2. 业务应用服务不依赖 pd-cli、MCP SDK 或具体宿主 SDK。
3. CLI 负责参数解析、终端呈现、帮助和退出码；MCP Adapter 负责协议、工具注册、输入 Schema 和 MCP 生命周期。
4. CLI 与 MCP 必须调用同一业务服务；不得复制 Recall 关联、授权、来源和错误映射。
5. MCP Adapter 不得启动 CLI 子进程完成业务。
6. 应用服务只能依赖经过审查的 Core / Host Runtime 公共服务；不得形成依赖环。
7. Hook / RuleHost 不依赖 MCP Server 是否运行。MCP 崩溃、卸载或关闭不能改变治理门禁。
8. 在 Gate 2 证明 MCP 有价值之前，不创建空壳应用包、不迁移现有实现、不引入 SDK。

### 5.2 包位置决策

packages/pd-application 仅是备选，不是默认方案。Gate 2 通过后，先画出真实 import/依赖图，再决定是否需要中立应用服务：

- 若现有包已有合适职责与稳定导出，优先复用；
- 若只需抽取一个窄用例，优先最小移动；
- 只有在第二个生产消费者和依赖边界都被证明时，才考虑独立包。

禁止为了“以后可能接 MCP”提前大规模重构。

---

## 6. 能力目录与候选 MCP 工具

应用能力目录与 MCP 工具白名单是两份不同的清单：内部可复用能力不自动获得外部披露资格。

| 候选能力/工具 | 当前实现映射 | 当前状态 | 开放前置条件 |
|---|---|---|---|
| pd_recall_principle_pains | recallPains() / pd.pain-recall.v1 | 首个候选；未批准 | 冻结目标工作流、字段披露和输出投影；Gate 2 证明 MCP 净增量；CLI 与 MCP 共用同一服务。 |
| pd_get_runtime_features | buildRuntimeFeaturesStatus() | 内部能力候选，不默认注册 MCP | 证明真实 Agent 工作流需要它；过滤本机路径、内部配置和不必要细节；不得声称是完整系统健康检查。 |
| pd_get_workspace_guidance_candidates | readPromptActivationCandidates() / buildActivePrinciplePromptContext() | 暂缓外部暴露 | 需要明确工作区候选与当前宿主资格的差别；没有权威回执时不能声称本轮已注入。 |
| pd_trace_pain | PainChainReadModel.traceByPainId() | 暂缓 | 先证明严格只读构造路径、来源语义和文件不变性；不得直接暴露当前可能初始化状态存储的默认路径。 |
| pd_get_capability_status | 尚无冻结的统一业务用例 | 从首批候选移除 | 仅在具体工作流需要时另行定义；不得含糊包装成全系统健康检查。 |

### 6.1 首个候选：pd_recall_principle_pains

这是候选而非已批准的 MCP 工具。其价值假设是：Agent 在当前任务中已知规范原则 ID，但需要按需找回与该原则存在真实来源关联的历史 Pain，以检查原则的形成背景和适用边界。

该工具必须复用既有 Recall 关联规则，不得用语义相似度猜测关联，也不得将未验证的候选/任务/工件 ID 当作 Pain ID。

#### 建议请求 Schema

~~~json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["principleId"],
  "properties": {
    "principleId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10,
      "default": 3
    }
  }
}
~~~

- principleId 为必填规范原则身份；必须经既有权威身份解析。
- limit 默认为 3，范围 1–10；实现时必须以最新主干服务契约复核。
- 不接受 workspaceDir、数据库路径、任意 hostKind、sessionId、turnId、SQL、排序字段或任意对象路径。
- 首版不暴露自由文本 context 参数，避免无必要地扩大输入和数据处理面。
- painId 精确过滤仅在目标工作流确实需要并通过 Gate 1 字段/用途评审后再加入；不是首版默认字段。

#### 建议响应投影

MCP Adapter 不得直接返回完整 PainRecallResult。内部响应包含自由文本并不代表 Agent 有权读取这些字段。

以下仅是用于合成 Gate 2 原型的**候选元数据投影**，不是已批准的生产 allowlist：

- 原则解析状态，不回显或额外暴露内部原则标识；
- 关联类型与置信度，不返回关联证据 ID；
- Pain / diagnosis / correctionEvidence 的可用性状态，不返回正文；
- 结果计数、截断状态、来源状态码和不含敏感信息的 warnings。

在 Owner 明确冻结逐字段 allowlist 前，生产 MCP 不得注册此工具。以下字段即使不属于原始正文，也不得默认输出：painId、occurredAt、source/host、evidenceRefs、canonicalId、原则标题/正文及脱敏摘要。若目标工作流无法在此元数据投影下完成，Gate 2 必须记录为能力不足并停止/请求字段裁决，不能由实现者自动扩大披露范围。

默认禁止披露的字段：

- pain.text、pain.reason、pain.rawStatement；
- diagnosis.rootCause、supportingEvidence.note、完整诊断正文；
- correctionEvidence.text、Owner 原话、完整纠错文本；
- 本机绝对路径、环境变量、凭据、内部 token、堆栈和无关内部目录结构。

如果业务价值必须依赖摘要文本，应先由 Owner 冻结摘要来源、允许字段、最大长度、使用目的和消费者范围。不得由实现者自行假定“只读”就允许原文披露。

---

## 7. 通用业务结果契约

以下为建议契约，须在 Gate 1 经 Owner 审阅后冻结。业务层 Schema 不依赖 MCP SDK 类型。

~~~json
{
  "schemaVersion": "pd.capability.v1",
  "capability": "pd_recall_principle_pains",
  "status": "ok",
  "data": {},
  "provenance": {
    "workspaceBinding": "configured",
    "sources": [
      {"name": "ledger", "status": "ok"}
    ]
  },
  "warnings": [],
  "error": null,
  "nextAction": null
}
~~~

字段语义：

- schemaVersion：业务契约版本，不等同于 MCP 协议版本。
- capability：实际执行的业务能力标识。
- status：稳定的外层业务状态。
- data：经授权与字段白名单过滤后的数据。
- provenance：最小必要来源信息，不暴露绝对路径。
- warnings：对象数组，每项含 code 与 message；禁止字符串数组与对象数组混用。
- error：null 或稳定的 {code, message}；不包含堆栈、路径或敏感正文。
- nextAction：null 或 {code, message}；不得建议绕过安全门禁。

### 7.1 状态语义

| 外层状态 | 语义 |
|---|---|
| ok | 查询成功且结果完整。 |
| no_matches | 查询成功，但没有符合条件的关联记录。 |
| partial | 可选来源不可用或结果不完整；必须列明缺失/不可读来源。 |
| not_found | 精确请求的对象不存在；不得与 no_matches 混淆。 |
| unconfirmed | 证据不足以确认所请求语义，例如没有权威注入回执。 |
| denied | 调用者没有读取该数据或执行该能力的授权。 |
| unavailable | 必需来源或服务不可用，无法完成查询。 |
| invalid_input | 输入违反 Schema 或业务约束。 |

内部领域状态必须映射且可测试：

- principle_not_found → not_found。
- ambiguous_principle → invalid_input，error.code=ambiguous_principle。
- pain_not_found → not_found，error.code=pain_not_found。
- source_missing / source_unreadable：按来源是否为必需来源分别映射 unavailable 或 partial，并保留原因码。
- 查询成功且结果为空 → no_matches。
- 因披露政策拒绝字段 → denied；不得伪装成空结果。
- 达到结果上限 → partial + result_limit_reached；不得静默截断。

协议错误与业务状态分开处理。工具名/协议参数错误由 MCP 层处理；业务查询的无结果、来源缺失或权限拒绝必须以稳定业务状态表达，不得一律包装成成功。

### 7.2 输出上限

拟议默认值（Gate 1 冻结前仍为建议）：

- 单次最多 10 条记录；
- 结构化业务响应最大 32 KiB；
- 经单独批准的自由文本字段最多 2,000 字符；
- 只读调用默认 10 秒截止时间。

超限必须给出明确的 partial 与原因码；不得悄悄丢弃证据、截断后仍声称完整，或通过无限分页扩大数据披露。MCP Adapter 优先使用目标宿主确实支持的结构化工具结果；若目标宿主不支持，才将同一业务信封序列化为单一 JSON 文本结果。不得在 text 与 structuredContent 中重复输出敏感负载。

---

## 8. 工作区绑定、授权与安全不变量

### 8.1 可信工作区绑定

- 若 Gate 4 获批，首版 MCP Server 只绑定一个由可信启动配置确定的工作区。
- 模型参数不得选择或覆盖 workspaceDir、ledger 路径、state.db 路径或 trajectory.db 路径。
- 启动时规范化根路径；所有数据源路径从该根目录派生。
- 符号链接或路径解析一旦可能越过授权根目录，必须拒绝。
- 工作区绑定失败时工具不可用；不得静默回退到当前目录、用户主目录或其他工作区。
- 若未来支持多工作区，必须由可信配置/授权层选择，不得由模型自由传入路径。

### 8.2 最小权限与披露政策

- 默认只读；仅注册经过批准的 MCP 工具白名单。
- 权限在服务端强制执行，不依赖工具描述中的自然语言提示。
- 数据能被内部服务读取，不等于可以向 Agent 披露。
- 原始 Pain 文本、Owner 原话、correctionEvidence、诊断根因、支持证据正文均默认禁止披露。
- 未决字段授权必须 fail-closed；拒绝敏感字段时返回 denied 或经过批准的脱敏投影，不得回退到原文。
- 模型不能通过参数伪造可信 hostKind、sessionId、turnId、Hook 事件或注入回执。
- 历史 Pain、诊断摘要和原则文本均是数据，不是权限指令；其中的提示注入内容不能改变工作区、工具白名单或执行策略。

### 8.3 严格只读不变量

每个获批为只读的能力都必须以真实文件和真实数据库夹具验证：

1. 缺失目录、ledger 或数据库保持缺失，不创建空替代物。
2. 不创建表、schema、迁移记录、锁文件、journal、WAL/SHM sidecar。
3. 现有源文件字节哈希与大小不变；数据库 schema 不变。
4. 不运行自动修复、后台任务、缓存写入、Pain 登记、激活或其他状态迁移。
5. 读取连接显式配置只读；State Manager 显式设置 readonly=true、bootstrapIfMissing=false。
6. WAL 场景必须纳入测试，不可只用默认 journal-mode 夹具。
7. 读取失败必须可观察地返回失败/部分状态，不能转为空结果。
8. 无法证明严格只读的能力不得进入 MCP 白名单。

PR #2214 已为 Pain Recall 的 WAL 场景建立暂存快照与线性化点证据。该机制提供可解释的时点一致性，不承诺无 writer 协调时的“返回瞬间绝对最新”。其他读取能力不能自动继承此证明，必须独立验收。

### 8.4 本地 transport 与安装边界

若 Gate 4 获批：

- 首版仅本地 stdio；不开放 HTTP、远程网络监听或公网服务。
- 由用户显式配置的受信任 MCP Client 启动；不自动扫描并改写所有宿主配置。
- 普通用户权限运行，不提升权限。
- MCP SDK 和 transport 依赖只进入独立 Adapter，不进入 principles-core、Hook 路径或核心存储包。
- SDK 精确版本、协议兼容矩阵与目标宿主版本必须在实现前复核并锁定 lockfile。2026-10-28 的技术核查记录了 TypeScript SDK v2 稳定线和 npm 版本信息，但不能替代实现时的版本复核。
- 启动失败、超时、崩溃或卸载不得触发宽权限 fallback，也不得改变 CLI、Hook 或 RuleHost 行为。

---

## 9. 候选实现映射与整改边界

| 项目 | 当前映射 | 进入实现前要求 |
|---|---|---|
| Pain Recall | packages/pd-cli/src/services/pain-recall.ts；pd.pain-recall.v1 | Gate 2 通过后才决定最小共享服务抽取；保持关联规则和 CLI 契约；MCP 使用独立字段白名单投影。 |
| Runtime Features | packages/pd-cli/src/commands/runtime-features.ts 中的 buildRuntimeFeaturesStatus() | 如未来选中，分离业务结果构建与 CLI 呈现；脱敏本机路径；不得宣称完整系统健康。 |
| Workspace Guidance | packages/host-runtime/src/active-principle-prompt.ts | 不把候选列表冒充实际注入回执；不重写宿主资格和预算规则。 |
| Pain Trace | packages/principles-core/src/runtime-v2/pain-chain-read-model.ts | 在注册为外部工具前解决 readonly / bootstrap 行为，并完成缺库、哈希、schema、WAL/SHM 不变性测试。 |
| Pain Explicit / Pain Ingress | 现有 CLI + Hook + live-turn context + admission 路径 | 保持宿主绑定；首版不把它改成 MCP 写工具，不接受模型自报的会话身份。 |
| Host Runtime dispatch | packages/host-runtime/src/index.ts | 不将通用 HostEvent dispatch 暴露为 MCP 工具。 |

Gate 2 之前，以上映射只用于契约设计与 Reality Audit；不移动代码、不新增包、不添加 SDK、不实现 Server。

---

## 10. 分阶段实施与决策 Gate

前一个 Gate 未通过，不进入后一个 Gate。Gate 的通过必须记录证据和 Owner 裁决；不能仅凭实现者自评升级状态。

### Gate 0 — Reality Audit 与 Owner 场景冻结

目标：以最新主干核实真实代码、宿主能力和目标任务。

必须完成：

- 核对 main、相关包、公共 exports、依赖方向、安装布局、Feature Flag 与 MCP Client 版本。
- 更新 Host Capability Matrix，分开记录源码存在、生产接线、安装状态、真实宿主验证和 Agent 可调用性。
- 把现有 Skill + CLI 纳入基线，至少评估目标相关的 pd pain recall 与 pd pain explicit 路径。
- 冻结一个目标工作流：使用者、触发时机、输入、期望结果、失败代价、现有替代方案。
- 记录目标宿主与版本；Owner 已批准 Codex CLI 作为验证候选，但目标宿主版本、MCP Client 版本和实际安装兼容性仍未核实，不得声称生产兼容。
- 明确历史 Pain/Owner 原话的分类和字段披露状态。
- 对照 Pain Recall CLI SPEC、PRR v1.3、ADR-0020 和 Codex Adapter SPEC。
- 明确诉求是业务工具访问还是 Hook/lifecycle 接入；不得混为一谈。

#### Reality Audit 快照（基线 3a2de95c）

| 面向 | 当前可支持的结论 | 对 Gate 的影响 |
|---|---|---|
| CLI Pain Recall | `packages/pd-cli/src/services/pain-recall.ts` 提供 `recallPains()` 与 `pd.pain-recall.v1`；`pain-recall-readonly.test.ts` 覆盖缺失源、回滚日志/WAL、sidecar、竞态和失败注入。PR #2214 已合并。 | 可作为业务语义与只读证据基线；不等于 MCP 字段披露已获准。 |
| PRR v1.3 | 明确将首版 MCP、Raw 列为范围外；其 Gate B 仍有独立授权要求。 | MCP 适配器必须保持独立；不得宣称 PRR 已批准 MCP 或真实历史读取。 |
| Codex Host Lifecycle | 仓库已有 Codex Adapter SPEC / ADR 与相关现实审计；它们描述 Hook/lifecycle 接入，不等于 MCP 工具客户端兼容性。 | 不将 Hook 覆盖当作 MCP 的增量价值，也不让 MCP 替代 Hook/RuleHost。 |
| MCP Server / Client | 本轮定向检索和已审查报告未找到已交付的 PD MCP Server；没有验证具体 Client/SDK 版本或真实宿主安装。 | 标记为 NOT_VERIFIED / NOT_IMPLEMENTED；实施前必须做完整源码与真实宿主核查。 |
| 共享应用服务包 | 当前 Recall 服务位于 `packages/pd-cli`；尚未证明必须创建独立 `packages/pd-application`。 | Gate 2 前不抽包、不迁移、不引入 SDK。 |

通过条件：关键结论有当前源码/测试证据；事实、推断、建议分开；目标场景明确；Owner 批准进入 Gate 1。完整宿主/Client 兼容性核查仍须在任何 Pilot 前完成。

当前状态：**PARTIAL — 默认工作流与架构约束已获 Owner 批准；Gate 0 未通过**。原因：完整 Host Capability Matrix、真实 Client 版本/安装兼容性以及对外字段白名单仍未核实/冻结。

### Gate 1 — Application Capability Contract（纯设计阶段）

目标：冻结业务能力语义，不改代码。

必须完成：

- 冻结候选能力目录、请求/响应 Schema、状态、来源、权限和披露规则。
- 为每项能力标注权威实现、必需/可选来源、副作用等级、结果上限。
- 区分内部应用能力目录和 MCP 工具白名单。
- 为 Recall 定义现有 pd.pain-recall.v1 到对外投影的映射；不改关联规则。
- 明确 Hook / RuleHost 的权威边界。
- 不创建 packages/pd-application，不引入 SDK，不移动源码。

通过条件：契约独立于 CLI 参数和 MCP SDK；空结果、部分可用、未确认、拒绝和失败无歧义；Owner 审阅候选工具及字段白名单。

当前状态：**PARTIAL — 默认架构约束已获 Owner 批准；Gate 1 未通过**。候选业务信封、状态映射和只读边界已成文；精确字段 allowlist（尤其 painId、occurredAt、source/host）、输出上限与 Gate 2 预注册阈值仍未冻结。

### Gate 2 — MCP 必要性与增量价值证明

目标：判断 MCP 对一个具体 Agent 工作流是否带来可重复的净增量。此 Gate 是集成效用测试，不是 PRR v1.3 Gate B 的行为收益实验。

#### 2.1 对照协议（拟议执行方案；尚未获执行授权）

- **Arm A — 现有路径：** 目标宿主按现有 Skill / 文档使用 `pd pain recall --principle-id <id> --json`。若没有可确认的 Skill，必须如实记录为 CLI + 当前指导文本，不得假称 Skill 已安装。
- **Arm B — 一次性 MCP 原型：** 仅注册 `pd_recall_principle_pains` 候选工具；使用本 SPEC 的合成元数据投影，不返回真实 Pain 内容、Owner 原话或未经批准的 ID/时间/来源字段。
- 两臂使用同一 Owner 批准的非 OpenAI 模型、相同模型版本/推理设置/任务提示、同一目标宿主版本、同一合成工作区和等价任务指令；随机化运行顺序并保留逐次结果。
- 使用 **12 个固定合成场景，每臂每场景重复 3 次**（每臂 36 次、合计 72 次）。建议场景分布：4 个有效关联；2 个真实无匹配；2 个必需来源缺失/不可读；2 个可选来源部分可用；1 个原则身份歧义；1 个非法输入/不允许字段请求。
- 场景、正确答案、状态映射和评分规则必须先冻结，再执行；不得根据中途结果改题或改门槛。
- 只使用合成 fixture。不得读取真实 Owner 历史、生产 Pain 文本、真实 correctionEvidence，不调用外部模型服务以外的任何服务（模型是否外部调用仍须单独遵循已批准预算/政策）；本 Gate 本身不授予真实数据访问权。

#### 2.2 不引入生产依赖的原型规则

- Gate 2 前不得在仓库 package.json / lockfile 中添加 MCP SDK，不创建应用包，不移动生产业务代码。
- 若要验证真实 stdio 工具发现/调用，可在隔离临时目录创建可丢弃原型，依赖只安装在临时目录，运行后销毁；不得提交该依赖、配置或原型代码。
- 若证明 MCP 价值必须先把 SDK 或新包写入生产仓库，则停止并返回 Owner 决策，不得以“实验需要”为由绕过 Gate。
- MCP 原型不得通过启动 CLI 子进程、解析 stdout 或复制 Recall 关联逻辑来模拟共享应用服务。Gate 2 允许用最小实验 harness 比较调用体验，但必须把“协议可用性”和“共享业务服务尚未抽取”分别记录，不得宣称 Gate 3 已完成。

#### 2.3 指标与停止规则

每次运行记录：任务是否完成、结果/状态是否正确、工具调用数、Agent 交互轮次、返回字节数、p50/p95 延迟、安装配置耗时、错误与恢复路径。对安全属性逐次断言：无未批准字段、无文件/数据库/sidecar 变化、无路径越界、无 CLI 子进程调用、无 false-success 状态映射。

以下数值仅为**待 Owner 冻结的阈值提案**，不是已批准门槛：

- 安全硬门：敏感字段泄露、任何工作区副作用、权限绕过或 false-success 发生次数必须为 **0**；出现一次即 STOP。
- 效用门：MCP 必须满足以下至少一项：任务成功率绝对提升不少于 **10 个百分点**；或在成功率不低于 CLI 基线 **5 个百分点以上**的前提下，中位 Agent 交互轮次/工具调用减少至少 **25%**。
- 操作门：在文档化前置条件已满足的环境中，新增 MCP 配置步骤目标不超过 **5 分钟**；p95 延迟不超过 CLI 基线的 **2 倍**。超出时必须证明有足够大的效用收益并由 Owner 另行接受。
- 若 CLI 基线任务成功率已达到 **95%**，而 MCP 未达到上述效率/配置收益，则建议 STOP，不为协议统一而继续投资。
- 若元数据投影不足以完成已冻结的真实目标任务，不得私自加入 painId、时间、来源或原文；应记录能力缺口，回到 Owner 字段裁决。未获字段授权前不做真实历史数据试验。

#### 2.4 Gate 2 的准入与结论

准入前必须由 Owner 冻结：① 12 个合成场景与评分答案；② 本次原型可输出的合成字段投影；③ 上述数值阈值或替代阈值；④ 目标 Codex / MCP Client 的精确版本；⑤ 原型隔离与清理方式。上述任何一项未冻结，Gate 2 保持 NOT_RUN。

退出结论只能是：
- **GO_TO_GATE_3_PROPOSAL**：安全硬门全过且效用门通过，提交证据供 Owner 决定是否进入共享服务抽取；
- **STOP**：CLI 已足够、MCP 无净增量、元数据投影无法满足任务，或任何安全硬门失败；
- **UNPROVEN**：结果不稳定、环境不等价或证据不足；不得按 GO 处理。

Gate 2 的成功不自动授权生产 MCP、真实历史数据读取或 PRR Gate B。Gate 3、Gate 4 仍需独立批准。

当前状态：**NOT_RUN — 方案已草拟；数值阈值、字段投影与 Client 版本未冻结，且无执行授权**。

### Gate 3 — 最小共享应用用例抽取

仅在 Gate 2 通过后进入。

- 依据依赖图决定是否需要抽取服务/新包。
- 首先为获批的候选用例建立唯一业务实现，让 CLI 和未来 MCP 调用同一服务。
- 服务不依赖 pd-cli、MCP SDK 或具体宿主 SDK。
- 保留 CLI 参数、JSON 语义、终端输出与退出码。
- 不复制关联、权限、来源或错误映射。
- 为所有只读路径提供真实文件不变性证据。

通过条件：CLI 回归通过、无循环依赖、无重复业务实现、服务结果一致、只读和披露测试通过，Owner 审阅 diff。

当前状态：BLOCKED_BY_GATE_2。

### Gate 4 — 单宿主只读 MCP Pilot

仅在 Gate 3 通过且 Owner 明确授权后进入。

- 本地 stdio、单一目标宿主、单一可信工作区。
- 仅注册获批白名单工具；首批候选最多为经批准的 Recall 投影。
- 不包含写入、审批、激活、撤回、回滚、RuleHost 或通用执行能力。
- MCP SDK 仅进入独立 Adapter。
- 验证工具发现、Schema、结构化结果、错误、路径边界、字段过滤、输出上限、超时、崩溃和卸载。
- 真实宿主测试必须使用合成或已授权数据。
- Hook/RuleHost 回归证明治理行为未变。

当前状态：BLOCKED_BY_GATE_3_AND_OWNER_APPROVAL。

### Gate 5 — 扩展其他宿主

单宿主 Pilot 通过后，每个宿主单独验证安装、配置、工具发现、参数、错误、卸载和治理回归。不得从一个宿主的成功推断所有宿主支持。

当前状态：BLOCKED_BY_GATE_4。

---

## 11. 测试与验收矩阵

### 11.1 应用服务契约

- 合法、缺失、空白、过长和未知字段输入。
- principleId 不存在、身份歧义、有效原则、无关联结果。
- 真实来源关联边、未解析关联、候选/任务 ID 不得冒充 Pain ID。
- 数据源缺失、不可读、可选来源缺失和部分可用的状态映射。
- CLI 与共享服务的业务结果一致；不通过 CLI stdout 进行内部调用。

### 11.2 严格只读

- 回滚日志模式、安静 WAL、非空 WAL、缺失 SHM、崩溃残留和混合来源矩阵。
- 缺失目录/文件不被创建。
- 工作区文件和数据库字节哈希、大小、schema 不变。
- 不创建 WAL/SHM/journal sidecar。
- 竞态、不可读和快照不一致时 fail-closed 或按已冻结的可选来源规则返回 partial。
- 任何失败都不能被误报为 no_matches。
- 每个新只读能力独立通过矩阵；Recall 的证据不能替代 Trace 或 Guidance 的证据。

### 11.3 披露与安全

- 对 pain.text、reason、rawStatement、rootCause、supportingEvidence.note、correctionEvidence.text 和 Owner 原话植入唯一敏感标记；断言响应、错误、日志均不包含标记。
- 恶意历史文本不能改变工作区绑定、权限、工具白名单或执行路径。
- 路径穿越、符号链接越界、未知参数、任意路径、SQL 和 host/session 自报全部拒绝。
- 未授权字段返回 denied 或冻结的脱敏结果，不得回退到原文。
- 响应不包含绝对路径、凭据、环境变量、堆栈或无关内部目录。

### 11.4 MCP Adapter（仅 Gate 4 后）

- 官方 Client 与真实 stdio 子进程的 wire-level 工具发现和调用。
- Schema 验证、未知工具、非法参数、结构化输出、错误状态和输出上限。
- 超时、Server 崩溃、重启、卸载与恢复。
- SDK 精确版本和目标宿主版本固定；安装/禁用/卸载有自动化或可复现手动证据。
- MCP 不启动 CLI 子进程，不复制业务逻辑。
- MCP 不可用时 CLI 仍工作，Hook/RuleHost 行为不变。

### 11.5 验收规则

任何关键只读、权限或披露测试失败，都阻断 MCP 白名单注册。不能通过减少断言、将失败映射为空结果或只测试 helper 来使测试变绿。

---

## 12. 失败处理、可观测性与回滚

### 12.1 失败语义

- invalid_input：说明稳定原因码和合法范围。
- denied：不返回敏感数据，指出需要经批准的授权流程。
- not_found：明确精确对象不存在。
- no_matches：只有在来源可用且查询成功时才表示真正无匹配。
- partial：列出缺失/不可读的可选来源及影响。
- unavailable：必需来源不可用，查询不能成立。
- unconfirmed：证据不足以确认；不得猜测。
- transport/protocol error：与业务状态分开，不能触发权限降级。

### 12.2 回滚

- 应用服务抽取与 MCP Adapter 独立回滚。
- MCP 停止、关闭或卸载不影响 CLI、Hook 或 RuleHost。
- 不要求用户修改或重建数据库。
- 禁止 MCP 故障时自动切换到宽权限工具。
- 若 CLI 迁移引入回归，按受控回滚恢复既有路径；不保留重复业务实现作为长期状态。

### 12.3 成功指标

不以工具数量或新增代码量衡量成功。对同一任务比较：

- 任务完成率、错误率和误调用率；
- Agent 调用轮次、结果字节数及上下文消耗（如可可靠测量）；
- 对 no_matches / partial / denied / unavailable 的正确区分率；
- 敏感字段泄露测试结果；
- 安装、配置、恢复、卸载步骤与维护成本；
- CLI 兼容、只读不变性、Hook/RuleHost 回归；
- 各宿主的独立验证状态。

指标采集不得记录未经授权的原始 Pain 文本或 Owner 原话。

---

## 13. 风险登记

| 风险 | 等级 | 缓解措施 | 停止条件 |
|---|---|---|---|
| MCP 被当作 Hook / RuleHost 替代品 | 极高 | 架构分离与治理回归 | 任一既有门禁依赖 MCP 可用性 |
| 任意工作区/路径读取 | 极高 | 启动时可信绑定，参数不允许覆盖 | 存在路径越界或模型可选工作区 |
| 未授权历史文本披露 | 极高 | 字段级白名单、默认不披露原文 | 未授权字段出现在响应、错误或日志 |
| 只读入口修改数据库/sidecar | 高 | WAL 真实夹具与文件不变性测试 | 任一源文件被创建或改变 |
| MCP 与 CLI 语义漂移 | 高 | 单一业务服务、契约测试 | 出现重复关联/授权逻辑 |
| 应用层抽取造成依赖环 | 高 | Gate 2 后依赖图审计 | 无法说明/消除循环依赖 |
| 工具颗粒度过粗 | 高 | 按权限与副作用拆分 | 工具可执行任意操作 |
| MCP 没有真实净增量 | 高 | Gate 2 对照实验 | Skill + CLI 已充分满足目标 |
| 仅一个宿主通过却声称全宿主支持 | 中 | 每宿主单独 Gate | 无真实安装和调用证据 |

---

## 14. Owner 决策卡

以下记录区分 Owner 已批准的设计默认值与仍待裁决事项。本次 Owner 批准仅限继续收口 Gate 0/1，不代表 Gate 已通过或授权实现。

| ID | 决策问题 | 建议 | 当前状态 |
|---|---|---|---|
| D-01 | 是否继续收口 Gate 0/1 设计？ | 继续文档与只读源码核查，不等于批准代码实施 | **OWNER_APPROVED_DESIGN_ONLY (2026-10-28)** |
| D-02 | 首个目标宿主与工作流 | Codex CLI 候选 + 按需查询原则关联 Pain；不是最终生产宿主批准 | **OWNER_APPROVED_AS_CANDIDATE** |
| D-03 | 精确 Recall 对外字段 allowlist（含 painId、occurredAt、source/host、evidenceRefs、原则文本/摘要） | 未逐字段批准前，生产 MCP 不注册工具；Gate 2 只用合成元数据投影 | **OWNER_DECISION_REQUIRED** |
| D-04 | 是否披露历史 Pain 原文、correctionEvidence、诊断根因、支持证据或 Owner 原话 | 默认禁止；如需开放，另行明确字段、目的、宿主与审计要求 | **APPROVED_DEFAULT_DENY** |
| D-05 | 若未来进入 Pilot，传输/工作区/权限约束 | 本地 stdio、单一可信工作区、只读白名单；不开放远程/公网与写入工具 | **OWNER_APPROVED_DESIGN_CONSTRAINT** |
| D-06 | 是否创建 packages/pd-application 或在仓库引入 MCP SDK | Gate 2 证明净增量前不建包、不加 SDK、不迁移生产代码 | **OWNER_APPROVED_DEFER_UNTIL_GATE_2** |
| D-07 | MCP SDK / Codex Client 精确版本及真实安装兼容性 | Gate 2 前核验目标候选 Client；SDK 版本在获准实施前复核并锁定 | **NOT_VERIFIED** |
| D-08 | Gate 2 的任务集、数值阈值与允许成本 | 12 个合成场景×每臂 3 次；安全门 0 泄露/副作用；效用门与操作门见 §10.2–10.4，数值仍待 Owner 冻结 | **PROPOSAL_NOT_APPROVED** |
| D-09 | 是否批准真实数据实验、PRR Gate B 或生产 MCP Pilot | 各自按 PRR 与本 SPEC 对应 Gate 独立授权；本次批准不包含这些事项 | **NOT_AUTHORIZED** |

---

## 15. 本版状态与完成条件

当前状态：

- Gate 0：**PARTIAL**；Owner 已批准候选工作流和设计约束，Recall/WAL 证据已核实；完整 Host Capability Matrix、Client 版本/安装兼容性仍待核实。
- Gate 1：**PARTIAL**；架构边界、候选工具、只读/失败语义已成文；精确对外字段 allowlist 与 Gate 2 预注册阈值未冻结。
- Gate 2：**NOT_RUN**；对照方案已草拟，阈值/字段投影/Client 版本未冻结，无执行授权。
- Gate 3：**BLOCKED_BY_GATE_2**；不抽取服务、不新建包。
- Gate 4：**BLOCKED_BY_GATE_3_AND_SEPARATE_OWNER_APPROVAL**；没有 MCP Server、SDK 或宿主安装改动。
- Gate 5：**BLOCKED_BY_GATE_4**。

Gate 0/1 的收口检查：

- [x] Owner 已批准候选宿主/工作流方向，以及本地 stdio、单工作区、只读白名单和默认不披露敏感原文（2026-10-28）。
- [x] 已核实 PR #2214 合并后的 Recall/WAL 只读修复与相关测试。
- [x] 已记录 PRR v1.3 将首版 MCP/Raw 列为范围外；本 SPEC 不修改 PRR Gate B。
- [x] 已明确 CLI / MCP / Host Lifecycle / RuleHost 的边界。
- [x] 已将 Gate 2 对照协议与停止规则写入 SPEC 草案。
- [ ] 完整 Host Capability Matrix、真实 Codex/MCP Client 版本与安装兼容性验证。
- [ ] 对外字段 allowlist 逐项冻结，尤其 painId、occurredAt、source/host 和脱敏摘要。
- [ ] Gate 2 数值阈值与允许成本由 Owner 预注册。
- [ ] Owner 单独授权启动 Gate 2；不包含真实数据访问或 PRR Gate B。

即使 Gate 0/1 通过，仍不自动批准 Gate 2 的真实实验、Gate 3 的代码抽取或 Gate 4 的生产 MCP。每一阶段均需其自身证据与授权。

---

## 16. 参考证据索引

所有主干链接固定到本版基线 3a2de95c84047e720317cc66c9568d5da37843c5。

1. 主干基线：[commit 3a2de95](https://github.com/csuzngjh/principles/commit/3a2de95c84047e720317cc66c9568d5da37843c5)
2. Recall WAL 只读修复：[PR #2214](https://github.com/csuzngjh/principles/pull/2214)
3. Recall 实施报告：[PD-AGENT-CAPABILITY-API-001 backend round 1](https://github.com/csuzngjh/principles/blob/3a2de95c84047e720317cc66c9568d5da37843c5/docs/implementation-reports/PD-AGENT-CAPABILITY-API-001-backend-round1-20261028.md)
4. Recall 服务：[pain-recall.ts](https://github.com/csuzngjh/principles/blob/3a2de95c84047e720317cc66c9568d5da37843c5/packages/pd-cli/src/services/pain-recall.ts)
5. Recall 只读测试：[pain-recall-readonly.test.ts](https://github.com/csuzngjh/principles/blob/3a2de95c84047e720317cc66c9568d5da37843c5/packages/pd-cli/tests/commands/pain-recall-readonly.test.ts)
6. Pain Recall CLI SPEC：[SPEC-PD-PAIN-RECALL-CLI-001](https://github.com/csuzngjh/principles/blob/3a2de95c84047e720317cc66c9568d5da37843c5/docs/specs/SPEC-PD-PAIN-RECALL-CLI-001.md)
7. Codex Adapter SPEC：[CODEX_CLI_ADAPTER_SPEC.md](https://github.com/csuzngjh/principles/blob/3a2de95c84047e720317cc66c9568d5da37843c5/docs/architecture/CODEX_CLI_ADAPTER_SPEC.md)
8. ADR-0020：[Codex CLI Host Adapter](https://github.com/csuzngjh/principles/blob/3a2de95c84047e720317cc66c9568d5da37843c5/docs/adr/0020-codex-cli-host-adapter.md)
9. 包职责导航：[CONTEXT-MAP.md](https://github.com/csuzngjh/principles/blob/3a2de95c84047e720317cc66c9568d5da37843c5/CONTEXT-MAP.md)
10. PRR v1.3 的范围边界与独立 Gate：[SPEC-PD-PRR-001-principle-pain-recall-v1.3.md](https://github.com/csuzngjh/principles/blob/3a2de95c84047e720317cc66c9568d5da37843c5/docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.3.md)
11. Codex 现实审计：[PRI-813-CODEX-REALITY-AUDIT.md](https://github.com/csuzngjh/principles/blob/3a2de95c84047e720317cc66c9568d5da37843c5/docs/audit/PRI-813-CODEX-REALITY-AUDIT.md)
12. v0.3 外部工作区快照的哈希与未决决策记录：见上述 PR #2214 的实施报告；完整 v0.3 原文件在本版编写前未找到主干副本。

---

## 17. 结论

PD 的 MCP 方向应是：**一套权威业务逻辑、多个独立入口、严格的数据与权限边界；MCP 是可选的业务能力访问适配器，不是新的治理核心。**

Owner 已批准继续采用候选宿主/工作流与本地只读设计约束；Gate 0/1 仍为 PARTIAL，而不是虚报通过。下一步先完成对外字段 allowlist、真实 Client 兼容性核查与 Gate 2 阈值预注册，再由 Owner 单独授权合成数据对照实验。PRR v1.3、Hook、RuleHost 和既有 CLI 契约均保持不变；在 Gate 2 证明净增量之前，不加生产 SDK、不抽包、不写 MCP Server。
