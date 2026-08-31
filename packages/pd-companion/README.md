# PD Companion

Windows 桌面常驻应用（PRI-526）：托盘 + 系统通知 + 双击启动，把 PD 控制台从"命令行拉起的网页"变成常驻伴侣应用。

## 定位（薄壳原则）

Companion **不内嵌**控制台服务端代码。它只做三件事：

1. 用**系统 Node**（better-sqlite3 ABI 约束，不可用 Electron 内置 Node）执行已安装的
   `pd console open --json --no-browser`（与 installer 的 autoLaunchConsole 同一条生产链路）；没有有效 `PD_CONSOLE_TOKEN` 时才追加 `--no-auth`；
2. 解析 CLI 的 JSON 输出（按 unknown 校验，见 `src/lib/launch-result.ts`），把
   `http://127.0.0.1:<port>` 装进独立窗口；
3. 监管该进程：崩溃退避重启（1s/2s/4s，稳定运行 60s 后重新计数，3 次快速崩溃进降级）、
   退出时回收、审批/更新通知（每版本一次）、npm 层更新后 ≤30s 自动重启服务。

行为契约见 `docs/specs/features/companion/*.feature`（supervisor 生命周期 / 通知去重 / 降级路径 / 输出解析）。

## 结构

- `src/lib/` — 纯逻辑（全部可单测，无 Electron 依赖）：locate / launch-result / supervisor / degraded / state-store / poller
- `src/main/` — Electron 胶水（薄）：托盘、窗口、通知、自启、日志
- `tests/lib/` — 单测；`tests/bdd/` — Gherkin 场景步骤

## 开发

```bash
npm run build        # tsc
npm test             # vitest（含 BDD）
npm run typecheck
npx electron .       # 本地启动（需已安装 PD 与系统 Node）
npm run dist         # electron-builder 打 NSIS 安装包（Windows）
```

## 分发

`companion-release.yml`（windows-latest，tag `companion-v*` 或手动触发）→ GitHub Releases → 官网 `/download` 页。
v1 安装包未签名，官网有 SmartScreen 引导文案。

## 已知边界

- 有效 `PD_CONSOLE_TOKEN` 仅通过子进程环境继承，绝不复制到 argv、日志或 launch JSON；Companion 会验证启动/复用实例报告的 authentication mode。
- 未配置或仅为空白 token 时保留 loopback-only `--no-auth` 降级；配置 token 后鉴权失败不会自动退回 no-auth。
- Electron 胶水（托盘/通知点击）由验收清单在真实安装包上人工验证；CI 覆盖纯逻辑层。
- v1 绑定默认工作区（`workspaceOverride` 状态存储），多工作区切换是 Phase 2。
