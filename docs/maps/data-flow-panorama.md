# 数据流全景图 (Data Flow Panorama)

> **用途**: 展示核心数据流转过程
> **目标用户**: AI 编程智能体
> **最后更新**: 2026-03-21
> **⚠️ 验证状态**: ✅ 已验证 - 与源代码一致

---

## 📋 核心数据流

### 1. 痛苦信号流

**源码**: `src/hooks/pain.ts`, `src/hooks/llm.ts`, `src/core/pain.ts`

```
工具执行失败
    ↓
after_tool_call 钩子 (src/hooks/pain.ts)
    ↓
trackFriction() 更新 GFI
    ↓
pain_score ≥ pain_trigger (默认40)?
    ↓ 是
写入 .state/pain_flag
    ↓
emitPainDetectedEvent() → EvolutionReducer
```

**关键函数**:
- `handleAfterToolCall()`: 处理工具调用结果
- `trackFriction()`: 更新GFI
- `computePainScore()`: 计算痛苦分数

---

### 2. 进化队列流

**源码**: `src/service/evolution-worker.ts`

```
Evolution Worker 每15分钟轮询
    ↓
checkPainFlag(): 读取 .state/pain_flag
    ↓
score ≥ 30 且未入队?
    ↓ 是
入队到 .state/EVOLUTION_QUEUE.json (扁平数组)
    ↓
processEvolutionQueue(): 选择最高分任务
    ↓
写入 .state/EVOLUTION_DIRECTIVE.json
    ↓
before_prompt_build 钩子注入指令
```

**关键配置**:
- `intervals.worker_poll_ms`: 900000 (15分钟)
- `intervals.task_timeout_ms`: 1800000 (30分钟)
- `thresholds.pain_trigger`: 40 (痛苦触发阈值)

---

### 3. 原则生成流

**源码**: `src/core/evolution-reducer.ts`

```
pain_detected 事件
    ↓
EvolutionReducer.onPainDetected()
    ↓
自动创建 candidate 原则
    ↓
立即调用 promote(candidate → probation)
    ↓
注入到 before_prompt_build
    ↓
recordProbationFeedback() 记录成功/失败
    ↓
successCount ≥ 3?
    ↓ 是
promote(probation → active)
    ↓
写入 memory/evolution.jsonl
```

**关键事件类型**:
- `pain_detected`: 痛苦检测
- `candidate_created`: 候选创建
- `principle_promoted`: 原则晋升
- `principle_deprecated`: 原则废弃

**⚠️ 重要**: 
- 原则创建是**自动的**，不是通过 `/pd-evolve` 命令
- 使用 `ts` 不是 `timestamp`
- 使用 `principleId` 不是 `id`

---

### 4. 信任演化流

**源码**: `src/core/trust-engine.ts`

```
工具执行结果
    ↓
recordSuccess() 或 recordFailure()
    ↓
recordSuccess(): 重置 success_streak 和 failure_streak 为 0
recordFailure(): delta = failure_streak_multiplier × (effectiveStreak - 1)
    ↓
更新 trust_score
    ↓
分数下限: 30 (不会降到30以下)
    ↓
阶段转换检查:
  < 30: Observer
  30-59: Editor
  60-79: Developer
  ≥ 80: Architect
```

**⚠️ 重要**:
- 信任引擎是**冻结状态** (`frozen: true`)
- `recordSuccess()` 只重置 streak，不增加奖励
- 失败惩罚是**线性增长**，不是指数增长

---

## 🔗 关键文件路径

| 文件 | 位置 | 用途 |
|------|------|------|
| 痛苦标志 | `.state/pain_flag` | 痛苦分数和来源 |
| 进化队列 | `.state/EVOLUTION_QUEUE.json` | 待处理任务 |
| 进化指令 | `.state/EVOLUTION_DIRECTIVE.json` | 当前任务 |
| 进化事件流 | `memory/evolution.jsonl` | 原则生命周期事件 |
| 信任分数卡 | `.state/AGENT_SCORECARD.json` | 信任分数和历史 |
| 进化积分卡 | `.state/evolution-scorecard.json` | 进化积分和等级 |

---

## 🔗 相关源码文件

| 文件 | 关键函数 | 用途 |
|------|----------|------|
| `src/hooks/pain.ts` | `handleAfterToolCall()` | 痛苦检测 |
| `src/hooks/llm.ts` | `handleLlmOutput()` | 共情信号检测 |
| `src/service/evolution-worker.ts` | `checkPainFlag()`, `processEvolutionQueue()` | 进化队列处理 |
| `src/core/evolution-reducer.ts` | `onPainDetected()`, `promote()` | 原则生命周期 |
| `src/core/trust-engine.ts` | `recordSuccess()`, `recordFailure()` | 信任计算 |

---

**文档版本**: v2.0
**最后更新**: 2026-03-21
**验证状态**: ✅ 已与源代码验证一致
