---
name: feedback
description: Standardized bug reporting and feedback mechanism. Collects system logs and profile data to generate a structured issue report for the Principles Disciple engineering team.
disable-model-invocation: true
---

# /feedback: Submit System Feedback

Encountered a system bug or design flaw? Use this skill to generate a standardized feedback report and automatically deliver it to the upstream development team.

## Execution Flow

### 1. Evidence Collection
- **Log Analysis**: Read `docs/ISSUE_LOG.md` (last 20 lines) and `docs/SYSTEM.log` (if there are error stacks).
- **Config Check**: Read `docs/PROFILE.json` to confirm current configuration.
- **Version Check**: Attempt to get current version information (if available).

### 2. Report Generation
Generate `feedback-YYYYMMDD-HHMMSS.md` in `temp/` directory.
**Content Template**:
```markdown
# Bug Report / Feature Request

**Severity**: HIGH | MEDIUM | LOW
**Component**: Agent | Hook | Skill | Installer
**Context**: [Brief description of what you were doing when the issue occurred]

## Evidence
### Log Snippet
```
[Paste logs here]
```

### Diagnosis (Self-Correction)
I analyzed this problem may be caused by [reason].
Suggested modification: [logic] in [file].

## Environment
- OS: [OS]
- Project: [Project Name]
```

### 3. Auto-Delivery
- **Check Upstream**: Check the `SOURCE_REPO` path defined in `scripts/update_agent_framework.sh`.
- **Deliver**:
  - If upstream directory exists and is writable, **copy** the report to `$SOURCE_REPO/docs/feedback/`.
  - Output: "✅ Report delivered directly to architect's desk (docs/feedback/)".
- **Fallback**: If unreachable, output file path and ask user to send manually.

## Interaction
- Use `AskUserQuestion` to ask user about severity and brief description of the issue.
