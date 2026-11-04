# SPEC-PD-PI12-COMPAT-001 — Pi 1.2.0 兼容性迁移

- 版本：v0.1（Draft，Phase 0 产出）
- 日期：2026-10-17
- 状态：待 Owner 裁决。Phase 0 审计与最小实验已完成（见 §15 证据与 §16 对抗复审）
- 关联文档：`docs/audit/pi12-compatibility-audit-2026-10-17.md`（差异矩阵全文）、`docs/implementation-reports/pi12-compat-phase0-spike-2026-10-17.md`（E01–E05）
- 实验分支：`ai/adhoc-20261017-pi12-compat-phase0-ac1fd3`（含全部迁移编辑与 spike 测试，可作 PR-01/02/03 的种子）

---

## 1. 现状、问题与升级价值

**现状**：PD 在 `packages/principles-core` 与 `packages/create-principles-disciple/core` 声明 `@earendil-works/pi-ai@^0.85.1` + `@earendil-works/pi-agent-core@^0.85.1`；7 个安装器 release-locks 精确锁 0.85.1。全部直接消费集中于 8 个生产文件（审计 §A）。

**问题**：
1. 0.85.1 已落后 pi-mono 五个 minor + 1.0 大版本线；上游 0.87 起移除 `shouldStopAfterTurn`、1.0 重构 agent-core，未来任何被动升级（安全修复、新模型目录条目）都将撞上同一批破坏点，且越晚撞面越大。
2. pi-ai 目录持续演进（模型条目、重试分类修复、Mistral compat 等）；PD 的 DeepSeek/zai 网关路径依赖目录质量。
3. agent-core 1.2 依赖从 7 个减到 2 个，安装树显著缩小（实验实测锁 diff -1951/+861 行）。

**升级价值**：可控的主动迁移窗口（编译碰撞实测仅 3 处）+ 依赖树瘦身 + 目录/重试质量跟进。**无新增产品能力**——本 SPEC 是纯依赖与适配器合同迁移。

**MVP 契约**：
- `mvp-q-1-what-if-skip`：不迁移则未来被动升级时破坏面扩大且无准备好的迁移式与测试锁定；无即时功能损失。
- `mvp-q-2-how-observed`：核心可观测面不变（Dreamer/Artificer/One-shot 三路径行为由 8486+ 用例与 14 个 spike 用例锁定）；依赖树/锁 diff 可审。
- `mvp-q-3-how-disabled`：依赖回退 = revert 两个 manifest + 适配器三文件（git revert 即可）；无新 flag。
- `mvp-q-4-emotional-value`：N/A — no direct Owner-facing behavior.

## 2. 0.85.1 → 1.2.0 差异（必改清单）

完整矩阵见审计报告 §D。对 PD 有迁移动作的项：

| # | 变化 | PD 必改点 |
|---|---|---|
| M1 | `AgentContext.systemPrompt` 移除；prompt/工具声明进入 transcript SystemMessage；`declareToolChanges` 把 `context.tools` 合并进 prompts 的 system 消息 | 两个 L2 适配器：prompts 前插 `{role:'system', content, timestamp:0}`；`agentContext = {messages: [], tools}`（**必须空数组**：两版 loop 都做 `[...context.messages, ...prompts]`，0.85 的老写法把用户消息在每请求重复两份——顺带修复的存量缺陷） |
| M2 | `shouldStopAfterTurn` → `finishTurn`（0.87 Breaking；error/aborted 回合会调用但决策被忽略；钩子在 turn_end 前触发） | 两适配器：守卫 `turn.message.stopReason === 'error'\|\|'aborted'` **在 turnCount 递增前** return undefined；命中停止条件返回 `{action:'end'}` |
| M3 | `convertToLlm` 契约含 system 角色直通 | 两适配器角色白名单加 `'system'` |
| M4 | `ToolCall.arguments` 收紧为 `JsonObject` | `pi-ai-runtime-adapter.ts:1101-1104` 谓词改用 SDK `ToolCall` 类型 |
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

- **FR-1（依赖切换）**：`packages/principles-core/package.json` 与 `packages/create-principles-disciple/core/package.json` 的 pi 两依赖改为精确 `1.2.0`（防漂移；后续放宽为 `^1.2.x` 属独立决定）；根 lockfile 与 **7 个含 pi 条目的 release-locks（core/host-runtime/plugin/pd-cli/console/codex-adapter/workbuddy-adapter；install-layout 与 release-manager 无 pi 条目）全部再生成并解析 1.2.0**。依赖树断言（复审 F-2 修正后的可执行形式）：`npm ls @earendil-works/pi-agent-core --workspace @principles/core --omit=dev` 显示其自身依赖恰为 `{@earendil-works/pi-ai, typebox}`（源：`packages/agent/package.json@v1.2.0`），且 `@earendil-works/chord` 与 `diff` 从生产树消失（`ignore`/`yaml` 由 dev 链保留、`pi-telemetry` 经 pi-ai@1.2.0 自身保留并解析 1.3.0——非回归）。
- **FR-2（Dreamer 迁移）**：`l2-agent-loop-adapter.ts` 按 M1–M3 修改；`convertToLlm` 对未知角色仍抛 `output_invalid`；`prompts` 复用于重试尝试时不可被 loop 变异（`declareToolChanges` 返回新数组，已核实）。
- **FR-3（Artificer 迁移）**：`artificer-l2-adapter.ts` 同 M1–M3；`getFollowUpMessages` 劝导机制、EP002-R3 message_end 错误捕获、abort 所有权分类原样保留。
- **FR-4（One-shot 迁移）**：仅 M4；三路结构化输出（tool_call_first → json_mode → free_form+repair）行为不变。
- **FR-5（合同测试更新）**：两个适配器契约测试的 6 处断言更新为新合同，且新增：error/aborted 回合不计数断言、`agentContext.messages === []` 断言、prompts[0] 为分层 system 消息断言。
- **FR-6（spike 测试固化）**：三个 `pi12-spike-*.test.ts`（真实 loop + faux）进入常规套件，作为 1.2 语义的常驻回归门。
- **FR-7（发布链）**：plugin bundle 卫星纯度守卫 0 违规、体积预算内；transitive-deps 守卫绿；`check-dist-hygiene` 各包绿。

## 5. 验收标准（AC）

- **AC-1** `npm run verify:merge` 在迁移 PR 上 exit 0。
- **AC-2** core 全量 vitest 0 failed（基线：8486 passed / 0 failed @ 实验分支）。
- **AC-3** spike 套件 14/14：含请求形状（C6）、submit 终止、混合批次、轮上限、预算中止（Artificer 分类 timeout）、L1 回退恰一次、白名单外工具 isError 反馈、无 L1 回退路径无额外模型调用。
- **AC-4** 全部 7 个含 pi 条目的 release-locks 解析 `pi-ai/pi-agent-core 1.2.0`（Node22/npm10 生成；无 `link:true` 记录）。**该条为合并硬门（复审 F-1）：任何锁部分再生成的中间态禁止合并——manifest 精确钉 1.2.0 而锁解析 0.85.1 时 `npm ci` 会大声失败，安装器直接不可用。**
- **AC-5** 安装器打包验证通过：`npm run check:release-locks` + `npm run test:smoke:packaged`（+ 随发版执行 `test:smoke:release-asset`）（正式 PR 阶段执行；复审 F-3：原稿的 `check:package-install` 命令不存在，已替换为真实脚本）。
- **AC-6** opt-in 真实 LLM E2E（`LLM_E2E_ENABLED=true`，PR-04/05 验收时 Owner 授权执行）：Dreamer submit_output 全链、Artificer validate→replay→submit 全链、One-shot json_schema 路径各至少 1 例真实 provider 通过——补齐 faux 覆盖不了的 onPayload/真实思考格式面。

## 6. 安全与 Owner 治理边界

- 不改任何审批/激活/RuleCode 治理语义；Artificer 无 L1 回退与 Owner-Evidence preflight 为迁移不可触碰项（C4）。
- 模型费用保护：PD 侧 `maxRetries:0` + 自管重试上限（默认 2）+ 每请求 timeoutMs + 总预算 timer 的四层结构原样；1.2 未引入任何新的隐式重试路径（库内 RetryPolicy 仅在 maxRetries>0 时生效，PD 全部关闭——源码核实 `utils/retry.ts` 两版一致）。
- 不触碰 `~/.pd/runtime`、生产 DB、真实任务；实验与验收均在隔离 worktree/测试库。
- `finishTurn` 不使用 `{action:'continue'}`（避免任何库内追加请求路径）；轮数与预算仍由 PD 独占控制。

## 7. 三路径迁移设计

**Dreamer（PR-02）**：M1（system 消息 + 空 messages）→ M3 → M2；重试循环的 `prompts` 复用安全（declareToolChanges 纯函数式返回新数组）；L1 回退路径 completeSimple 经 compat normalizeContext 折叠 systemPrompt——与 0.85 行为等价。迁移后每请求用户消息从 2 份变 1 份（C6，披露的行为变化）。

**Artificer（PR-03）**：同 M1–M3；`timeoutMs: totalBudgetMs` 继续经 `AgentLoopConfig extends SimpleStreamOptions` 下渗（1.2 结构未变）；EP002-R3 事件捕获在 message_end（联合未变）；abort 所有权（budget timer 首写）不受 finishTurn 时序影响（finishTurn 在 turn_end 前触发不改变 abort 竞态面——abort 是 controller 级）。

**One-shot（PR-04 主体）**：仅 M4 谓词收紧；compat 门面零改动。PR-04 同时承载真实 LLM opt-in E2E 的补齐（AC-6）。

## 8. Provider / Timeout / Abort / Retry / 费用保护

| 维度 | 合同（迁移后不变） |
|---|---|
| Provider 解析 | `resolveModel`/`resolveL2Model` 三层（builtin → 目录扫描仅采 openai-completions → 保守字面量）；目录变化（1.2 新条目/azure 更名）不影响 PD 现有 provider 集（零 azure 引用） |
| Timeout | One-shot：`input.timeoutMs > config.timeoutMs > 300s` → AbortSignal.timeout；Artificer：三层合同（budget t0 唯一权威 + SDK timeoutMs=backstop + runner poll）；Dreamer：budget timer abort |
| Abort | 全部经 PD 持有的 AbortController；1.2 的 loop signal 传递路径与 0.85 同构（位置参数） |
| Retry | PD 自管（maxRetries 0 库内 + 自管 2 次指数退避 + 限流正则 2× 延迟）；1.2 重试分类词表变化不触及 PD 正则主路径 |
| 费用 | 无新增调用点；`{action:'continue'}` 禁用；spike 断言 callCount 精确值锁死调用次数 |

## 9. 测试方案（真实 SQLite + 适配器集成）

1. 单元/合同层：两适配器契约测试（已更新）+ 3 个 faux spike（已入库）。
2. 集成层：既有 runtime-v2 套件含真实 SQLite 存储路径（core 全量 8486 内），迁移分支全绿即为集成证据。
3. host-runtime 层：`internalization-consumer-cycle` 既有套件（Owner-Evidence 三态、Artificer 装配门）不因 Pi 变化而改动——迁移 PR 必须保持其零改动通过。
4. 真实 LLM（AC-6，Owner 授权后）：复用 `__tests__/fixtures/llm-e2e-config.ts` 的 opt-in 机制，新增 Pi 1.2 专项 3 例（Dreamer/Artificer/One-shot json_schema）。
5. 打包层：`check-satellite-purity` + `transitive-deps` + 安装器 `check:package-install`。

## 10. 独立 Worktree、发布与回滚

- 每个实施 PR 独立 worktree（`npm run dev:worktree`），基于最新 origin/main，writer 认领。
- 发布序：PR 合并 → changeset（core patch + installer patch）→ Node22 工具链再生成全部 release-locks 并随 PR 入库 → 常规发布火车。**不单独发版**——随下一次正常版本列车。发布注记须含一行 provider 更名提示（`azure-openai-responses` → `azure`，复审 F-7；PD 源零引用，仅影响用户手写配置）。
- 回滚：`git revert` 迁移 commit 集（两 manifest + 三适配器 + 测试）即恢复 0.85.1；release-locks 同步 revert。无 schema、无状态、无 flag，回滚零数据面。若已发版后回滚：安装器按锁回装 0.85.1，与运行时状态无耦合。

## 11. 实施 PR 分包与依赖序

| PR | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **PR-01（单一合并单元，R6a）** | **依赖 + 全部适配器迁移 + 测试一体**：两 manifest 切 `1.2.0` + 全部 release-locks 再生成（Node22）+ M1–M4 全部代码编辑 + 两契约测试更新 + 三个 spike 入库。实验分支即此形状 | 无（首个） | FR-1..FR-7、AC-1..AC-4 |
| **PR-02** | （可选，评审焦点切分）Dreamer/Artificer 迁移的评审深化与注释清理 | PR-01 | 复审确认项沉淀 |
| **PR-03** | （可选）One-shot 真实 LLM opt-in E2E 补齐（AC-6，需 Owner 授权执行） | PR-01 | AC-6 |
| **PR-04** | （可选）安装/回归补强：`test:smoke:packaged`、安装器本地干跑 | PR-01 | AC-5 |
| **PR-05** | 发版 changeset + 版本列车随行 | PR-01（+可选 02-04） | §10 发布序 |

说明（复审修订）：R6 采纳方案 (a) 后，**PR-01 为唯一必需合并单元**；PR-02..05 为可选补强。AC-2 的全量绿在 PR-01 合并时即成立（实验分支已验证）。PR-01 的合并硬门 = AC-4（7/7 锁，F-1）。

## 12. 残余风险与生产切换条件

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | onPayload 真实 HTTP 行为未实测（faux 盲区） | P2 | 源码同构已核（审计 §B.6）+ AC-6 真实 E2E json_schema 例 |
| R2 | 真实 provider 思考格式/目录 compat 变化（DeepSeek/zai 网关） | P2 | `l2-resolve-model-compat` canary 在 1.2 绿；AC-6 真实验证 |
| R3 | 1.2 重试分类词表变化对边缘错误消息的归类差异 | P3 | PD 正则主路径不受影响；生产遥测观察 |
| R4 | 用户消息去重带来的模型行为/成本边际变化 | P3 | 语义无损失；E02 形状断言；生产观察首周遥测 |
| R5 | release-locks 需 Node22/npm10 工具链 | P2 | CI 已有 node22 作业；本地缺失仅为环境约束 |
| R6 | PR-01（依赖切 1.2）先合而 PR-02/03 未合时主分支编译红 | **P1（流程）** | **采纳方案 (a)（复审建议）：单一 PR 携带全部代码编辑**（依赖切换 + M1–M4 + 测试，即实验分支现状，Phase 0 已验证全绿）；§11 的 PR-02/03/04 退化为同一变更集内的评审焦点切分或后续测试补强，而非独立可合并单元。真实约束是两个 manifest 属于同一逻辑运行时包、须与锁原子变更（复审 F-8 措辞修正） |
| R7 | pi-telemetry 传递升 1.3.0 的行为面 | P3 | 随 1.2 锁解析；core 全量含其路径 |

**生产切换条件**（全部满足方可随版本列车发布）：
1. AC-1..AC-5 全绿；AC-6 已执行或 Owner 明示豁免。
2. IAER Production Pilot 的真实 L2→Evaluator 验收在 1.2 上重放通过（Pilot 本未完成，1.2 迁移不得使其倒退——以 Pilot 既有任务集为准）。
3. 安装器在干净环境 `npx create-principles-disciple` 干跑通过（PR-05）。
4. Owner Review Card 交付 + 回滚 runbook（§10）确认。

## 13. 明确非目标

Pi Code Mode；Pi Durable；全部 Agent 自动升级 L2；Agent 自适应执行策略（prepareNextTurn/prepareRequest/steer 队列等新钩子的采用）；RuleCode 治理机制重构；Owner 审批权限调整；生产历史任务批量恢复；Dreamer 中止分类收紧（审计 §E.2 存量问题，独立工票）；任何新功能 flag。

## 14. Complexity Delta

New durable source of truth: NO；New persisted schema/state: NO；New subsystem: NO；New public abstraction: NO（适配器公共接口不变）；New runtime feature flag: NO；New cross-package dependency: NO（版本变更非新增）；New host/platform behavior: NO；New external/network capability: NO。净变化为负（传递依赖 -5 个包族）。

## 15. Phase 0 证据索引

- 审计：`docs/audit/pi12-compatibility-audit-2026-10-17.md`（调用点全景、差异矩阵 14 项、存量怪癖 3 项、NOT_RUN 清单）。
- 实验：`docs/implementation-reports/pi12-compat-phase0-spike-2026-10-17.md`（E01–E05 逐项退出码；core 8486/8486；spike 14/14；bundle +1.55%；锁部分再生成）。
- 实验分支 `ai/adhoc-20261017-pi12-compat-phase0-ac1fd3`：迁移编辑 3 文件 + 契约测试 2 文件 + spike 3 文件 + 再生成的 core/host-runtime 锁。

## 16. 独立对抗性复审结论（Phase 0D，2026-10-17）

有界单轮独立复审（独立子代理，只读，证据重核两仓源码），对任务书 12 问逐项裁决：**Q1–Q10 全部 OK**（含五项关键事实主张 A–D 全部 TRUE、E 部分核验），Q9/Q11/Q12 提出发现。复审核心确认：

- 迁移回调与 pi-mono 官方 CHANGELOG §0.87.0 迁移配方逐字一致；error/aborted 守卫在计数前，轮数记账与 0.85 精确等价。
- 全部 PD→Pi 边界 `maxRetries:0`（两版同构），无任何隐式重试/追加调用路径；`{action:'continue'}` 全仓零使用。
- 治理面零接触：diff 不含 host-runtime/pd-cli/openclaw-plugin/codex/workbuddy 任何文件；Owner-Evidence preflight 与无 L1 回退原样。
- spike 的 mock 形态核实为「真函数 + 真 registry」（importActual 展开），驱动的是真实 Pi 1.2 loop；盲区（onPayload 真实 HTTP）诚实标注并归 AC-6。
- 中间版本考古：M1/M4 自 0.86.1、M2 自 0.87.0 即已存在——**不存在更便宜的中间停点**；唯一直接相关的上游修复（Z.AI CN 端点上下文溢出检测）在 0.99.2。
- 事实主张 A（0.85 用户消息每请求重复）/ B（systemPrompt 静默丢失不可编译捕获）/ C（onPayload 消费点同构）/ D（azure 零引用）全部独立证实。

发现与处置（P0=0）：

| ID | 级别 | 发现 | 处置（本 v0.1 已闭合处） |
|---|---|---|---|
| F-1 | P1 | 分支仅 2/7 pi 锁再生成（plugin/pd-cli/console/codex-adapter/workbuddy 仍 0.85.1），该状态合并即破坏安装器（npm ci 大声失败） | 已写入 AC-4 为**合并硬门**；正式实施必须在 Node22/npm10 再生成全部 7 锁 |
| F-2 | P2 | FR-1 原 npm-ls 断言按字面不可执行（ignore/yaml 由 dev 链保留；pi-telemetry 经 pi-ai@1.2.0 自身保留） | §4 FR-1 已改写为可执行断言 |
| F-3 | P2 | AC-5 引用的 `check:package-install` 命令不存在 | 已替换为 `check:release-locks` + `test:smoke:packaged`（+发版时 `test:smoke:release-asset`） |
| F-4 | P3 | SPEC `^1.2.0` vs 分支精确 `1.2.0` 不一致 | 已统一为精确 `1.2.0`（防漂移；放宽属后续独立决定） |
| F-5/F-8 | P3 | §11 分包表与 R6(a) 张力；R6 措辞不精确 | §11 已重构为 R6(a) 单一合并单元 + 可选补强；R6 已改写 |
| F-6 | P3 | 两处过期注释仍述 shouldStopAfterTurn 语义 | 实施提交中已同步更新（artificer EP002-R3 注释 + agent-tool-contract 头注） |
| F-7 | P3 | 用户 workspace 配置若含旧 `azure-openai-responses` provider 串，升级后不再解析 | 发布注记一行 + 可选 doctor 提示（§10 已列入发布序） |

**裁决**：

- **SPEC READINESS：GO** —— 复审提出的全部 SPEC 缺陷（F-2/F-3/F-4/F-5/F-8 + §16 占位）已在 v0.1 内闭合；无 P0；无不可执行/不可测要求残留。复审原始裁决为 CONDITIONAL GO（修订前），本节修订后条件全部解除。
- **PI 1.2 MIGRATION READINESS：CONDITIONAL GO** —— 技术兼容性已由 E01–E05 充分证明（真实 1.2 loop 三路径 14/14、core 全量 8486/8486、构建/打包/守卫全过、迁移代码与上游官方配方一致）。条件（按关键度）：
  1. 7/7 pi 锁在 Node22/npm10 再生成并机械门禁（F-1，合并硬门）；
  2. 采纳 R6(a) 单一合并单元（消除编译红窗口）；
  3. AC-6 真实 LLM E2E 执行或 Owner 明示豁免后方可随版本列车发布（faux 盲区 = onPayload/真实 HTTP payload/思考格式；C6 用户消息去重是真实生产提示词变化，值得至少 Dreamer 全链 + One-shot json_schema 各一例真实验证）；
  4. 合并后首周遥测观察 R4（去重行为边际）。

  `SPEC READINESS GO` ≠ `PRODUCTION READY`：生产切换仍须满足 §12 四项条件。
