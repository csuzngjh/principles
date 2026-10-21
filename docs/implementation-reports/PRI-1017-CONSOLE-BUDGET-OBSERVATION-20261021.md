# PRI-1017 实施报告：打通 Console 与运行时模型预算数据链

**日期：** 2026-10-21
**分支：** `ai/PRI-1017-console-budget-observation`
**基线：** `origin/main` `808278e8c1325d5e7c4c715836034df78b93c33c`
**工单：** PRI-1017
**SPEC：** `docs/specs/SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001.md`（新增 §6.5 与 AC-14）

## A. 根因（实际代码调用链）

PR #2093（SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001）合并后：

- 运行时侧：OpenClaw Hook / Codex·WorkBuddy 共享路径每次 prompt build 调
  `resolvePromptBudget({hostCapacity, modelIdentity, catalog})`，可信 256K 窗口解析出
  4000 字符预算，并把 `budget` + 四个溯源字段写入注入事件
  `runtime_v2_prompt_activations_injected`（`<ws>/.state/logs/events_<date>.jsonl`）。
- Console 侧：`ApprovalsGroupedConsoleModel.readPromptInjectionBudgetStatus()` 调
  `resolveLivePromptInjectionProjection({workspaceDir, targetHost})` **未传 `promptBudget`**；
  `buildLivePromptInjectionProjection` 第 403 行 `input.promptBudget ?? resolvePromptBudget()`
  ——无参调用 ⇒ hostCapacity undefined ⇒ 纯 fallback 2000。

结果：运行时按 4000 注入，Console 预测按 2000，Owner 看到 `1953/2000` 与"控制台未绑定运行时
模型（host_capacity_absent）"。SPEC §6.1 最后一句（"不得让实际注入使用动态预算，而 Console
仍使用另一个固定 2000 字符预算并声称预测准确"）正是该缺口。

事件里的预算事实**已经持久化**，但 Console 侧没有任何读取方——属于"现有能力 → 断开的
信息流"，不是缺失能力。因此修复采用连接而非新建。

## B. 实际实现（最小充分修复）

**新模块（host-runtime，只读）：** `packages/host-runtime/src/prompt-injection-budget-observation.ts`

- `readRuntimePromptBudgetObservations({workspaceDir})`：扫描既有事件 JSONL（目录清单
  `RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS = ['.pd/logs', '.state/logs']`，与 RuleCode 遥测
  收集器同一常量，ERR-031 单一来源；最多最近 7 个日志文件，I/O 有界），取每个宿主最近一次
  注入事件的预算观测。不可信输入纪律：行级 `unknown` 解析 + 闭合集校验
  （capacitySource / capacityStatus / fallbackReason / hostKind / policyVersion），结构无效
  计入 `parseFailures`；无溯源字段的旧事件计入 `legacyEventsSkipped`（不重解释）；
  `budgetPolicyVersion` 与当前政策不一致计入 `foreignPolicyEventsSkipped`（公式可能已变，
  不作为当前依据）；`data.workspaceDir` 与扫描工作区不一致的事件不关联。
- `selectRuntimeBudgetObservation` / `selectConsoleRuntimeBudgetFacts`：按宿主选择；
  `usable`（≤ 24h）/ `stale`（超过 `RUNTIME_BUDGET_OBSERVATION_MAX_AGE_MS` = 24h，
  诚实降级）/ `absent`（无观测）三态；`targetHost` 缺省时只给逐宿主基准，不给单一选定事实。
- `runtimeBudgetObservationToResolution`：把观测重建成投影消费的同一
  `PromptBudgetResolution` 形状（不携带 log-only 的 `fallbackDetail`）。

**数据链接通（三个 Console 消费点，同一机制）：**

1. `ApprovalsGroupedConsoleModel.readPromptInjectionBudgetStatus`：先取观测，再把重建的
   resolution 作为 `promptBudget` 传入 `resolveLivePromptInjectionProjection`；confirmed
   分支 payload 增加 `budgetObservedAt`；观测过期时以
   `budgetFallbackReason: 'runtime_budget_observation_stale'` 覆盖（可追踪降级）；
   unconfirmed 分支的 perHost 条目各自携带自己的 `budget` / `budgetCapacitySource` /
   `budgetCapacityStatus` / `budgetObservedAt`——不再共用 perHost[0] 的标题数字。
2. `ActivationsConsoleModel.getActivations`：把观测预算传入
   `readPromptActivationInjectionStatuses`，逐行 `budget` 与真实注入一致；路由摘要新增
   `budgetObservedAt` / `budgetCapacitySource` / `budgetCapacityStatus` /
   `budgetContextWindowTokens`，且 `budgetObservedAt` 只在**可用观测**存在时给出。
3. `ApprovalsConsoleModel.checkPromptInjectionBudget`（批准后告警）：同一机制；未确认
   路由的 per-host 预告带上各自预算；告警文本注明预算基准
   （`runtime_observation` / `runtime_observation_fallback`（附运行时原因码）/
   `fixed_fallback`（观测过期）），不让旧观测冒充当前预算。
4. `pd-cli` 的 `RULECODE_EVENT_LOG_CANDIDATE_DIRS` 改为别名引用 host-runtime 同一常量
   （ERR-031 单一来源；行为不变）。

**投影扩展（host-runtime）：** `resolveLivePromptInjectionProjection` 增加可选
`promptBudget`（confirmed 分支）与 `perHostPromptBudget`（unconfirmed 逐宿主）；
`readPromptActivationInjectionStatuses` 增加可选 `promptBudget` / `budgetObservedAt`。
全部可选、缺省行为不变（插件路径不经过这些入口）。

**合同与 UI（pd-console）：**

- `shared/prompt-injection-contract.ts`：`PromptInjectionBudgetStatus` 增加
  `budgetObservedAt`；`PromptInjectionPerHostForecast` 增加 `budget` /
  `budgetCapacitySource` / `budgetCapacityStatus` / `budgetObservedAt`；
  `PromptInjectionRouteSummaryWire` 增加 `budgetObservedAt`；`budgetFallbackReason`
  闭合集增加 `runtime_budget_observation_stale`。
- `ui/utils/validators.ts`：全部新字段走 drop-on-invalid；perHost 元素新增字段同样逐字段
  丢弃；路由摘要同样处理。
- `FocusPage.tsx`：confirmed + 有观测 ⇒ 渲染"预算取自最近一次运行时观测（来源/上下文/
  观测时间）"；unknown + 有观测 ⇒ 回退提示附"运行时最近一次观测于 …"；未确认横幅逐宿主
  条目显示各自的预算与观测标注。
- `ActivationPage.tsx`：激活区顶部一条观测说明（`budgetObservedNote`）。
- i18n：补齐 PR #2093 评审残留（`promptBudgetModelAwareNote` /
  `promptBudgetFallbackNote` / `promptBudgetFallbackReasonSuffix` /
  `budgetFallbackReason.*` 十个码此前缺失，英文界面渲染中文 defaultValue），并新增本次
  的观测相关键；en/zh-CN 对称。
- `routes/approvals-grouped.ts`：`?host=` 参数按 host-runtime roster 接受
  `openclaw|codex|workbuddy`（此前拒收 workbuddy，与 Focus 页三宿主按钮不一致）。

**未做（有意识的最小面）：** 不新建数据库/第二状态源；不改治理权限；不改事件 Schema
（字段已在 PR #2093 齐全）；不改预算公式；不把固定回退换成其他常量。

## C. 测试证据

| 层 | 文件 / 命令 | 结果 |
|---|---|---|
| host-runtime 单元 | `npx vitest run tests/prompt-injection-budget-observation.test.ts`（28 例：读取/最新胜出/宿主分桶/工作区分隔/大小写/符号链接越界/旧事件/异政策/不可信字段/解析失败/双目录/时效三态/未来时间戳/公式一致性/上下界 clamp/逐宿主选择/重建形状） | 28/28 |
| pd-console 跨层 | `npx vitest run tests/models/prompt-budget-console-observation.test.ts`（17 例：**生产 dispatch → 真实 EventLog writer → `.state/logs` → Console 读取 → UI 合同**；A1–A3 256K→4000；C1–C4 `model_dependent`/`oversized`/clamp 边界；B1–B10 无观测/48h 过期/宿主不匹配/不可信字段/逐宿主/未来时间戳/矛盾溯源/坏行容忍/运行时自身回退观测） | 17/17 |
| pd-console 合同 | `npx vitest run tests/ui/prompt-capacity-validators.test.ts tests/ui/focus-page.test.ts tests/ui/activation-page.test.ts` | 198/198 |
| pd-console 路由合同 | `npx vitest run tests/server/routes/cr8-data-contract.test.ts`（13 例；新增 `?host=workbuddy` 200 + 读取真实观测 4000/256K + 未知宿主 400） | 13/13 |
| host-runtime 全量 | `cd packages/host-runtime && npx vitest run` | 567/567（48 文件） |
| pd-console 全量 | `cd packages/pd-console && npx vitest run` | 2910 passed + 1 expected fail（147 文件，含新增路由例） |
| openclaw-plugin 插件路由 | `cd packages/openclaw-plugin && npx vitest run tests/hooks/runtime-v2-prompt-activation.test.ts` | 44/44（含 2 例新增：256K→4000 溯源；无宿主事实→2000+`host_capacity_absent`） |
| 治理回归 | `npx vitest run tests/integration/governance-approve-activation.test.ts` | 18/18 |
| 类型检查 | core / pd-cli / install-layout / openclaw-plugin / pd-console / pd-companion `tsc --noEmit` | 全部通过 |
| 质量门禁 | `check:telemetry-events --strict`、`check:runtime-contract`、`check:docs-structure`、`check:error-handbook`、`check:repo-hygiene`、`check:runtime-writers`、`check:security-baseline`、`check:generated-artifacts`、`check:pipeline-contract`、`check:workspace-tools`、`lint` | 全部通过 |

**测试 A 的关键设计（非伪造）：** 用 `createProductionHostRuntime({hostKind:'codex'})`
 dispatch 一个带 `modelContext {contextTokenBudget: 256_000, contextWindowSource: 'model'}`
 的真实 prompt 事件，事件经**生产 EventLog writer**（vitest alias 指向
 openclaw-plugin 源码）落盘 `.state/logs/events_<date>.jsonl`；随后
 `ApprovalsGroupedConsoleModel.getApprovalsGrouped('codex')` 返回
 `budget=4000 / budgetCapacitySource=host_effective_window / budgetCapacityStatus=confirmed /
 budgetContextWindowTokens=256000 / budgetObservedAt=<ISO>`，且
 `validatePromptInjectionBudgetStatus` 原样接受。断言同时验证事件文件真实存在且
 `data.budget === 4000`——不是手写 Console 返回值。

## C2. 真实宿主证据（安装态 2.3.9）

安装态产品版本 `2.3.9`（`sourceCommit 12dace433`，含 PR #2093）已在本机运行。用**新读取器**直接读取真实安装宿主的既有事件（只读，不修改任何安装目录）：

```
readRuntimePromptBudgetObservations({ workspaceDir: 'C:/Users/Administrator/.workbuddy/pd-workspace',
                                       now: 2026-10-21T06:46:00Z })
→ filesRead=7, lines=7715, legacyEventsSkipped=181, foreignPolicyEventsSkipped=0, parseFailures=0
→ observations=[{ hostKind:'workbuddy', budgetChars:2000, capacitySource:'legacy_fallback',
                   capacityStatus:'unknown', contextWindowTokens:null,
                   fallbackReason:'catalog_no_match_for_model_id',
                   policyVersion:'model_aware_v1', observedAt:'2026-10-21T05:44:09.189Z' }]
```

事实链：

- 2026-10-20 的 82 条注入事件无任何预算溯源字段（升级前写入）→ 全部计入 `legacyEventsSkipped`，不产生观测；
- 2026-10-21 升级后的 7 条事件带完整溯源（`model_aware_v1` + 闭合集原因码），新读取器正确重建为一条诚实的固定回退观测；
- WorkBuddy 生产路径确实没有可信容量事实（`catalog_no_match_for_model_id`），因此真实宿主的正确行为就是 2000 + 原因码——这与读取器/Console 的回退语义一致。

**未覆盖的真实宿主：** OpenClaw 工作区最近事件停在 2026-10-18（模型感知预算上线前），本机 OpenClaw 网关处于空闲，无法在不操作安装态运行环境的前提下获得一次真实 OpenClaw Hook 观测。因此“真实 OpenClaw 256K → 4000”仍属**未验证**；插件本地路由由 `openclaw-plugin` 的 44 例生产代码测试覆盖，但不冒充真实宿主验收。Codex 工作区事件同样停留在 10-17（升级前），且 Codex 生产路径只带 `modelId` 不带 provider/容量，按设计恒回退。

## D. PR #2093 评审意见逐条复核

| # | 意见 | 当前状态 |
|---|---|---|
| 1 | 实施报告过时表述（旧 500–4000/旧公式/旧 head） | 已在 #2093 修复轮更新（残留仅为历史 head 标注） |
| 2 | `prompt-injection-status.ts` (1250,2000] 误报 injectable | 已修复（tierFit 先行）；本次在 Console 跨层锁定回归（C1） |
| 3 | 测量脚本缺 `budgetFallbackReason` | 已修复 |
| 4 | 档位测量只跑 selfReport=false | 已修复（双态） |
| 5 | `policy.formula` 写死旧公式 | 已修复（常量插值） |
| 6 | FocusPage 回退原因硬编码中文前缀 | #2093 改为本地化键机制，但**键在语言文件中缺失**；本次补齐 en/zh-CN 全部相关键（英文界面不再渲染中文 defaultValue） |

## E. 已知限制

- **观测是过去事实**：Console 仍无法获得实时模型身份；观测超过 24h 即诚实降级。切换模型后
  若没有任何新的 prompt build，Console 显示回退而非旧模型的预算。
- **真实宿主 E2E**：安装态 2.3.9 的 WorkBuddy 真实事件已被新读取器验证（见 C2）；真实
  OpenClaw Hook 观测未取得（网关空闲，工作区事件停留在 10-18），confirmed 路径的真实宿主
  验收仍为**未验证**。跨层一致性由“生产 dispatch → 生产 EventLog → Console → UI 合同”的
  17 例测试证明，不以合成测试冒充真实宿主验收。Codex/WorkBuddy 的容量来源限制不变
  （Codex 生产路径仅 modelId、无 provider；WorkBuddy 无容量字段，恒回退）。
- 观测读取按最近 7 个日志文件有界；更早的观测本就会超过 24h 时效界，无信息损失。
