# PRI-87/88/89/90/91 Implementation Plan

## Summary

实施 5 个相互依赖的 Linear issue，构建 Internalization Engine 的严格验证、任务提交、CLI 入口、Philosopher Runner 和调度链。按依赖顺序串行推进：PRI-87 → PRI-88 → (PRI-89 ‖ PRI-90) → PRI-91。

## Current State Analysis

### 已有基础设施

| 组件 | 文件 | 状态 |
|------|------|------|
| DreamerOutput 类型 + PassThroughDreamerValidator | `internalization/dreamer-output.ts` | ✅ 完整，但 validator 是 pass-through |
| DreamerRunner | `internalization/dreamer-runner.ts` | ✅ 完整，接受 DreamerValidator 注入 |
| InternalizationOrchestrator | `internalization/internalization-orchestrator.ts` | ✅ 有 `proposeNextTask()` 但只返回 proposal 不持久化 |
| PITaskMetadata 序列化/水合 | `internalization/pitask-metadata.ts` | ✅ 完整 |
| State Machine Guards | `internalization/internalization-state-machine.ts` | ✅ 有 `createNextTaskProposal()` |
| Job Graph | `internalization/internalization-job-graph.ts` | ✅ 定义了 dreamer→philosopher→scribe→artificer→evaluator→rollout_reviewer→trainer |
| PIArtifactStore | `internalization/pi-artifact.ts` + `pi-artifact-store.ts` | ✅ 有 Memory 和 SQLite 实现 |
| RuntimeStateManager | `store/runtime-state-manager.ts` | ✅ 有 `createTask()` 方法 |
| run-once CLI | `pd-cli/commands/runtime-internalization-run-once.ts` | ✅ 仅支持 dreamer，使用 PassThroughDreamerValidator |
| candidate CLI | `pd-cli/commands/candidate.ts` | ✅ 有 list/show/intake/audit/repair/route 子命令 |
| Internalization Route | `internalization/internalization-route.ts` | ✅ 有 `decideInternalizationRoute()` |
| Architecture Regression Tests | `__tests__/architecture-regression.test.ts` | ✅ 覆盖边界约束 |

### 关键发现

1. **DreamerValidator 是接口注入**：`DreamerRunner` 通过 `DreamerRunnerDeps.validator` 接收 validator，替换只需改注入点
2. **PassThroughDreamerValidator 已标注 @deprecated**：注释明确说"must be implemented in a future PRI-67 follow-up"
3. **proposeNextTask() 已存在**：返回 `ProposeNextTaskResult = ProposalCreatedResult | null`，但不持久化
4. **RuntimeStateManager.createTask() 已存在**：接受 `Omit<TaskRecord, 'createdAt' | 'updatedAt'>`，含 `diagnosticJson` 字段
5. **run-once CLI 硬编码 `new PassThroughDreamerValidator()`**：第 227 行
6. **run-once CLI 硬编码 `runnerKind !== 'dreamer'` 检查**：第 196-199 行
7. **candidate CLI 已有 `route` 子命令**：可复用为 `internalize` 子命令的入口
8. **DreamerOutput.candidates 是 `readonly DreamerCandidate[]`**：candidate 有 candidateIndex, badDecision, betterDecision, rationale, confidence(0-1), riskLevel('low'|'medium'|'high'), strategicPerspective

---

## PRI-87: DreamerOutput Strict Validator

### 目标

替换生产路径中的 `PassThroughDreamerValidator`，确保 malformed Dreamer output 不会 mark succeeded 或写 PIArtifact。

### 修改文件

#### 1. `packages/principles-core/src/runtime-v2/internalization/dreamer-output.ts`

**新增 `DefaultDreamerValidator` 类**：

```ts
export class DefaultDreamerValidator implements DreamerValidator {
  async validate(output: DreamerOutput, taskId: string): Promise<DreamerValidationResult> {
    const errors: string[] = [];

    // output 是 object（由 TypeScript 类型保证，但 runtime 可能收到 any）
    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    // taskId 存在且等于当前 taskId
    if (output.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${output.taskId}`);
    }

    // valid 标志必须为 true
    if (output.valid !== true) {
      errors.push('output.valid must be true');
    }

    // candidates 是数组
    if (!Array.isArray(output.candidates)) {
      errors.push('candidates must be an array');
    } else {
      // candidates 长度 1-5
      if (output.candidates.length < 1 || output.candidates.length > 5) {
        errors.push('candidates must have 1-5 items');
      }
      // 逐个验证 candidate
      for (const c of output.candidates) {
        if (typeof c.candidateIndex !== 'number') errors.push('candidate.candidateIndex must be number');
        if (typeof c.badDecision !== 'string' || c.badDecision.trim() === '') errors.push('candidate.badDecision must be non-empty string');
        if (typeof c.betterDecision !== 'string' || c.betterDecision.trim() === '') errors.push('candidate.betterDecision must be non-empty string');
        if (typeof c.rationale !== 'string' || c.rationale.trim() === '') errors.push('candidate.rationale must be non-empty string');
        if (typeof c.confidence !== 'number') errors.push('candidate.confidence must be number');
        else if (c.confidence < 0 || c.confidence > 1) errors.push('candidate.confidence must be in [0, 1]');
        if (c.riskLevel !== 'low' && c.riskLevel !== 'medium' && c.riskLevel !== 'high') errors.push('candidate.riskLevel must be low|medium|high');
        if (typeof c.strategicPerspective !== 'string' || c.strategicPerspective.trim() === '') errors.push('candidate.strategicPerspective must be non-empty string');
      }
    }

    // contextRefs 是数组
    if (!Array.isArray(output.contextRefs)) {
      errors.push('contextRefs must be an array');
    }

    // generatedAt 是非空字符串（ISO-8601 格式）
    if (typeof output.generatedAt !== 'string' || output.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
```

**保留 `PassThroughDreamerValidator`**，但添加更明确的 deprecated 注释和 `@internal` 标记。

#### 2. `packages/principles-core/src/runtime-v2/internalization/index.ts`

- 新增导出 `DefaultDreamerValidator`

#### 3. `packages/principles-core/src/runtime-v2/__tests__/dreamer-runner-vslice.test.ts`

**新增测试用例**（RED first）：

- valid Dreamer output 被 DefaultDreamerValidator 接受
- 缺 required field（如 taskId）被拒绝
- confidence 是字符串时被拒绝
- confidence < 0 或 > 1 被拒绝
- unknown riskLevel 被拒绝
- output taskId 与当前 task 不一致时被拒绝
- invalid output 不写 artifact
- invalid output 不 mark succeeded，走 retry/fail 语义

#### 4. `packages/pd-cli/src/commands/runtime-internalization-run-once.ts`

- 第 227 行：将 `new PassThroughDreamerValidator()` 替换为 `new DefaultDreamerValidator()`
- 更新 import

#### 5. `packages/pd-cli/tests/commands/runtime-internalization-run-once.test.ts`

- 新增测试：run-once 默认不再使用 PassThroughDreamerValidator

#### 6. `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`

- 新增 guard：确认 production run-once 不直接使用 PassThroughDreamerValidator
- 确认 DefaultDreamerValidator 从 barrel 正确导出
- 确认 DefaultDreamerValidator 不 import plugin/nocturnal/fs/path/process

### 验证命令

```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/principles-core/src/runtime-v2/__tests__/dreamer-runner-vslice.test.ts
npx vitest run packages/pd-cli/tests/commands/runtime-internalization-run-once.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts
npm run typecheck:openclaw-plugin
```

---

## PRI-88: Successor Task Committer

### 依赖

PRI-87 合并后开始

### 目标

把 `InternalizationOrchestrator.proposeNextTask()` 返回的 successor proposal 真正持久化成 TaskRecord，并且幂等。

### 修改文件

#### 1. `packages/principles-core/src/runtime-v2/internalization/internalization-orchestrator.ts`

**新增 `commitNextTaskProposal()` 方法**：

```ts
export type CommitNextTaskResult =
  | { decision: 'successor_created'; sourceTaskId: string; successorTaskId: string; successorKind: PeerRunnerKind }
  | { decision: 'successor_exists'; sourceTaskId: string; successorTaskId: string; successorKind: PeerRunnerKind }
  | { decision: 'no_successor'; sourceTaskId: string; reason: string }
  | { decision: 'invalid_task_metadata'; taskId: string; reason: string }
  | { decision: 'source_not_succeeded'; taskId: string; status: PDTaskStatus }
  | { decision: 'task_not_found'; taskId: string };
```

**幂等策略**：使用 `sourceTaskId + successorKind + channel` 作为查重条件，通过 `listTasks({ status: 'pending' })` + `hydratePITaskRecord()` 检查是否已有匹配的 successor task。

**实现逻辑**：

1. `getTask(taskId)` → null → `task_not_found`
2. `hydratePITaskRecord(task)` → null → `invalid_task_metadata`
3. `task.status !== 'succeeded'` → `source_not_succeeded`
4. `proposeNextTask(taskId)` → null → `no_successor`
5. 查重：遍历 pending tasks，hydrate 后匹配 `parentTaskId === taskId && taskKind === proposal.taskKind && channel === proposal.channel`
6. 找到 → `successor_exists`
7. 未找到 → `createTask()` + `createPITaskDiagnosticJson()` → `successor_created`

#### 2. `packages/principles-core/src/runtime-v2/__tests__/internalization-orchestrator.test.ts`

**新增测试用例**（RED first）：

- succeeded dreamer commit 后创建 philosopher task
- repeated commit 返回同一个 successor task，不重复创建
- source task 不存在时 structured failure（task_not_found）
- source task 不是 succeeded 时不创建 successor（source_not_succeeded）
- source task metadata invalid 时 fail closed（invalid_task_metadata）
- terminal runner（如 trainer）没有 successor 时返回 no_successor
- 创建出来的 successor task 经过 SQLite 持久化后仍能 hydratePITaskRecord()
- successor metadata 包含 parentTaskId、dependencyTaskIds、channel、inputArtifactRefs

#### 3. `packages/principles-core/src/runtime-v2/internalization/index.ts`

- 导出 `CommitNextTaskResult` 类型

#### 4. `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`

- 新增 guard：确认 CommitNextTaskResult 从 barrel 导出

### 验证命令

```bash
npm run build --workspace=@principles/core
npx vitest run packages/principles-core/src/runtime-v2/__tests__/internalization-orchestrator.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/pitask-metadata.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts
npm run typecheck:openclaw-plugin
```

---

## PRI-89: Candidate-to-Internalization Seed CLI

### 依赖

PRI-88 合并后开始

### 目标

从 Diagnostician candidate/recommendation 创建 root Dreamer PI task，打通 candidate 到 internalization queue 的入口。

### 修改文件

#### 1. `packages/pd-cli/src/commands/candidate.ts`

**新增 `handleCandidateInternalize()` 函数**：

命令：`pd candidate internalize --candidate-id <id> --workspace <path> [--dry-run] [--json]`

流程：
1. 解析 workspace
2. 读取 candidate（`stateManager.getCandidate()`）
3. 读取 recommendation（从 candidate.sourceRecommendationJson 或 column fallback）
4. 调用 `decideInternalizationRoute()`
5. 如果 route 是 defer/no-op，返回 structured no_task_created
6. 如果 `--dry-run`，返回预览不写数据库
7. 幂等查重：candidateId + recommendationId + route/channel
8. 创建 root dreamer TaskRecord（`stateManager.createTask()`）
9. 使用 `createPITaskDiagnosticJson()` 写 PI metadata
10. 返回结构化输出

**输出结构**：

```ts
interface CandidateInternalizeResult {
  candidateId: string;
  route: InternalizationRouteKind;
  taskId?: string;
  channel?: InternalizationChannel;
  status: 'created' | 'existing' | 'dry_run' | 'no_task_created';
  reason?: string;
}
```

#### 2. `packages/pd-cli/tests/commands/candidate.test.ts`

**新增测试用例**（RED first）：

- valid actionable candidate 创建 root dreamer PI task
- repeated seed 返回 existing task，不重复创建
- `--dry-run` 不写数据库
- defer/non-actionable route 返回 structured no_task_created
- candidate 不存在返回 structured error
- recommendation kind 映射到正确 channel
- 创建的 task 能通过 hydratePITaskRecord()
- JSON 输出包含 candidateId、route、taskId、channel、created/existing/dryRun

#### 3. `packages/pd-cli/src/index.ts`（或命令注册文件）

- 注册 `candidate internalize` 子命令

### 验证命令

```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/pd-cli/tests/commands/candidate.test.ts
npm run typecheck:openclaw-plugin
```

---

## PRI-90: PhilosopherRunner Vertical Slice

### 依赖

PRI-87 和 PRI-88 合并后开始

### 目标

实现第二个 peer runner：PhilosopherRunner。读取 Dreamer artifact，调用 PDRuntimeAdapter，验证输出，写 Philosopher artifact，mark task succeeded。

### 修改文件

#### 1. `packages/principles-core/src/runtime-v2/internalization/philosopher-output.ts`（新增）

```ts
export interface PhilosopherOutputV1 {
  taskId: string;
  sourceDreamerArtifactId: string;
  thesis: string;
  principleCandidate: {
    title: string;
    rationale: string;
    scope: string;
    confidence: number;
  };
  risks: string[];
  generatedAt: string;
}

export interface PhilosopherValidationResult {
  valid: boolean;
  errors: readonly string[];
  errorCategory?: PDErrorCategory;
}

export interface PhilosopherValidator {
  validate(output: PhilosopherOutputV1, taskId: string): Promise<PhilosopherValidationResult>;
}

export class DefaultPhilosopherValidator implements PhilosopherValidator { ... }
```

#### 2. `packages/principles-core/src/runtime-v2/internalization/philosopher-runner.ts`（新增）

复用 DreamerRunner 模式，但关键差异：
- taskKind 必须是 `philosopher`，否则 fail closed
- 从 dependencyTaskIds 找到 succeeded dreamer task
- 通过 dreamer task 的 resultRef / PIArtifactStore 找到 Dreamer artifact
- 构建 runtime input 时包含 Dreamer artifact 内容
- `outputSchemaRef: 'philosopher-output-v1'`
- 写 Philosopher PIArtifact（artifactKind: 'principle'）
- mark succeeded with `philosopher://` resultRef

#### 3. `packages/principles-core/src/runtime-v2/__tests__/philosopher-runner-vslice.test.ts`（新增）

**测试用例**（RED first）：

- taskKind 不是 philosopher 时 fail closed
- lease conflict non-mutating
- missing Dreamer dependency blocked/failure
- Dreamer dependency 未 succeeded 时不能执行
- Dreamer artifact 缺失时走 retry/fail
- valid runtime output 写 Philosopher PIArtifact
- valid runtime output mark task succeeded
- invalid output 不写 artifact
- artifact write failure 走 retry/fail，不 mark succeeded
- 不 import plugin/nocturnal，不直接调用 Scribe

#### 4. `packages/principles-core/src/runtime-v2/internalization/index.ts`

- 导出 PhilosopherRunner, PhilosopherOutputV1, PhilosopherValidator, DefaultPhilosopherValidator

#### 5. `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`

- 新增 guard：philosopher-runner.ts 不 import plugin/nocturnal
- 不出现 ScribeRunner 调用
- barrel exports 完整

### 验证命令

```bash
npm run build --workspace=@principles/core
npx vitest run packages/principles-core/src/runtime-v2/__tests__/philosopher-runner-vslice.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/dreamer-runner-vslice.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts
npm run typecheck:openclaw-plugin
```

---

## PRI-91: run-once Dispatcher for Successor Chain

### 依赖

PRI-88 和 PRI-90 合并后开始

### 目标

扩展 operator CLI，让 run-once 支持 philosopher，并通过显式 `--enqueue-next` 提交 successor task。

### 修改文件

#### 1. `packages/pd-cli/src/commands/runtime-internalization-run-once.ts`

**修改**：

- runner dispatch table：支持 `dreamer` / `philosopher`
- unsupported runner 直接 structured error，不获取 lease
- 新增 `--enqueue-next` 选项：只在 runner success 后调用 `orchestrator.commitNextTaskProposal()`
- `--enqueue-next` 必须幂等
- 保留 `--allow-test-double` 安全门
- 不自动跑下一个 runner
- 不 daemonize

**RunOnceOptions 扩展**：

```ts
interface RunOnceOptions {
  workspace?: string;
  json?: boolean;
  runtime?: string;
  runner?: string;
  allowTestDouble?: boolean;
  enqueueNext?: boolean;  // 新增
}
```

**RunOnceOutput 扩展**：

```ts
interface RunOnceOutput {
  // ...existing fields...
  successorTaskId?: string;     // 新增
  successorKind?: string;       // 新增
  enqueueDecision?: string;     // 新增
}
```

#### 2. `packages/pd-cli/tests/commands/runtime-internalization-run-once.test.ts`

**新增测试用例**（RED first）：

- `--runner philosopher` dispatches PhilosopherRunner
- unsupported runner fails closed，不 lease
- successful dreamer + `--enqueue-next` 返回 successorTaskId
- repeated `--enqueue-next` 返回 existing successorTaskId
- test-double 仍必须显式 `--allow-test-double`
- JSON 输出包含 runnerKind、decision、taskId、runId、artifactId、resultRef、successorTaskId
- text 输出也包含关键 id
- RuntimeStateManager close/resource cleanup 不退化

#### 3. `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`

- 新增 guard：确认 run-once 不自动跑下一个 runner（无循环调度逻辑）

### 验证命令

```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/pd-cli/tests/commands/runtime-internalization-run-once.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/internalization-orchestrator.test.ts
npm run typecheck:openclaw-plugin
```

---

## Assumptions & Decisions (Confirmed)

| 决策点 | 选择 | 理由 | 状态 |
|--------|------|------|------|
| Validator 命名 | `DefaultDreamerValidator` | 与 DefaultLeaseManager/DefaultRetryPolicy 命名一致 | ✅ 已确认 |
| PassThroughDreamerValidator 处置 | 保留但标 deprecated + @internal | 测试需要，且指令要求保留 | ✅ 已确认 |
| Successor committer 位置 | 在 InternalizationOrchestrator 上加方法 | 保持职责内聚，不引入新类 | ✅ 已确认 |
| 幂等查重策略 | sourceTaskId + successorKind + channel | 指令建议，且与 PITaskMetadata 字段对齐 | ✅ 已确认 |
| Candidate internalize 命令入口 | `pd candidate internalize` | 复用现有 candidate 命令树，与 route 子命令一致 | ✅ 已确认 |
| PhilosopherOutputV1 字段 | 最小可用 contract | 指令要求"不要试图一次性设计完整原则编译器" | ✅ 已确认 |
| PhilosopherRunner 复用策略 | 复用 DreamerRunner 模式但不复制粘贴 | 指令要求"若需要抽象，必须很小" | ✅ 已确认 |
| --enqueue-next 语义 | 显式 opt-in | 指令要求"不自动跑下一个 runner" | ✅ 已确认 |
| --runner auto | 不实现 | 指令要求"只有在可确定、可测试、fail closed 时才实现" | ✅ 已确认 |

## Verification Steps

每个 PR 必须通过：

1. `npm run build --workspace=@principles/core` + `npm run build --workspace=@principles/pd-cli`
2. 相关 vitest 测试全部通过
3. `npm run typecheck:openclaw-plugin` 通过
4. architecture-regression.test.ts 通过
5. PR 描述包含：变更文件、测试命令、测试结果、剩余风险
