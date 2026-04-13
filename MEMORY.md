# 项目记忆 — Principles Disciple

## 当前状态 (2026-04-13)
- **版本**: v1.10.x
- **最新修复**: #288 `fix/evolution-worker-start` — EvolutionWorkerService.start() 手动启动
- **OpenClaw 版本**: 2026.4.11
- **OpenClaw 源码**: `/home/csuzngjh/code/openclaw/`

## 待处理
- PR #191 代码评审发现 16 个问题（3 Critical, 8 Major, 4 Minor）
- PR #191 merge 状态为 CONFLICTING — 需要 rebase 到 main

## 部署
- `cd packages/openclaw-plugin && node scripts/sync-plugin.mjs --dev` 构建、同步、重启
- `--bump/-b` 标志自动检测未提交变更并 bump 版本号
- **⚠️ 缓存陷阱**：`sync-plugin.mjs` 的 esbuild 可能缓存旧 bundle，直接编译更可靠：
  ```bash
  node esbuild.config.js --production
  cp dist/bundle.js ~/.openclaw/extensions/principles-disciple/dist/bundle.js
  systemctl --user restart openclaw-gateway
  ```
- `npx tsx scripts/pipeline-health.ts --workspace ~/.openclaw/workspace-main` 健康检查

## 关键文件位置
- 插件源码: `packages/openclaw-plugin/src/`
- 测试: `packages/openclaw-plugin/tests/`
- OpenClaw 源码: `/home/csuzngjh/code/openclaw/` (核实框架行为时必须查阅)
- 状态文件: `~/.openclaw/workspace-main/.state/`
- Cron jobs: `~/.openclaw/cron/jobs.json`
- 故障排查文档: `docs/troubleshooting/evolution-worker-start.md`

## 核心教训 — EvolutionWorker 启动问题 (2026-04-13)

### 根因
OpenClaw 的 `startPluginServices()` 在 Gateway 启动时只调用一次，但我们的插件是**懒加载**的（`register()` 在第一次 `before_prompt_build` 时才执行）。当 `register()` 执行时，`startPluginServices()` 已经结束，所以 `EvolutionWorkerService.start()` 从未被自动调用。

### 修复
在 `before_prompt_build` hook 第一次执行时手动调用 `EvolutionWorkerService.start()`，使用 hook 提供的 `workspaceDir`。

### 调试时的教训
1. **不要假设 `api.logger` 写到 SYSTEM.log** — 它写到 OpenClaw 的 `[plugins]` 子系统日志，用 `journalctl` 查看
2. **`/tmp` 文件在沙箱中可能不可写** — 调试日志不要依赖 `/tmp`
3. **bundle.js 缓存问题** — `sync-plugin.mjs` 可能使用旧的 dist/，验证时一定要确认 bundle 内容确实更新了
4. **查看 OpenClaw 源码是必须的** — 不读 `server-startup-post-attach.ts` 和 `services.ts` 就无法理解插件加载时序
5. **验证方法**：`grep "EvolutionWorker" journalctl` 看启动日志；创建 test pain flag 看检测日志
6. **心跳被 requests-in-flight 阻止** — `runHeartbeatOnce` 在有活跃对话时跳过，等心跳周期自动触发

### 代码操作纪律（已有，补充）
7. **部署后必须验证 bundle 内容** — `grep "新代码特征" dist/bundle.js`，确认 md5 匹配
8. **关键服务启动必须有日志** — 启动时打印 workspaceDir，确认路径正确

## 智能体工作目录问题
- 在 `before_prompt_build` hook 中，`resolveToolHookWorkspaceDirSafe()` 能正确获取当前会话智能体的工作目录
- 不要写死 `main` 或其他 agent ID — 始终通过 hook 的 `ctx` 获取
