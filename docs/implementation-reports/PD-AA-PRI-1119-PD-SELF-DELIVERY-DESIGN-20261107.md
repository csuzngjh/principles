# PRI-1119 PD 自有取证路径设计（未修改官方宿主上的替代方案）

- 文档 ID：`pd-aa-pri-1119-pd-self-delivery-design-20261107`
- 状态：**待 Owner 书面批准**（涉及观察边界变更与新增 PD 事件；批准前不编码）
- 前置：Owner 决策——PD 主线不依赖 OpenClaw 上游合并/发版/用户安装定制宿主；上游 PR #194566/#194594 仅作可选贡献保留参考，本轮不改
- 与旧方案关系：批准的 Tier B wire 检查点（宿主侧字段）降级为**可选上游贡献**；本设计给出"仅更新 PD"即可获得的观察路径

## 1. 官方未修改宿主能力矩阵（release/2026.11.1 源码核实）

| 接口 | 已核实事实 | 对 PD 的可用性 | 依据 |
|---|---|---|---|
| `llm_input` 插件钩子 | 字段：`runId, sessionId, provider, model, systemPrompt（=完整装配后 systemPromptText）, prompt, historyMessages（隔离快照）, imagesCount, tools`；在 context_assembled 阶段派发（文档定位：装配构造后、模型提交前）；**异步派发（void + catch）**；incognito 会话不派发；非捆绑插件需 `plugins.entries.<id>.hooks.allowConversationAccess=true` | **可用（Path A）**：PD 作为已启用插件注册该钩子，观察到**宿主侧最终装配的完整 system prompt 文本**（含 PD 注入块、守卫与回退之后的结果） | `hook-types.ts:232-241`；`attempt-prompt-support.ts:353-381`（派发条件与字段）；`attempt-prompt-build.ts:575`（systemPromptForHook=systemPromptText）；`docs/plugins/hooks.md`（权限/时限/incognito） |
| `before_prompt_build` 钩子 | PD 已在用；ctx 含 `runId`+`sessionId`（`PluginHookAgentContext`），与 `llm_input` 事件身份可联结 | **可用**：冻结点与观察点的身份联结键 | `hook-agent-context.types.ts:26-31` |
| provider 插件 `wrapStreamFn` | 官方 provider 运行时钩子，"在通用 wrapper 之后"包装 streamFn（最接近 wire 的官方扩展点）；但**按 provider 归属作用域**：需 `api.registerProvider` 声明 provider；`zai` 由捆绑插件拥有，`amd-radeon-cn` 为配置声明型 provider（归属不明确） | **受限（Path B）**：不能透明包装他人/内建 provider；需用户把 provider/model 配置改到 PD 声明的 provider id（配置代价大、改变生产路由） | `provider-plugin.types.ts:332-345`；`provider-transport.types.ts:27-38`；`docs/plugins/architecture-internals/provider-hooks.md:86-87` |
| `onPayload`（StreamFn options） | 内部 transport options，不在任何插件钩子面上暴露 | **插件不可达**（证实 Tier B wire 检查点必须宿主侧代码） | wire 调查（前轮，`openai-completions-transport.ts`） |
| `model_call_started/ended` | 元数据（runId/callId/provider/durationMs/requestPayloadBytes），**无正文** | 仅负载遥测，不支撑正文存在性 | `hook-types.ts:243-268` |

**结论**：在未修改的已发布宿主上，PD 自有代码能合法获得的最近观察点是 `llm_input`（装配后文本、宿主侧、独立于 PD 返回片段）；wire 级证据仍只有宿主侧代码（上游贡献）或显式本地转发（Path C，隔离实验）可提供。

## 2. Path 评估（按指令顺序）

- **A（推荐）**：PD 插件注册 `llm_input`，对 `event.systemPrompt`（宿主侧最终装配文本）执行与 Tier B 相同的有界包含检查 → PD 自有取证事件。**零宿主改动、零上游依赖**；用户代价=一行配置（allowConversationAccess）。边界准确标注为"装配后文本观察"，不宣称提交/送达。
- **B**：provider `wrapStreamFn` 提交前观察。**不推荐为主路径**：需 PD registerProvider + 用户改 provider/model 配置路由经 PD provider；对 `zai`（捆绑插件拥有）不可透明包装；`amd-radeon-cn` 归属 unknown。保留为"若未来用户已用 PD provider"的可选增强。
- **C**：隔离实验中的显式本地转发取证。仅当 D 的 wire 证据被 Owner 判为必要且 A/B 不足时另行提案（需独立批准卡：配置/凭证/生命周期/流式/成本/回滚）。本设计不实现。

## 3. 推荐设计（Path A：`llm_input` 装配观察）

### 3.1 文件与调用链

| 环节 | 文件（PD 仓库） | 改动 |
|---|---|---|
| 注册 | `packages/openclaw-plugin/src/index.ts` | `api.on("llm_input", handler)`（与现有 before_prompt_build 注册同型） |
| 冻结（既有） | `hooks/prompt.ts` + `hooks/prompt-presence-expectations.ts` | 不改语义；冻结点已位于守卫/重验/回退之后；**新增**：把冻结期望集存入 run 域内存登记（`runId+sessionId` → `{expectations, overflowCount, frozenAt, expiresAt}`，短 TTL 如 30 分钟，条目≤64） |
| 观察（新增） | `hooks/llm-input-presence.ts`（新）+ 检查器纯函数 **移植自 openclaw 实现**（`prompt-presence-check.ts` → `packages/openclaw-plugin/src/hooks/`，零宿主依赖） | handler：`runId+sessionId` 联结冻结登记 → 对 `event.systemPrompt`（responses 路径语义：完整文本）+ `event.prompt`/`historyMessages`（错误角色面）跑有界检查 → 写 PD 自有事件 |
| 事件 | `packages/openclaw-plugin/src/core/event-log.ts`（既有 EventLogService） | 新事件类型 `runtime_v2_prompt_presence_observed`（遥测 union 门禁按仓库规则同步） |

### 3.2 输入输出与身份

- 输入：`llm_input` 事件（宿主侧文本）+ 冻结登记（PD 自身装配事实，内存）。
- 输出：PD 事件 `{ runId, sessionId, provider, model, boundary: "post_assembly_system_prompt_via_llm_input", attemptLabel: "per_prompt_build", results[{activationId, revision, outcome, reason, hitLocation}], expectationsOverflow }`。
- 身份：`runId+sessionId`（两钩子共有）；同 run 多次 prompt 构建（工具循环/压缩重试）→ 多条观察事件，各自与该次冻结对比。
- 结果资格：与 Tier B 相同三值（`full_hit`/`checked_missing`/`unknown`+reason）；登记缺失/过期 → `unknown:missing_expectations`（不静默）；**该事件只陈述装配观察事实，不判定 D/confirmed/timely，不宣称 wire/送达**。

### 3.3 覆盖与失败处理

- 覆盖：普通会话与工具循环的每次 prompt 构建；压缩/空响应重试会再次触发（源码判读，**运行时频次列入待验证**）。incognito 会话无观察（宿主行为，如实限制）。
- 失败：handler 内 try/catch 全包，失败写 `unknown:check_failed` 事件，绝不向宿主抛错；登记 TTL 过期或登记缺失 → `unknown:missing_expectations`。
- 有界：检查器上限沿用（64 条/64KiB/8MiB/512 消息/32MiB 累计）；登记自身 ≤64 条、TTL 清理。

### 3.4 仅升级 PD 后的生效条件与用户操作

| 步骤 | 谁 | 内容 |
|---|---|---|
| 1 | 用户 | 更新 PD（官方安装路径）→ 插件含 llm_input 注册 |
| 2 | 用户 | `openclaw.json` 增加 `plugins.entries.principles-disciple.hooks.allowConversationAccess: true`（一行；语义=允许读取会话内容类钩子） |
| 3 | 无 | 不改 provider/model 配置；不改宿主；不装定制宿主 |

代价：allowConversationAccess 扩大会话内容读取面（宿主文档明示这是信任授予而非沙箱）；隐私=装配文本仅在内存比对，不落正文，事件只含资格与摘要性字段。

### 3.5 离线验收（批准后实施时）

1. 检查器移植单测：openclaw 矩阵等价用例（宿主侧 systemPrompt 为纯文本，无 parts，矩阵相应简化）+ 全部负例。
2. 冻结→观察联结单测：登记命中/缺失/TTL 过期/溢出。
3. **真实 hook 链单测**：同一 harness 先 `handleBeforePromptBuild`（冻结）再直调注册的 llm_input handler（模拟宿主派发字段，用真实 `systemPromptText`），断言事件事实与最终装配一致（含回退后排除）。
4. 回归：hooks 全量 + tsc + lint + build + 遥测 union 门禁。

### 3.6 后续隔离运行验收（另行批准的运行卡，本设计不含）

1 次 responses + 1 次 completions 真实任务，断言 PD 事件出现且与注入事实一致；运行卡届时独立提交。

### 3.7 回滚

revert PD 更新即可；登记为内存态无持久迁移；`allowConversationAccess` 配置可保留（无副作用）或移除。

### 3.8 与旧 Tier B 方案的替代关系

| | 旧 Tier B（宿主侧 wire 检查点） | 本设计（Path A 装配观察） |
|---|---|---|
| 观察边界 | 提交前请求对象（最接近 wire） | 装配后宿主侧文本（llm_input） |
| 生效条件 | 宿主代码合入+发版+安装（上游依赖） | **仅更新 PD + 一行配置** |
| 可判定 | wire 级存在性（D 的最强现有素材，仍非送达证明） | 装配级存在性（宿主侧独立文本，优于 PD 自返回片段；D 保持 unknown） |
| 状态 | 降级为可选上游贡献（#194594），不再是 PD 主线完成条件 | **PD 主线路径（待批）** |

### 3.9 已验证 / 推断 / unknown

- **已验证（release/2026.11.1 源码）**：llm_input 事件字段与派发条件；systemPrompt=完整装配文本；异步派发；allowConversationAccess 要求；ctx.runId/sessionId 可联结；wrapStreamFn 的 provider 归属作用域。
- **推断（标注）**：llm_input 对工具循环/重试的触发频次（源码判读，待运行时确认）；`amd-radeon-cn` 配置型 provider 的钩子归属。
- **unknown**：wire 级正文证据在未修改宿主上仍不可得（D 维持 unknown——这是真实能力缺口，不是任务失败）；llm_input 在 2026.11.2+ 的契约稳定性。

### 3.10 需要 Owner 批准的具体范围

1. **L1 设计**：本文件（Path A + 边界标注 + 事件契约）。
2. **L2 实现**：PD 仓内 llm_input 注册 + 冻结登记 + 检查器移植 + 新事件（含遥测 union 门禁同步）+ 单测；**不含**任何宿主改动。
3. **L3 离线验收**：§3.5 全部通过 + 回归门禁。
4. **L4 文档同步**：SPEC/观察方案的 D 口径补注"Path A 提供装配级观察；wire 级仍 unknown"。
