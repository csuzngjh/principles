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
- 当前最后 blocker：修 OpenClaw CLI runtime last-mile，使 `node packages/pd-cli/dist/index.js runtime probe --runtime openclaw-cli --openclaw-local --agent main --workspace D:/.openclaw/workspace --json` 能稳定成功；然后重跑 m8-03 UAT。不要再改 PainSignalBridge/CandidateIntake/ledger 主业务链路，除非 UAT 证明它们有缺陷。
