# PRI-872 同用户双开路径隔离：实施与验收记录

核查/实施时间：2026-11-10（Asia/Shanghai）。
基线：`origin/main` `716789d80`（工作树 `PRI-872-dual-instance-isolation`）。
SPEC：`docs/audit/install-mjs-dev-prod-isolation-review-20260920.md` §6（同用户双开最小工程范围）。
性质：本条记录本期已落地的范围与实测证据，同时明确仍未覆盖的部分。

## 1. 本期结论

同用户双开的**控制面隔离**已闭合：第二个实例不再可能读/写正式安装的用户级状态，也无法触发产品更新或机器级网关服务。

隔离前的问题（复核结果，HEAD `e7c7e6bba`）：`os.homedir()` 在 pd-console 有 10 处硬编码、bootstrap executor 1 处；`resolveUpdateLayout()` 零参数；全仓无 `PD_HOME` 类变量；`packages/install-layout` 零 `process.env`、零 `realpath`。

## 2. 契约（新公共接口）

`PD_EXPERIMENT_ROOT`（绝对路径）是唯一开关，缺省时行为与历史完全一致。

| 模式 | homeDir | pdHome | consoleConfigDir | openclawHome | codexHome |
| --- | --- | --- | --- | --- | --- |
| production | `os.homedir()` | `<home>/.pd` | `<home>/.pd-console` | `OPENCLAW_HOME` > `<home>/.openclaw` | `<home>/.codex` |
| experiment | realpath(root) | `<root>/.pd` | `<root>/.pd-console` | `OPENCLAW_HOME`（须在根内）> `<root>/.openclaw` | `<root>/.codex` |

解析入口：`@principles/install-layout.resolvePdHome()`（新增 `pd-home.ts`）。pd-console 侧统一经 `src/server/utils/pd-home.ts` 取用，不再本地推导。

`homeDir` 仍是 `getInstallLayoutPaths(homeDir)` 的入参，因此已安装布局（runtime/plugin/console/pd-cli）继续复用同一个路径推导，未新增第二套路径事实。

## 3. 拒绝矩阵（fail-closed，绝不回退真实 home）

| reason | 触发条件 |
| --- | --- |
| `experiment_root_empty` | 变量存在但为空/空白（不是"视为未设置"） |
| `experiment_root_not_absolute` | 相对路径 |
| `experiment_root_missing` | 目录不存在 |
| `experiment_root_not_directory` | 指向文件 |
| `experiment_root_unresolvable` | realpath 失败（坏链接） |
| `experiment_root_overlaps_production` | 根落在 `~/.pd`、`~/.pd-console`、`~/.openclaw` 内，或是它们的祖先（例如用户 home） |
| `experiment_path_escapes_root` | 派生路径（`.pd` / `.pd-console` / `.openclaw` / `.codex`）经 junction/符号链接指向根外 |
| `openclaw_home_outside_experiment` | 实验模式下 `OPENCLAW_HOME` 指到根外 |

实现要点：先对根做一次 `realpathSync.native`，其后所有派生路径都基于**真实根**；派生路径用"最深已存在祖先 realpath + 补齐缺失尾段"判定包含关系（`path.relative`，win32 大小写不敏感），因此"计划中尚不存在"的目录同样被覆盖。`<root>/.pd` junction 到正式 `~/.pd` 这类攻击被明确拒绝（有测试）。

## 4. 代码变更

| 文件 | 变更 |
| --- | --- |
| `packages/install-layout/src/pd-home.ts` | 新增：`resolvePdHome()`、`isPathWithinRoot()`、拒绝原因联合 |
| `packages/install-layout/src/index.ts` | 导出上述公开 API |
| `packages/pd-console/src/server/utils/pd-home.ts` | 新增：控制台侧唯一入口 + `PdHomeConfigurationError` |
| `packages/pd-console/src/server/config/WorkspaceConfigStore.ts` | 注册表目录改为 `consoleConfigDir` |
| `packages/pd-console/src/server/utils/installed-layout.ts` | `resolveUpdateLayout()` / `resolveCanonicalRuntimeRoot()` 改用 `homeDir` |
| `packages/pd-console/src/server/utils/pd-backups.ts`、`utils/gateway.ts` | openclaw home 改由解析器提供（保留生产模式 `OPENCLAW_HOME` 优先级） |
| `packages/pd-console/src/server/routes/update.ts` | `pdHome` 取自解析器；实验模式显式拒绝（`experimental_instance`），不构造 ReleaseManager 权限 |
| `packages/pd-console/src/server/routes/update-transaction.ts` | 3 处事务 journal 路径改用解析器 |
| `packages/pd-console/src/server/index.ts` | 启动即解析（失败打印 reason/nextAction 并退出 1）；横幅打印模式与绝对路径；实验模式默认端口 13100；`EADDRINUSE` 结构化提示 |
| `packages/pd-console/src/server/console-ports.ts` | 新增：3100 / 13100 / 19789 与 `defaultConsolePort()` 单一事实 |
| `packages/pd-console/src/server/utils/gateway.ts` | 实验模式拒绝 `openclaw gateway stop|start`（机器级服务归正式实例） |
| `packages/create-principles-disciple/src/update/bootstrap-executor.ts` | 分离进程同样经 `resolvePdHome()` 解析；失败以结构化 `reason` 返回 |
| `scripts/dev/console-experiment.mjs` + `package.json` | 新增 `npm run dev:console:experiment -- --root <abs>`：端口预检、根创建（父目录存在且不在正式状态内）、子进程句柄管理、可选 `--gateway` 前台 `openclaw gateway run --port 19789` |
| `packages/pd-console/package.json` | `dev` 脚本不再写死 `--port 3100`（由模式决定默认值） |

## 5. 验收证据

自动化（全部通过）：

- `packages/install-layout/tests/pd-home.test.ts`：13 项，含 8 条拒绝路径、生产模式行为不变、openclaw 覆盖在根内/根外。
- `packages/pd-console/tests/server/utils/pd-home-wiring.test.ts`：4 项（派生路径、注册表落在实验根、坏根抛错、端口契约）。
- `packages/pd-console/tests/server/update/experiment-instance-guard.test.ts`：2 项（`/check` 为 `check_failed` + `experimental_instance`；`/apply-full` 拒绝且**从未构造 authority、从未 spawn**，workspace 无更新历史写入）。
- `packages/pd-console/tests/server/utils/gateway-experiment-guard.test.ts`：2 项（实验模式 stop/start 均拒绝且 `execFileSync` 零调用；生产模式仍走机器级服务）。
- 回归：`packages/pd-console/tests/server` 全量 729/731 通过；2 项失败为既有环境噪音（`examiner-v0101-p1-repair` 的 symlink `EEXIST`（已用 stash 基线复现，同样失败）、`recovery-control-registry` 的 5s 超时/EBUSY）。
- `create-principles-disciple`：`bootstrap-executor-source`、`backup-location`、`console-launch` 共 17/17 通过。

现场端到端（本机，正式实例全程未中断）：

```text
正式：~/.pd/active.json generation=67 releaseId=bundled-2.8.5-bdb316ebdc1a
      127.0.0.1:3100 PID 7068、127.0.0.1:18789 PID 13540 保持 LISTENING
实验：node scripts/dev/console-experiment.mjs --root D:/pd-exp-pri872 --port 13100 --no-auth
      → 根下生成 .pd / .pd-console / .openclaw / .codex / workspace
      → GET /api/update/check = { state: "check_failed", reason: "experimental_instance" }
      → 127.0.0.1:13100 PID 38168；关闭启动器后端口释放，无孤儿网关
哨兵：实验实例启动前后 active.json 的 sha256/16、generation、mtime 完全一致
      ~/.pd-console 未被创建（正式注册表未被触碰）
```

## 6. 本期未覆盖（显式残留）

1. **installer 自身不认实验根**：`npx create-principles-disciple` 仍以 `getHomeDir()` 安装，实验根内的“受控部署”尚未接线（SPEC §6.2 的完整闭环需要 install 路径同样认 `PD_EXPERIMENT_ROOT`）。
2. **宿主侧隔离**（SPEC §6.4）：OpenClaw 独立 profile/config（启动器已注入 `OPENCLAW_HOME`，但独立 gateway 配置与派生端口预检仍需真机验证）、Codex `CODEX_HOME` 注入（已注入，未验收）、测试消息通道换测试账号（未做）、浏览器认证（实验实例仍建议 `--no-auth` + loopback）。
3. **consistency cover**：更新历史、日志、临时锁在实验模式下已随 pdHome 就近，但 `scripts/dev` 侧其他工具（如 `dev:workspace:*`）未接入该契约。
4. `checkOpenClawGateway()` 在实验模式下读 `<root>/.openclaw/openclaw.json`，若该 profile 未初始化会显示“未运行”——这是正确行为，但尚无 UI 文案区分“实验网关未启动”与“配置缺失”。

## 7. Complexity Delta

- 新公共接口：**YES**（`resolvePdHome` / `PD_EXPERIMENT_ROOT` 契约，复用现有 install-layout）。
- 新平台行为：**YES**（实验进程/端口/网关归属；启动器持句柄）。
- 新数据契约：NO（未新增持久化格式；事务 journal、注册表仍为既有格式）。
- 新架构边界：NO（未新增子系统；控制台只是改为向既有 install-layout 提问）。
- 其余（跨包循环、后台进程、feature flag、新存储、通用编排）：NO。

Emotional value: N/A — 无 Owner 直接可见的行为变化（生产模式下端口、路径、更新流程全部保持原样）。
