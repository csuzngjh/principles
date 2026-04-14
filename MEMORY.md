# 项目记忆 — Principles Disciple

## 当前状态 (2026-04-14)
- **版本**: v1.10.x (PR #290 已合并)
- **OpenClaw 版本**: 2026.4.11
- **OpenClaw 源码**: `/home/csuzngjh/code/openclaw/`
- **Agent worktree**: `/home/csuzngjh/code/principles/agent-worktree` (分支 `agent-worktree`)

## 核心架构事实

### 多智能体工作目录
- 每个 agent 有**独立**的工作目录和独立的心跳任务
- 配置来源：`~/.openclaw/openclaw.json` → `agents.list`
- 8 个 agent：main、builder、pm、hr、repair、verification、research、resource-scout
- 每个 agent 的 workspace 由 `agents.list[].workspace` 指定
- 子代理复用主代理的工作目录

### 插件加载机制（关键）
- OpenClaw 的插件是**懒加载**的：`register()` 在第一次 `before_prompt_build` 时才触发
- `startPluginServices()` 在 Gateway 启动时只调用一次，此时我们的插件还没注册
- **`before_prompt_build` hook 按 agent 触发**，每个 agent 心跳时都会调用
- hook 的 `ctx.workspaceDir` 是**当前 agent 的工作目录**

### EvolutionWorker 正确设计 (PR #290 已实现)
- **每个 workspace 启动一个独立的 EvolutionWorker**
- 在 `before_prompt_build` 中，当 hook 触发时为该 workspace 启动 Worker
- 用 `startedWorkspaces: Set<string>` 去重（index.ts 模块级）
- 用 `EvolutionWorkerService._startedWorkspaces: Set<string>` 去重（evolution-worker.ts 服务级）
- 每个 Worker 只处理自己 workspace 的 `.pain_flag` 和 `evolution_queue.json`

### 配置化触发模式 (PR #290 已实现)
- 配置文件：`{workspaceDir}/.state/nocturnal-config.json`
- 新增 `periodic` 触发模式，绕过 idle 检测
- 当前 main workspace 配置：trigger_mode=periodic, period_heartbeats=2, max_runs_per_day=20
- 默认模式：trigger_mode=idle, max_runs_per_day=3

### 调试时的教训
1. **不要假设 `api.logger` 写到 SYSTEM.log** — 它写到 OpenClaw 的 `[plugins]` 子系统日志，用 `journalctl --user -u openclaw-gateway` 查看
2. **bundle.js 缓存问题** — `sync-plugin.mjs` 可能使用旧 dist/，验证时直接 `grep` 检查 bundle 内容
3. **查看 OpenClaw 源码是必须的** — 不读 `server-startup-post-attach.ts` 和 `services.ts` 就无法理解插件加载时序
4. **不要写死 agent ID 或路径** — 始终通过 hook 的 `ctx.workspaceDir` 或 `api.config.agents` 获取
5. **部署后必须验证 bundle 内容** — `grep "新代码特征" dist/bundle.js`，确认 md5 匹配
6. **代码操作纪律**：commit 前必须验证 staged 文件；写代码前必须 grep 确认 API 存在；修复后必须读回验证

## 部署
- `cd packages/openclaw-plugin && node scripts/sync-plugin.mjs --dev` 构建、同步、重启
- 验证部署：`grep "EvolutionWorker started for workspace:" ~/.openclaw/extensions/principles-disciple/dist/bundle.js`
- 查看运行时日志：`journalctl --user -u openclaw-gateway --since "5 min ago" | grep "PD:"`
- `npx tsx scripts/pipeline-health.ts --workspace ~/.openclaw/workspace-main` 健康检查

## 关键文件位置
- 插件源码: `packages/openclaw-plugin/src/`
- 测试: `packages/openclaw-plugin/tests/`
- OpenClaw 源码: `/home/csuzngjh/code/openclaw/`
- 插件配置: `~/.openclaw/openclaw.json`
- 状态文件: `~/.openclaw/workspace-*/.state/`
- 故障排查文档: `docs/troubleshooting/evolution-worker-start.md`
- Cron jobs: `~/.openclaw/cron/jobs.json`

## 已验证通的链路
- ✅ pain_flag 写入 → detection → queue → pain_diagnosis task → LLM runs → diagnostician report → principle 创建
- ✅ EvolutionWorker 每个 workspace 独立启动（8 个 agent 各有一个 Worker）
- ✅ periodic 触发模式工作正常（每 2 个心跳触发一次，约 2 分钟）
- ✅ 配置热更新（每次心跳重新读取 nocturnal-config.json）

## 待调通的链路
- ⏸️ sleep_reflection → nocturnal workflow → subagent → artifact/sample 创建
- 当前状态：sleep_reflection 任务可以入队，但 nocturnal workflow 需要通过 subagent 运行 Trinity 流程
- 需要验证：idle 检测 → enqueueSleepReflectionTask → NocturnalWorkflowManager.startWorkflow() → subagent.run() → artifact persistence

## 已知问题
- quota 默认只有 3 次/天（已通过配置改为 20）
- idle 检测依赖无活跃会话，开发中很难触发（已通过 periodic 模式绕过）
- 所有 sleep_reflection 相关日志已从 debug 改为 info 级别
