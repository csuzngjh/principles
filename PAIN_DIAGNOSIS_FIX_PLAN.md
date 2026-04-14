# Pain Diagnosis Task 饥饿问题 — 修复方案

## 问题总结

| 层级 | 问题 | 影响 |
|------|------|------|
| L1 症状 | `8a5e08f4` 永久卡住 | 任务既不完成也不清理 |
| L2 机制 | 双 store 状态分裂 + 无超时清理 | EvolutionWorker 等 marker，prompt hook 读 pending，两边不一致 |
| L3 根因 | `runHeartbeatOnce` 是 one-shot，被 `requests-in-flight` 跳过就没有重试 | 插件调用不走 wake layer 重试路径 |

## 根因分析（5 Whys）

1. **Why 任务卡住？** → 双 store 状态分裂 + 无超时清理
2. **Why agent 没处理？** → heartbeat 被 `requests-in-flight` 跳过
3. **Why 跳过后不重试？** → `runHeartbeatOnce` 是 one-shot 调用，不走 wake layer 重试路径（OpenClaw 设计特性）
4. **Why 不走重试？** → OpenClaw 把插件调用视为"立即尝试一次"，重试由插件自己负责
5. **Why 没有备用路径？** → 诊断任务只有 heartbeat 注入一条执行路径，无独立通道

---

## 修复方案（3 个 Phase）

### Phase 1：超时清理（止血，最低风险）

**目标**：给 `pain_diagnosis` 任务加超时，避免永久卡住。

**改动文件**：`evolution-worker.ts`

**逻辑**：在 `processEvolutionQueue` 中，检测 `pain_diagnosis` 任务的 `started_at` 时间，超过 30 分钟未完成的标记为 `failed` 并清理。

```typescript
const PAIN_DIAGNOSIS_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

for (const task of queue.filter(t => 
    t.status === 'in_progress' && t.taskKind === 'pain_diagnosis'
)) {
    const startedAt = task.started_at ? new Date(task.started_at).getTime() : 0;
    if (startedAt > 0 && (Date.now() - startedAt) > PAIN_DIAGNOSIS_TIMEOUT_MS) {
        logger.warn(`[PD:EvolutionWorker] Pain diagnosis task ${task.id} timed out after 30min`);
        task.status = 'failed';
        task.resolution = 'diagnostician_timeout';
        task.completed_at = new Date().toISOString();
        queueChanged = true;
    }
}
```

**风险**：极低。只是加了一个兜底清理逻辑，不影响正常流程。

---

### Phase 2：统一状态源（根治双 store 分裂）

**目标**：让 prompt 注入和 EvolutionWorker 读取同一个状态源，消除分裂。

**改动文件**：
- `diagnostician-task-store.ts` — 加 `setTaskStatus()` 方法
- `evolution-worker.ts` — 写入 `diagnostician_tasks.json` 时同步更新 status
- `prompt.ts` — 读取时过滤掉 `in_progress` 超时的任务

**逻辑**：
1. EvolutionWorker 标记 `in_progress` 时，同时写 `diagnostician_tasks.json` 的 status
2. prompt 注入读取 pending 任务时，额外检查 `diagnostician_tasks.json` 里的实际 status
3. 如果任务在 `evolution_queue.json` 里是 `in_progress` 但超过 15 分钟没完成，prompt 不再注入（避免重复）

---

### Phase 3：独立重试路径（根因修复）

**目标**：当 `runHeartbeatOnce` 被 `requests-in-flight` 跳过时，启动定时重试。

**改动文件**：`evolution-worker.ts`

**方案**：在 pain flag enqueued 后，不依赖 `runHeartbeatOnce` 的一次性调用，而是调用 `requestHeartbeatNow()`。wake layer 会自动重试（1 秒间隔，直到不 busy）。

```typescript
if (painCheckResult.enqueued) {
    // requestHeartbeatNow 会进入 wake layer，wake layer 会在 requests-in-flight 时自动重试
    api.runtime.system.requestHeartbeatNow({
        reason: `pd-pain-diagnosis: pain flag detected`,
    });
}
```

**为什么这能工作**：
- `requestHeartbeatNow` → `queuePendingWakeReason` → `schedule(250ms)` → timer 触发 → `active()` → `runOnce()`
- 如果 `requests-in-flight` → wake layer 自动 `schedule(DEFAULT_RETRY_MS=1000, "retry")` → 1 秒后再试
- 无限循环直到 heartbeat 成功执行或被其他原因跳过

---

## 实施计划

| Phase | 内容 | 改动文件 | 风险 | 验证方式 |
|-------|------|---------|------|---------|
| **P1** | 超时清理 | `evolution-worker.ts` | 极低 | 部署后等 30 分钟观察卡住的任务是否被清理 |
| **P2** | 统一状态源 | `diagnostician-task-store.ts`, `evolution-worker.ts`, `prompt.ts` | 低 | 检查双 store 状态是否一致 |
| **P3** | 独立重试路径 | `evolution-worker.ts` | 中 | 模拟 agent 繁忙场景，验证 wake layer 重试 |

---

## 验证清单

- [ ] P1: 超时清理生效，30 分钟后的卡住任务被标记为 failed
- [ ] P2: 双 store 状态一致，不再有分裂
- [ ] P3: agent 繁忙时 wake layer 自动重试，诊断任务最终被执行
- [ ] CI: tsc-plugin + Lint 全部通过
- [ ] E2E: 创建 PR 并合并到 main
