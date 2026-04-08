# 项目记忆 — Principles Disciple

## 当前状态 (2026-04-08)
- **版本**: v1.8.2 (main commit 4550be2c)
- **PR #178**: 已合并到 main (d9aec3fa) — Issues #177-#190 全部修复并关闭
- **PR #191**: 代码评审完成，16 个问题已验证并提交到 PR 评论
- **分支清理**: 所有已合并远程分支已删除

## 待处理
- PR #191 需要修复 3 个 Critical + 8 个 Major 问题
  - C1: 生命周期命令使用 mutateLedger 统一读写锁
  - C2: Replay Engine 添加 sampleToRuleHostInput 转换器
  - C3: deleteImplementationAssetDir 加 withLock
  - M1-M8: 读取加锁、路由修复、日志统一、级联删除等
- PR #191 合并冲突需要 rebase 到 main

## 部署流程
```bash
cd packages/openclaw-plugin && node scripts/sync-plugin.mjs --dev
```
- `--bump/-b` 自动检测未提交源码变更并 bump 版本号
- `npx tsx scripts/pipeline-health.ts --workspace ~/.openclaw/workspace-main` 健康检查

## 关键文件位置
- 插件源码: `packages/openclaw-plugin/src/`
- 测试: `packages/openclaw-plugin/tests/`
- OpenClaw 源码: `../openclaw/` (核实框架行为时必须查阅)
- 状态文件: `~/.openclaw/workspace-main/.state/`
- Cron jobs: `~/.openclaw/cron/jobs.json`
