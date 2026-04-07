# Agent Trajectory Database 设计方案

> **版本**: v1.1 | **日期**: 2026-03-19 | **状态**: Implemented

---

## 1. 概述

Trajectory Database 是 Principles Disciple 的**轨迹数据持久化层**，用于存储 AI Agent 的运行时数据，支持：

| 功能 | 说明 |
|------|------|
| **数据持久化** | SQLite 存储 sessions、turns、tool calls、pain events 等 |
| **Blob 存储** | 大文本外部存储，支持阈值配置 |
| **纠错样本管理** | 自动捕获用户修正 → 样本生成 → 审核 → 导出 |
| **Analytics 导出** | 聚合指标、错误聚类、原则效果分析 |
| **Legacy 数据迁移** | 自动导入旧版 events.jsonl 和 sessions |

---

## 2. 数据模型

### 2.1 表结构

```
┌─────────────────────┐
│ sessions            │
├─────────────────────┤
│ session_id (PK) TEXT│
│ started_at TEXT     │
│ updated_at TEXT     │
└─────────────────────┘
          │
          │ 1:N
          ▼
┌─────────────────────┐     ┌─────────────────────┐
│ assistant_turns     │     │ user_turns          │
├─────────────────────┤     ├─────────────────────┤
│ id (PK) INTEGER     │     │ id (PK) INTEGER     │
│ session_id (FK)     │     │ session_id (FK)     │
│ run_id TEXT         │     │ turn_index INTEGER  │
│ provider TEXT       │     │ raw_text TEXT       │
│ model TEXT          │     │ blob_ref TEXT       │
│ raw_text TEXT       │     │ correction_detected │
│ sanitized_text TEXT │     │ correction_cue TEXT │
│ blob_ref TEXT       │     │ references_assistant│
│ usage_json TEXT     │     │ created_at TEXT     │
│ empathy_signal_json │     └─────────────────────┘
│ created_at TEXT     │
└─────────────────────┘
          │
          │ 1:N
          ▼
┌─────────────────────┐     ┌─────────────────────┐
│ tool_calls          │     │ pain_events         │
├─────────────────────┤     ├─────────────────────┤
│ id (PK) INTEGER     │     │ id (PK) INTEGER     │
│ session_id (FK)     │     │ session_id (FK)     │
│ tool_name TEXT      │     │ source TEXT         │
│ outcome TEXT        │     │ score REAL          │
│ duration_ms INTEGER │     │ severity TEXT       │
│ exit_code INTEGER   │     │ reason TEXT         │
│ error_type TEXT     │     │ origin TEXT         │
│ error_message TEXT  │     │ confidence REAL     │
│ gfi_before REAL     │     │ created_at TEXT     │
│ gfi_after REAL      │     └─────────────────────┘
│ params_json TEXT    │
│ created_at TEXT     │
└─────────────────────┘

┌─────────────────────┐     ┌─────────────────────┐
│ gate_blocks         │     │ trust_changes       │
├─────────────────────┤     ├─────────────────────┤
│ id (PK) INTEGER     │     │ id (PK) INTEGER     │
│ session_id TEXT     │     │ session_id TEXT     │
│ tool_name TEXT      │     │ previous_score REAL │
│ file_path TEXT      │     │ new_score REAL      │
│ reason TEXT         │     │ delta REAL          │
│ plan_status TEXT    │     │ reason TEXT         │
│ created_at TEXT     │     │ created_at TEXT     │
└─────────────────────┘     └─────────────────────┘

┌─────────────────────┐     ┌─────────────────────┐
│ correction_samples  │     │ sample_reviews      │
├─────────────────────┤     ├─────────────────────┤
│ sample_id (PK) TEXT │     │ id (PK) INTEGER     │
│ session_id TEXT     │     │ sample_id (FK)      │
│ bad_assistant_turn  │     │ review_status TEXT  │
│ user_correction_turn│     │ note TEXT           │
│ recovery_tool_span  │     │ created_at TEXT     │
│ diff_excerpt TEXT   │     └─────────────────────┘
│ principle_ids_json  │
│ quality_score REAL  │
│ review_status TEXT  │
│ export_mode TEXT    │
│ created_at TEXT     │
│ updated_at TEXT     │
└─────────────────────┘

┌─────────────────────┐     ┌─────────────────────┐
│ principle_events    │     │ task_outcomes       │
├─────────────────────┤     ├─────────────────────┤
│ id (PK) INTEGER     │     │ id (PK) INTEGER     │
│ principle_id TEXT   │     │ session_id TEXT     │
│ event_type TEXT     │     │ task_id TEXT        │
│ payload_json TEXT   │     │ outcome TEXT        │
│ created_at TEXT     │     │ summary TEXT        │
└─────────────────────┘     │ principle_ids_json  │
                            │ created_at TEXT     │
                            └─────────────────────┘

┌─────────────────────┐
│ exports_audit       │
├─────────────────────┤
│ id (PK) INTEGER     │
│ export_kind TEXT    │
│ mode TEXT           │
│ approved_only INT   │
│ file_path TEXT      │
│ row_count INTEGER   │
│ created_at TEXT     │
└─────────────────────┘
```

### 2.2 视图

```sql
-- 错误聚类
CREATE VIEW v_error_clusters AS
SELECT tool_name, COALESCE(error_type, 'unknown') AS error_type, COUNT(*) AS occurrences
FROM tool_calls WHERE outcome = 'failure'
GROUP BY tool_name, error_type ORDER BY occurrences DESC;

-- 原则效果
CREATE VIEW v_principle_effectiveness AS
SELECT event_type, COUNT(*) AS total
FROM principle_events GROUP BY event_type;

-- 样本队列
CREATE VIEW v_sample_queue AS
SELECT review_status, COUNT(*) AS total
FROM correction_samples GROUP BY review_status;

-- 日指标聚合
CREATE VIEW v_daily_metrics AS
SELECT
  substr(created_at, 1, 10) AS day,
  COUNT(*) AS tool_calls,
  SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures
FROM tool_calls GROUP BY substr(created_at, 1, 10);
```

### 2.3 索引

```sql
-- Session 索引
CREATE INDEX idx_assistant_turns_session_id ON assistant_turns(session_id);
CREATE INDEX idx_assistant_turns_created_at ON assistant_turns(created_at);
CREATE INDEX idx_assistant_turns_provider_model ON assistant_turns(provider, model);
CREATE INDEX idx_user_turns_session_id ON user_turns(session_id);
CREATE INDEX idx_tool_calls_session_id ON tool_calls(session_id);
CREATE INDEX idx_tool_calls_created_at ON tool_calls(created_at);
CREATE INDEX idx_pain_events_session_id ON pain_events(session_id);
CREATE INDEX idx_correction_samples_review_status ON correction_samples(review_status);
```

---

## 3. 核心特性

### 3.1 Blob 存储

大文本（默认 > 16KB）存储到外部文件，数据库只保留引用：

```typescript
interface BlobStorage {
  inlineText: string | null;  // 小文本直接存储
  blobRef: string | null;     // 大文本存储为 blob 文件名
  excerpt: string;            // 用于 diff 的摘要
}
```

**配置项**：
- `trajectory.blob_inline_threshold_bytes`: 阈值（默认 16KB）

### 3.2 Blob 清理

启动时自动清理未被引用的孤儿 blob：

```typescript
private pruneUnreferencedBlobs(): { removedFiles: number; reclaimedBytes: number } {
  // 1. 收集所有被引用的 blob
  // 2. 删除未被引用且超过宽限期的 blob
}
```

**配置项**：
- `trajectory.orphan_blob_grace_days`: 宽限期（默认 7 天）

### 3.3 并发安全

使用 WAL 模式 + busy_timeout + 文件锁：

```typescript
this.db.pragma('journal_mode = WAL');
this.db.pragma('busy_timeout = 5000');
```

**配置项**：
- `trajectory.busy_timeout_ms`: 锁等待超时（默认 5000ms）

### 3.4 纠错样本生成

自动检测用户修正行为，生成训练样本：

```
流程：
1. Assistant 输出 → recordAssistantTurn
2. Tool 失败 → recordToolCall(outcome='failure')
3. 用户修正检测 → recordUserTurn(correctionDetected=true)
4. Tool 成功恢复 → recordToolCall(outcome='success') → maybeCreateCorrectionSample
```

**样本字段**：
- `bad_assistant_turn_id`: 错误的 AI 输出
- `user_correction_turn_id`: 用户修正输入
- `recovery_tool_span_json`: 恢复工具调用
- `quality_score`: 质量分数
- `review_status`: pending/approved/rejected

---

## 4. Hook 集成

| Hook | 集成点 | 记录内容 |
|------|--------|---------|
| `llm.ts` | `handleLlmOutput` | assistant turns, empathy signals, pain events |
| `pain.ts` | `handleAfterToolCall` | tool calls (success/failure), pain events |
| `gate.ts` | `handleBeforeToolCall` | gate blocks |
| `prompt.ts` | context injection | (间接通过 WorkspaceContext) |

---

## 5. 命令接口

### `/pd-export`

```bash
/pd-export analytics              # 导出 analytics 快照
/pd-export corrections            # 导出纠错样本（原始）
/pd-export corrections --redacted # 导出纠错样本（脱敏）
```

### `/pd-samples`

```bash
/pd-samples                       # 列出待审核样本
/pd-samples review approve <id>   # 批准样本
/pd-samples review reject <id>    # 拒绝样本
```

### `/pd-status data`

显示数据库统计信息。

---

## 6. 配置

在 `pain_settings.json` 中：

```json
{
  "trajectory": {
    "blob_inline_threshold_bytes": 16384,
    "busy_timeout_ms": 5000,
    "orphan_blob_grace_days": 7
  }
}
```

---

## 7. 文件位置

| 文件 | 路径 |
|------|------|
| 数据库 | `.state/trajectory.db` |
| Blob 存储 | `.state/blobs/` |
| 导出文件 | `.state/exports/` |

---

## 8. Legacy 迁移

启动时自动迁移：

1. `sessions/*.json` → `sessions` 表
2. `logs/events.jsonl` → `pain_events`, `trust_changes`, `gate_blocks` 表
3. `memory/evolution.jsonl` → `principle_events` 表

幂等性保证：通过 `ingest_checkpoint` 表避免重复导入。

---

## 9. 实现文件

| 文件 | 说明 |
|------|------|
| `src/core/trajectory.ts` | 数据库核心实现 |
| `src/service/trajectory-service.ts` | 服务生命周期管理 |
| `src/core/workspace-context.ts` | 服务集成 |
| `src/commands/export.ts` | 导出命令 |
| `src/commands/samples.ts` | 样本管理命令 |
| `tests/core/trajectory.test.ts` | 单元测试 |