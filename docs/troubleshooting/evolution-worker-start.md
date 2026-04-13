# EvolutionWorker 启动问题排查手册

## 问题描述

EvolutionWorker 的 `start()` 方法从未被调用，导致：
- Pain flag 检测不到
- 诊断任务不被处理
- Nocturnal 管道完全瘫痪
- 队列中任务堆积，全部超时

## 根因

**OpenClaw 的插件加载时序问题**：

```
时间线：
─────────────────────────────────────────────────────────
Gateway 启动
  → loadGatewayStartupPlugins()
  → loadOpenClawPlugins()        ← 加载所有 enabled 插件
  → 对每个插件: plugin.register(api)
  → startPluginServices()        ← ⚠️ 调用所有已注册服务的 start()
    → for entry of registry.services:
        await service.start(ctx)  ← 此时我们的服务还没注册
  → Gateway 就绪
  → (等待第一次用户消息)
  → before_prompt_build 触发
  → 我们的 plugin.register(api)  ← 此时 startPluginServices() 早已结束
    → EvolutionWorkerService.api = api
    → api.registerService(EvolutionWorkerService)  ← 注册了，但没人调用 start()
```

**结论**：插件被懒加载，`register()` 在第一次 `before_prompt_build` 时才执行，而 `startPluginServices()` 已经在 Gateway 启动时执行完毕。

## 关键源码位置

### OpenClaw 侧

| 文件 | 行号 | 关键代码 |
|------|------|---------|
| `src/gateway/server-startup-post-attach.ts` | 27070 | `loadGatewayStartupPlugins()` 加载插件 |
| `src/gateway/server-startup-post-attach.ts` | 25232 | `startPluginServices()` 调用服务 start |
| `src/plugins/services.ts` | 33-60 | `startPluginServices` 实现 |
| `src/plugins/registry.ts` | 945 | `registerService` 只是添加到数组 |
| `src/plugins/loader.ts` | 479+ | `loadOpenClawPlugins` 懒加载机制 |

### 我们的插件侧

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/index.ts` | 160-195 | `before_prompt_build` hook，插件懒加载 |
| `src/service/evolution-worker.ts` | 2055+ | `EvolutionWorkerService.start()` 定义 |

## 修复方案

在 `before_prompt_build` 第一次执行时手动启动服务：

```typescript
// packages/openclaw-plugin/src/index.ts
api.on('before_prompt_build', async (event, ctx) => {
  const workspaceDir = resolveToolHookWorkspaceDirSafe(ctx, api, 'before_prompt_build');
  if (!workspaceDir) return;

  if (!workspaceInitialized) {
    // ⬇️ 关键修复：手动启动 EvolutionWorkerService
    EvolutionWorkerService.api = api;
    EvolutionWorkerService.start({
      config: api.config,
      workspaceDir,          // 使用 hook 提供的 workspaceDir
      stateDir: path.join(workspaceDir, '.state'),
      logger: api.logger,
    });

    migrateDirectoryStructure(api, workspaceDir);
    ensureWorkspaceTemplates(api, workspaceDir, language);
    SystemLogger.log(workspaceDir, 'SYSTEM_BOOT', `Principles Disciple online. workspaceDir=${workspaceDir}`);
    workspaceInitialized = true;
  }
  // ...
});
```

**为什么有效**：`before_prompt_build` 的 `ctx` 中已经有了 `workspaceDir`，来自当前会话的智能体上下文。

## 验证方法

### 1. 查看系统日志

```bash
# 检查 EvolutionWorker 是否启动
journalctl --user -u openclaw-gateway --since "5 min ago" --no-pager \
  | grep -i "EvolutionWorker\|workspaceDir"

# 应该看到类似输出：
# [PD:EvolutionWorker] Starting with workspaceDir=/home/csuzngjh/.openclaw/workspace-main, stateDir=/home/csuzngjh/.openclaw/workspace-main/.state
```

### 2. 创建测试 pain flag

```bash
cat > ~/.openclaw/workspace-main/.state/.pain_flag << 'EOF'
source: manual
score: 75
time: 2026-04-13T15:11:00.000Z
reason: Test pain flag for verification
EOF

# 等待下一个心跳周期（最长 60 秒），然后查看日志
journalctl --user -u openclaw-gateway --since "1 min ago" --no-pager \
  | grep -i "EvolutionWorker\|pain\|enqueued"
```

### 3. 验证队列状态

```bash
python3 -c "
import json
q = json.load(open('/home/csuzngjh/.openclaw/workspace-main/.state/evolution_queue.json'))
print(f'Total: {len(q)}')
print(f'Pending: {sum(1 for t in q if t[\"status\"]==\"pending\")}')
print(f'In-progress: {sum(1 for t in q if t[\"status\"]==\"in_progress\")}')
# 查找最新任务
new_tasks = sorted([t for t in q if t.get('timestamp','') > '2026-04-13T15:00'],
                    key=lambda x: x.get('timestamp',''))
for t in new_tasks:
    print(f'  {t[\"id\"]}: {t[\"status\"]} {t[\"taskKind\"]} {t.get(\"score\",\"?\")}')
"
```

### 4. 验证 diagnostician task 创建

```bash
python3 -c "
import json
d = json.load(open('/home/csuzngjh/.openclaw/workspace-main/.state/diagnostician_tasks.json'))
tasks = d.get('tasks', {})
pending = {k:v for k,v in tasks.items() if v.get('status')=='pending'}
print(f'Pending tasks: {len(pending)}')
for k,v in pending.items():
    print(f'  {k}: {v[\"prompt\"][:80]}')
"
```

## 常见陷阱

### 陷阱 1：bundle.js 缓存问题

`sync-plugin.mjs --dev` 的 `buildPlugin()` 函数内部调用 `esbuild.config.js`，但如果 `dist/bundle.js` 已存在且较新，esbuild 可能不会重新编译。

**症状**：源码改了，但日志中没有新功能输出。

**解决**：
```bash
# 方法 1：删除 bundle.js 再部署
rm dist/bundle.js
node scripts/sync-plugin.mjs --dev

# 方法 2：直接编译并拷贝（更快）
node esbuild.config.js --production
cp dist/bundle.js ~/.openclaw/extensions/principles-disciple/dist/bundle.js
systemctl --user restart openclaw-gateway
```

### 陷阱 2：api.logger 写到子系统日志

`api.logger.info()` 写入的是 OpenClaw 的 `[plugins]` 子系统日志，不是 SYSTEM.log。

**查看方法**：
```bash
journalctl --user -u openclaw-gateway --since "5 min ago" --no-pager | grep "[plugins]"
```

### 陷阱 3：/tmp 文件在沙箱中不可写

如果通过 `/tmp` 写调试日志，OpenClaw 的沙箱环境可能不允许写入。`fs.appendFileSync('/tmp/pd-debug.log', ...)` 的 try-catch 会静默失败。

**替代方案**：使用 `api.logger.info()` 或直接写到 `.state/` 目录。

### 陷阱 4：心跳被 requests-in-flight 阻止

`runHeartbeatOnce` 在有活跃请求时被跳过：
```
Immediate heartbeat result: status=skipped reason=requests-in-flight
```

诊断任务会在下次心跳周期（30 分钟）自动处理，或者通过智能体发新消息触发 `before_prompt_build`。

## 正常链路的日志证据

一个健康运行的 EvolutionWorker 应该产生以下日志：

```
# 1. 插件注册
[plugins] Principles Disciple Plugin registered. (Path: /home/csuzngjh/.openclaw/extensions/principles-disciple)
[plugins] [PD:health] Tool hook workspaceDir OK: "/home/csuzngjh/.openclaw/workspace-main"

# 2. EvolutionWorker 启动
[plugins] [PD:EvolutionWorker] Starting with workspaceDir=/home/csuzngjh/.openclaw/workspace-main, stateDir=/home/csuzngjh/.openclaw/workspace-main/.state
[plugins] [PD:EvolutionWorker] Timer configured: initialDelay=5000ms, interval=900000ms

# 3. 心跳周期运行
[plugins] [PD:EvolutionWorker] HEARTBEAT cycle=... idle=false idleForMs=8152
[plugins] [PD:EvolutionWorker] Queue snapshot: total=21 pending=0 in_progress=0

# 4. 检测到 pain flag
[plugins] [PD:EvolutionWorker] Detected pain flag (score: 75, source: manual). Enqueueing evolution task.
[plugins] [PD:EvolutionWorker] Enqueued pain task 67d5838b (score=75)
[plugins] [PD:EvolutionWorker] Wrote diagnostician task to diagnostician_tasks.json for task 67d5838b
[plugins] [PD:EvolutionWorker] Pain flag enqueued — runHeartbeatOnce available: true

# 5. 心跳触发诊断
[plugins] [PD:EvolutionWorker] Immediate heartbeat result: status=ran duration=...
```

## 部署检查清单

```bash
# 1. 编译
cd /home/csuzngjh/code/principles/packages/openclaw-plugin
node esbuild.config.js --production

# 2. 验证 bundle 内容
grep -c "EvolutionWorker" dist/bundle.js  # 应该 > 0
grep -c "workspaceDir" dist/bundle.js     # 应该 > 50

# 3. 部署
cp dist/bundle.js ~/.openclaw/extensions/principles-disciple/dist/bundle.js
cp dist/openclaw.plugin.json ~/.openclaw/extensions/principles-disciple/dist/openclaw.plugin.json
cp dist/templates ~/.openclaw/extensions/principles-disciple/dist/templates -r 2>/dev/null

# 4. 验证
md5sum ~/.openclaw/extensions/principles-disciple/dist/bundle.js
# 对比与 dist/bundle.js 的 md5

# 5. 重启
systemctl --user restart openclaw-gateway
sleep 5

# 6. 验证启动
journalctl --user -u openclaw-gateway --since "30 sec ago" --no-pager | grep -i "EvolutionWorker\|PD:"
```

## 历史

- **发现时间**：2026-04-13
- **影响范围**：所有 nocturnal pain diagnosis 功能
- **修复 PR**：#288 `fix/evolution-worker-start`
- **修复方式**：12 行代码，在 `before_prompt_build` 中手动调用 `EvolutionWorkerService.start()`
