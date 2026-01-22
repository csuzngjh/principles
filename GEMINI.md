# Principles & Evolutionary Agent Framework

## Project Overview
This repository contains the configuration, rules, and scripts for an "Evolutionary Programming Agent" framework. The system is designed to create a stable, self-correcting development loop that learns from mistakes ("Pain Signals") by converting them into permanent rules and guardrails.

**Core Philosophy:**
- **Evolution:** Negative feedback (Pain) -> Issue Log -> Principle -> Guardrail (Rule/Hook/Test).
- **Anti-Sycophancy:** Hard constraints and audits override user requests if they violate safety or principles.
- **Deductive Audit:** Rigorous checks must be performed before execution.
- **Credibility Weighted:** Decisions are influenced by the historical reliability of the user and sub-agents.

## Key Components

### 1. Rules (`.claude/rules/`)
Defines the agent's behavior and constraints.
- **`00-kernel.md`**: The invariant core logic (Goal → Problem → Diagnosis → Audit → Plan → Execute → Review → Log).
- **`10-guardrails.md`**: Runtime restrictions derived from principles.

### 2. Skills (`.claude/skills/`)
Specialized capabilities invokable by the agent.
- **`/evolve-task`**: The main entry point enforcing the rigid Triage → Plan → Execute loop.
- **`/triage`**: Initial problem definition.
- **`/root-cause`**: Deep dive analysis (5 Whys, Proximal/Root causes).
- **`/deductive-audit`**: Pre-plan verification (Axiom, System, Via Negativa tests).
- **`/plan-script`**: Generates step-by-step execution plans.

### 3. Hooks (`.claude/hooks/`)
Shell scripts triggered by agent actions (tool use, session events) to enforce safety.
- **`pre_write_gate.sh`**: Prevents writes to configured `risk_paths` without a valid `docs/PLAN.md` and a passing `docs/AUDIT.md`.
- **`post_write_checks.sh`**: Automatically runs tests after changes.
- **`stop_evolution_update.sh`**: Updates profiles and logs issues upon session end.

### 4. Documentation & Memory (`docs/`)
- **`PRINCIPLES.md`**: The source of truth for all engineering principles.
- **`ISSUE_LOG.md`**: Record of all "Pain Signals" and their root causes.
- **`PROFILE.json`**: Runtime configuration (risk paths, audit levels, permissions).
- **`USER_PROFILE.json`** & **`AGENT_SCORECARD.json`**: Tracks credibility scores for the user and sub-agents.
- **`PLAN.md`** & **`AUDIT.md`**: Marker files used by the gate hooks to track state.

## Usage & Workflows

### Standard Workflow
1.  **Start Task:** Agent receives a complex request.
2.  **Triage & Plan:** Agent uses `/evolve-task` or manually invokes `/triage` -> `/root-cause` -> `/deductive-audit`.
3.  **Gate Check:** Before modifying code in risky areas (e.g., `src/server/`, `infra/`), the `pre_write_gate.sh` hook checks for:
    - Existence of `docs/PLAN.md` (Status: READY).
    - `docs/AUDIT.md` with `RESULT: PASS`.
4.  **Execute:** Agent modifies code using `Write` or `Edit` tools.
5.  **Verify:** `post_write_checks.sh` runs configured tests immediately after writing.
6.  **Reflect:** If failure occurs, it is logged as a "Pain Signal" in `docs/ISSUE_LOG.md` via `stop_evolution_update.sh`.

### Running Tests
To verify the integrity of the hooks and gate logic:

```bash
# Run the hook unit tests
bash tests/test_hooks.sh

# Debug the gate manually (simulates a tool call)
bash debug_gate.sh
```

## Configuration

### `docs/PROFILE.json`
Controls the behavior of the safety gates.
```json
{
  "risk_paths": ["src/server/", "infra/", "db/"],
  "gate": {
    "require_plan_for_risk_paths": true,
    "require_audit_before_write": true
  }
}
```

## Principles Format
When adding new principles to `docs/PRINCIPLES.md`, strictly follow this format:
```markdown
### P-XX: <One-line principle>
- Trigger: <When to trigger>
- Constraint (Must/Forbidden): <What must/must not happen>
- Verification: <How to verify>
- Exceptions: <Exceptions>
- Source: <Issue Log #XX / Date / Reference>
```
