---
layout: page
title: 下载 PD Companion
---

<DownloadCompanion lang="zh" />

**PD Companion** 是 Principles Disciple 的 Windows 桌面应用：双击即用——完整控制台装进独立窗口（不碰终端、不开浏览器标签页），常驻系统托盘，有待审批事项时弹系统通知。

## 环境要求

| | |
|---|---|
| **操作系统** | Windows 10 / 11（64 位） |
| **Node.js** | ≥ 18 且在 PATH 中（`node -v` 可用）——Companion 使用系统 Node 运行控制台服务 |
| **PD** | 已安装：OpenClaw 宿主（`npx create-principles-disciple`）或 Codex 插件市场安装 |

Companion 是已装 PD 的增强入口——若控制台未安装，它会显示明确的修复指引，而不是白屏。

## 首次安装四步

1. **下载**上方安装包（或从 GitHub Releases 下载）。
2. **运行安装**。v1 安装包未做代码签名，Windows 可能弹出蓝色「Windows 已保护你的电脑」：点**更多信息 → 仍要运行**。
3. **双击启动** PD Companion。托盘图标出现，控制台窗口直接打开你的数据。
4. 完成。默认开机自启（首次运行气泡告知一次），随时可在托盘菜单关闭。

## 它会通知什么

- **新的待审批项**——点击通知直达审批页。
- **PD 新版本可用**——每个版本只提醒一次，不做重复打扰。

在控制台里点「更新」后，Companion 会在约 30 秒内自动重启控制台服务到新版本——不需要"Ctrl+C 后重跑"。

## 控制与卸载

- 关闭窗口后 Companion 仍驻留托盘；托盘菜单**退出**会同时停掉控制台服务，不留孤儿进程。
- 从 Windows 设置卸载——**不影响** PD 本体、`pd console open` 与工作区数据。
