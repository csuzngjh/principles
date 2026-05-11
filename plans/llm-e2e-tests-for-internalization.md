# Plan: 原则内化流程 E2E 测试完善

> **背景**：当前项目处于 v2.9 M10 完成后重构阶段，涉及 LLM 的环节存在数据流断裂和功能不完善问题。通过完善端到端测试来验证和发现这些问题。
>
> **目标**：使用真实 LLM API 验证原则内化完整流程，确保数据流完整性和组件集成正确性。

## 背景调研

### 当前 E2E 测试现状

| 类型 | 位置 | 覆盖情况 |
|------|------|----------|
| 集成测试 | `tests/integration/` | 基础集成，无 LLM 调用 |
| 单元测试 | `tests/core/` | Mock 依赖，隔离测试 |
| 回归测试 | `regression-e2e.yml` | 仅运行 `regression-v1-9-1.test.ts` |
| Runner 垂直切片测试 | `principles-core/src/runtime-v2/__tests__/` | 使用 Mock 适配器 |

### 关键差距

1. **LLM 适配器缺少真实调用测试**：`PiAiRuntimeAdapter` 只有 Mock 测试
2. **Peer Runner 链路缺少端到端验证**：Dreamer → Philosopher → Scribe → Artificer 完整链路未验证
3. **内部化编排器缺少真实集成测试**：`InternalizationOrchestrator` 只测试了 Mock
4. **数据流完整性未验证**：任务创建 → LLM 调用 → 输出存储 → 状态更新 链路未验证

### 原则内化流程数据流

```
pain signal
    ↓
DiagnosticianRunner → PiAiRuntimeAdapter → LLM API
    ↓
principle_candidates → CandidateIntakeService
    ↓
PrincipleTreeLedger (probation)
    ↓
needs_training → NocturnalWorkflowManager
    ↓
DreamerRunner → PiAiRuntimeAdapter → LLM (Dreamer prompt)
    ↓
PhilosopherRunner → LLM (Philosopher prompt)
    ↓
ScribeRunner → LLM (Scribe prompt)
    ↓
ArtificerRunner → LLM (Artificer prompt) → rule code
    ↓
EvaluatorRunner → LLM (Evaluator prompt)
    ↓
RolloutReviewerRunner → LLM (RolloutReviewer prompt)
    ↓
TrainerRunner → model training
```

## 架构决策

- **测试目标**：原则内化核心链路（Dreamer → Philosopher → Scribe）
- **LLM 提供商**：MiniMax API（`MiniMax-M2.7` 模型，provider: `minimax-cn`）
- **测试环境隔离**：每个测试使用独立临时目录
- **Mock 策略**：仅 Mock 不相关的外部依赖（文件系统），真实调用 LLM API
- **超时控制**：LLM 调用 120s 超时，Runner 5 分钟超时
- **API Key 环境变量**：`MINIMAX_CN_API_KEY`

---

## Phase 1: DreamerRunner 真实 LLM E2E 测试

**目标**：验证 DreamerRunner 与 PiAiRuntimeAdapter + 真实 LLM 的完整集成

**验收标准**：
- [ ] 真实 LLM 调用产生有效 DreamerOutput
- [ ] PIArtifact 正确写入 artifact store
- [ ] 任务状态从 `pending` → `leased` → `succeeded`
- [ ] 输出 JSON Schema 验证通过
- [ ] 错误处理正确（超时、API 错误）

**测试用例**：

1. `DreamerRunner with real LLM: succeeds with valid output`
   - 创建 pending dreamer 任务
   - 调用 runner.run()
   - 验证 LLM 返回符合 DreamerOutputV1Schema
   - 验证 artifact 写入和状态更新

2. `DreamerRunner with real LLM: handles LLM timeout gracefully`
   - 配置极短超时
   - 验证超时错误分类正确
   - 验证任务进入 retry_wait 而非 failed

3. `DreamerRunner with real LLM: validates schema on real output`
   - 真实 LLM 输出
   - 验证 DreamerValidator 正确处理

---

## Phase 2: PhilosopherRunner 真实 LLM E2E 测试

**目标**：验证 PhilosopherRunner 依赖 Dreamer artifact 的数据流

**验收标准**：
- [ ] Philosopher 读取 Dreamer 输出作为 context
- [ ] lineage artifact IDs 正确传递
- [ ] PhilosopherOutput 符合 Schema

**测试用例**：

1. `PhilosopherRunner with real LLM: reads predecessor context`
   - 先运行 Dreamer 生成 artifact
   - 创建依赖 Dreamer 的 Philosopher 任务
   - 验证 Philosopher 读取了 Dreamer context

2. `PhilosopherRunner with real LLM: validates PhilosopherOutput`
   - 验证输出符合 PhilosopherOutputV1Schema

---

## Phase 3: 内部化编排器端到端测试

**目标**：验证 InternalizationOrchestrator + Runner + RuntimeAdapter 完整集成

**验收标准**：
- [ ] orchestrator.wakeOnce() 正确选择和租赁任务
- [ ] Runner 执行并更新状态
- [ ] 编排器处理多个任务正确

**测试用例**：

1. `InternalizationOrchestrator + DreamerRunner + real LLM: full pipeline`
   - 创建 dreamer 任务
   - orchestrator.wakeOnce()
   - 验证任务被执行和完成

2. `InternalizationOrchestrator: handles concurrent tasks`
   - 创建多个 pending 任务
   - 验证只租赁一个
   - 验证其他保持 pending

---

## Phase 4: Dreamer → Philosopher → Scribe 链路测试

**目标**：验证三阶段原则生成完整链路

**验收标准**：
- [ ] Dreamer 生成 principle candidates
- [ ] Philosopher 深化 principle
- [ ] Scribe 格式化为可执行规则
- [ ] 数据流在阶段间正确传递

**测试用例**：

1. `Trinity pipeline: Dreamer → Philosopher → Scribe`
   - 创建 Dreamer 任务并执行
   - 基于 Dreamer 结果创建 Philosopher 任务
   - 基于 Philosopher 结果创建 Scribe 任务
   - 验证每个阶段的输出

2. `Trinity pipeline: validates end-to-end data integrity`
   - 验证 candidate index 正确传递
   - 验证 lineage 完整

---

## Phase 5: 错误恢复和边界条件测试

**目标**：验证系统在异常情况下的行为

**验收标准**：
- [ ] LLM API 错误正确处理
- [ ] 依赖任务失败时正确传播
- [ ] 重试逻辑正确工作

**测试用例**：

1. `Error propagation: LLM API error through pipeline`
   - Mock LLM 失败
   - 验证错误正确分类
   - 验证 telemetry 正确发送

2. `Dependency failure: philosopher waits for dreamer`
   - Dreamer 任务 failed
   - 验证 Philosopher 依赖被正确处理
   - 验证 orchestrator 不选择 Philosopher

3. `Idempotency: re-running same task`
   - 运行任务两次
   - 验证不产生重复 artifact
   - 验证状态正确

---

## 测试基础设施

### 测试配置文件

```typescript
// packages/principles-core/src/runtime-v2/__tests__/fixtures/
// - llm-e2e-config.ts: MiniMax 测试配置
// - real-workspace-fixture.ts: 真实工作空间夹具

// llm-e2e-config.ts 示例
export interface MiniMaxTestConfig {
  apiKey: string;
  model: 'MiniMax-M2.7';
  provider: 'minimax-cn';
  apiKeyEnv: 'MINIMAX_CN_API_KEY';
  timeoutMs: number;
  maxRetries: number;
}

export function getMiniMaxConfig(): MiniMaxTestConfig | null {
  const apiKey = process.env.MINIMAX_CN_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    model: 'MiniMax-M2.7',
    provider: 'minimax-cn',
    apiKeyEnv: 'MINIMAX_CN_API_KEY',
    timeoutMs: 120_000,
    maxRetries: 2,
  };
}
```

### CI 配置

```yaml
# .github/workflows/llm-e2e.yml
name: LLM E2E Tests
on:
  workflow_dispatch:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
env:
  MINIMAX_CN_API_KEY: ${{ secrets.MINIMAX_CN_API_KEY }}
```

### 测试跳过条件

- 无 `MINIMAX_CN_API_KEY` 环境变量时跳过真实 LLM 测试
- 使用 `describe.skipIf(!hasApiKey)` 在 describe 级别跳过

---

## 实现步骤

### 步骤 1: 创建测试基础设施

1. 创建 `llm-e2e-config.ts` 配置测试环境变量
2. 创建 `real-workspace-fixture.ts` 管理真实工作空间
3. 添加 `test.skipIfNoApiKey()` 辅助函数

### 步骤 2: 实现 Phase 1 测试

1. 在 `packages/principles-core/src/runtime-v2/__tests__/` 创建 `dreamer-runner-real-llm.test.ts`
2. 实现真实 LLM 调用测试用例
3. 添加 Schema 验证断言

### 步骤 3: 实现 Phase 2-4 测试

1. 创建 `philosopher-runner-real-llm.test.ts`
2. 创建 `trinity-pipeline-real-llm.test.ts`
3. 实现多阶段链路测试

### 步骤 4: 实现 Phase 5 测试

1. 创建 `internalization-error-handling.test.ts`
2. 添加错误恢复和边界条件测试

### 步骤 5: 配置 CI

1. 创建 `.github/workflows/llm-e2e.yml`
2. 添加 API key secret 配置
3. 配置定时执行

---

## 已知问题

（暂无）

---

## 风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| LLM API 成本 | 高 | 限制测试频率，每日一次 |
| LLM API 不稳定 | 中 | 实现重试和超时 |
| 测试时间过长 | 低 | 使用小模型和短超时 |
| API key 泄露 | 高 | 仅在 CI 环境使用 secret |

---

## 成功指标

- 所有 Phase 的测试在 30 分钟内完成
- 真实 LLM 调用成功率 > 90%
- 测试覆盖率：原则内化核心链路 100%
- CI 回归测试通过率 100%
