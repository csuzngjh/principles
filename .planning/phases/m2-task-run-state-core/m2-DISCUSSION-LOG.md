# Phase M2: Task/Run State Core - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-22
**Phase:** m2-task-run-state-core
**Areas discussed:** 存储层位置与结构, 迁移策略与legacy兼容, Run-Task关系模型, SQLite存储细节

---

## 存储层位置与结构

### Store 位置

| Option | Description | Selected |
|--------|-------------|----------|
| 全放在 @principles/core (推荐) | 接口和 SQLite 实现都在 core，所有 runtime-v2 代码集中 | ✓ |
| 接口 core + 实现单独 package | 更清晰的关注点分离，但增加 package 管理复杂度 | |
| 全部放 openclaw-plugin | 违反 "OpenClaw is adapter" 原则 | |

**User's choice:** 全放在 @principles/core
**Notes:** M1 contracts 已经在 core，保持一致性

### 目录结构

| Option | Description | Selected |
|--------|-------------|----------|
| runtime-v2/store/ 子目录 (推荐) | schema 文件在 runtime-v2/ 根，实现在 store/ 子目录 | ✓ |
| src/store/ 平级目录 | 与 runtime-v2/ 平级，打破单一入口模式 | |

**User's choice:** runtime-v2/store/ 子目录

---

## 迁移策略与 Legacy 兼容

### 对旧 evolution queue 的处理

| Option | Description | Selected |
|--------|-------------|----------|
| 只建新、不碰旧 (推荐) | M2 scope 最小、风险最低 | |
| Dual-write 双写 | 平滑过渡但 M2 scope 膨胀 | |
| 直接替换旧 queue | 一步到位，风险最高 | ✓ |

**User's choice:** 直接替换旧 queue
**Notes:** 用户选择激进替换，不走 dual-write

### 存量任务处理

| Option | Description | Selected |
|--------|-------------|----------|
| 启动时自动迁移 + 备份旧文件 (推荐) | 一次性迁移 | |
| 不迁移、新 store 空白开始 | 旧数据不导入 | ✓ |

**User's choice:** 不迁移、新 store 空白开始
**Notes:** 旧 JSON 保留磁盘但不作为 truth source

---

## Run-Task 关系模型

### 关系模型

| Option | Description | Selected |
|--------|-------------|----------|
| 1 Task : N Runs (推荐) | 每次 attempt 创建新 Run，保留执行历史 | ✓ |
| 1 Task : 1 Run | 重试复用同一个 Run，更简单但丢失历史 | |

**User's choice:** 1 Task : N Runs

### Run 内容

| Option | Description | Selected |
|--------|-------------|----------|
| Run 存 metadata + ref (推荐) | Run 轻量，payload 存外部 artifact | |
| Run 存完整 payload | 更自包含但增加 SQLite 写入负担 | ✓ |

**User's choice:** Run 存完整 payload
**Notes:** Run 包含完整 input (ContextPayload) 和 output (DiagnosticianOutputV1)

---

## SQLite 存储细节

### DB 位置

| Option | Description | Selected |
|--------|-------------|----------|
| Workspace 级别 (推荐) | 每个 workspace 一个 .pd/state.db，符合隔离原则 | ✓ |
| 全局单一 DB | 集中管理但违反 workspace 隔离 | |

**User's choice:** Workspace 级别

### SQLite 并发配置

| Option | Description | Selected |
|--------|-------------|----------|
| WAL mode + busy_timeout (推荐) | 标准并发配置，读写并发 | ✓ |
| 默认 DELETE mode | 最简单但并发性能差 | |

**User's choice:** WAL mode + busy_timeout (5000ms)

---

## Claude's Discretion

- SQL schema DDL (column types, constraints, indexes)
- Lease duration default value
- Backoff policy parameters
- Recovery sweep interval
- Event emission format
- TaskKind handling (use existing strings)
- Whether RunRecord gets its own TypeBox schema

## Deferred Ideas

- None — discussion stayed within M2 scope
