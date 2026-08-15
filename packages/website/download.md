---
layout: page
title: Download PD Companion
---

<DownloadCompanion lang="en" />

**PD Companion** is the Windows desktop app for Principles Disciple: one double-click gives you the full Console in its own window (no terminal, no browser tab), a tray icon, and system notifications when approvals need you.

## Requirements

| | |
|---|---|
| **OS** | Windows 10 / 11 (64-bit) |
| **Node.js** | ≥ 18 on PATH (`node -v`) — Companion runs the console server with your system Node |
| **PD** | Installed via `npx create-principles-disciple` (OpenClaw host) or the Codex plugin marketplace |

Companion is an add-on to an existing PD install — if the console is missing, it shows the exact fix instead of a blank window.

## First install in four steps

1. **Download** the installer above (or from GitHub Releases).
2. **Run it.** Windows may show a blue "Windows protected your PC" screen because the v1 installer is not code-signed: click **More info → Run anyway**.
3. **Launch PD Companion** from the desktop shortcut. The tray icon appears and the Console window opens with your data.
4. That's it. Auto-start on login is enabled by default and announced with a one-time balloon; turn it off any time from the tray menu.

## What it notifies about

- **New pending approval** — click the notification to jump straight to the review page.
- **New PD version available** — once per version, never nagging.

While you apply an update inside the Console, Companion restarts the console server automatically within ~30 seconds — no "Ctrl+C and rerun" needed.

## Control & uninstall

- Closing the window keeps Companion in the tray; **Exit** from the tray menu also stops the console server (no orphan processes).
- Uninstall from Windows Settings — it does **not** touch your PD install, `pd console open`, or workspace data.
