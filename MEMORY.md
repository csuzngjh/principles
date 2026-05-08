# 项目记忆 — Principles Disciple

## 当前状态 (2026-04-30)
- **版本**: v1.10.40 (PR #414 已合并，PR #415 MEMORY 更新已合并)
- **OpenClaw 版本**: 2026.4.11
- **当前里程碑**: v2.9 M10 (Nocturnal Artificer LLM Upgrade) 已 SHIPPED
- **m10-03**: deferred to v2.10 (Dynamic Pruning & E2E Validation)

## 近期 PR 合并 (2026-04-30)
- PR #415: chore: update MEMORY.md for v1.10.40 + M10 shipped
- PR #417: test(nocturnal-workflow-manager): verify async pipeline was actually called
- PR #418: (clean rebase branch) 已合并
- PR #419: fix/issue 416 pd cli observability and error output

## 核心架构事实

### 多智能体工作目录
- 每个 agent 有**独立**的工作目录和独立的心跳任务
- 配置来源：`~/.openclaw/openclaw.json` → `agents.list`
- 8 个 agent：main、builder、pm、hr、repair、verification、research、resource-scout
- 每个 agent 的 workspace 由 `agents.list[].workspace` 指定
- 子代理复用主代理的工作目录

### 插件加载机制（关键）
- OpenClaw 的插件是**懒加载**的：`register()` 在第一次 `before_prompt_build` 时才触发
- `startPluginServices()` 在 Gateway 启动时只调用一次，此时我们的插件还没注册
- **`before_prompt_build` hook 按 agent 触发**，每个 agent 心跳时都会调用
- hook 的 `ctx.workspaceDir` 是**当前 agent 的工作目录**

### EvolutionWorker 正确设计 (PR #290 已实现)
- **每个 workspace 启动一个独立的 EvolutionWorker**
- 在 `before_prompt_build` 中，当 hook 触发时为该 workspace 启动 Worker
- 用 `startedWorkspaces: Set<string>` 去重（index.ts 模块级）
- 用 `EvolutionWorkerService._startedWorkspaces: Set<string>` 去重（evolution-worker.ts 服务级）
- 每个 Worker 只处理自己 workspace 的 `.pain_flag` 和 `evolution_queue.json`

### 配置化触发模式 (PR #290 已实现)
- 配置文件：`{workspaceDir}/.state/nocturnal-config.json`
- 新增 `periodic` 触发模式，绕过 idle 检测
- 当前 main workspace 配置：trigger_mode=periodic, period_heartbeats=2, max_runs_per_day=20
- 默认模式：trigger_mode=idle, max_runs_per_day=3

### 调试时的教训
1. **不要假设 `api.logger` 写到 SYSTEM.log** — 它写到 OpenClaw 的 `[plugins]` 子系统日志，用 `journalctl --user -u openclaw-gateway` 查看
2. **bundle.js 缓存问题** — `sync-plugin.mjs` 可能使用旧 dist/，验证时直接 `grep` 检查 bundle 内容
3. **查看 OpenClaw 源码是必须的** — 不读 `server-startup-post-attach.ts` 和 `services.ts` 就无法理解插件加载时序
4. **不要写死 agent ID 或路径** — 始终通过 hook 的 `ctx.workspaceDir` 或 `api.config.agents` 获取
5. **部署后必须验证 bundle 内容** — `grep "新代码特征" dist/bundle.js`，确认 md5 匹配
6. **代码操作纪律**：commit 前必须验证 staged 文件；写代码前必须 grep 确认 API 存在；修复后必须读回验证

## 部署
- **插件同步（重要更新）**：`node packages/openclaw-plugin/scripts/sync-plugin.mjs --dev`
  - 现在会同时构建并同步 PD CLI（@principles/core + @principles/pd-cli）
  - 创建 `~/.openclaw/extensions/principles-disciple/bin/pd.cmd` shim
  - 安装全局 pd shim 到 npm global bin
  - 注入 monorepo 的 @principles/core workspace 包到安装目录
- 验证部署：`grep "EvolutionWorker started for workspace:" ~/.openclaw/extensions/principles-disciple/dist/bundle.js`
- Windows 运行时日志（PowerShell）：`Get-Content $env:USERPROFILE/.openclaw/logs/plugin.log -Tail 100 -Wait`
- 健康检查：`npx tsx scripts/pipeline-health.ts --workspace ~/.openclaw/workspace-main`
- **分支清理注意**：lefthook 阻止直接 push main，使用临时分支删除远程分支

## 关键文件位置
- 插件源码: `packages/openclaw-plugin/src/`
- 测试: `packages/openclaw-plugin/tests/`
- OpenClaw 源码: `~/.openclaw/`（Windows: `C:/Users/Administrator/.openclaw/`）
- 插件配置: `~/.openclaw/openclaw.json`
- 状态文件: `~/.openclaw/workspace-*/.state/`
- Cron jobs: `~/.openclaw/cron/jobs.json`

## 已验证通的链路
- ✅ pain_flag 写入 → detection → queue → pain_diagnosis task → LLM runs → diagnostician report → principle 创建
- ✅ EvolutionWorker 每个 workspace 独立启动（8 个 agent 各有一个 Worker）
- ✅ periodic 触发模式工作正常（每 2 个心跳触发一次，约 2 分钟）
- ✅ 配置热更新（每次心跳重新读取 nocturnal-config.json）
- ✅ sync-plugin.mjs 同步安装：插件 + PD CLI + 全局 shim

## 待调通的链路
- ⏸️ sleep_reflection → nocturnal workflow → subagent → artifact/sample 创建
- 当前状态：sleep_reflection 任务可以入队，但 nocturnal workflow 需要通过 subagent 运行 Trinity 流程
- 需要验证：idle 检测 → enqueueSleepReflectionTask → NocturnalWorkflowManager.startWorkflow() → subagent.run() → artifact persistence

## 已知问题
- quota 默认只有 3 次/天（已通过配置改为 20）
- idle 检测依赖无活跃会话，开发中很难触发（已通过 periodic 模式绕过）
- 所有 sleep_reflection 相关日志已从 debug 改为 info 级别

## Runtime v2 当前事实 (2026-04-30)
- M9 已合并 (2026-04-29)：PiAiRuntimeAdapter 作为默认 Diagnostician Runtime，ledger probation entry = 成功标准
- M10 已合并 (2026-04-30, PR #414)：Artificer LLM Upgrade 替换 hardcoded stub
  - m10-01 ✅: runArtificerAsync + parseArtificerOutput + buildArtificerPrompt
  - m10-02 ✅: Pipeline Integration，LLM 失败返回 `skipped`（DD-04: no candidate > bad candidate）
  - m10-03 ❌: Dynamic Pruning & E2E Validation — **deferred to v2.10**
- LOCKED-04 ✅: Artificer 使用与 Diagnostician 相同的 runtimeAdapter 配置
- LOCKED-05 ✅: 静态验证（validateRuleImplementationCandidate）是强制门控
- LOCKED-06 ⚠️: Dynamic Pruning 可验证性 — m10-03 deferred，无 adherence-based lifecycle
- 重要修复：sessions 表 schema 与 OpenClaw trajectory 对齐（`updated_at` 而非 `last_seen_at`）
- 重要修复：parseArtificerOutput 使用 extractJsonOrPlaintext 支持 markdown/fenced JSON

### Runtime v2 数据源边界与误判防线 (2026-04-30)
- Runtime v2 pain->principle 主链路事实源是 `workspace/.pd/state.db`（tasks/runs/artifacts/principle_candidates）和 `workspace/.state/principle_training_state.json`（ledger probation/candidate entries）。
- `workspace/.state/trajectory.db` 的 `pain_events` 现在主要是 observability/历史分析数据；`evolution_tasks` 是 legacy 队列，不是 Runtime v2 diagnosis 任务源。不要因为 `evolution_tasks` 没写入就判断 V2 断链。
- `.pain_flag` 是 legacy compatibility，不是 Runtime v2 diagnosis entry。手动触发必须走 `pd pain record --workspace <workspace> --reason <reason> --score <0-100> --json`。
- 成功标准：`pd pain record` 返回 `status=succeeded` 且 `candidateIds`、`ledgerEntryIds` 非空；只创建 task/run 或只写 `pain_events` 不算成功。
- 真实 workspace 核查发现：4 个 consumed candidates 中有 1 个历史 E2E candidate（`10df2bb5-f2ed-4688-892e-409bbaa76aa7`, `task_id=test-e2e-20260426163127`）不在 ledger；这更像早期测试/旧版本遗留一致性问题，不应直接归因 Windows atomic rename。
- 必须补 candidate/ledger audit：`status=consumed` 的 candidate 必须能在 ledger 中找到 `candidate://<candidateId>`；否则 health/audit 应报告 degraded，并提供 repair。
- `pd health` 不能从已安装 `pd-cli/dist` 动态 import `openclaw-plugin/src/...` 源码路径；安装后源码路径不存在，会导致健康检查假失败。

### Runtime v2 当前验收状态 (2026-05-01)
- PR #420 已合并到 main（commit `9f98ab63`）：修复 candidate/ledger 一致性审计与修复能力，`pd health` 不再依赖安装后不存在的 `openclaw-plugin/src` 路径。
- 后续 CLI polish 已合并（commit `a0f2852b`）：`pd runtime probe --workspace` 支持从 `workflows.yaml` 读取 pi-ai policy；probe 默认 timeout 提升到 120s；`pd task show --json`、health `lastSuccessfulChain`、artifact/candidate workspace 错误提示已补齐。
- 真实 UAT 已通过（manual path）：workspace `D:\.openclaw\workspace`，runtime `pi-ai`，provider `xiaomi-coding`，model `mimo-v2.5-pro`，`XIAOMI_KEY` 可用。
- UAT 关键链路：`pd pain record` -> `PiAiRuntimeAdapter` -> `DiagnosticianOutputV1` -> artifact -> candidate -> ledger -> audit/health OK。
- UAT 成功样本：`painId=manual_1777610494502_eig69mxt`，`taskId=diagnosis_manual_1777610494502_eig69mxt`，`runId=run_diagnosis_manual_1777610494502_eig69mxt_1`，`artifactId=8f27d582-eea6-4e89-8448-c16cf6292e16`，`candidateId=ff0a19ec-c021-47db-adc1-a4ecd0b726ee`，`ledgerEntryId=68232be1-26d2-4acb-aa26-c28406dce64e`。
- 历史一致性已清理：之前缺 ledger 的 consumed candidate（`10df2bb5-f2ed-4688-892e-409bbaa76aa7`）已通过 `pd candidate repair` 修复，`pd candidate audit` 和 `pd health` 返回 OK。
- 当前结论：Runtime V2 手动 pain->principle 主链路已真实跑通；自动 OpenClaw hook/GFI path 尚未完成真实 UAT（之前 TC6 skipped）。
- 仍需量化稳定性：下一步不是大重构，而是补可观测性和重复 UAT。建议实现 `pd runtime trace show --task-id ... --workspace ... --json`、增强 `pd health --json` 的链路指标，并新增 `scripts/uat/runtime-v2-chain-uat.mjs` 连续执行 N 次真实 `pd pain record`，统计 successRate、p95 latency、failure category、candidate/ledger consistency。
- 系统动力学指标方向：长期跟踪 `pain_signal_count`、`gfi_gate_pass_rate`、`diagnosis_success_rate`、`pain_to_candidate_rate`、`candidate_to_ledger_rate`、`p95_pain_to_ledger_latency_ms`、`runtime_timeout_rate`、`output_invalid_rate`、`active_principle_count`、`soft_to_hard_conversion_rate`、`context_load_tokens`。
- 后续架构重构方向（不要立即开始）：将 CLI/plugin/bridge/intake/ledger 编排收敛为 core 层 `PainToPrincipleService`，CLI 和 OpenClaw plugin 都只做入口适配。

## Runtime v2 路线图与 Linear 治理事实 (2026-05-02)
- Runtime V2 架构回退事件：PR #438 曾删除/回退 PRI-12/13/14/15/16 的部分成果；PR #444 已恢复 `PainToPrincipleService`、`PainChainReadModel`、ADR-0001、相关测试；PR #445 已做 public orchestration API consolidation。
- 当前核心边界：写侧统一入口是 `PainToPrincipleService`；pain-chain 读侧统一入口是 `PainChainReadModel`；principle lifecycle/pruning 读侧入口是 `PruningReadModel`。CLI/plugin 不应直接编排 `createPainSignalBridge` 或手写 `recordPainSignalObservability`。
- Linear milestone 已建立：
  - `M1 Runtime V2 Architecture Stability`：恢复、收口并防回退 Runtime V2 service/read-model 边界。已 100%，包含 `PRI-20`、`PRI-22`。
  - `M2 Principle Lifecycle Review`：把 pruning signals 变成人工可审计 review workflow。当前主线，先做 `PRI-23` + `PRI-24`，再做 `PRI-25`，最后 `PRI-26`。
  - `M3 Runtime V2 Production Reliability`：重复 UAT、真实 OpenClaw auto-trigger 验证、operator health snapshot/runbook。
- M2 issue 顺序：`PRI-23 Add pruning signal explain command` 与 `PRI-24 Add pruning review audit log` 可并行；`PRI-25 Add pruning review CLI workflow` blocked by PRI-23/PRI-24；`PRI-26 Document principle lifecycle review workflow` blocked by PRI-25。
- M3 issue 顺序：`PRI-27 Establish Runtime V2 repeated UAT baseline`；`PRI-29 Validate real OpenClaw auto-trigger pain path` blocked by PRI-27；`PRI-28 Add Runtime V2 operator health snapshot` 可在 UAT 基线后做；`PRI-30 Document Runtime V2 production runbook` blocked by PRI-27/28/29。
- `PRI-31 Calibrate Diagnostician recommendation taxonomy` 已加入 M2，priority Low，blocked by PRI-23/PRI-24。它来自一次外部代码分析：`DiagnosticianPromptBuilder` 可能偏向 `kind: principle`，但正确目标是校准 recommendation taxonomy（principle/rule/implementation/defer），不是强制多产 rule。
- Linear 模板库已用普通 issue 形式创建（因为当前 Linear document 创建工具不可用）：
  - `PRI-32 Template — TDD Feature Issue`
  - `PRI-33 Template — Architecture Recovery / Regression Issue`
  - `PRI-34 Template — AI Prompt / Eval Calibration Issue`
  - `PRI-35 Template — Production Reliability / UAT Issue`
  - `PRI-36 Template — Project Status Update`
- 后续创建 issue 时优先复制上述模板的 description。每个开发 issue 都应有 `Goal / Context / Must Read First / Scope / Non-Goals / TDD Requirements / Verification / Acceptance Criteria / Completion Comment Template`。AI prompt/eval 类 issue 用 PRI-34；架构回退类用 PRI-33；真实 UAT/可靠性用 PRI-35。
- Linear 管理纪律：每 2-3 个 PR 或 milestone 边界用 PRI-36 模板写 status update；每个 PR 合并后在对应 issue 留事实型 comment（Merged PR、Changed files、Tests、Remaining risk、Follow-up）。

## Hard Internalization Core Migration 当前事实 (2026-05-04)
- 下一阶段主线是把硬内化 domain logic 从 `openclaw-plugin` 逐步迁到 `@principles/core`，让 plugin 只保留 OpenClaw adapter/hook/runtime 边界。Linear Project A 已拆为 M4/M5/M6。
- `PRI-41` / PR #464 已合并：新增 ADR-0002 `docs/adr/0002-hard-internalization-core-boundary.md`，确认迁移顺序：`PRI-42 -> PRI-43 -> PRI-44 -> PRI-45 -> PRI-46 -> PRI-47`；`PRI-39` store modularization 明确不在 critical path。
- `PRI-42` / PR #465 已合并：`RuleHostInput`、`RuleHostDecision`、`RuleHostMeta`、`RuleHostResult`、`LoadedImplementation` 与 `createRuleHostHelpers` 已迁到 `packages/principles-core/src/runtime-v2/internalization/` 并从 `@principles/core/runtime-v2` 导出；plugin 侧 `rule-host-types.ts` / `rule-host-helpers.ts` 现在只是 re-export。
- `PRI-43` / PR #467 已合并：core 新增纯函数 `decideInternalizationRoute()`，将 `DiagnosticianRecommendation` 的 `principle/rule/implementation/prompt/defer` 映射为 `principle-ledger/rule-candidate/implementation-candidate/prompt-injection-candidate/deferred`，输出 `ready/missingFields/reason/nextAction`。这是纯模型，无 I/O、无 plugin dependency。
- `PRI-46` / PR #468 已合并：CLI 新增 `pd candidate route --candidate-id <id> --workspace <path> [--json]`，只读展示 candidate 的 internalization route/readiness，复用 `decideInternalizationRoute()`，不写 DB/ledger、不触发 compiler。验证通过：core/pd-cli build、candidate-route tests、cli-command-tree、internalization-route tests、openclaw-plugin typecheck。
- `PRI-44` / PR #469 已合并：提取纯 PrincipleCompiler 组件到 `@principles/core/runtime-v2/internalization/`：
  - `template-generator.ts`（108 行纯模板生成逻辑）迁移到 `core/internalization/`
  - `FORBIDDEN_PATTERNS` + `checkForbiddenPatterns()` 提取到 `rule-code-validator.ts`
  - `CompileResult` 接口迁移到 `compile-result.ts`
  - Plugin 文件变为 thin re-export：`template-generator.ts` 直接转发 core 导出，`code-validator.ts` 导入 core 的 `checkForbiddenPatterns`，`compiler.ts` 导入 core 的 `CompileResult` 类型
  - 新增 14 个核心测试 + 5 个架构回归守卫（验证 core 无 infrastructure imports、plugin 正确引用 core）
  - 修复 review 发现的问题：`inferToolName` 添加动词排除（`please read` / `could write`）、`\bglobal\b` 添加自然语言排除（`global rule` / `global scope`）、`compileAll` catch 添加 console.warn
- 当前推荐下一步：执行 `PRI-45`（剩余 compiler/orchestration 边界清理）或 `PRI-47`（InternalizationRoute 应用到 intake flow）
- `PRI-45` / PR #470 已合并：提取 `mergeDecisions()` 纯函数到 `@principles/core/runtime-v2/internalization/rule-host-evaluator.ts`，plugin `evaluate()` 从 65 行减到 12 行，仅保留基础设施（VM 加载、文件系统读取）；新增 12 个 TDD 测试 + 4 个架构回归守卫；修复 review 发现：RuleHostLogger 改为 re-export、空数组检查移到 try 外、diagnostics 合并使用 ruleId 前缀避免覆盖。
- `PRI-47` store modularization Phase 1 / PR #471 已合并（2026-05-04）：task/run/commit 子目录 + barrel index.ts，41 个文件 import path 更新，5 个架构回归守卫。
- `PRI-47` store modularization Phase 2 / PR #472（2026-05-04）：context/history/trajectory/lifecycle 子目录 + barrel index.ts，~30 个文件 import path 更新，5 个架构回归守卫；修复预存 test assertion：`sqlite-trajectory-locator.test.ts` expects `'pain_id_to_run_id_lookup'` but impl returns `'run_alias_lookup'`（已重命名，测试未同步）。

## Runtime V2 / Internalization 当前事实 (2026-05-06)
- 真实 OpenClaw workspace `D:\.openclaw\workspace\carverter` 暴露出 Runtime V2 pain diagnosis 的结构化输出稳定性问题：`pd pain record` 可以创建 pain/task，但 MiniMax provider/model 可能返回可解析 JSON 后无法通过 `DiagnosticianOutputV1Schema`，错误为 `[output_invalid] LLM output does not match DiagnosticianOutputV1 schema`，任务进入 `retry_wait`。
- 关键判断：这不是简单配置问题，也不应通过降低 schema 解决。正确方向是保留 fail-closed，同时给 schema-invalid JSON 一次 bounded repair loop：用 `Value.Errors(...)` 生成精简 schema error feedback，让同一模型修正完整 JSON；修复失败仍拒绝进入 artifact/candidate/ledger。
- `PRI-71 Harden structured LLM output validation with schema repair loop` 已完成并合并到 main：PR #500，commit `8abd8517`。它解决 Runtime V2 structured output repair loop，目标是让 Diagnostician/pain->principle 链路在 MiniMax 等模型产生 schema-invalid JSON 时可 bounded repair，同时保留 fail-closed。
- `PRI-71` 的架构原则仍然是当前事实：不得降低 `DiagnosticianOutputV1Schema`，不得接受 invalid output 入 ledger；只对“JSON parsed but schema invalid”做 repair；timeout/runtime_unavailable/execution_failed 不进入 repair。
- `PRI-65/66/68` review 修复已核查通过：
  - `PITaskRecord` 扩展字段通过 `diagnosticJson.pi_metadata` 持久化，`hydratePITaskRecord()` 从 `TaskRecord` 水合，OpenClaw trigger adapter 不再依赖 top-level 临时字段。
  - `model_training` 采用 Policy B：完整 peer chain 走到 `rollout_reviewer` 后，只有 `model_training` channel 才能进入 `trainer`；不是任意 runner 直接 fan-out 到 trainer。
  - `InternalizationOrchestrator.wakeOnce()` 现在返回 `no_ready_tasks.reason`，可区分 `no_candidates`、`all_hydration_failed`、`all_blocked`、`all_dependency_failed`、`all_lease_conflict`。
- 2026-05-06 核查测试通过：`internalization-orchestrator.test.ts` + `pitask-metadata.test.ts` + `internalization-state-machine.test.ts` 共 114 passed；OpenClaw internalization trigger tests 27 passed；`npm run build --workspace=@principles/core` 通过；`npm run typecheck:openclaw-plugin` 通过。
- 下一阶段优先级：先验收 `PRI-71` 在真实 `carverter` workspace 的效果，再推进 operator 可观测性和下一批 peer runner/internalization engine。不要再把 `PRI-71` 当待办规划。

## Runtime v2 重构事实 (2026-04-26)
- 当前方向：PD Runtime v2 已完成 M1-M5，M6 正在接入 `openclaw-cli` 作为第一个真实生产 runtime adapter。目标是摆脱 OpenClaw 插件 API / heartbeat / prompt hook / sessions_spawn / marker file，改成 `pd diagnose run --runtime openclaw-cli` 的显式执行链。
- M3 已建立 PD-owned retrieval：`pd legacy import openclaw` 将 OpenClaw `.state/diagnostician_tasks.json` 和 `.state/trajectory.db` 导入 `workspace/.pd/state.db`；`pd trajectory locate`、`pd history query`、`pd context build` 可基于 PD-owned DB 工作。
- M4/M5 已建立 runner + commit：`DiagnosticianRunner` 使用 lease -> context -> runtime -> validate -> commit；M5 committer 将 diagnosis artifact 和 principle candidates 写入 SQLite artifact registry。
- 当前真实 OpenClaw 环境：`openclaw --version` 可用；`main` agent 存在，`diagnostician` agent 不存在。默认 diagnostician agent 会失败，真实验证应显式使用 `--agent main`，除非先在 OpenClaw 中创建 diagnostician agent。
- M6 最新 blocker：`pd runtime probe --runtime openclaw-cli --openclaw-local --agent main` 不能只依赖 `openclaw --version` / `openclaw agents list`。真实 `openclaw agent --agent main --message ... --json --local` 会因 OpenClaw 插件加载失败（例如 qqbot PluginLoadFailureError）而 exit 1，但 probe 可能只返回 degraded/exit 0，导致 hard gate 假阳性。
- M6 最新 blocker：`OpenClawCliRuntimeAdapter.pollRun()` 对非零 exit 只返回 `CLI exited with code X`，丢弃 stdout/stderr；真实 `pd diagnose run` 失败后只看到 `execution_failed`，无法定位 OpenClaw 插件加载、参数、prompt 或输出解析问题。必须保留 bounded stdout/stderr excerpts 到 RunStatus.reason / telemetry / CLI JSON。
- M6 最新 blocker：`pd diagnose run --json` 在 runner result 为 `retried` / `failed` 时仍 exit 0；operator E2E 会误判成功。非 `succeeded` 必须 exit non-zero。
- M6 修复后验收必须在真实环境执行：`pd runtime probe --runtime openclaw-cli --openclaw-local --agent main --json`、`--agent diagnostician` 负例、以及真实/临时 task 的 `pd diagnose run --runtime openclaw-cli --openclaw-local --agent main --json`，并确认成功时产生 artifact/candidate，失败时有可行动错误细节。

## Runtime v2 M7/M8 当前事实 (2026-04-28)
- M7 已合并：principle candidate intake 已建立，`principle_candidates.status=pending` 可被消费成 PrincipleTreeLedger 的 probation entry；幂等键必须是 `candidate://<candidateId>`，不是 artifact 级 sourceRef。
- M8 目标是最终单路径：pain signal -> Runtime v2 task/run -> DiagnosticianRunner -> OpenClawCliRuntimeAdapter -> DiagnosticianOutputV1 -> SQLite artifact/candidate -> CandidateIntakeService -> PrincipleTreeLedger probation entry；不保留 legacy fallback。
- M8 已删除/移除运行入口：`write_pain_flag` tool 不再注册，`.pain_flag` 文件副作用不再作为完成机制；`pd pain record` 已改为 Runtime v2 pain entry。
- 重要语义修正：`painId` 是触发事件/外部 provenance ID；`taskId` 是 Runtime v2 可执行诊断任务 ID，格式为 `diagnosis_<painId>`；`tasks.inputRef = painId`。不要再把 `painId` 当 `taskId`。
- `PainSignalBridge.onPainDetected()` 应返回结构化结果：`painId/taskId/runId/artifactId/candidateIds/ledgerEntryIds/status/message`。`status=succeeded` 只能表示完整 pain->principle 链路成功，不能表示"已创建 task"或"已入队"。
- 当前 M8 真实 UAT 状态：暂不签收。`pd pain record` 在真实环境返回 `status=retried` 且 exit 1，这是正确失败语义；UAT-01 blocked 在 OpenClaw CLI/runtime last-mile，尚未产生 artifact/candidate/ledgerEntry。

## PRI-73 Bug Fix Follow-up (2026-05-07)

- `InternalizationQueueReadModel.getSnapshot()` 两个 bug 在 review PR #504 时发现并修复：PR #505
  - B1: `pendingCount`/`retryWaitCount` 包含非 PI 任务（diagnostician/evaluator_janitor）→ 先 filter PeerRunnerKind 再计数
  - B2: `inspectedCount=0` 时 dominance 逻辑误判为 `all_hydration_failed` → 添加 `inspectedCount === 0` 显式 guard
  - B3: `QueueNoReadyTasksReason` 类型过宽（包含 never 返回的 `all_lease_conflict`）→ 移除
- 13 个单元测试覆盖：empty queue、non-PI 过滤、hydration failure、blocked、dependency_failed、ready tasks、counts 聚合、dominance 逻辑
- JSDoc 已更新：明确所有 counts 只统计 PI peer-runner 任务
- 当前最后 blocker：修 OpenClaw CLI runtime last-mile，使 `node packages/pd-cli/dist/index.js runtime probe --runtime openclaw-cli --openclaw-local --agent main --workspace D:/.openclaw/workspace --json` 能稳定成功；然后重跑 m8-03 UAT。不要再改 PainSignalBridge/CandidateIntake/ledger 主业务链路，除非 UAT 证明它们有缺陷。

## Architecture Docs Alignment Before PRI-75 (2026-05-07)

- 架构文档对齐任务已完成并核查：`docs/architecture/DOMAIN_MODEL.md` 是最高本体事实源；`PD_SYSTEM_ARCHITECTURE.md` 是目标架构蓝图；`PD_System_Dynamics_Model.md` 是战略/系统动力学分析，不得覆盖 ontology。
- 关键修正：
  - `Pruning Review` 只能是 append-only / read-side audit，不执行 ledger mutation；真正 lifecycle mutation 必须叫 `Pruning Action`，并要求 dry-run、人类确认、rollback plan。
  - Core 层被明确拆成 `Pure Domain Model` 与 `Core Runtime SDK`。`core` 不依赖 OpenClaw host，但可以拥有 Runtime V2 store/read-model/service/adapter contract，例如 `RuntimeStateManager`、`PainToPrincipleService`、`PainChainReadModel`、`InternalizationOrchestrator`。
  - Internalization 路线统一为三类：Prompt/Skill/SOP、Code/Hook/Tool、Model Parameter/LoRA；不要恢复旧的 SkillFactory-only L3 表述。
- 核查中修复了 Mermaid fence 破损、尾部乱码、trailing whitespace，并整理为单一提交 `37dd24ba docs(architecture): align ontology and system blueprint`。
- 下一步推荐执行 Linear `PRI-75 Prompt Injection SDK Migration Phase 1`：基于 PR #502 Phase 0 inventory，把 5 个零依赖 prompt 构建纯函数迁到 `@principles/core/src/prompt-builder/`，plugin 只保留 OpenClaw I/O 和适配。

## PRI-75 Phase 1 完成 (PR #507 + PR #508 merged 2026-05-07)

- **5 个纯函数**已迁移到 `@principles/core/src/prompt-builder/`：
  - `buildAttitudeDirective(gfi)` — GFI 阈值 attitude directive
  - `detectCorrectionCue(text)` — 中英文纠错 cue 检测（15 个 phrase）
  - `extractMessageContent(message)` — 多格式 message 内容提取
  - `isMinimalTrigger(trigger, sessionId)` — minimal mode 检测
  - `truncateInjectionToBudget(ps, pc, ac, options?)` — size guard + priority stripping
- **新增文件**：attitude-directive.ts / correction-cue.ts / message-extraction.ts / minimal-trigger.ts / size-guard.ts / types.ts / index.ts
- **PR #507**：新增 core prompt-builder primitives；**PR #508**：把 plugin size guard 接入 `truncateInjectionToBudget()`，删除旧内联 priority stripping。
- **测试**：40 个单元测试 + 159 个架构回归测试全部通过
- **未迁移（Phase 2）**：`selectPrinciplesForInjection` / `classifyTask` / empathy / `autoCompressFocus`
- **设计决策**：`truncateInjectionToBudget` 改为 3 string 参数 + 1 options 参数（替代原 PromptInjectionPart[]），preserves prependSystemContext + prependContext

## PRI-75 Phase 2 完成 (PR #510 merged 2026-05-07)

- **3 个纯函数**已迁移到 `@principles/core/src/prompt-builder/`：
  - `formatPrinciple(p)` — principle 格式化
  - `selectPrinciplesForInjection(principles, budgetChars)` — principle 选择
  - `DEFAULT_PRINCIPLE_BUDGET` 常量
- **plugin thin adapter**：`principle-injection.ts` re-export from core，删除了内联 `selectPrinciplesForInjection` 和 `PRIORITY_ORDER`
- **测试**：51 个单元测试 + 架构回归测试全部通过
- **未迁移（Phase 3）**：`classifyTask` / empathy / `autoCompressFocus`

## PRI-75 Phase 3 完成 (PR #511 merged 2026-05-07)

- **路由分类纯逻辑**已迁移到 `@principles/core/src/prompt-builder/routing-guidance.ts`：
  - `RoutingInput` 接口、`RoutingClassification` 类型
  - `READER_KEYWORDS / EDITOR_KEYWORDS / HIGH_ENTROPY_KEYWORDS` 常量
  - `containsKeyword(text, keywords)` / `computeCombinedText(input)` / `classifyTaskKind(input)` / `buildReason` / `buildBlockers`
  - `COMPLEXITY_HINTS` / `MAX_BOUNDED_EDIT_FILES` 常量
- **plugin thin adapter**：`local-worker-routing.ts` 变为 thin adapter，调用 core 纯函数，保留 I/O（getDeployment/isRoutingEnabledForProfile 等）
- **review 修复**：H2 blockers 条件触发、M1 `@deprecated` JSDoc
- **测试**：51 个单元测试 + architecture regression guards 通过

## PRI-74 完成 (PR #512 merged 2026-05-07)

- **review findings 修复**：PRI-75 Phase 3 的 follow-up
  - 恢复 `nocturnal-rollout route --complexity=` 解析
  - `index.ts` 添加 PRI-74 phase comment
  - 更新 route 注释（移除过时的 shadow observation 描述）
  - `local-worker-routing.ts` 明确 pure vs I/O-bound classification categories
  - 删除 architecture-regression.test.ts 内冗余 inline phase comment
