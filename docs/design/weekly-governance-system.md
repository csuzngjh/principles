# 📋 周报/状态管理系统实施方案

> **创建时间**: 2026-03-15 02:53 UTC
> **状态**: 🟡 **设计完成，待实施** (v2.1 规划中)
> **来源**: Wesley 2026-03-15 深度讨论

---

## 🎯 设计目标

解决智能体在以下极端场景下的稳定性问题：
1. 周一 Wesley 下达 20+ 个任务
2. 24 小时执行 + 上下文周期性压缩
3. 临时增加/删除任务
4. 会话重启，丢失所有短期记忆
5. 多个子智能体并行执行
6. 任务队列为空时的自主工作能力

---

## 📂 文件结构

```
memory/okr/
├── WEEK_TASKS.json          # 结构化任务列表（核心）
├── TASK_CHANGES.jsonl       # 任务变更记录（append-only）
├── WEEK_STATE.json          # 周进度和指标（已有，需更新结构）
├── WEEK_EVENTS.jsonl        # 系统事件记录（已有）
├── CURRENT_FOCUS.md         # 当前焦点摘要（人类可读）
└── RECOVERY_PROTOCOL.md     # 会话重启恢复指南（永久）
```

---

## 📄 文件格式定义

### 1. WEEK_TASKS.json（核心任务列表）

```json
{
  "week": "2026-W11",
  "createdAt": "2026-03-15T00:00:00Z",
  "createdBy": "wesley",
  "tasks": [
    {
      "id": "T1",
      "desc": "完成 PR #4 用户文档",
      "status": "done",
      "priority": "high",
      "evidence": "docs/ep-guide.md 存在，git log 显示 PR #26 已合并",
      "verifiedAt": "2026-03-14T13:00:00Z",
      "addedBy": "wesley",
      "addedAt": "2026-03-12T09:00:00Z"
    },
    {
      "id": "T2",
      "desc": "验证 EP 系统优于 Trust Engine",
      "status": "pending",
      "priority": "high",
      "evidence": null,
      "addedBy": "wesley",
      "addedAt": "2026-03-12T09:00:00Z"
    }
  ]
}
```

**状态枚举**: `pending` | `in_progress` | `done` | `blocked` | `cancelled`

### 2. TASK_CHANGES.jsonl（变更记录）

```jsonl
{"type": "add", "taskId": "T1", "desc": "完成 PR #4", "by": "wesley", "at": "2026-03-12T09:00:00Z"}
{"type": "status", "taskId": "T1", "from": "pending", "to": "in_progress", "by": "agent", "at": "..."}
{"type": "status", "taskId": "T1", "from": "in_progress", "to": "done", "evidence": "...", "by": "agent", "at": "..."}
{"type": "remove", "taskId": "T5", "reason": "不再需要", "by": "wesley", "at": "..."}
```

**规则**: append-only，永远不删除或修改已有行。

### 3. WEEK_STATE.json（更新结构）

```json
{
  "week": "2026-W11",
  "stage": "EXECUTING",
  "goal": "Evolution Points MVP",
  "metrics": {
    "totalTasks": 20,
    "done": 12,
    "inProgress": 2,
    "pending": 5,
    "blocked": 1
  },
  "lastUpdatedAt": "2026-03-15T02:53:00Z",
  "lastVerifiedAt": "2026-03-15T02:00:00Z"
}
```

### 4. RECOVERY_PROTOCOL.md（永久存在）

```markdown
# 🔄 恢复协议 - 会话重启后必读

## 第一步：读取当前状态
1. 读取 `memory/okr/WEEK_TASKS.json` → 当前任务列表
2. 读取 `memory/okr/TASK_CHANGES.jsonl` → 近期变更（最后10行）
3. 读取 `memory/okr/WEEK_STATE.json` → 周进度

## 第二步：验证进行中的任务
对每个 `in_progress` 或 `done` 任务：
- PR 合并？→ git log --oneline | grep "Merge"
- 文档存在？→ ls -la <path>
- 测试通过？→ npm test | grep "passed"

## 第三步：恢复执行
- 有 pending 任务？→ 继续执行
- 任务全空？→ 执行自主推导（见下方）
- OKR 全完成？→ 通知用户等待新方向

## 自主推导流程
1. 读取 `memory/STRATEGY.md` 和 `memory/okr/CURRENT_FOCUS.md`
2. 识别未完成的里程碑
3. 推导 3-5 个具体任务
4. 写入 `WEEK_TASKS.json`
5. 通知用户："我已规划本周任务，请确认"
```

---

## 🔄 周治理任务（更新 BOOTSTRAP.md）

```json
{
  "name": "weekly-governance",
  "schedule": { "kind": "cron", "expr": "0 0 * * 0", "tz": "UTC" },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "执行周治理：\n\n## 1. 验证 WEEK_TASKS.json\n对每个 done 任务验证证据：\n- PR 合并？git log | grep Merge\n- 文档存在？ls -la <path>\n- 测试通过？npm test\n- 验证失败？改为 blocked 并记录原因\n\n## 2. 任务队列为空？\n执行自主推导：\n- 读取 STRATEGY.md + CURRENT_FOCUS.md\n- 识别未完成里程碑\n- 推导 3-5 个具体任务\n- 写入 WEEK_TASKS.json\n- 通知用户确认\n\n## 3. OKR 全部完成？\n通知用户：'本周目标已完成，等待新方向'\n\n## 4. 更新状态\n- 更新 WEEK_STATE.json 指标\n- 记录到 WEEK_EVENTS.jsonl\n- 更新 CURRENT_FOCUS.md 摘要",
    "timeoutSeconds": 300
  },
  "delivery": { "mode": "announce" }
}
```

---

## 📋 HEARTBEAT.md 检查项（更新）

```markdown
## 📋 任务队列检查（每3次心跳）

- [ ] **检查 WEEK_TASKS.json**：是否有 in_progress 任务超过24小时？
- [ ] **检查任务队列是否为空**：如果空，提醒用户或执行自主推导
- [ ] **验证刚完成的任务**：对最近标记 done 的任务抽查证据
```

---

## 🚀 实施步骤

### Phase 1：创建核心文件（立即）
1. 创建 `memory/okr/WEEK_TASKS.json`（空任务列表）
2. 创建 `memory/okr/TASK_CHANGES.jsonl`（空文件）
3. 创建 `memory/okr/RECOVERY_PROTOCOL.md`

### Phase 2：更新模板文件
1. 更新 BOOTSTRAP.md 周治理任务（加入自主推导）
2. 更新 HEARTBEAT.md 检查项

### Phase 3：迁移现有数据
1. 从 CURRENT_FOCUS.md 提取现有任务到 WEEK_TASKS.json
2. 初始化 WEEK_STATE.json 新结构

### Phase 4：测试验证
1. 模拟会话重启，验证恢复协议
2. 模拟任务队列为空，验证自主推导

---

*本文档是实施蓝图，完成后删除。*
