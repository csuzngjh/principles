# Ray Dalio Disciple - Evolvable Programming Agent
## User Guide

**Version**: 1.0
**Date**: 2026-01-22
**Core Philosophy**: Principle-Based Programming · Radical Truth · Continuous Evolution

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Core Philosophy](#core-philosophy)
3. [Quick Start](#quick-start)
4. [Workflow](#workflow)
5. [Use Cases](#use-cases)
6. [Configuration](#configuration)
7. [Best Practices](#best-practices)
8. [Troubleshooting](#troubleshooting)
9. [FAQ](#faq)

---

## System Overview

**"Ray Dalio Disciple"** is a principle-based programming agent system, deeply inspired by Ray Dalio's book *Principles*, bringing the concepts of "Radical Truth," "Radical Transparency," and "Continuous Evolution" into software development workflows.

### Core Features

| Feature | Description | Corresponding Dalio Principle |
|---------|-------------|------------------------------|
| **Pain Flag Mechanism** | Mark failures when they occur, ensuring they're not ignored | Face reality, don't avoid problems |
| **Deductive Audit** | Three-tier review (axiom/system/via-negativa) ensures logical soundness | Radical truth, question all assumptions |
| **Gate System** | PLAN + AUDIT dual verification for risk paths | Deep thinking, avoid impulsive decisions |
| **Audit Logging** | Complete record of all operations and decisions | Radical transparency, fully traceable |
| **Checkpoint Recovery** | Detect incomplete tasks, support recovery | Learn from mistakes, continuous improvement |
| **Scorecard** | Track agent performance, quantify results | Build feedback loops |

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Ray Dalio Disciple Agent System                  │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐ │
│  │  Planner    │ ───> │  Auditor    │ ───> │Implementer  │ │
│  │  (Planner)  │      │  (Auditor)  │      │ (Implementer)│ │
│  └─────────────┘      └─────────────┘      └─────────────┘ │
│         │                     │                     │        │
│         ▼                     ▼                     ▼        │
│    docs/PLAN.md        docs/AUDIT.md          Implementation │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Hooks Gate System                       │   │
│  │  • PreToolUse: Risk path checking                   │   │
│  │  • PostToolUse: Test validation                     │   │
│  │  • SessionInit: Checkpoint recovery                │   │
│  │  • Stop: Pain Flag generation                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Memory & Audit System                   │   │
│  │  • AUDIT_TRAIL.log: Operation log                   │   │
│  │  • DECISIONS.md: Decision record                    │   │
│  │  • ISSUE_LOG.md: Issue tracking                     │   │
│  │  • AGENT_SCORECARD.json: Performance scoring        │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Philosophy

### Ray Dalio's 5-Step Process

This system integrates Dalio's 5-step process into programming practice:

1. **Goals** → PLAN.md defines clear goals
2. **Problems** → ISSUE_LOG.md records problems
3. **Diagnosis** → Diagnostician + Auditor deep analysis
4. **Design** → Planner creates execution plan
5. **Doing** → Implementer executes strictly

### Application of Key Principles

| Dalio Principle | System Implementation |
|----------------|----------------------|
| **Radical Truth** | Deductive audit three-tier: axiom test, system test, via negativa |
| **Embrace Reality** | Pain Flag mechanism, failures marked immediately, don't avoid problems |
| **Radical Transparency** | AUDIT_TRAIL.log records all operations, fully traceable |
| **Deep Thinking** | Gate system requires PLAN + AUDIT dual verification |
| **Learn from Mistakes** | ISSUE_LOG.md records root cause analysis, prevent repeating mistakes |
| **Continuous Evolution** | System can self-improve, records all decisions and results |

### Core Invariants

```bash
# Process sequence (no skipping allowed)
Goal → Problem → Diagnosis → Deductive Audit → Plan → Execute → Review → Log
```

**All tasks must follow this sequence**. Violations will be blocked by hooks.

---

## Quick Start

### Requirements

| Component | Version | Required/Optional |
|-----------|---------|-------------------|
| **Claude Code** | 1.0+ | Required |
| **jq** | 1.6+ | Required |
| **Bash** | 4.0+ | Required |
| **ShellCheck** | 0.9+ | Recommended |

### Installation Steps

#### 1. Clone Repository

```bash
git clone <repository-url>
cd principles
```

#### 2. Verify Environment

```bash
# Check jq
jq --version

# Check hooks
bash tests/test_hooks.sh
```

#### 3. Initialize Configuration

Configuration file located at `docs/PROFILE.json` defines risk paths and permissions:

```json
{
  "audit_level": "medium",
  "risk_paths": ["src/server/", "infra/", "db/"],
  "gate": {
    "require_plan_for_risk_paths": true,
    "require_audit_before_write": true
  },
  "permissions": {
    "deny_skip_tests": true,
    "deny_unsafe_db_ops": true
  }
}
```

#### 4. Start System

```bash
# Start Claude Code
claude

# System will automatically run session_init.sh
# Display current config, Pain Flag status, recent Issues
```

---

## Workflow

### Standard Development Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                   Complete Workflow                          │
└─────────────────────────────────────────────────────────────┘

1. Identify Problem
   ├─ User reports problem
   └─ Create ISSUE (record to ISSUE_LOG.md)

2. Root Cause Analysis
   ├─ Use Diagnostician agent
   ├─ 5 Whys analysis
   └─ Generate root cause report

3. Deductive Audit
   ├─ Use Auditor agent
   ├─ Axiom test: Verify assumptions
   ├─ System test: Check system impact
   ├─ Via negativa: Worst-case analysis
   └─ Generate AUDIT.md (RESULT: PASS/FAIL)

4. Create Plan
   ├─ Use Planner agent
   ├─ Generate PLAN.md
   │   ├─ STATUS: READY
   │   ├─ Steps: Detailed steps
   │   ├─ Metrics: Verification criteria
   │   ├─ Rollback: Rollback plan
   │   └─ Risk notes: Risk warnings
   └─ Audit passes (AUDIT.md RESULT: PASS)

5. Execute Plan
   ├─ Use Implementer agent
   ├─ Execute strictly according to PLAN.md
   ├─ Run tests
   └─ Generate change summary

6. Code Review (optional)
   ├─ Use Reviewer agent
   └─ Review code quality and security

7. Clean Pain Flag
   ├─ Confirm problem solved
   └─ Delete docs/.pain_flag

8. Record Decisions
   ├─ Update DECISIONS.md
   └─ Update AGENT_SCORECARD.json
```

### Agent Usage Examples

#### Planner

**Purpose**: Create detailed plan before code modification

```bash
# Usage example
Enter Plan Mode, let Planner create plan

# Output example
STATUS: READY
Steps:
1. Read docs/ISSUE_LOG.md to understand problem
2. Use Diagnostician to analyze root cause
3. Use Auditor for deductive audit
4. Design solution
5. List implementation steps

Metrics:
- Issue problem resolved
- All tests pass
- No regression issues

Rollback:
- git revert commit
- Restore backup files

Risk notes:
- May affect user authentication flow
- Deploy during low-traffic hours
```

#### Auditor

**Purpose**: Verify logical correctness and system safety of the plan

```bash
# Usage example
Let Auditor audit PLAN.md

# Output example
## Axiom test
- ✅ Language contract check: API version compatible
- ✅ Dependency verification: All dependencies exist

## System test
- ✅ Technical debt: No new technical debt introduced
- ✅ Enhancement loop: Improve logging system (positive enhancement)
- ⚠️ Latency risk: Database query may increase 50ms

## Via negativa
- ✅ Empty input: Correctly handled
- ✅ Network failure: Graceful degradation
- ⚠️ Permission bypass: Need additional verification

RESULT: PASS

Must-fix:
- Add database query optimization before implementation
- Add unit test for permission verification
```

#### Implementer

**Purpose**: Execute code modifications strictly according to PLAN.md

```bash
# Usage example
Use Implementer to execute PLAN.md

# Output example
## Changes
- modified: src/auth/login.py (added session timeout)
- modified: tests/test_auth.py (added timeout test)

## Commands run
- pytest tests/test_auth.py → ✅ pass (12/12)
- pylint src/auth/login.py → ✅ pass (8.5/10)

## Notes
- Executed steps 1-4 as planned
- No deviations, no extra changes
- All tests passed
```

#### Diagnostician

**Purpose**: Deep analysis of root causes

```bash
# Usage example
Use Diagnostician to analyze ISSUE

# 5 Whys analysis example
Why 1: Why session timeout?
  Ans: Session expiry time not set

Why 2: Why not set?
  Ans: Config missing after framework upgrade

Why 3: Why config missing?
  Ans: Migration script didn't cover new config items

Why 4: Why migration script missed?
  Ans: No config difference comparison

Why 5: Why no comparison?
  Ans: Process flaw, missing migration checklist

Root cause classification:
- People: Process design flaw
- Design: Missing migration validation mechanism
- Assumption: Assumed config fully compatible (wrong)
```

---

## Use Cases

### Case 1: Fix Bug

```bash
# 1. Report problem
Discovered login failure rate increased

# 2. Generate Issue
Record to docs/ISSUE_LOG.md

# 3. Diagnosis
Use Diagnostician to analyze root cause
→ Found: Session concurrency limit config error

# 4. Audit solution
Use Auditor to verify fix plan
→ RESULT: PASS

# 5. Create plan
Use Planner to generate PLAN.md

# 6. Execute fix
Use Implementer to execute PLAN.md

# 7. Verify
Run tests, confirm problem resolved

# 8. Clean up
Delete docs/.pain_flag
```

### Case 2: Add Feature

```bash
# 1. Requirement analysis
Define feature goals and acceptance criteria

# 2. Risk assessment
Check if involves risk_paths (e.g., infra/, db/)

# 3. Deductive audit
Use Auditor to audit design
→ Check database migration safety
→ Check API compatibility
→ Check performance impact

# 4. Create plan
Use Planner to generate detailed PLAN.md
→ Include database migration steps
→ Include rollback plan

# 5. Execute implementation
Use Implementer to execute

# 6. Code review
Use Reviewer to review code
```

### Case 3: Refactor Code

```bash
# 1. Identify technical debt
Code review found issues

# 2. Record Issue
Record to docs/ISSUE_LOG.md

# 3. Audit refactoring scope
Use Auditor to analyze impact
→ Ensure Behavior Preservation

# 4. Create refactoring plan
PLAN.md includes:
- Refactoring steps
- Test verification
- Performance comparison

# 5. Execute refactoring
Use Implementer to execute
```

---

## Configuration

### PROFILE.json Configuration

```json
{
  "audit_level": "medium",
  "risk_paths": ["src/server/", "infra/", "db/"],

  "gate": {
    "require_plan_for_risk_paths": true,
    "require_audit_before_write": true
  },

  "tests": {
    "on_change": "smoke",
    "on_risk_change": "unit",
    "commands": {
      "smoke": "npm test --silent",
      "unit": "npm test",
      "full": "npm test && npm run lint"
    }
  },

  "permissions": {
    "deny_skip_tests": true,
    "deny_unsafe_db_ops": true
  }
}
```

#### Configuration Options

| Option | Description | Values |
|--------|-------------|--------|
| `audit_level` | Audit strictness | `low`, `medium`, `high` |
| `risk_paths` | Risk path list | Array, relative paths |
| `require_plan_for_risk_paths` | Require PLAN for risk paths | `true`, `false` |
| `require_audit_before_write` | Require AUDIT before write | `true`, `false` |
| `on_change` | Test level for normal changes | `smoke`, `unit`, `full` |
| `on_risk_change` | Test level for risk changes | `smoke`, `unit`, `full` |
| `deny_skip_tests` | Prohibit skipping tests | `true`, `false` |
| `deny_unsafe_db_ops` | Prohibit dangerous DB ops | `true`, `false` |

### Hooks Configuration

Configure in `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "CLAUDE_HOOK_TYPE=SessionStart \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/audit_log.sh"
          },
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/session_init.sh"
          }
        ]
      }
    ],
    "PreToolUse": [...],
    "PostToolUse": [...],
    "Stop": [...]
  }
}
```

### DEBUG Mode

Control whether to show debug information:

```bash
# Default: DEBUG off
claude

# Enable DEBUG (development)
DEBUG_HOOKS=1 claude

# Or persist in ~/.bashrc
export DEBUG_HOOKS=1
```

See: `docs/DEBUG_HOOKS_USAGE.md`

---

## Best Practices

### 1. Follow Process, Don't Skip Steps

```bash
❌ Wrong: Modify code directly
Direct Edit file → Blocked

✅ Right: Follow complete process
Problem → Diagnosis → Audit → Plan → Execute → Review
```

### 2. Fully Utilize Agents

| Scenario | Use Agent |
|----------|-----------|
| Need to create plan | Planner |
| Need to verify plan | Auditor |
| Need deep analysis | Diagnostician |
| Need to execute changes | Implementer |
| Need code review | Reviewer |
| Need to explore code | Explorer |

### 3. Record Everything

- ✅ All Issues to `docs/ISSUE_LOG.md`
- ✅ All Decisions to `docs/DECISIONS.md`
- ✅ All Operations to `docs/AUDIT_TRAIL.log`
- ✅ Agent Performance to `docs/AGENT_SCORECARD.json`

### 4. Clean Pain Flags Promptly

```bash
# Clean up immediately after problem solved
rm docs/.pain_flag

# Or use hooks auto-reminder
# Stop agent will prompt to clean up
```

### 5. Regular Review

- Weekly: Review `docs/ISSUE_LOG.md`
- Monthly: Review `docs/AGENT_SCORECARD.json`
- Quarterly: Review `docs/DECISIONS.md`

### 6. Continuous Improvement

Based on patterns in `docs/ISSUE_LOG.md`:
- Identify systemic issues
- Update `docs/PROFILE.json`
- Improve processes

---

## Troubleshooting

### Problem 1: Hook Blocks Operation

**Symptom**:
```
Blocked: risk edit requires docs/PLAN.md
```

**Cause**: Attempting to modify risk path without PLAN.md

**Solution**:
```bash
# 1. Use Planner to generate PLAN.md
Enter Plan Mode

# 2. Use Auditor to audit plan
Ensure AUDIT.md RESULT: PASS

# 3. Use Implementer to execute
```

### Problem 2: Test Failure

**Symptom**:
```
Post-write checks failed (rc=254)
Pain flag written to docs/.pain_flag
```

**Cause**: Tests didn't pass

**Solution**:
```bash
# 1. View test output
pytest tests/...

# 2. Fix problem
Edit code

# 3. Re-test
# After tests pass, delete pain flag
rm docs/.pain_flag
```

### Problem 3: jq Not Available

**Symptom**:
```
❌ Error: jq is required but not installed
```

**Solution**:
```bash
# Linux/WSL
sudo apt-get install jq

# macOS
brew install jq

# Windows
choco install jq
```

### Problem 4: Pain Flag Blocking

**Symptom**:
```
⚠️ Unhandled pain flag detected
Suggestion: Run /evolve-task --recover to complete diagnosis
```

**Cause**: Previous task failed, Pain Flag not cleaned

**Solution**:
```bash
# 1. View Pain Flag content
cat docs/.pain_flag

# 2. Complete diagnosis or fix
Use Diagnostician to analyze

# 3. Clean up after problem solved
rm docs/.pain_flag
```

### Problem 5: Agent Call Failure

**Symptom**: Agent not working or abnormal output

**Solution**:
```bash
# 1. Check Agent configuration
ls .claude/agents/

# 2. Check YAML frontmatter
Ensure name, description, tools correct

# 3. View Agent scoreboard
cat docs/AGENT_SCORECARD.json

# 4. View audit log
grep "AGENT" docs/AUDIT_TRAIL.log | tail -20
```

---

## FAQ

### Q1: Must I use all Agents?

**A**: Not required. Choose based on scenario:

- **Simple tasks**: Direct conversation
- **Complex tasks**: Planner + Implementer
- **Risk tasks**: Full flow (Planner → Auditor → Implementer)

### Q2: Can I skip AUDIT and go directly to PLAN?

**A**:
- **Risk paths** (e.g., `infra/`, `db/`): **No**, will be blocked
- **Non-risk paths**: Yes, but not recommended

### Q3: Does Pain Flag block all operations?

**A**: No. Pain Flag is just a reminder, doesn't block operations. But strongly recommended to handle Pain Flag first.

### Q4: How to view history?

**A**:
```bash
# View audit log
cat docs/AUDIT_TRAIL.log

# View decision record
cat docs/DECISIONS.md

# View Issue history
cat docs/ISSUE_LOG.md
```

### Q5: How to quantify Agent performance?

**A**: Check `docs/AGENT_SCORECARD.json`:

```json
{
  "implementer": {
    "total_tasks": 42,
    "success_rate": 0.95,
    "avg_duration": "3m 20s"
  }
}
```

### Q6: Can I customize Agents?

**A**: Yes. Create new `.md` file in `.claude/agents/`, format:

```markdown
---
name: custom-agent
description: Your description
tools: Read, Write, Edit, Bash
model: sonnet
permissionMode: acceptEdits
---

Your system prompt...
```

### Q7: How to disable a Hook?

**A**: In `.claude/settings.json`:

```json
{
  "disableAllHooks": false  // Disable all hooks
}
```

Or modify `hooks` config, remove unwanted hook.

### Q8: Does system support multi-user collaboration?

**A**: Yes. Recommended:

1. **Shared config**: `.claude/settings.json` commit to git
2. **Personal config**: `.claude/settings.local.json` don't commit
3. **Pain Flag reminder**: session_init.sh prompts other users' Pain Flags
4. **Audit transparency**: All operations recorded to AUDIT_TRAIL.log

---

## Advanced Usage

### Create Custom Workflow

```bash
# .claude/workflows/feature-development.md

# Standard flow for new feature development

1. Requirement Analysis
   - Define feature goals
   - Identify risk paths
   - Assess impact scope

2. Design Audit
   - Use Auditor to audit design
   - Use Planner to create implementation plan
   - Use Reviewer to review code quality

3. Implementation Verification
   - Use Implementer to execute plan
   - Run full test suite
   - Conduct regression testing

4. Deploy
   - Update DECISIONS.md
   - Generate deployment checklist
   - Prepare rollback plan
```

### Integrate CI/CD

```yaml
# .github/workflows/principles-check.yml

name: Principles Check

on: [pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Check PLAN
        run: |
          if [ -f "docs/PLAN.md" ]; then
            grep -q "STATUS: READY" docs/PLAN.md
          fi
      - name: Check AUDIT
        run: |
          if [ -f "docs/AUDIT.md" ]; then
            grep -q "RESULT: PASS" docs/AUDIT.md
          fi
      - name: No Pain Flag
        run: |
          if [ -f "docs/.pain_flag" ]; then
            echo "Pain flag exists!"
            exit 1
          fi
      - name: Run Hooks Test
        run: bash tests/test_hooks.sh
```

---

## Appendix

### A. File Structure

```
principles/
├── .claude/
│   ├── agents/              # Agent definitions
│   │   ├── auditor.md
│   │   ├── diagnostician.md
│   │   ├── implementer.md
│   │   ├── planner.md
│   │   └── reviewer.md
│   ├── hooks/               # Hooks scripts
│   │   ├── audit_log.sh
│   │   ├── pre_write_gate.sh
│   │   ├── post_write_checks.sh
│   │   ├── session_init.sh
│   │   ├── stop_evolution_update.sh
│   │   └── subagent_complete.sh
│   ├── rules/               # Core rules
│   │   └── 00-kernel.md
│   ├── skills/              # Custom skills
│   │   └── evolve-task/
│   └── settings.json        # Claude Code config
├── docs/                    # Docs and records
│   ├── PROFILE.json         # System config
│   ├── PLAN.md              # Execution plan
│   ├── AUDIT.md             # Audit report
│   ├── DECISIONS.md         # Decision record
│   ├── ISSUE_LOG.md         # Issue log
│   ├── CHECKPOINT.md        # Checkpoint
│   ├── AUDIT_TRAIL.log      # Operation audit
│   ├── .pain_flag           # Pain marker (not committed)
│   └── AGENT_SCORECARD.json # Agent scoring
├── tests/                   # Test scripts
│   ├── test_hooks.sh
│   ├── shellcheck_all.sh
│   └── fix_jq_path.sh
└── README.md
```

### B. Glossary

| Term | Description |
|------|-------------|
| **Pain Flag** | Failure marker, recorded to `docs/.pain_flag` |
| **Deductive Audit** | Axiom + System + Via Negativa three-tier review |
| **Risk Paths** | Dangerous directories defined in `PROFILE.json` |
| **Gate System** | PLAN + AUDIT dual verification mechanism |
| **Agent** | Specialized sub-agent |
| **Evolution** | System continuously improves through learning |
| **Principles** | Immutable invariant rules |
| **Radical Truth** | Question all assumptions, verify all premises |
| **Radical Transparency** | All operations and decisions fully traceable |

### C. References

- **Ray Dalio's *Principles***: http://www.principles.com/
- **Claude Code Docs**: https://code.claude.com/docs
- **Shell Script Best Practices**: https://www.shellcheck.net/
- **Git Workflows**: https://www.atlassian.com/git/tutorials/comparing-workflows

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-22 | Initial version |

---

## Support

- **Issues**: Submit Issue in project repository
- **Documentation**: See other docs in `docs/` directory
- **Audit Log**: `docs/AUDIT_TRAIL.log`

---

**"Truth is the foundation of all real improvement."** - Ray Dalio

**"Embrace reality, learn from mistakes, and evolve continuously."** - Ray Dalio Disciple
