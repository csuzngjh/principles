---
name: pd-setup
description: Use when the Owner asks to install, set up, restart-after-install, or verify Principles Disciple (PD) on this machine. Covers host detection (OpenClaw / Codex / WorkBuddy), the one-command installer, per-host restart semantics, and the post-install acceptance loop (pd health / pd mcp probe). Do not use for daily PD operation after acceptance — that belongs to pd-cli-operator / pd-control.
---
<!-- pd-agent-skill: pd-setup (owned by create-principles-disciple; safe to replace/remove via `npx create-principles-disciple agent-skill`) -->

<!-- Owner: create-principles-disciple (bootstrap channel). This skill is NOT
     part of the plugin-delivered skill set (skill-catalog parity) — it is the
     pre-install entry an agent has BEFORE PD exists on the machine. Canonical
     guidance: README_AGENT.md / README_AGENT_EN.md at the repository root,
     published at https://principles-website.pages.dev/install-agent.zh.md -->

# PD Setup（安装 · 重启 · 验收 / Install · Restart · Accept）

你被问到"装 PD / 装 Principles Disciple"时，按本技能执行。完整权威指南（含排错表）：
<https://principles-website.pages.dev/install-agent.zh.md>（英文：
<https://principles-website.pages.dev/install-agent.en.md>）。

## 第 0 步 · 宿主自判 / Detect the host

| 线索 / Signal | 宿主 / Host |
|---|---|
| `~/.openclaw/` 存在 | OpenClaw |
| `~/.codex/`（或 `CODEX_HOME`）存在；有 `codex plugin` 命令 | Codex |
| `~/.workbuddy/` 存在 | WorkBuddy |
| 都不像 / none match | 按 OpenClaw 处理（安装器默认 / installer default） |

前置 / Prerequisite: Node.js ≥ 22（`node -v`）。

## 第 1 步 · 安装 / Install

```bash
# OpenClaw（默认 / default）
npx create-principles-disciple --yes

# Codex
npx create-principles-disciple --host codex --yes

# WorkBuddy
npx create-principles-disciple --host workbuddy --yes
```

- 可加 `--provider openai --api-key-env OPENAI_API_KEY --model <id>` 一次配好 LLM（`--api-key-env` 是环境变量**名**，不是密钥）。
- 机器可读：加 `--json`，成功输出的 `postInstall` 块含逐宿主 `verifyCommand`。
- Codex 若返回 `manualActions`：这些命令你自己执行——`codex plugin marketplace add csuzngjh/principles` → `codex plugin add principles-disciple@principles` → 会话内 `$pd-control setup` → `/hooks` 信任 → 重跑安装器收敛。
- WorkBuddy：装完在插件管理里**启用** PD（全新安装默认未启用）。

## 第 2 步 · 重启语义 / Restart semantics

| 宿主 / Host | 动作 / Action |
|---|---|
| OpenClaw | 安装器已自动重启网关；仅当提示失败时手动 `openclaw gateway start` |
| Codex | **开新会话**（或重启 Codex）；`/hooks` 信任 |
| WorkBuddy | **开新会话**（或 `/reload-plugins`）；确认插件已启用 |

## 第 3 步 · 验收 / Acceptance loop

```bash
pd health --workspace "<工作区 / workspace>" --json    # summary.* 逐项看，非 ok 项按 nextAction 行动
pd mcp probe --workspace "<工作区 / workspace>" --json # MCP 活体探针（握手 + 契约工具）
```

- `summary.overall` = `healthy` 才算装好；`attention`/`error` 按 `nextAction` 修复后复跑。
- `pd` 不在 PATH 时用绝对路径 `~/.pd/runtime/bin/pd`（Windows：`pd.cmd`）。
- 控制台：`pd console open --workspace "<path>"`（owner 审核原则的界面）。

## 边界 / Boundaries

- 不要代 Owner 做审批决定；不要手改 `.pd/config.yaml`、`.principles/`、`.state/`。
- 验收通过后的日常运维走 `pd-cli-operator` / `pd-control` 技能（若已安装）。
