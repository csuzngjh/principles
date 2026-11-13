# PRI-1116 · C01–C09 验收矩阵（证据整理）

状态：`EVIDENCE SNAPSHOT / DESIGN-ONLY ROUND`。本文只整理 SPEC v0.6 §8.1 的原始验收要求与**既有**证据，不新增测试平台、不改通过条件、不重跑全仓。

> 2026-11-13 更新：Codex `exec` 追加路径的 C04/G1 逐项证据见
> `PD-AA-C04-G1-CODEX-APPEND-ACCEPTANCE-20261113.md`。本矩阵 C01–C09 历史行保持原样，不改写。

基线：`origin/main` = `a902255e1`（2026-11-06 实时核实）。C01–C09 的“已通过”均为**组件级历史记录**（见 `PD-AA-v0.6-IMPLEMENTATION-STATUS.md` 第 13–20 行：插件 10 文件 163 项、host-runtime 7 文件 75 项、core 6 文件 55 项、Node 工具 8 文件 66 项，0 失败/0 跳过，共 360 项不重叠案例；提交 `7c84f20f1`、`01bed8750`、`3e81b1115`、`8b8160ca2`、`679f6833a` 及后续调用 ID 贯穿修订）。**本轮只改文档，未重跑这些套件，因此不声称当前 HEAD 已重新执行通过。**

状态词：

- **已通过（组件级）**：既有测试在列出的 commit 上执行通过；不代表当前 HEAD、安装启用或真实宿主。
- **未运行**：该验收要求的运行条件尚不存在或本轮未执行。
- **不适用**：只在 SPEC 指定的其他阶段（G2/G3、真实行为）成立，G1 不以它阻断。
- **待确认**：证据只能支持 `unknown`/`partial`，或需 Owner 决定。
- **失败**：有明确反例或断言失败；本矩阵暂未发现。

---

## 汇总

| ID | 原要求（SPEC §8.1 原文） | 证据层级 | 状态 | 剩余最小动作 | 负责 |
|---|---|---|---|---|---|
| C01 | “匹配时只选择配置的有效目标；正常任务按原 Native 路径处理，不凭一般关键词或回调推定风险。” | 单元 + 跨模块（真实本地/共享入口） | 已通过（组件级） | 隔离宿主正例尚未运行 | PRI-1118 |
| C02 | “不把旧正文带入目标请求，不修改任何治理记录；可追溯拒绝或回退原因。” | 单元 + 跨模块（选择→最终提交边界） | 已通过（组件级） | 在隔离宿主复现一次撤销/变更回退 | PRI-1118 |
| C03 | “已有内容只出现一次；不可安全装配时无本轮增量。记录最终文本差异及未送达，不挤掉必需约束。” | 单元 + 跨模块（packer/预算/大小守卫） | 已通过（组件级） | 真实宿主最终 payload 仍需独立取证 | PRI-1118 / C04 |
| C04 | “独立比对同一请求正文、配置身份和行动顺序；前者可取 confirmed/timely，后者只取 returned，缺证保留未知。” | 夹具（verifier） | 未运行 + 待确认 | 正例请求需一次隔离宿主；embedded 无原生 requestId，请求级关联预期保持 `unknown` | PRI-1118 |
| C05 | “不补记为及时；能通过任务产物抽查漏触发机会。未能建立完整 T 时只报可观测部分。” | 单元（读模型） | 未运行（真实行为） | 需 G2 真实任务抽样；不阻断 G1 接线 | PRI-1119 / G2 |
| C06 | “无跨界、无重复投递或虚构合并；不同请求不能借用旧确认。指纹不可得记录 partial/unknown，配置变化后旧成功不能充当新配置证据。” | 单元 + 跨模块（journal/配置身份） | 已通过（组件级） | 隔离宿主重放/并发/超时未运行；一次性准入待实现 | PRI-1118 |
| C07 | “增量失败不阻塞正常任务；没有返回、提交或 kill 的独立证据不能伪造成功或阻塞。撤掉映射后原 Native 仍可工作。” | 单元 + 跨模块（截止/回退/停用） | 已通过（组件级） | 宿主侧依赖失败与软截止未注入验证 | PRI-1118 |
| C08 | “Examiner 能区分行动、最终结果和不必要代价。行为独立证据缺失时不以自述或 receipt 补齐。” | 夹具 + 评价器既有能力 | 未运行（真实行为） | 可用已知例验证评分区分能力；非 G1 接线阻断项 | PRI-1116 / Examiner |
| C09 | “仅在批准的使用范围和期限运行；不自动开启 Shadow/Live，不向未授权目的地发送上下文。” | 单元 + 跨模块（配置边界） | 已通过（组件级） | 宿主模式切换与外发审计未运行 | PRI-1118（环境边界） |

---

## C01 · 场景匹配与正常 Native

**原要求**：匹配时只选择配置的有效目标；正常任务按原 Native 路径处理，不凭一般关键词或回调推定风险。

**当前实现入口**：

- `packages/openclaw-plugin/src/hooks/adaptive-activation-config.ts` @`7c84f20f1`：显式启用、workspace 精确匹配、`expiresAt`、单条 mapping。
- `packages/principles-core/src/runtime-v2/activation/adaptive-principle-intervention.ts` @`3e81b1115`：场景判定；只有真实消息身份**或**受控准入两种来源；首行标记 `[PD-AA:delivery-review:v1]`。
- `packages/openclaw-plugin/src/index.ts` 第 361–388 行：标记 + 身份门。

**既有测试/日志及 commit**：

- `packages/openclaw-plugin/tests/hooks/runtime-v2-prompt-activation.test.ts` @`440aa6354`：`does not interpret a quoted scene marker as operator admission`；`preserves Native when identity unavailable`（第 344 行起）。
- `packages/principles-core/src/runtime-v2/activation/__tests__/adaptive-principle-intervention.test.ts` @`3e81b1115`：`never triggers from missing message identity or quoted/history marker`。
- `packages/openclaw-plugin/tests/hooks/adaptive-activation-config.test.ts` @`7c84f20f1`：2 项配置边界。

**证据层级**：单元 + 跨模块（真实本地 prompt 入口与共享 provider 组装）。

**状态**：已通过（组件级）。正常任务 Native 有不依赖标记的反例；没有“普通关键词/回调即触发”的实现路径。

**剩余最小动作**：在隔离宿主用一次正例证明同一配置在真实 `before_prompt_build` 下命中；本轮不运行。负责 PRI-1118。

---

## C02 · 未授权、Artifact 变更/撤销、临交付前失效

**原要求**：不把旧正文带入目标请求，不修改任何治理记录；可追溯拒绝或回退原因。

**当前实现入口**：

- `packages/host-runtime/src/adaptive-principle-revalidation.ts` @`595d4e41d`：身份/正文/摘要/authority/approvedBy 重验；Reader 错误 fail closed。
- `packages/openclaw-plugin/src/hooks/prompt.ts`：返回边界只读重验（1052–1096 行附近）；失败恢复 Native 并记录原因。
- Runtime V2 Reader：唯一治理授权权威；不写回。

**既有测试/日志及 commit**：

- `packages/host-runtime/tests/adaptive-principle-revalidation.test.ts` @`4a7c584dd`：6 项，覆盖 Artifact 变更、撤销、取消、Reader 错误。
- `runtime-v2-prompt-activation.test.ts` @`440aa6354`：`removes a shared target whose artifact changes between selection and final commit`。
- core 回执/解析契约测试 @`3e81b1115`：旧 revision 复活反例已修。

**证据层级**：单元 + 跨模块（共享选择 → 最终提交边界）。

**状态**：已通过（组件级）。没有任何测试或日志显示治理记录被修改。

**剩余最小动作**：隔离宿主中在“选择后、提交前”撤销目标，观察一次回退与 journal 原因。负责 PRI-1118。

---

## C03 · Native 同文、预算不足、必需约束

**原要求**：已有内容只出现一次；不可安全装配时无本轮增量。记录最终文本差异及未送达，不挤掉必需约束。

**当前实现入口**：

- `packages/host-runtime/src/active-principle-prompt.ts` / `packages/host-runtime/src/index.ts` 第 235 起：Native 正文复用、selection budget、packer。
- core `prepareAdaptiveIntervention`：精确目标正文、必需约束、最终正文完整性。
- `packages/openclaw-plugin/src/hooks/prompt.ts` 最终预算检查（1052–1096 行附近）。

**既有测试/日志及 commit**：

- `packages/host-runtime/tests/adaptive-principle-priority-prompt.test.ts` @`3e81b1115`：6 项（Native 同文、预算公平、拒绝挤占）。
- core `adaptive-principle-intervention.test.ts` @`3e81b1115` 第 9/10/12/13 项：Native 复用、必需约束、预算。
- `packages/openclaw-plugin/tests/hooks/prompt-size-guard.test.ts` @`0d47c7de3`：大小守卫。
- 状态记录：`PD-AA-v0.6-IMPLEMENTATION-STATUS.md` 第 7、13 行。

**证据层级**：单元 + 跨模块（真实 packer/prompt hook）。

**状态**：已通过（组件级）。测试断言“出现一次”与“不可装配时无增量”。

**剩余最小动作**：真实宿主最终 payload 的独立比对归 C04；本轮不运行。负责 PRI-1118/C04。

---

## C04 · 正常入口与真实请求、只有返回的对照

**原要求**：独立比对同一请求正文、配置身份和行动顺序；前者可取 confirmed/timely，后者只取 returned，缺证保留未知。

**当前实现入口**：

- `scripts/dev/principle-learning-lab/verify-adaptive-delivery.mjs` @`60ac56546`：独立请求正文比对（`requestCapture`、`directiveBodies`、信任清单 pin）。
- `scripts/dev/principle-learning-lab/probe-local-transport.mjs`：本地单请求传输探针。
- `prompt.ts` 返回边界：记录 `returned/prepared`，不升级 `confirmed`。

**既有测试/日志及 commit**：

- `verify-adaptive-delivery.test.mjs`（fixture）：验证器自身契约。
- `probe-local-transport.mjs` 历史记录：1 个本地 HTTP 请求、stub 回复；宿主回调未出现（`PD-AA-v0.6-IMPLEMENTATION-STATUS.md` 第 19 行）；该记录不能证明送达。
- embedded producer（`attempt-system-prompt-prepare-F34qAuO4.mjs` 第 3943–3946 行）没有原生 `requestId`，因此“同一请求”无法绑定到 receipt。

**证据层级**：夹具；无隔离宿主正例。

**状态**：**未运行**（真实请求正例）；**待确认**（请求级关联预期保持 `unknown`）。

**剩余最小动作**：PRI-1118 在隔离宿主完成一次正例，由假 provider 记录 `endpointRequestId/bodySha256/userMessageSha256`，同时明确 `requestAssociation=unknown`。不得把端点序号冒充宿主 requestId。

---

## C05 · 动作已发生、无信号或未捕获

**原要求**：不补记为及时；能通过任务产物抽查漏触发机会。未能建立完整 T 时只报可观测部分。

**当前实现入口**：

- `packages/host-runtime/src/adaptive-behavior-linkage.ts` @`fda71df92`：`journalRangeComplete`（834–842）与 `classifyAssociation`（844–893）。
- `pd activation link`（读 journal + trajectory）。
- coverage 统计（`PD-AA-v0.6-IMPLEMENTATION-STATUS.md` 第 19 行）。

**既有测试/日志及 commit**：

- `packages/host-runtime/tests/adaptive-behavior-linkage.test.ts` @`fda71df92`：O1–O5；跨 session、配置变化、重复 open/terminal、行为来源截断。
- PR #2380 合并 `fda71df92`：单会话行为来源截断不再冒充完整。

**证据层级**：单元（读模型）；真实任务抽样未运行。

**状态**：**未运行（真实行为）**；G1 不以 C05 阻断。

**剩余最小动作**：G2 真实任务中抽查交付清单的全部验收项，估计 T/V/O/D，并单列未捕获。负责 PRI-1119 / G2；本矩阵只记录边界。

---

## C06 · 重放、并发、profile/配置或请求身份变化

**原要求**：无跨界、无重复投递或虚构合并；不同请求不能借用旧确认。指纹不可得记录 partial/unknown，配置变化后旧成功不能充当新配置证据。

**当前实现入口**：

- `packages/host-runtime/src/adaptive-behavior-linkage.ts` @`fda71df92`：身份无效/配置变化/重复事件 → `unknown`/`ambiguous`/`conflict`。
- EventLog `adaptive_delivery` journal（open/closed，复用现有 EventLog）。
- `scripts/dev/principle-learning-lab/lib/adaptive/adaptive-config-identity.test.mjs` @`60ac56546`：配置身份。
- 一次性准入：**尚未实现**，设计见 `PD-AA-CONTROLLED-ADMISSION-WIRING-DESIGN-20261106.md` §3.5。

**既有测试/日志及 commit**：

- `packages/host-runtime/tests/adaptive-journal-reconciliation.test.ts` @`440aa6354`。
- `adaptive-behavior-linkage.test.ts` @`fda71df92`：跨 session、配置 A→B、重复 open/terminal、requestId 借用。
- `adaptive-config-identity.test.mjs` @`60ac56546`。

**证据层级**：单元 + 跨模块（journal/读模型）。

**状态**：已通过（组件级）；**隔离宿主重放/并发/超时未运行**。

**剩余最小动作**：PRI-1118 实现准入后，用同一准入重复回调、同输入新 run、跨 session、超时、工具后第二请求五个用例验证拒绝。负责 PRI-1118。

---

## C07 · 依赖失败、软截止、证据缺失与恢复

**原要求**：增量失败不阻塞正常任务；没有返回、提交或 kill 的独立证据不能伪造成功或阻塞。撤掉映射后原 Native 仍可工作。

**当前实现入口**：

- core `prepareAdaptiveIntervention`：soft deadline、`AbortSignal.timeout`、依赖失败返回 `degraded/timeout/unavailable`。
- `packages/openclaw-plugin/src/hooks/prompt.ts`：返回边界重验、失败恢复 Native、`shouldUseSharedHostRuntime` 停用路径。
- `prompt-size-guard.test.ts` @`0d47c7de3`：不可安全装配即无增量。

**既有测试/日志及 commit**：

- core `adaptive-principle-intervention.test.ts` @`3e81b1115` 第 1/4/6/7 项：超时、依赖失败、Native 保留。
- `runtime-v2-prompt-activation.test.ts` @`440aa6354`：`restores the native prompt after mapping is disabled between selection and final commit`。
- `production-host-runtime.test.ts` @`679f6833a`：生产 dispatch 回退。

**证据层级**：单元 + 跨模块（真实 dispatch）。

**状态**：已通过（组件级）；宿主侧依赖失败/软截止未注入运行。

**剩余最小动作**：隔离宿主中不制造故障（预算内不注入），保留 `unknown`；如需故障注入，另开有界批准。负责 PRI-1118。

---

## C08 · 一次符合原则的行为、一次无效/有害遵循

**原要求**：Examiner 能区分行动、最终结果和不必要代价。行为独立证据缺失时不以自述或 receipt 补齐。

**当前实现入口**：

- Examiner v0.10.1（SPEC 引用；隔离、基线、配对、评价既有能力）。
- `docs/specs/PD-AA-EVAL-CASES-DRAFT-v0.1.md` @`ed761d631`：CEB-003P 等已知例。

**既有测试/日志及 commit**：

- 评价器既有套件（不在本矩阵重复计数）；本票未新增测试。评估用例草案 @`ed761d631`。

**证据层级**：夹具 + 评价器既有能力；真实行为未运行。

**状态**：**未运行（真实行为）**；**待确认**（评分区分能力）。非 G1 接线阻断项。

**剩余最小动作**：用已知例验证“行动/结果/代价”三列可区分；在 G2 有真实案例后由 Examiner 出判断。负责 PRI-1116 / Examiner。

---

## C09 · 限域授权、到期、外发与模式切换

**原要求**：仅在批准的使用范围和期限运行；不自动开启 Shadow/Live，不向未授权目的地发送上下文。

**当前实现入口**：

- `adaptive-activation-config.ts` @`7c84f20f1`：`enabled`、workspace 精确匹配、`expiresAt`。
- `index.ts` 第 147–159、503–506 行：`abstraction_layer_v1` 默认关闭；共享/本地区分。
- 设计 §4：隔离 workspace/config/state；仅 loopback 假 provider；不写生产配置。

**既有测试/日志及 commit**：

- `adaptive-activation-config.test.ts` @`7c84f20f1`：2 项（启用、workspace/到期边界）。
- `runtime-v2-prompt-activation.test.ts` @`440aa6354`：无映射/停用恢复 Native。
- `PD-AA-v0.6-IMPLEMENTATION-STATUS.md` 第 12 行：配置默认关闭，未写入安装/生产配置。

**证据层级**：单元 + 跨模块（配置/路由）。

**状态**：已通过（组件级）；**宿主模式切换与外发审计未运行**。

**剩余最小动作**：PRI-1118 P0 预检记录实际配置哈希与 provider 唯一性；不做 Shadow/Live 切换。负责 PRI-1118。

---

## 最小反例（代码/接线缺陷，单列，不混入未来研究）

| ID | 缺陷/风险 | 最小反例 | 归属 |
|---|---|---|---|
| D1 | embedded 不提供原生消息身份 | 把 producer 的 `{prompt, messages}` 直接传给 `prepareAdaptiveIntervention`，无 `controlledAdmission` → `missing_message_identity`，保持 Native | 已知能力边界；PRI-1118 用准入解决 |
| D2 | 共享 provider 在无 `currentUserMessageId` 时提前 `undefined` | `adaptivePriorityProvider` 收到 `{prompt:"[PD-AA:delivery-review:v1] ..."}` 但无 own `currentUserMessageId` → 不选目标；已有测试 `preserves Native when identity unavailable` 正是该行为 | PRI-1118 必须新增准入分支，不能只改 `prompt.ts` |
| D3 | 解析后正文是派生串，不能证明原始提交字节 | 输入带 Feishu wrapper 时，`resolveCurrentUserMessage` 返回内层文本；若实现用该值取哈希，会误把拼接/包装后的 prompt 当作当前正文 | 设计 §3.4.2 用**原始 `event.prompt` 哈希** + 解析逐字节一致消除；实现必须遵守 |
| D4 | core 有准入校验但无人调用 | 插件源码无 `controlledAdmission` 传入（`prompt.ts` 第 773 行参数表） | PRI-1118 接线缺口（Connection Before Creation） |
| D5 | embedded 无原生 `requestId` | 无法把 receipt 绑定到端点收到的同一请求；`verify-adaptive-delivery` 的 `requestId` pin 不可满足 | 不是本轮要修的缺陷；请求级关联保持 `unknown` |

---

## 不阻断本轮的未来方向（不是验收项）

- 切换到 harness 原生身份入口（需 Owner 改变研究目标，见设计 §3.6.6）；
- 多宿主/跨模型全面适配；
- Model-assisted Shadow / Live；
- 长期行为内化与撤除实验；
- C05 的完整 T/V/O/D 抽样（属 G2）。

以上均不作为 G1 接线或本矩阵的阻断条件。

---

## 本轮执行边界

- 未运行任何测试套件；状态引用既有记录及其 commit，不声称当前 HEAD 重跑通过。
- 未启动宿主、未调用模型、未安装插件、未修改生产配置、未发版。
- 未改写 SPEC 通过条件；未删除/弱化既有测试。
