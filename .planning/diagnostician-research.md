# Diagnostician (pain_diagnosis) Implementation Flow - Technical Research

## Overview

The Diagnostician is a specialized subagent that performs root-cause analysis on pain signals (tool failures, user frustration) using a 4-phase protocol (Evidence → Causal Chain → Classification → Principle Extraction). It is distinct from the Empathy Observer and DeepReflect workflows — both of which are helper workflows managed by `WorkflowManager` implementations, whereas the Diagnostician is a pain-driven queued task with its own HEARTBEAT-based lifecycle.

---

## 1. The Complete Diagnostician Lifecycle

### Phase 0: Pain Signal Detection & Flag Creation

**Trigger Sources:**
- **Subagent error** (`subagent.ts` lines 263-285): When a subagent session ends with `outcome === 'error'`, a pain flag is written via `writePainFlag()` and an evolution event `pain_detected` is emitted via `wctx.evolutionReducer.emitSync()`.
- **Tool failure** (handled via pain hook): Pain flags are written to `.state/.pain_flag` (or `.state/.pain_flag`) in the workspace's state directory.
- **Human Intervention** (user frustration): Detected by the Empathy Observer (separate workflow).

**Pain Flag Format:**
```
source: subagent_error|tool_failure|Human Intervention
score: <number>
time: <ISO timestamp>
reason: <description>
is_risky: true|false
session_id: <session ID>
agent_id: <agent ID>
```

**Key File:** `/home/csuzngjh/code/principles/packages/openclaw-plugin/src/core/pain.ts`
```typescript
export function writePainFlag(projectDir: string, painData: Record<string, string>): void {
  const painFlagPath = resolvePdPath(projectDir, 'PAIN_FLAG');
  // Writes serialized key-value lines to .state/.pain_flag
}
```

---

### Phase 1: Pain Flag Check (Evolution Worker Heartbeat)

The **evolution-worker.ts** runs a periodic heartbeat (every 15 minutes by default, or immediately when pain is enqueued). In each cycle:

**File:** `/home/csuzngjh/code/principles/packages/openclaw-plugin/src/service/evolution-worker.ts`

**Step 1: `checkPainFlag()` (lines 481-600)**
- Reads `.state/.pain_flag` 
- Parses pain data (supports both JSON and key-value line formats)
- If a pain flag exists with `status !== 'queued'`, calls `doEnqueuePainTask()`

**Step 2: `doEnqueuePainTask()` (lines 439-479)**
- Acquires queue lock on `.state/evolution_queue.json`
- Creates a new `EvolutionQueueItem` with:
  - `taskKind: 'pain_diagnosis'`
  - `id: pain_${timestamp}_${random}` 
  - `source`: from pain flag
  - `reason`: from pain flag
  - `score`: from pain flag (1-100)
  - `trigger_text_preview`: error message snippet
  - `status: 'pending'`
  - `priority`: derived from score (high ≥70, medium ≥40, low <40)
  - `traceId`, `sessionId`, `agentId`: extracted from pain flag
- Appends to queue file and marks pain flag as `status: queued, task_id: <id>`

---

### Phase 2: Task Selection & HEARTBEAT.md Preparation

**File:** `/home/csuzngjh/code/principles/packages/openclaw-plugin/src/service/evolution-worker.ts`, lines 842-950

When a `pain_diagnosis` task is `pending`:

1. **Select highest-priority task** (lines 851-856):
   - Sorted by `score` descending, then by `priorityWeight` (high=3, medium=2, low=1)

2. **Prepare HEARTBEAT.md content** (lines 880-908):
   ```
   ## Evolution Task [ID: <taskId>]
   
   **Pain Score**: <score>
   **Source**: <source>
   **Reason**: <reason>
   **Trigger**: "<trigger_text_preview>"
   **Queued At**: <enqueued_at>
   **Session ID**: <session_id>
   **Agent ID**: <agent_id>
   
   ---
   
   ## Diagnostician Protocol
   
   You MUST use the **pd-diagnostician** skill for this task.
   Read the full skill definition and follow the 4-phase protocol (Evidence → Causal Chain → Classification → Principle Extraction) EXACTLY as specified.
   
   After completing the analysis:
   1. Write your JSON diagnosis report to: .diagnostician_report_<taskId>.json
   2. Mark the task complete by creating a marker file: .evolution_complete_<taskId>
   3. Replace this HEARTBEAT.md content with "HEARTBEAT_OK"
   ```

3. **Write HEARTBEAT.md** (line 913):
   - Writes to `HEARTBEAT.md` in workspace root
   - Only after successful write, marks task as `in_progress` with `assigned_session_key = heartbeat:diagnostician:<taskId>`

4. **Trigger immediate heartbeat** (lines 1404+):
   - If pain was newly enqueued and `api.runtime.system.runHeartbeatOnce` is available, triggers an immediate heartbeat cycle to start the diagnostician without waiting for the next 15-minute interval.

---

### Phase 3: Diagnostician Execution (via subagent session spawn)

**Two paths exist for diagnostician execution:**

#### Path A: Real-time injection via `prompt.ts` (lines 508-622)

When a user/observer session runs and the evolution queue has `in_progress` tasks:

1. `prompt.ts` reads the queue and finds `pain_diagnosis` tasks with `status === 'in_progress'`
2. Calls `resolveEvolutionTask()` to enrich the task with conversation context
3. Injects a `<evolution_task>` directive into `prependContext`
4. The main agent reads HEARTBEAT.md and sees the task
5. The agent calls `sessions_spawn(task="使用 pd-diagnostician skill 执行诊断任务...")`
6. A new subagent session starts with the `pd-diagnostician` skill

**Key File:** `/home/csuzngjh/code/principles/packages/openclaw-plugin/src/hooks/prompt.ts`, line 555:
```typescript
const spawnTask = `使用 pd-diagnostician skill 执行诊断任务。\n\n任务: ${escapedTask}${existingPrinciplesRef}`;
```

#### Path B: Background heartbeat via HEARTBEAT.md (evolution-worker.ts)

If no user session runs but the workspace is idle:
- The evolution worker writes HEARTBEAT.md with the diagnostician task
- A background heartbeat session reads HEARTBEAT.md and executes the task
- This is handled by the OpenClaw heartbeat mechanism (external to this plugin)

---

### Phase 4: The pd-diagnostician Skill

**Skill Definition:** `/home/csuzngjh/code/principles/packages/openclaw-plugin/templates/langs/zh/skills/pd-diagnostician/SKILL.md`

The skill defines a **4-phase protocol**:

| Phase | Name | Description |
|-------|------|-------------|
| 0 | Context Extraction | Optionally reads session JSONL for conversation context |
| 1 | Evidence Gathering | Reads `.state/.pain_flag`, `.state/logs/events.jsonl`, searches code |
| 2 | Causal Chain (5 Whys) | Builds Why-1 through Why-5 with evidence for each |
| 3 | Root Cause Classification | Classifies as People/Design/Assumption/Tooling |
| 4 | Principle Extraction | Extracts abstract principle with `trigger_pattern`, `action`, `abstracted_principle` |

**Output contract (JSON):**
```json
{
  "diagnosis_report": {
    "task_id": "pain-xxx",
    "summary": "One-line root cause",
    "causal_chain": [
      { "why": 1, "answer": "...", "evidence": "file:line" }
    ],
    "root_cause": {
      "category": "Design|People|Assumption|Tooling",
      "description": "..."
    },
    "principle": {
      "trigger_pattern": "regex or keywords",
      "action": "what to do differently",
      "abstracted_principle": "ONE sentence, max 40 chars"
    }
  }
}
```

**Skill execution constraint:**
```
disable-model-invocation: true
```
This means the skill cannot recursively spawn other subagents.

---

### Phase 5: Result Capture & Principle Creation

**Two completion paths:**

#### Completion Path A: Real-time (subagent.ts)

When a diagnostician subagent session completes (`outcome === 'ok'` or `'deleted'`):

**File:** `/home/csuzngjh/code/principles/packages/openclaw-plugin/src/hooks/subagent.ts`, lines 300-527

1. `handleSubagentEnded()` is called
2. **Session matching** (lines 326-360):
   - Finds `pain_diagnosis` task where `assigned_session_key` matches or `heartbeat:diagnostician:{taskId}` pattern
   - Supports backward compatibility: matches tasks with no `assigned_session_key` within 30 minutes
3. **Report parsing** (lines 409-526):
   - Gets session messages via `ctx.api.runtime.subagent.getSessionMessages()`
   - Extracts assistant text
   - Calls `parseDiagnosticianReport()` to find JSON in markdown code blocks
   - Supports multiple nesting paths: `principle`, `phases.principle_extraction.principle`, `diagnosis_report.principle`
   - **Fallback**: If no JSON found, calls `extractPrincipleFromRawText()` with regex patterns
4. **Principle creation** (lines 486-495):
   ```typescript
   const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
     painId: matchedTask?.id || completedTaskId,
     painType: 'tool_failure',
     triggerPattern,
     action,
     source: matchedTask?.source || 'diagnostician',
     evaluability,
     detectorMetadata,
     abstractedPrinciple: report.principle.abstracted_principle,
   });
   ```
5. **Pain flag cleanup** (line 390): Removes the pain flag if no remaining active tasks

#### Completion Path B: HEARTBEAT timeout (evolution-worker.ts)

**File:** `/home/csuzngjh/code/principles/packages/openclaw-plugin/src/service/evolution-worker.ts`, lines 701-840

When checking in-progress `pain_diagnosis` tasks:

1. **Check for marker file** `.evolution_complete_<taskId>` (line 706):
   - If exists: parses `.diagnostician_report_<taskId>.json`, calls `createPrincipleFromDiagnosis()`, marks task complete
2. **Check for timeout** (line 776):
   - Default timeout: 30 minutes (configurable)
   - If timed out AND marker exists: creates principle from late report
   - If timed out AND no marker: marks `auto_completed_timeout`

**Result file locations:**
- Report: `.state/.diagnostician_report_<taskId>.json`
- Marker: `.state/.evolution_complete_<taskId>` (contains `diagnostic_completed: <timestamp>\noutcome: <summary>`)

---

## 2. Key Files and Their Roles

| File | Role |
|------|------|
| `packages/openclaw-plugin/src/service/evolution-worker.ts` | Periodic heartbeat worker; owns queue processing, HEARTBEAT.md writing, timeout detection |
| `packages/openclaw-plugin/src/core/pain.ts` | Pain flag read/write utilities |
| `packages/openclaw-plugin/src/core/evolution-reducer.ts` | Event sourcing for evolution loop; `createPrincipleFromDiagnosis()` implementation |
| `packages/openclaw-plugin/src/hooks/prompt.ts` | Real-time evolution task injection into user/observer sessions; `sessions_spawn` directive |
| `packages/openclaw-plugin/src/hooks/subagent.ts` | Subagent lifecycle handler; diagnostician session completion, principle creation |
| `packages/openclaw-plugin/src/constants/diagnostician.ts` | Protocol summary constants for HEARTBEAT injection |
| `packages/openclaw-plugin/templates/langs/zh/skills/pd-diagnostician/SKILL.md` | Full skill definition with 4-phase protocol |
| `packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` | Empathy Observer workflow manager (separate from diagnostician) |
| `packages/openclaw-plugin/src/service/subagent-workflow/deep-reflect-workflow-manager.ts` | DeepReflect workflow manager (separate from diagnostician) |

---

## 3. Communication APIs & Interfaces

### EvolutionQueueItem Schema
```typescript
interface EvolutionQueueItem {
  id: string;
  taskKind: 'pain_diagnosis' | 'sleep_reflection' | 'model_eval';
  priority: 'high' | 'medium' | 'low';
  source: string;
  score: number;
  reason: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  assigned_session_key?: string;  // set when in_progress
  trigger_text_preview?: string;
  session_id?: string;
  agent_id?: string;
  traceId?: string;
  retryCount?: number;
  maxRetries?: number;
  resultRef?: string;
}
```

### `createPrincipleFromDiagnosis()` Interface
```typescript
interface CreatePrincipleFromDiagnosisParams {
  painId: string;
  painType: 'user_frustration' | 'tool_failure';
  triggerPattern: string;
  action: string;
  source: string;
  evaluability: 'deterministic' | 'weak_heuristic' | 'manual_only';
  abstractedPrinciple?: string;
  detectorMetadata?: {
    applicabilityTags?: string[];
    positiveSignals?: string[];
    negativeSignals?: string[];
    toolSequenceHints?: string[][];
    confidence?: 'high' | 'medium' | 'low';
  };
}
```

### Pain Flag Format
Key-value lines format written to `.state/.pain_flag`:
```
source: tool_failure
score: 65
time: 2026-04-05T...
reason: Tool edit failed on MEMORY.md
is_risky: true
session_id: ...
agent_id: main
status: queued
task_id: pain_xxx
```

---

## 4. Empathy/DeepReflect vs. Diagnostician

| Aspect | Empathy Observer | DeepReflect | Diagnostician |
|--------|-----------------|-------------|---------------|
| **Trigger** | User message analysis (async) | Manual/periodic trigger | Pain flag in evolution queue |
| **Workflow Manager** | `EmpathyObserverWorkflowManager` | `DeepReflectWorkflowManager` | None (queue-based) |
| **Transport** | `runtime_direct` | `runtime_direct` | `sessions_spawn` |
| **Completion** | Workflow store + manager lifecycle | Workflow store + manager lifecycle | HEARTBEAT marker OR subagent session match |
| **Result** | Friction tracks, session analysis | Artifact persisted | Principle created via `createPrincipleFromDiagnosis()` |
| **HEARTBEAT** | No | No | Yes (HEARTBEAT.md used) |
| **Prompt Injection** | No | No | Yes (via `prompt.ts`) |
| **Skill** | `empathy-observer` skill | `reflection` skill | `pd-diagnostician` skill |

**Key structural difference:** Empathy and DeepReflect are helper workflows managed by `WorkflowManager` implementations with explicit lifecycle (start, wait, finalize). They use `RuntimeDirectDriver` to spawn subagents directly. The Diagnostician is a queued task that uses the main agent as the executor via `sessions_spawn` + HEARTBEAT.md + `pd-diagnostician` skill.

---

## 5. What Would Break if "Helper-ized"

If one tried to convert the Diagnostician to a helper workflow (like Empathy/DeepReflect), the following would break:

### 1. **HEARTBEAT.md Contract**
The HEARTBEAT.md file is a contract between `evolution-worker.ts` and the diagnostician agent:
- Worker writes task context to HEARTBEAT.md
- Worker checks for `.evolution_complete_<taskId>` marker file
- Worker reads `.diagnostician_report_<taskId>.json`

If converted to a workflow, this file-based signaling mechanism would be replaced by workflow store events, breaking the existing heartbeat completion detection in `evolution-worker.ts` (lines 701-840).

### 2. **Prompt Injection Path**
`prompt.ts` (lines 508-622) specifically handles `pain_diagnosis` task injection with two-phase reply instructions:
```
**阶段 1 - 立即回复用户:** ... sessions_spawn(task=...)
**阶段 2 - 收到子代理结果后:** ...
```
This would need to be replicated in a workflow manager or the prompt injection logic would need significant changes.

### 3. **Dual Completion Paths**
The diagnostician has **two independent completion paths**:
- **Path A**: `subagent_ended` hook in `subagent.ts` (lines 300-527) — matches session to task, parses report, creates principle
- **Path B**: `evolution-worker.ts` timeout/marker detection (lines 701-840)

Both call `createPrincipleFromDiagnosis()` but through completely different mechanisms. A helper workflow would consolidate this into one path (via `notifyLifecycleEvent` → `finalizeOnce`), but the existing Path B in evolution-worker would become orphaned.

### 4. **Queue-based Priority Scheduling**
The evolution queue supports heterogeneous task kinds (`pain_diagnosis`, `sleep_reflection`, `model_eval`) with priority and score-based scheduling. Empathy/DeepReflect workflows are single-purpose spawned on demand. Converting diagnostician to a workflow would lose the queue-based scheduling semantics.

### 5. **Backward Compatibility**
The current code has extensive backward compatibility for session matching (lines 348-356 in `subagent.ts`):
- Legacy: tasks with no `assigned_session_key` within 30 minutes
- HEARTBEAT placeholder: `heartbeat:diagnostician:{taskId}`
A helper workflow would replace this with a new workflow_id → task mapping in the workflow store, but the old queue entries would not be migratable.

### 6. **Pain Flag → Queue → HEARTBEAT → Session → Report → Principle Chain**
The current chain is:
```
Pain Flag → Evolution Queue → HEARTBEAT.md → sessions_spawn → pd-diagnostician 
         → .diagnostician_report_<id>.json → .evolution_complete_<id>.json 
         → createPrincipleFromDiagnosis()
```

A helper workflow would insert `startWorkflow()` and `notifyLifecycleEvent()` into this chain, but:
- The evolution worker would no longer own the completion detection
- The timeout logic in evolution-worker (lines 776-839) would be redundant
- The pain flag → queue → HEARTBEAT flow would need to be replaced by a workflow spawning mechanism

### 7. **The `disable-model-invocation: true` Constraint**
The pd-diagnostician skill has this constraint, meaning it cannot spawn subagents. This is intentional — the diagnostician is meant to be the leaf node of the analysis chain. If converted to a helper workflow, this constraint would need removal, potentially allowing recursive diagnostician spawning.

---

## 6. Summary

The Diagnostician is a **queue-based, HEARTBEAT-driven, file-signaled** system that is fundamentally different from the **workflow-store-driven, RuntimeDirectDriver-based** Empathy and DeepReflect helpers. The key differences are:

1. **Ownership**: Diagnostician completion is owned by both `subagent.ts` (real-time path) and `evolution-worker.ts` (heartbeat path). Empathy/DeepReflect completion is owned by their respective `WorkflowManager` instances.

2. **Signal mechanism**: Diagnostician uses file-based signaling (`.evolution_complete_<id>`, `.diagnostician_report_<id>.json`, `HEARTBEAT.md`). Empathy/DeepReflect use workflow store + `notifyLifecycleEvent()` + `finalizeOnce()`.

3. **Scheduling**: Diagnostician tasks go through a priority queue with timeout handling. Empathy/DeepReflect are immediate, on-demand spawns.

4. **Prompt integration**: Diagnostician tasks inject into user prompts via `prompt.ts` (two-phase reply pattern). Empathy/DeepReflect run as silent async sidecars.

"Helper-izing" the Diagnostician would require rewriting the completion detection in `evolution-worker.ts`, the prompt injection logic in `prompt.ts`, and the dual-path principle creation in both `evolution-worker.ts` and `subagent.ts`. It is a non-trivial change that would need careful migration planning for existing queued tasks and backward compatibility with the file-based signaling contracts.
