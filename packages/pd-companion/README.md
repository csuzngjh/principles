# PD Companion

Windows 桌面常驻应用（PRI-526）：托盘 + 系统通知 + 独立 Console 窗口，把 PD 控制台从命令行拉起的网页变成 Owner 的桌面入口。

## 当前实现职责（源码基线：2026-11-27）

Companion 是 UI / Control Plane 桌面壳，**不再承担任何后台任务执行或 Worker 生命周期管理**：

1. 用系统 Node（better-sqlite3 ABI 约束，不使用 Electron 内置 Node）执行已安装的 pd console open --json --no-browser；
2. 解析 CLI JSON 输出并校验 launch result，把本地 Console URL 装进独立窗口；
3. 监督 Console Server 子进程：崩溃退避重启（1s / 2s / 4s；稳定运行 60s 后重新计数；快速崩溃达到预算后进入 degraded）、CLI 入口缺失时有界等待更新链落盘，并在退出时回收 Companion 自己启动的 Console；
4. 轮询待审批、版本更新与安装发布权威，负责托盘/通知/窗口等 Owner 可见控制面行为；
5. 在 Companion before-quit 路径只停止 Console 控制权范围内的进程；Workspace 后台执行完全由 PD Service Host 拥有。

窗口关闭与进程退出不同：关闭所有窗口后 Companion 保留在系统托盘；真正退出 Companion 只会结束它自己的 Console 监督，不会也不应停止 Service Host 拥有的后台执行。

行为契约见 docs/specs/features/companion/*.feature（supervisor 生命周期、通知去重、降级路径和输出解析）。

## 结构

- src/lib/ — 纯逻辑（尽量不依赖 Electron）：locate / entry-verdict / launch-result / supervisor / degraded / state-store / poller / release-watch / version-handover
- src/main/ — Electron 胶水：托盘、窗口、通知、自启、日志、Console 生命周期接线
- tests/lib/ — 单测与 Service-Host-only 负向边界守卫；tests/bdd/ — Gherkin 场景步骤

相关源码：
- src/main/main.ts — Console 启动/监督/退出接线（唯一的子进程职责）
- src/lib/supervisor.ts — Console 子进程监督
- src/lib/release-watch.ts — Console 所在安装发布权威交接判定

## 架构边界（Service-Host-only）

[PD Service Host Architecture SPEC](../../docs/specs/SPEC-PD-SERVICE-HOST-001.md) 定义的目标边界在 Companion 侧已经落地：PD Service Host 是唯一后台运行时，Companion 只保留 UI / Control Plane。

- Companion 不启动、监督、调度、重启、drain 或交接任何 Codex / WorkBuddy / OpenClaw Worker；
- Companion 不把安装清单中的 Workspace 列表解释为进程创建授权；该列表只属于 Service Host 的执行面；
- Companion 退出、升级或 Console 窗口关闭，不得停止已启用的 Service Host；
- Companion 唯一的子进程职责是启动并监督 Owner 可见的本地 Console 服务。

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
- 当前 v1 绑定默认工作区（workspaceOverride 状态存储）；多工作区切换是独立产品能力，与 Service Host 的多 Workspace 后台执行清单不是同一职责。
