# PD 工作流数据流梳理与可观测框架

> 日期：2026-04-18
> 状态：进行中（设计迭代中）

---

## Context

PD 系统有 9 条以上的工作流交织在一起，没人能说清楚完整的数据流。Issue #366（Diagnostician 只写 Marker 不写 JSON）暴露了一个更深层的问题：**我们甚至没有手段去发现这个断点在哪里**。

**重要设计约束：PD 工作流仍在持续开发中，调研结论可能不准，工作流本身也会持续调整。**

因此：
- 设计必须承认"当前理解的可能是错的"
- 工作流变了，不应该需要改代码
- 调研结论是"当前最佳理解"，不是"永恒真相"
- YAML 文件才是系统地图，代码只是执行引擎

---

## 核心设计原则

1. **YAML 是单一真相来源**：想了解 PD 工作流 → 只读一个 YAML 文件
2. **event-log 是原始数据记录层**：只负责写 event，不定义漏斗结构
3. **漏斗从 event 数据 + YAML 定义推导出来**：不是代码定义漏斗，是 YAML 定义漏斗
4. **YAML 可以随时修正，不破坏已有代码**：调查结论变了 → 更新 YAML；工作流变了 → 更新 YAML
5. **新增工作流只需在 YAML 加 entry，event-log 不动**

---

## 调研结果：PD 工作流总图（当前最佳理解）

> ⚠️ 以下是当前调研结论，是"当前最佳理解"而非"永恒真相"。随着代码变化和持续调研，细节会调整。

```
【Pain 信号源】（多条）
  ├─ after_tool_call (pain.ts)        → tool_failure
  ├─ subagent_ended error (subagent.ts) → subagent_error
  ├─ lifecycle hook (lifecycle.ts)     → intercept_extraction
  └─ manual (pain.ts 'pain' 工具)     → manual
       ↓
  writePainFlag() + emitPainDetectedEvent()
       ↓
  PAIN_FLAG 文件  +  pain_signal event
       ↓
  ┌─────────────────────────────────────────────────────────┐
  │  Evolution Worker（90s heartbeat 驱动）                   │
  │  processEvolutionQueue()                                │
  │    ├─ pain_diagnosis task ──────────────────────────┐ │
  │    │     → addDiagnosticianTask()                    │ │
  │    │     → diagnostician_tasks.json (写)            │ │
  │    │     ← getPendingDiagnosticianTasks() (读)       │ │
  │    │     ← Heartbeat LLM 注入 prompt                │ │
  │    │     ← LLM 写 .evolution_complete_<id>          │ │
  │    │     ← LLM 写 .diagnostician_report_<id>.json   │ │
  │    │     → Worker 检测 marker                        │ │
  │    │     → createPrincipleFromDiagnosis()            │ │
  │    │     → event: principle_candidate                │ │
  │    └─────────────────────────────────────────────────┘ │
  │    └─ sleep_reflection task ───────────────────────┐ │
  │          → NocturnalWorkflowManager                  │ │
  │          → Dreamer → Philosopher → Scribe          │ │
  │          → persistArtifact + code candidate         │ │
  │          → ReplayEngine（手动 /pd-promote-impl eval）│ │
  │          → PromotionGate → active                    │ │
  └─────────────────────────────────────────────────────────┘

  【RuleHost 实时拦截链】（独立）
    每次 write/bash/agent 工具调用同步触发
    RuleHost.evaluate() → vm 执行 active 实现
    → block / requireApproval / allow
```

### 已发现的关键断点

**断点 1：diagnostician JSON 报告（Issue #366）**
- LLM 写完 marker 后被截断，JSON 报告未写
- Worker 检测 marker 存在 → 读 JSON → 不存在
- 重试最多 3 次（`requeueDiagnosticianTask`），之后静默失败
- **没有 stats 记录 missing_json 的次数**

**断点 2：Nocturnal ReplayEngine 手动触发**
- Nocturnal 生成 code candidate 后，需要手动运行 `/pd-promote-impl eval`

### 已发现的冗余

**冗余 1：`getActivePrinciples` 被读两次**
- evolution-worker.ts:1278 → 构建 prompt 时注入现有原则给 LLM 去重
- evolution-reducer.ts:285 → 服务端再次去重（内存遍历）

**冗余 2：`pain_detected` event 双重写入**
- pain.ts:385 → emitPainDetectedEvent → EVOLUTION_STREAM + trajectory principle_events
- pain.ts:301 → wctx.trajectory?.recordPainEvent → trajectory pain_events

---

## 设计方案

### 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│  workflows.yaml  ← 单一真相来源，系统地图                   │
│  定义：工作流列表、每级漏斗节点、event类型、stats字段映射   │
└─────────────────────────────────────────────────────────────┘
            ↑
            │ 漏斗定义（纯数据）
            │
┌─────────────────────────────────────────────────────────────┐
│  event-log.ts  ← 原始 event 记录层（不定义漏斗结构）      │
│  recordXxx() → events.jsonl                               │
│  aggregateEventsIntoStats() → daily-stats.json             │
└─────────────────────────────────────────────────────────────┘
            ↑
            │ event 写入
            │
┌─────────────────────────────────────────────────────────────┐
│  各工作流代码  ← 按需调用 eventLog.recordXxx()            │
│  pain.ts / evolution-worker.ts / rule-host.ts 等            │
└─────────────────────────────────────────────────────────────┘
```

### workflows.yaml 结构

```yaml
# ============================================================
# PD 工作流漏斗定义
# ============================================================
# 使用说明：
# - 此文件是 PD 工作流的单一真相来源
# - 想了解 PD 有哪些工作流、每级漏斗是什么 → 只读此文件
# - 工作流变了？更新此文件，不改代码
# - 调研结论可能不准？此文件可以随时修正，不需要改代码
# ============================================================

workflows:

  # ----------------------------------------------------------
  # 工作流 1：Pain → Diagnostician → Evolution（核心学习闭环）
  # 状态：surveyed（调研结论可能随代码变化而调整）
  # ----------------------------------------------------------
  pd_pain_to_evolution:
    name: "Pain → Diagnostician → Evolution"
    description: |
      核心学习闭环：工具失败 → 诊断任务 → JSON报告 → 原则生成
      触发源：after_tool_call hook / subagent error / manual
    trigger: "工具失败 (pain.ts) + heartbeat 触发 (evolution-worker.ts)"
    stages:

      - id: pain_signal
        name: "Pain Signal 写入"
        description: "after_tool_call hook 检测到工具失败，写入 PAIN_FLAG"
        event: pain_signal
        statsField: painSignals
        emittedBy:
          - "pain.ts:handleAfterToolCall"
        fileWrite:
          - "PAIN_FLAG"
        notes: "pain.ts line 323"

      - id: diagnosis_task_enqueued
        name: "诊断任务入队"
        description: "evolution-worker 读取 PAIN_FLAG，按 GFI 排序后写入 diagnostician_tasks.json"
        event: diagnosis_task
        category: enqueued
        statsField: diagnosisTasksWritten
        emittedBy:
          - "evolution-worker.ts:addDiagnosticianTask"
        fileWrite:
          - "diagnostician_tasks.json"
        notes: "evolution-worker.ts line 1400"

      - id: json_report_written
        name: "JSON 报告落地"
        description: |
          LLM（Diagnostician）完成诊断后写入 JSON 报告。
          三种结果：
          - missing_json: marker 存在但 JSON 不存在（#366，LLM 输出截断）
          - incomplete_fields: JSON 存在但缺 principle 字段（LLM 输出不完整）
          - success: JSON 存在且有 principle 字段（真正完成）
        event: diagnostician_report
        categories:
          - success
          - missing_json
          - incomplete_fields
        statsFields:
          reportsJsonWritten: "category IN (success, incomplete_fields)"
          reportsMissingJson: "category = missing_json"
          reportsIncompleteFields: "category = incomplete_fields"
        emittedBy:
          - "evolution-worker.ts:marker 检测逻辑 (line 921-1061)"
        fileWrite:
          - ".diagnostician_report_<id>.json"
        notes: "见 evolution-worker.ts line 921-1061，重试逻辑见 requeueDiagnosticianTask (line 168)"

      - id: principle_candidate
        name: "原则候选创建"
        description: "Worker 从 JSON 报告提取 principle.trigger_pattern 和 principle.action，创建 candidate"
        event: principle_candidate
        statsField: principleCandidatesCreated
        emittedBy:
          - "evolution-reducer.ts:createPrincipleFromDiagnosis (line 245)"
        fileWrite:
          - "PRINCIPLES.md"
          - "principle-tree.json"
        notes: "createPrincipleFromDiagnosis 内部：内存 → EVOLUTION_STREAM → PRINCIPLES.md → ledger → 编译"

  # ----------------------------------------------------------
  # 工作流 2：Nocturnal 夜间反射（待补充）
  # 状态：partially_surveyed
  # ----------------------------------------------------------
  nocturnal_pipeline:
    name: "Nocturnal 夜间反射"
    description: |
      触发条件：heartbeat + idle check + cooldown
      路径：Dreamer → Philosopher → Scribe → artifact → code candidate
    trigger: "heartbeat + idle + cooldown check"
    stages: []
    status: partially_surveyed
    notes: |
      - NocturnalWorkflowManager.startWorkflow() 异步触发
      - Dreamer/Philosopher/Scribe 三阶段
      - persistArtifact + maybePersistCodeCandidate 输出 artifact
      - ReplayEngine 需要手动 /pd-promote-impl eval 触发
    gaps:
      - "各 stage 无独立 event 计数（nocturnal_started/completed/failed 存在但中间 stage 没有）"
      - "code candidate 落地后无独立 event"
      - "ReplayEngine 是手动触发，没有自动化漏斗"

  # ----------------------------------------------------------
  # 工作流 3：RuleHost 实时拦截（待补充）
  # 状态：partially_surveyed
  # ----------------------------------------------------------
  rulehost_realtime:
    name: "RuleHost 实时拦截"
    description: "每次 write/bash/agent 工具调用同步触发，RuleHost 评估 active 规则"
    trigger: "每次 write/bash/agent 工具调用（同步）"
    stages: []
    status: partially_surveyed
    notes: |
      - gate.ts:handleBeforeToolCall() 同步触发
      - RuleHost.evaluate() 加载所有 lifecycleState='active' 的 code 实现
      - vm 沙箱执行 evaluate()
      - 短路：block > requireApproval > allow
    gaps:
      - "无 'RuleHost 被调用了 N 次' 的独立计数"
      - "block/allow/requireApproval 分布无独立 stats"

# ============================================================
# Event 类型全局清单
# ============================================================
# 此清单与 event-log.ts 的 recordXxx() 方法对应
# 新增 event 类型需要同时更新此清单和 event-log.ts
# ============================================================

events:

  - name: pain_signal
    type: pain_signal
    description: "Pain Signal 写入"
    categoryField: false
    emittedBy: ["pain.ts:handleAfterToolCall"]

  - name: diagnosis_task
    type: diagnosis_task
    description: "诊断任务写入 task store"
    categoryField: true
    categories: ["enqueued", "completed"]
    emittedBy: ["evolution-worker.ts:addDiagnosticianTask"]

  - name: heartbeat_diagnosis
    type: heartbeat_diagnosis
    description: "Heartbeat 注入诊断任务"
    categoryField: false
    emittedBy: ["prompt.ts:recordHeartbeatDiagnosis"]

  - name: diagnostician_report
    type: diagnostician_report
    description: "Worker 处理诊断报告"
    categoryField: true
    categories: ["success", "missing_json", "incomplete_fields"]
    emittedBy: ["evolution-worker.ts:marker 检测逻辑"]
    notes: "category 三值扩展解决 Issue #366"

  - name: principle_candidate
    type: principle_candidate
    description: "原则候选创建"
    categoryField: false
    emittedBy: ["evolution-reducer.ts:createPrincipleFromDiagnosis"]

  - name: rule_promotion
    type: rule_promotion
    description: "原则晋升 active"
    categoryField: false
    emittedBy: ["evolution-reducer.ts:promote"]

  - name: rule_enforced
    type: rule_enforced
    description: "RuleHost 评估命中"
    categoryField: false
    emittedBy: ["rule-host.ts:evaluate"]
```

---

## 实施计划（Phase 1）

### 核心思路

不新建模块，在现有 `event-log.ts` 体系上扩展。

**Phase 1 只做一件事：** 扩展 `diagnostician_report` event 的 category，解决 Issue #366（JSON 缺失/字段不完整/成功三态）。

YAML 定义文件的加载机制、漏斗推导逻辑，作为 Phase 2 迭代实施。

### Phase 1 改动范围

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/types/event-types.ts` | `DiagnosticianReportEventData.category` 从 `boolean` 改为三值 | Issue #366 修复 |
| `src/core/event-log.ts` | `aggregateEventsIntoStats` 新增 `reportsMissingJson++`、`reportsIncompleteFields++` | 统计扩展 |
| `src/service/evolution-worker.ts` | marker 检测逻辑（line 921-1061）写入正确的 category 值 | 三态记录 |
| `src/service/runtime-summary-service.ts` | `heartbeatDiagnosis` 字段扩展（见下） | 漏斗展示 |

**漏斗展示字段（runtime-summary-service.ts）：**

```typescript
heartbeatDiagnosis: {
  pendingTasks: number;
  tasksWrittenToday: number;       // diagnosisTasksWritten
  reportsWrittenToday: number;     // 从 diagnosticianReportsWritten 改名，更准确
  reportsMissingJsonToday: number; // 新增：category=missing_json 的次数
  reportsIncompleteFieldsToday: number; // 新增：category=incomplete_fields 的次数
  candidatesCreatedToday: number;   // principleCandidatesCreated
  heartbeatsInjectedToday: number;
}
```

### Phase 2（后续迭代）

- YAML 文件加载逻辑
- 漏斗自动推导机制
- Nocturnal/RuleHost 漏斗补充

---

## 验证方法

1. 手动触发 pain signal（必定失败的 write 操作）
2. 观察 `daily-stats.json` 中各漏斗级计数是否递增
3. 让 JSON 报告缺失，观察 `reportsMissingJson` 是否 +1
4. 运行 `pd-status`，确认漏斗各级数字可见

---

## 设计决策记录

| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-04-18 | 用 YAML 作为工作流定义的单一真相来源 | 工作流会变、调研会出错，硬编码的漏斗定义会成为下一个技术债 |
| 2026-04-18 | event-log 只做原始记录，漏斗由 YAML + event 数据推导 | 代码和漏斗定义解耦，两边都可以独立修正 |
| 2026-04-18 | Phase 1 先做 Issue #366 修复，YAML 加载机制后续迭代 | Issue #366 是当前最紧迫的断点，需要先止血 |
