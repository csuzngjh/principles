# PRI-1119 正常入口复核与阻断报告（A 线单工作区试用准备）

- 文档 ID：`pri-1119-normal-entry-blocker-20261109`
- 日期：2026-11-09；工单：PRI-1119（保持 In Review）；父单：PRI-1105；既有依赖：PRI-1118（Todo）
- 性质：**只读核查 + 离线复现 + 文档**。本轮宿主启动 0 次、模型调用 0 次、付费调用 0 次、生产库写入 0 次（生产 `state.db`/`config.yaml` 以快照副本核对）。未改共享装配或策略文件，未复用 PRI-1152 已执行包，未覆盖他人检查点与 `LATEST.json`。
- 基线：工作树 `ai/PRI-1119-aa-trial-prep`，base = `origin/main` = `8a791cfcfb34ec1a70dcdf392f4afc86c1a278c8`（含 #2436，merge `517e33885735edbe776a2a84438dde33135d6f0c`）。
- 规范：`docs/specs/PD Adaptive Activation SPEC v0.6.md`（§7 L171/L179、G1 L190、C04 L203）。

## 1. 裁决

**本轮准备材料：READY_FOR_REVIEW。正常入口（生产选定 embedded 路径）：BLOCKED —— 两个独立阻断，均不属于「标记写不进模板」。**

对任务的四个步骤逐一回答：

| 步骤 | 结论 |
|---|---|
| 1 核对真实入口 | 已核对并复现。**首行标记可写进普通用户请求且插件能读到；但生产宿主在 before_prompt_build 事件上不交出所需请求身份，principleId 映射按 #2436 fail-closed 拒绝，永远回退 Native。** 另发现第二阻断：manifest 配置 schema 缺 `principleId`，配置该映射会导致 PD 插件整体加载失败 |
| 2 操作页 | 已交付：`docs/implementation-reports/PD-AA-PRI-1119-A-LINE-OPERATIONS-PAGE-20261109.md`（样例字段以实际 schema/读取器为准；阻断修复前标注为不可启用） |
| 3 两份决定 | 正常入口验收卡与试用卡**当前不可申请**；两卡的前提清单与骨架见 §10，G1/C04 缺口逐项见 §8；三元工具核对结果见 §7（部分确认，真实模型步骤继续阻断） |
| 4 可裁决 | 交付具体阻断（§3/§4）+ 最小修复建议与成本（§9）+ 离线复现（§5），无需再做广泛宿主取证 |

## 2. 版本档位（今日实测）

| 档位 | 版本 | 是否含 #2436（principleId 映射） | 证据 |
|---|---|---|---|
| `origin/main`（未发布） | 插件 `3.1.2`（#2445 bump） | **是**（`517e33885` 为祖先） | `git merge-base --is-ancestor`；`openclaw.plugin.json` version |
| npm 已发布 `principles-disciple` | `3.1.1`（tag v3.1.1 = `1dd3b8e87`，#2434） | **否**（合并早于 #2436） | `npm view`；tag 祖先检查 |
| 本机已安装插件 `~/.openclaw/extensions/principles-disciple` | `3.0.2`（mtime 2026-11-08 17:59） | **否** | package.json |
| 已安装宿主 OpenClaw | `2026.11.1 (4ffdd20)` | —（宿主与 PD 版本独立） | `openclaw --version` |

含义：**当前不存在任何可安装版本支持 principleId 映射**；main 上的 3.1.2 是第一个含读取器支持的版本，但其 manifest schema 仍缺 `principleId`（§4）。

## 3. 阻断 1（宿主上游）：生产 embedded 路径不提供消息身份

**链路（main 代码，生产 wiring 已核实）**：插件注册 `before_prompt_build`（`packages/openclaw-plugin/src/index.ts:523-526`）→ 共享 host-runtime 以 `adaptivePriorityProvider` 调用 `resolveAdaptivePriorityForHook`（`index.ts:482-486`）。

**决定逻辑（`index.ts:266-310`）**：需要 `workspaceDir` + `sessionId` + 用户交互 trigger；映射解析成功后按 `hasNativeIdentity = currentUserMessageId || requestId` 分流：

- **无原生身份**（生产 embedded 常态）：principleId 映射直接拒绝——`[PD:AA] controlled admission refused: {"reason":"principle_mapping_has_no_admission_identity"}`（`index.ts:280-283`，#2436 fail-closed）；钉死映射仅在受控准入已配置时可走（操作者冻结输入，非普通任务）。
- **有原生身份**：才检查 `currentUserMessage` 首行标记（`index.ts:308-310`），随后 principleId 映射经 `resolveCurrentAuthorizedActivationByPrincipleId` 现场解析（`index.ts:318-356`，`additiveOnly:true`）。

**宿主侧证据（已安装 2026.11.1 bundle，今日逐行核对）**：

1. `dist/context-engine-maintenance-B3wgO8Sx.mjs:326-329`：生产 embedded 路径（经 `attempt-system-prompt-prepare-F34qAuO4.mjs` → `attempt-execution.runtime`）分发的 before_prompt_build 事件**只含 `{ prompt, messages }`**。
2. 带身份的是另一条路径：`dist/agentsapi-attempt-CUirEvwK.mjs:212` 传 `currentUserMessage: admittedMessage ?? params.prompt`，由 `agent-harness-runtime-D36YOAmh.mjs:320-331` 组装 `currentUserMessage` 文本与 `currentUserMessageId`（取 `params.currentUserMessageId ?? currentUserMessage.idempotencyKey`）。该路径仅被 agentsapi 扩展（`agentsapi-harness`/`extensions/agentsapi`）引用，**不是生产网关聊天选定模式**。
3. 与 2026-11-05 审计（`docs/implementation-reports/PD-AA-OPENCLAW-MESSAGE-IDENTITY-AUDIT.md`）一致：内部存在身份（`idempotencyKey: sourceId`，gateway 用户轮录制时写入），harness 路径已透出，**selected embedded 路径没有**。11-07 入口可行性文档引用的插件注释「Embedded OpenClaw supplies no native message identity」（`index.ts:273`）对现装宿主仍然成立，但其当时未对宿主 bundle 取证；本报告补齐了这一环。

**结论**：标记能否写进模板不是缺口；缺口是宿主事件不带身份。标记检查在 `hasNativeIdentity` 分支内（`index.ts:310`），无身份时根本不会执行到标记比对。

## 4. 阻断 2（PD 仓内）：manifest 配置 schema 缺 `principleId`

#2436 给配置读取器加了 `principleId` 身份（`packages/openclaw-plugin/src/hooks/adaptive-activation-config.ts:18-28,64-68`），但 `packages/openclaw-plugin/openclaw.plugin.json` 的 `configSchema.properties.adaptiveActivation` **没有加 `principleId` 属性**，且该对象 `additionalProperties: false`（#2436 未触及该文件；`git show 517e33885 --stat` 无 plugin.json）。

**后果（宿主加载期，已安装 2026.11.1 bundle 与官方源码双重核实）**：

1. 宿主按 manifest schema 校验插件配置：`dist/loader-shared-Cz3CKegE.mjs:285-300`（`validatePluginConfig` → `validatePluginSchemaValue`），校验失败即 `err(errors)`。
2. 加载路径对校验失败的处理是**插件整体加载失败**：官方源码 `src/plugins/loader-runtime-candidate.ts:283-294`——`pushPluginLoadError("invalid config: …"); return;`；已安装 bundle 存在同机制（`failurePhase="validation"`、`maybeThrowOnPluginLoadError`、`PluginLoadFailureError` 导出）。
3. 即：在当前 main 的产物上写入 principleId 映射，**不只是映射无效，而是 PD 插件全部 hook 消失**（含 Native 注入、治理观测）。这远劣于静默回退，且会在试用启用瞬间打掉整条链。
4. 仓库无 configSchema↔读取器一致性测试（`packages/openclaw-plugin/tests/` 全量检索 `configSchema` = 0 命中），该缺口无守卫可拦。

候选原则映射值本身已验证真实可用（见 §5 C 臂）；阻断 2 是纯声明遗漏，修复成本极小（§9）。

## 5. 离线复现（最小反例，零宿主/零模型/零生产写入）

脚本：工作树 `.tmp/pri-1119/counterexample.mjs`；驱动真实 `resolveAdaptivePriorityForHook`（built 插件 dist 导出）+ 真实共享装配上游解析；工作区指向生产快照副本 `.tmp/pri-1119/ws-snapshot/`（state.db + config.yaml，复制于 2026-11-09 19:44 本地）。映射目标 = 今日快照实测的唯一授权原则（§6）。

| 臂 | 事件形状 | 映射 | 结果 |
|---|---|---|---|
| **A 最小反例** | `{prompt, messages}`（embedded 生产形状，标记在 prompt 首行） | `principleId` | `undefined`（→ Native）；结构化 warn `principle_mapping_has_no_admission_identity` |
| B | 同 A | 钉死 `(artifactId, activationId)`，未配置受控准入 | `undefined`（→ Native，静默） |
| **C 阳性对照** | A + `currentUserMessage`（首行标记）+ `currentUserMessageId` | `principleId` | **返回 priority**：解析到快照库唯一授权激活，`additiveOnly:true`，有 `hookInvocationId` |
| C2 阳性对照 | A + `currentUserMessage` + `requestId`（另一合法身份来源） | `principleId` | 同 C |

判读：marker + 身份 + 映射 → 解析 → additive-only 优先级，整链在 PD 侧连通；唯一缺失输入是宿主身份（阻断 1）。**受控准入的旧通过结果（PRI-1152）不能填补此缺口**：其 manifest 契约绑定精确 `(artifactId, activationId)` 身份、输入为操作者冻结正文 + 一次性消费（`controlled-admission.ts`、`index.ts:276-283`），#2436 明确拒绝 principleId 走受控准入；且它不是普通真实任务入口（SPEC §7 L171/L179 禁止借用）。

## 6. 候选工作区 / 宿主模式 / 原则（今日只读核对）

| 项 | 值 | 核对方式 |
|---|---|---|
| 工作区 | `D:\.openclaw\workspace`（生产，gateway `local`，agent `main`；11-07 文档确认的生产模式，本轮未变更） | `~/.openclaw/openclaw.json`；快照复制 |
| 工作区配置 | `features.prompt.enabled=true`；**无 `adaptiveActivation` 键**（grep 0 命中） | 快照 `config.yaml` |
| 目标原则 principleId | `产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性` | 真实 `PromptActivationReader` 跑快照（built dist） |
| artifactId | `pi-art-scribe-21bc6e76-ed9c-45a9-afef-eeeae6c30831-prompt-run_scribe-21bc6e76-ed9c-45a9-afef-eeeae6c30831-prompt_2` | 同上 |
| activationId | `act_prompt_产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性` | 同上 |
| 授权/唯一性 | `authority: owner`、`approvedBy: operator`；18 条 active prompt 中该 principleId **恰好 1 条**（满足解析器「至多一条」要求） | 同上，`warnings: []` |
| 生产插件配置落点 | `~/.openclaw/openclaw.json` → `plugins.entries["principles-disciple"].config`（现值 `{enabled:true, hooks:{allowConversationAccess:true}}`） | 生产配置只读 |

宿主/插件版本、工作区、原则均未冻结为试用承诺——正式冻结仍按操作页「待决策项」走 Owner 决定。

## 7. 三元工具（dispatch_action / tool_describe / tool_search）——部分确认

- **暴露已证实**：PRI-1152 隔离运行实证 `tools.deny=["*"]` 下请求仍携带 3 个工具定义；静态核对已安装 bundle 一致（`tool-surface-bridge-D03z9gNz.mjs:1515` 控制工具常驻目录；`tool-search-D-pqChBc.mjs:177-179` 名称常量）。
- **派发路径已定位**：属宿主 code-mode 桥接控制工具（`dispatch_action` 执行延迟工具，`tool-search` 上下文 L599）。
- **拒绝路径未确认**：未能从静态证据闭合「真实模型调用后是否执行/是否被 tools.deny 或后台 allowlist 拒绝、PD before_tool_call 是否可见」。按任务约束，**依赖真实模型的步骤不启动**；这与 PRI-1152 遗留项一致（其报告 §7「任何真实模型运行卡必须单独处理这一点」）。若未来验收卡涉及真实模型，卡内必须先含该项的专项核对或隔离验证步骤。

## 8. G1/C04 缺口逐项（在 11-07 缺口清单上更新）

| ID | 缺口 | 本轮更新 |
|---|---|---|
| G-B | 无最终请求正文证据（C04 confirmed 前提） | **仍阻断**。#2432 的 presence 观察边界是 `post_assembly_system_prompt_via_llm_input`，不证明请求正文；DES 的 `pre_submission_request_object` 方案需宿主改动，未实施 |
| **G-F（新）** | **宿主身份缺口**（本报告阻断 1） | 正常入口 principleId 映射不可触发；C04 正例（同请求正文比对）无从谈起 |
| **G-S（新）** | **manifest schema 缺 principleId**（本报告阻断 2） | PD 仓内一行修复；未修复前禁止任何环境配置 principleId（会打掉整条插件） |
| G-A | 目标注入比例 97/238 仅日志范围 | 维持 11-07 结论：待场景样本核实，非阻断 |
| G-C | 无请求级身份 → 顺序证据仅同机时钟 | 并入 G-F；修复后需重核 |
| G-D | 版本能力差 | 更新：npm 3.1.1/安装 3.0.2 均无 #2436；需发版+安装授权 |
| G-E | 普通路径无最终重验 | 维持（adaptive 分支已有 revalidate；普通路径按 Native 语义不重验，非本轮范围） |
| 三元工具 | 真实模型行为未知 | §7：拒绝路径未确认，真实模型步骤保持阻断 |

## 9. 最小修复建议与成本

**修复 2（PD 仓内，先做，成本极小）**：`openclaw.plugin.json` 的 `configSchema.properties.adaptiveActivation.properties` 增加

```json
"principleId": { "type": "string", "minLength": 1 }
```

配套：一条 manifest↔读取器一致性测试（读取器认识的键 ⊆ schema 声明的键，防复发）+ `@principles/openclaw-plugin` changeset（patch）。建议作为 PRI-1140 收尾小 PR 单独交付；**其本身不改变任何生产行为**（读取器早已支持，schema 补声明只是让宿主放行）。本轮授权仅文档，未编码。

**修复 1（宿主上游，真正解阻断，成本中）**：让生产 embedded 生产者（`resolvePromptBuildHookResult` 所在 helper）从当前 turn recorder/admission 读取 `currentUserMessage` 文本与稳定 `currentUserMessageId`（`idempotencyKey`），随事件传出——与 harness 路径（`agent-harness-runtime` L320-331）同构。配套负例：无 admission（心跳/注入轮）、重建/重试、历史消息、跨会话等不得出现身份。前提：在与已安装版本匹配的 OpenClaw 源码上做（2026-11-05 审计已明确不可用旧 checkout 冒充），随后走官方发版 + PD 安装升级授权。修复落地后 PD 侧无需再改（SDK 类型已跟进，读取/解析路径已就绪并有测试）。

**两修复都落地后的第一验证步（廉价、有界）**：一次隔离或受控宿主回合，仅记录 hook 事件的实际键集合（`Object.keys(event)`）与映射解析日志，确认身份在场后，才进入正常入口验收卡。此前任何卡片都不应承诺触发。

**已否决的替代路径**：以受控准入包装普通入口（SPEC 禁止 + 一次性消费 + 固定 ID）；切换 agentsapi 模式（非 Owner 实际工作模式，SPEC §7 选宿主条件不满足）；PD 侧伪造身份（rc-6/身份语义，禁止）。

## 10. 两份决定：当前不可申请，前提与骨架

**正常入口验收卡（G1/C04 有界运行）——不可申请**，前提：修复 2 合并发版并安装 + 修复 1 落地且宿主升级 + 第一验证步确认身份在场 + 三元工具拒绝路径专项核对。届时卡需包含：版本/输入/预期触发与回退、证据源（同请求正文独立比对 + 行动顺序）、预算、超时、停止与清理（骨架沿用 PRI-1152 卡 §6–§11 的账本与判定结构）。

**单工作区试用卡（G2 观察窗口）——不可申请**，前提：G1 正例达成（SPEC §8：G2 需 G1 达成并取得限域试用授权）+ Owner 明确授权工作区/起止/负责人/原则版本/采集项/停用方式。采集聚焦：触发、遗漏、回退、额外开销、使用摩擦（O 的识别入口仍需按 G2 预注册草稿的入口要求补齐）。

两卡在前提达成前不出现在任何授权请求里；本报告不预填虚构日期或 ID。

## 11. 待 Owner 决策项

1. 是否批准「修复 2」作为 PRI-1140 收尾小 PR（PD 仓内，schema + parity 测试 + changeset）。
2. 是否立项「修复 1」上游宿主变更（需与已安装版本匹配的源码与发版路径；11-05 审计的修复落点仍有效）。
3. PRI-1118（真实宿主事前送达闭环）在阻断 1/2 修复前维持 Todo；PRI-1119 维持 In Review 与对 PRI-1118 的依赖。
4. 操作页中的工作区/窗口/负责人等字段仍为待决策，禁止以本报告 §6 的核对值冒充冻结。

## 12. 证据索引与边界声明

| 类型 | 位置 |
|---|---|
| 代码 | `packages/openclaw-plugin/src/index.ts:266-356`（分流与拒绝）、`src/hooks/adaptive-activation-config.ts`（读取器）、`openclaw.plugin.json` configSchema、`packages/host-runtime/src/active-principle-prompt.ts:245-283,670-676`（解析器/additiveOnly） |
| 已安装宿主 bundle | `%APPDATA%/npm/node_modules/openclaw/dist/`：`context-engine-maintenance-B3wgO8Sx.mjs:326`、`agent-harness-runtime-D36YOAmh.mjs:320-331`、`agentsapi-attempt-CUirEvwK.mjs:212`、`loader-shared-Cz3CKegE.mjs:285-300`、`tool-surface-bridge-D03z9gNz.mjs:1515`、`tool-search-D-pqChBc.mjs:177-179` |
| 官方源码 | `D:/Code/openclaw`（2026-09-07 checkout，仅作 loader 逻辑参照；结论以已安装 2026.11.1 bundle 为准） |
| 离线复现 | 工作树 `.tmp/pri-1119/counterexample.mjs`（A/B/C/C2 结果见 §5）、`.tmp/pri-1119/verify-target.mjs`、快照 `.tmp/pri-1119/ws-snapshot/` |
| 前序文档 | `PD-AA-OPENCLAW-MESSAGE-IDENTITY-AUDIT.md`（11-05）、`PD-AA-PRI-1119-ENTRY-FEASIBILITY-20261107.md`、`pri-1152-isolated-host-run-result-20261109.md` |

边界：本轮 0 宿主启动、0 模型/付费调用、0 生产写入（生产库仅快照复制）；未改共享装配/策略文件；未复用 PRI-1152 执行包；未更新 G1/C04/G2 状态（无对应证据与批准）；未覆盖他人 aa-handoff 检查点与 `LATEST.json`。残留未知：宿主对插件配置校验失败在不同宿主版本上的精确表现（拒载 vs 降级）未做运行验证——因此操作页明确禁止在修复 2 前配置 principleId。
