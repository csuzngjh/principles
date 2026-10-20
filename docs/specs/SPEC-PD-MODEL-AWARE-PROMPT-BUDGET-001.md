# SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001
## 模型上下文感知的原则注入预算

**版本：** v0.1
**日期：** 2026-10-20
**状态：** Proposed — 待 Owner 审阅
**目标：** Runtime V2 原则注入预算动态化
**调查基线：** PD `origin/main` 快照 `a57cc3e07ab860e4c646d8f5fc5366d49fc88e97`（原调查基于 `ec66d2338`，实施前已更新基线），`@principles/core` 1.294.x；Pi AI 依赖版本 1.2.0（`packages/principles-core` runtime dependency）。

---

## 1. 问题定义

### 1.1 当前实现

PD Runtime V2 使用固定常量：

`RUNTIME_V2_PRINCIPLE_BUDGET = 2000`

单位为 JavaScript `String.length`，即 UTF-16 code units，而不是模型 Token。

预算应用于两条实际注入路径：

- **OpenClaw plugin-local 路径：** 按选择列表的序列化行计费。
- **共享 host-runtime 路径：** 按完整 directive 渲染结果计费，包含包装和可能存在的自报指令。

现有 `PD_PROMPT_CAPACITY_V1` 已实现容量预检、路由识别、注入状态和容量测量。本 SPEC 只演进其预算计算机制，不重建容量治理系统。

主要缺陷是：模型的有效上下文窗口可能不同，但当前 Runtime V2 使用相同的 2000 字符预算，无法根据已知模型容量调整注入规模。

### 1.2 目标

建立一个共享的、可测试的模型容量解析与预算计算机制：

1. 优先使用宿主在当前 Hook 中可靠提供的有效上下文窗口。
2. 在宿主没有提供容量时，复用已安装 Pi AI 模型目录中的可信元数据。
3. 对未知模型、来源不明或存在歧义的元数据，保留现有 2000 字符预算。
4. 让实际注入、容量预检、Console 投影和 CLI 反馈使用一致的预算政策。
5. 保留现有 Owner 审批、原则激活、去重、轮转和可观测性机制。

**重要边界：** 本 SPEC 计算的是基于模型总上下文容量的原则注入预算，不是当前请求精确的剩余上下文 Token。

---

## 2. 非目标与不可破坏约束

### 2.1 非目标

- 不开发新的 Tokenizer，也不增加模型专用 Tokenizer 依赖。
- 不声称精确计算任意模型的 Token 消耗。
- 不读取或重建整个宿主对话来推测精确剩余上下文。
- 不改变原则的 Owner 审批与激活授权机制。
- 不改变原则排序、去重、轮转和适用性选择算法。
- 不修改 RuleHost 的确定性治理逻辑。
- 不修改 legacy evolution-principles 的 4000/1000 字符预算和 core principles 的既有注入策略。
- 不新增数据库、持久化模型容量缓存、独立模型目录服务或每轮网络请求。
- 不在本次任务中引入 Working Set Selector 或自动原则创建。

### 2.2 不可破坏约束

1. 模型容量未知时，不能假装已经获得精确容量。
2. `maxTokens` 是最大输出 Token 数，不能误用为 `contextWindow`。
3. 自定义代理端点不得无条件继承其他提供商的模型容量。
4. 容量元数据解析失败不得阻断正常宿主对话。
5. Console 中的未知状态不得被解释为零注入或注入成功。
6. 不得因为预算计算变化而绕过 Owner 审批、自动激活或修改原则状态。
7. 保留 `PD_PROMPT_CAPACITY_V1` 现有路由及序列化计费口径。

---

## 3. 现有能力与源码证据

### 3.1 PD 已有实现

- `packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts`
  - 固定预算常量、`trimToBudget`、选择策略与列表行序列化。
- `packages/openclaw-plugin/src/hooks/prompt.ts`
  - OpenClaw plugin-local 注入路径。
- `packages/host-runtime/src/active-principle-prompt.ts`
  - 共享注入路径。
- `packages/host-runtime/src/prompt-injection-projection.ts`
  - 注入路由、容量投影和计费口径。
- `packages/host-runtime/src/prompt-activation-deliverability.ts`
  - 激活写入前的容量预检。
- `packages/host-runtime/src/prompt-injection-status.ts`
  - 激活级容量状态。
- `packages/pd-console/src/shared/prompt-injection-contract.ts`
  - Console 容量状态合同。
- `packages/principles-core/src/runtime-v2/adapter/pi-ai-catalog.ts`
  - 既有 Pi AI 目录单点封装（本 SPEC 扩展复用，不新建并行封装）。

实施前必须重新搜索所有 `RUNTIME_V2_PRINCIPLE_BUDGET` 的直接使用位置，确保没有遗漏消费者。

### 3.2 宿主信息差异

**OpenClaw**

上游 Hook 上下文已经提供以下字段：

- `modelProviderId`
- `modelId`
- `contextTokenBudget`
- `contextWindowSource`
- `contextWindowReferenceTokens`

其中 `contextTokenBudget` 是宿主解析出的有效上下文 Token 容量，受模型、配置或 Agent 限制影响。它不是当前已使用的 Token 数。

PD 的 `packages/openclaw-plugin/src/openclaw-sdk.ts` 已声明相关字段（:345-347），但尚未接入预算计算。其 `contextWindowSource` 类型还需要与实际支持的上游版本核对并同步。

**Codex**

`packages/codex-adapter/src/codec/input-decoder.ts` 已验证并读取原始 Hook 中的 `model` 字段，但目前没有将模型身份保留到统一的 `HostEventContext`。

该 Hook 载荷并未提供与 OpenClaw 等价的有效上下文 Token 容量。因此，模型 ID 只能作为元数据查找依据，不能直接当作容量。

**WorkBuddy**

当前已核实的 `packages/workbuddy-adapter/src/codec/input-decoder.ts` 与冻结 Hook 契约未提供等价的模型上下文容量字段。

必须允许该宿主继续使用固定预算，直至发现并验证权威的模型容量来源。不得猜测模型、读取未经确认的配置或伪造容量。

### 3.3 Pi AI 能力

PD 依赖 `@earendil-works/pi-ai@1.2.0`（principles-core runtime dependency），模型目录包含：

- `contextWindow`：上下文窗口容量。
- `maxTokens`：最大输出 Token 数。
- `provider`、`id`：模型身份。

已验证（1.2.0 实测）：`getModel(provider, id)` 对未知条目返回 `undefined` 而非抛错；`getModels(provider)` 需要 provider 参数；无 provider 的同名 modelId 跨提供商普遍存在且 `contextWindow` 不一致（如 `gpt-5` 在 azure/openai/opencode 为 400000、在 cloudflare-ai-gateway 为 128000；`claude-sonnet-4-5` 在 radius 下为 1000000 与其他 200000 不一致）——因此无 provider 查找在现实目录中大多必须诚实降级。

复用时必须遵循已安装版本的实际 API，不得假定 Coding Agent 的 `ctx.getContextUsage()` 能跨宿主调用。

Pi 的通用 Token 估算器采用粗略字符比例，不是精确的模型专用 Tokenizer。本 SPEC 不将它用于伪造精确的剩余上下文。

---

## 4. 预算政策

### 4.1 单位与初始参数

第一阶段继续使用 UTF-16 字符预算，以避免同时迁移序列化计费体系和容量预检合同。

| 参数 | 初始值 | 含义 |
|---|---:|---|
| `BASE_BUDGET_CHARS` | 2000 | 基准预算 |
| `REFERENCE_CONTEXT_WINDOW_TOKENS` | 128000 | 基准上下文容量 |
| `MIN_BUDGET_CHARS` | 500 | 动态预算下限 |
| `MAX_BUDGET_CHARS` | 4000 | 动态预算硬上限 |
| `FALLBACK_BUDGET_CHARS` | 2000 | 容量未知时沿用的旧预算 |

128000 是本 SPEC 选择的初始政策锚点，不代表所有用户的模型都具有该容量，也不代表该预算已被证明是行为效果最优值。实际效果必须通过受控测量验证。

### 4.2 动态预算公式

当获得可信、有效的上下文窗口 \(W\) 时：

\[
B(W)=\min\left(
4000,\;
\max\left(500,\;
\left\lfloor 2000\frac{W}{128000}\right\rfloor
\right)
\right)
\]

其中：

- \(W\)：有效上下文窗口，单位 Token。
- \(B(W)\)：原则注入预算，单位 UTF-16 字符。

参考结果：

| 有效上下文窗口 | 原则注入预算 |
|---:|---:|
| 32K | 500 字符 |
| 64K | 1000 字符 |
| 128K | 2000 字符 |
| 256K | 4000 字符 |
| 1M | 4000 字符 |
| 未知或无效 | 2000 字符 |

以上为初始政策，不是精确 Token 换算。4000 字符是硬上限，避免大窗口模型导致原则注入规模无限增长。

### 4.3 容量解析优先级

建立纯函数形式的容量解析器（实现名 `resolvePromptBudget`）。函数名称可以按仓库现有命名规范调整，但必须保持单一实现。

优先级如下：

1. **宿主提供的有效上下文容量。** OpenClaw 在来源可信且数值有效时优先使用 `contextTokenBudget`。
2. **Pi AI 的精确模型元数据。** 使用已安装模型目录中的准确 `provider + modelId` 匹配。
3. **无提供商身份的模型 ID 查找。** 只有当已安装目录中所有完全匹配的候选模型都具有相同、有效的 `contextWindow`，且不存在自定义端点歧义时，才允许使用。否则返回未知。
4. **固定预算降级。** 没有可信容量、模型映射冲突、元数据无效或查找失败时，使用 2000 字符。

具体规则：

- 不使用在线请求刷新 Pi 模型目录。
- 不把模型 ID 相同当成不同提供商限制相同的充分证据。
- `maxTokens` 不参与上下文窗口计算。
- `contextWindowReferenceTokens` 仅用于诊断和解释容量来源，不得替代宿主提供的有效 `contextTokenBudget`。
- 对 `contextWindowSource = default` 等非模型特定来源，应先核实其可信度；不能证明实际模型容量时，继续查找可信模型元数据，否则降级。
- 无效的零值、负数、非有限数、非整数和异常大值必须拒绝，不得静默转换成看似可信的容量。

### 4.4 预算结果合同

解析结果至少包括：

- `budgetChars`
- `capacitySource`
- `capacityStatus`
- `contextWindowTokens`（未知时为 `null`）
- `policyVersion`
- `fallbackReason`（需要降级时）

来源分类：

- `host_effective_window`
- `pi_catalog_exact`
- `pi_catalog_unambiguous`
- `legacy_fallback`

`capacityStatus` 必须区分已确认（`confirmed`）和未知（`unknown`）。不得通过伪造默认模型或容量来提高确认率。

---

## 5. 跨宿主接入

### 5.1 OpenClaw

在 `before_prompt_build` Hook 中，将实际可用的模型容量事实传入预算解析器。

要求：

1. 使用当前 Hook 调用的有效上下文窗口，而不是 PD 内部 Artificer 或 Diagnostician 使用的模型容量。
2. 将模型身份、容量数值及来源传给 plugin-local 和共享 host-runtime 路径。
3. 更新 `openclaw-sdk.ts` 的类型，使其与实际支持的上游 Hook 合同兼容。
4. 对缺失、无效或低可信来源保守降级。
5. 不新增同步网络调用，不增加每轮 LLM 调用。

### 5.2 Codex

1. 在 `decodeCodexInput` 已验证 `raw.model` 的基础上，将模型 ID 作为可选的、经过验证的模型上下文信息保留到统一接入路径。
2. 不把模型 ID 直接解释为 Token 容量。
3. 优先通过可信的宿主模型身份映射查询 Pi AI 已安装目录。
4. 如果目录中不存在精确匹配或存在歧义，使用 2000 字符预算。
5. 不因模型元数据缺失而阻断 Hook 或修改工具的 allow/deny 决策。

### 5.3 WorkBuddy

1. 保持现有 Hook 合同不变，不擅自新增必填字段。
2. 调查当前受支持 WorkBuddy 版本是否存在可在提示词构建时获取的权威模型身份和有效上下文容量。
3. 只有在来源经过核实、存在稳定契约且可以自动化测试时，才接入动态容量。
4. 如果无法获得权威来源，使用固定 2000 字符预算，并在诊断结果中明确标记 `legacy_fallback`。

**v1 不得宣称 WorkBuddy 已经实现动态容量，除非有真实运行证据。** 后续可以独立扩展其容量来源，但不能为了三宿主表面一致而猜测数据。

---

## 6. 注入与容量治理一致性

这是本 SPEC 的核心验收要求。

### 6.1 统一预算传递

每次注入只解析一次预算，然后将同一预算传入该次请求实际执行的选择器和序列化器。

至少覆盖：

- `trimToBudget`
- `buildActivePrinciplePromptContext`
- `buildLivePromptInjectionProjection`
- `checkPromptArtifactDeliverability`
- `readPromptActivationInjectionStatuses`
- `runtime_v2_prompt_activations_injected` 相关记录
- Console 和 CLI 的容量预检与反馈

不得让实际注入使用动态预算，而 Console 仍使用另一个固定 2000 字符预算并声称预测准确。

### 6.2 路由与计费

保持 `PD_PROMPT_CAPACITY_V1` 的原有计费范围：

- `legacy_trim`：按选择行计费。
- `shared_render`：按完整 directive 渲染结果计费。

动态化只改变可用预算数值，不改变计费单位或 serializer。

容量投影、激活预检与真实注入必须使用相同的路由判定、预算解析结果和生产序列化器。

### 6.3 审批时的模型容量未知

Owner 审批时，Console/CLI 通常不能保证获得执行该激活的实时模型身份，因此不能假装知道当前模型的动态预算。

修改 `checkPromptArtifactDeliverability` 的容量判断：

- 单条成本不超过最小预算：可确认在所有受支持预算档位下单条可装入。
- 单条成本高于最小预算但不超过最大预算：返回 `model_dependent`，说明是否能注入取决于运行时模型容量。
- 单条成本超过最大预算：返回 `undeliverable`，给出明确原因和 `nextAction`。
- 路由或工件事实无法确认：保留 `unconfirmed`。

容量未知时，不得把 `model_dependent` 显示成确定可注入，也不得因为模型尚未绑定就声称该原则永久不可注入。

审批、激活、替换事务与 Owner 授权流程不变。运行时若当前预算不足，应如实记录排除原因。

### 6.4 轮转与公平性

保留现有 `legacy_fifo_prefix_v1` 与 `fair_rotation_v1` 行为，不借预算改造顺便重写选择算法。

必须测试预算改变后：

- 实际注入集合符合当前选择策略。
- 预算硬上限不被突破。
- `droppedActivationIds`、`oversizedActivationIds` 和 `truncated` 语义正确。
- 未提供轮转键时，不得宣称具备轮转公平性。
- 单条超过整个预算的原则仍明确报告为超长，而不是普通预算竞争。

---

## 7. 可观测性

扩展现有注入事件和容量读模型，优先使用可选字段，避免不必要的 schema 迁移。

增加（可选字段）：

- `budgetPolicyVersion`
- `capacitySource`
- `capacityStatus`
- `contextWindowTokens`
（`budget` 字段已存在，即本次解析得到的 `budgetChars`。）

保留现有 `injectedCharCount`、`budget`、`hostKind`、截断和选择策略字段。

约束：

- 不记录原始原则正文或完整用户提示词。
- 不记录 API Key、鉴权信息或自定义端点凭证。
- 缺失容量必须有可观察的降级原因。
- 历史事件没有新字段时，继续按旧格式读取；不能把缺失字段解释成容量为零。
- Console 必须区分“实际运行时容量已确认”和“仅按固定预算回退”。

---

## 8. 性能、兼容性与安全

1. 预算计算为纯函数，复杂度为 O(1)；模型目录查询必须使用已安装的本地目录。
2. 不在 Hook 中执行在线模型目录刷新，不增加额外 LLM 调用。
3. 不新增数据库或生产数据迁移。
4. 新增宿主上下文字段均为可选字段，旧 Hook 载荷继续有效。
5. 模型上下文信息仅用于预算计算，不赋予任何审批、激活或工具授权能力。
6. 元数据解析失败时，继续使用固定预算，不能导致宿主对话失败。
7. 保持现有 runtime pin、插件打包依赖、事件合同和类型检查。
8. 对上游 Pi AI API 的使用必须以仓库实际安装的 1.2.0 依赖为准，而不是直接复制最新版 Pi Coding Agent 的专属接口。

---

## 9. 实施阶段

### Phase 0：实现前核验

- 更新 `origin/main` 并核对源码基线。
- 重新搜索所有固定预算引用。
- 验证当前安装的 Pi AI 1.2.0 的模型目录查询接口。
- 验证 OpenClaw 当前支持版本的 Hook 容量来源。
- 验证 Codex 的模型 ID 与 Pi 模型目录的匹配情况。
- 核查 WorkBuddy 是否存在权威容量来源。
- 确认已有容量测量脚本可以复用。

输出：实际调用链、模型解析覆盖矩阵和未知项清单。

### Phase 1：预算解析器

- 实现单一预算解析器及公式。
- 增加边界测试、来源优先级测试和未知容量降级测试。
- 不接入真实注入路径前，先验证预算结果和错误处理。

### Phase 2：跨宿主接入

- 接入 OpenClaw 有效上下文容量。
- 保留并验证 Codex 模型身份，接入可信 Pi 元数据查找。
- 核实 WorkBuddy 的可用来源；无法确认时明确保留固定预算。
- 将同一个预算解析结果传入实际注入和共享 host-runtime。
- 保持现有选择策略与 Owner 治理边界。

### Phase 3：容量预检与 Console 投影

- 更新共享容量投影和单条激活预检。
- 更新 Console/CLI 的容量状态合同及提示。
- 为 `model_dependent`、`unconfirmed` 和降级原因增加回归测试。
- 确保实际注入、预检和投影不再出现预算来源不一致。

### Phase 4：真实测量与交付

复用 `packages/pd-cli/scripts/prompt-capacity-measurement.mjs`，扩展现有对照场景。

新增容量档位：32K、64K、128K、256K、1M 和未知容量。

分别测量：

- 实际预算值与来源。
- 注入字符数。
- 注入原则数及超长排除数。
- 截断次数与轮转覆盖。
- plugin-local 与 shared-render 两种计费口径。
- 模型容量未知时的固定预算降级。

不得把“注入原则数增加”直接宣称为“行为对齐改善”。行为改善需要单独的真实 Agent 对照和回放证据。

---

## 10. 验收标准

| ID | 验收要求 |
|---|---|
| AC-01 | 预算公式、上下限和 2000 字符回退均有完整单元测试。 |
| AC-02 | OpenClaw 在有效 Hook 容量可用时确实使用该容量，而不是继续读取固定常量。 |
| AC-03 | Codex 的模型 ID 只有经过可信解析才能参与预算计算；未知或歧义时正确回退。 |
| AC-04 | WorkBuddy 不存在权威容量来源时，明确报告回退，不伪造动态支持。 |
| AC-05 | `maxTokens` 不被用作 `contextWindow`；自定义端点不会无条件继承其他提供商的容量。 |
| AC-06 | 所有真实注入路径均受动态预算或明确的固定预算回退约束，预算不超过 4000 字符。 |
| AC-07 | 实际注入、预检、容量状态和 Console 投影共享相同的预算政策和路由计费口径。 |
| AC-08 | 审批时容量未知的原则使用 `model_dependent` 等诚实状态，不错误承诺一定注入或永久不可注入。 |
| AC-09 | 原有公平轮转、FIFO 降级、去重、超长识别及 Owner 审批语义无回归。 |
| AC-10 | 不增加每轮网络调用、数据库、schema 迁移或新的模型服务。 |
| AC-11 | `PD_PROMPT_CAPACITY_V1` 原有测试与容量测量回归通过，并新增各容量档位的生产构建器测量。 |
| AC-12 | OpenClaw、Codex、WorkBuddy 的实际接入结果分别有证据；不得以共享 helper 单测代替真实宿主验证。 |
| AC-13 | CI、构建、类型检查、插件打包检查和受影响测试全部通过。 |

## 11. 回滚与交付要求

回滚目标是原有固定 2000 字符预算，无需数据库迁移。

若动态容量解析或模型映射出现异常，系统必须能通过固定预算回退继续工作。不能因为动态预算失败而跳过原则注入之外的治理逻辑，也不能影响工具 allow/deny 决策。

最终交付必须包含：

1. 实际修改文件及调用链。
2. 每个宿主的容量来源、可信度、动态支持状态与回退原因。
3. 预算公式边界测试结果。
4. 容量预检与实际注入一致性测试结果。
5. 真实宿主 E2E 证据和容量测量报告。
6. CI 与构建结果。
7. 已知限制，尤其是 WorkBuddy 的容量来源，以及“总上下文窗口”与“当前剩余上下文”的区别。

**最终成功标准：** PD 在能够可靠识别模型容量时使用模型感知预算；无法可靠识别时保持旧行为并明确记录降级。所有注入与治理反馈都诚实反映实际执行的预算，而不是产生一个看似动态、实际仍依赖猜测的系统。
