# SPEC-PD-PI12-COMPAT-001 — Pi 1.2.0 兼容性迁移

- 版本：v0.2（Phase 1 实施修订；**取代 v0.1**，v0.1 按仓库惯例保留于同目录作为历史版本）
- 日期：2026-10-17
- 状态：实施 PR 就绪评审中。Phase 0 审计/实验/对抗复审已完成；Phase 1 已按本文档完成单一原子 PR（R6a）的全部内容与四层验证
- 审计与证据：`docs/specs/SPEC-PD-PI12-COMPAT-001-pi-compat-audit-20261017.md`（差异矩阵全文，**已入库受版本控制**；`docs/audit/` 目录被 gitignore，不作为交付路径）、`docs/implementation-reports/pi12-compat-phase0-spike-2026-10-17.md`（E01–E05）
- 实施分支：`ai/adhoc-20261017-pi12-compat-phase1-943ffc`（基于 origin/main `d91b9e07e`；Phase 0 迁移提交 `33c9bf5a` 已 cherry-pick 为 `edc9a01db` 并与新 main 的 PRI-1011 改动共存验证）

---

## 1. 现状、问题与升级价值

**现状**：PD 在 `packages/principles-core` 与 `packages/create-principles-disciple/core` 声明 `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`（原 `^0.85.1`）；7 个安装器 release-locks 原锁 0.85.1。全部直接消费集中于 8 个生产文件（审计 §A）。

**问题**：
1. 0.85.1 已落后 pi-mono 五个 minor + 1.0 大版本线；上游 0.87 起移除 `shouldStopAfterTurn`、1.0 重构 agent-core，未来任何被动升级（安全修复、新模型目录条目）都将撞上同一批破坏点，且越晚撞面越大。
2. pi-ai 目录持续演进（模型条目、重试分类修复、Mistral compat 等）；PD 的 DeepSeek/zai 网关路径依赖目录质量。
3. agent-core 1.2 依赖从 7 个减到 2 个，安装树显著缩小（实测锁 diff -1951/+861 行）。

**升级价值**：可控的主动迁移窗口（编译碰撞实测仅 3 处）+ 依赖树瘦身 + 目录/重试质量跟进。**无新增产品能力**——本 SPEC 是纯依赖与适配器合同迁移。

**MVP 契约**：
- `mvp-q-1-what-if-skip`：不迁移则未来被动升级时破坏面扩大且无准备好的迁移式与测试锁定；无即时功能损失。
- `mvp-q-2-how-observed`：核心可观测面不变（Dreamer/Artificer/One-shot 三路径行为由全量套件与 14 个 spike 用例锁定）；依赖树/锁 diff 可审。
- `mvp-q-3-how-disabled`：依赖回退 = revert 两个 manifest + 适配器三文件（git revert 即可）；无新 flag。
- `mvp-q-4-emotional-value`：N/A — no direct Owner-facing behavior.

## 2. 0.85.1 → 1.2.0 差异（必改清单）

完整矩阵见审计报告 §D（`docs/specs/SPEC-PD-PI12-COMPAT-001-pi-compat-audit-20261017.md`）。对 PD 有迁移动作的项：

| # | 变化 | PD 必改点 |
|---|---|---|
| M1 | `AgentContext.systemPrompt` 移除；prompt/工具声明进入 transcript SystemMessage；`declareToolChanges` 把 `context.tools` 合并进 prompts 的 system 消息 | 两个 L2 适配器：prompts 前插 `{role:'system', content, timestamp:0}`；`agentContext = {messages: [], tools}`（**必须空数组**：两版 loop 都做 `[...context.messages, ...prompts]`，0.85 的老写法把用户消息在每请求重复两份——顺带修复的存量缺陷） |
| M2 | `shouldStopAfterTurn` → `finishTurn`（0.87 Breaking；error/aborted 回合会调用但决策被忽略；钩子在 turn_end 前触发） | 两适配器：守卫 `turn.message.stopReason === 'error'\|\|'aborted'` **在 turnCount 递增前** return undefined；命中停止条件返回 `{action:'end'}` |
| M3 | `convertToLlm` 契约含 system 角色直通 | 两适配器角色白名单加 `'system'` |
| M4 | `ToolCall.arguments` 收紧为 `JsonObject` | `pi-ai-runtime-adapter.ts` ToolCall 提取谓词改用 SDK `ToolCall` 类型 |
| M5 | 依赖/打包 | 两处 manifest 版本、全部 release-locks 再生成（Node22/npm10 工具链） |

无迁移动作（已核实兼容）：compat 五函数签名、`SimpleStreamOptions` 字段、`onPayload` 消费点、Google 自定义 fetch 拒绝集合、`StopReason`/`Usage`、`AgentEvent`、`getFollowUpMessages`/`beforeToolCall`、`terminate` 语义、azure 更名（PD 零引用）、engines（≥22.19 不变）。

## 3. 目标架构与兼容性合同

**不变式（迁移前后必须逐条成立）**：

- C1 三路径装配点唯一：host-runtime `internalization-consumer-cycle` 仍是三适配器唯一生产装配处；pd-cli/openclaw-plugin 经 `@principles/core/runtime-v2` 公共导出消费。
- C2 One-shot 请求合同：`completeSimple(model, context, {maxRetries:0, timeoutMs, signal, fetch, onPayload})`——PD 自管重试/超时/中止；onPayload 的 `tool_choice:'required'` 与 `response_format json_schema` 改写语义不变。
- C3 L2 终止合同：主终止 = submit 工具捕获（finishTurn 判 `{action:'end'}`）；轮上限 = PD 自管 turnCount（maxTurns 默认 Dreamer 5 / Artificer 12）；预算 = PD budget timer 对 AbortController 的首写所有权（Artificer PRI-795 三层超时合同原样）。
- C4 Artificer 治理链：Owner-Evidence preflight（适配器构造前）→ 四工具白名单双层防御 → validator 拒绝即修复回路 → 无 L1 回退 → 失败即 loud。全部不受 Pi 版本影响。
- C5 Dreamer 回退合同：L2 空（无 submit、无可解析 JSON）经 `1+maxEmptyRetries` 次尝试后 L1 单次 completeSimple 回退（默认开启），遥测 `dreamer_l2_fallback_to_l1`。
- C6 消息形状：每次 LLM 请求 = 恰好一条 system（三层合并 prompt + 工具声明）+ 一条 user（任务数据）——**新固定合同**（0.85 为双 user 怪癖，迁移即修复并以 E02 断言锁定）。

**明确不做**：不引入 `Agent` 类/Harness/steer 队列/durable；不使用 `prepareNextTurn`/`prepareRequest`/`outputSchema`/`structuredContent` 新钩子（记录为后续可选项）；不改 `pdStreamSimple` 的 fetch 绑定与 Google 例外表。

## 4. 功能需求（FR）

- **FR-1（依赖切换）**：`packages/principles-core/package.json` 与 `packages/create-principles-disciple/core/package.json` 的 pi 两依赖改为精确 `1.2.0`（防漂移；后续放宽为 `^1.2.x` 属独立决定）；根 lockfile 与 **7 个含 pi 条目的 release-locks（core/host-runtime/plugin/pd-cli/console/codex-adapter/workbuddy-adapter；install-layout 与 release-manager 无 pi 条目）全部再生成并解析 1.2.0**。依赖树断言（Phase 0 复审 F-2 修正后的可执行形式）：`npm ls @earendil-works/pi-agent-core --workspace @principles/core --omit=dev` 显示其自身依赖恰为 `{@earendil-works/pi-ai, typebox}`（源：`packages/agent/package.json@v1.2.0`），且 `@earendil-works/chord` 与 `diff` 从生产树消失（`ignore`/`yaml` 由 dev 链保留、`pi-telemetry` 经 pi-ai@1.2.0 自身保留并解析 1.3.0——非回归）。
- **FR-2（Dreamer 迁移）**：`l2-agent-loop-adapter.ts` 按 M1–M3 修改；`convertToLlm` 对未知角色仍抛 `output_invalid`；`prompts` 复用于重试尝试时不可被 loop 变异（`declareToolChanges` 返回新数组，已核实）。
- **FR-3（Artificer 迁移）**：`artificer-l2-adapter.ts` 同 M1–M3；`getFollowUpMessages` 劝导机制、EP002-R3 message_end 错误捕获、abort 所有权分类原样保留。
- **FR-4（One-shot 迁移）**：仅 M4；三路结构化输出（tool_call_first → json_mode → free_form+repair）行为不变。
- **FR-5（合同测试更新）**：两个适配器契约测试的 6 处断言更新为新合同，且新增：error/aborted 回合不计数断言、`agentContext.messages === []` 断言、prompts[0] 为分层 system 消息断言。
- **FR-6（spike 测试固化）**：三个 `pi12-spike-*.test.ts`（真实 loop + faux）进入常规套件，作为 1.2 语义的常驻回归门。
- **FR-7（发布链）**：plugin bundle 卫星纯度守卫 0 违规、体积预算内；transitive-deps 守卫绿；`check-dist-hygiene` 各包绿。
- **FR-8（发布意图，v0.2 新增）**：本 PR 必须自带 changeset（`@principles/core` patch + `create-principles-disciple` patch），`scripts/release/check-pr-release-intent.mjs` 在真实 PR base SHA 上 **PASS**。

## 5. 验收标准（AC）与合并硬门

**合并硬门（任一不满足禁止合并）**：AC-4（7/7 锁）、AC-8（Changeset + Release Intent Guard）、AC-1（verify:merge）。

- **AC-1** `npm run verify:merge` 在迁移 PR 上 exit 0。【Phase 1 实测：**exit 0 @ head f4ad1c836 全门禁链**（含 Release Intent Guard/check:error-handbook/telemetry strict/repo-hygiene/runtime-contract/workspace-tools/guard-contracts/release-target-matrix/core build/website/lint/全仓 build/pipeline-contract/pd-cli+pd-console build/四包 typecheck/satellite-bundle-deps/runtime-writers）】
- **AC-2** core 全量 vitest 0 failed。【Phase 1 实测：**8530 passed / 0 failed**（433 文件 +4 skipped，含 PRI-1011 新增测试在 Pi 1.2.0 下通过；两连跑确认）】
- **AC-3** spike 套件 14/14：含请求形状（C6）、submit 终止、混合批次、轮上限、预算中止（Artificer 分类 timeout）、L1 回退恰一次、白名单外工具 isError 反馈、无 L1 回退路径无额外模型调用。【Phase 1 实测：PASS（与契约测试合计 212/212）】
- **AC-4（合并硬门）** 全部 7 个含 pi 条目的 release-locks 解析 `pi-ai/pi-agent-core 1.2.0`（Node22/npm10 生成；无 `link:true` 记录；无 0.85.1 残留；任何锁部分再生成的中间态禁止合并——manifest 精确钉 1.2.0 而锁解析 0.85.1 时 `npm ci` 会大声失败，安装器直接不可用）。【Phase 1 实测：7/7 全部 1.2.0、telemetry 1.3.0、link=0、0.85.1 残留=0；`npm run check:release-locks --workspace=create-principles-disciple` exit 0】
- **AC-5** 安装器打包验证：`npm run check:release-locks --workspace=create-principles-disciple` + `npm run test:smoke:packaged --workspace=create-principles-disciple`（+ 随发版执行 `test:smoke:release-asset`；发版资产 smoke 需官方 Release Asset，本轮离线环境 NOT_RUN 并如实记录）。【Phase 1 实测：check:release-locks PASS；smoke-packaged 在 **Node22/npm10 便携工具链**下执行，结果见 §15】
- **AC-6（真实 LLM E2E）状态机：`NOT_RUN` / `PASS` / `OWNER_WAIVED` 三值，禁止其他表述。** opt-in 真实 LLM E2E（`LLM_E2E_ENABLED=true`）：Dreamer submit_output 全链、Artificer validate→replay→submit 全链、One-shot json_schema 路径各至少 1 例真实 provider 通过——补齐 faux 覆盖不了的 onPayload/真实思考格式面。【Phase 1 实测：**NOT_RUN**——本轮任务书禁止真实付费模型调用；该状态不等于 OWNER_WAIVED，生产切换前必须二选一：执行 PASS 或 Owner 明示豁免】
- **AC-7（新 main 共存，v0.2 新增）**：迁移与 main 新增改动（PRI-1011 maxTokens 降档、PRI-995 意图门）在同一分支上全部测试共存通过。【Phase 1 实测：PASS——cherry-pick 零冲突；PRI-1011 的 `completeWithRetry` 区与 M4 编辑区不重叠；PRI-1011 测试套件在 1.2.0 下绿】
- **AC-8（合并硬门，v0.2 新增）** Changeset 随本 PR 提交（core patch + installer patch）且 Release Intent Guard PASS。

## 6. 安全与 Owner 治理边界

- 不改任何审批/激活/RuleCode 治理语义；Artificer 无 L1 回退与 Owner-Evidence preflight 为迁移不可触碰项（C4）。
- 模型费用保护：PD 侧 `maxRetries:0` + 自管重试上限（默认 2）+ 每请求 timeoutMs + 总预算 timer 的四层结构原样；1.2 未引入任何新的隐式重试路径（库内 RetryPolicy 仅在 maxRetries>0 时生效，PD 全部关闭——源码核实 `utils/retry.ts` 两版一致）。
- 不触碰 `~/.pd/runtime`、生产 DB、真实任务；实验与验收均在隔离 worktree/测试库。
- `finishTurn` 不使用 `{action:'continue'}`（避免任何库内追加请求路径）；轮数与预算仍由 PD 独占控制。

## 7. 三路径迁移设计（单一原子 PR 内的三条编辑线）

**Dreamer**：M1（system 消息 + 空 messages）→ M3 → M2；重试循环的 `prompts` 复用安全（declareToolChanges 纯函数式返回新数组）；L1 回退路径 completeSimple 经 compat normalizeContext 折叠 systemPrompt——与 0.85 行为等价。迁移后每请求用户消息从 2 份变 1 份（C6，披露的行为变化）。

**Artificer**：同 M1–M3；`timeoutMs: totalBudgetMs` 继续经 `AgentLoopConfig extends SimpleStreamOptions` 下渗（1.2 结构未变）；EP002-R3 事件捕获在 message_end（联合未变）；abort 所有权（budget timer 首写）不受 finishTurn 时序影响（finishTurn 在 turn_end 前触发不改变 abort 竞态面——abort 是 controller 级）。

**One-shot**：仅 M4 谓词收紧；compat 门面零改动。真实 LLM opt-in E2E 的补齐（AC-6）属后续独立验收动作，不在本 PR 内执行（本轮禁止付费调用）。

三条编辑线 + 依赖/锁 + 测试 + changeset **作为一个原子合并单元交付**（R6a，见 §11），消除「依赖先合、适配器未合」的编译红窗口。

## 8. Provider / Timeout / Abort / Retry / 费用保护

| 维度 | 合同（迁移后不变） |
|---|---|
| Provider 解析 | `resolveModel`/`resolveL2Model` 三层（builtin → 目录扫描仅采 openai-completions → 保守字面量）；目录变化（1.2 新条目/azure 更名）不影响 PD 现有 provider 集（零 azure 引用） |
| Timeout | One-shot：`input.timeoutMs > config.timeoutMs > 300s` → AbortSignal.timeout；Artificer：三层合同（budget t0 唯一权威 + SDK timeoutMs=backstop + runner poll）；Dreamer：budget timer abort |
| Abort | 全部经 PD 持有的 AbortController；1.2 的 loop signal 传递路径与 0.85 同构（位置参数） |
| Retry | PD 自管（maxRetries 0 库内 + 自管 2 次指数退避 + 限流正则 2× 延迟）；1.2 重试分类词表变化不触及 PD 正则主路径；PRI-1011 的 maxTokens 降档重试发生在 PD 侧重试环内，与 1.2 兼容（同预算语义，实测共存绿） |
| 费用 | 无新增调用点；`{action:'continue'}` 禁用；spike 断言 callCount 精确值锁死调用次数 |

## 9. 测试方案（真实 SQLite + 适配器集成）

1. 单元/合同层：两适配器契约测试（已更新）+ 3 个 faux spike（已入库）。
2. 集成层：既有 runtime-v2 套件含真实 SQLite 存储路径，迁移分支全量绿即为集成证据（AC-2）。
3. host-runtime 层：`internalization-consumer-cycle` 既有套件（Owner-Evidence 三态、Artificer 装配门、PRI-995 意图门）零改动通过（host-runtime 全量 511/511）。
4. 真实 LLM（AC-6，Owner 授权后）：复用 `__tests__/fixtures/llm-e2e-config.ts` 的 opt-in 机制，Pi 1.2 专项 3 例（Dreamer/Artificer/One-shot json_schema）。
5. 打包层（v0.2 修正：原稿引用的 `check:package-install` 命令不存在）：`npm run check:release-locks --workspace=create-principles-disciple` + `npm run test:smoke:packaged --workspace=create-principles-disciple` + `check-satellite-purity` + `transitive-deps`。

## 10. 独立 Worktree、发布与回滚

- 实施在独立 worktree（`npm run dev:worktree`），基于最新 origin/main（`d91b9e07e`），writer 认领租约。
- 发布序（v0.2 修正：changeset **随本 PR 提交**，不是合并后动作）：changeset（core patch + installer patch）随 PR 入库 → Release Intent Guard PASS → PR 合并 → 常规版本列车消费 changeset 发版。**不单独发版**。发布注记须含一行 provider 更名提示（`azure-openai-responses` → `azure`，Phase 0 复审 F-7；PD 源零引用，仅影响用户手写配置）。
- 回滚：`git revert` 迁移 commit 集（两 manifest + 三适配器 + 测试 + 锁）即恢复 0.85.1；release-locks 同步 revert。无 schema、无状态、无 flag，回滚零数据面。若已发版后回滚：安装器按锁回装 0.85.1，与运行时状态无耦合。

## 11. 实施策略：单一原子合并单元（R6a 定案）

Phase 0 复审 R6 采纳方案 (a)：**一个 PR 携带依赖切换 + M1–M4 全部适配器编辑 + 契约/spike 测试 + 7/7 release-locks + changeset + 文档**。v0.1 的 PR-02..05 分包编号废止——它们原是评审焦点切分建议，不构成独立可合并单元。真实约束：两个 manifest 属于同一逻辑运行时包，须与锁、changeset 原子变更（Phase 0 复审 F-8 措辞修正）。本分支即该形状。

## 12. 残余风险与生产切换条件

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | onPayload 真实 HTTP 行为未实测（faux 盲区） | P2 | 源码同构已核（审计 §B.6）+ AC-6 真实 E2E json_schema 例 |
| R2 | 真实 provider 思考格式/目录 compat 变化（DeepSeek/zai 网关） | P2 | `l2-resolve-model-compat` canary 在 1.2 绿；AC-6 真实验证 |
| R3 | 1.2 重试分类词表变化对边缘错误消息的归类差异 | P3 | PD 正则主路径不受影响；生产遥测观察 |
| R4 | 用户消息去重带来的模型行为/成本边际变化 | P3 | 语义无损失；E02 形状断言；生产观察首周遥测 |
| R5 | release-locks 需 Node22/npm10 工具链 | P2 | **已解除**：本轮以官方 Node v22.23.3（npm 10.9.9）便携工具链完成 7/7；CI node22 作业为长期保障 |
| R6 | （已定案）依赖/适配器/锁/changeset 的原子性 | — | R6a 单一 PR 已实施，风险关闭 |
| R7 | pi-telemetry 传递升 1.3.0 的行为面 | P3 | 随 1.2 锁解析；core 全量 8530 含其路径 |

**生产切换条件**（全部满足方可随版本列车发布；与 PR 可合并是两个独立状态）：
1. AC-1..AC-5、AC-7、AC-8 全绿（已达成）；**AC-6 从 NOT_RUN 变为 PASS 或 OWNER_WAIVED**。
2. IAER Production Pilot 的真实 L2→Evaluator 验收在 1.2 上重放通过（Pilot 本未完成，1.2 迁移不得使其倒退——以 Pilot 既有任务集为准）。
3. 安装器在干净环境 `npx create-principles-disciple` 干跑通过。
4. Owner Review Card 交付 + 回滚 runbook（§10）确认 + Owner 审批。

## 13. 明确非目标

Pi Code Mode；Pi Durable；全部 Agent 自动升级 L2；Agent 自适应执行策略（prepareNextTurn/prepareRequest/steer 队列等新钩子的采用）；RuleCode 治理机制重构；Owner 审批权限调整；生产历史任务批量恢复；Dreamer 中止分类收紧（审计 §E.2 存量问题，独立工票）；任何新功能 flag；真实付费模型调用（本轮）。

## 14. Complexity Delta

New durable source of truth: NO；New persisted schema/state: NO；New subsystem: NO；New public abstraction: NO（适配器公共接口不变）；New runtime feature flag: NO；New cross-package dependency: NO（版本变更非新增）；New host/platform behavior: NO；New external/network capability: NO。净变化为负（传递依赖 -5 个包族）。

## 15. Phase 1 验证记录（2026-10-17，本分支实测）

| 层 | 项 | 命令 | 结果 |
|---|---|---|---|
| L1 | 类型 | `tsc --noEmit`（core） | exit 0 |
| L1 | Pi 专项 | vitest：3 spike + 2 契约 + PRI-1011 one-shot 套件 | **212/212 PASS** |
| L1 | git 卫生 | `git diff --check` | 干净 |
| L2 | core 全量 | `npx vitest run`（principles-core） | **8530 passed / 0 failed**（两连跑） |
| L2 | host-runtime 全量 | `npx vitest run`（host-runtime，含 Owner-Evidence/意图门/consumer-cycle） | **511 passed / 0 failed** |
| L3 | 锁检查 | `npm run check:release-locks --workspace=create-principles-disciple` | exit 0 |
| L3 | 锁解析 | 7/7 pi 锁脚本核验 | 全部 `pi-ai=1.2.0, pi-agent-core=1.2.0, telemetry=1.3.0, link=0, 0.85.1 残留=0` |
| L3 | 打包安装冒烟 | `test:smoke:packaged`（**Node22/npm10 便携工具链**驱动 vitest，npm 解析跟随 process.execPath） | 本地 Windows：10/13 PASS + 3 个环境性失败（600s 用例级硬编码超时的全量自包含安装、GNU tar 盘符转义、console 6 秒固定启动窗）；干净 main 基线本地 13 skipped（前置 build 失败）→ 本套件本地不可比，权威仲裁 = CI `smoke-packaged-install`（ubuntu+node22+30min），PR 上跟踪为 CI_PENDING |
| L3 | 卫星纯度 | `build:production` 内置 assertSatellitePurity | Forbidden dependency count: 0 |
| L3 | 传递依赖 | `transitive-deps.test.ts` | 5/5 PASS |
| L4 | 合并门禁 | `npm run verify:merge` @ head f4ad1c836 | **exit 0**（全门禁链通过；本表其余行在此前中间 head 实测） |
| — | 发布意图 | `node scripts/release/check-pr-release-intent.mjs`（PR_BASE_SHA=d91b9e07e） | 【提交 changeset 后复跑，结果见 PR Review Card】 |

## 16. Phase 0 独立对抗性复审结论（历史记录，2026-10-17）

v0.1 §16 全文保留有效（12 问裁决、F-1..F-8 发现与处置、双裁决）。Phase 1 对其中条件的落实：

- F-1（7/7 锁硬门）→ **已解除**（AC-4 实测 7/7）。
- F-2/F-3/F-4/F-5/F-8 → 已在 v0.1/v0.2 文本闭合（FR-1 可执行断言、AC-5 真实命令、精确 1.2.0、R6a 定案）。
- F-6（过期注释）→ 已随迁移提交修正。
- F-7（azure 发布注记）→ 列入 §10 发布序。
- CONDITIONAL GO 条件 1/2 → 已满足；条件 3（AC-6）→ **NOT_RUN**，生产切换前须 PASS 或 OWNER_WAIVED；条件 4（首周遥测）→ 合并后动作。
