# EvolutionWorker 启动问题排查手册

## 问题描述

EvolutionWorker 的 `start()` 方法从未被调用，导致 pain flag 检测不到、诊断任务不被处理、Nocturnal 管道瘫痪。

## 根因

OpenClaw 的 `startPluginServices()` 在 Gateway 启动时只调用一次，但我们的插件是**懒加载**的（`register()` 在第一次 `before_prompt_build` 时才触发）。当 `register()` 执行时，`startPluginServices()` 已经执行完毕。

## 修复

在 `before_prompt_build` 第一次执行时手动调用 `EvolutionWorkerService.start()`，使用 `resolveWorkspaceDirFromApi(api, 'main')` 获取默认 agent 的工作目录。

## 验证方法

```bash
# 查看 EvolutionWorker 是否启动
journalctl --user -u openclaw-gateway --since "5 min ago" --no-pager | grep "EvolutionWorker"

# 测试 pain flag
cat > ~/.openclaw/workspace-main/.state/.pain_flag << 'EOF'
source: manual
score: 75
time: 2026-04-13T15:11:00.000Z
reason: Test
EOF

# 等待心跳周期，查看日志
journalctl --user -u openclaw-gateway --since "1 min ago" --no-pager | grep -i "EvolutionWorker\|pain\|enqueued"
```

## 常见陷阱

1. **bundle.js 缓存**：`sync-plugin.mjs` 可能使用旧 dist/，直接编译更可靠
2. **api.logger 写到子系统日志**：用 `journalctl` 查看，不在 SYSTEM.log
3. **/tmp 在沙箱中不可写**：调试日志不要依赖 /tmp
4. **心跳被 requests-in-flight 阻止**：等心跳周期自动触发

## 正常链路的日志证据

```
[PD:EvolutionWorker] Starting with workspaceDir=~/.openclaw/workspace-main, stateDir=~/.openclaw/workspace-main/.state
[PD:EvolutionWorker] Detected pain flag (score: 75, source: manual). Enqueueing evolution task.
[PD:EvolutionWorker] Enqueued pain task XXXX (score=75)
[PD:EvolutionWorker] Wrote diagnostician task to diagnostician_tasks.json for task XXXX
```

## 历史
- 发现时间：2026-04-13
- 修复 PR：#290
