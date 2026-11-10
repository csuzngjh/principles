# PRI-1119 入口决策卡：交付验收的入口选择（普通聊天 vs PD 自有显式入口）

- 文档 ID：`pri-1119-entry-decision-20261110`；日期：2026-11-10；工单：PRI-1119（blockedBy PRI-1118 维持）
- 性质：**只读核查 + 离线裁决材料**。本轮宿主启动 0、模型调用 0、生产配置/治理写入 0、上游提交 0、合并 0。
- 基线：`origin/main` = `4000adc495a7c146f4d9282c114d0d936d8e196a`（#2457）；工作树 `ai/PRI-1119-entry-decision-card`。
- 待裁决问题：Owner 要在一个工作区明确触发一次交付验收——PD 选中一条当前已授权的原则、结果可核对、随时可停用。优先查已有 PD 自有入口能否做到；若不能，以 #2451 为基线交付上游立项建议。
- 前序：#2436（principleId 映射，已合并）、#2449（清单声明，已合并）、#2451（身份设计 v2，已合并）、#2448（阻断报告+操作页，仍 OPEN）、PRI-1152/#2432（隔离装配观察，已合并）。

## 1. 裁决

| 问题 | 裁决 |
|---|---|
| 入口 A：普通 OpenClaw 聊天 + 交付标记 | **BLOCKED**——唯一余留阻断 = 宿主 embedded 事件不带用户轮身份（上游缺口，#2451 已给最小设计） |
| 入口 B：PD 自有显式入口（Console/CLI/MCP/受控准入） | **无可用既有受支持入口**（§3 逐条核查） |
| 本轮整体 | **READY_FOR_OWNER_DECISION**——裁决对象 = 是否批准上游立项（§6 D1）；批准前维持 Native |

**推荐（一句话）**：批准基于 #2451 §3 的上游立项——宿主 embedded prompt-build 接线当前用户轮身份；PD 侧能力已全部就绪且已随 3.1.3 发布并安装到本机（§4），上游接线是唯一剩余缺口；在其落地前普通入口维持 Native，不要启用映射配置。

## 2. 两种入口的划分与判定标准

- **入口 A**：继续在现有 OpenClaw 普通聊天中使用交付标记。这是 Owner 的日常路径；交付验收最终必须发生在它上面——adaptive 选择的生产消费链只有一条：插件 `before_prompt_build`（`packages/openclaw-plugin/src/index.ts:482` 注册 `adaptivePriorityProvider` → `packages/openclaw-plugin/src/host-runtime/openclaw-host-runtime.ts:150-153` 桥接 → `packages/host-runtime/src/index.ts:352-356` 消费）。Console/CLI/MCP 均不在这条链上。
- **入口 B**：Owner 显式 PD 操作（现有 Console 或 CLI）发起一次验收。成立标准（沿用本轮任务门槛）：已有受支持入口能把「操作、输入、随后实际被装配的同一轮」可靠绑定。能记录一次点击或拿到一个内部 ID 仍不足——必须证明绑定到了实际装配的请求。

## 3. PD 自有入口逐一核查（今日代码取证）

**结论：没有。** 六个候选全部不成立，逐条证据如下。

| # | 候选入口 | 核查结果 | 证据 |
|---|---|---|---|
| B1 | PD Console | 治理 UI。路由清单 = activations/approvals/owner-decisions/examiner/update 等（`packages/pd-console/src/server/routes/` 共 29 个路由文件）；examiner 执行器明确「唯一可达模式 offline-stub」（`routes/examiner-executor.ts:1-9`）；全 Console 源码 `delivery-review`/`deliveryReview` = 0 命中；无任何路由驱动宿主 prompt 装配 | routes 目录清单 + rg 0 命中 |
| B2 | pd-cli | 命令面为治理/runtime/UAT/遥测等。`pd runtime activation dispatch` 是把激活种入工作区 state.db 的治理操作，不产生宿主轮；`pd version --delivery` 的 delivery-surfaces 是**发布交付面**检查（canonical runtime/扩展/Codex 插件版本一致性，`services/delivery-surfaces.ts:1-22`），与「交付验收」同名不同物；`delivery-review` = 0 命中 | `packages/pd-cli/src/commands/` 清单 + rg |
| B3 | pd-mcp-server | 单一 pd-recall 工具（疼痛召回查询）；不驱动装配 | `packages/pd-mcp-server/src/server.ts:132-136` |
| B4 | 受控准入（PD 自有，env `PD_AA_ADMISSION_FILE`） | 操作者冻结输入 + 一次性消费 + 仅钉死 `(artifactId, activationId)`；#2436 起 principleId 映射走受控准入直接拒绝（`index.ts:280-283` fail-closed）；SPEC §7（L171/L179）禁止借作普通入口。它能证明「钉死 ID 送达」（PRI-1152 假 provider 已证），不能证明「当前已授权原则的现场解析」（#2436 的核心语义），也非 Owner 日常入口 | `src/hooks/controlled-admission.ts:19,132`；`index.ts:270-306` |
| B5 | PRI-1152 隔离执行包 | #2432 合并内容 = 运行卡 + 结果文档（MERGED 2026-11-09）；`packages/` 全量检索 exec-pack/isolated-host 仅命中一个测试 fixture（`tests/hooks/isolated-host-presence-fixture.test.ts`），无产品入口代码；假 provider，真实模型拒绝路径未验证 | `gh pr view 2432` + rg |
| B6 | agentsapi harness | 事件可带身份（`currentUserMessage` + `idempotencyKey`），但为 OpenAI 托管 VM + API key 的另一执行模式，非 Owner 现有受支持路径（11-09 裁决，采用需另行授权与独立验证） | 阻断报告 §3；#2451 §1 |

**绑定缺口（B1–B3 共同，为什么「显式入口」不成立）**：Console 点击或 CLI 输出 ID 发生在 PD 自己的进程与存储里；宿主装配轮发生在 OpenClaw 进程的 prompt-build。两者之间没有既有机制把前者变成后者的事件身份——已装宿主 2026.11.1 的 embedded 事件只含 `{prompt, messages}`，没有任何字段可承载操作来源。任何「Console 发起验收」方案都要先解决与入口 A 相同的宿主身份缺口，再新增 Console→宿主触发通道（新代码 + 新契约），因此不成立为「已有入口」。

补充：#2448 的操作页（配置→触发→核对→停用）是**入口 A 的操作材料**——触发仍靠聊天轮首行标记，不构成入口 B。

## 4. 版本档位（今日实测）——阻断 2 已随「发布 + 安装」闭环

11-09 阻断报告的两个阻断中，**阻断 2（manifest 缺 `principleId`）已闭环**：修复已发布并安装到本机。逐档实测：

| 档位 | 版本 | 含 #2436 读取器/fail-closed | 含 #2449 清单声明 | 证据 |
|---|---|---|---|---|
| npm 已发布 `principles-disciple` | **3.1.3（latest）** | 是 | 是 | `npm view`（dist-tags latest=3.1.3，#2453 version packages） |
| 本机已装扩展 `~/.openclaw/extensions/principles-disciple` | **3.1.3**（package.json/manifest mtime 2026-11-09 22:53，dist 11-10 09:14） | 是：`dist/bundle.js` 命中 `principle_mapping_has_no_admission_identity` | 是：`openclaw.plugin.json:49` 声明 `principleId` | 文件读取 + rg |
| canonical runtime `~/.pd/runtime` | core **6.0.0** / host-runtime **3.1.0** / plugin 目录 3.1.1 | host-runtime `dist/active-principle-prompt.js` 命中 `resolveCurrentAuthorizedActivationByPrincipleId` 与 `additiveOnly`/`would_displace_native_assembly`（2 命中） | —（清单随扩展壳） | rg |
| 已装宿主 OpenClaw | **2026.11.1（不变）** | —（身份缺口未变） | — | 安装目录 package.json |
| main（未发布基线） | 插件 3.1.3 / core 6.0.0 / host-runtime 3.1.1 / pd-cli 1.168.1 / installer 1.148.4 | 是 | 是 | 各 package.json |
| 生产配置 | `~/.openclaw/openclaw.json` 与 `D:/.openclaw/workspace/.pd/config.yaml` 均无 `adaptiveActivation`（未启用，行为=纯 Native） | — | — | rg 0 命中 |

含义与操作口径：

1. **阻断 2 闭环**：当前产物上配置 `principleId` 映射不再打掉插件加载；#2448 操作页「启用前提①」（PD 版本含 #2436 且清单已声明）已满足。
2. **阻断 1 不变**：宿主仍为 #2451 逐行核对过的 2026.11.1（npm 2026.11.2 源提交未核对，维持未知）；上游接线不存在。
3. **此时启用映射「安全但无效」**：每轮在 `hasNativeIdentity=false` 分支 fail-closed 回 Native（带结构化 warn `principle_mapping_has_no_admission_identity`）。**因此现在不要启用**——等宿主身份落地后按操作页流程启用。
4. 观察项（不阻断本裁决）：canonical runtime 的 plugin 目录副本（3.1.1）落后于扩展壳（3.1.3），属不同发布面的同步时序现象；本裁决依赖的三项能力（清单声明 / 读取器+fail-closed / 解析器+additiveOnly 门）已逐项在装产物命中。验收运行时以实际日志为准。

## 5. 推荐方案：上游立项卡（基于 #2451，按今日事实更新）

四件待批准/待发生的事。**全部单独立项，本卡不启动任何一步**（含 AI 不提交上游代码/PR）：

| 环节 | 内容 | 依赖/授权 | 状态 |
|---|---|---|---|
| ① 接线工作（上游代码） | `attempt-prompt-build.ts:159` 调 `resolvePromptBuildHookResult` 时，从作用域内已有的 `attempt.userTurnTranscriptRecorder?.message` 取当前轮（与 L536 同源），以 harness 同名同型参数传入；helper 增可选 `currentUserMessage`/`currentUserMessageId`，复用 harness 展开规则，仅非空 string 写入、取不到不写（宁缺毋假）；不新增身份语义——身份即宿主准入写下的 `idempotencyKey`；**PD 侧零改动** | 上游提交通道（Owner 圈定；设计已备 = #2451 §3） | 待批准立项 |
| ② 外部评审与发版 | 上游维护者评审重点 = §7 的同轮归属与反例；随后官方发版 | 上游维护者；**上游等待时间未知（保留，不作承诺）** | 未开始 |
| ③ 本机升级 | 升级本机宿主到含接线的版本；确认 PD 3.1.3 链兼容 | Owner 授权（安装/生产变更） | 未开始 |
| ④ 验收 | 第一验证步 = `Object.keys(event)` 探针（一次隔离或受控回合，仅记录事件键集合与映射解析日志，确认身份在场）→ §7 有界运行（P1/P2 + N1–N6）→ 通过后起草 G1 正常入口验收卡；三元工具（dispatch_action/tool_describe/tool_search）拒绝路径专项核对作为验收卡前置（阻断报告 §7，PRI-1152 遗留） | 有界运行授权；G1/C04 门槛维持 | 未开始 |

未知项（如实保留，不补造）：retry/rebuild 是否复用同一 recorder 实例（#2451 §2⑥）；非聊天触发下 recorder 缺省值（⑦）；`excludeFromContext` 消息身份透出语义（⑧）；上游发版时间；npm 2026.11.2 是否已含接线。

PD 侧已就绪清单（无需再动）：读取/解析/additive-only 装配（#2436，已发布安装）、清单声明（#2449，已发布安装）、SDK 类型两字段（2026-11-05 身份审计）、身份缺失全链 fail-closed 回 Native（#2448 离线 A/B/C/C2 四臂复现）、停用 = 操作页既有路径（enabled=false / 删键 / expiresAt 自然过期）。

## 6. Owner 可直接选择的决定

**D1（推荐）：批准上游立项。** 批准①启动（在与已安装版本匹配的 OpenClaw 源线上准备接线变更，提交通道由 Owner 圈定）；②③④按序另行批准。后果：A 线唯一缺口进入外部通道；期间普通入口维持 Native、不启用映射。回滚：随时停——不启用映射即零行为差异；宿主侧按官方版本回退。

**D2：维持 Native，结束本轮。** 不启动上游；A 线挂起，待上游身份能力自然可用后复核。后果：G1 正常入口验收卡与试用卡继续不可申请；PRI-1118 依赖维持。回滚：无（零变更）。

**已排除（本轮核查后不再列为选项）**：PD 自有显式入口（§3：无既有受支持入口）；受控准入包装普通入口（SPEC §7 禁止）；agentsapi 切换（另一执行模式，11-09 裁决）；PD 侧伪造/推断身份（首行标记、prompt 哈希、sessionId、runId、最新轮序数均不得充当请求身份）。

## 7. 验收身份语义（环节④批准后执行；判据 = #2451 §4，此处为执行口径）

**通过判据**：每个被判为交付信号轮的 `before_prompt_build` 事件中，`currentUserMessage` 文本与 `currentUserMessageId` 属于**同一个当前接纳的用户轮**——文本等于该轮准入内容，ID 等于该轮准入写下的 `idempotencyKey`。仅「`Object.keys(event)` 出现字段」不构成通过。

| 编号 | 场景 | 必须观察到 |
|---|---|---|
| P1 | 第 1 轮输入 A（首行标记 + 正文 A） | 事件文本 = A 的准入内容；ID = A 的准入键；PD 解析到唯一授权激活 |
| P2 | 紧接第 2 轮输入 B（不同正文） | 事件文本 = B；ID = B 的准入键且 ≠ P1（不得沿用上一轮陈旧身份） |
| N1 | 无用户轮准入的运行（cron/自动化） | 事件不含身份字段；PD 不触发，回 Native |
| N2 | 心跳轮 | 同 N1 |
| N3 | 历史含首行标记的旧消息、当前轮无标记 | 身份只来自当前轮；不因历史标记触发 |
| N4 | 同一用户轮的重试 | ID 与文本保持该轮原值；不产生第二个「新轮」 |
| N5 | 同一用户轮的恢复/重建（restart-recovery） | 同 N4；无法证明复用同一准入则身份缺失并回 Native |
| N6 | 归属无法证明的任一情形 | 保留缺失（unknown），不补造；走原回退 |

补充约束：

- **身份替代品禁令**：首行标记、prompt 哈希、`sessionId`、`runId`、最新轮序数，单独或组合都不能充当本轮请求身份；B 线 PRI-1162（轮转）的轮次序数不能充当 A 线请求身份。
- **被排除正文**：宿主契约明确之前，`excludeFromContext` 消息不通过新增字段交给插件（#2451 §2⑧，设计取向=透出身份不改变上下文排除语义，待上游核对）。
- **证据要求**：事件侧只记录字段键、ID 与正文摘要指纹（不落原文）；准入侧引用宿主 transcript 该轮记录的 `idempotencyKey` 与内容指纹逐轮比对，一致才计通过；任一正例失败或任一反例出现身份即判失败。
- **归属不明回 Native**：与 #2436 既有语义一致（`principle resolution refused {reason}` / `would_displace_native_assembly` 等结构化回退，操作页 §4 可观测物）。

## 8. 不做与边界

- 不泛查宿主：上游核对范围维持 #2451 已核对的 embedded 入口与其引用行号；npm 2026.11.2 与未核对版本保留未知。
- 不启用任何配置、不改共享装配/策略文件、不写生产库。
- 不动 #2448/#2451 所属分支与其文件：版本档位变化以本卡 §4 为准；操作页「启用前提①已满足」的口径更新属 #2448 评审范围（建议 Owner 处置 #2448 时一并采纳）。
- 不覆盖 `LATEST.json` 与任何历史 aa-handoff 检查点；本轮只新增自己的检查点文件。
- G1/C04/G2 状态不动；PRI-1118（Todo）依赖维持；PRI-1119 工单状态随 PR 交付转 In Review，不随工程子单关闭。

## 9. 证据索引

| 类型 | 位置 |
|---|---|
| 基线 | `origin/main` = `4000adc495a7c146f4d9282c114d0d936d8e196a`（#2457）；本卡工作树 `ai/PRI-1119-entry-decision-card` |
| adaptive 唯一生产消费链 | `packages/openclaw-plugin/src/index.ts:250-365`（分流/拒绝/解析）、`:482`（注册）；`src/host-runtime/openclaw-host-runtime.ts:150-153`；`packages/host-runtime/src/index.ts:352-356` |
| PD 自有入口零命中 | `packages/pd-console/src/server/routes/`（29 路由，含 `examiner-executor.ts:1-9` offline-stub 声明）；`packages/pd-cli/src/commands/` 清单；`packages/pd-cli/src/services/delivery-surfaces.ts:1-22`；`packages/pd-mcp-server/src/server.ts:132-136`；两包 `delivery-review` rg 0 命中 |
| 受控准入 | `packages/openclaw-plugin/src/hooks/controlled-admission.ts:19,132`；SPEC v0.6 §7 L171/L179、G1 L190、C04 L203 |
| PRI-1152 残留 | `gh pr view 2432`（MERGED 2026-11-09，docs）；`packages/openclaw-plugin/tests/hooks/isolated-host-presence-fixture.test.ts`（仅测试 fixture） |
| 版本档位 | `npm view principles-disciple version` = 3.1.3；`~/.openclaw/extensions/principles-disciple/`（package.json 3.1.3、`openclaw.plugin.json:49`、`dist/bundle.js` 命中 fail-closed 串）；`~/.pd/runtime/{core,host-runtime,plugin}/package.json`（6.0.0 / 3.1.0 / 3.1.1）+ host-runtime `dist/active-principle-prompt.js` 命中解析器与 additiveOnly；已装 OpenClaw package.json = 2026.11.1；生产两配置 rg 0 命中 |
| 前序文档 | #2448 阻断报告与操作页（`D:\Code\_worktrees\principles\PRI-1119-aa-trial-prep\docs\implementation-reports\`）；#2451 身份设计 v2（main `docs/implementation-reports/PD-AA-PRI-1119-HOST-IDENTITY-UPSTREAM-DESIGN-20261109.md`）；11-07 入口可行性（main 同目录）；`aa-handoff/20261109T1342Z-zcode.{json,md}` |
| Linear | PRI-1119（In Progress→本轮 PR 后 In Review；blockedBy PRI-1118 维持）；附件 #2448/#2449/#2451/#2406/#2404 |
