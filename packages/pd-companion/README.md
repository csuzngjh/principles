# PD Companion

Windows 桌面常驻应用（PRI-526）：托盘 + 系统通知 + 独立 Console 窗口，把 PD 控制台从命令行拉起的网页变成 Owner 的桌面入口。

## 当前实现职责（源码基线：2026-11-19）

Companion **当前不只是 UI 薄壳**。除桌面交互外，它还承担了部分后台进程生命周期管理：

1. 用系统 Node（better-sqlite3 ABI 约束，不使用 Electron 内置 Node）执行已安装的 pd console open --json --no-browser；
2. 解析 CLI JSON 输出并校验 launch result，把本地 Console URL 装进独立窗口；
3. 监督 Console Server 子进程：崩溃退避重启（1s / 2s / 4s；稳定运行 60s 后重新计数；快速崩溃达到预算后进入 degraded）、CLI 入口缺失时有界等待更新链落盘，并在退出时回收；
4. 从 PD 安装清单发现 Codex / WorkBuddy Workspace，创建并监督对应的长运行 CLI Worker；
5. 周期性重新核对 Workspace 清单，并将 Worker 降级、恢复和停止状态反映到日志、托盘和通知；
6. 在 Companion before-quit 路径停止 Console Server 和当前由它监督的 Workspace Workers。

窗口关闭与进程退出不同：关闭所有窗口后 Companion 保留在系统托盘；真正退出 Companion 才会执行 Worker supervision shutdown。

行为契约见 docs/specs/features/companion/*.feature（supervisor 生命周期、通知去重、降级路径和输出解析）。

## 结构

- src/lib/ — 纯逻辑（尽量不依赖 Electron）：locate / entry-verdict / launch-result / supervisor / degraded / state-store / poller / Workspace Worker Registry
- src/main/ — Electron 胶水：托盘、窗口、通知、自启、日志、Console 与 Worker 生命周期接线
- tests/lib/ — 单测；tests/bdd/ — Gherkin 场景步骤

相关源码：
- src/main/main.ts — Console 与 Workspace Worker 的启动/退出接线
- src/lib/workspace-workers.ts — Workspace Worker Registry、进程监督、重启与 drain
- src/lib/supervisor.ts — Console 子进程监督

## 目标架构边界（尚未实现）

[PD Service Host Architecture SPEC](../../docs/specs/SPEC-PD-SERVICE-HOST-001.md) 提议把 PD 后台任务的触发和生命周期从 Companion / OpenClaw Gateway 移出：

- Service Host 成为 PD-owned 后台触发者；V1 采用用户级 OS scheduler + 有界 run-once，不引入常驻通用 Daemon；
- Companion 只读取服务状态、展示通知并提供显式操作入口；
- Companion 退出、升级或 Console 窗口关闭，不得停止已启用的 Service Host；
- Service Host 迁移完成前，当前 Companion Worker supervision 仍是现有 Codex / WorkBuddy 路径的生命周期所有者。

**重要：上述是目标架构提案，不是当前已部署行为。** ADR-0020 §11.1 仍然有效；任何运行时迁移必须先获得 Owner 对 ADR 的明确批准，并通过单一生命周期所有者切换 Gate。

## 开发

~~~bash
npm run build        # tsc
npm test             # vitest（含 BDD）
npm run typecheck
npx electron .       # 本地启动（需已安装 PD 与系统 Node）
npm run dist         # electron-builder 打 NSIS 安装包（Windows）
~~~

## 分发

companion-release.yml（windows-latest，tag companion-v* 或手动触发）→ GitHub Releases → 官网 /download 页。
v1 安装包未签名，官网有 SmartScreen 引导文案。

## 已知边界

- 控制台没有令牌/密码：打开控制台等同于使用当前操作系统的本地会话。Companion 只继承子进程环境，不保存任何凭证。
- Electron 胶水（托盘/通知点击）由验收清单在真实安装包上人工验证；CI 覆盖纯逻辑层。
- 当前 v1 绑定默认工作区（workspaceOverride 状态存储）；多工作区切换是独立产品能力，不等于后台 Worker 已支持的多 Workspace 清单监督。
