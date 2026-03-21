# 文件格式规范 (File Format Specifications)

> **用途**: 定义所有状态文件的结构，帮助AI编程助手理解和操作数据
> **目标用户**: AI 编程智能体、开发者
> **最后更新**: 2026-03-21
> **⚠️ 验证状态**: ✅ 已验证 - 与源代码一致

---

## 📋 概述

Principles Disciple 使用多种文件格式存储状态：

| 格式 | 用途 | 文件位置 |
|------|------|----------|
| JSON | 配置和状态快照 | `.state/*.json`, `.principles/*.json` |
| JSONL | 事件流和日志 | `.state/logs/*.jsonl`, `memory/evolution.jsonl` |
| SQLite | 分析数据库 | `.state/trajectory.db` |
| Markdown | 原则和知识 | `.principles/*.md`, `memory/*.md` |

---

## 🗂️ JSON 文件格式

### 1. AGENT_SCORECARD.json - 信任分数卡

**位置**: `.state/AGENT_SCORECARD.json`
**源码**: `src/core/trust-engine.ts` → `TrustScorecard` 接口 (15-32行)

```json
{
  "trust_score": 85,
  "success_streak": 0,
  "failure_streak": 0,
  "exploratory_failure_streak": 0,
  "grace_failures_remaining": 5,
  "last_updated": "2026-03-21T10:30:00.000Z",
  "cold_start_end": "2026-03-22T10:30:00.000Z",
  "first_activity_at": "2026-03-21T10:30:00.000Z",
  "history": [
    {
      "type": "success",
      "delta": 2,
      "reason": "success_base",
      "timestamp": "2026-03-21T10:30:00.000Z"
    }
  ],
  "frozen": true,
  "reward_policy": "frozen_all_positive"
}
```

**字段说明**:
| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `trust_score` | number | 当前信任分数 | 85 |
| `success_streak` | number | 建设性成功连续次数 | 0 |
| `failure_streak` | number | 建设性失败连续次数 | 0 |
| `exploratory_failure_streak` | number | 探索性失败连续次数 | 0 |
| `grace_failures_remaining` | number | 冷启动容错次数 | 5 |
| `last_updated` | string | ISO 8601 时间戳 | - |
| `cold_start_end` | string | 冷启动结束时间 | null |
| `first_activity_at` | string | 首次活动时间 | null |
| `history` | array | 历史记录 | [] |
| `frozen` | boolean | 是否冻结奖励 | true |
| `reward_policy` | string | 奖励策略 | 'frozen_all_positive' |

---

### 2. evolution-scorecard.json - 进化积分卡

**位置**: `.state/evolution-scorecard.json`
**源码**: `src/core/evolution-types.ts` → `EvolutionScorecard` 接口 (92-114行)

```json
{
  "version": "2.0",
  "agentId": "default",
  "totalPoints": 150,
  "availablePoints": 120,
  "currentTier": 3,
  "lastDoubleRewardTime": "2026-03-21T10:30:00.000Z",
  "recentFailureHashes": {},
  "stats": {
    "totalSuccesses": 45,
    "totalFailures": 12,
    "consecutiveSuccesses": 0,
    "consecutiveFailures": 0,
    "doubleRewardsEarned": 8,
    "tierPromotions": 2,
    "pointsByDifficulty": {
      "trivial": 10,
      "normal": 80,
      "hard": 60
    }
  },
  "recentEvents": [],
  "lastUpdated": "2026-03-21T10:30:00.000Z"
}
```

---

### 3. EVOLUTION_QUEUE.json - 进化队列

**位置**: `.state/EVOLUTION_QUEUE.json`
**源码**: `src/service/evolution-worker.ts` → `EvolutionQueueItem` 接口 (16-29行)

**⚠️ 重要**: 实际是**扁平数组**，不是 `{items: []}` 结构

```json
[
  {
    "id": "pain_abc123def",
    "task": "Diagnose pain [ID: abc123def]. Source: tool_failure...",
    "score": 45,
    "source": "tool_failure",
    "reason": "Command failed with exit code 1",
    "timestamp": "2026-03-21T09:15:00.000Z",
    "enqueued_at": "2026-03-21T09:15:00.000Z",
    "status": "pending"
  }
]
```

---

### 4. EVOLUTION_DIRECTIVE.json - 进化指令

**位置**: `.state/EVOLUTION_DIRECTIVE.json`
**源码**: `src/service/evolution-worker.ts` (约306-311行)

```json
{
  "active": true,
  "taskId": "abc123de",
  "task": "Diagnose systemic pain [ID: abc123de]. Source: tool_failure...",
  "timestamp": "2026-03-21T09:15:00.000Z"
}
```

---

### 5. pain_settings.json - 配置文件

**位置**: `.state/pain_settings.json`
**源码**: `src/core/config.ts` → `PainSettings` 接口

```json
{
  "language": "zh",
  "thresholds": {
    "pain_trigger": 40,
    "cognitive_paralysis_input": 4000,
    "stuck_loops_trigger": 4,
    "semantic_min_score": 0.7,
    "promotion_count_threshold": 3,
    "promotion_similarity_threshold": 0.8
  },
  "trust": {
    "stages": {
      "stage_1_observer": 30,
      "stage_2_editor": 60,
      "stage_3_developer": 80
    },
    "cold_start": {
      "initial_trust": 85,
      "grace_failures": 5,
      "cold_start_period_ms": 86400000
    },
    "penalties": {
      "tool_failure_base": -2,
      "risky_failure_base": -10,
      "gate_bypass_attempt": -5,
      "failure_streak_multiplier": -2,
      "max_penalty": -20
    },
    "rewards": {
      "success_base": 2,
      "subagent_success": 5,
      "tool_success_reward": 0.2,
      "streak_bonus_threshold": 3,
      "streak_bonus": 5,
      "recovery_boost": 5,
      "max_reward": 15
    }
  },
  "gfi_gate": {
    "enabled": true,
    "thresholds": {
      "low_risk_block": 70,
      "high_risk_block": 40,
      "large_change_block": 50
    },
    "large_change_lines": 50,
    "trust_stage_multipliers": {
      "1": 0.5,
      "2": 0.75,
      "3": 1.0,
      "4": 1.5
    },
    "bash_safe_patterns": ["npm test", "npm run build", "git status"],
    "bash_dangerous_patterns": ["rm -rf", "mkfs", "dd if="]
  },
  "empathy_engine": {
    "enabled": true,
    "dedupe_window_ms": 60000,
    "penalties": {
      "mild": 10,
      "moderate": 25,
      "severe": 40
    },
    "rate_limit": {
      "max_per_turn": 40,
      "max_per_hour": 120
    },
    "model_calibration": {}
  }
}
```

---

## 📝 JSONL 文件格式

### 1. events.jsonl - 事件日志

**位置**: `.state/logs/events.jsonl`

每行一个JSON对象：

```json
{
  "ts": "2026-03-21T10:30:00.000Z",
  "date": "2026-03-21",
  "type": "tool_call",
  "category": "success",
  "sessionId": "ses_abc123",
  "data": {
    "toolName": "bash",
    "exitCode": 0,
    "durationMs": 1500
  }
}
```

---

### 2. evolution.jsonl - 进化事件流

**位置**: `memory/evolution.jsonl`
**源码**: `src/core/evolution-types.ts` → `EvolutionLoopEvent` 类型 (307-314行)

事件类型 (使用 `ts` 不是 `timestamp`):
```json
{"ts": "2026-03-21T10:30:00.000Z", "type": "pain_detected", "data": {"painId": "abc", "painType": "tool_failure", "source": "bash", "reason": "Command failed"}}
{"ts": "2026-03-21T10:30:00.000Z", "type": "candidate_created", "data": {"painId": "abc", "principleId": "xyz", "trigger": "npm install fails", "action": "Check package-lock.json", "status": "candidate"}}
{"ts": "2026-03-21T10:30:00.000Z", "type": "principle_promoted", "data": {"principleId": "xyz", "from": "probation", "to": "active", "reason": "success_threshold", "successCount": 3}}
{"ts": "2026-03-21T10:30:00.000Z", "type": "principle_deprecated", "data": {"principleId": "xyz", "reason": "conflict_detected", "triggeredBy": "auto"}}
{"ts": "2026-03-21T10:30:00.000Z", "type": "principle_rolled_back", "data": {"principleId": "xyz", "reason": "too_many_conflicts", "triggeredBy": "auto_conflict"}}
{"ts": "2026-03-21T10:30:00.000Z", "type": "circuit_breaker_opened", "data": {"taskId": "abc", "painId": "xyz", "failCount": 3, "reason": "repeated_failures", "requireHuman": true}}
```

---

## 🔗 相关源码文件

| 文件 | 关键接口/函数 | 用途 |
|------|---------------|------|
| `src/core/trust-engine.ts` | `TrustScorecard` (15-32行) | 信任分数卡定义 |
| `src/core/evolution-types.ts` | `EvolutionScorecard` (92-114行) | 进化积分卡定义 |
| `src/core/evolution-types.ts` | `EvolutionLoopEvent` (307-314行) | 进化事件定义 |
| `src/service/evolution-worker.ts` | `EvolutionQueueItem` (16-29行) | 进化队列定义 |
| `src/core/config.ts` | `PainSettings` 接口 | 配置定义 |
| `src/core/trajectory.ts` | `initSchema()` | 数据库表定义 |

---

**文档版本**: v2.0
**最后更新**: 2026-03-21
**验证状态**: ✅ 已与源代码验证一致
