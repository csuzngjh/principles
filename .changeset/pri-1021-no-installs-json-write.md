---
"create-principles-disciple": patch
---

PRI-1021：安装器不再写 OpenClaw 宿主的 `~/.openclaw/plugins/installs.json`。该文件自 OpenClaw 2026.10.5 起会被 doctor 状态迁移硬拒，导致网关以 exit 78 循环重启；插件注册只由 `openclaw.json` 与宿主自身的安装流程负责。
