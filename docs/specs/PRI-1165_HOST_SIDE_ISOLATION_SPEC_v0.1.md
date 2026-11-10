# PRI-1165 宿主侧隔离闭环 SPEC v0.1

状态：草案（待评审）
父单：PRI-872（已 Done，PR #2473）
上游 SPEC：`docs/audit/install-mjs-dev-prod-isolation-review-20260920.md` §6（同用户双开最小工程范围，该文件被 .gitignore，仅本地）
调查基线：OpenClaw `2026.11.1`（全局安装）+ PD HEAD（含 PR #2473）
调查性质：本文结论来自对 OpenClaw 安装产物 `dist/` 的源码核查，不采信记忆或二手文档。

## 1. 背景

PRI-872 已闭合**控制面**隔离：PD home / Console 注册表 / 更新事务 / 网关归属 / 端口全部落在实验根，且实验实例拒绝产品更新与机器级 `openclaw gateway stop|start`。

但"同用户双开"在**宿主侧**仍有残余：实验实例运行时仍可能触碰若干净的系统级共享位置。本 SPEC 先给出实证核查，再界定最小闭环方案。

## 2. 现状核查（实证）

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| PD 控制面（home/注册表/更新/备份） | 已隔离 | `packages/install-layout/src/pd-home.ts`；PR #2473 |
| 端口与进程归属 | 已隔离 | `packages/pd-console/src/server/console-ports.ts`；`scripts/dev/console-experiment.mjs` |
| OpenClaw state/config/workspace | 已隔离 | launcher 设 `OPENCLAW_STATE_DIR/CONFIG_PATH/WORKSPACE_DIR` 并 `delete OPENCLAW_HOME` |
| Codex home | 已隔离 | `CODEX_HOME=<root>/.codex`；`packages/pd-cli/src/services/codex-plugin-install.ts:7-10` |
| OpenClaw OAuth 凭据 | 已隔离 | 默认 `stateDir/credentials`（`dist/config-doctor/boundary-file-read-*.js:131-133`） |
| Console 浏览器认证 | 无共享凭据 | 静态 Bearer token + `--no-auth` 仅 loopback（`AuthConfig.ts:14-18`）；端口异源 |
| 机器级 SQLite 快照 / 滚动日志缓存 | **未隔离** | `resolvePrivateSqliteSnapshotStagingRoot`：`[XDG_CACHE_HOME, LOCALAPPDATA]`（`dist/config-doctor/openclaw-state-db-cache-*.js:9694-9708`） |
| 日志实例命名空间 | **未隔离** | 日志名 `openclaw-<date>.log`，仅当 `OPENCLAW_PROFILE` 非 default 才加 profile 段（`dist/.../sqlite-readonly-subsystem-*.mjs:10670-10684`） |
| `%LOCALAPPDATA%\OpenClaw\locks` | **不可 env 重定向，但共享安全** | 目录硬编码 `os.homedir()`（`dist/gateway-state-owner-*.mjs:147-150`）；锁文件名 `state.<sha256(canonicalStateDbPath,16)>.lock` |
| jiti 编译缓存 | 共享（可接受） | `%LOCALAPPDATA%\openclaw\jiti\<openclaw 版本>`，仅性能影响 |
| 测试消息通道 | 路径已隔离，内容未约束 | 独立 `openclaw.json` 已隔离；若复用正式 bot token 仍会消费同一真实消息 |
| `--gateway` | 预检存在，未端到端验收 | `console-experiment.mjs:175-182` 缺失配置即拒绝；从未跑通真实网关 |

关键修正：原 PRI-872 报告曾判断"机器级缓存可能需要 OPENCLAW_* 之外的隔离手段，或接受共享"。实证表明 **`XDG_CACHE_HOME`（绝对路径）即可重定向该缓存根**；`skipPreferredOnWindows` 只影响 preferredDir，fallback 基址仍是 `cacheRoot`。

## 3. 目标 / 非目标

**目标**
1. 实验实例的运行时副作用（缓存 / 日志 / SQLite 快照）落在实验根内。
2. 对确实无法迁移的共享项（locks 目录、jiti 编译缓存）给出**可验证的接受理由**并文档化。
3. 补一次 `--gateway` 真实端到端验收。
4. PD 的 `openclawHome` 与 OpenClaw 实际 state 目录**语义对齐**。

**非目标**
- 不修改 OpenClaw 本体。
- 不引入新子系统 / 新存储。
- 不改变 PD 生产模式的既有路径落点（除非用户显式设置 `OPENCLAW_STATE_DIR`）。

## 4. 方案

### 4.1 PD 解析器：优先认 `OPENCLAW_STATE_DIR`（方案 A，增量）

`resolvePdHome()` 当前只读 `PD_EXPERIMENT_ROOT` 与 `OPENCLAW_HOME`，且把 `OPENCLAW_HOME` 当作 `.openclaw` 目录本身；而 OpenClaw 把它当 **HOME 替身**（`dist/home-dir-*.mjs:28-37`）。这是先于本单的生产期潜在错位。

调整为：

```
production.openclawHome =
  OPENCLAW_STATE_DIR（绝对） > OPENCLAW_HOME（沿用旧语义）> <home>/.openclaw
experiment.openclawHome = 保持现状（launcher 已设 OPENCLAW_STATE_DIR，值等于派生值）
```

- 对既有用户**不改变落点**（他们通常不设 `OPENCLAW_STATE_DIR`）。
- 拒绝矩阵新增一条：`OPENCLAW_STATE_DIR` 为相对路径 → fail-closed。
- 文档明确：新部署优先用 `PD_EXPERIMENT_ROOT` / `OPENCLAW_STATE_DIR`；`OPENCLAW_HOME` 仅作旧语义兼容。

### 4.2 启动器补环境变量

在 `scripts/dev/console-experiment.mjs` 的 `childEnv` 增加：

- `XDG_CACHE_HOME = <root>/.cache` —— 重定向 SQLite 快照 staging 与滚动日志的 tmp 根。
- `OPENCLAW_PROFILE = experiment` —— 日志文件名获得实例命名空间。
- （待验证）`XDG_DATA_HOME` / `XDG_CONFIG_HOME` —— 按 OpenClaw 实际使用面决定是否一并设。

保留现有 `OPENCLAW_STATE_DIR/CONFIG_PATH/WORKSPACE_DIR/CODEX_HOME`，继续 `delete OPENCLAW_HOME`。

### 4.3 接受共享（文档化 + 理由）

- `%LOCALAPPDATA%\OpenClaw\locks`：硬编码 `os.homedir()`，但锁文件按 `sha256(canonicalStateDbPath,16)` 命名 ⇒ 不同 state-db 生成不同锁文件 ⇒ 不会互相顶锁。
- `%LOCALAPPDATA%\openclaw\jiti\<ver>`：按 OpenClaw 版本分的编译缓存，共享仅影响性能。
- 启动器 banner 输出"已隔离 / 共享"清单，避免后续维护者误判。

### 4.4 测试消息通道

- 实验 `openclaw.json` 必须使用测试 bot / 测试账号，不得复制正式 token。
- 先以**文档 + setup 检查清单**约束；"自动检测 token 相等"列为可选增强（见 §8）。

### 4.5 `--gateway` 端到端验收

1. 在实验根用 `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` 执行 `openclaw setup` 生成 `openclaw.json`。
2. `--gateway` 起 19789，确认 prod 18789 不受影响。
3. 关闭启动器后 19789 释放、无孤儿进程。

## 5. 正确性验证

**代码证据（已具备）**
- `dist/config-doctor/openclaw-state-db-cache-*.js:9694-9708`：`XDG_CACHE_HOME` 优先于 `LOCALAPPDATA`。
- `dist/.../sqlite-readonly-subsystem-*.mjs:10633-10642`：`tmpdir: () => cacheRoot`。
- `dist/gateway-state-owner-*.mjs:147-150`：locks 硬编码 + 按 state-db 分键。

**真机验收（必须补）**
- 设 `XDG_CACHE_HOME` 后：`%LOCALAPPDATA%\openclaw` 不再新增 SQLite staging；新文件出现在 `<root>/.cache`。
- 日志出现在 `<root>/.cache/openclaw` 且文件名含 `experiment` 段。
- locks 目录仍共享，但实验/正式锁文件名不同。
- 哨兵：正式 `~/.pd/active.json` 的 sha256/generation/mtime 前后一致。
- 负向：相对 `OPENCLAW_STATE_DIR` 被拒。

**单元测试**
- `pd-home.test.ts` 增 `OPENCLAW_STATE_DIR` 分支 + 相对路径拒绝。
- launcher env 断言（可在 `scripts` 侧加测试，或导出 `buildChildEnv()` 纯函数便于测试）。

## 6. 风险与回滚

- `XDG_*` 可能影响 OpenClaw 其他组件（config/data）；逐项验证，必要时只设 `XDG_CACHE_HOME`。
- PD 认 `OPENCLAW_STATE_DIR` 后，生产用户若设置该变量，备份/扩展位置随之移动 —— 属预期对齐，需在 CHANGELOG 说明。
- 回滚：全部是 env / 解析顺序变更，无持久化 schema 变更；回滚 = 去掉 env / 回退解析顺序。

## 7. Complexity Delta

- 新公共接口：NO（复用 `resolvePdHome`，仅增加一个 env 读取）
- 新平台行为：YES（实验实例的缓存 / 日志目录归属）
- 新数据契约：NO
- 新架构边界：NO
- 新子系统：NO

## 8. 未决（评审时定）

1. `XDG_DATA_HOME` / `XDG_CONFIG_HOME` 是否一并设（需验证 OpenClaw 使用面）。
2. 测试消息通道做"token 相等自动检测"还是仅文档约束。
3. 长期是否废弃 `OPENCLAW_HOME` 兼容路径。
