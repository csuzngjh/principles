# SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001 — Codex / WorkBuddy 关键词自动 Pain 准入

> 版本：v0.1（2026-10-19）
> 状态：**Draft / Owner Review；仅规格调查交付，未授权修改运行代码、安装产物或生产开关**
> 源码审计基线：`origin/main@9f2184d6b533ae6eb1a42b8358efde3059d61815`（2026-10-19）
> 适用：`@principles/core`、`@principles/host-runtime`、`@principles/codex-adapter`、`@principles/workbuddy-adapter`、CLI/安装器与测试
> 关联已有契约：`docs/adr/0020-codex-cli-host-adapter.md`、`docs/specs/SPEC-CODEX-PAIN-CLOSURE-001-v0.2.md`、`docs/specs/SPEC-WORKBUDDY-PAIN-CLOSURE-001-v0.1.md`、`docs/specs/workbuddy-host-adapter-spec.md`

## 0. 决策摘要

本 SPEC 的目标不是把 OpenClaw 整套同步 I/O + Stage2 LLM 逻辑搬到其他宿主，而是**用各宿主真实的当前用户消息，在明确授权后执行极轻量的高精度纠正词检测；命中后通过 PD 唯一的规范 Pain、去重、限额与诊断任务链路**。

1. **Codex：已有可用代码。** 当 `host.codex` 与 `codex_conversation_ingestion` 同时开启，`UserPromptSubmit / before_prompt_build` 已经构建 `GovernanceCorrectionCandidate`，通过共享 `admitGovernanceSignals()` 进行 high + STRONG 判定、事务化 Pain 准入和 `ensureGovernanceContinuation()`。第一阶段主要做真实配置/入口/数据证据验收，**禁止重复造第二套 Pain writer**。
2. **WorkBuddy：确有缺口。** `UserPromptSubmit` 已能取得 `prompt`、`session_id`、`generation_id` 和 `is_internal_continuation`；现有 `recordWorkbuddyOwnerStatement()` 仅处理 `PD记录痛苦：` 显式前缀。共享准入的 `admitOne()` 明确拒绝非显式 WorkBuddy user_correction。须接入普通消息 → 共享检测 → 唯一 Pain → 任务确保。
3. **推荐分两期。** P0 做 Codex 既有路径真实验收 + WorkBuddy 显式开启的最小自动检测；P1 如 Owner 希望“只打开几个词，而不授权 Codex 全会话增量采集”，再提供与 `codex_conversation_ingestion` 独立的 Codex live-only 轻量模式。**P1 不是 P0 的隐式前置条件。**
4. **共情词不是强痛苦证据。** `搞什么`、`不对`、`再试一下` 等低精度/情绪表达不能直接造高分 Pain；v0.1 仅自动准入高精度纠正语句，弱信号与 Stage2 LLM 留在原有可授权链路，不新增任何联网模型调用。

## 1. 已核查事实与边界（2026-10-19）

| 事项 | 源码证据 | 当前结论 |
| --- | --- | --- |
| OpenClaw Stage1 | `principles-core/src/runtime-v2/signal-collector/keyword-stage.ts`；`openclaw-plugin/src/core/signal-collector-host.ts` | 简单字符串包含匹配；OpenClaw 钩子还会有轨迹 SQLite 写入、文件统计/其他逻辑，不可直接类推“整条链零开销”。 |
| 共享确定性检测 | `host-runtime/src/governance-signal-admission.ts` 的 `buildSharedSeedKeywordStore`、`createSharedCorrectionKeywordStore`、`evaluateCorrectionSignal` | 已有共享 seed、learner 投影、高精度分级；Codex 只消费 high + STRONG 同步结果。 |
| Codex 实时入口 | `codex-adapter/src/pd-hook.ts`、`ingestion/ingestion.ts`、`ingestion/admission.ts` | 有原生消息候选、转录回放收敛、规范 Pain + 任务路径；`codex_conversation_ingestion` 默认 OFF，关闭时必须维持零 transcript I/O。 |
| WorkBuddy 入口 | `workbuddy-adapter/src/codec/input-decoder.ts`、`pd-hook.ts`、`explicit-owner-statement.ts` | 当前只有“显式 Owner 提交”可自动造成 user_correction Pain；普通消息无自动检测调用。 |
| WorkBuddy 准入硬门 | `host-runtime/src/governance-signal-admission.ts` 中 `admitOne()` | 现有校验只允许 Codex 或 `workbuddy + user_correction + explicitOwnerStatement=true`。直接传普通 WorkBuddy candidate 会被拒绝。 |
| WorkBuddy 证据边界 | `host-runtime/src/governance-observation-store.ts`、`governance-signal-admission.ts` | `GovernanceObservationInput.hostKind` 当前仅为 `codex`；`ensureGovernanceContinuation()` 会启动 Codex 风格 transcript promotion，**不能原封不动用于 WorkBuddy**。 |
| WorkBuddy 原生能力 | `workbuddy-adapter/tests/fixtures/host-contract/README.md`、`events/user-prompt-submit.json` | `UserPromptSubmit` 有真实样本；print/stream-json 的首个启动 prompt 曾未发此事件，不能声称覆盖所有启动方式。 |
| 当前安装/开关 | 用户级工作区与源码仓库配置分离 | 是否“运行中”必须在测试时重新读**实际运行工作区**，不得仅由仓库默认值推断；本 SPEC 不擅自打开任何生产开关。 |

**已证实**的是代码接入/断点及测试样本，不是三宿主的生产实测命中率。现有单测并不能取代真实安装产物、原生宿主、持久化与 worker 的联合验收。

## 2. 用户故事、范围和非目标

**US-1：** 我在 Codex 或 WorkBuddy 对 AI 的真实输出说“这是错的”或“不要自作主张”，启用该能力的工作区应自动创建**一条** `host_kind` 正确的 Pain、唯一 admission marker 和待诊断任务；不要求我额外输入“PD记录痛苦”。

**US-2：** 只是谈论“这是错的”这几个字、引用代码或一般闲聊时，应优先避免误报；弱情绪信号不能伪装成 Owner 的已验证纠正。

**US-3：** 默认关闭的新能力对其他宿主无影响；关闭后不扫描当前 prompt、不访问 transcript、不留下新证据；出错不阻断正常用户消息。

**US-4：** 我能从 status/诊断输出知道“宿主启用了吗、当前消息可观察吗、扫描了吗、是否命中、Pain 是否入库、任务是否排队、为什么跳过”，不必依赖 OpenClaw 的日志。

**非目标：** 自动批准原则、自动写入长期行为约束、默认开启语义模型、历史全量回扫、后台常驻模型、读取 WorkBuddy transcript、改变已有工具失败准入/deny 语义、替代显式 Owner 痛苦入口。

## 3. 触发语义和词表策略

### 3.1 最小词表

P0 只允许从 `HIGH_PRECISION_CORRECTION_OVERLAY` 选定的**4 个已存在的 high/correction seed**作为第一批自动准入：
- `这是错的`
- `不要自作主张`
- `不应该这么做`
- `又搞错`（以共享 overlay 在实施基线中的实际完整词项为准；若已漂移则以已核实条目替代，不得猜造）

实现时通过**共享词表的受限投影**过滤 `category=correction && precision=high` 并限定上述 allowlist；不能各宿主复制一份字符串检测器。它只是 P0 上线白名单，**不是删除、重写 OpenClaw 的词库**。Codex 现有 ingestion 路径保留原先已批准的 high/STRONG 策略，试运行报告必须单独列示“P0 WorkBuddy 白名单”与“Codex 既有全高精度策略”的覆盖差异，不能宣称两者命中集合完全相同。若 Owner 要求**相同的四词策略**，作为 P1 通过共同的 policy 参数收敛，不得暗改旧 Codex 行为。

不得自动把整个 learned store（可能包含高权重但语义含混的用户整句）提升为两个新宿主的第一批触发词；后续扩大白名单须依据真实 TP/FP 证据和 Owner 审阅。

### 3.2 确定性门槛

- 仅真实 **当前用户消息**，且宿主原生身份有效；非用户触发、内部续接、subagent 消息、无稳定 turn identity → `skipped`，不造 Pain。
- 只在 `matchedPrecision=high && strength=STRONG && type=correction` 时允许自动 Pain。`ambiguous / empathy / none` → 不造 Pain、不占配额、不排诊断。
- 同一条消息被显式 `PD记录痛苦：` 命中（包括非法/被拒前缀）时，优先走已有显式处理；**通用关键词路径必须跳过**，以免绕过显式校验、重复写入或赋予伪 Owner 权限。
- 不剪切用户消息后再做敏感信息脱敏。检测前限制最大长度并对超限消息显式 `skipped:prompt_too_large`；持久化时先对完整原文走现有 sanitizer，再截取受限摘要。
- 第一版不尝试解决所有引号/引用上下文误报：加入引用、代码块、第三方报告等负样本验收；若误报率不达标，保持 observe-only，**不要**通过“命中即落库”掩盖质量问题。

## 4. 推荐架构和控制面

```text
Codex before_prompt_build ── host.codex + ingestion consent ─┐
             (existing)                                   │
                                                           ▼
                                                shared high-precision
                                                evaluateCorrectionSignal()
                                                           │
WorkBuddy UserPromptSubmit ── host.workbuddy ── P0 opt-in ──┤
   native session/generation/is_internal_continuation      │
                                                           ▼
                                   shared admitGovernanceSignals()
                                      (dedup + quota + canonical Pain)
                                                           │
                          ┌────────────────────────────────┴─────────────┐
                          ▼                                              ▼
             Codex ensureGovernanceContinuation()     WorkBuddy ensureGovernanceDiagnosticianTask()
             (已授权 observation + promotion)         (当前消息原生证据；绝不伪造 transcript)
                          └────────────────────────────────┬─────────────┘
                                                           ▼
                                  既有 PD Diagnostician 任务/Owner 审阅
```

### 4.1 P0：Codex 不另造检测器

- 使用现有 `codex-adapter/src/pd-hook.ts` 的 `runConversationIngestion` / `runGovernanceAdmission`、共享 `evaluateCorrectionSignal`、`admitGovernanceSignals`、`ensureGovernanceContinuation`。
- 先在**隔离测试工作区**通过已有公开设置/同意流程显式启用 `host.codex`、`codex_conversation_ingestion`；绝不直接修改用户生产配置。记录实际工作区解析、旗标来源、version guard、transcript consent 披露和 native `UserPromptSubmit/Stop` 效果。
- 验证相同 `turn_id` 的 live + Stop transcript 重放只产生一个规范 Pain/任务。`codex_conversation_ingestion=false` 仍必须是**零 transcript 访问**；当前显式 Owner 前缀照常生效。
- 如用户拒绝 Codex transcript consent，不偷偷借其他路径扫描历史；只能等 P1 live-only 方案通过单独授权，不能将 P0 判为“已在 Codex 开启自动检测”。

### 4.2 P0：WorkBuddy 新增自动入口

**改造入口：** `workbuddy-adapter/src/pd-hook.ts`，在 `recordWorkbuddyOwnerStatement()` 之后、共享 dispatch 之前接入 `evaluateWorkbuddyLiveCorrection()`（名称可调整），仅 `event.kind=before_prompt_build` / native `UserPromptSubmit`，并要求原始 `is_internal_continuation === false`、合法 `session_id`、`generation_id`。不得信任模型输出、拼接的文本或自报的 Owner 身份。

**工作区和身份：**
- 强制使用 `resolveWorkbuddyWorkspace(os.homedir())` 指向的 WorkBuddy governance workspace，不回退到项目目录/Codex 工作区。
- 身份复用现有显式提交约定：`nativeIdentity = JSON.stringify(['workbuddy', sessionId, generationId])`；`hostTurnId=nativeIdentity`，`logicalObservationKey=nativeIdentity + '|user'`，`rolloutIdentity=JSON.stringify(['workbuddy',sessionId])`。同一 turn 不得新造随机 `painId`、`turnId` 或退化为 message-content identity。
- 先解析显式前缀。只要 `matched=true` 就跳过自动路径；无论显式提交成功、拒绝、重试还是限流，都不能 fallback 成关键词自动提交。
- 使用 host-runtime 的共享 deterministic detector，**不能**在 WorkBuddy hook 引入 Stage2 LLM、OpenClaw plugin 依赖、transcript/`.codebuddy/projects` 扫描。
- 第一批四词 allowlist 由共享 policy 投影提供；**新增自动检测分支在未命中时**只做最轻量计算，不额外打开 trajectory.db、不构建 worker、不写消息正文或普通“未命中”逐条日志。原有基础治理 hook 可能仍有其自身 I/O，本 SPEC 不声称整个 WorkBuddy 钩子在未命中时零 I/O。
- 命中后复用唯一 `admitGovernanceSignals()` 所属的规范 Pain 事务；**不得只把 `admitOne()` 改为 `hostKind === workbuddy` 就算完成**。优先新增受限的 `admitTrustedWorkbuddyLiveCorrection()` 内部入口（或等价的受控 admission-authority seam），校验 WorkBuddy 新 feature gate、原生 current-user 身份和 allowlist，再复用 `admitCorrection()`；普通通用候选 API 仍拒绝未授权的 WorkBuddy user_correction。若选择扩展 `admitOne()`，则必须在共享准入边界再次校验这些权限条件，证明绕过 hook 直接伪造 candidate 无法创建 Pain。不得顺便放开 WorkBuddy tool_failure。
- Pain 事务继续使用既有 `canonicalPainId`、`governance_signal_admissions` 唯一键、限额桶，命中后以 `ensureGovernanceDiagnosticianTask()` 确保一条待诊断任务。**不得**直接调用 Codex 特有的 `ensureGovernanceContinuation()`，它会尝试 WorkBuddy 不具备的 transcript evidence promotion。

**证据必须真实：** 现有 `taskSubmissionPayload()` 对非显式 user_correction 总写 `governance_observation:<key>`，但 `governance-observation-store` 目前仅支持 Codex。这不能原样沿用，否则 WorkBuddy 任务将引用不存在的观察。P0 选定以下契约：WorkBuddy live keyword 任务使用源自真实 native 当前用户消息、且可按键找到的**已提交规范 Pain 记录**作为 `sourceRef=pain_event:<canonicalPainId>`；Pain 中的文本按现有 sanitizer 处理，marker 中包含 native session/turn 身份。`taskSubmissionPayload()` 当前没有 `painId` 参数，因此必须以经过事务派生的 `canonicalPainId` 显式传给 payload builder，并补上 sourceRef 的真实 resolver、可达性测试和脱敏校验。若该自引用来源无法满足 Diagnostician 的证据质量门槛，则改为单独的、受限持久化 live-prompt 证据记录（仍不读取 transcript），不能只替换字符串蒙混过关。没有可靠来源时准入降级、不得编造轨迹。P1 如确需 WorkBuddy 观察库，再单独设计；不得悄悄把 Codex-only `GovernanceObservationInput.hostKind` 改为泛型导致 transcript 语义漂移。不能把关键词检测结果标成 `owner_statement` 或 `runtime_verified`。

**WorkBuddy 输出：** 自动发现不向 stdout 注入“Pain 已完成”或重复模型指令；正常继续 host 的原始 stdout 契约（无额外输出、`exitCode=0`）；失败只写有界 stderr + 脱敏诊断事件，绝不可使用 `exit 2`（会清掉用户 prompt）。显式前缀仍走已有真实 `painId/taskId` 回执；PreToolUse fail-closed/deny 决策完全不受影响。

### 4.3 P1（单独批准）：Codex live-only 轻量能力

若要求 Codex **只在当前 Prompt 做几个词匹配**、不启用 `codex_conversation_ingestion`：
- 增加独立 quiet/default-OFF feature `codex_live_keyword_pain`，要求同时 `host.codex.enabled=true`，仅可消费已验证的 native `UserPromptSubmit` 当前 `prompt / session_id / turn_id`。关闭时**零 transcript I/O、零 current-prompt scan**，不能借 `CODEX_HOME` 遍历历史。
- 使用与 P0 WorkBuddy 相同的共享 allowlist/policy、STRONG 准入与 Pain writer，但**不能**使用 `ingestCodexConversation()`（它要求校验 transcript_path）。完整源码与产物测试证明该分支不读取任何 transcript 字节，也不读取历史 JSONL。
- 既有 `codex_conversation_ingestion=true` 时原 ingestion 路径**独占**通用纠正准入，live-only 不再重复提交；二者不可以同时成为同一 turn 的两个独立 Pain writers。对模式切换、同一次 turn 再投递，规范 ID 按 session+原生 turn+真实 text 收敛；审计 marker 可不同，但 task 与 Pain 只能一份，升级切换测试必须实证。
- live-only 没有 transcript 证据提升，诊断依据诚实标为“仅当前用户纠正消息的未验证观察”；P1 需设计可解析的 native prompt evidence sourceRef，并采用 `ensureGovernanceDiagnosticianTask()`，不得伪称完整轨迹或触发 Codex transcript promotion。
- 用新增 flag 的注册、生命周期、配置校验与显式 Owner 授权流程接线；不能用 `signal_collector` 标志冒充轻量关键词独立开关。

## 5. 旗标、诊断与发布

**既有门：** `host.codex`（默认 core ON，但本机用户工作区可覆盖）、`codex_conversation_ingestion`（quiet OFF）、`host.workbuddy`（quiet OFF；本机已选择开启不等于自动检测开启）。

**新增 P0 门：** `workbuddy_live_keyword_pain`，`category=quiet`、默认 `enabled=false`，即使 WorkBuddy 宿主已启用也不得自动创建通用用户纠正 Pain。P1 才增加 `codex_live_keyword_pain`。在 `feature-flag-contract.ts` 和 `feature-flag-lifecycle.ts` 注册；开关配置由受控 CLI/安装器写入，不在 hook 内偷偷改配置。

**治理层级：**
1. host gate 关闭 → 无匹配/无 DB 写/无任务；原有其他 host 行为不变；
2. auto gate 关闭 → 现有显式提交与工具失败照常工作，普通消息不自动入库；
3. 消息不具备 native 身份 → skip + 聚合计数；
4. 扫描命中但不是 high + STRONG / 超额 → 拒绝准入且不创建 marker/task；
5. 已持久化 Pain，但排任务失败 → 返回可重试的 degraded 状态；由现有 task ensure/reconcile 保证最终不丢不重。

**状态字段（建议复用诊断事件 + CLI status；不增加普通命中的每轮 stderr 噪声）：** `hostKind`、`sourceEvent`、`workspaceScope`、`hostFlag`、`autoFlag`、`mode=off|keyword_only|ingestion`、`evaluated`、`matchClass=strong|weak|none`、`outcome=skipped|not_a_signal|admitted|already_admitted|rate_limited|degraded`、`ruleVersion`、`durationMs`、`failureReason`、`canonicalPainId/taskId`（仅已持久化后）。不记录完整 prompt、API token、秘密或无上限的关键词片段。操作页面至少能辨别“未开启 / 从未收到 hook / 检测但未命中 / 命中但限流 / Pain 已入库但诊断未完成”。

## 6. 性能、资源与故障预算

- **零新联网请求**：P0/P1 词匹配路径纯内存，严禁启动 LLM；WorkBuddy 未命中不得做 `readFileSync/SQLite/open worker`。仅每个 hook 当前消息扫描一次，绝不遍历整个消息历史。
- **限制输入与词表规模**：P0 allowlist 4 词，文本上限建议 16 KiB（超限跳过并记录计数）；长消息的上限是显式产品决定，不能默默截断后对残片做权限判断。
- **真实持久化不可 fire-and-forget**：Codex/WorkBuddy 均为短生命周期 hook 子进程；命中后必须等待“Pain durable + task enqueue or durable recoverable pending marker”的成功确认才能宣称成功。写入必须有有界时间预算；超时不允许阻断用户 prompt，不虚构成功。
- **性能验收指标属于目标，不是当前实测**：在同一 Windows/Node/真实 SQLite 环境，对比关闭新门的基线，记录 30 次以上 warm/cold 子进程与 100 次以上 scanner 微测的 p50/p95/p99；建议 **未命中增量 p95 ≤ 10ms、p99 ≤ 30ms；命中并持久化增量 p95 ≤ 100ms、p99 ≤ 250ms**。若达不到，先优化 I/O/锁等待再开启 admission；不得仅通过 mock 指标宣布达标。逐项给出源码标记：decode、gate、scan、lock/SQLite、Pain commit、task ensure、stdout encoding。
- 工作区 SQLite 忙锁、损坏、目录只读、I/O 延迟时应该可观测 degraded；不重试 50 次同步 busy-wait 把 WorkBuddy/Codex 钩子卡住。Codex 原 ingestion 路径的现有工作不因本规格自动改变。
- 完整 OpenClaw prompt hook 的历史查询与同步 SQLite 风险另立性能专项；**不要**把 OpenClaw 的逐消息轨迹入库/批量分类默认复制过来。

## 7. 工程工作包与文件清单

| 工作包 | 必要改造 | 预计落点 | 验收交付 |
| --- | --- | --- | --- |
| G0：Baseline / 环境 | 对齐 `origin/main` 与运行安装版，复核 Codex UserPromptSubmit/Stop 和 WorkBuddy 第一条消息限制；读已有准入测试与真实 fixture | `codex-adapter/tests`、`workbuddy-adapter/tests/fixtures/host-contract`、`docs/implementation-reports` | 可追溯的 host capability / flag / privacy 矩阵 |
| G1：Codex 现成链路 | 在隔离工作区走现有 consent/enable，真实 stdin → observation → high-precision admission → task → replay 去重；不改功能代码（有实证缺口才开修复） | `codex-adapter/src/pd-hook.ts`、`ingestion/*`、`pd-cli/src/commands/codex-setup.ts` | Codex 无新 scanner 的端到端真实证据 |
| G2：共用受限扫描策略 | 复用 `evaluateCorrectionSignal`/`buildSharedSeedKeywordStore`，导出受限 4 词 policy；不可重复实现 includes 扫描 | `host-runtime/src/governance-signal-admission.ts` 或紧邻独立 helper | 高精度、弱信号、无匹配、非法 store 单测 |
| G3：WorkBuddy 自动入口 | WorkBuddy 原生身份校验、显式优先、feature gate、候选构造、准入、任务确保、日志/输出契约 | `workbuddy-adapter/src/pd-hook.ts` 与新增 `live-correction.ts` | 正式 hook runner + 实 SQLite Pain/task |
| G4：共享 admission / evidence | 保守放开 WorkBuddy 自动 user_correction；避免来源伪造，修复不可解析的 `governance_observation:` ref，单一 Pain/任务身份 | `host-runtime/src/governance-signal-admission.ts`、必要的证据读取接口 | 不伪造观察/不改变 Codex tool failure/explicit |
| G5：控制面/发布 | 新 feature flag 默认 OFF、CLI/status 的有效值及来源、手动/回滚开关、安装/打包交付检查 | `principles-core/src/runtime-v2/feature-flags/*`、WorkBuddy installer / CLI / docs | 可观测、可关闭、升级不偷开 |
| G6：P1（后续） | Codex live-only 独立同意与轻量开关、和 ingestion 互斥不重复 | `codex-adapter/src/pd-hook.ts`，必要的 host-runtime helper | 不读取 transcript 的真实子进程证明 |

## 8. 强制验收矩阵（不得仅跑 mocks）

| ID | 场景 | 必须观察到的结果 |
| --- | --- | --- |
| A01 | WorkBuddy 默认关 / host 关 | 原 prompt 正常、无自动 Pain/marker/task、无当前消息持久化；显式路径行为不被误关 |
| A02 | WorkBuddy 已开启 + 真实 `UserPromptSubmit` 发送“这是错的” | 恰好一条 `host_kind=workbuddy/source=user_correction` Pain、一个 marker、一个 task、可解析的真实证据 sourceRef；零 transcript I/O |
| A03 | WorkBuddy 同 `session_id+generation_id` 重放；另一个 generation 发送同文 | 重放 1 条；不同原生 turn 生成独立事件，并遵守配额 |
| A04 | WorkBuddy `is_internal_continuation=true` / 缺失 / 非布尔 / 无 generation | 零自动 Pain；不能从 transcript 猜缺失 id |
| A05 | WorkBuddy `PD记录痛苦：...` 有效、空内容、>500 字、畸形、重复 | 完全沿用既有显式收据/拒绝；普通关键词不能二次创建 |
| A06 | 普通消息 / 弱共情 / 引用 / pasted code / 长文 / 敏感 token | 禁止误判、禁止保存凭据；超限明示 skip；真实 TP/FP 评估未达标则不可放量 |
| A07 | WorkBuddy 命中后 DB 忙、只读、任务 enqueue 故障 | 用户 prompt 不被清除；非空、脱敏、界限明确的诊断；可重试且无第二个 Pain/任务 |
| A08 | Codex 两旗标启用 + high correction | 真实 hook 生成一条规范 Pain/任务；Stop catch-up 不重复，诊断可继续 |
| A09 | Codex `codex_conversation_ingestion=false` | 原路径零 transcript I/O；若未实施/开启 P1 live-only，绝不宣称普通消息能自动创建 Pain |
| A10 | 功能开启后关闭、安装升级/重装、worker 重启 | 新自动准入立即停用；已有 evidence 保留；已提交任务幂等恢复、无自动原则批准 |
| A11 | WorkBuddy PreToolUse deny；PostToolUseFailure；UserPromptSubmit 异常 | 保持既有事件级 exit code / stdout whitelist；自动检测绝不改变 deny 结果或阻塞正常 prompt |
| A12 | 性能和资源 | 同机真 SQLite 的增量 p95/p99 满足第 6 节约定的验收目标；不额外启动进程或 LLM；不对历史逐条扫描 |
| A13 | 真实 WorkBuddy 首条启动 prompt / Desktop 与 stream-json | 明确报告 UserPromptSubmit 触发覆盖率与缺口；host 未派发则标注“未观察到”，不能伪称自动覆盖 |
| A14 | P1 Codex live-only（若授权） | 关闭 ingestion 条件下仍只匹配原生当前消息，零 transcript 字节读取；与旧模式切换只得一条 Pain/任务 |

**核查 SQL（只读）：** 按 session / native turn 检查 `pain_events(canonical_pain_id,host_kind,source)`、`governance_signal_admissions(logical_observation_key,canonical_pain_id,diagnostician_task_id)`；按 taskId 检查 `.pd/state.db` 中 Diagnostician task 的真实存在与状态。仅有 stderr 或 JS mock 回执不等于 Pain 已成功持久化；Pain 入库不等于诊断执行完毕。

## 9. 风险、依赖与回滚

1. **P1-来源伪造：** 扩开 `admitOne()` 的 WorkBuddy 分支不可以信任任意外部造的 `hostKind='workbuddy'`。须保证 caller capability / native provenance / host gate 边界；普通 payload 不能凭字符串冒充 Owner。
2. **P1-无效诊断证据：** WorkBuddy 没有 Codex 轨迹观察，不能使用不可解析的 `governance_observation:...`；否则 Pain 虽能入库，诊断可能被卡住或产生幻觉上下文。要求可验证的 `pain_event:...` evidence resolver 与 E2E。
3. **P1-误报：** “我说的是”“谁让你”或学到的整句不应未经评估入第一版 WorkBuddy 自动强信号；真实样本需单独记录 TP/FP。引用和转述属于强制负例。
4. **P1-宿主首次事件覆盖：** WorkBuddy CLI print 的第一个 prompt 曾不发 UserPromptSubmit，不能靠扫描旧 transcript 补漏；需用实时宿主探针重新测量覆盖率；无法接收的事件标记限制。
5. **P1-性能/隐私：** 同步 DB 锁、子进程启动、长消息、后端等待均可放大延迟。不要默认读取历史消息；Codex 现有 ingress 的 Stop 回放是**不同范围的 Owner 同意**。
6. **回滚：** 先关闭 WorkBuddy 专属新旗标（P1 则关闭 Codex live-only），保持现有 `host.workbuddy`、`host.codex` 及显式反馈/工具失败功能；已有 Pain/任务不删除。源代码/安装产物通过正式发布机制回滚，禁止手工热补 `~/.pd/runtime` 或插件缓存。
7. **门控与 Owner 授权：** G0/G1/G2 可在隔离环境完成；G3–G5 需要 PR、CI 和 Owner 审核后再开启真实用户工作区。真正扩大词库或开启 Codex transcript/Stage2 LLM，都要另行明确批准。

## 10. 完成定义与交付顺序

- **Gate A / SPEC 合格：** 源码门槛、隐私授权、host payload 事实、真实证据引用和回滚策略均已列明。
- **Gate B / P0 READY：** Codex 现有模式真实测试、WorkBuddy 自动入口源码/生产钩子测试、admission/evidence、flags、负例、限流/幂等、性能门槛、CLI 可观察性全部通过；PR CI 绿且 review 已收敛。
- **Gate C / LIVE VERIFIED：** 官方更新后的真实 Codex 与 WorkBuddy host 各至少一次自动 strong 命中成功入库、一次负例未入库、一次重放不重复，并可通过 PD CLI 复核 `painId/taskId`；记录版本、feature flag 的**有效值与来源**。
- **Gate D / P1 可选：** Owner 决定是否支持 Codex live-only；未经批准不得用 transcript 采集替代“只检查当前消息”的授权。

**推荐实施顺序：** G0 → G1（Codex 无新代码验收）→ G2/G3/G4（WorkBuddy 真正缺口）→ G5（可控发布）→ Gate B/C → 视 Owner 决策启动 G6。

---

**状态声明：** 该文件是依据 `origin/main@9f2184d6` 的**改造 SPEC**，不是已实施报告；未更改任何运行代码、配置、用户 Pain、审批或 PR。

## Owner decision addendum (2026-10-19): fresh-install default ON for WorkBuddy

New, first-time WorkBuddy installations MUST explicitly persist both host.workbuddy.enabled=true and workbuddy_live_keyword_pain.enabled=true in their NEW governance workspace. Existing users, upgrades and reinstalls MUST retain existing effective settings. Central quiet registry defaults remain OFF for backward safety. This supersedes P0 default-OFF language above ONLY for the fresh WorkBuddy installer path. Do NOT enable codex_conversation_ingestion or imply Codex live-only is ready.
