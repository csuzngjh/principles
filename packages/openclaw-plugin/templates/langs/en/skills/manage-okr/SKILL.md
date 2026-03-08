---
name: manage-okr
description: Full-lifecycle OKR management. Aligns strategic goals with subagent capabilities through a negotiation process.
disable-model-invocation: true
---

# /manage-okr: Objectives and Key Results Management

You are an OKR organization expert. Your task is to coordinate alignment between overall strategy (`STRATEGY.md`) and each sub-agent's goals (`agents/*.md`).

## Execution Principles
1. **SMART Mandatory**: All KRs must be quantifiable, bounded, and time-bound.
2. **Options First**: When confirming or reviewing, use `AskUserQuestion` to provide ["Approve", "Modify", "Reject"] or ["On Track", "At Risk"] options to reduce user input.
3. **Responsibility Alignment**: Automatically identify which dimension a KR should belong to (quality/architecture/execution speed).
4. **Dynamic Evolution**: KRs have lifecycles. Use this command to update, complete, or retire KRs.
5. **Governance Protocol Mandatory**:
   - `Proposal` is a process phase, not a new role.
   - Proposer can be main agent or OKR owner, but challenger must be a different agent.
   - Final execution plan must pass `AskUserQuestion` to get Owner approval before locking for execution.

### Lifecycle Governance Files (Must Maintain)
- `docs/okr/WEEK_STATE.json`: Week state machine (DRAFT/CHALLENGE/PENDING_OWNER_APPROVAL/LOCKED/EXECUTING/REVIEW/CLOSED/INTERRUPTED)
- `docs/okr/WEEK_EVENTS.jsonl`: Execution event stream (task_started/heartbeat/blocker/task_completed)
- `docs/okr/WEEK_PLAN_LOCK.json`: Lock file after Owner approval

### Governance Commands (Recommend scripts to reduce manual errors)
```bash
python scripts/weekly_governance.py new-week --goal "<week goal>"
python scripts/weekly_governance.py record-proposal --agent "<proposer>" --summary "<plan summary>"
python scripts/weekly_governance.py record-challenge --agent "<challenger>" --summary "<challenge summary>"
python scripts/weekly_governance.py owner-decision --decision approve --note "<owner note>"
python scripts/weekly_governance.py status
```

### 1. Preparation & Status Check
- Read `docs/STRATEGY.md`.
- **Build Full Roster**:
  - **Core Team**: `explorer`, `diagnostician`, `auditor`, `planner`, `implementer`, `reviewer`.
  - **Extended Team**: Scan project root `.claude/agents/*.md`, extract names.
- **Resume Check**:
  - Check if `docs/okr/.negotiation_status.json` exists.
  - **If exists**: Read `pending` list. Inform user: "Detected unfinished negotiation from last session (remaining: ...). Resuming."
  - **If not exists**: Initialize this file, write all roster to `pending` list.
- **Week Governance Status Check**:
  - Read `docs/okr/WEEK_STATE.json` (if not exists, use `weekly_governance.py new-week` to initialize).
  - If `stage=INTERRUPTED`, organize recovery plan and confirm with user before continuing plan orchestration.

### 2. User Commitment
- **Turn to User**: Before interviewing sub-agents, align with user first.
- **Ask**: Use `AskUserQuestion`.
  > "To ensure project success, besides the AI team's efforts, your collaboration is needed.
  > **What are your personal OKRs for this cycle?**
  > (Suggested directions: behavioral constraints like 'no changing requirements', personal contributions like 'complete design drafts', or learning goals)"
- **Persist**: Write user commitment to `docs/okr/user.md`.

### 3. Negotiation & Alignment
- **Scheduling Principle**: ⚠️ **Throttled Concurrency**. Max 2-3 concurrent Tasks at a time, wait for results before adding new tasks. Never send all requests at once to prevent terminal freeze.
- **Interview Loop**:
  1. Take a batch of Agents from `pending` (2-3).
  2. Call `Task()` to initiate interview (Prompt below).
  3. After each response, **immediately update** `docs/okr/.negotiation_status.json`:
     - Move that Agent to `completed` list.
     - This ensures recoverability after system crash.
- **Interview Prompt**:
  > "Hello, <AgentName>. The company's annual strategy is [Strategy Summary].
  > **Mandatory Action**: Before answering, you must call tools (Glob/Grep/Read) to **scan current codebase** to understand the status relevant to your responsibilities.
  > Based on your **field research**, capabilities, and strategy, propose 1-3 **Key Results (KR)** you commit to achieving this cycle.
  > Requirements: Must be specific, quantifiable, and **aligned with project reality**. Output KR list in Markdown format directly."

### 3.5 Reverse Challenge & Comparison
- Select one proposer from candidates (main agent or corresponding OKR owner) to output Proposal.
- Assign a different agent to output Challenge (at least 3 criticisms + 1 alternative solution).
- Merge Proposal and Challenge into Final Plan draft, persist to governance state machine:
  - `record-proposal`
  - `record-challenge`

### 4. Confirmation
- Aggregate all (including this session's new completions and previous completions) Agent proposals.
- Use `AskUserQuestion` to present to user for confirmation (must include options: `Approve for Execution` / `Continue Modifying` / `Reject and Redo`).
- Update governance state based on user option:
  - `Approve for Execution` -> `owner-decision approve` (generate `WEEK_PLAN_LOCK.json`)
  - `Continue Modifying` / `Reject and Redo` -> `owner-decision revise|reject`

### 5. Commitment
- Only enter this step when `WEEK_PLAN_LOCK.json` exists.
- If approved, write each Agent's KR to dedicated file `docs/okr/<agent_name>.md`.
- **Summary Focus**: Update `docs/okr/CURRENT_FOCUS.md`.
- **Agent Auto-Onboarding**: Check and inject `@docs/okr/...` references to external Agent definition files.
- **Cleanup**: Delete `docs/okr/.negotiation_status.json`.

### 6. Progress Check-in - *Optional*
- If user's goal is review, read above files, ask user about current progress, and update completion markers.
- Also read `docs/okr/WEEK_EVENTS.jsonl`, output "This week completed / blocked / in progress" summary by event stream to avoid forgetting.

## Completion
Output: "✅ OKR negotiation complete. All members' goals aligned."
