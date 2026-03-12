# Principles Disciple (v1.5.1+) Technical Reference (RAG Knowledge Base)

> **Identity Statement**: This document is the底层 reference guide for the Principles Disciple framework, providing agents with deep architectural understanding and configuration details.

---

## Command Quick Reference

| Command | Purpose | Replaces |
|---------|---------|----------|
| `/pd-init` | Initialize strategy and OKRs | `/init-strategy` |
| `/pd-okr` | Objectives and Key Results management | `/manage-okr` |
| `/pd-bootstrap` | Environment tool scan and upgrade | `/bootstrap-tools` |
| `/pd-research` | Initiate tool upgrade research | `/research-tools` |
| `/pd-thinking` | Manage mental models and candidates | `/thinking-os` |
| `/pd-evolve` | Execute full evolution loop | `/evolve-task` |
| `/pd-daily` | Configure and send evolution daily report | `/evolution-daily` |
| `/pd-grooming` | Workspace digital cleanup | `/workspace-grooming` |
| `/pd-trust` | View trust score and security stage | `/trust` |
| `/pd-status` | View Digital Nerve System status | New |
| `/pd-help` | Get interactive command guidance | Unchanged |

---

## 1. Digital Nerve System (DNS)

### 1.1 GFI (Global Friction Index) Calculation
GFI is the core metric measuring system "pain level", range 0-100.
- **Exit Code Penalty**: If recent command exit code is non-zero, +70.
- **Spiral Penalty**: Detect logic loops or repeated operations, +40.
- **Missing Tests**: Missing required `tests.commands`, +30.
- **Severity Levels**:
    - **High (>=70)**: System in crisis state, force evolution mode.
    - **Medium (>=40)**: Obvious architectural friction.
    - **Low (>=20)**: Minor discomfort, suggest optimization.

### 1.2 Pain Dictionary
Stored in `.state/pain_dictionary.json`, records all failure events with hash deduplication.
- **Noise Reduction**: Automatically merges similar paths and error messages.
- **Evolution Trigger**: Accumulated pain samples are input source for `/pd-evolve`.

---

## 2. Trust Engine

### 2.1 Security Stages
- **Stage 1: Observer (0-29)**: Observe only. Code modification severely restricted.
- **Stage 2: Editor (30-59)**: Limited editing. Single modification cap 50 lines, force block Risk Paths.
- **Stage 3: Developer (60-79)**: Free development. Supports Risk Paths but requires `PLAN.md` filing.
- **Stage 4: Master (80-100)**: Senior developer. Full autonomy including sub-agent scheduling.

### 2.2 Reward/Penalty Algorithm (Delta Table)
- **Rewards**:
    - Task success: +1
    - Successful sub-agent delegation: +3
    - 5-win streak bonus: +5
- **Penalties**:
    - Tool call failure: -8
    - Risk path modification failure: -15
    - Attempt to bypass Gatekeeper: -5
    - Losing streak multiplier: `(failure_streak - 1) * -3`

---

## 3. Evolution Loop (`/pd-evolve`)

### 3.1 Nine-Step SOP
1. **Context Recovery**: Read `CHECKPOINT.md` and `ISSUE_LOG.md`.
2. **Environment Sensing**: `git status`, `gh issue list`.
3. **TRIAGE**: Assess risk level and impact scope.
4. **Explorer**: Collect evidence, establish hypotheses.
5. **Diagnostician**: 5 Whys root cause analysis.
6. **Auditor**: Deductive validation of solution, must produce `RESULT: PASS`.
7. **Planner**: Write movie-script level `PLAN.md`.
8. **Implementer**: Strictly follow plan to operate.
9. **Reviewer**: Quality assurance.
10. **Log**: Update `PRINCIPLES.md`.

---

## 4. Strategy & OKR Management

### 4.1 Strategic Anchor (`/pd-init`)
- **Vision Statement**: Define project's successful form in one year.
- **CSF (Critical Success Factors)**: Lock in core strategy.

### 4.2 OKR Governance (`/pd-okr`)
- **Controlled Concurrency**: Only delegate 2-3 sub-tasks at a time.
- **User Commitment**: Record user's OKRs in `memory/okr/user.md` for AI-Human collaboration.
- **State Machine**: DRAFT -> CHALLENGE -> LOCKED -> EXECUTING.

---

## 5. Cognitive Hygiene & Entropy Reduction

### 5.1 T-10 State Externalization
- **Principle**: When context approaches limit or task switches, force export current memory state (Mental Model) to `memory/.scratchpad.md` or `PLAN.md`, preventing "goldfish memory".

### 5.2 Space Organization (`/pd-grooming`)
- **Red Line**: Never touch `src/`, `lib/`, `tests/`.
- **Goal**: Clean up debug logs, temporary backups, and unarchived reports in root directory.

---

## 6. Tool Research (`/pd-research`)

### 6.1 Purpose
Initiate deep research for specific tool upgrades when:
- New version available with breaking changes
- Security vulnerabilities in current version
- Performance improvements needed

### 6.2 Process
1. Identify target tool and version
2. Research changelog and migration guide
3. Assess impact on current codebase
4. Generate upgrade plan with rollback strategy

---

## 7. Thinking OS (`/pd-thinking`)

### 7.1 Purpose
Manage mental models and candidate solutions for:
- Complex decision making
- Architecture design trade-offs
- Problem-solving strategies

### 7.2 Features
- Store and retrieve mental models from `.principles/THINKING_OS.md`
- Track candidate solutions for active decisions
- Support hypothesis validation workflow

---
*Version: v1.5.1 | Maintainer: Spicy Evolver*
