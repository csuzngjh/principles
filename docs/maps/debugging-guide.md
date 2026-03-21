# 调试指南 (Debugging Guide)

> **用途**: 提供常见问题的诊断和解决方案
> **目标用户**: AI 编程智能体
> **最后更新**: 2026-03-21
> **⚠️ 验证状态**: ✅ 已验证 - 与源代码一致

---

## 🔍 场景1: Agent 被门禁阻塞

### 诊断步骤

#### 1. 检查当前信任阶段

```bash
# 查看信任分数
cat .state/AGENT_SCORECARD.json | jq '.trust_score'

# 查看当前阶段
cat .state/AGENT_SCORECARD.json | jq '{
  score: .trust_score,
  stage: (.trust_score < 30 ? "Observer" : .trust_score < 60 ? "Editor" : .trust_score < 80 ? "Developer" : "Architect")
}'
```

**阶段权限**:
| 阶段 | 分数范围 | 最大行数 | 最大文件数 |
|------|----------|----------|------------|
| Observer | 0-29 | 20 | 1 |
| Editor | 30-59 | 50 | 2 |
| Developer | 60-79 | 300 | 5 |
| Architect | 80-100 | 500 | 10 |

#### 2. 检查GFI

```bash
# 查看最近的门禁阻塞事件
grep "gate_block" .state/logs/events.jsonl | tail -5
```

**GFI阻塞阈值**:
| GFI | 低风险工具 | 高风险工具 | Agent工具 |
|-----|-----------|-----------|-----------|
| < 40 | ✅ | ✅ | ✅ |
| 40-69 | ✅ | ❌ | ✅ |
| 70-89 | ❌ | ❌ | ✅ |
| ≥ 90 | ❌ | ❌ | ❌ |

**⚠️ 重要**: 高风险工具阻塞阈值是 **40**，不是 85

---

## 🔍 场景2: 痛苦信号未触发

### 诊断步骤

```bash
# 检查痛苦触发阈值
cat .state/pain_settings.json | jq '.thresholds.pain_trigger'

# 检查痛苦标志是否存在
ls -la .state/pain_flag

# 检查最近的痛苦事件
grep "pain_signal" .state/logs/events.jsonl | tail -5
```

**关键配置**:
- `thresholds.pain_trigger`: 40 (默认值)
- 痛苦标志路径: `.state/pain_flag` (不是 `.state/.pain_flag`)

---

## 🔍 场景3: 进化流程不工作

### 诊断步骤

```bash
# 检查痛苦标志
cat .state/pain_flag

# 检查进化队列
cat .state/EVOLUTION_QUEUE.json | jq '.[] | select(.status == "pending")'

# 检查当前指令
cat .state/EVOLUTION_DIRECTIVE.json

# 检查工作器配置
cat .state/pain_settings.json | jq '{
  worker_interval: .intervals.worker_poll_ms,
  task_timeout: .intervals.task_timeout_ms
}'
```

**关键配置**:
- `intervals.worker_poll_ms`: 900000 (15分钟)
- `intervals.task_timeout_ms`: 1800000 (30分钟)

---

## 🔍 场景4: 原则未生成

### 诊断步骤

```bash
# 检查进化事件流
tail -20 memory/evolution.jsonl | jq '.type'

# 检查候选创建事件
cat memory/evolution.jsonl | jq 'select(.type == "candidate_created")' | tail -5

# 检查晋升事件
cat memory/evolution.jsonl | jq 'select(.type == "principle_promoted")' | tail -5
```

**关键事件类型**:
- `pain_detected`: 痛苦检测
- `candidate_created`: 候选创建
- `principle_promoted`: 原则晋升 (成功阈值: 3)
- `principle_deprecated`: 原则废弃

---

## 🔍 场景5: 信任分数异常

### 诊断步骤

```bash
# 查看信任变化历史
cat .state/AGENT_SCORECARD.json | jq '.history[-10:]'

# 查看当前配置
cat .state/pain_settings.json | jq '{
  initial_trust: .trust.cold_start.initial_trust,
  grace_failures: .trust.cold_start.grace_failures,
  tool_failure_base: .trust.penalties.tool_failure_base,
  failure_streak_multiplier: .trust.penalties.failure_streak_multiplier
}'
```

**关键配置**:
- `trust.cold_start.initial_trust`: 85 (初始信任)
- `trust.cold_start.grace_failures`: 5 (冷启动容错)
- `trust.penalties.failure_streak_multiplier`: -2 (连续失败乘数)

---

## 🔗 相关源码文件

| 文件 | 关键函数 | 用途 |
|------|----------|------|
| `src/hooks/gate.ts` | `handleBeforeToolCall()` | 门禁逻辑 |
| `src/hooks/pain.ts` | `handleAfterToolCall()` | 痛苦检测 |
| `src/service/evolution-worker.ts` | `checkPainFlag()`, `processEvolutionQueue()` | 进化处理 |
| `src/core/evolution-reducer.ts` | `onPainDetected()`, `promote()` | 原则生成 |
| `src/core/trust-engine.ts` | `recordSuccess()`, `recordFailure()` | 信任计算 |

---

**文档版本**: v2.0
**最后更新**: 2026-03-21
**验证状态**: ✅ 已与源代码验证一致
