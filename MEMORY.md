# 项目记忆 — Principles Disciple

## 当前状态 (2026-04-08)
- **版本**: v1.8.2 (PR #178 已合并到 main)
- **分支**: main 包含 Issues #177-#190 全部修复
- **下一版本**: v1.9.0 (PR #191 principle tree ledger + rule host + replay engine)

## 待处理
- PR #191 代码评审发现 16 个问题（3 Critical, 8 Major, 4 Minor）
- PR #191 merge 状态为 CONFLICTING — 需要 rebase 到 main

## 部署
- `cd packages/openclaw-plugin && node scripts/sync-plugin.mjs --dev` 构建、同步、重启
- `--bump/-b` 标志自动检测未提交变更并 bump 版本号
- `npx tsx scripts/pipeline-health.ts --workspace ~/.openclaw/workspace-main` 健康检查

## 关键文件位置
- 插件源码: `packages/openclaw-plugin/src/`
- 测试: `packages/openclaw-plugin/tests/`
- OpenClaw 源码: `../openclaw/` (核实框架行为时必须查阅)
- 状态文件: `~/.openclaw/workspace-main/.state/`
- Cron jobs: `~/.openclaw/cron/jobs.json`
