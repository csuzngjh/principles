---
layout: page
title: Download PD Companion
---

<DownloadCompanion lang="en" />

## Prerequisites

PD Companion is a desktop companion for an **existing** Principles Disciple install:

1. **Node.js ≥ 18** on PATH (`node -v`) — Companion runs the console server with your system Node.
2. **PD installed** via `npx create-principles-disciple`. If the console is missing, Companion shows the exact fix instead of a blank window.

## What it does

- One double-click: tray icon + the full Console in its own window (no terminal, no browser tab).
- System notification when a new approval is pending — click to jump straight to the review page.
- System notification when a new PD version is available (once per version).
- Restart the console service from the tray; after you apply an update in the Console, Companion restarts the server within ~30 seconds.

## Windows SmartScreen notice

The v1 installer is **not code-signed**. On first launch Windows may show a blue "Windows protected your PC" screen:

1. Click **More info**.
2. Click **Run anyway**.

This is expected for v1; we will sign installers once distribution scales.

## Control & uninstall

- Auto-start on login is enabled by default (announced on first run) — toggle it in the tray menu at any time.
- Closing the window keeps Companion in the tray; use **退出 / Exit** to quit (the console server is stopped with it, no orphan processes).
- Uninstall from Windows Settings. Uninstalling Companion does **not** touch your PD install, `pd console open`, or workspace data.
