# Phase m9-02: Policy + Factory Integration - Research

**Researched:** 2026-04-29
**Domain:** workflows.yaml policy extension + PainSignalRuntimeFactory runtime selection
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** runtime 配置字段平铺到 `FunnelPolicy` interface，和 `timeoutMs` 同级。不使用嵌套 `runtime` 对象。字段：`runtimeKind`, `provider`, `model`, `apiKeyEnv`, `maxRetries`。
- **D-02:** Factory 层验证 — `PainSignalRuntimeFactory` 在创建 adapter 前检查 `runtimeKind === 'pi-ai'` 所需字段（provider, model, apiKeyEnv）。缺失时抛出明确的配置错误。不在 adapter 层延迟验证。
- **D-03:** bridgeCache key 从 `workspaceDir` 改为 `${workspaceDir}:${runtimeKind}`。不同 runtime 各自独立缓存。
- **D-04:** policy 中 `runtimeKind` 缺失时默认 `'pi-ai'`。M9 目标是让 pi-ai 成为默认 diagnostician runtime。
- **D-05:** 默认 pi-ai + 无默认 provider/model = 现有只配了 timeoutMs 的 policy 会 break。选择报错要求显式配置，不提供 fallback 默认值。M9 是新功能，现有用户应显式迁移。
- **D-06:** Factory 配置验证失败时抛出普通 `Error`（非 `PDRuntimeError`），因为这是配置错误而非运行时错误。错误消息明确列出缺失字段和修复方法。

### Claude's Discretion

- YAML 中 policy 字段的命名风格（camelCase 与 YAML 惯例的 kebab-case）— 代码侧用 camelCase，YAML 侧由 `js-yaml` load 后直接映射，保持一致。
- `test-double` runtimeKind 保留用于测试，factory 中暂时不实现，仅在 type union 中声明。
- 工厂函数 `resolveRunnerOptions` 扩展为 `resolveRuntimeConfig`，同时读取 runtime 配置和 timeoutMs。

### Deferred Ideas (OUT OF SCOPE)

None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PL-01 | `pd-runtime-v2-diagnosis` funnel policy 增加字段：`runtimeKind`, `provider`, `model`, `apiKeyEnv`, `maxRetries` | FunnelPolicy interface 位于 workflow-funnel-loader.ts:48-61，扩展 5 个可选字段即可 |
| PL-02 | policy 字段有合理默认值 | D-04/D-05 决定：runtimeKind 默认 pi-ai，但 provider/model/apiKeyEnv 无默认值，缺失报错 |
| PL-03 | WorkflowFunnelLoader 正确解析新 policy 字段 | js-yaml load 已将 YAML camelCase key 直接映射为 JS 对象属性，无需额外解析逻辑 |
| FC-01 | 从 workflows.yaml policy 读取 runtimeKind | `resolveRunnerOptions` (factory.ts:48-64) 已读取 policy，扩展为同时读取 runtime 字段 |
| FC-02 | runtimeKind === 'pi-ai' 时创建 PiAiRuntimeAdapter | factory.ts:97-99 硬编码 OpenClawCliRuntimeAdapter，替换为 switch on runtimeKind |
| FC-03 | runtimeKind === 'openclaw-cli'（或未指定）时创建 OpenClawCliRuntimeAdapter | 保留现有行为作为 fallback path |
| FC-04 | 不再硬编码 openclaw-cli，policy 驱动 | 核心改动点：factory.ts line 97-119 |
</phase_requirements>

## Summary

Phase m9-02 是 M9 的第二个里程碑，将 m9-01 实现的 PiAiRuntimeAdapter 接入运行时。核心改动集中在两个文件：`workflow-funnel-loader.ts`（扩展 FunnelPolicy interface）和 `pain-signal-runtime-factory.ts`（根据 policy 选择 adapter）。改动范围小且边界清晰，不涉及 adapter 内部实现、candidate/ledger 主链路、或 OpenClawCliRuntimeAdapter。

**关键约束：** D-05 决定现有只配了 timeoutMs 的 policy 会 break —— 这是刻意的 breaking change，M9 要求显式配置 provider/model/apiKeyEnv。

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| FunnelPolicy 类型定义 | workflow-funnel-loader | — | 接口定义归属 loader 模块 |
| YAML 解析 | WorkflowFunnelLoader | js-yaml | js-yaml 自动映射 camelCase，loader 无需额外逻辑 |
| Runtime 配置验证 | PainSignalRuntimeFactory | — | D-02: factory 层验证，非 adapter 层 |
| Adapter 实例化 | PainSignalRuntimeFactory | — | 根据 runtimeKind 分发创建 |
| Bridge 缓存 | PainSignalRuntimeFactory | — | 模块级 Map，key 需要改为 workspaceDir:runtimeKind |

## Existing Code Analysis

### FunnelPolicy Interface (workflow-funnel-loader.ts:48-61)

```typescript
export interface FunnelPolicy {
  timeoutMs?: number;
  stageOrder?: 'strict' | 'relaxed';
  legacyDisabled?: boolean;
  observability?: {
    enabled?: boolean;
    emitEvents?: string[];
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
  };
}
```

**需要新增的字段（D-01）：**
- `runtimeKind?: RuntimeKind` — 使用已有的 RuntimeKind 类型，包含 `'pi-ai'` literal
- `provider?: string` — LLM provider 名称
- `model?: string` — 模型 ID
- `apiKeyEnv?: string` — 环境变量名
- `maxRetries?: number` — 重试次数

**类型导入：** `RuntimeKind` 已在 `runtime-protocol.ts` 中定义并导出，`workflow-funnel-loader.ts` 需要新增 import。

### PainSignalRuntimeFactory (pain-signal-runtime-factory.ts)

**当前流程（lines 97-119）：**
```
resolveRunnerOptions(stateDir) → 只读 timeoutMs
new OpenClawCliRuntimeAdapter({ runtimeMode: 'local', workspaceDir }) → 硬编码
new DiagnosticianRunner(..., { runtimeKind: 'openclaw-cli' }) → 硬编码
```

**目标流程：**
```
resolveRuntimeConfig(stateDir) → 读 runtimeKind + provider + model + apiKeyEnv + maxRetries + timeoutMs
switch(runtimeKind):
  'pi-ai' → new PiAiRuntimeAdapter({ provider, model, apiKeyEnv, maxRetries, timeoutMs, workspace })
  'openclaw-cli' → new OpenClawCliRuntimeAdapter({ runtimeMode, workspace, timeoutMs })
new DiagnosticianRunner(..., { runtimeKind: resolvedKind })
```

**关键改动点：**
1. `resolveRunnerOptions` → `resolveRuntimeConfig`：扩展返回类型包含 runtime 配置
2. `bridgeCache` key：`workspaceDir` → `${workspaceDir}:${runtimeKind}`（D-03）
3. `createPainSignalBridge`：替换硬编码 adapter 创建为 switch 分发
4. `invalidatePainSignalBridge`：签名需要同时接受 workspaceDir 和 runtimeKind，或改用新 key 格式

### PiAiRuntimeAdapterConfig (pi-ai-runtime-adapter.ts:42-57)

```typescript
export interface PiAiRuntimeAdapterConfig {
  provider: string;
  model: string;
  apiKeyEnv: string;
  maxRetries?: number;
  timeoutMs?: number;
  workspace?: string;
  eventEmitter?: StoreEventEmitter;
}
```

Factory 需要将 policy 中的字段映射到此 config 对象。

### RuntimeKindSchema (runtime-protocol.ts:15-25)

已包含 `'pi-ai'` literal（m9-01 已完成），无需修改。

### RuntimeKind Type

```typescript
export type RuntimeKind = Static<typeof RuntimeKindSchema>;
```

FunnelPolicy 中直接使用此类型即可，保证类型安全。

## Changes Required

### 1. FunnelPolicy Interface Extension (workflow-funnel-loader.ts)

**新增 import：**
```typescript
import type { RuntimeKind } from './runtime-v2/runtime-protocol.js';
```

**新增字段（D-01，平铺到 FunnelPolicy）：**
```typescript
export interface FunnelPolicy {
  timeoutMs?: number;
  stageOrder?: 'strict' | 'relaxed';
  legacyDisabled?: boolean;
  observability?: { ... };
  // M9: Runtime configuration (D-01)
  runtimeKind?: RuntimeKind;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  maxRetries?: number;
}
```

**无需修改 WorkflowFunnelLoader 类本身。** js-yaml 解析 YAML 时会自动将 camelCase key 映射为 JS 对象属性，新增的字段会被 `getFunnel()` 返回的 policy 对象携带。`cloneFunnel` 的浅拷贝 (`...funnel.policy`) 也能正确处理新字段。

### 2. Factory Configuration Resolution (pain-signal-runtime-factory.ts)

**重命名 `resolveRunnerOptions` → `resolveRuntimeConfig`，扩展返回类型：**
```typescript
interface RuntimeConfig {
  runtimeKind: RuntimeKind;
  timeoutMs: number;
  agentId: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  maxRetries?: number;
}

function resolveRuntimeConfig(stateDir: string): RuntimeConfig { ... }
```

**D-04 默认值逻辑：**
- `runtimeKind` 缺失时默认 `'pi-ai'`
- `timeoutMs` 缺失时默认 `DEFAULT_TIMEOUT_MS`
- `provider`, `model`, `apiKeyEnv` 无默认值

### 3. Factory Validation (pain-signal-runtime-factory.ts)

**D-02 验证逻辑 — 在创建 adapter 前检查：**
```typescript
function validateRuntimeConfig(config: RuntimeConfig): void {
  if (config.runtimeKind === 'pi-ai') {
    const missing: string[] = [];
    if (!config.provider) missing.push('provider');
    if (!config.model) missing.push('model');
    if (!config.apiKeyEnv) missing.push('apiKeyEnv');
    if (missing.length > 0) {
      throw new Error(
        `[PainSignalRuntimeFactory] Missing required fields for runtimeKind 'pi-ai': ${missing.join(', ')}. ` +
        `Add these fields to your workflows.yaml pd-runtime-v2-diagnosis funnel policy.`
      );
    }
  }
}
```

**D-06：抛出普通 Error，非 PDRuntimeError。**

### 4. Bridge Cache Key Update (pain-signal-runtime-factory.ts)

**D-03：** `bridgeCache.get(opts.workspaceDir)` → `bridgeCache.get(\`${opts.workspaceDir}:${runtimeKind}\`)`

**注意：** `invalidatePainSignalBridge` 函数签名需要更新。当前签名是 `(workspaceDir: string): void`。选项：
- 改为 `(workspaceDir: string, runtimeKind?: string): void` — 可选参数保持向后兼容
- 或者保留原签名，遍历 cache 删除匹配 prefix 的 entries

建议选择方案 A：改签名加上 runtimeKind 参数，调用方需要更新（测试代码中的 `invalidatePainSignalBridge` 调用）。

### 5. Adapter Instantiation (pain-signal-runtime-factory.ts)

**替换 lines 97-119 的硬编码逻辑：**
```typescript
// 根据 runtimeKind 创建 adapter
let runtimeAdapter: PDRuntimeAdapter;
const runtimeConfig = resolveRuntimeConfig(opts.stateDir);
validateRuntimeConfig(runtimeConfig);

if (runtimeConfig.runtimeKind === 'pi-ai') {
  runtimeAdapter = new PiAiRuntimeAdapter({
    provider: runtimeConfig.provider!,
    model: runtimeConfig.model!,
    apiKeyEnv: runtimeConfig.apiKeyEnv!,
    maxRetries: runtimeConfig.maxRetries,
    timeoutMs: runtimeConfig.timeoutMs,
    workspace: opts.workspaceDir,
  });
} else {
  // Default to openclaw-cli for backward compatibility
  runtimeAdapter = new OpenClawCliRuntimeAdapter({
    runtimeMode: 'local',
    workspaceDir: opts.workspaceDir,
  });
}
```

### 6. workflows.yaml Example (manual update)

用户需要手动更新 `.state/workflows.yaml`：
```yaml
funnels:
  - workflowId: pd-runtime-v2-diagnosis
    stages: [...]
    policy:
      timeoutMs: 120000
      runtimeKind: pi-ai
      provider: openrouter
      model: anthropic/claude-sonnet-4
      apiKeyEnv: OPENROUTER_API_KEY
      maxRetries: 2
```

### 7. Export Updates (runtime-v2/index.ts)

`invalidatePainSignalBridge` 签名变更会影响导出。确认导出类型正确。

## Pitfalls & Gotchas

### P1: cloneFunnel 不需要修改

`WorkflowFunnelLoader.cloneFunnel` 使用 spread operator 做浅拷贝：`...funnel.policy`。新增的 scalar 字段（string, number）会被正确拷贝，无需修改 clone 逻辑。只有嵌套对象（如 `observability`）需要深拷贝。

### P2: RuntimeKind 类型与 js-yaml 的交互

js-yaml load 后返回的是 plain object，TypeScript 不会在运行时验证 YAML 值是否符合 RuntimeKind union。如果用户在 YAML 中写了 `runtimeKind: typo-value`，`resolveRuntimeConfig` 返回的值会是 `'typo-value'` 但 TypeScript 类型标注为 `RuntimeKind`。这不会导致编译错误，但运行时 switch 会走到 default 分支。

**建议：** 在 `resolveRuntimeConfig` 或 `validateRuntimeConfig` 中增加运行时校验，检查 runtimeKind 是否为已知值。可使用 `RuntimeKindSchema` 做验证。

### P3: D-05 Breaking Change 传播

现有只配了 `timeoutMs` 的 policy 会在 `validateRuntimeConfig` 中抛出 Error（D-05）。这意味着：
- 所有使用 `pd-runtime-v2-diagnosis` funnel 的 workspace 必须更新 workflows.yaml
- 需要在错误消息中清晰说明迁移步骤
- CI/CD 中如果有使用 factory 的测试，需要同步更新

### P4: bridgeCache key 变更的测试影响

`invalidatePainSignalBridge` 签名变更后，所有使用此函数的测试需要更新调用方式。搜索 `invalidatePainSignalBridge` 的调用点。

### P5: resolveRunnerOptions 重命名的影响

`resolveRunnerOptions` 在 `index.ts` 中被 re-export（line 174）。但注意：这个 export 来自 `./runner/diagnostician-runner-options.js`，不是 factory 中的同名私有函数。Factory 中的 `resolveRunnerOptions` 是模块私有的，重命名不影响外部 API。

### P6: PI-AI runtimeKind default 的隐含行为

D-04 说 runtimeKind 缺失默认 pi-ai，但 D-05 说缺少 provider/model 会报错。这意味着：如果用户只配了 `timeoutMs`，会先默认 `runtimeKind: 'pi-ai'`，然后因为缺少 provider/model/apiKeyEnv 而报错。错误消息应该暗示 "你可能想要显式设置 runtimeKind: openclaw-cli"。

## Test Strategy

### Unit Tests for Factory

1. **policy-driven adapter selection:**
   - `runtimeKind: 'pi-ai'` + 完整配置 → 创建 PiAiRuntimeAdapter
   - `runtimeKind: 'openclaw-cli'` → 创建 OpenClawCliRuntimeAdapter
   - 无 runtimeKind（只配 timeoutMs）→ 默认 pi-ai → 报错（缺少 provider/model/apiKeyEnv）
   - 无 policy → 默认 pi-ai → 报错

2. **config validation:**
   - `runtimeKind: 'pi-ai'` + 缺少 provider → 抛 Error，消息包含 "provider"
   - `runtimeKind: 'pi-ai'` + 缺少 model → 抛 Error，消息包含 "model"
   - `runtimeKind: 'pi-ai'` + 缺少 apiKeyEnv → 抛 Error，消息包含 "apiKeyEnv"
   - `runtimeKind: 'pi-ai'` + 全部缺少 → 抛 Error，消息列出所有缺失字段

3. **bridgeCache key:**
   - 相同 workspaceDir + 不同 runtimeKind → 两个独立缓存 entry
   - `invalidatePainSignalBridge(ws, 'pi-ai')` 只删除 pi-ai 缓存

4. **resolveRuntimeConfig:**
   - 完整 policy → 返回所有字段
   - 只有 timeoutMs → runtimeKind 默认 pi-ai，其余 undefined
   - workflows.yaml 不存在 → runtimeKind 默认 pi-ai，其余 undefined

### Unit Tests for FunnelPolicy

5. **WorkflowFunnelLoader 解析新字段：**
   - YAML 含 runtimeKind + provider + model + apiKeyEnv + maxRetries → `getFunnel().policy` 包含所有字段
   - YAML 不含新字段 → `getFunnel().policy` 中新字段为 undefined（向后兼容）

### Mock Strategy

- Factory 测试需要 mock `WorkflowFunnelLoader`（避免文件系统依赖）
- 或使用临时目录写入 test YAML 文件
- PiAiRuntimeAdapter 已有完整 mock 测试（m9-01），factory 测试只需验证正确的 adapter 类型被实例化

## Sources

### Primary (HIGH confidence)
- `packages/principles-core/src/workflow-funnel-loader.ts` — FunnelPolicy interface, cloneFunnel, js-yaml 解析逻辑
- `packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts` — resolveRunnerOptions, createPainSignalBridge, bridgeCache
- `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` — PiAiRuntimeAdapterConfig 接口
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — RuntimeKindSchema (已含 'pi-ai')
- `packages/principles-core/src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts` — 测试模式参考

### Secondary (MEDIUM confidence)
- `.planning/phases/m9-02-Policy-Factory-Integration/m9-02-CONTEXT.md` — 所有实现决策
- `.planning/REQUIREMENTS.md` — PL-01~03, FC-01~04 需求定义

## Metadata

**Confidence breakdown:**
- Interface extension: HIGH — 只新增可选字段，向后兼容
- Factory modification: HIGH — 改动点明确，现有代码结构支持
- js-yaml 解析: HIGH — js-yaml 已在项目中使用，camelCase 自动映射
- Breaking change (D-05): HIGH — 决策已锁定，错误消息需仔细设计

**Research date:** 2026-04-29
**Valid until:** 2026-05-29 (stable phase, no external dependencies)
