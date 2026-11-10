# PRI-1165 宿主侧隔离闭环：实施与验收记录

核查/实施时间：2026-11-10（Asia/Shanghai）。
父单：PRI-872（已 Done，PR #2473）。
SPEC：`docs/specs/PRI-1165_HOST_SIDE_ISOLATION_SPEC_v0.1.md`。
性质：本条记录本期已落地范围与实测证据，并如实标注受沙箱限制未完成的部分。

## 1. 本期结论

宿主侧"运行时副作用外泄"已闭合到可验证的程度：

- **实验实例的 SQLite 快照 staging 与滚动日志**不再写 `%LOCALAPPDATA%\openclaw`，而是落在实验根的 `XDG_CACHE_HOME` 下（实测见 §4）。
- **PD 的 `openclawHome` 与 OpenClaw 实际 state 目录对齐**：`OPENCLAW_STATE_DIR` 优先于 `OPENCLAW_HOME`，且相对路径 fail-closed。
- 仅存的两处共享（`%LOCALAPPDATA%\OpenClaw\locks`、jiti 编译缓存）已确认**共享安全**并文档化。

## 2. 变更清单

| 文件 | 变更 |
| --- | --- |
| `packages/install-layout/src/pd-home.ts` | 新增 `PD_OPENCLAW_STATE_DIR_ENV`；production 与 experiment 均按 `OPENCLAW_STATE_DIR > OPENCLAW_HOME > <home>/.openclaw` 解析；experiment 要求 state dir 在根内；新增两条拒绝原因 `openclaw_state_dir_not_absolute` / `openclaw_state_dir_outside_experiment` |
| `packages/install-layout/src/index.ts` | 导出新常量 |
| `packages/install-layout/tests/pd-home.test.ts` | 新增 6 项：state-dir 单独生效、优先级高于 HOME、相对路径拒绝（prod/experiment）、根内接受、根外拒绝 |
| `scripts/dev/console-experiment.mjs` | `childEnv` 增 `XDG_CACHE_HOME=<root>/.cache`、`OPENCLAW_PROFILE=experiment`；创建 `.cache`；banner 输出 cache/profile 与共享 locks 说明 |
| `.changeset/pri-1165-host-side-isolation.md` | `@principles/install-layout` minor |

## 3. 契约变化

```text
production.openclawHome  = OPENCLAW_STATE_DIR(绝对) > OPENCLAW_HOME(旧语义) > <home>/.openclaw
experiment.openclawHome  = OPENCLAW_STATE_DIR(根内) > OPENCLAW_HOME(根内) > <root>/.openclaw
```

- 既有用户通常不设 `OPENCLAW_STATE_DIR`，落点不变。
- 相对 `OPENCLAW_STATE_DIR` 一律拒绝（fail-closed），不回退真实 home。

## 4. 验收证据

**自动化（本机，全部通过）**
- `packages/install-layout/tests/pd-home.test.ts`：**19/19**（原 13 + 新增 6）。
- `packages/pd-console/tests/server/utils/pd-home-wiring.test.ts`：**5/5**（实验模式派生路径未回归）。
- `install-layout` typecheck（tsc 7.0.2）**通过**；`npm run build` **通过**（含 dist-hygiene）。

**真机实证（关键）**
以实验环境执行 `openclaw setup --baseline`（`OPENCLAW_STATE_DIR=<root>/.openclaw`、`XDG_CACHE_HOME=<root>/.cache`、`OPENCLAW_PROFILE=experiment`、`CODEX_HOME=<root>/.codex`、删除 `OPENCLAW_HOME`）：

```text
<root>/.cache/openclaw/openclaw-sqlite-readonly-v2-*      ← 7 个 staging 目录，落在实验根
<root>/.openclaw/state/openclaw.sqlite(+shm/wal/seal)     ← state DB，落在实验根
<root>/.openclaw/{openclaw.json, agents/main/sessions, plugin-skills}
%LOCALAPPDATA%\openclaw  →  仅 jiti/ + locks/              ← 无新增 SQLite 快照
正式实例：127.0.0.1:3100 (PID 7068)、127.0.0.1:18789 (PID 13540) 仍 LISTENING
正式哨兵：~/.pd/active.json sha256/16 = 3be31ad8b59b8db0 未变
```

这直接修正了 PRI-872 报告 §6.2 的"机器级 SQLite 快照只能接受共享 / 需上游"判断：**`XDG_CACHE_HOME` 足以重定向**。

**共享项（可接受，已文档化）**
- `%LOCALAPPDATA%\OpenClaw\locks`：目录硬编码 `os.homedir()`，但锁文件按 `sha256(canonicalStateDbPath,16)` 命名 ⇒ 实验/正式 state-db 不同 ⇒ 锁文件不同，不互顶。
- `%LOCALAPPDATA%\openclaw\jiti\<ver>`：按 OpenClaw 版本分的编译缓存，共享仅影响性能。

## 5. 本期未完成（如实记录）

- **完整 launcher `--gateway` 运行未在本沙箱完成**：本机安全策略把 `reg.exe` 列入程序黑名单，`openclaw doctor` 因此挂起（120s 超时 SIGTERM）。完整"起 13100 + 19789 → 关闭释放"的端到端验收需在不受该限制的环境补跑。
- 但**本单的核心假设（XDG_CACHE_HOME 重定向）已通过 `openclaw setup --baseline` 直接证明**，不依赖 launcher 全链路。
- `XDG_DATA_HOME` / `XDG_CONFIG_HOME` 未设（SPEC §8 未决项），本期按最小改动只做 `XDG_CACHE_HOME`。
- 测试消息通道仍为**配置内容约束**（实验 `openclaw.json` 用测试 bot 账号），未做 token 相等自动检测。

## 6. Complexity Delta

- 新公共接口：NO（复用 `resolvePdHome`，仅新增一个 env 读取）。
- 新平台行为：YES（实验实例缓存/日志归属）。
- 新数据契约：NO。
- 新架构边界：NO。
- 新子系统：NO。

Emotional value: N/A — 无 Owner 直接可见的行为变化（生产模式默认路径不变）。
