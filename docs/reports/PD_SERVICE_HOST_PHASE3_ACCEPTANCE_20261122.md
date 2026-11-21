# PD Service Host Phase 3 真实安装验收报告（PRI-1281，2026-11-22）

> 结论：**PASS_WITH_LIMITATIONS**（Windows 平台在适配器层完成真实 OS 全生命周期验收；真实安装态 CLI 的注册与观察窗因验收主机 UAC 控制台同意不可得而 PENDING，复跑脚本就绪；macOS / Linux 真实平台 NOT_VERIFIED）。
> 权威：SPEC-PD-SERVICE-HOST-001 v0.3 §11 Phase 3 / §10；工单 PRI-1281 §9F/§10。
> 分支：`ai/PRI-1281-service-scheduler`（提交链见文末）。

## 1. 验收环境

- Windows 主机 `SK-20230410INTQ`（win32 10.0.26200，zh-CN，medium 完整性级会话）。
- **加固策略（实测）**：非提升（medium token）进程创建计划任务被整机策略拒绝（`Register-ScheduledTask` → `0x80070005 Access is denied`；`schtasks /Create` 同样拒绝）。读取（Get/Query）不受影响。
- UAC：`ConsentPromptBehaviorAdmin=5`（Windows 二进制静默提升）；但当控制台会话不可交互（断开/锁屏）时，提升同意被自动取消（`操作已被用户取消`）——本验收会话后段即处于该状态。

## 2. 发布候选（§10 步骤 1-3）——✅ PASS

- `build-self-contained-release.mjs` 真实构建：payload 157,939 文件，`_release/product-identity.json` 盖章（productVersion 2.8.10；sourceCommit `e53384e96`——构建按工作树进行，内容含 `68ff46464` homeDir 修复，戳为构建启动时的 HEAD，如实记录）；payload hygiene 检查通过（无编译测试产物）；sha256 `415c2325…`。
- 普通 `npm pack` 产物会被安装器 PRI-874 防线正确拒绝（缺 product-identity）——防线有效证据。
- 隔离 home（`D:\Code\principles\.tmp\pri-1281\acceptance\home`）真实安装：`create-principles-disciple --yes --host codex` → `.pd/runtime`（pd-cli dist + bin shim）、`install.json`、`active.json`（releaseId `bundled-2.8.10-b18dff8a7762`，generation 1）全部就绪。结果=**合法部分完成**（Codex Marketplace 人工步骤属预期，rc-9 语义正确）。

## 3. 真实安装态 CLI（§10 步骤 4）——✅ PASS

`node <installed>/runtime/pd-cli/dist/index.js service status --json --pd-home <home>`（非提升）：

- 身份：`homeSource: injected`、pdHome/activeRelease 正确解析（`bundled-2.8.10`，valid）。
- 契约：`pd.service-status.v1`，`registered:false / enabled:false`（未注册基线）、安装键派生任务名 `PrinciplesDisciple-ServiceHost-81a18c136a`、triggerConfiguration 指向安装态 CLI 入口。
- 状态读取未启动 Worker、未写业务数据。

## 4. Windows Task Scheduler 真实生命周期（§9F）——✅ PASS（适配器层，2026-11-22 00:57 会话取证）

当时控制台同意可用，进程测试（隔离安装身份）全绿（22/22）：

1. **诚实契约（真实验证）**：非提升注册被拒 → 结构化 `command_failed:scheduler_mutation_failed:…AccessDenied`，绝不呈现为"未安装"。
2. 提升 PowerShell 桥运行同一 adapter 脚本：install → **registered + DISABLED**；幂等重装保持 disabled；enable → enabled（OS 读回 + 间隔 PT1M=60000ms 正确解析）。
3. **真实 OS 启动**：`Start-ScheduledTask` 后 `LastRunTime` 离开哨兵、`LastTaskResult` 为真实退出码（缺失的 CLI 入口 → 非零，恰证 OS 执行的是我们注册的命令行）。
4. disable → disabled；uninstall → 注册消失；再 uninstall → 幂等 no-op。
5. 清理后 `schtasks /Query` 全表零遗留 `PrinciplesDisciple-ServiceHost-*` / `PDProbe*` 任务。

真实平台缺陷修复（均以真机复现驱动）：XML 不可带 encoding 声明（0x8004131a"无法切换编码"）；`Get-Content` 须 `-Encoding UTF8`（zh-CN ANSI 代码页会损坏中文路径）；NotFound 判定按 FQEId `CmdletizationQuery_NotFound_*`；never-run 判空按 `LastTaskResult=267011`（哨兵时间戳存在 1899 与 1999 两种）；重复间隔下限 PT1M（契约下限收紧至 60s）。

## 5. 真实安装态的调度器注册与观察窗（§10 步骤 5-21）——⏸ PENDING（环境阻断，复跑就绪）

- 阻断：本会话后段控制台同意不可得 → 提升运行真实 CLI（`service install`）的 UAC 请求被自动取消（§1）。**非产品缺陷**：适配器与 CLI 路径均已在第 3/4 节分别实证。
- 就绪的复跑序列（控制台可用时 ~1.5h，脚本与产物在 `.tmp/pri-1281/acceptance/`，工单 §10 全步骤映射）：
  1. `step-install.ps1`（提升）→ 真实 CLI `service install --json --pd-home <home>` → 预期 installed_disabled；
  2. fixture 清单（`ws/sh-owned` 合法 service_host_owned marker + `ws/legacy-ws` legacy marker，写进隔离安装的 install.json——工单 §10 明示允许的隔离安装 fixture，不动生产 marker）；
  3. `service enable` → 周期触发（60s 间隔）→ 观察 ≥10 次触发 + ≥1h 窗口（`run-once-status.json` 的 `triggerSource:"scheduler"`、OS LastRunTime 序列、单实例锁无重叠、sh-owned 真实有界周期推进、legacy 全程 skipped）；
  4. `service disable` → ≥2 周期无新触发；`service uninstall` → 注册消失、Workspace 数据/state.db/清单完整；重装恢复。
- 观察窗内单 Workspace 业务任务推进深度受 fixture 无真实 pending task 限制（沿用 Phase 2 真实周期验收口径：真实周期 + 真实进展证据读取；无预置任务时为合法空周期）。

## 6. macOS / Linux —— ⚠️ NOT_VERIFIED（如实声明）

单元测试覆盖于伪造命令边界（plist/unit 内容、launchctl/systemctl 序列、幂等/外部冲突/诚实失败映射），无真实 Darwin/Linux 主机。平台差异（登录前/注销后不触发、Linux 不启用 linger）已在运行手册矩阵如实声明。

## 7. 安装器集成验证

- 桥接单测 9/9（同意门控、refresh-if-registered、卸载撤销、env 清洗、无凭据越界、ERR-197 告警语义）。
- 真实安装运行中桥接未触发（未传同意旗标）→ 无静默注册，符合 §6。
- installer `test:fast` 全绿（本 PR 改动范围内）。

## 8. 提交链

- `e53384e96…` Phase 3 全量（调度器/managed/状态契约/CLI/installer 桥/Console 路由/文档/测试）
- `68ff46464` `--pd-home` 必须传受信 HOME 根（真实安装验收发现的缺陷修复）+ 进程测试双轨重构
- `3faf59c86` 控制台同意不可得时进程测试显式 skip

## 9. 最终结论

**PASS_WITH_LIMITATIONS**：Phase 3 的架构、契约、三平台实现、CLI 命令面、installer 集成、Console 只读面全部交付并有单元/进程级证据；Windows 在适配器层完成真实 OS 全生命周期 + 真实安装态 CLI 状态契约实证；限制为（a）真实安装态的调度器注册+观察窗待控制台同意可用后按第 5 节脚本补跑（约 1.5h），（b）macOS/Linux 真实平台 NOT_VERIFIED。不得将本阶段结论等同于 Production Cutover（SPEC §2.0）。
