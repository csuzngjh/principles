# WorkBuddy Host Adapter SPEC — PD 第三宿主

> Status: IMPLEMENTED v0.3.1 — v0.3.0 契约经实施与验收（2026-10-13，PRI-952）；实现状态见 §12，验收边界以 §12 为准，未验证项不得宣称支持。
> Date: 2026-10-12（v0.3.0 整改稿）；2026-10-13（§12 实施状态补记）。
> Code baseline: `b0f807b95d8c86e88fe46b7f2a63eec1923af24a`（整改基线）；实现分支见私有执行记录 STATE.md。
> Input: 同日 v0.2.0、第一轮评审清单，以及 2026-08 的 feasibility / capability-map / adapter-verification 三份调研。
> Review: 第二轮报告保存在独立 private docs 的 `docs/reviews/2026-10-12-workbuddy-spec-second-review.md`。第一轮报告及旧调研是历史证据，不是当前验收结果。独立实施后审查（REQUEST CHANGES→resolved）见私有执行记录。
> Authority: 本文不修改 ADR 或替 Owner 批准 OD；实现服从 AGENTS.md、ADR-0020、ADR-0027/0028。

配套整改稿：[可行性](../plans/2026-08-workbuddy-plugin-feasibility.md)、[能力与机会](../plans/2026-08-28-workbuddy-capability-map-for-pd.md)、[历史取证及当前验证动作](../plans/2026-08-28-workbuddy-adapter-verification.md)。三份原始资料保留，本文链接指向同一隔离 worktree 内的修订稿。

配套 PLAN 位于独立私有仓库 `docs/plans/2026-10-12-workbuddy-host-adapter-implementation-plan.md`；Zcode 启动指令位于该仓库 `docs/operator/2026-10-12-zcode-workbuddy-start.md`。人类 Owner 实际发送启动指令后，其中明确的 OD 授权可用于解除本文对应的待批准条件；探针、实现和测试仍须实际完成，不能以授权替代验证。

## 0. 开工结论与边界

方向成立：command hook + 薄适配器，复用共享治理运行时。v0.2 尚不足以冻结实现；需要先证明安装、工作区定位、事件协议、故障表现和后台推进能连成真实路径。

本稿将“实现了接口”与“用户能用”分开验收。允许准备隔离探针；Phase 1 必须在相关 OD 获批准、必需探针有证据、改动面落实后开始。0.5–1 天探针、3–5 天实现仅是旧估计，本稿不将其视为承诺。

采用四事件基线：PreToolUse、PostToolUse、SessionStart、UserPromptSubmit。成功事件不能替代失败事件；失败覆盖由 §7 的 P03 决定是否需要最小追加 PostToolUseFailure。无需因为新增宿主事件名就自动新增核心 HostEventKind。

首版目标是明确支持范围内的原则注入、工具治理、证据和 Owner 撤回。完整“纠正→提案→审批”自动学习另有发布门槛，不能由四个 hook 的存在推导成立。

## 1. 用户目标与可见结果

- G1：Owner 明确选择治理工作区后，项目 A/B 的 hook、控制台、后台任务读同一份授权状态，项目路径仍用于工具路径判定。
- G2：已批准原则能在下一次 UserPromptSubmit 进入输出通道；区分 prepared、submitted、宿主接收和最终上下文存在，不能用数量或 stdout 证明模型遵守。
- G3：真实禁止操作产生 deny 且目标文件未被更改；故障、unsupported、disabled 各自可见。按 §4.4 声明阻断边界。
- G4：真实工具失败通过受支持事件进入既有证据链；身份缺失时标注不能关联，不伪造精确的 turn/tool 关联。
- G5：关闭 flag、撤回原则、卸载均有恢复验证。撤回阻止后续注入/执行规则，不承诺从已有对话上下文抹除文本。

MVP 四问：不接入则 WorkBuddy 使用中缺少 PD 治理；通过 §8 的真实流程观察；通过选定工作区的 flag 和宿主禁用插件关闭；交付的是“知道是否生效、能撤回”，而非更多事件数量。

Excluded：MVP 不读取 transcript，不读 reasoning，不做 transcript ingestion；不做 modifiedInput、updatedToolOutput、压缩前证据抢救、IM 通知、SDK 或 PD 智能体向宿主子代理迁移。宿主原生记忆不由 PD 接管。OpenClaw/Codex 的旧语义必须回归验证，不能写“零风险”。

## 2. 当前代码现实与复用边界

以下为源码证据，不是 WorkBuddy 运行证明；定位使用符号而非文件总行数。

| 能力 | 当前生产入口 | 复用限制 |
|---|---|---|
| 宿主协议 | `packages/principles-core/src/host/host-adapter.ts` | WorkBuddy 为第二个 HostAdapter 接口实现、第三个宿主包；OpenClaw 不能被称为已实现该接口 |
| Codex 子进程范本 | `packages/codex-adapter/src/pd-hook.ts::processHookInvocation` | 参考接线，不复制全部失败语义；当前已区分 requestedCwd 与治理 workspace |
| 共享编排 | `packages/host-runtime/src/index.ts::createProductionHostRuntime` | 注入在 beforePromptBuild；hostKind 显式只接受 openclaw/codex 的生产分支也须扩展 |
| 工具闸门 | `packages/host-runtime/src/production-rulehost-gate.ts` | 接收 `rawPayload.toolInput={toolName,params}`；缺上下文的 v2 规则会暂停；多条故障返回 allow+warnings |
| 工具证据 | `packages/host-runtime/src/production-pain-evidence.ts` | 消费 context.toolInput/toolOutput；当前识别 error/exitCode 等，须匹配真实 WorkBuddy payload |
| 统一证据写入 | `packages/host-runtime/src/intervention-evidence-ingress.ts` | sourceKind 也是联合；不可只加 hostKind。证据写失败不得改变已计算工具决策 |
| 后台推进 | `packages/pd-cli/src/commands/codex-worker.ts`、`packages/pd-companion/src/lib/workspace-workers.ts` | 当前 worker 带 Codex 路径与语义；不能仅注册 workspace 就认定 WorkBuddy 队列会被处理 |
| 共享下游消费者 | `packages/host-runtime/src/internalization-consumer-cycle.ts` | 复用既有队列/lease/审批权威，不另起治理系统；上游诊断及调度仍需接线验证 |

不修改 HostAdapter 公开接口；允许扩展现有宿主联合、注册表和生产分支。不承诺 host-runtime 完全零改动，也不以“薄适配器”掩盖必须连接的生产路径。

## 3. 宿主证据等级

2026-08-28 的 5.3.14、第一轮报告记载的 5.8.1 均为版本化历史证据。事件名/字段名在引擎中命中只证明字符串存在；不能证明功能实现、实际触发、与 CLI 完全同源或跨宿主优越性。

本次读到了当前本机 `cli/dist/codebuddy-lite-wb.mjs` 路径，未完成宿主版本身份与真实 hook 运行核验。开发前重新采集 manifest、产品版本、引擎路径及哈希。官方网页本次访问失败；本稿协议依据本地 2026-10-12 官方快照，须由 P01–P05 实测复核，不伪装为实时官方确认。

保留 command 方案：历史 http 故障放行风险尚无闭环验证，且 PD 控制台无已核实的事件入口。command 也会在启动失败、超时、被杀时失去治理能力，不能把“选择 command”等同绝对 fail-closed。

## 4. 适配器契约

### 4.1 包、分发和治理目录

新建 `packages/workbuddy-adapter`，持有 decoder、encoder、host adapter、进程入口、工具语义和插件骨架；依赖现有 core、host-runtime、install-layout。hook 通过显式 node 命令启动 .cjs wrapper。

优先验证 wrapper 定位 installer 管理的 canonical runtime，不依赖开发仓库、全局 npm 包或任意 cwd。打包代码不意味着 SQLite 等原生依赖能成为零依赖单文件；必须验证 Windows/Node ABI 与运行产物。bundle 不决定数据库归属。

OD-07 待批准：推荐显式初始化的 WorkBuddy 专用用户级治理目录（候选 `~/.workbuddy/pd-workspace`），由既有 install-layout/manifest 记录；不得自动复用 Codex/OpenClaw 状态。该候选路径不是当前实现事实，P06 后冻结。若 Owner 选择项目级策略，应同步改 setup/status/worker/console 测试。

统一语义：projectDir=宿主 cwd；workspaceDir=治理状态目录。入口、setup、状态检查、卸载及 worker 使用同一解析策略。选中治理目录不可读或配置损坏时报告 degraded，不静默切换到另一份数据库；未初始化时报明确初始化动作。跨项目不能靠复制原则数据库实现。

### 4.2 事件与标准化

| 宿主事件 | 核心事件 | MVP 行为 |
|---|---|---|
| PreToolUse | before_tool_call | 工具闸门，保留宿主正常权限判断 |
| PostToolUse | after_tool_call | 记录真实工具结果；不假设包含失败调用 |
| UserPromptSubmit | before_prompt_build | 主注入通道，每轮读取当前激活状态 |
| SessionStart | session_start | 健康检查及状态提示；首版不重复注入原则正文 |
| PostToolUseFailure（条件项） | after_tool_call（若语义适配成立） | P03 证明失败未进入 PostToolUse 时，批准最小追加；否则发布范围明确不含失败采集 |

SessionStart 不复制成一次虚假的 before_prompt_build。恢复/压缩后未经新 prompt 的继续执行由 P04 单独核验；若无法覆盖，标 unsupported 或调整设计后重审，不能承诺“所有恢复时点自动补注”。

decoder 对输入使用 unknown 并检查自有字段：公共 session_id/cwd/hook_event_name；工具事件必须有非空 tool_name 和存在的 tool_input，post 必须有实际结果或失败结构；prompt 事件必须有 prompt。cwd 必须绝对。transcript_path 只验证为协议允许的类型，不打开文件。permission_mode 保留，未知值不授予额外权限。必填/可空要求由各事件 fixture 固定，不能从 InstructionsLoaded 的空路径推广到所有事件。

工具事件同时设置 `context.toolName/toolInput/toolOutput` 与 `rawPayload.toolInput={toolName,params:tool_input}`；逐工具核验成功/失败标准化，禁止把 `success:false` 因缺 exitCode 默认为成功。

generation_id 仅在宿主确实给出时映射 turnId；工具调用 ID 以 P03 证实的宿主字段为准。缺少可靠 ID 时不得用时间戳、参数哈希或固定占位伪造关联；只能记录可证明的 session 级事实，并声明细粒度关联 unsupported。幂等去重不得合并同参数的两次真实调用；同一事件重送不能重复计痛点。

### 4.3 输出

正常路径统一一份 JSON 输出。`hookSpecificOutput` 的字段按事件验证，首版仅需 hookEventName、permissionDecision（仅 deny）、permissionDecisionReason、additionalContext。中性结果省略 permissionDecision，绝不输出 allow 绕过宿主权限。deny 只用于 before_tool_call 且 reason 非空；additionalContext 仅用于通过探针的注入事件。

首版拒绝 modifiedInput、updatedToolOutput、ask；不得因历史文档白名单出现这些字段而启用。stdout 不混日志。exit 2 错误通道与成功 JSON 分开测试，以 P02 验证的最小形态为准；没有 stdout message 时 stderr 必须是有界、脱敏的用户可读说明。

### 4.4 失败策略（OD-01 修订）

不能照抄“永远 exit 0”的 Codex belt，也不能宣称“所有治理错误 exit 2”。P02 必须验证退出码和输出各自的效力，尤其 stdout 已关闭但宿主仍能取得退出码的情况。

| 条件 | 推荐策略与可声明边界 |
|---|---|
| flag-off | 中性 JSON + exit 0；不 dispatch、不读 transcript；允许定位并读取 flag 所需配置 |
| PreToolUse 已算出 deny，证据记录失败 | 保留 deny；单独报告证据降级，不把证据异常变成放行 |
| PreToolUse 已进入受支持治理路径，decode/dispatch/encoder/序列化失败 | 若 P02 证明有效则 exit 2 阻断；序列化失败不得一律改为 `{}`+exit 0 |
| runtime 返回 allow+warnings | 保留现有共享安全语义并报告 degraded；不得称健康或全 fail-closed，不靠字符串抓取把所有 warning 改 deny |
| v2 上下文缺失、隔离、全局暂停 | 明确 unsupported/suspended/paused；不是“没有规则命中”。不得加载上下文不完整的 v2 规则 |
| PostToolUse 错误 | 工具已运行，只能报告证据降级，不能说已阻止执行 |
| SessionStart 错误 | 状态提示，不声称阻断会话 |
| UserPromptSubmit 错误 | 推荐中性输出 + degraded，避免 exit 2 清除用户 prompt；若需阻断必须另获 Owner 同意并实测 |
| node/依赖缺失、启动失败、超时/被杀、非法 JSON 无法可信识别事件 | 明确宿主边界 Unknown/降级；不声称脚本必能输出 JSON 或自行阻断；安装前检验、故障探针及恢复指引覆盖 |

如果 Owner 要求共享 runtime 内所有治理故障也必须阻断，这是额外行为契约变更：需结构化结果分类、区分安全暂停和故障、单独评审及跨宿主回归。不得在本适配器用脆弱 warning 文本匹配暗中实现。

### 4.5 工具语义和能力声明

工具名与路径参数来自 P03 真实采样，复用 buildToolSemanticRegistry/host-tool-declaration；未知工具不臆造 Write/Bash 等价关系。语义声明、能力声明、当前健康是三个不同事实。

按 ADR-0027，分宿主/版本/通道记录 Supported、Unsupported、Unknown 和 proof reference。v2 RuleCode context provider 未接线时明确 unsupported，与 Codex 现状相同；不能宣称与 OpenClaw 功能全等。

### 4.6 证据与隐私

复用统一 intervention ingress、既有 pain 存储与脱敏入口，不直接写第二套证据账本。注入 prepared/submitted 不等于 delivered；编码 deny 不等于宿主执行了拦截。application 的证明边界、delivery 的确认强度及行为改善分别记录，不以 attempt-only 代替所有证据类型。

MVP 不读取 transcript：取消 v0.2 “仅内存读 reasoning 因不落盘无需 consent”的推论。后续确有需求时，限定宿主显式传入路径、权限、大小、时间、脱敏及用途，同意后再读取。禁止扫描会话目录猜 latest。

## 5. 必须覆盖的生产改动面

以下是发现的接线面，不声称穷尽；实施前用候选 diff 和消费者搜索再核对。

| 面 | 已核实入口 / 必查消费者 | 验收 |
|---|---|---|
| 新适配器 | workbuddy-adapter 包、插件 .cjs/hooks 清单 | 真实插件启动四事件 |
| 安装器与身份 | installers/index.ts、workbuddy-host-installer.ts、prompts.ts、install-layout/src/index.ts | 用户确认、初始化、manifest、detect、状态、卸载一致 |
| 配置 | feature-flag-contract.ts、feature-flag-lifecycle.ts、mvp-config.ts | 默认 off；显式启用成功；注册表和加载器一致 |
| 构建和交付 | 根 package.json build、installer package.json files、scripts/bundle-plugin.mjs、release locks/identity/校验清单 | 干净打包安装含适配器与原生依赖，不从源码目录补依赖 |
| 宿主归因 | trajectory-types.ts、intervention-evidence-normalizer.ts、host-runtime/index.ts、pain-signal-bridge.ts、prompt-injection-projection.ts、prompt-injection-event-evidence.ts | hostKind 无丢失/默认落成旧宿主 |
| 证据源 | intervention-evidence-ingress.ts sourceKind、对应 normalizer/store/read model | 原始源→归一化→存储→查询全链关联；兼容旧行 |
| 观察与操作 | console activations/approvals/evidence-outcomes、shared/prompt-injection-contract、UI api/validators/FocusPage | 真实 WorkBuddy 卡片、审批与撤回可用；仅改后端不足以宣布 UI 可延后 |
| 后台推进 | codex-worker.ts、codex-adapter 的 worker cycle、Companion workspace-workers、共享 consumer cycle | 独立 WorkBuddy 初始化环境中从真实证据推进提案；不借用 Codex flag/日志伪装归因 |
| channel | sqlite-activation-safety-store、activation-state-store、activation-compatibility-read-model | 继续 code_tool_hook；宿主差异由能力/语义承担，不新建 channel |

后台推进先做调用链调查，再决定最小接线。复用现有调度和消费者，不新建服务。若完整闭环尚不具备，交付名称只能是“执行已批准原则的适配器预览”，不得宣称 WorkBuddy 自动学习支持完成。

## 6. 安装、启用与恢复

host.workbuddy 为 quiet、默认 false；保留当前 sparse config 默认值机制。安装不等于启用，用户明确启用才写 override。OD-03 记录与 ADR-0020 旧显式持久化措辞的冲突；代码先例不自动废除 ADR。

写配置前展示目标宿主、插件路径、治理目录、写入范围及是否立即生效；沿用现有安装确认机制。enabledPlugins 只负责启用，是否另需 marketplace/本地路径注册由 P01 证明。解析失败停止写入；保留未知字段、其他插件和 hooks；备份、原子替换、失败回滚及重复安装均有测试。

不向用户全局 hooks 段重复注册插件 hook。detect 需区分安装存在、宿主发现、批准/启用、flag 状态、runtime 可达和上次健康。缺 Node/Git Bash 是修复指引，不是已安装成功。

卸载先停用本插件注册，再按宿主缓存规则提示重启；只删除可证明归本插件管理的文件。不删除治理数据库、他宿主 runtime、共享 worker 或其他插件。撤回/flag-off 测试覆盖当前会话和新会话；旧上下文仍残留时提示新会话恢复。

## 7. 分期与探针清单

### 7.1 Phase 0：当前宿主证据包

使用隔离 profile/settings 和无真实业务数据的测试项目；先证明隔离机制。若宿主不支持隔离，记录阻塞和最小必要设置变更，不能声称“未改全局配置”同时测试全局启用链。每项记录版本/引擎哈希、命令、fixture、预期、实际、副作用、恢复动作、PASS/FAIL/UNKNOWN。脱敏样本另保原始证据定位。

本阶段只用最小探针和合成数据验证宿主协议与定位方案；P04 用预置标记模拟注入内容更新，P06 用已存在的解析机制验证选址。真正审批/撤回、installer/console/worker 一致性在 Phase 1 重新通过生产入口验收，不能把模拟记录记为产品闭环通过。该区分避免要求“先有完整适配器才能完成开工前探针”的循环依赖。

| ID | 实验 | 通过条件 |
|---|---|---|
| P01 | 插件发现→注册→enabledPlugins→review→重启→更新→卸载 | 本地目录确被宿主加载；明确刷新时点，卸载后不再触发；恢复原设置 |
| P02 | 四事件退出码 0/2/1、deny、中性 JSON、坏 JSON、超时、依赖缺失、stdout 断管 | 逐事件观察实际动作；特别记录 prompt 是否丢失、工具是否真的未执行；日志不能充当副作用证明 |
| P03 | 成功写入、工具错误、非零退出、权限拒绝、重复调用/重送、并发 | 记录事件分流、真实工具名、输入输出、session/generation/tool IDs；明确失败能否映射 after_tool_call 及身份限制 |
| P04 | 每轮注入、新会话/恢复/压缩、审批后激活与撤回 | 不重复注入；next-turn 状态新鲜；正文与身份对齐；证明边界不足则 Unknown |
| P05 | 真实 .cjs 在 Git Bash 中启动、路径有空格/中文、Node 20/22 | 依赖/SQLite 可解析；无源码仓库依赖；当前机器未测版本不得记 PASS |
| P06 | 项目 A/B、治理目录坏配置/不可读、工作区切换 | projectDir 与 workspaceDir 不串；setup/hook/console/worker 一致；无回退写错库 |

第一轮原探针 10（updatedToolOutput）移出必需门槛，因首版明确禁用。SQLite 并发写入及完整 worker 行为放 Phase 1 生产实现验收，不能在仅有宿主探针时宣称已验证。

### 7.2 Phase 1：实施顺序

1. 先定 P01/P05/P06 和 OD，打通实际安装产物与身份定位。
2. codec→共享 runtime→事件/证据消费者；P03 若暴露失败缺口，先调整事件范围再编码。
3. flag/status/console 可见性与 worker 接线，按发布档位覆盖真实 Owner 流程。
4. 真实宿主验收、回归、升级/卸载/恢复，全部证据齐备才标支持。

每步交付对应可复跑测试和结果，不以包创建、编译成功或 fixtures 单测替代下一步的证据。

### 7.3 后续机会

先检验痛点是否真实存在再排期。PostToolUseFailure 属当前失败覆盖问题；PermissionDenied 仅是拒绝事实，不自动算 Owner 纠正。压缩前抢救需先证明既有持久化会丢证据。reasoning 文本不是模型真实因果过程的可靠证明。异步提醒需先有审批延迟证据；subagent/SDK 编排不属于本接入目标；改参需另评权限及误改风险。

## 8. 验收与发布档位

| 验收 | 必须经过的实际边界 |
|---|---|
| 协议/故障 | golden fixtures + spawn 真实入口；按事件断言退出码、消息及动作；已算 deny 不被证据故障吞掉 |
| 三路径 | 已批准测试原则→真实注入；受保护操作→未发生副作用；真实失败→正确身份的证据 |
| Owner 流程 | 经既有产品入口建立/审批/激活/撤回原则；控制台显示该工作区；禁止直接写 SQLite 假装闭环 |
| 完整学习档 | 真实纠正或工具失败→入队→后台消费→提案→人工审批→下一轮变化→撤回；记录未覆盖信号类别 |
| 并发 | 多个真实入口进程、数据库被锁、事件重送、同参数独立调用；报告丢失/重复/降级，证据失败不逆转 deny |
| 升级/发布 | 打包→隔离安装→无源码依赖启动；升级保持配置/数据；宿主版本变化重跑关键探针 |
| 回归 | Codex/OpenClaw 原事件、批准/撤回、失败策略、归因和已有数据读取保持原义 |

阶段结果分为：协议探针通过、适配器预览可用、完整治理闭环可用。代码构建、单测通过、宿主收到输出、实际遵守与持续行为改善是不同结论。

实施验收运行仓库当前 `verify:merge` 和 task-specific tests；失败逐项定位，不能预先把 Windows EBUSY 全部排除。本文是规格整改，没有运行 WorkBuddy probe，也没有实现或运行上述新增测试。

## 9. Owner 决策与风险

| ID | 推荐方案 | 未批准时的边界 |
|---|---|---|
| OD-01 | 采用 §4.4 有界策略；PreToolUse 可达故障阻断、共享降级显式展示 | 不冻结失败语义；若要求全链故障阻断，另评共享结果契约 |
| OD-02 | 四事件基线；P03 证据驱动决定最小追加失败事件 | 不宣称覆盖失败证据或全部学习信号 |
| OD-03 | 默认 sparse、显式启用写 override；以正式决策解决 ADR 旧措辞冲突 | 不自动宣告 ADR 已被替代 |
| OD-04 | 本机安装先行，P01 验证真实发现/同意/缓存链 | enabledPlugins 写成功不能作为安装成功 |
| OD-05 | 复用 code_tool_hook、扩展宿主能力/归因链 | 不新增 channel |
| OD-06 | modifiedInput 延后，首版 encoder 拒绝 | 不暗中启用 |
| OD-07（新增） | 显式 WorkBuddy 用户级治理目录，项目路径独立；P06 冻结路径 | 不自动借用其他宿主数据库 |
| OD-08（新增） | 发布档位分别验收；完整支持必须补后台闭环 | 只能发布已验证范围的预览 |

风险：静默升级使 fixtures 过期；宿主启动故障无法由未启动的脚本兜底；未知身份导致精确关联不足；v2 上下文能力不齐；旧对话残留原则无法靠撤回擦除。状态页和支持说明必须体现这些限制。

## 10. 架构及复杂度

延续 ADR-0020 的协议适配边界及 ADR-0027 的证据权威，不改变 ADR-0028 原则资产生命周期。跨宿主一致性针对同一授权意图和可证明结果，不能要求能力或失败机制假装完全相同。

| Complexity Delta（未来实现） | 结论 | 理由与验证/恢复 |
|---|---|---|
| 新 durable truth | NO | 原则、审批、激活仍归既有 store；检测跨工作区错读 |
| 新持久状态 | YES（既有 schema 的新宿主实例/配置） | 安装注册、语义声明、治理 workspace；不新增独立账本，卸载保留治理数据 |
| 新服务/后台进程种类 | NO（目标） | 复用既有调度和消费者；无法复用则重审，不偷偷新增 |
| 新公开抽象 | NO（目标） | 既有 HostAdapter；结果契约若需扩张须重新评审 |
| 新运行 flag | YES | host.workbuddy 独立关闭；注册表/lifecycle/off 测试 |
| 新跨包依赖 | YES | 新适配器→core/host-runtime/install-layout；产物启动验证，随宿主包卸载 |
| 新宿主行为 | YES | codec/注册/失败处理；真实 probe 与禁用恢复 |
| 新外部网络能力 | NO | 复用既有运行时配置，不增加通知/SDK 服务 |

## 11. 修订记录

v0.2 的“10 Major + 14 Minor 全部修订”仅代表作者已改文字，不代表整改效果已独立验收。第二轮对原 24 行逐项给出状态，见 private review。

v0.3.0：收窄故障阻断承诺并补 UserPromptSubmit；补治理目录与 worker；修正工具结果/身份契约；SessionStart 首版只做健康检查；补 sourceKind/生产分支/打包/UI 消费面；取消 MVP transcript 读取；按事件细化探针与真实 Owner 验收；机会改为有前提的假设；OD-01/02 更新并新增 OD-07/08；补全八项 Complexity Delta。

v0.3.1（2026-10-13，实施后）：新增 §12 实施状态与支持矩阵。OD-01..08 均按推荐方案执行（Owner 启动授权记录于私有 DECISIONS）；P01–P06 真实宿主探针全部完成（engine 2.161.0）；四事件基线维持（P03 实证常规失败已进 PostToolUse，PostToolUseFailure 未纳入首版 hooks 注册）；治理目录冻结 `~/.workbuddy/pd-workspace`。真实宿主治理主回路（注入/阻断/证据/撤回）E2E 6/6 PASS。

## 12. 实施状态与支持矩阵（2026-10-13，第二轮整改后 v0.3.2）

真实宿主：WorkBuddy Desktop 5.8.1 / 引擎 `codebuddy-lite-wb.mjs` v2.161.0（SHA-256 `1b1a01bc…`，哈希变更后关键协议探针已复跑并修正两项结论，见下）。隔离机制 `WORKBUDDY_CONFIG_DIR`+`CODEBUDDY_CONFIG_DIR`（P0 实证）。

| 能力 | 状态 | 证据 |
|---|---|---|
| 插件发现/注册/启用/卸载（Desktop marketplace 语义） | Supported | P01 9/9 + installer 28+4 测试；生效时点=新会话 |
| PreToolUse 治理阻断（deny/exit2/超时 fail-closed） | Supported | P02 矩阵 + E2E deny（文件未写+reason 达模型） |
| UserPromptSubmit 原则注入（additionalContext，逐轮新鲜） | Supported | P04 + E2E inject（请求体含原则文本） |
| PostToolUse 真实失败证据（is_error/exitCode 分流） | Supported | P03 + E2E evidence（trajectory 行） |
| PostToolUseFailure（thrown 错误，tool_error_code=2009 等） | Supported（五事件订阅；**准入受限**见下行） | 第二轮整改：订阅接入+decoder 归一化（error→failure envelope） |
| 失败信号准入（诊断队列） | **受限（政策边界）**：thrown 类失败 painScore=20（无 exitCode）< 70 地板 → evidence_only 不入队；is_error/exitCode 类（Bash 非零等）同理不计分；真实 LLM 诊断可将信号分类为 implementation 候选 → skill channel MVP-disabled → not_internalizable 终态 | PTUF 子代理测试+审查者独立实测（provider 健康时诊断 succeeded、链终于策略拒绝）——**Owner 决策点**：调整评分（tool_error_code 视同失败）或启用 skill channel，均影响全部宿主 |
| SessionStart 健康检查（静默，不注入正文） | Supported（保守：状态提示仅 stderr） | P04 通道验证；会话内不可见为已知限制 |
| Owner 审批/撤回（既有产品入口） | Supported | E2E withdraw（pd activation deactivate）+ BDD 撤回场景 |
| 跨项目共享治理工作区（projectDir/workspaceDir 分离） | Supported | P06 8/8 + BDD A/B 场景；Console/canary/交互提示全部路由治理目录（第二轮 P1 修复，产品级进程证据：console server `--workspace <governance>`） |
| flag-off 中性可观察（默认 off） | Supported | OD-03 + adapter/CLI 测试；合法 YAML 字段顺序下启停均生效（第二轮 §3 修复） |
| 完整自动学习（失败→入队→后台诊断→提案→审批→生效） | **受限**：链路全通（learn2 真实 LLM 诊断 succeeded；BDD 健康窗口实测到达 pending approval），但 implementation 类信号终止于 skill channel MVP-disabled（见上）；principle/rule 类信号可正常入队 | BDD 场景去 disabled，真实 LLM 门控 |
| modifiedInput / updatedToolOutput / ask / continue:false | Unsupported（首版 encoder 拒绝） | 输出白名单测试 |
| transcript/reasoning 读取 | Unsupported（MVP 排除） | 无此类代码路径 |
| resume/compact 后自动补注 | Unknown（宿主行为未验证） | 探针边界记录 |
| 独立 CLI 引擎（~/.codebuddy 根）注册 | Unsupported（本安装器面向 Desktop） | installer 边界注释 |
| 引擎自动发现 | **受限**：生产解析器只探 C 盘 Program Files；D 盘安装需 `PD_WORKBUDDY_ENGINE` env（direct-write fallback 注册后真实引擎可读取） | 第二轮审查 §3 |

并发/升级/发布档：真实多入口并发、幂等重放、同参数独立调用有进程级测试；`npm pack`→`build-release-asset` 戳版 payload→支持安装器→隔离 HOME→真实引擎发现全链 **8/8 PASS**。

本稿不构成 Owner 批准、部署授权或运行验收通过。原稿保留在用户提供的原目录，本稿在隔离 worktree 中供审阅。
