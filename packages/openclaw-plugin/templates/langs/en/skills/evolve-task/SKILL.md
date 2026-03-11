---
name: evolve-task
description: Run the full evolution loop (triage → diagnosis → audit → plan → execute → review → log)
disable-model-invocation: true
---

You must execute the following steps in order (no skipping). ARGUMENTS: $ARGUMENTS

## Step 0: Restore Context (Mandatory)
- Read the last entry in memory/CHECKPOINT.md
- Read the last 3 entries in memory/ISSUE_LOG.md
- Read recent decisions in memory/DECISIONS.md
- If .state/.pain_flag exists, handle breakpoint recovery first

## Step 1: Read Runtime Parameters & Self-Check
- Read .principles/PROFILE.json, understand risk_paths, gate, tests.commands.
- **Capability Self-Check**: Quickly scan `skills/` and `agents/` under plugin directory. If there's a specialized Skill (like `/deep-search`) or Agent (like `security-expert`) for the current task, prioritize using them in subsequent steps.

## Step 1.5: Full-Spectrum Awareness
- **Local**: Run `git status` and `git log -n 5` to understand code status.
- **Remote**: If `gh` is available, must run `gh issue list --limit 5` and `gh pr list --limit 5`.
- **Correlation**: If related Issues found, must record their IDs in current task context.

## Step 2: TRIAGE (Fill Information Gaps)
- **Map First**: Must read architecture diagrams under `codemaps/` or `docs/SYSTEM_PANORAMA.md` to accurately assess modification risk.
Output:
- Goal (one sentence)
- Problem (reproducible description)
- Evidence (files/commands/logs)
- Risk level (low/medium/high)

## Step 3: Delegate Explorer (Evidence Collection)
- Let Explorer sub-agent output: Evidence list / Repro / Hypotheses(<=3)
- **Performance Evaluation**: After task completion, evaluate Explorer performance and write to `.state/.verdict.json`. Format must strictly follow `@.principles/schemas/agent_verdict_schema.json`.

## Step 4: Delegate Diagnostician (Root Cause)
- Let Diagnostician output: Proximal cause / Root cause / 5 Whys / Category
- **Performance Evaluation**: After task completion, write to `.state/.verdict.json`. Format follows `@.principles/schemas/agent_verdict_schema.json`.

## Step 5: Delegate Auditor (Deductive Audit)
- Let Auditor output: Axiom/System/Via negativa / RESULT: PASS/FAIL
- Write audit result to AUDIT.md (RESULT line must exist).
- **Performance Evaluation**: After task completion, write to `.state/.verdict.json`. Format follows `@.principles/schemas/agent_verdict_schema.json`.

### Branch Handling (Must Follow)
- If RESULT = FAIL:
  1. Write Must-fix list to AUDIT.md
  2. Go back to Step 4 to re-delegate Diagnostician, request supplemental root cause
  3. Max 2 retries; if still FAIL, write to memory/DECISIONS.md and request user intervention
- If RESULT = PASS: Continue to Step 6

## Step 6: Delegate Planner (Movie Script Plan)
- Planner outputs Plan (steps/commands/metrics/rollback).
- Write plan to PLAN.md (STATUS line must exist).
- **Task Sync**: 
  - If `CLAUDE_CODE_TASK_LIST_ID` is set, you must convert the Plan's core steps to Native Tasks (via natural language command "Add task..." or related tools).
  - If not set and in interactive mode, prompt user: "Recommend running `export CLAUDE_CODE_TASK_LIST_ID=task-$(date +%s)` to enable persistent task tracking."
  - If in background/headless mode, skip prompt.
- **Performance Evaluation**: After task completion, write to `.state/.verdict.json`. Format follows `@.principles/schemas/agent_verdict_schema.json`.

## Step 7: Delegate Implementer (Execution)
- Implementer can only execute according to PLAN. Any deviation must first update PLAN.
- **Performance Evaluation**: After task completion, write to `.state/.verdict.json` based on verification results. Format follows `@.principles/schemas/agent_verdict_schema.json`.

## Step 8: Delegate Reviewer (Review)
- Reviewer outputs: Critical/Warning/Suggestion.
- **Performance Evaluation**: After task completion, write to `.state/.verdict.json`. Format follows `@.principles/schemas/agent_verdict_schema.json`.

### Branch Handling
- If Critical exists: Go back to Step 6 to revise plan, max 2 retries
- If no Critical: Continue to Step 9

## Step 9: Reflection & Persistence
1. **System Evolution**: Append Pain/Root cause/New principle candidates/Gate suggestions to memory/ISSUE_LOG.md, and update memory/DECISIONS.md.
2. **User Profile Update (Mandatory)**:
   - Review user's performance in this task (instruction quality, domain knowledge, preferences) and system highlights.
   - **Must** write to `.state/.user_verdict.json` (incremental update). Format must strictly follow `@.principles/schemas/user_verdict_schema.json`.
   - Note: If user shows no obvious characteristics or preferences, corresponding fields can be empty.

## Step 10: Final Briefing
- **Action**: Delegate ``sessions_spawn(reporter)`` for closing statement.
- **Requirement**: Pass Implementer and Reviewer's final outputs as input. Let it decide report depth and style based on `USER_CONTEXT.md`.
- **Goal**: Ensure the boss (user) clearly understands task outcomes and potential risks without cognitive load.
