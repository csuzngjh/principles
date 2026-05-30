# ADR-0015: Pain Signal Model Unification

> **状态**: Proposed
> **日期**: 2026-05-30
> **相关**: ADR-0010 (GAP), ADR-0014 (MVP Pivot), DOMAIN_MODEL.md, Series 03 (Biological Forward Pass)

## 1. 背景与痛点

PD 系统的痛苦信号机制存在以下问题：

### 1.1 业务模型缺失

博文连载三定义了清晰的三层痛觉分级体系：

- **底层（HUMAN）**：人类痛感的投影 — 开发者显式表达挫败感
- **中层（FRICTION）**：系统摩擦的量化 — Agent 原地打转、无效操作
- **高层（GOAL）**：目标偏离的虚无感 — 勤奋但偏离目标

但代码中 `painType` 只有 3 个值（`tool_failure | subagent_error | user_frustration`），6 种不同 source 被压扁到 `user_frustration`，三层痛觉的业务模型在类型系统中完全没有表达。

### 1.2 代码分散与重复

- **两套 PainSignal Schema**：core 层和 runtime-v2 层各有一套，字段约束不同
- **Score 计算分散**：硬编码/可配置/动态计算/累积，无统一策略
- **Severity 分级不一致**：`low/medium/high/critical` vs `mild/moderate/severe`，`normalizeSeverity('critical')` 错误返回 `'mild'`
- **3 个手动入口**：`pain` 工具(score=100)、`/pd-pain`(score=90)、`pd pain record`(score=80)，做同一件事但行为不一致

### 1.3 Hook 层越权

每个信号源在 Hook 层做了 3-4 次重复写入（eventLog、trajectory、evoLogger），然后 `emitPainDetectedEvent` 内部通过 `PainToPrincipleService.recordPain()` 再写一次。Gate 检查也散落在各 Hook 文件中。`subagent_error` 甚至不走 `recordPain()`，只调用 `emitSync`。

### 1.4 根因

这些问题是 openclaw-plugin → principles-core 重构的过渡态产物。原来所有逻辑都在 Hook 层，重构到 SDK 后旧代码没删干净，导致同一件事做了两遍。

## 2. 决策详情

### 2.1 核心类型系统

定义在 `packages/principles-core/src/pain-signal-model.ts`（新文件，单一权威来源）。

#### PainLayer — 三层痛觉

```typescript
export const PainLayer = {
  GOAL: 1,      // 高层痛觉：目标偏离的虚无感
  HUMAN: 2,     // 底层痛觉：人类痛感的投影
  FRICTION: 3,  // 中层痛觉：系统摩擦的量化
} as const;

export type PainLayer = typeof PainLayer[keyof typeof PainLayer];
```

层级用数字 1/2/3，有天然优先级顺序。命名用业务语义（GOAL/HUMAN/FRICTION）而非抽象编号（L1/L2/L3）。

#### PainSignalKind — 信号种类

```typescript
export const PAIN_SIGNAL_KINDS = {
  // Layer 1: GOAL — 预留，post-MVP 实施
  GOAL_DRIFT:           'goal_drift',
  MISSION_STALLED:      'mission_stalled',
  DECISION_SKIPPED:     'decision_skipped',
  REWORK_LOOP:          'rework_loop',

  // Layer 2: HUMAN
  USER_REPORTED:        'user_reported',

  // Layer 3: FRICTION
  TOOL_FAILURE:         'tool_failure',
  DISPATCH_ERROR:       'dispatch_error',
  SUBAGENT_ERROR:       'subagent_error',
  LLM_PARALYSIS:        'llm_paralysis',
  GATE_BLOCKED:         'gate_blocked',
  EMPATHY_INFERRED:     'empathy_inferred',
  SEMANTIC:             'semantic',
  INTERCEPT_EXTRACTION: 'intercept_extraction',
} as const;

export type PainSignalKind = typeof PAIN_SIGNAL_KINDS[keyof typeof PAIN_SIGNAL_KINDS];
```

Layer 1 的 4 种 kind 在枚举中预留但不注册 Descriptor，等 ADR-0010 GAP 实施时启用。

3 个手动入口合并为 1 种 kind `user_reported`，provenance 字段区分上下文丰富度。

#### ScoreStrategy — Score 计算策略

```typescript
export const ScoreStrategy = {
  FIXED:           'fixed',           // 硬编码分数
  COMPUTED:        'computed',        // 动态计算（如 computePainScore）
  ACCUMULATIVE:    'accumulative',    // 累积性（如 GFI 溢出）
  DETECTED:        'detected',        // 由检测器产出（如 DetectionService）
  PROVENANCE_BASED: 'provenance_based', // score 取决于 provenance
} as const;

export type ScoreStrategy = typeof ScoreStrategy[keyof typeof ScoreStrategy];
```

#### ProvenanceType — 信号来源可信度

```typescript
export const ProvenanceType = {
  OPENCLAW_CONTEXT_BOUND:  'openclaw_context_bound',
  OWNER_REPORTED:          'owner_reported_no_host_trace',
  SYSTEM_OBSERVED:         'system_observed',
} as const;

export type ProvenanceType = typeof ProvenanceType[keyof typeof ProvenanceType];
```

新增 `SYSTEM_OBSERVED`，用于系统自动检测的信号（当前代码中这类信号没有显式 provenance）。

#### PainSignalDescriptor — 信号描述符

```typescript
export interface PainSignalDescriptor {
  kind: PainSignalKind;
  layer: PainLayer;
  scoreStrategy: ScoreStrategy;
  defaultScore?: number;
  provenanceScores?: Record<ProvenanceType, number>;  // provenance_based 策略用
  canTriggerDiagnostic: boolean;
  provenance: ProvenanceType;
  description: string;
}
```

### 2.2 PainSignalRegistry 注册表

```typescript
export class PainSignalRegistry {
  private descriptors = new Map<PainSignalKind, PainSignalDescriptor>();

  register(descriptor: PainSignalDescriptor): void;
  get(kind: PainSignalKind): PainSignalDescriptor;
  getByLayer(layer: PainLayer): PainSignalDescriptor[];
  getAll(): PainSignalDescriptor[];
}
```

内置 `defaultPainSignalRegistry` 实例，注册当前所有 9 种活跃信号（Layer 1 预留不注册）：

| kind | layer | scoreStrategy | defaultScore | provenance |
|------|-------|--------------|-------------|-----------|
| `user_reported` | HUMAN(2) | provenance_based | — | openclaw_context_bound:100, owner_reported:80 |
| `tool_failure` | FRICTION(3) | computed | — | system_observed |
| `dispatch_error` | FRICTION(3) | computed | — | system_observed |
| `subagent_error` | FRICTION(3) | fixed | 60 | system_observed |
| `llm_paralysis` | FRICTION(3) | fixed | 45 | system_observed |
| `gate_blocked` | FRICTION(3) | fixed | 45 | system_observed |
| `empathy_inferred` | FRICTION(3) | accumulative | — | system_observed |
| `semantic` | FRICTION(3) | detected | — | system_observed |
| `intercept_extraction` | FRICTION(3) | fixed | 100 | system_observed |

所有 Descriptor 的 `canTriggerDiagnostic` 当前为 `true`（仅做类型抽象，不改变 Gate 行为）。未来 GAP 实施时，Layer 3 的改为 `false`。

### 2.3 统一 PainSignal Schema

替代现有的两套 Schema，定义在 `pain-signal-model.ts`：

```typescript
export const PainSignalSchema = Type.Object({
  painId: Type.String({ minLength: 1 }),
  kind: Type.Union([/* 13 种 literal */]),
  layer: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
  score: Type.Number({ minimum: 0, maximum: 100 }),
  source: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  traceId: Type.Optional(Type.String()),
  provenance: Type.Union([/* 3 种 literal */]),
  evidence: Type.Optional(Type.Any()),
  createdAt: Type.String({ format: 'date-time' }),
});

export type PainSignal = Static<typeof PainSignalSchema>;
```

关键变更：
- `kind` 替代 `painType`，值域从 3 扩展到 13
- 新增 `layer` 字段
- `sessionId`/`agentId`/`traceId` 统一为可选，由 `recordPain()` 填充默认值
- 新增 `createdAt`

### 2.4 统一 Severity 分级

保持两套体系并存（SDK 对外 vs 内部管道），但修复 bug 并消除歧义：

**SDK 层（对外契约）**：
```typescript
export const PAIN_SEVERITY = {
  LOW:      { min: 0,  max: 39 },
  MEDIUM:   { min: 40, max: 69 },
  HIGH:     { min: 70, max: 89 },
  CRITICAL: { min: 90, max: 100 },
} as const;

export type PainSeverity = 'low' | 'medium' | 'high' | 'critical';

export function deriveSeverity(score: number): PainSeverity;
```

**内部管道层**：
```typescript
export type InternalSeverity = 'mild' | 'moderate' | 'severe';

export function toInternalSeverity(severity: PainSeverity): InternalSeverity {
  switch (severity) {
    case 'low': return 'mild';
    case 'medium': return 'moderate';
    case 'high':
    case 'critical': return 'severe';  // 修复：critical → severe（原来错误地映射到 mild）
  }
}
```

**删除**：
- `painSeverityLabel()` 中的 `info` 级别（无任何消费者识别）
- `normalizeSeverity()` 被 `toInternalSeverity()` 替代

**不修改**：DB 中已持久化的 `mild/moderate/severe` 值，避免数据迁移。

### 2.5 统一管道：PainToPrincipleService.recordPain()

所有信号源统一走一条管道。Hook 层只负责采集原始事件和提取 payload。

#### RecordPainInput

```typescript
interface RecordPainInput {
  kind: PainSignalKind;
  source: string;
  reason: string;
  score?: number;
  sessionId?: string;
  agentId?: string;
  traceId?: string;
  provenance?: ProvenanceType;
  evidence?: unknown;
  errorHash?: string;
  consecutiveErrors?: number;
  currentGfi?: number;
}
```

#### recordPain() 内部流程

```
1. 从 Registry 获取 Descriptor
2. 计算 score（根据 scoreStrategy）
3. 填充默认值（sessionId, agentId, traceId, createdAt）
4. 更新 GFI（如果 Descriptor.scoreStrategy 需要）
5. PainDiagnosticGate 检查（统一 cooldown）
6. 写入 pain_events 表（只写一次）
7. 创建诊断任务（如果 Gate 通过）
8. 返回结果
```

### 2.6 手动入口简化

**删除**：
- `pain` 自定义工具（OpenClaw skill 定义）
- `/pd-pain` 斜杆命令（`handlePainReportCommand`）
- Hook 层的 `if (event.toolName === 'pain')` 特殊分支

**保留**：
- `pd pain record` CLI — 唯一的手动痛苦信号入口

**迁移路径**：用户告诉智能体"帮我记录一个痛苦信号"，智能体通过 bash 调用 `pd pain record`。

### 2.7 Hook 层简化

每个 Hook 文件的职责从"做 6 件事"简化为"提取 payload + 调用 recordPain"。

**移入 recordPain() 内部**：
- `trackFriction()` — GFI 更新
- `evaluatePainDiagnosticGate()` — Gate 检查
- `trajectory.recordPainEvent()` — 只写一次
- `eventLog.recordPainSignal()` — 只写一次
- `evoLogger.logPainDetected()` — 只写一次

**保留在 Hook 层**（不是痛苦信号逻辑，是通用工具调用记录）：
- `eventLog.recordToolCall()` — 记录工具调用本身
- `trajectory.recordToolCall()` — 同上
- `recordEvolutionFailure()` / `recordEvolutionSuccess()` — Trust Engine 统计
- `trackPrincipleValue()` — 原则价值观察
- Probation 反馈 — 原则试用机制

### 2.8 subagent_error 修复

从 `emitSync`（只触发 evolutionReducer 事件监听器）改为 `recordPain()`，获得：
- ✅ 写入 pain_events 表
- ✅ Gate cooldown 保护
- ✅ 创建诊断任务
- ✅ 与其他信号源行为一致

### 2.9 删除的文件/代码

| 文件 | 删除内容 | 原因 |
|------|---------|------|
| `principles-core/src/pain-signal.ts` | 整个文件 | 合并到 `pain-signal-model.ts` |
| `principles-core/src/runtime-v2/types/pain-signal.ts` | 整个文件 | 合并到 `pain-signal-model.ts` |
| `openclaw-plugin/src/core/pain-signal.ts` | 整个文件 | 直接从 `@principles/core` 导入 |
| `principles-core/src/pain-signal-adapter.ts` | 整个文件 | 被 Registry 替代 |
| `openclaw-plugin/src/core/pain-signal-adapter.ts` | 整个文件 | 被 Registry 替代 |
| 3 个 adapter 实现 | openclaw/code-review/writing | 被 Registry 的 scoreStrategy 替代 |
| `openclaw-plugin/src/commands/pain.ts` | `handlePainReportCommand()` | `/pd-pain` 删除 |
| `openclaw-plugin/src/hooks/pain.ts` | `emitPainDetectedEvent()` 函数 | 直接调用 recordPain |
| `openclaw-plugin/src/hooks/subagent.ts` | `emitSubagentPainEvent()` 函数 | 改为调用 recordPain |
| 各 Hook 文件 | `eventLog.recordPainSignal()` 调用 | 重复，recordPain 内部已写 |
| 各 Hook 文件 | `trajectory.recordPainEvent()` 调用 | 重复 |
| 各 Hook 文件 | `evoLogger.logPainDetected()` 调用 | 重复 |
| 各 Hook 文件 | `evaluatePainDiagnosticGate()` 调用 | 移入 recordPain |

## 3. 不变量约束

- `PSM-1`：所有痛苦信号必须通过 `PainToPrincipleService.recordPain()` 创建，Hook 层不得直接写入 pain_events 表。
- `PSM-2`：每种 PainSignalKind 必须在 `defaultPainSignalRegistry` 中注册对应的 PainSignalDescriptor。
- `PSM-3`：PainSignal.kind 的值域由 PainSignalKind 枚举约束，不得使用字符串字面量。
- `PSM-4`：Gate 检查（cooldown）在 `recordPain()` 内部统一执行，Hook 层不得自行调用 `evaluatePainDiagnosticGate()`。
- `PSM-5`：Layer 1 的 kind 在枚举中预留但不注册 Descriptor，直到 ADR-0010 GAP 实施时启用。

## 4. 架构收益

### 积极影响

- **业务模型在代码中表达**：三层痛觉不再是博文中的概念，而是类型系统中的 `PainLayer`
- **单一管道**：所有信号走 `recordPain()`，消除重复写入和 Hook 层越权
- **声明式 Score 策略**：从散落的硬编码变为 Descriptor 中的 scoreStrategy
- **统一 Severity**：`critical` 不再被错误映射为 `mild`
- **手动入口简化**：3 个入口合并为 1 个
- **可扩展**：新增信号类型只需注册 Descriptor，不需要改生产代码
- **GAP 预留**：`canTriggerDiagnostic` 字段为 ADR-0010 的 Layer 3 门控预留无成本切换点

### 潜在风险与缓解

| 风险 | 缓解 |
|------|------|
| 大爆炸切换可能引入回归 | 迁移前确保所有现有 pain 信号路径有集成测试覆盖 |
| `subagent_error` 改走 `recordPain` 后行为变化（会创建诊断任务了） | 这是 bug 修复而非行为变更，`subagent_error` 本应走完整管道 |
| `pain` 工具删除后用户需要适应新入口 | `pd pain record` 已可用，skill 定义中引导智能体使用 CLI |
| DB 中已有的 `painType` 值（`user_frustration`）与新 `kind` 不兼容 | 保留 `painType` 列为 legacy，新增 `kind` 列，读取时优先用 `kind` |

## 5. 与 ADR-0010 的关系

本 ADR 是 ADR-0010 (GAP) 的**前置条件**。ADR-0010 要求 Layer 3 禁止独立触发诊断，但当前代码中连 Layer 的概念都没有。本 ADR 建立了三层痛觉的类型系统，ADR-0010 的 GAP 门控只需将 Layer 3 的 `canTriggerDiagnostic` 改为 `false` 即可实施。

ADR-0010 中 Layer 1 的 `GAPSignalGenerator` 和 Objectives/KeyResults 表仍为 post-MVP conditional work，不在本 ADR 范围内。
