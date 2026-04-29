# Phase m9-03: CLI Commands - Research

**Researched:** 2026-04-29
**Domain:** pd-cli 命令扩展支持 pi-ai runtime
**Confidence:** HIGH

## Summary

Phase m9-03 需要扩展 pd-cli 三个命令支持 pi-ai runtime：`pd runtime probe --runtime pi-ai`、`pd diagnose run --runtime pi-ai`、`pd pain record`（policy-driven，不改代码）。

核心发现：
- `probeRuntime()` 函数目前只支持 `openclaw-cli`，需要扩展支持 `pi-ai` 或在 CLI 层绕过它直接调用 `PiAiRuntimeAdapter.healthCheck()`
- `diagnose.ts` 的 `handleDiagnoseRun` 已有 if/else chain 选择 runtime，加入 pi-ai 分支即可
- `pain-record.ts` 调用 `createPainSignalBridge`，m9-02 后 factory 已自动从 policy 读取 runtimeKind，**无需修改**
- PiAiRuntimeAdapter 已有完整的 `healthCheck()` 三阶段验证（apiKeyEnv 存在 + getModel + minimal complete）

**Primary recommendation:** 扩展 `probeRuntime()` 支持 pi-ai，在 `diagnose.ts` 加入 pi-ai 分支，pain-record.ts 不动。

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| CLI flag 解析 | pd-cli (commander) | — | 用户交互入口 |
| probe 验证逻辑 | principles-core (PiAiRuntimeAdapter.healthCheck) | — | adapter 已实现三阶段验证 |
| diagnose runtime 选择 | pd-cli (diagnose.ts if/else) | principles-core (factory) | CLI 层显式选择 vs factory 自动选择 |
| pain record runtime 选择 | principles-core (factory) | — | policy-driven, CLI 不干预 |
| 配置读取 | principles-core (WorkflowFunnelLoader) | — | workflows.yaml 是 SSOT |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| commander | (已在 pd-cli 中) | CLI flag 解析 | 已有依赖，不新增 |
| @mariozechner/pi-ai | 0.70.6 | LLM 调用 | m9-01 已引入 |

### 不需要新增的库

本 phase 不引入新依赖。所有需要的组件（PiAiRuntimeAdapter、PainSignalRuntimeFactory、WorkflowFunnelLoader）已在 m9-01/m9-02 中实现。

## Architecture Patterns

### 现有 CLI 命令模式

```
pd-cli/src/index.ts (commander 定义)
  → pd-cli/src/commands/xxx.ts (handleXxx 函数)
    → @principles/core/runtime-v2 (库函数/类)
```

**模式特征：**
- commander option 用 camelCase（`--openclawLocal`、`--apiKeyEnv`）
- handler 函数接收 `{ runtime: string, json?: boolean, ... }` options
- 错误处理：try/catch + PDRuntimeError 分类 + process.exit(1)
- JSON 模式：`--json` flag 输出结构化 JSON
- human-readable 模式：默认，格式化 console.log 输出

### Probe 命令当前架构

```
handleRuntimeProbe (runtime.ts)
  → 验证 runtime === 'openclaw-cli'  ← 硬编码限制
  → 验证 --openclaw-local / --openclaw-gateway 互斥
  → probeRuntime({ runtimeKind, runtimeMode, agentId })
    → new OpenClawCliRuntimeAdapter(...)
    → adapter.healthCheck() + getCapabilities()
  → 格式化输出
```

**问题：** `probeRuntime()` 函数签名限制 `runtimeKind: 'openclaw-cli'`，需要扩展。

### Diagnose 命令当前架构

```
handleDiagnoseRun (diagnose.ts)
  → runtimeKind = opts.runtime ?? 'test-double'
  → if/else chain:
      'openclaw-cli' → new OpenClawCliRuntimeAdapter(...)
      'test-double' → new TestDoubleRuntimeAdapter(...)
      else → error  ← pi-ai 需要加到这里
  → new DiagnosticianRunner(..., { runtimeKind })
  → runner.run(taskId)
```

### Pain Record 命令当前架构

```
handlePainRecord (pain-record.ts)
  → createPainSignalBridge({ workspaceDir, stateDir, ... })
    → resolveRuntimeConfig(stateDir)  ← m9-02 已从 policy 读取 runtimeKind
    → validateRuntimeConfig(config)
    → switch(runtimeKind): 'pi-ai' | 'openclaw-cli'
  → bridge.onPainDetected(data)
```

**结论：** pain-record.ts 无需修改，factory 已处理。

## Key Design Decisions

### Decision 1: probeRuntime() 扩展策略

**选项 A：扩展 `probeRuntime()` 函数签名支持 pi-ai**
- 修改 `ProbeOptions` union：`runtimeKind: 'openclaw-cli' | 'pi-ai'`
- pi-ai 分支需要新增 config 参数（provider, model, apiKeyEnv, maxRetries, timeoutMs）
- 返回类型 `ProbeResult` 也需要扩展（runtimeKind union）

**选项 B：CLI 层绕过 `probeRuntime()`，直接调用 `PiAiRuntimeAdapter`**
- `handleRuntimeProbe` 中 pi-ai 分支直接 `new PiAiRuntimeAdapter(config).healthCheck()` + `getCapabilities()`
- 不修改 `probeRuntime()` 库函数
- 复制 `probeRuntime()` 的 Promise.all 模式

**推荐：选项 A** — 扩展 `probeRuntime()` 保持 CLI → 库函数的一致调用链。但需要扩展接口签名。

**实际考量：** `probeRuntime()` 是 principles-core 库函数，被其他代码也可能调用。扩展它意味着库层面支持 pi-ai probe，更干净。但 options 接口会变复杂（pi-ai 需要额外 config 字段）。

**混合方案：** `ProbeOptions` 变为 discriminated union：
```typescript
type ProbeOptions =
  | { runtimeKind: 'openclaw-cli'; runtimeMode: 'local' | 'gateway'; workspaceDir?: string; agentId?: string }
  | { runtimeKind: 'pi-ai'; provider: string; model: string; apiKeyEnv: string; maxRetries?: number; timeoutMs?: number }
```

### Decision 2: diagnose pi-ai 分支配置来源

**D-01/D-06 决定：** CLI flags + policy fallback。有 flag 用 flag，没有从 policy 读取。

**实现方式：**
1. CLI 层接受 `--provider`, `--model`, `--apiKeyEnv`, `--maxRetries`, `--timeoutMs` flags
2. 如果 flag 缺失，调用 `resolveRuntimeConfig()` 从 policy 读取
3. 与 `handleDiagnoseRun` 现有的 `runtimeKind = opts.runtime ?? 'test-double'` 模式一致

**问题：** `resolveRuntimeConfig()` 目前是 factory 内部函数（`pain-signal-runtime-factory.ts`），不导出。diagnose 需要访问它。

**方案：** 将 `resolveRuntimeConfig` 导出，或在 diagnose.ts 中实现轻量版配置读取。

### Decision 3: probe test complete 最小 prompt

**D-03/D-05 决定：** probe 执行三步验证，第三步发最小 prompt。

**PiAiRuntimeAdapter.healthCheck() 已实现：** 使用 `'Reply with {"ok":true} only.'` 作为 probe prompt，验证 `{"ok":true}` 响应。

**probe 输出格式（Claude's Discretion）：** 参考 CONTEXT.md 示例：
```
Runtime: pi-ai
Provider: openrouter
Model:    anthropic/claude-sonnet-4
Status:   succeeded

Health:
  apiKeyEnv:     OPENROUTER_API_KEY (set)
  modelResolve:  ok
  testComplete:  ok (response: "Hello!")

Capabilities:
  streaming          no
  cancellation       yes
  artifactDelivery   no
```

### Decision 4: pi-ai probe 超时

**D-04 决定：** probe 超时 60s（pi-ai 走真实 LLM 调用）。

**注意：** `PiAiRuntimeAdapter.healthCheck()` 内部已使用 `AbortSignal.timeout(30_000)`。probe 层可能需要覆盖为 60s。

**方案：** healthCheck 的 30s 超时是合理的（probe prompt 很短），probe 层可以不覆盖。如果需要 60s，需要在 PiAiRuntimeAdapter 构造时传入 `timeoutMs` 或给 healthCheck 加可选参数。

## Key Source Files

### 需要修改的文件

| File | Change | Complexity |
|------|--------|------------|
| `packages/principles-core/src/runtime-v2/cli/probe.ts` | 扩展 ProbeOptions/ProbeResult 支持 pi-ai | 中 |
| `packages/pd-cli/src/commands/runtime.ts` | pi-ai 分支：新 flags + 格式化输出 | 中 |
| `packages/pd-cli/src/commands/diagnose.ts` | pi-ai 分支：新 flags + adapter 创建 | 中 |
| `packages/pd-cli/src/index.ts` | probe/diagnose 命令新增 flags | 低 |

### 不需要修改的文件

| File | Reason |
|------|--------|
| `packages/pd-cli/src/commands/pain-record.ts` | factory 已自动处理 (D-08) |
| `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` | m9-01 已实现完整接口 |
| `packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts` | m9-02 已实现 policy-driven |
| `packages/principles-core/src/runtime-v2/runtime-protocol.ts` | RuntimeKindSchema 已含 'pi-ai' |

### 需要检查的依赖

| File | Check |
|------|-------|
| `packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts` | `resolveRuntimeConfig` 是否已导出？当前是内部函数 |

## CLI-01~04 Requirement Traceability

| Req | Description | Implementation |
|-----|-------------|----------------|
| CLI-01 | `pd runtime probe --runtime pi-ai` | 扩展 probeRuntime() + runtime.ts handler |
| CLI-02 | `pd diagnose run --runtime pi-ai` | diagnose.ts 加 pi-ai 分支 |
| CLI-03 | `pd pain record` 默认走 policy | 无需修改 (D-08, factory 已处理) |
| CLI-04 | CLI 正确传递 config 到 PiAiRuntimeAdapter | probe/diagnose 的 flag → config 映射 |

## Potential Pitfalls

### Pitfall 1: resolveRuntimeConfig 未导出
**What:** `resolveRuntimeConfig` 是 `pain-signal-runtime-factory.ts` 的内部函数
**Impact:** diagnose.ts 的 flag fallback 无法访问 policy 配置
**Solution:** 导出 `resolveRuntimeConfig` 或提取为共享工具函数

### Pitfall 2: probe 的 PiAiRuntimeAdapter 实例化需要完整 config
**What:** probe 需要 provider/model/apiKeyEnv 才能创建 PiAiRuntimeAdapter
**Impact:** 如果用户只传 `--runtime pi-ai` 没传其他 flags，probe 无法工作
**Solution:** probe 也支持 policy fallback（与 diagnose 一致），或要求所有 flags 必填

### Pitfall 3: healthCheck 超时 vs probe 超时
**What:** healthCheck 内部 30s 超时，但 D-04 要求 probe 60s 超时
**Impact:** 如果 LLM 响应慢但 <60s，healthCheck 可能已超时返回 degraded
**Solution:** 保持 healthCheck 30s（probe prompt 很短），60s 是 CLI 层整体超时

### Pitfall 4: diagnose 的 pi-ai 分支需要 workspace 传入 PiAiRuntimeAdapter
**What:** PiAiRuntimeAdapterConfig 有可选 `workspace` 字段
**Impact:** 不传也能工作，但未来可能需要
**Solution:** 传递 workspaceDir 作为 workspace 参数

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | pd-cli 运行 | ✓ | (已安装) | — |
| pnpm | 构建 | ✓ | (已安装) | — |
| commander | CLI 框架 | ✓ | (已在 pd-cli) | — |
| @mariozechner/pi-ai | LLM 调用 | ✓ | 0.70.6 (m9-01) | — |

**无缺失依赖。**

## Validation Architecture

### Test Requirements (m9-03 scope)

本 phase 是 CLI 层修改，测试主要在 m9-04 (TEST-01~06)。m9-03 本身不需要新增测试文件，但需要确保：

1. probe pi-ai 可手动测试：`pd runtime probe --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY`
2. diagnose pi-ai 可手动测试：`pd diagnose run --task-id <id> --runtime pi-ai`
3. pain record 自动走 policy：`pd pain record --reason "test"`

### Wave 0 Gaps

无 — 所有依赖已就位，不需要新增测试框架或配置。

## Code Examples

### probeRuntime 扩展 (probe.ts)

```typescript
// Discriminated union for ProbeOptions
export type ProbeOptions =
  | {
      runtimeKind: 'openclaw-cli';
      runtimeMode: 'local' | 'gateway';
      workspaceDir?: string;
      agentId?: string;
    }
  | {
      runtimeKind: 'pi-ai';
      provider: string;
      model: string;
      apiKeyEnv: string;
      maxRetries?: number;
      timeoutMs?: number;
    };

export type ProbeResult =
  | { runtimeKind: 'openclaw-cli'; health: RuntimeHealth; capabilities: RuntimeCapabilities }
  | { runtimeKind: 'pi-ai'; health: RuntimeHealth; capabilities: RuntimeCapabilities; provider: string; model: string };

export async function probeRuntime(options: ProbeOptions): Promise<ProbeResult> {
  if (options.runtimeKind === 'openclaw-cli') {
    // existing logic
  } else if (options.runtimeKind === 'pi-ai') {
    const adapter = new PiAiRuntimeAdapter({
      provider: options.provider,
      model: options.model,
      apiKeyEnv: options.apiKeyEnv,
      maxRetries: options.maxRetries,
      timeoutMs: options.timeoutMs,
    });
    const [health, capabilities] = await Promise.all([
      adapter.healthCheck(),
      adapter.getCapabilities(),
    ]);
    return { runtimeKind: 'pi-ai', health, capabilities, provider: options.provider, model: options.model };
  }
  throw new Error(`Unsupported runtime kind: ${(options as { runtimeKind: string }).runtimeKind}`);
}
```

### handleRuntimeProbe pi-ai 分支 (runtime.ts)

```typescript
// 新增 pi-ai 分支
if (opts.runtime === 'pi-ai') {
  // 从 flags 或 policy 读取配置
  const config = resolvePiAiConfig(opts);
  const result = await probeRuntime({
    runtimeKind: 'pi-ai',
    provider: config.provider,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
  });
  // 格式化输出...
}
```

### handleDiagnoseRun pi-ai 分支 (diagnose.ts)

```typescript
} else if (runtimeKind === 'pi-ai') {
  // 从 flags 或 policy 读取配置
  const config = resolvePiAiConfig(opts);
  runtimeAdapter = new PiAiRuntimeAdapter({
    provider: config.provider,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    workspace: workspaceDir,
  });
  storeEmitter.emitTelemetry({
    eventType: 'runtime_adapter_selected',
    traceId: opts.taskId,
    timestamp: new Date().toISOString(),
    sessionId: 'pd-cli-diagnose',
    agentId: 'pi-ai-adapter',
    payload: { runtimeKind: 'pi-ai', provider: config.provider, model: config.model },
  });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| probe 只支持 openclaw-cli | 扩展支持 pi-ai | m9-03 | CLI 可验证 pi-ai runtime |
| diagnose 只支持 openclaw-cli + test-double | 加入 pi-ai 分支 | m9-03 | CLI 可用 pi-ai 执行诊断 |
| pain record 硬编码 openclaw-cli | factory policy-driven | m9-02 | pain record 自动选择 runtime |

## Sources

### Primary (HIGH confidence)
- `packages/pd-cli/src/commands/runtime.ts` — 现有 probe handler 完整实现
- `packages/pd-cli/src/commands/diagnose.ts` — 现有 diagnose handler 完整实现
- `packages/pd-cli/src/commands/pain-record.ts` — 现有 pain record handler
- `packages/principles-core/src/runtime-v2/cli/probe.ts` — probeRuntime() 函数
- `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` — PiAiRuntimeAdapter 实现
- `packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts` — Factory 实现
- `.planning/phases/m9-03-CLI-Commands/m9-03-CONTEXT.md` — 11 个实现决策

### Secondary (MEDIUM confidence)
- `.planning/phases/m9-01-PiAiRuntimeAdapter-Core/m9-01-CONTEXT.md` — D-02 (no defaults), D-13 (healthCheck)
- `.planning/phases/m9-02-Policy-Factory-Integration/m9-02-CONTEXT.md` — D-01 (flat policy), D-04 (default runtimeKind)

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — 无新依赖，所有组件已就位
- Architecture: HIGH — 现有模式清晰，扩展点明确
- Pitfalls: MEDIUM — resolveRuntimeConfig 导出问题需要确认

**Research date:** 2026-04-29
**Valid until:** 2026-05-06 (M9 快速迭代中)

---
*Phase: m9-03-CLI-Commands*
*Research completed: 2026-04-29*
