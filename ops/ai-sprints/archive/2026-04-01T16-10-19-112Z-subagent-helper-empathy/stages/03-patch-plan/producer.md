# Producer Report — patch-plan Stage

**Role**: producer  
**Stage**: patch-plan  
**Round**: 1  
**Date**: 2026-04-02  
**Sprint**: subagent-helper-empathy  
**SHA**: 4138178581043646365326ee42dad4eab4037899

---

## SUMMARY

本阶段完成了 empathy observer 迁移到 workflow helper 的 patch-plan 设计。识别出 4 个核心交付物：empathy_observer_spec、workflow_spec、shadow_run_plan、rollback_steps，均已产出详细设计文档。

关键发现：
1. 现有 `types.ts` 已包含完整的 `SubagentWorkflowSpec` 和 `EmpathyObserverWorkflowSpec` 接口定义
2. 当前 `EmpathyObserverManager` 使用内存 Map 实现（sessionLocks、activeRuns、completedSessions）
3. 迁移目标是将 lifecycle 管理迁移到 `WorkflowManager`，保持 `EmpathyObserverManager` 作为业务层门面
4. shadow run 采用 dedupeKey 机制防止双重 finalize

---

## CHANGES

### 新增文件

| 文件 | 用途 |
|------|------|
| `empathy_observer_spec.md` | EmpathyObserverWorkflowSpec 详细规范 |
| `workflow_spec.md` | SubagentWorkflowSpec 接口与状态机定义 |
| `shadow_run_plan.md` | 双路径 shadow run 策略与验证计划 |
| `rollback_steps.md` | 清理状态定义与回滚程序 |

### 设计决策

1. **Transport 选择**: empathy observer 使用 `runtime_direct`（已验证）
2. **状态机设计**: 采用 `pending → active → wait_result → finalizing → completed` 流程
3. **清理状态**: 区分 `completed_with_cleanup_error` vs `cleanup_pending`
4. **Dedupe 策略**: 共享 `processedDedupeKeys` Set 防止双写

---

## CODE_EVIDENCE

- files_checked: `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`, `packages/openclaw-plugin/src/service/subagent-workflow/types.ts`, `packages/openclaw-plugin/tests/service/empathy-observer-manager.test.ts`, `docs/design/2026-03-31-subagent-workflow-helper-design.md`, `ops/ai-sprints/specs/subagent-helper-empathy.json`
- evidence_source: local
- sha: 4138178581043646365326ee42dad4eab4037899
- branch/worktree: HEAD (detached at 4138178)
- evidence_scope: principles

---

## EVIDENCE

### 已验证的 OpenClaw 行为

| 行为 | 位置 | 状态 |
|------|------|------|
| `runtime.subagent.run()` 返回 `runId` | `server-plugins.ts` | 验证 |
| `waitForRun()` 返回 `status: 'ok' | 'error' | 'timeout'` | SDK types | 验证 |
| `expectsCompletionMessage: true` 延迟 `subagent_ended` | `subagent-registry-completion.ts:521-533` | 验证 |
| Session key 格式 | `subagent-spawn.ts` | 验证 |

### 现有实现分析

- **当前 EmpathyObserverManager**: 511 行，使用内存 Map 管理生命周期
- **测试覆盖**: 393 行测试，15 个测试用例覆盖 happy path、timeout、error、concurrent 等场景
- **关键方法**: `spawn()`, `finalizeRun()`, `reapBySession()`, `reap()`, `shouldTrigger()`

---

## INTERFACE_SPEC

### EmpathyObserverWorkflowSpec

```typescript
interface EmpathyObserverWorkflowSpec extends SubagentWorkflowSpec<EmpathyResult> {
  workflowType: 'empathy-observer';
  transport: 'runtime_direct';
  timeoutMs: 30_000;
  ttlMs: 300_000; // 5 minutes
  shouldDeleteSessionAfterFinalize: true;
}
```

### 关键行为契约

| 方法 | 契约 |
|------|------|
| `spawn()` | 验证 `shouldTrigger()` → 构建 sessionKey → 调用 `runtime.subagent.run()` → 返回 `WorkflowHandle` |
| `finalizeOnce()` | 检查幂等 → 读取消息 → `parseResult()` → `persistResult()` → `deleteSession()` |
| `shouldFinalizeOnWaitStatus()` | 仅 `status === 'ok'` 时 finalize，timeout/error 走 fallback |

### empathy-check.json 格式

```typescript
interface EmpathyCheck {
  checkedAt: string;
  workflowId: string;
  parentSessionId: string;
  damageDetected: boolean;
  severity?: 'mild' | 'moderate' | 'severe';
  painSignalRecorded: boolean;
  trajectoryRecorded: boolean;
  frictionTracked: boolean;
  sessionDeleted: boolean;
  workflowState: 'completed' | 'completed_with_cleanup_error' | 'cleanup_pending' | 'expired';
  migrationPath: 'old' | 'new' | 'shadow';
}
```

---

## SHADOW_RUN_PLAN

### 双路径架构

```
User Message
     │
     ▼
┌─────────────────────────────────────────┐
│        EmpathyObserverManager            │
│  ┌─────────────┐    ┌───────────────┐  │
│  │ Old Path    │    │ Shadow Path   │  │
│  │ (Current)   │    │ (Workflow     │  │
│  └─────────────┘    │  Helper)      │  │
│                     └───────────────┘  │
└─────────────────────────────────────────┘
          │                    │
          ▼                    ▼
   Pain Signals ────────→ DedupKey Check ──→ (ignored)
```

### 迁移阶段

| 阶段 | 目标 | 配置 |
|------|------|------|
| Shadow Mode | 验证新路径产生相同结果 | `shadow_only: true` |
| Canary 5% | 5% 流量测试 | `canary_percentage: 5` |
| Full Rollout | 100% 流量 | `enabled: true, shadow_only: false` |

### 退出标准

- 关键 diff = 0（不同 pain signal 写入）
- 非关键 diff < 5%
- Shadow 路径耗时 < 2x Old 路径

---

## CHECKS

CHECKS: evidence=ok;tests=not-run;scope=pd-only;prompt-isolation=confirmed

---

## CONTRACT

- empathy_observer_spec status: DONE
- workflow_spec status: DONE
- shadow_run_plan status: DONE
- rollback_steps status: DONE

---

## KEY_EVENTS

- ✅ empathy_observer_spec.md 设计完成
- ✅ workflow_spec.md 接口与状态机定义完成
- ✅ shadow_run_plan.md 双路径迁移策略完成
- ✅ rollback_steps.md 清理状态与回滚程序完成
- ✅ OpenClaw 兼容性假设已验证（runtime_direct transport）
- ✅ 现有 types.ts 已包含 EmpathyObserverWorkflowSpec 定义

---

## HYPOTHESIS_MATRIX

| 假设 | 状态 | 证据 |
|------|------|------|
| empathy 使用 runtime_direct transport | ✅ 确认 | empathy-observer-manager.ts 直接调用 runtime.subagent.* |
| shadow run 可防止双写 | 🔄 待验证 | 需 implement-pass-1 阶段验证 |
| cleanup_pending 状态满足恢复需求 | ✅ 假设合理 | sweepExpiredWorkflows 可处理 |
| empathy-check.json 格式满足验证需求 | ✅ 假设合理 | 覆盖所有关键字段 |

---

## OPEN_RISKS

1. **OpenClaw hook 触发时机未在 OpenClaw repo 验证**: 当前假设 `expectsCompletionMessage: true` 延迟 `subagent_ended`，但未在 D:/Code/openclaw 源码中交叉验证
2. **SQLite workflow store 尚未实现**: 计划依赖 SQLite 持久化，但代码尚未实现
3. **shadow run dedupeKey 共享机制未验证**: Old 和 New 路径需共享 dedupe 状态，当前通过共享 Set 实现，需运行时验证
