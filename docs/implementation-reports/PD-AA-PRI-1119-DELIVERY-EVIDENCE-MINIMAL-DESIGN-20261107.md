# PRI-1119 交付证据最小设计（wire 边界存在性核验）v1.1

- 文档 ID：`pd-aa-pri-1119-delivery-evidence-minimal-design-20261107`
- 版本：v1.2（2026-11-07；**v1.1 Tier B 已获 Owner 书面批准**（实施卡 L1–L6），附加四项验收条件随本版同步入文；实现进行中）
- 状态：**待 Owner 书面明确批准后方可编码**（本指令只授权调查与设计修订，不替代设计批准）
- v1.0 → v1.1 差异表见 §10；v1.0 全文见 git 历史（PR #2404 commit `8f20b9f98`）

## 0. 目标与不目标（v1.1 不变，补充）

**目标**：让目标正文在**最终提交给 SDK 的请求对象**中的存在性可判定（ responses 与 completions 两条路径），输出取证事实。
**不目标（不变）**：不落盘正文；不自动升级 D/confirmed/timely；不新建服务/平台/数据库；不做机会识别；不做 G1/C04 签收；不做 G2 试用。

## 1. 已核实的源码与版本锚点（契约 7）

| 项 | 已核实事实 | 证据 |
|---|---|---|
| 审计对象 | 已安装 `openclaw@2026.11.1`（AppData npm 全局目录）dist bundle；行号引用均针对该产物 | 只读 grep/sed |
| 可构建源码 | `D:/Code/openclaw` 仓库存在 `origin/release/2026.11.1` 分支（branch head `d10d3d9a642`，`package.json version=2026.11.1`）；`openclaw --version` 的构建戳 `4ffdd2047d1` 是该分支祖先（落后 3 commits） | `git cat-file` / `git merge-base --is-ancestor` / `git show` |
| 源码↔bundle 一致性 | 抽查 `packages/ai/src/transports/openai-responses-prompt-observer-internal.ts`（release/2026.11.1）与 bundle 逻辑逐段一致（readFinalResponsesPrompt/createResponsesPromptEgressObserver） | 逐行比对 |
| **gitSha 不可靠** | trace metadata 的 `harness.gitSha=2282d26` 与 2026.10.5 时代**完全相同**（跨发布不更新的陈旧戳）；不可用作提交锚。可靠锚 = 版本串 `2026.11.1` + 安装产物内容哈希 + release 分支 | trace metadata 对比 |
| 实施检出方式 | 从 `D:/Code/openclaw` 以 `git worktree add` 建独立工作树检出到 release/2026.11.1（**不改动 Owner 主检出工作树、不改全局安装目录、不直接修补 dist**） | — |
| 构建入口 | 根 `pnpm build:runtime`（`scripts/build-all.mts runtime`，tsdown）；`@openclaw/ai` 产物 `dist/internal/openai.mjs`（正是 runner 导入的 `@openclaw/ai/internal/openai`）；测试走根 vitest（`scripts/run-vitest.mjs` + `test/vitest/*` 配置） | package.json scripts |
| 交付路径 | openclaw 仓库分支/PR（独立于 PD 仓库）；通过官方安装器升级生效；**禁止**直接改安装目录 | — |
| 覆盖范围声明 | 行号级审计结论属于**已安装 2026.11.1**；实现针对 release/2026.11.1 源码。若 Owner 升级宿主至 2026.11.2+，实现需按新分支重验（rebase + 重跑 fixture），不默认覆盖 | — |

## 2. 观测边界（契约 1 修订）

**准确称谓**：检查点观测的是**传输提交前请求对象**（pre-submission request object），**不是**实际网络请求。

### 2.1 responses 路径已核实链（2026.11.1 源码）

```
send-loop 每次尝试:
  observePrompt(attempt.request, {egress, payloadVariant})   ← 检查点（本次改动）
  → encodeBody(attempt.request)                              ← prepareModelRequestBody
       = JSON.stringify(request) → Blob（body 覆盖）          ← ①序列化
  → client.responses.create(request, {body, headers, ...})    ← SDK 拿 Blob 原样发送（body 覆盖后 SDK 不再自行序列化）
```

- `provider-prompt-serialization.ts#prepareProviderPrompt(encode=true)` 的 `encoded` 即 `serializeModelRequestBody(payload)` —— **编码字节 = 观测对象的 JSON.stringify**，观测对象与提交字节同一（① 已核实）。
- 仍**不能证明**：TLS/代理层改动；provider 侧实际收到的字节；provider 是否按收到的内容处理（响应只证明请求被接受，不证明内容完整送达模型上下文）。这些列为边界外事实。

### 2.2 completions 路径已核实链

```
buildOpenAICompletionsRequest → params
  → options.onPayload(params, model)   ← ⚠️ 可整体替换 params（已核实）
  → encodeBody(params)                  ← JSON.stringify(params) → Blob（body 覆盖）
  → client.chat.completions.create(params, requestOptions)
```

- 检查点必须放在 **onPayload 替换之后、encodeBody 之前**（观察最终 params），并在 encodeBody 内复用同一次 stringify（避免重复序列化成本与偏差）。
- direct 模式 `maxRetries: 0`（已核实）；managed 模式 SDK 层重试配置待实现时按 `buildOpenAISdkRequestOptions` 实测——SDK 层重试**不会**再次经过本检查点，事件只记首次提交尝试，SDK 重试如实列为边界外。

### 2.3 结论表述（用于所有报告）

> 事件记录的是"提交前请求对象中目标正文的存在性"。它证明"本次提交所用的请求对象包含/不包含目标正文"；它不证明"网络对端收到了同样字节"或"模型上下文实际包含该正文"。后者需要 provider 侧证据，超出本轮范围。

## 3. 正文匹配（契约 2 修订）

- **删除 v1.0 的 `systemRegionSha256 ≠ assembledBlockSha256 → 漂移` 判据**（整区域哈希不等不能定位漂移内容，且子块哈希与整区域哈希本就不应相等——判据无效）。
- **匹配规则**：对期望集中每条 `{activationId, revision, bodyText}`，在**全部**合法角色文本中做**完整正文**精确子串检查：
  - responses：`request.instructions`（若为 string）+ `request.input[]` 中**每一条** `role ∈ {system, developer}` 的消息（`content` 为 string 时全量；为部件数组时仅拼接 `type="input_text"` 部件——与宿主现有读取语义一致）；
  - completions：`params.messages[]` 中**每一条** `role === "system"`（如宿主扩展 developer 角色则一并纳入）；
  - **不做跨消息拼接**：正文横跨两条消息 → 按缺失记录（避免拼接制造虚假命中）；
  - 命中语义：完整 `bodyText` 原文出现在**单条**合法角色消息文本内 → 该 activation 记 `full_hit`（并记录命中的消息序号与角色）；
- **完整正文 vs 实际装配文本的区别（Owner 附加条件 2）**：期望集条目携带 `bodyComplete`（PD 在尺寸守卫后判定该 activation 的**完整原则正文**是否原样存活于实际装配文本）。`bodyComplete=false`（装配被截断，期望集只含残片）→ 该条结果强制 `unknown`，`reason=assembly_truncated`，**禁止用残片做包含检查取得 `full_hit`**；
  - 命中出现在 user/tool 角色消息 → `presentInWrongRole=true`，**不改变** `full_hit=false`；
  - 匹配用原文精确子串（`String.prototype.includes`），无正则、无归一化、无模糊匹配。

## 4. 有界检查（契约 3 修订）

全部上限为**实现期常量（配置可调），历史观测最大值（18 条 / ≈2.2KiB）只作为背景参考，不充当强制上限**：

| 上限 | 初始值（实现卡批准时可调） | 超限行为 |
|---|---|---|
| 期望集条数 | 64 | 整次检查 → `unknown`，`reason=expectations_over_limit`（记录实际条数） |
| 单条 bodyText 长度 | 64 KiB | 该条 → `unknown`，`reason=body_over_limit`（记录实际长度；**禁止截断后把前缀命中算作完整命中**） |
| 扫描区域总字节（单消息文本） | 8 MiB | 该消息跳过并在结果中记 `skipped_over_limit`；若因此无法完整检查 → `unknown`，`reason=scan_region_over_limit` |
| 合法角色消息数 | 512 | 超出部分记 `skipped_over_limit`；同上降级 |
| **累计扫描字节（整次检查，覆盖合法+错误角色全部被扫文本）** | **32 MiB** | **一旦超过：整次检查 → `unknown`，`reason=cumulative_scan_over_limit`（记录实际累计值）。绝不在超限后输出 `checked_missing`（Owner 附加条件 1）** |

- 结果资格（契约 4 修订）：每条 activation 只有三种互斥结果：
  - `full_hit` —— 完整检查执行且完整正文命中；
  - `checked_missing` —— 完整检查执行且完整正文缺失；
  - `unknown` —— 无法完整检查（`limit_exceeded` / `unparseable_content` / `check_failed` / 期望缺失），必须带 `reason` 与实际值（rc-3/rc-9：不得静默跳过）。
- **事件存在 ≠ 命中；发送尝试 ≠ 送达**（送达=provider 接受+模型上下文包含，本轮不判定）。本轮只输出取证事实，不自动升级 D/confirmed/timely。

## 5. 期望集接线（契约 5 修订：'PD 零改动'假设**不成立**）

### 5.1 已核实的真实链

| 环节 | 位置（release/2026.11.1 源码 / PD 仓库） | 已核实事实 |
|---|---|---|
| 生产者 | PD `packages/openclaw-plugin/src/hooks/prompt.ts`（before_prompt_build 处理器） | 计算 `prependSystemContext`（含 adaptive 前缀）；**期望集必须在此冻结，且在 `truncateInjectionToBudget` 尺寸守卫之后**——守卫可能截断注入块，冻结对象必须是实际返回的文本 |
| 接口 | PD `packages/openclaw-plugin/src/openclaw-sdk.ts:209` `PluginHookBeforePromptBuildResult`；宿主 `src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts:80-124` | **两侧都只有 5 个字段**（systemPrompt/prependContext/appendContext/prependSystemContext/appendSystemContext [+toolsAllow]）；宿主用显式白名单提取，**插件返回的额外字段被丢弃** |
| 立即调用者 | 宿主 hook 分发（attempt-prompt-helpers 内 `logHookFailure("before_prompt_build")` 包装；PD 侧注册于 `packages/openclaw-plugin/src/index.ts:460-462`） | 每 prompt 构建（每次逻辑模型请求）调用一次 |
| 应用点 | `wrapPluginSystemContextSection(...)` → 合入 systemPrompt → `context.systemPrompt` → `createResponsesPromptEgressObserver(options, context.systemPrompt)` | 观察点已有 assembledPrompt 可对照 |
| 消费者（现状） | 仅 egress 长度/全等观测 | 无 per-activation 通道 |

### 5.2 最小改动（推翻"PD 零改动"，给出精确增量）

1. **宿主**：`PluginHookBeforePromptBuildResult` 契约增加可选结构化字段 `injectedExpectations?: FrozenExpectation[]`（`{activationId, revision, bodyText, bodyChars}`，仅内存）；白名单与字段拷贝处同步放行该字段；
2. **宿主**：attempt 层把冻结期望集随本次 streamFn 调用传入检查点——载体用 `@openclaw/ai` 现有 **symbol-keyed options carrier 模式**（与 `modelRequestBodyState`/`responsesRequestLifecycle` 同型，`@openclaw/ai/internal/openai` 导出），每次调用设置、检查点读取；精确落点（`attempt-stream-settle.ts` / `attempt-stream.ts`，wrapper 应用点 `attempt-stream-settle.ts:522` 已核实）在实现期对齐；
3. **PD**：hook 返回值在尺寸守卫后附带 `injectedExpectations`（本轮实际装配的 activation 列表），并同步本地类型镜像；
4. **禁止**：检查点事后读数据库最新内容替代冻结快照；不新增平行数据库/全局最新值缓存/第二套授权机制（期望集只活在单次调用的内存生命周期内）。

### 5.3 回退档（若 Owner 否决契约改动）

**Tier A（宿主侧独立完成，无 PD 改动）**：检查点利用已核实的 `context.systemPrompt`（= assembledPrompt），对**整段 PD 注入区块**（`wrapPluginSystemContextSection` 包装后的 prependSystemContext 全文，装配时已知）做块级 full-hit 检查。能证明"PD 装配块整体进入请求对象"，**不能**给出 activationId/revision 粒度（宿主无法拆解区块内容）。Tier B（上表 1–3）才满足契约 5 的 per-activation 冻结来源要求。**默认实现 Tier B**；Tier A 仅作为被否决后的降级选项，由 Owner 明确选择。

## 6. 请求归属（契约 6 修订）

三层身份（全部已核实）：

| 层 | 定义 | 载体 | 隔离证据 |
|---|---|---|---|
| run | 一次 agent run | `getProviderPromptState(runId)` 全局 Map（key=runId）+ `clearProviderPromptState(runId)` 清理；新 runId 无基线 | `provider-prompt-state.ts:47-59` |
| 逻辑模型请求 | streamFn 的一次调用 | wrapper 闭包（`responsesPromptObserver.set`、`attempts` 计数、`promptObservation` 均为**每次调用新建**） | bundle 内 wrapper 结构逐行核实 |
| 传输尝试 | send-loop 内每次 `observePrompt` 调用（含 service-tier/encrypted-content/previous_response_id 各类重试） | 事件逐尝试落盘 | `openai-responses-shared.ts` send-loop |

- **payloadVariant 不是唯一尝试身份**（同一 kind 可重复出现）：检查点事件增加 wrapper 闭包内单调 `attemptIndex`（在 observePrompt 触发时递增——时序上先于 encodeBody 的 `++attempts`，故必须独立计数）。
- **期望集隔离**：期望集经 options carrier 只绑定本次逻辑模型请求；并发 run → runId 不同 + 状态 Map 分键 + closure 分离，**无串用路径**；同 run 第二次模型请求 → 新 wrapper 闭包 + 新 carrier；失败/重试 → 同闭包内同期望集逐尝试重检（期望集不变，结果逐尝试记录）。清理：carrier 随调用对象生命周期结束；run 级 `clearProviderPromptState` 已有。
- completions：每次调用一次 encode+create（已核实无内层 attempt loop）；SDK 层重试（若有）不经检查点，如实列为边界外。
- **身份复用（Owner 附加条件 3）**：事件优先复用既有身份字段——run=`runId`（信封既有）、逻辑模型请求=`requestIndex`（wrapper 闭包次序，同 run 内单调）、传输尝试=`attemptIndex`+`payloadVariant`；测试必须覆盖同 run 多请求（requestIndex 递增且期望集各自独立）、并发 run（互不串用）、重试（attemptIndex 递增、逐尝试独立结果）。

## 7. 检查器纯函数与事件（接口冻结，实现按此）

```ts
type FrozenExpectation = { activationId: string; revision: number|string; bodyText: string; bodyChars: number };
type PresenceOutcome = "full_hit" | "checked_missing" | "unknown";
type PresenceResult = {
  activationId: string; revision: number|string;
  outcome: PresenceOutcome; reason?: string;         // unknown 必带
  hitMessageIndex?: number; hitRole?: string;        // full_hit 必带
  presentInWrongRole?: boolean; actualBodyChars?: number;
};
type PresenceCheck = {
  checked: boolean; reason?: string;                  // false=disabled/empty_expectations
  attemptIndex: number; boundary: "pre_submission_request_object";
  results: PresenceResult[];
  limitsExceeded?: { expectations?: number; bodyChars?: number; scanBytes?: number; messages?: number };
  checkFailedReason?: string;                         // exception:<class> 等
};
```

挂载：responses → 现有 `provider.prompt.observed` 事件新增 `presenceCheck` 字段；completions → **同名事件**（信封已含 `modelApi/provider/modelId`，检查点新增于 `openai-completions-transport.ts` encode 前）。事件经现有轨迹 sanitize（逐字符串 32768 上限——presenceCheck 各字段均远小于上限）。

## 8. 测试与测量矩阵（实现验收）

**功能（先红后绿，全部离线 fixture，不发真实请求）**：完整命中 / 完整检查后缺失 / 错误角色命中不计 full_hit / 多条合法角色消息+结构化 input_text 部件 / 只有正文前缀→`checked_missing`（禁止算命中）/ body 超限→`unknown:body_over_limit` / 期望集超限→`unknown` / 不可解析 content→`unknown:unparseable_content` / revision 变化→按冻结文本判定且记录 revision / 错 run 期望集→检查拒绝执行并记原因 / 同 run 两次模型请求→两个独立事件+attemptIndex 归零 / 重试：前次失败后内容变化→逐尝试独立结果 / PD 片段存在但提交对象缺失→`checked_missing` / 检查器抛异常→请求照发+`unknown:check_failed` / 编码后字节==JSON.stringify(观测对象)（防 SDK 转换偏差）/ completions 与 responses 双路径同矩阵。

**测量（必须给出实测数字，不得沿用 v1.0 的"<1ms / ≤1.5KiB"宣称）**：
- 耗时：vitest bench 或 `performance.now()` 环绕，代表性 fixture（system 区 53–65k 字符 × 18 期望 × 2.2KiB body）+ 边界 fixture（64×64KiB 超限），各 ≥30 次取中位/p95；
- 事件字节：**按 UTF-8 字节实测（Owner 附加条件 4）**——`Buffer.byteLength(JSON.stringify(event.data.presenceCheck), "utf8")`（18 结果满载与空载两档；presenceCheck 净增量单独给出）；
- 报告表：`测量方法/输入/次数/中位/p95/字节数`，写入实现 PR。

## 9. 成本、验收、回滚（v1.1 修订）

- 成本：openclaw 仓库改动 ≈ 传输检查点 2 处 + carrier + 白名单/类型 + wrapper 传参（数百行内）；PD 仓库 1 个 hook 字段 + 类型镜像；无 I/O、无网络、无新存储。
- 验收：§8 全绿 + 双路径事件字段核对 + 实测表；**真实宿主验收另行运行卡（§11），离线通过不关闭真实验收**。
- 回滚：openclaw 侧 revert 检查点/carrier/白名单三处；PD 侧 revert hook 字段（旧宿主忽略未知字段吗？**不成立**——旧宿主白名单丢弃，故 PD 字段向后兼容：旧宿主静默忽略，新宿主消费）；无 schema 迁移、无状态残留。

## 10. v1.0 → v1.1 差异表

| # | v1.0 | v1.1 | 依据 |
|---|---|---|---|
| 1 | "wire 边界存在性核验"，含糊于网络请求 | **传输提交前请求对象**；链条三步+body 覆盖核实；明确不能证明网络对端/模型上下文 | encodeBody/SDK 源码核实 |
| 2 | 整 system 区域哈希 vs 注入子块哈希对照判"漂移" | **删除**该判据；改为全部合法角色消息的完整正文包含检查；禁止跨消息拼接；禁止只查首条 | 契约 2 |
| 3 | 上限"≤16KiB 截断期望"、"历史 18 条"语焉不详 | 四类显式上限（64 条/64KiB/8MiB/512 消息）+ 超限一律 `unknown:limit_exceeded`；历史最大值不作上限 | 契约 3 |
| 4 | `presentInSystem=true/false` 二值 + checkFailed | 三值资格 `full_hit/checked_missing/unknown`（unknown 必带 reason+实际值） | 契约 4 |
| 5 | "PD 零改动"假设；期望集"随注入返回值走" | **假设不成立**（宿主白名单丢弃额外字段，已核实）：Tier B = 宿主契约字段+symbol carrier+PD 冻结（守卫后）；Tier A = 宿主独立块级检查（无 per-activation）；禁止事后读库 | attempt-prompt-helpers.ts:80-124 |
| 6 | payloadVariant 当尝试身份；未定义并发隔离 | 三层身份（run/逻辑请求/尝试）+attemptIndex；runId 分键 Map+closure 隔离+carrier 单调用生命周期已核实 | provider-prompt-state.ts |
| 7 | 未指明可构建源码与构建入口 | release/2026.11.1（head d10d3d9a642；构建戳 4ffdd20 为其祖先）；gitSha 不可靠已声明；构建入口/测试入口/交付路径明确；worktree 方式不触 Owner 检出与安装目录 | git 核实 |
| 8 | "<1ms、≤1.5KiB"未经测量 | 改为测量方法+实测表要求 | 契约 4/任务指令 |
| 9 | fixture A1–A8 | 保留并修订语义（A2→checked_missing、A3→unknown:unparseable、A4→按冻结文本+revision 记录）+ 新增"编码后一致性"测试 | §8 |

## 11. 实施卡（一次批准）

| 层 | 内容 | 精确范围 | 勾选 |
|---|---|---|---|
| L1 设计 | 本文档 v1.1 | 七契约修订 + 差异表 | ☐ |
| L2 档位选择 | **Tier B**（宿主契约字段+carrier+PD 冻结）或 **Tier A**（宿主独立块级） | 默认 Tier B；选 Tier A 则 per-activation 粒度不可得，须 Owner 知情 | ☐ |
| L3 openclaw 实现 | 独立 worktree @ `origin/release/2026.11.1`：检查纯函数 + responses/completions 两接线 + carrier + 白名单/类型 + wrapper 传参 + §8 全部测试 | 不触安装目录/dist；不改生产配置 | ☐ |
| L4 PD 实现 | `openclaw-plugin` hook 返回 `injectedExpectations`（守卫后冻结）+ 本地类型镜像 + 单测 | Tier B 才需要 | ☐ |
| L5 构建与离线验证 | `pnpm build:runtime` + vitest 全绿 + 假传输捕获核对 + 实测表 | 不启动真实宿主/模型 | ☐ |
| L6 交付 | openclaw 分支/PR（不合并）+ PD PR #2404 文档与检查点更新 | 官方安装器路径升级才生效 | ☐ |

> L1–L6 全部勾选后才进入编码；缺任一层该层内动作不执行。本卡不授权真实宿主运行（运行卡见 §12，届时另批）。

## 12. 真实运行卡（仅为草案，本轮不执行、不请求批准）

待离线实现验收后，如需在真实宿主验证：专用单 agent、1 次 responses 路径 + 1 次 completions 路径真实请求、预算上限、时长上限、停用方式（revert + 重装官方版本）、验收=事件含 presenceCheck 且字段与离线 fixture 一致。**本轮不出卡、不申请。**
