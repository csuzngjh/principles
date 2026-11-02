# PRI-737 Post-Merge Reality Check

> 日期：2026-09-11
> 基线：`origin/main` `cbee081a6`（PR #1614 合并后）；被审查对象 = PR #1613 合并提交 `764d16e12`
> 性质：**只读审查**。未修改任何源码、未创建 PR、未删除文件、未修复问题、未新建 Linear 工单。
> 前序：`docs/architecture/PRI-737-evolution-worker-reality-audit.md`（删除前复审，判决 DELETE READY）。

---

# Executive Summary

**结论：PASS WITH NOTES**

Evolution Worker 历史链路的物理删除**没有破坏 PD 当前真实运行链路**：

- 仓库构建产物**干净**——合并提交的 `dist/service/` 只含 5 个现役模块，被删的 `evolution-worker` / `queue-io` / `queue-migration` / `workflow-dedup` / `workflow-watchdog` / `subagent-workflow` / `workflow-debug` / `evolution-engine` / `evolution-logger` 均无残留产物。
- 自动化门禁**全绿**：本机 `verify:merge` 两次独立运行均退出码 0（8m06s / 7m33s）；架构回归 + barrel 导出测试 519/519；插件注册 / hook / pain 链测试 71/71；CI 在最新 main 上除一个**先于本 PR 就存在**的失败项外全部 success。
- 浏览器真实用户走查：11 个页面全部正常渲染，**0 条 JS page error、0 条 console error/warning**；API 层 18 条现役路由全部 200，5 条 evolution 时代端点全部 404；侧边栏与页面全文均**无** Evolution Status / 已删除能力入口。
- Runtime-v2 核心链路（reducer / compiler / pain pipeline / principle lifecycle / RuleHost / Activation）**无任何对 Evolution Worker 的依赖**。
- 生产安装面已确认：已安装插件 bundle 中 **不含**旧 worker 专属标识（`writeWorkerStatus` / `processCompilationBackfill` / `registerEvolutionTaskSession` / `EVOLUTION_WORKER_DISABLED` / `workflow-debug` / `initWorkflowSchema` 全为 0 命中）。

遗留问题**均为文档 / 注册表 / 安装叠加层性质的残留**，无 P0、无 P1。其中 3 项判为 P2（误导性文档），其余为 P3（清理性残留、已记录的延后项）。

**建议：可关闭 PRI-737 的删除主交付**，另立一个「PRI-737 残留清理」工单处理 P2/P3 项（详见 §Recommendation）。

---

# Baseline

| 项 | 值 |
| --- | --- |
| 本地 HEAD | `e144d21f9e3121f8c0446335c65375e4726ed2d0`（branch `main`，**落后** origin/main 7 个合并） |
| `git ls-remote origin refs/heads/main` | `cbee081a60980fbb6d6a7c6534f99846036f9354` |
| fetch 后 `origin/main` | `cbee081a60980fbb6d6a7c6534f99846036f9354` |
| 本地 HEAD 是否为 origin/main 祖先 | 是（`merge-base --is-ancestor` = YES） |
| PR #1613 | #1613 `refactor(PRI-737): retire legacy evolution worker chain (phase 1)`，state=MERGED |
| PR #1613 mergedAt | `2026-09-11T12:20:47Z`（20:20 CST） |
| PR #1613 merge commit | `764d16e12bc4b0b20f5930d227ae5d57983f497a` |
| PR #1613 headRefOid | `598a5717d3fe73da7236a8445c0bfb1bcf5d3d43` |
| PR #1613 改动规模 | 97 files changed, +382 / −9704 |
| `764d16e12` → `cbee081a6` 差异 | **仅文档 1 个文件**：`docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` |

**审查方法**：按要求未改动主工作区。源码事实全部通过 `git grep` / `git show` / `git diff` 取自 fetched ref；自动化验证与浏览器验证在独立工作树 `D:\Code\principles-pri737-reality`（checkout 于 `764d16e12`）内执行。因 `764d16e12` 与 `cbee081a6` 差异为纯文档，该工作树的代码面等价于最新 main。

---

# Residual Scan

## A. 分类基线（对照删除前审计的修正 scope）

被删除的生产源码（11 个）：

```
packages/openclaw-plugin/src/commands/workflow-debug.ts
packages/openclaw-plugin/src/core/evolution-engine.ts
packages/openclaw-plugin/src/core/evolution-logger.ts
packages/openclaw-plugin/src/service/evolution-dedup.ts
packages/openclaw-plugin/src/service/evolution-worker.ts
packages/openclaw-plugin/src/service/queue-io.ts
packages/openclaw-plugin/src/service/queue-migration.ts
packages/openclaw-plugin/src/service/subagent-workflow/{subagent-error-utils,types,workflow-store}.ts
packages/openclaw-plugin/src/service/workflow-watchdog.ts
```

**审计要求"不可删"的资产确认未被误删** ✅：`core/evolution-reducer.ts`（修改而非删除）、`core/principle-compiler/*`（未出现在改动清单）、`core/evolution-types.ts`、`runtime-v2/evolution/*`、`workflow-funnel-loader.ts`、`memory/evolution.jsonl`、`trajectory`、`RuleHost`、`Activation` 全部在位。

## B. Residual Reference Matrix

图例：类型 **D**=文档 / **C**=注释 / **R**=运行时生产代码 / **T**=测试 / **X**=安装/发布面 / **B**=构建产物

| 关键词 | 位置 | 类型 | 是否问题 |
| --- | --- | --- | --- |
| `EvolutionWorker` | `MEMORY.md:30-72`（仓库根） | D | ⚠️ **是 P2** — 以现在时描述 "EvolutionWorker 正确设计"、`_startedWorkspaces` 去重、并给出 `grep "EvolutionWorker started for workspace:" ~/.openclaw/.../bundle.js` 的部署验证法；全部已失效，且会被后续会话当作现状读入 |
| `EvolutionWorker` | `docs/runbooks/USER_GUIDE.md:208` / `USER_GUIDE_ZH.md:210` | D | ⚠️ **是 P2** — 对用户声明 `evolution_worker` 是"MVP-Quiet 默认关闭…未来版本会启用"，事实上该能力已被物理删除，不会启用 |
| `EvolutionWorker` | `docs/architecture/ARCHITECTURE.md:121,160-161` | D | ⚠️ **是 P2** — 活动架构文档以现在时列出 `EvolutionWorkerService (src/service/evolution-worker.ts)`，文件已不存在 |
| `EvolutionWorker` | `docs/architecture/COMPONENTS.md:374,559` | D | ⚠️ 是 P3 — 组件清单状态列仍写"退役切换目标"，已切换完成 |
| `EvolutionWorker` | `docs/architecture/CODEX_CLI_ADAPTER_SPEC.md:1037` | D | ⚠️ 是 P3 — 设计文档 scope 仍列该服务 |
| `EvolutionWorker` | `packages/openclaw-plugin/.planning/codebase/ARCHITECTURE.md:79-81` | D | ⚠️ 是 P3 — 包级规划文档仍描述 worker→evolution-engine→trajectory 流程 |
| `EvolutionWorker` | `packages/pd-cli/src/commands/errors-list.ts:10,61` | C | ⚠️ 是 P3 — 头注与类型注仍称 `worker-status.json` 由 EvolutionWorker 写入，与该文件内已更新的 PRI-737 说明自相矛盾 |
| `EvolutionWorker` | `packages/openclaw-plugin/src/index.ts:329-330,628`；`hooks/prompt.ts:360-361`；`scripts/sync-plugin.mjs:444` | C | 否 — 显式记录删除动作，属正确注释 |
| `EvolutionWorker` | `docs/adr/0012`、`docs/adr/0014`、`docs/archive/**`、`docs/audit/**`、`docs/plans/**`、`docs/architecture/PRI-731/736/737-*-audit.md` | D | 否 — 历史 ADR / 归档 / 审计快照，按约定不改写 |
| `EvolutionWorker` | `tests/feature-testing/framework/test-scenarios/{evolution-worker,pain-evolution-chain}.json` | T | ⚠️ 是 P3 — 场景断言 "EvolutionWorker service is active"；`tests/feature-testing` 未接入 CI 或 package.json，属死场景 |
| `evolution_worker` | `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts:240` | R | ⚠️ 是 P3（**已记录的延后项**）— flag 仍在正式契约内（quiet/默认 off）；`packages/openclaw-plugin/src/index.ts:330` 注释明示 "its `evolution_worker` flag entry retires under a separate change" |
| `evolution_worker` | `.../feature-flag-lifecycle.ts:104-111` | R | ⚠️ 是 P3 — lifecycle 退役判据为 2026-12-01；删除前审计已要求 Owner 显式决策 |
| `evolution_worker` | `.../plugin-surface-registry.ts:98,148` | R | ⚠️ 是 P3 — 目录中仍注册 `service:evolution-worker` 与 `startup:evolution-worker` 两个 surface，已无实现。**同文件既有先例**：`nocturnal` / `idle_trigger` 已归入 `category: 'gone'`，`evolution_worker` 未同步 |
| `evolution_worker` | `packages/pd-console/src/ui/utils/enum-labels.ts:96` | R(UI) | ⚠️ 是 P3 — 保留 `'evolution_worker': '进化工作器'` 标签，无消费者；删除前审计 §7.1 已列入 scope |
| `evolution_worker` | `.../feature-flags/__tests__/surface-guard-policy.test.ts:119`、`internalization/__tests__/diag-chain-e2e.test.ts:511` | T | 否 — 夹具引用 |
| `evolution_queue` | `scripts/pipeline-health.ts:61,332,640,769-770,820,966,1010,1239,1287` | R | ⚠️ 是 P3 — 运维诊断脚本仍含 `evolution_queue` 巡检 stage；生产者已删，该 stage 恒为 "not exists"。PR 已把该文件削减 143 行但未清完 |
| `evolution_queue` | `scripts/collect-control-plane-snapshot.sh:114,141,149` / `.ps1:71,109,117` | R | ⚠️ 是 P3 — 两个运维快照脚本仍把 `evolution_queue.json` 纳入控制面证据包；**全仓零引用**（无 CI、无 package.json、无文档提及） |
| `evolution_queue` | `scripts/pipeline-health.ts` 同条；`tests/test_hook_runner_advanced.py:9`、`tests/test_statusline.py:2` | T | ⚠️ 是 P3 — Python 遗留测试仍以 evolution_queue 为夹具 |
| `evolution_engine` | 仅 `docs/architecture/PRI-737-evolution-worker-reality-audit.md:1` | D | 否 ✅ 生产代码零残留 |
| `worker-status` | `packages/host-runtime/src/index.ts:51` → `codex-worker-status.ts` | R | 否 ✅ **同名异义**：Codex CLI worker 状态码，与 Evolution Worker 无关，文件真实存在 |
| `worker-status` | `packages/pd-cli/src/commands/errors-list.ts:151,162-209,358-369,424`；`packages/pd-cli/src/index.ts:1183`；`scripts/pipeline-health.ts:81,425` | R | ⚠️ 是 P3 — 读取路径保留，写入者已随 PR 删除 → `worker-status.json` 成为**永久空读路径**。PR 已正确把"缺失"改为预期稳态（仅解析失败才告警），但读路径本身未退役 |
| `worker-status` | `docs/architecture/PRI-731/736/737-*-audit.md`、`docs/audit/runtime-async-lifecycle-audit-2026-09-09.md` | D | 否 — 审计快照 |
| `workflow-debug` | `packages/openclaw-plugin/tests/index.test.ts:138` | T | 否 ✅ **正向证据**：该断言逐条验证 `/pd-workflow-debug` 已从 help 文本移除 |
| `workflow-debug` | `docs/architecture/{CODEX_CLI_ADAPTER_SPEC,COMPONENTS,PD_SYSTEM_ARCHITECTURE}.md` | D | ⚠️ 是 P3 — 文档仍列该命令（PRI-737 审计文档除外） |
| `workflow-debug` | pd-cli 命令注册表 | R | 否 ✅ 全仓无 `workflowDebug` 命令注册 |
| `subagent_workflows` | `packages/pd-cli/src/commands/runtime-init.ts:7,294-296` | C | 否 ✅ — 注释明确说明 db 初始化已随 PRI-737 移除、旧库保留不动 |
| `subagent_workflows` | `scripts/pipeline-health.ts:85-87,99,1071-1102` | R | ⚠️ 是 P3 — 仍对冻结库（live mtime 2026-05-13）做 TTL/active/stale 巡检 |
| `compilationRetryCount` | `.../runtime-v2/types/ledger-store.ts:22`、`types/principle-schema.ts` | R | 否 ✅ — 契约字段**有意保留**（PRI-459 富 schema 对齐）；仅 `ledger-store.ts:12` 注释仍以 evolution-worker 为消费者举例，属 P3 级陈述陈旧 |
| `compilationRetryCount` | `packages/openclaw-plugin/src/core/evolution-reducer.ts:433,442-443` | C | 否 ✅ — 注释已按审计 §7.1 更新为 "Compilation is single-attempt"，幽灵重试环措辞已消除 |
| `compilationRetryCount` | `tests/core/evolution-reducer.compilation-retry.test.ts`、`principle-tree-ledger.roundtrip.test.ts` 等 | T | 否 |

## C. 未被关键词覆盖、但属删除面的孤儿

| 位置 | 类型 | 判定 |
| --- | --- | --- |
| `packages/openclaw-plugin/src/types/queue.ts` | R | ⚠️ P3 — 纯 re-export barrel（`@principles/core/runtime-v2` 的 QueueItemId/WorkflowId 等），**全仓零 import**（src + tests 均为 0 命中） |
| `packages/website/.vitepress/theme/components/EvolutionMenu.vue` | R(站点) | ⚠️ P3 — 站点导航组件，**零引用** |
| `scripts/migrate-to-evolution-points.ts` | R | ⚠️ P3 — 一次性迁移脚本，保留态 |
| `packages/pd-cli/src/commands/evolution-tasks-list.ts` / `-show.ts` + `principles-core/src/evolution-store.ts` | R | ⚠️ P3（**已记录延后项**）— 只读消费已冻结的 `trajectory.db.evolution_tasks` 表；删除前审计 §7.3-3 明确列为数据保留政策 follow-up |
| `packages/principles-core/src/runtime-v2/evolution/*` | R | 否 — 审计明确的共享类型资产 |
| `~/.pd/runtime/plugin/dist/**`、`~/.openclaw/extensions/principles-disciple/dist/**` | X | ⚠️ P3 — 见 §Issues P3-6 |

---

# Core Dependency Integrity

Runtime-v2 无对 Evolution Worker 的依赖。确认项：

| 断言 | 证据 |
| --- | --- |
| reducer 完好 | `packages/openclaw-plugin/src/core/evolution-reducer.ts` 在位且被修改（非删除）；`RUNTIME_V2_NO_NOCTURNAL_TRINITY_IMPORT` 用例通过 |
| principle-compiler 完好 | `core/principle-compiler/{compiler,code-validator,ledger-registrar,template-generator,index}.ts` 全在位，未出现在 PR 改动清单 |
| pain pipeline 完好 | `runtime-v2/pain-ingress.ts`、`pain-signal-bridge.ts`、`pain-signal-runtime-factory.ts`、`pain-to-principle-service.ts`、`pain-gate/`、`pain-chain-read-model.ts` 全在位；`pain-signal-runtime-factory.ts:39` 仍是 `WorkflowFunnelLoader` 的真实消费者（该模块非孤儿） |
| principle lifecycle 完好 | `runtime-v2/activation/{activation.ts,approval-queue.ts}`、`lifecycle` 路由在位；isolated console `/api/v1/activations` 返回 1 条激活事实 |
| RuleHost / Activation 未受影响 | 生产库 `principle_applications` 最新记录 `2026-09-11T13:54:04Z`（= 21:54 CST，**晚于 PR #1613 合并 20:20 CST**），证明应用/回执链在合并后仍在产出 |
| 无编译期悬挂引用 | `verify:merge`（含 `build` 全链 + 3 个 typecheck）退出码 0；CI `Build OpenClaw Plugin` / `TypeScript Check (pd-console)` / `Release Build Parity` 均 success |
| 构建产物无孤儿 | 见 §Residual Scan 与 §Automated Verification |

**明确未误删**（Phase 2 禁列项全数在位）：`evolution-reducer`、`principle-compiler`、`memory/evolution.jsonl`（live 最后写入 2026-09-09，Runtime-v2 活流）、`trajectory.db`（live mtime 2026-09-11 22:24，活跃）、`RuleHost`、`Activation`。

---

# Automated Verification

## 1. CI（最新 main `cbee081a6`，权威门禁）

`gh api .../commits/cbee081a6/check-runs` → 25 项：**23 success / 1 failure / 2 skipped**（skipped 为 `PR <-> Linear link`、`CI failure reminder`，按设计跳过）。

success 项含：`Verify Merge Gate`、`Lint`、`Build OpenClaw Plugin`、`Release Build Parity`、`TypeScript Check (pd-console)`、`Test principles-core` / `pd-cli` / `pd-console` / `pd-companion` / `host-runtime` / `codex-adapter` / `scripts` / `create-principles-disciple`、`Test OpenClaw Plugin (unit)` / `(integration)` / `(coverage)`、`Test host runtime parity`、`Test packaged install smoke`、`Test release asset smoke`、`Analyze (javascript-typescript)`。

**唯一 failure：`Nocturnal Pipeline Regression Test`（workflow `E2E Regression Test`）**

- 失败内容：`pd-cli` 的 `src/update/**`（TUF 发布链）编译错误——`error TS2591: Cannot find name 'node:fs' / 'Buffer' / 'console'`、`TS2307: Cannot find module '@tufjs/models'`、`TS2307: Cannot find module 'tuf-js'`，`Process completed with exit code 2`。
- **判定：与本 PR 无关，属先存在的基线红灯。** 该 workflow 最近 **10 次 push 全部失败**（#1605→#1614，横跨本 PR 前后），失败文件全部落在 `src/update/*`，与 Evolution Worker 删除面（`openclaw-plugin/service`、`pd-cli runtime-init/errors-list`）无交集。PR #1613 合并提交 `764d16e12` 自身的该 job 亦为 failure，且失败签名与 #1612 等前序提交一致。
- 参见项目既有基线注释：TUF 签名链（`trust-metadata*`、`release-manager*`）为已知问题域。

## 2. 本机 `verify:merge`（独立工作树 @ `764d16e12`）

| 轮次 | 命令 | 耗时 | 退出码 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `npm run verify:merge` | 8m06s（22:06:59→22:15:04） | **0 ✅** | 完整覆盖：6 项 `check:*` + release-target-matrix + core build + test:website + lint + build + pd-cli build + 3 个 typecheck |
| 2 | 同上（审查者调整 node_modules 解析后） | 7m20s | 2 ❌ | 失败于 `pd-cli tsc`：`TS2307 Cannot find module 'principles-disciple'`——**审查者自建的目录联接指向了主检出中的符号链接，Windows 不穿透链式重解析点**，属环境自伤，非代码缺陷 |
| 3 | 同上（修正联接直指工作树包后） | 7m33s（22:35:40→22:43:12） | **0 ✅** | 复核轮；与轮 1 结论一致 |

> 说明：轮 1 与轮 3 针对**同一份源码**（`764d16e12`），均退出码 0。轮 2 的失败已定位为审查工具链问题（自建目录联接指向主检出中的符号链接，Windows 不穿透链式重解析点，导致 `pd-cli` 无法解析 workspace 包 `principles-disciple`）并在轮 3 前修正，**不构成对 PR 的任何指控**。CI 在同一提交上的 `Verify Merge Gate` + `Build` 全绿，与轮 1/轮 3 一致。

## 3. 定向测试

| 测试 | 命令 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 架构回归 + barrel 导出 | `npx vitest run src/runtime-v2/__tests__/architecture-regression.test.ts src/runtime-v2/__tests__/barrel-io-cleanup.test.ts`（packages/principles-core） | **519 passed / 2 files** ✅ | 17.5s |
| 插件注册 / host-runtime 注册 / pain hook / auto-entry gate | `npx vitest run tests/index.test.ts tests/host-runtime-registration.test.ts tests/hooks/pain.test.ts tests/integration/auto-entry-gate.test.ts`（packages/openclaw-plugin） | **71 passed / 4 files** ✅ | 9.1s（重跑 18s） |

其中 `architecture-regression.test.ts` 含 `RUNTIME_V2_NO_NOCTURNAL_TRINITY_IMPORT`（断言 runtime-v2 不得 import 宿主体）与 `exports PainToPrincipleService`，均通过。

---

# User Simulation

## 1. PD Console 浏览器走查（真实 Owner 路径，非 CLI）

隔离副本 + 独立实例（未触碰线上运行时）：

- 工作区副本：`tmp/pri737-reality/workspace`（`state.db` + `config.yaml` + `principle_training_state.json` 自 `D:\.openclaw\workspace` 拷出）
- 实例：`packages/pd-console` `npx tsx src/server/index.ts --port 3199 --workspace <副本> --no-auth`，**由合并提交源码启动**（前端 `npm run build:ui` 重出）

**页面加载**：11 条实际路由全部渲染成功，无空白页、无重定向到 login/splash。

| 路由 | 页面 | 结果 |
| --- | --- | --- |
| `#/focus` | 治理焦点 | ✅ 渲染「需要你决定 · 2」+ 2 条 rollout_review 卡片 |
| `#/pain` | 行为证据 | ✅ |
| `#/principles` | 原则审查（含 `#/principles/core`） | ✅ |
| `#/activation` | 生效情况 | ✅ 「1 条已激活 / 0 条未激活」 |
| `#/control-center` | 控制中心 | ✅ 4 阶段行为回路图（发现错误→形成原则→拥有者审批→改变行为）+ 就绪态「已启用 9/10，核心管道 正常」 |
| `#/failed-tasks` | 失败任务 | ✅ |
| `#/debt` | 原则债务 | ✅ |
| `#/intent` | 拥有者意图 | ✅ |
| `#/settings` | 设置 | ✅ |
| `#/update` | 更新 | ✅ |

**JS 错误**：`agent-browser errors` → **空**；`agent-browser console` 全量过滤 error/warn/fail → **空**。

**API 层（权威证据）**：18 条现役路由全部 `200` 且 `success:true`：

```
/api/health, /api/principles, /api/principles/core, /api/workspaces, /api/update/history,
/api/v1/governance/experience, /api/v1/governance/queue, /api/v1/governance/owner-decisions,
/api/v1/approvals/grouped, /api/v1/approvals, /api/v1/failed-tasks, /api/v1/activations,
/api/v1/receipts/counts, /api/v1/evidence-chain, /api/v1/owner-identity, /api/v1/intent,
/api/v1/intent-decisions/summary, /api/v1/config/summary
```

**已删除能力端点（应 404）**：全部 `404 not_found` ✅

```
/api/v1/evolution/status, /api/v1/evolution/worker, /api/v1/evolution-queue,
/api/v1/worker/status, /api/v1/workflow-debug
```

**入口泄漏检查**：
- 侧边栏 = 治理焦点 / 行为证据 / 原则审查 / 生效情况 / 原则债务 / 拥有者意图 + 控制中心 / 产品反馈 / 失败任务 / 设置 / 更新 —— 无 Evolution Status，无 workflow-debug。
- `App.tsx` 路由表 18 条，无 evolution/worker 路由。
- 控制中心页面全文（4085 字符）grep `evolution|worker|进化|工作器|workflow-deb` → **0 命中**。
- `/api/health` 的 `overall=error` 来自副本快照的 `pain_chain_flow: 超过 14502 分钟无活动`（拷贝的是 09-09 的静态库，非活跃库），**不是回归**。

## 2. OpenClaw / 插件使用验证

**可验证方式的取舍（需明确说明）**：本机 `~/.pd/runtime` 与 `~/.openclaw/extensions/principles-disciple` 属安装器所有，按 AGENT.md §1.1 硬规矩不可改动，因此**未对其做任何写入或热替换**。改为按「已安装面只读取证 + 合并源码构建产物验证」两条独立证据链：

**(a) 已安装生产面（只读）**——已安装插件 `1.235.0`，`~/.openclaw/workspace/.pd/update-history.json` 记录 `1.233.0 → 1.235.0` 更新于 `2026-09-11T14:09:35Z`（22:09 CST，**晚于 #1613 合并**）。对已安装 bundle 做关键词探针：

```
dist/bundle.js:  writeWorkerStatus=0  processCompilationBackfill=0
                 registerEvolutionTaskSession=0  EVOLUTION_WORKER_DISABLED=0
                 workflow-debug=0  initWorkflowSchema=0
```

→ 已安装产物中**不含**任何旧 worker 实现/入口，且含 `dist/utils/trace-id.d.ts`（PRI-737 才引入的搬迁产物）。

**(b) 合并源码构建产物**——工作树 `packages/openclaw-plugin/dist/service/` 干净：仅 `correction-observer-service`、`internalization-auto-consumer-service`、`keyword-optimization-service`、`phase3-input-filter`、`trajectory-service` 五个现役模块（`.js` + `.d.ts`），被删模块零残留。

**(c) 插件注册与 hook**——`tests/index.test.ts`（12）、`tests/host-runtime-registration.test.ts`（5）、`tests/hooks/pain.test.ts`（46）、`tests/integration/auto-entry-gate.test.ts`（8）共 71 用例全绿，覆盖 plugin 注册、host-runtime 注册、pain hook 判定与 auto-entry 门。CI 另有 `Test OpenClaw Plugin (unit/integration/coverage)` + `Test host runtime parity` success。

**结论**：插件加载 / hook 链 / runtime 连接在合并后源码与已安装产物两侧均正常，且已安装 bundle 已包含删除后的代码。

**未能执行的部分（如实记录）**：未启动一次真实的 OpenClaw Agent 端到端会话。原因：真实会话只能由安装态运行时承载，而安装态不可改动；在合并源码上发起真实会话需要重装/切换安装布局，超出本只读审查授权。上述 (a)(b)(c) 三条证据链覆盖了该路径的同一组断言（产物无残留、注册成功、hook 正常）。

## 3. 核心链路 Pain → Diagnosis → Principle → Activation

**未人为制造真实 Pain。** 原因：Pain 的产生依赖宿主 Agent 真实交互中的行为偏差事件（`code_tool_hook` / `prompt` 通道），本审查全程只读、不改配置、不重装，因而无法在不触碰生产运行时的前提下构造。

**改为对生产数据的只读取证**（`D:\.openclaw\workspace\.pd\state.db`，`readonly` 打开）：

| 链路环节 | 表 | 计数 | 最新时间 |
| --- | --- | --- | --- |
| Diagnosis | `pain_diagnoses` | 0 | — |
| Diagnosis(死信) | `dead_letter_pains` | 0 | — |
| Principle | `principle_candidates` | 42 | 2026-09-09T02:14:16Z |
| Principle | `pi_artifacts` | 162 | 2026-09-09T02:39:47Z |
| Approval | `approvals` | 0 | — |
| **Activation** | `activations` | 1 | — |
| **Activation→应用** | `principle_applications` | **178** | **2026-09-11T13:54:04Z** |
| Task | `tasks` | 198 | 2026-09-09T02:37:35Z |

`principle_applications` 的时间戳 **13:54:04Z = 21:54 CST**，晚于 PR #1613 合并（20:20 CST）与最新 main 推送（21:34 CST）；`activation_control_states` / `activation_decisions` / `activation_evidence_snapshots` 均为 0（该工作区未使用这些更细粒度的控制面表）。`activations` = 1 与 Console `/api/v1/activations`、`/api/v1/receipts/counts`（`effectCount` 最高 11、`presenceCount` 166）互相印证。

**判定**：链路的 Principle → Activation → 应用回执段在合并后**仍在产出真实数据**；Pain → Diagnosis 段因缺少新 Pain 事件而无新增记录，且 `pain_diagnoses` 为空是删除前的既有状态（审计已记录 worker 主动丢弃 `pain_diagnosis` 队列项、Runtime-v2 走 `PainSignalBridge → SplitDiagnosticianRunner`），**不由本次删除引起**。

---

# Issues Found

无 P0、无 P1。以下 P2/P3 均为**记录项**（本任务只读，未修复）。

## P2-1 · 仓库根 `MEMORY.md` 以现在时描述已删除的 Evolution Worker

- **位置**：`MEMORY.md:30-72`
- **复现**：`git grep -n EvolutionWorker origin/main -- MEMORY.md` → 5 命中，含 "EvolutionWorker 正确设计 (PR #290 已实现)"、"`EvolutionWorkerService._startedWorkspaces` 去重"、部署验证 `grep "EvolutionWorker started for workspace:" .../bundle.js`
- **影响**：仓库根记忆文件是后续 AI 会话的高权重上下文。它现在会主动引导新会话相信该服务存在并可 grep 验证——这正是删除前审计要消除的「两代进化架构并存」误判（PRI-731 已记录两起真实误判案例）。**认知成本高于普通文档陈旧**。
- **证据**：`src/service/evolution-worker.ts` 已不存在；`grep class EvolutionWorkerService bundle.js` = 0。

## P2-2 · 用户手册向 Owner 承诺一个已被删除、不会再启用的能力

- **位置**：`docs/runbooks/USER_GUIDE.md:208`、`docs/runbooks/USER_GUIDE_ZH.md:210`
- **复现**：`git grep -n evolution_worker origin/main -- docs/runbooks/`
- **原文**：EN "Some subsystems (such as `evolution_worker` and `correction_observer`) are **default OFF** by design (MVP-Quiet, ADR-0014)… They will be enabled in a future release once seed-customer evidence justifies broader activation."（中文同义）
- **影响**：Owner 会按手册期待该子系统未来被启用；实际它已被物理删除。这是**面向用户的错误承诺**。

## P2-3 · 活动架构文档仍把 EvolutionWorkerService 列为现役组件（含不存在的文件路径）

- **位置**：`docs/architecture/ARCHITECTURE.md:121`（`Pain Signals → EvolutionWorker (background)`）、`:160-161`（`EvolutionWorkerService (src/service/evolution-worker.ts)`，描述"每 90 秒扫描"）
- **复现**：`git show origin/main:docs/architecture/ARCHITECTURE.md | sed -n '118,162p'`；`git ls-tree origin/main -- packages/openclaw-plugin/src/service/evolution-worker.ts` → 空
- **影响**：`ARCHITECTURE.md` 是新人/新会话理解 PD 的第一入口；它指向一个不存在的文件并描述一个不存在的后台周期。

## P3-1 · `scripts/pipeline-health.ts` 仍巡检三个无生产者的死对象

- **位置**：`:61`(`evolution_queue.json`)、`:81`(`worker-status.json`)、`:85-87,99,1071-1102`(`subagent_workflows.db`)、`:332,425,640,769-770,820,966,1010,1239,1287`
- **影响**：诊断脚本会恒常输出 "not exists" 的降级信号；运维者可能误判为管道异常。PR 已削减该文件 143 行但未清完（删除前审计 §7.1 曾把 `:61-63` 列入 scope）。

## P3-2 · `worker-status.json` 读取路径保留但写入者已删（永久空读）

- **位置**：`packages/pd-cli/src/commands/errors-list.ts:151,162-209,358-369`；`scripts/pipeline-health.ts:81,425`
- **现状**：PR 已把"文件缺失"从告警降级为预期稳态（改得正确），但读取路径与 `workerStatusPath` 字段仍对外暴露一个永不存在的产物。
- **影响**：`pd errors list` / pipeline-health 的 `workerStatusPath` 是死引用。低危，属清理项。

## P3-3 · 孤儿文件与零引用脚本

| 路径 | 零引用证据 |
| --- | --- |
| `packages/openclaw-plugin/src/types/queue.ts` | `git grep -n "types/queue"` 在 `packages/openclaw-plugin/{src,tests}` → 无命中 |
| `packages/website/.vitepress/theme/components/EvolutionMenu.vue` | `git grep -n EvolutionMenu -- packages/website` → 无命中 |
| `scripts/collect-control-plane-snapshot.sh` / `.ps1` | `git grep -n collect-control-plane-snapshot`（排除自身）→ 无命中；且仍把 `evolution_queue.json` 纳入证据包 |
| `tests/feature-testing/framework/test-scenarios/{evolution-worker,pain-evolution-chain}.json` | `git grep -n feature-testing -- package.json .github packages/*/package.json` → 无命中（该框架未接线） |
| `tests/test_hook_runner_advanced.py`、`tests/test_statusline.py` | Python 遗留测试，仍以 `evolution_queue` 为夹具 |
| `scripts/migrate-to-evolution-points.ts` | 一次性迁移脚本 |

## P3-4 · `evolution_worker` flag 与三个注册表条目未同步退役（**已记录的延后项**）

- **位置**：`feature-flag-contract.ts:240`、`feature-flag-lifecycle.ts:104-111`、`plugin-surface-registry.ts:98,148`、`pd-console/src/ui/utils/enum-labels.ts:96`
- **现状**：flag 无任何运行时消费者；surface registry 中 `service:evolution-worker` / `startup:evolution-worker` 无对应实现；控制台保留"进化工作器"标签。PR 在 `src/index.ts:330` 明示延后。
- **参照先例**：`nocturnal` 与 `idle_trigger` 已归入 `category: 'gone'`，`evolution_worker` 仍留在 `quiet`。
- **治理约束**：lifecycle 退役判据为 2026-12-01；删除前审计要求 Owner 在 lifecycle 条目中记录显式提前退役决策。**本项不构成对 #1613 的缺陷指控**——延后是 PR 明确声明的范围决定。

## P3-5 · 冻结数据面的只读消费面保留（**已记录的延后项**）

- **位置**：`packages/pd-cli/src/commands/evolution-tasks-list.ts` / `-show.ts`、`principles-core/src/evolution-store.ts`（消费已冻结的 `trajectory.db.evolution_tasks`）
- **依据**：删除前审计 §7.3-3 明确"属数据保留政策，单独立项"。

## P3-6 · 安装布局保留被删模块的孤儿类型声明（overlay 更新不删除文件）

- **位置**：`~/.pd/runtime/plugin/dist/service/` 与 `~/.openclaw/extensions/principles-disciple/dist/service/` 仍含 `evolution-worker.d.ts`、`evolution-dedup.d.ts`、`queue-io.d.ts`、`queue-migration.d.ts`、`workflow-watchdog.d.ts`；`dist/core/` 含 `evolution-engine.d.ts`、`evolution-logger.d.ts`；`dist/commands/` 含 `evolution-status.d.ts`；`dist/service/runtime-summary-service.d.ts`（PRI-736 已删）；`dist/service/subagent-workflow/` 目录
- **对比证据**：合并提交的**干净构建**产物 `packages/openclaw-plugin/dist/service/` 只有 5 个现役模块，无任何上述声明 → **仓库侧干净**。
- **归因**：目录基线 mtime 为 2026-09-06 21:13（早于 PRI-736/737），今日 22:09 的 `1.235.0` 更新为**叠加式**刷新（仅 `dist/utils/` 目录项变动）。安装器不删除已移除文件，故旧声明留存。
- **附加观察**：`packages/openclaw-plugin/package.json` 的 `scripts.clean` **未定义**，`prepack = build:production && build:types` 无 clean 步骤。CI 全新 checkout 下产物干净（已验证），但**非干净的本地发布**会把上次 `tsc --emitDeclarationOnly` 的孤儿 `.d.ts` 一并打包。
- **影响**：已安装 bundle 行为正确（关键词探针全 0），孤儿 `.d.ts` 不参与运行时；风险为 Install-layout 组件清单漂移与后续取证误判（该项目「组件清单无单一事实源」问题域已复发 3 次）。
- **性质**：非本 PR 引入（基线早于本 PR），属安装/发布路径的既有模式；建议单独立项，不阻断本工单。

## 观察项（非缺陷）· main 上先存在的 CI 红灯

`E2E Regression Test / Nocturnal Pipeline Regression Test` 在最近 **10 次 push 上连续失败**（#1605–#1614），失败根因为 `packages/pd-cli/src/update/**`（TUF 发布链）的 `TS2591` / `TS2307`（缺 `@types/node`、`tuf-js`、`@tufjs/models`），与 Evolution Worker 删除面零交集。已确认**不由 PR #1613 引起**。建议作为独立的 CI 修复工单处理（本任务不新建工单）。

---

# Recommendation

1. **PRI-737 的删除主交付可以关闭（Close PRI-737）。**
   依据：删除面在仓库、构建产物、已安装 bundle 三处均已生效且无残留实现；`verify:merge` 退出码 0；CI 全部相关 job success；浏览器真实用户走查 11 页零错误、零能力入口泄漏；Runtime-v2 核心链路在合并后仍产出真实数据（`principle_applications` 21:54 CST）。

2. **创建 1 个后续工单「PRI-737 残留清理」（建议 P2 优先级）**，条目按 §Issues 逐项落地，其中 P2-1/P2-2/P2-3 是价值最高的三项（消除误导性当前态描述，收回审计所追求的认知收益）：
   - 改写 `MEMORY.md` 的 Evolution Worker 章节为历史注记 / 移除
   - 更正 `docs/runbooks/USER_GUIDE{,_ZH}.md` 对 `evolution_worker` 的承诺
   - 更新 `docs/architecture/ARCHITECTURE.md` §4 / §组件表，删除不存在的文件路径
   - 清理 `pipeline-health.ts` 死对象巡检、`worker-status.json` 读路径、孤儿脚本/组件/场景
   - 把 `evolution_worker`（含 surface-registry 两条目 + 控制台标签）并入 `category: 'gone'`，并在 lifecycle 条目记录 Owner 提前退役决策（对齐 2026-12-01 判据）

3. **另立 1 个 Install/Release 路径工单（P3）**：处理 §P3-6 的安装叠加层孤儿声明，并评估给 `openclaw-plugin` 增加 `clean` 步骤或让安装器对已移除文件做差集清理。此项属既有模式，与 PRI-737 无因果关系。

4. **继续观察，不阻断**：
   - `Nocturnal Pipeline Regression Test`（先存在，需独立修复）
   - 冻结数据面（`trajectory.db.evolution_tasks`、`subagent_workflows.db`、`evolution_queue.json`）按 `DATA_CLEANUP_GUIDELINES` 走 Owner 决策，本审查未触碰。

5. **不建议因本次审查回滚或补丁式修补 PR #1613。** 未发现需要修复的正确性缺陷。

---

# 附：关键取证命令（可复现）

**证据归档**：`D:\Code\pri737-evidence\`（`api-snapshot.json` + 11 张页面截图 + 控制中心全文 dump）；验证用独立工作树保留在 `D:\Code\principles-pri737-reality`（分支 `pri737-reality` @ `764d16e12`），供复核后自行移除。

```bash
# ── 基线 ──────────────────────────────────────────────
git ls-remote origin refs/heads/main
git fetch origin main && git rev-parse origin/main
git merge-base --is-ancestor e144d21f9 origin/main && echo YES
git log -1 --format='%H%n%ad%n%s' 764d16e12
git diff --name-only 764d16e12 cbee081a6            # 仅 1 个文档文件

# ── 残留扫描（基于 origin/main，不改主工作区）──────────
git grep -c -I -i -e EvolutionWorker -e evolution_worker -e evolution_queue \
  -e evolution_engine -e worker-status -e workflow-debug \
  -e subagent_workflows -e compilationRetryCount origin/main
git grep -n -I -i -e EvolutionWorker -e evolution_worker -e worker-status \
  origin/main -- 'packages/*/src/**' 'packages/*/scripts/**' 'scripts/**'
git grep -n "types/queue"          origin/main -- packages/openclaw-plugin   # 零消费者
git grep -n "collect-control-plane-snapshot" origin/main -- .               # 零引用
git grep -n class                  -- dist                                  # 产物侧零残留

# ── 构建产物干净性（工作树 @ 764d16e12）─────────────────
ls packages/openclaw-plugin/dist/service/          # 仅 5 个现役模块

# ── 已安装面只读探针（严禁写入）─────────────────────────
ls ~/.pd/runtime/plugin/dist/service/ | grep -i evolution    # 孤儿 .d.ts
grep -c writeWorkerStatus   ~/.openclaw/extensions/principles-disciple/dist/bundle.js   # 0
grep -c EVOLUTION_WORKER_DISABLED <同上>                                                # 0
grep -c initWorkflowSchema  <同上>                                                      # 0

# ── 自动化 ────────────────────────────────────────────
export npm_config_script_shell="C:/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin/bash.exe"
export CODEBUDDY_SAFE_DELETE_ENABLED=0 SAFE_DELETE_ENABLED=0
npm run verify:merge                                # EXIT=0, 8m06s
npx vitest run src/runtime-v2/__tests__/architecture-regression.test.ts \
              src/runtime-v2/__tests__/barrel-io-cleanup.test.ts        # 519 passed

# ── 浏览器 / API ──────────────────────────────────────
agent-browser open "http://127.0.0.1:3199/#/control-center"
agent-browser errors ; agent-browser console
curl -s http://127.0.0.1:3199/api/v1/evolution/status    # 404 not_found（预期）
```
