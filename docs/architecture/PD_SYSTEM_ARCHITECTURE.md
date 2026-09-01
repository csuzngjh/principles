# PD 系统架构（System Architecture）

> **状态**: Active（2026-05-15 重写版）
> **最后更新**: 2026-05-15
> **取代**: 2026-05-09 版（已归档到 `archive/`）
> **关联**: 本文档是 [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) 的**结构补充**，专注于物理结构、依赖关系、部署形态。

> **2026-05-23 修订**: [ADR-0012](../adr/0012-runtime-v2-standalone-scheduling-and-legacy-retirement.md) 将 Runtime V2 定为唯一 forward execution path。本文后续提到的 `IdleTrigger`、OpenClaw idle/night scheduling、`sleep-cycle` 或 Nocturnal execution 均是待删除 legacy 状态，不是待实现能力。OpenClaw 仅保留 hook/runtime adapter 职责；PD 配置与调度属于 PD-owned SDK/operator 边界。

> **阅读顺序建议**：先读 `PD_ARCHITECTURE_OVERVIEW.md` 了解全局视图；再读本文档了解物理结构；最后读 `COMPONENTS.md` 查具体组件。

---

## 1. 文档定位

`PD_ARCHITECTURE_OVERVIEW.md` 回答**"PD 是什么、由什么构成、数据怎么流"**。

本文档回答更具体的问题：

- 包之间的物理依赖是什么样的？
- 各个层级具体有哪些代码目录？
- 进程模型是什么？
- 部署形态是什么？
- 我新增一个文件应该放哪里？

---

## 2. 包结构（Package Topology）

### 2.1 monorepo 结构

```
principles/                         （工作区根目录）
├── packages/
│   ├── principles-core/            ← @principles/core
│   ├── openclaw-plugin/            ← principles-disciple
│   ├── pd-cli/                     ← @principles/pd-cli
│   ├── pd-console/                 ← @principles/pd-console
│   └── create-principles-disciple/ ← 安装脚手架
├── docs/                           ← 文档
├── scripts/                        ← 构建/运维脚本
├── ops/                            ← 运维相关
├── tests/                          ← 跨包集成测试
├── package.json                    ← 根 package（pnpm workspace）
└── pnpm-workspace.yaml
```

### 2.2 各包公开 API 与外部依赖

| 包 | npm 名 | 私有 | 公开导出 | 主要外部依赖 |
|----|-------|-----|---------|------------|
| principles-core | `@principles/core` | 否 | 见 `src/index.ts` + `runtime-v2/index.ts` | `@sinclair/typebox`, `better-sqlite3`, `glob` |
| openclaw-plugin | `principles-disciple` | 否（npm 发布） | OpenClaw plugin 入口 | `@principles/core`, OpenClaw plugin SDK |
| pd-cli | `@principles/pd-cli` | 是 | CLI 二进制 | `@principles/core` |
| pd-console | `@principles/pd-console` | 是 | Web Server | `@principles/core`, React, Tailwind |
| create-principles-disciple | `create-principles-disciple` | 否 | npm init scripts | 无 PD 内部依赖 |

### 2.3 依赖关系（强约束）

```
              ┌─────────────────────────────────┐
              │       @principles/core          │
              │  (Domain & Runtime)             │
              │                                 │
              │  - Schemas                      │
              │  - Stores (SQLite + JSON)       │
              │  - Runners                      │
              │  - Bridges                      │
              │  - Read Models                  │
              │  - Adapters interface           │
              └────────────────┬────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
            ▼                  ▼                  ▼
   ┌────────────────┐ ┌──────────────┐ ┌────────────────┐
   │openclaw-plugin │ │ pd-cli       │ │ pd-console     │
   │(Host Adapter)  │ │ (for Agent)  │ │ (for Human)    │
   │                │ │              │ │                │
   │ - Hooks        │ │ - Commands   │ │ - Web Server   │
   │ - Hook adapter  │ │ - JSON IO    │ │ - React UI     │
   │ - OpenClaw API │ │              │ │ - Approval UI  │
   └────────────────┘ └──────────────┘ └────────────────┘
```

**强约束（架构守护测试）**：

| 规则 | 描述 |
|-----|------|
| R1 | `@principles/core` **不得**依赖任何其他 PD 包 |
| R2 | `openclaw-plugin` **不得**依赖 `pd-cli` 或 `pd-console` |
| R3 | `pd-cli` **不得**依赖 `pd-console` 或 `openclaw-plugin` |
| R4 | `pd-console` **不得**依赖 `pd-cli` 或 `openclaw-plugin` |
| R5 | 三个 surface 包共用 `@principles/core` 的 Store / ReadModel / Service，但通过文件并发同步（SQLite + 原子写入） |

---

## 3. 四层架构（详细映射）

### 3.1 Layer 1: Foundation（基础层）

**位置**：`@principles/core/src/`（部分顶层 + `runtime-v2/`）

```
packages/principles-core/src/
├── pain-signal.ts                 ← Schema（内部模块，PRI-636 起不再公开导出）
├── telemetry-event.ts             ← Schema（内部模块，PRI-636 起不再公开导出）
├── pain-signal-adapter.ts         ← Adapter interface（内部模块，PRI-636 起不再公开导出）
├── principle-tree-ledger.ts       ← Store（JSON）
├── trajectory-store.ts            ← Store
├── workflow-funnel-loader.ts      ← Util
├── adapters/                      ← Adapter 接口（domain）
├── prompt-builder/                ← Util 集合
└── runtime-v2/                    ← 主体（见下文）
    ├── error-categories.ts        ← Schema
    ├── schema-version.ts          ← Schema
    ├── agent-spec.ts              ← Schema
    ├── runtime-protocol.ts        ← Schema
    ├── task-status.ts             ← Schema
    ├── context-payload.ts         ← Schema
    ├── diagnostician-output.ts    ← Schema
    ├── candidate-intake.ts        ← Schema + Service
    ├── candidate-intake-service.ts← Service
    ├── golden-trace.ts            ← Schema
    └── store/                     ← Store 实现集合
        ├── sqlite-connection.ts
        ├── runtime-state-manager.ts
        ├── task/
        ├── run/
        ├── commit/
        ├── candidate/
        ├── artifact/
        ├── history/
        ├── trajectory/
        ├── context/
        ├── lifecycle/
        └── event-emitter.ts
```

**禁止内容**：
- 任何 `setInterval` / `cron` / `setTimeout` 用于业务调度
- 任何对 OpenClaw / Codex / Gemini 等具体平台 API 的调用
- 任何 UI / HTTP server 代码

### 3.2 Layer 2: Domain Services & Runners（领域服务层）

**位置**：`@principles/core/src/runtime-v2/`（剩余部分）

```
runtime-v2/
├── pain-signal-bridge.ts            ← Bridge
├── pain-to-principle-service.ts     ← Service
├── pain-signal-runtime-factory.ts   ← Factory
├── pain-signal-observability.ts     ← Service
├── pain-chain-read-model.ts         ← ReadModel
├── pain-to-principle-service.ts     ← Service
├── runtime-selector.ts              ← Service
├── pruning-read-model.ts            ← ReadModel
├── pruning-mask.ts                  ← Util
├── pruning-review-log.ts            ← Store
├── operator-health-read-model.ts    ← ReadModel
├── candidate-audit.ts               ← Util
├── control-plane-triage.ts          ← Util
├── schema-conformance-read-model.ts ← ReadModel
├── internalization-queue-read-model.ts        ← ReadModel
├── internalization-chain-integrity-read-model.ts ← ReadModel
├── internalization-integrity-remediation.ts   ← Service
├── remediation-contract.ts          ← Schema
├── golden-trace-replay-validator.ts ← Service
├── golden-trace-replay-adapter.ts   ← Adapter
├── runner/                          ← Runner 框架
│   ├── diagnostician-runner.ts
│   ├── diagnostician-runner-options.ts
│   ├── diagnostician-validator.ts
│   ├── default-validator.ts
│   ├── runner-phase.ts
│   └── runner-result.ts
├── adapter/                         ← Runtime Adapter 实现
│   ├── openclaw-cli-runtime-adapter.ts
│   ├── pi-ai-runtime-adapter.ts
│   ├── test-double-runtime-adapter.ts
│   └── principle-tree-ledger-adapter.ts
├── internalization/                 ← 内化流水线（Stage 2）
│   ├── peer-runner-contracts.ts
│   ├── pitask-metadata.ts
│   ├── pi-artifact.ts
│   ├── pi-artifact-store.ts
│   ├── internalization-job-graph.ts
│   ├── internalization-state-machine.ts
│   ├── internalization-task-guards.ts
│   ├── internalization-orchestrator.ts
│   ├── internalization-route.ts
│   ├── intake-to-internalization-bridge.ts
│   ├── routing-policy.ts
│   ├── deprecated-readiness.ts
│   ├── lifecycle-datasource.ts
│   ├── lifecycle-metrics.ts
│   ├── lifecycle-read-model.ts
│   ├── lifecycle-types.ts
│   ├── rule-host-contracts.ts
│   ├── rule-host-helpers.ts
│   ├── rule-host-evaluator.ts
│   ├── rule-host-adapter.ts
│   ├── rule-code-validator.ts
│   ├── template-generator.ts
│   ├── correction-proposal.ts
│   ├── compile-result.ts
│   ├── dreamer-runner.ts + dreamer-output.ts + dreamer-prompt-builder.ts
│   ├── philosopher-*.ts
│   ├── scribe-*.ts
│   ├── artificer-*.ts
│   ├── evaluator-*.ts
│   ├── rollout-reviewer-*.ts
│   └── trainer-*.ts
├── activation/                      ⚠️ 部分落地（dispatcher/queue/writers 已有；skill/rulehost/training 待建）
│   ├── activation-dispatcher.ts
│   ├── approval-queue.ts
│   ├── approval-store.ts
│   ├── rejection-feedback-service.ts
│   ├── rejection-feedback-store.ts
│   ├── activation-status-read-model.ts
│   ├── approval-queue-read-model.ts
│   └── writers/
│       ├── ledger-prompt-writer.ts
│       ├── ledger-archive-writer.ts
│       ├── skill-file-writer.ts
│       ├── rule-host-writer.ts
│       └── training-exporter.ts
├── gfi/                             ← GFI 子模块
│   ├── gfi-kernel.ts
│   ├── gfi-types.ts
│   ├── gfi-policy.ts
│   └── gfi-read-model.ts
└── cli/                             ← Diagnose / Probe CLI 接口（被 pd-cli 调用）
    ├── index.ts
    ├── diagnose-run.ts
    ├── diagnose-status.ts
    ├── candidate-list.ts
    ├── candidate-show.ts
    ├── artifact-show.ts
    └── probe-runtime.ts
```

### 3.3 Layer 3: Host Integration（宿主集成层）

**位置**：`packages/openclaw-plugin/src/`

```
packages/openclaw-plugin/src/
├── index.ts                         ← Plugin 入口
├── openclaw-sdk.ts                  ← OpenClaw SDK 类型 shims
├── types.ts                         ← Plugin 配置类型
├── hooks/                           ← OpenClaw 事件回调
│   ├── pain.ts                      ← after_tool_call
│   ├── gate.ts                      ← before_tool_call
│   ├── prompt.ts                    ← before_prompt_build
│   ├── llm.ts                       ← llm_output
│   ├── subagent.ts                  ← subagent_*
│   ├── lifecycle.ts                 ← reset / compaction
│   ├── lifecycle-routing.ts
│   ├── trajectory-collector.ts
│   ├── message-sanitize.ts          ← 设计建议删除
│   └── gate-block-helper.ts
├── service/                         ← 长生命周期服务
│   ├── idle-trigger.ts              ← legacy retirement target；不新增宿主调度适配
│   ├── evolution-worker.ts          ← legacy cutover/delete target
│   ├── trajectory-service.ts
│   ├── monitoring-query-service.ts
│   ├── workflow-watchdog.ts
│   ├── runtime-summary-service.ts
│   ├── keyword-optimization-service.ts
│   ├── event-log-auditor.ts
│   ├── startup-reconciler.ts
│   ├── failure-classifier.ts
│   ├── cooldown-strategy.ts
│   ├── nocturnal-*.ts               ← 计划删除（ADR-0005）
│   ├── sleep-cycle.ts               ← 删除 idle/night 调度职责
│   └── subagent-workflow/
├── core/                            ← Plugin 内部业务（迁移中）
│   ├── pain.ts / pain-signal.ts     ← 部分迁入 core
│   ├── pain-signal-adapter.ts
│   ├── pain-context-extractor.ts
│   ├── session-tracker.ts           ← GFI plugin 适配器
│   ├── workspace-context.ts
│   ├── path-resolver.ts
│   ├── paths.ts
│   ├── focus-history.ts
│   ├── empathy-keyword-matcher.ts
│   ├── correction-cue-learner.ts
│   ├── evolution-engine.ts          ← EP 系统
│   ├── evolution-reducer.ts
│   ├── evolution-types.ts
│   ├── principle-tree-ledger.ts     ← 旧版本，应删除（已迁移到 core）
│   ├── code-implementation-storage.ts
│   ├── rule-host.ts                 ← 适配器化（PRI-45）
│   ├── rule-implementation-runtime.ts
│   ├── nocturnal-*.ts               ← 计划删除
│   ├── replay-engine.ts
│   ├── pd-task-*.ts                 ← 后台任务（已部分弃用）
│   ├── init.ts
│   ├── migration.ts
│   ├── system-logger.ts
│   ├── observability.ts
│   ├── thinking-models.ts / thinking-os-parser.ts
│   ├── principle-internalization/   ← 部分迁入 core
│   ├── principle-compiler/          ← 部分迁入 core
│   ├── reflection/
│   ├── hygiene/
│   └── schema/
├── commands/                        ← Plugin slash commands
│   ├── strategy.ts / capabilities.ts / thinking-os.ts
│   ├── pain.ts / context.ts / focus.ts
│   ├── evolution-status.ts
│   ├── promote-impl.ts / disable-impl.ts / archive-impl.ts / rollback-impl.ts
│   ├── principle-rollback.ts / rollback.ts
│   ├── pd-reflect.ts
│   ├── nocturnal-*.ts               ← 计划重命名为 internalization-*
│   ├── samples.ts / export.ts
│   └── workflow-debug.ts
├── tools/                           ← OpenClaw 工具注册
├── i18n/                            ← 多语言
├── config/                          ← Plugin 配置
├── constants/                       ← 常量
├── utils/                           ← Plugin 工具函数
└── types/                           ← Plugin 类型定义
    └── principle-tree-schema.ts     ← 计划迁入 core（ADR-0002）
```

### 3.4 Layer 4: Surface（表面层）

#### 3.4.1 pd-cli

**位置**：`packages/pd-cli/src/`

```
packages/pd-cli/src/
├── index.ts                         ← CLI 入口
├── resolve-workspace.ts             ← workspaceDir 解析
├── principle-tree-ledger-adapter.ts ← Ledger 适配器
├── commands/                        ← 各命令实现
│   ├── diagnose.ts                  ← pd diagnose
│   ├── run.ts                       ← pd run
│   ├── task.ts                      ← pd task
│   ├── flow.ts                      ← pd flow
│   ├── trace.ts                     ← pd trace
│   ├── health.ts                    ← pd status / pd health
│   ├── context.ts                   ← pd context build
│   ├── history.ts                   ← pd history query
│   ├── trajectory.ts                ← pd trajectory locate
│   ├── pain-record.ts               ← pd pain record
│   ├── samples-*.ts                 ← pd samples *
│   ├── runtime-*.ts                 ← pd runtime *
│   │   ├── runtime.ts
│   │   ├── runtime-canary.ts
│   │   ├── runtime-uat.ts
│   │   ├── runtime-pruning.ts
│   │   ├── runtime-recovery.ts
│   │   ├── runtime-internalization-queue.ts
│   │   ├── runtime-internalization-wake-once.ts
│   │   ├── runtime-internalization-run-once.ts
│   │   ├── runtime-internalization-integrity.ts
│   │   ├── runtime-internalization-integrity-repair.ts
│   │   ├── runtime-health-snapshot.ts
│   │   ├── runtime-gfi-snapshot.ts
│   │   └── runtime-diagnostics-export.ts
│   ├── activation.ts                ★ 待建（pd activation list/status）
│   ├── evolution-tasks-*.ts
│   ├── remediation-output.ts
│   ├── legacy-import.ts             ← 历史数据迁移
│   └── legacy-cleanup.ts
└── legacy/                          ← 待清理的旧代码
```

**pd-cli 设计原则**：
- 所有命令支持 `--json` 输出
- 所有命令必须支持 `--workspace <dir>`
- 所有命令必须有 exit code 约定（0 / 1 / 2）
- **不得**绕过 ActivationDispatcher 进行高风险写入
- 所有写操作必须记录 `actor=agent` + agentId

#### 3.4.2 pd-console

**位置**：`packages/pd-console/src/`

```
packages/pd-console/src/
├── server.ts                        ← 启动入口
├── types.ts                         ← 共享类型
├── lib/                             ← Server 工具库
├── server/                          ← Web Server
│   ├── index.ts
│   ├── config/                      ← 配置
│   ├── models/                      ← Read Model 实现
│   │   ├── EventLogReadModel.ts
│   │   ├── GateConsoleModel.ts
│   │   ├── FeedbackConsoleModel.ts
│   │   └── ApprovalConsoleModel.ts  ← 待建（当前审批数据通过 core ApprovalQueue API 直接获取）
│   ├── routes/                      ← REST API
│   ├── types/
│   └── utils/
└── ui/                              ← React 前端
    ├── App.tsx
    ├── main.tsx
    ├── api.ts                       ← Server API client
    ├── components/                  ← 共用组件
    ├── hooks/                       ← React hooks
    ├── i18n/                        ← 多语言
    ├── pages/                       ← 路由页
    │   ├── Dashboard.tsx
    │   ├── Health.tsx
    │   ├── Pipeline.tsx
    │   ├── EventLog.tsx
    │   ├── Principles.tsx
    │   ├── Pruning.tsx
    │   ├── Approvals.tsx（基础版）✅ ← 嵌入 TasksPage.tsx approvals tab
    │   └── ApprovalDetail.tsx       ★ 待建
    └── styles/
```

**pd-console 设计原则**：
- 默认监听 `localhost:18789`，**不**对外暴露
- 高风险操作必须通过 UI 多步确认
- 所有审批操作必须记录 `actor=human` + userId
- 不直接执行业务，所有操作通过 `@principles/core` API

---

## 4. 进程模型

PD 系统在运行时分为以下进程：

### 4.1 OpenClaw Gateway 进程（包含 plugin）

- 启动方式：`openclaw gateway` 或 OpenClaw IDE 内嵌
- 包含：openclaw-plugin（in-proc）
- 责任：
  - 接收用户/代理交互
  - 触发 PD hooks
  - 不运行 PD 调度；仅转发 hook/runtime adapter 需要的宿主事件
- **不**直接运行 Internalization Pipeline 的 LLM 调用（通过 Adapter 异步分派）

### 4.2 pd-cli 进程（短暂进程）

- 启动方式：`pd <command> [args]`
- 类型：单次执行后退出
- 责任：
  - 执行单条命令
  - 读 / 写 state.db / ledger.json
  - 通过 PDRuntimeAdapter 调用 LLM（如果是 `pd diagnose run` / `pd runtime internalization-run-once` 等）
- 并发：多个 pd-cli 进程可同时运行，靠 SQLite 锁 + LeaseManager 协调

### 4.3 pd-console 进程（长生命周期）

- 启动方式：`pd-console serve` 或 `npx pd-console`
- 类型：本地 Web Server
- 责任：
  - 提供 Web UI
  - 读 state.db / ledger.json
  - 通过 ApprovalQueue 写审批决策
- 进程数：通常一个工作区一个 server

### 4.4 进程间协调

```
┌─────────────────────────────────────────────────────────────────┐
│                  Workspace 文件系统                              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐│
│  │ {workspace}/.pd/state.db                                    ││
│  │ {workspace}/.state/principle_training_state.json           ││
│  │ {workspace}/.state/audit-log.jsonl                         ││
│  │ {workspace}/.principles/skills/                            ││
│  │ {workspace}/.principles/implementations/                   ││
│  │ {workspace}/.pd/training-exports/                          ││
│  └────────────────────────────────────────────────────────────┘│
└──────────┬─────────────────┬──────────────────┬────────────────┘
           │                 │                  │
           │ 读+写            │ 读+部分写         │ 读+审批写
           │ (并发安全：       │ (并发安全：       │ (并发安全：
           │  LeaseManager +  │  LeaseManager +  │  LeaseManager +
           │  atomic write)   │  atomic write)   │  atomic write)
           ▼                 ▼                  ▼
   ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
   │ Plugin 进程    │  │ pd-cli 进程    │  │ pd-console 进程│
   │ (Gateway 内嵌) │  │ (单次执行)     │  │ (长 Server)   │
   └───────────────┘  └───────────────┘  └───────────────┘
```

**并发协调机制**：

1. **SQLite WAL 模式**：所有进程使用 WAL 模式，读写不互斥
2. **LeaseManager**：跨进程的 task lease，TTL 强制释放
3. **原子文件写入**：所有 JSON 文件通过 `atomicWriteFileSync`（写临时文件 + rename）
4. **幂等性**：所有跨进程操作都有幂等键

详见 `DATA_ARCHITECTURE.md` §3。

---

## 5. 部署形态

### 5.1 本地开发模式（默认）

```
开发者机器
├── ~/.openclaw/extensions/principles-disciple/   ← Plugin 安装位置
├── ~/.openclaw/workspace-main/                   ← 默认工作区
│   ├── .pd/state.db
│   └── .state/
└── PD CLI 通过 npm 全局安装或项目本地安装
```

### 5.2 多工作区

```
开发者机器
├── workspace-A/.pd/state.db        ← 项目 A 的 PD 状态
├── workspace-B/.pd/state.db        ← 项目 B 的 PD 状态
└── 共享：~/.openclaw/extensions/principles-disciple/
```

每个工作区独立维护自己的 state.db / ledger / artifacts。目标边界是由 PD 专属配置/SDK 明确提供 workspace；不得为执行 Runtime V2 继续扩建依赖 OpenClaw 当前上下文的发现逻辑。

### 5.3 CI/CD 模式

```
CI 环境
├── 单独运行 pd-cli 命令做检查
│   - pd runtime-canary  （运行健康度 canary）
│   - pd runtime-uat     （UAT 测试）
│   - pd schema-conformance-check
└── 不运行 plugin / console
```

### 5.4 Pi-AI 集成模式（实验）

```
开发者机器
├── PD 工作区（与本地模式相同）
└── PiAiRuntimeAdapter 直接调用外部 LLM API
```

适用于不依赖 OpenClaw 的脱机场景。

---

## 6. 数据存储分布

### 6.1 状态数据库（state.db）

物理位置：`{workspace}/.pd/state.db`

详见 `DATA_ARCHITECTURE.md` §2.1。包含的表：

```sql
tasks
runs
commits
candidates
artifacts
pi_artifacts
events                            -- TelemetryEvent 流
approvals                         ✅ 基础版已落地（pending/approve/reject/cancel/list）
rejection_feedbacks               ★ 待建
history (各 history 子表)
trajectory
correction_audit_events           ★ ADR-0004
```

### 6.2 Ledger（JSON）

物理位置：`{workspace}/.state/principle_training_state.json`

```json
{
  "trainingStore": { ... legacy ... },
  "_tree": {
    "principles": { "P_001": {...}, ... },
    "rules": { "R_001_a": {...}, ... },
    "implementations": { "IMPL_001_a_hook": {...}, ... },
    "metrics": { ... },
    "lastUpdated": "..."
  }
}
```

### 6.3 工件文件

```
{workspace}/.principles/
├── skills/                         ← skill 通道激活后写入
│   └── {skillId}/
│       ├── SKILL.md
│       └── manifest.json
└── implementations/code/           ← code_tool_hook 通道激活后写入
    └── {implId}/
        ├── entry.ts
        ├── manifest.json
        ├── tests.jsonl             ← GoldenTrace cases
        └── last-eval.json
```

```
{workspace}/.pd/
├── state.db
├── config/
│   ├── activation.yaml
│   ├── internalization.yaml
│   └── runtime-scheduling.yaml       ← PD-owned explicit scheduling (replaces legacy idle trigger)
├── training-exports/               ← model_training 通道激活后写入
│   └── {batchId}/
│       ├── dataset.jsonl
│       └── metadata.json
└── audit-log.jsonl                 ← 审计日志
```

```
{workspace}/.state/                 ← OpenClaw 兼容性目录
├── principle_training_state.json   ← Ledger
├── pruning_reviews.jsonl           ← Pruning 审计
├── trajectory.db                   ← 旧轨迹数据
├── sessions/
├── event-log.jsonl
└── 其他 plugin 兼容文件
```

---

## 7. 配置层级

PD 的配置遵循以下层级（从低优先级到高优先级，详见待建的 `CONFIGURATION_ARCHITECTURE.md`）：

```
1. 内置默认值（代码常量）
       ↓ 可被覆盖
2. ~/.openclaw/extensions/principles-disciple/default-config.yaml
       ↓ 可被覆盖
3. {workspace}/.pd/config/*.yaml
       ↓ 可被覆盖
4. 环境变量（PD_* 前缀）
       ↓ 可被覆盖
5. 命令行参数（pd-cli）
```

主要配置文件：

| 文件 | 用途 |
|------|------|
| `activation.yaml` | 通道激活策略（详见 ADR-0006）|
| `internalization.yaml` | 内化流水线参数 |
| `runtime-scheduling.yaml` | PD-owned 显式调度/执行策略；不依赖 OpenClaw idle 状态 |
| `runtime.yaml` | RuntimeAdapter 选择 |
| `gfi.yaml` | GFI 策略 |

---

## 8. 跨流水线数据流（端到端示例）

以下展示一个 PainSignal 从捕获到激活的**完整路径**，串联 §3 的所有组件：

```
[1] OpenClaw 工具调用失败
        │
        ▼ Hook
[2] handleAfterToolCall (plugin/hooks/pain.ts)
        │
        │ 调用 core
        ▼
[3] PainSignalAdapter.recordPain (core/pain-signal-adapter.ts)
        │
        ▼ 写入
[4] state.db: pain_signals
    ledger.json: pain_flag
        │
        ▼ 触发
[5] PainSignalBridge.onPainDetected (core/runtime-v2/pain-signal-bridge.ts)
        │
        │ 创建 task
        ▼
[6] state.db: tasks (taskKind=diagnostician, status=pending)
        │
        │ PD-owned operator/SDK/scheduler → InternalizationOrchestrator.wakeOnce()
        ▼
[7] DiagnosticianRunner.run (core/runtime-v2/runner/diagnostician-runner.ts)
    ├─ acquireLease
    ├─ ContextAssembler.assemble → DiagnosticianContextPayload
    ├─ DiagnosticianPromptBuilder.buildPrompt
    ├─ PDRuntimeAdapter.startRun → ... → fetchOutput
    ├─ DiagnosticianValidator.validate
    └─ DiagnosticianCommitter.commit
        │
        ▼ 写入
[8] state.db: artifacts (kind=diagnosis_report)
    state.db: candidates (status=pending)
        │
        ▼
[9] CandidateIntakeService.intake (core/runtime-v2/candidate-intake-service.ts)
        │
        ▼ 写入
[10] ledger.json: principles[P_xxx].status = 'probation'
        │
        ▼ 触发 ★ NEW
[11] IntakeToInternalizationBridge.onProbationCreated (core/runtime-v2/internalization/intake-to-internalization-bridge.ts)
        │
        │ RoutingPolicy 决策 → channel=prompt
        │ 创建 dreamer task
        ▼
[12] state.db: tasks (taskKind=dreamer, channel=prompt, status=pending)
        │
        │ PD-owned operator/SDK/scheduler → InternalizationOrchestrator.wakeOnce(taskKind='dreamer')
        ▼
[13] DreamerRunner.run
        │
        ▼
[14] state.db: pi_artifacts (kind=principle, validation=pending → validated)
     state.db: tasks (taskKind=philosopher) ← proposeNextTask 入队
        │
        ▼ ... 重复至 RolloutReviewer
        │
[15] RolloutReviewerRunner.run → output.review.decision='auto_activate'
        │
        ▼ 触发 ★ NEW
[16] ActivationDispatcher.dispatch (core/runtime-v2/activation/activation-dispatcher.ts)
        │
        │ channel=prompt → 自动激活
        ▼
[17] PromptWriter.activate
        │
        ▼ 写入
[18] ledger.json: principles[P_xxx].status = 'active'
        │
        ▼ 下次
[19] before_prompt_build hook (plugin/hooks/prompt.ts)
        │
        │ 读取 active 原则注入
        ▼
[20] LLM 接收到含原则的 system prompt
        │
        ▼
[21] 代理行为受影响 ★ 内化生效
```

---

## 9. 旧文档与本文档的对照

| 旧文档 | 旧设计 | 本文档对应 |
|-------|-------|-----------|
| 旧 `PD_SYSTEM_ARCHITECTURE.md`（2026-05-09）| 3 层 | 4 层（Layer 1-4），更精确 |
| `2026-04-21-pd-runtime-agnostic-architecture-v2.md` | 4 层 | 与本文档大体一致，本文档是其更新版 |
| `pd-task-manager.md` | PDTask 概念 | 已被 TaskRecord + Runtime V2 explicit scheduling 取代 |

---

## 10. 实施进度对照

| 部分 | 实施进度 |
|------|---------|
| Layer 1（Foundation） | ✅ 95% |
| Layer 2（Domain Services & Runners） | ⚠️ 90% — Runtime V2 core path 已落地；legacy idle 策略待删除 |
| Layer 3（Host Integration） | ⚠️ 75% — OpenClaw hook adapter 待收薄；Nocturnal/idle 调度入口待退役 |
| Layer 4（Surface） | ⚠️ 75% — pd-console approval UI 未建 |

详见 `COMPONENTS.md` 状态列。

---

## 11. 关联文档

| 文档 | 关系 |
|------|------|
| [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) | 上层视图与本文档互补 |
| [`COMPONENTS.md`](./COMPONENTS.md) | 组件级目录，本文档是结构级视图 |
| [`INTERNALIZATION_PIPELINE.md`](./INTERNALIZATION_PIPELINE.md) | 流水线设计 |
| [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md) | 通道详细 |
| [`DATA_ARCHITECTURE.md`](./DATA_ARCHITECTURE.md) | 数据存储 |
| [`ERROR_ARCHITECTURE.md`](./ERROR_ARCHITECTURE.md) | 错误体系 |
| [`GLOSSARY.md`](./GLOSSARY.md) | 术语 |
| ADR-0001/0003/0005/0006 | 决策依据 |

---

## 12. 维护规则

### 12.1 何时需要修改本文档

- 新增 / 删除一个**包**（极少）
- 新增 / 删除一个**层**（极少，需 ADR）
- 调整**包之间的依赖关系**（需 ADR）
- 调整**进程模型**（需 ADR）
- 新增 / 删除 / 重组**主要目录**（修订）

### 12.2 何时不需要改本文档

- 新增 / 修改一个组件 → 改 `COMPONENTS.md`
- 新增 / 修改一条数据流 → 改 `INTERNALIZATION_PIPELINE.md` 或对应文档
- 新增一个新文件 → 不需要除非影响目录结构理解

### 12.3 PR 标签

修改本文档的 PR 必须含 `[ARCHITECTURE]` 标签。
