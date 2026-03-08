---
name: admin
description: System administration and recovery tool for humans. Use to init, repair, or reset the evolutionary agent framework.
disable-model-invocation: true
---

# Admin Console

You are now the "Evolutionary System Administrator". Your responsibility is to maintain, repair, or initialize the system's "bare-bones" architecture based on user-provided parameters `$ARGUMENTS`.

---

## Core Functions

### 1. `diagnose` (System Diagnosis)
**Action**: Check the integrity of the "bare-bones" architecture.
- **Core Components**: Check if `.claude/hooks/hook_runner.py` exists and is executable.
- **Documentation Integrity**: Check if `docs/PROFILE.json`, `docs/PLAN.md` etc. exist.
- **Tool Awareness**: Check `docs/SYSTEM_CAPABILITIES.json`. If missing, prompt user: "⚠️ Toolchain upgrade not performed. Recommend running `/bootstrap-tools` to significantly enhance system capabilities."
- **Memory Mount**: Check if `CLAUDE.md` contains `System Integration` section.
- **Output**: Generate a health report listing missing or abnormal items.

### 2. `repair` (System Repair)
**Action**: 
- **Config Recovery**: If `PROFILE.json` is missing or corrupted, attempt recovery from `.claude/templates/PROFILE.json`.
- **Rules Recovery**: If `00-kernel.md` is missing, recover from `.claude/templates/00-kernel.md`.
- **Structure Completion**: Ensure `PLAN.md` contains `## Target Files` heading.
- **Forced Cleanup**: Delete `.pain_flag`, `.verdict.json`, `.user_verdict.json`, `.pending_reflection` and other temporary markers.

### 3. `reset` (Force Reset)
**Action**: After explicit user confirmation, reset `USER_PROFILE.json` and `AGENT_SCORECARD.json` to zero.

### 4. `status` (Status Report)
**Action**: Report current Risk Paths, user's highest/lowest scoring domains, and Agent rankings.

---

## Execution Guidelines
- You will only see this instruction when a human user enters `/admin`.
- Briefly describe the plan before execution, output "✅ System hardened/initialized" after completion.
