---
layout: page
title: 下载 PD Companion
---

<DownloadCompanion lang="zh" />

## 前置条件

PD Companion 是已安装的 Principles Disciple 的桌面伴侣应用：

1. **Node.js ≥ 18** 已在 PATH 中（`node -v` 可用）——Companion 使用系统 Node 运行控制台服务。
2. 已通过 `npx create-principles-disciple` **安装 PD**。若控制台未安装，Companion 会显示明确的修复指引，而不是白屏。

## 它做什么

- 双击即用：托盘图标 + 独立窗口中的完整控制台（无需终端、无需浏览器标签页）。
- 出现新的待审批项时弹系统通知——点击直达审批页。
- 有新版本可用时提醒一次（同一版本不重复打扰）。
- 托盘一键重启控制台服务；在控制台里点「更新」成功后，Companion 会在约 30 秒内自动重启服务到新版本。

## Windows SmartScreen 提示

v1 安装包**未做代码签名**。首次运行时 Windows 可能弹出蓝色「Windows 已保护你的电脑」提示：

1. 点击**更多信息**。
2. 点击**仍要运行**。

这是 v1 的预期行为；分发规模扩大后我们会购买签名证书。

## 控制与卸载

- 默认开机自启（首次运行时会气泡告知），可随时在托盘菜单关闭。
- 关闭窗口后 Companion 仍驻留托盘；从托盘菜单**退出**会同时停掉控制台服务，不留孤儿进程。
- 从 Windows 设置卸载。卸载 Companion **不影响** PD 本体、`pd console open` 与工作区数据。
