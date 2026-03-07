# Principles Disciple: Evolutionary Agent Framework (v2.5)

## 1. Project Identity
**Principles Disciple** is no longer just a plugin; it is a **Scaffold & Installer Toolkit** that transforms any Claude Code project into a self-evolving, principle-driven digital lifeform. It replaces default behaviors with a rigorous loop of Strategy, Execution, Reflection, and Evolution.

**Core Philosophy:**
- **System Dynamics**: Optimizes for leveraged evolution (Information Flow, Rules, Self-Organization).
- **Anti-Sycophancy**: Enforces principles over user whims via strict gates and audits.
- **Evidence-Driven**: Decisions must be backed by logs, metrics, or tests (Clinical Trials).
- **Tool Empowerment**: Proactively detects environment capabilities (`ripgrep`, `ast-grep`) to empower agents.

---

## 2. Architecture: The "Scaffold" Model

### Deployment
- **`install.sh`**: The core delivery vehicle.
    - **Smart Copy**: Preserves user-evolved prompts (saving updates as `*.update`).
    - **Safe Copy**: Protects critical data (`docs/`).
    - **Path Fix**: Injects absolute paths into `settings.json` for WSL/Windows compatibility.
- **Self-Update**: Target projects can pull upstream changes via `scripts/update_agent_framework.sh`.

### Key Directories (Flattened Structure)
- **`hooks/hook_runner.py`**: The central nervous system (Python-based). Handles all events, telemetry (`SYSTEM.log`), and dynamic guardrails.
- **`agents/`**: Specialized sub-agents (`Explorer`, `Diagnostician`, `Auditor`, `Planner`, `Implementer`, `Reviewer`, `Reporter`). **Unlocked**: All have `Glob` and `Bash` permissions.
- **`skills/`**: High-level capabilities (Strategy, OKR, Evolution, Feedback).
- **`docs/`**: The system's memory and configuration.
    - **`schemas/`**: JSON Schemas for data contracts (`user_verdict`, `agent_verdict`).
    - **`system/`** (Virtual): Core config files are protected via `.memory-index.md`.

---

## 3. The 6 Evolutionary Loops

### 🔄 1. The Gatekeeper Loop (Safety)
- **Mechanism**: `pre_write_gate` (Hook).
- **Logic**: Blocks modifications to `risk_paths` unless `PLAN.md` is `READY` and `AUDIT.md` is `PASS`.
- **Dynamic**: Supports regex-based `custom_guards` defined in `PROFILE.json`.

### 🧠 2. The Reflection Loop (Pain)
- **Mechanism**: `post_write_checks` -> `.pain_flag` -> `/reflection-log`.
- **Logic**: Runtime failures triggers immediate reflection, generating new Principles or Guardrails.

### 🎯 3. The Strategy Loop (Goal)
- **Mechanism**: `/init-strategy` -> `/manage-okr`.
- **Logic**: Align project Strategy -> Agent OKRs -> User OKRs (`docs/okr/user.md`).
- **Feature**: Supports "User Commitment" to prevent scope creep.

### 💖 4. The Positive Reinforcement Loop (Dopamine)
- **Mechanism**: `/reflection-log` (Positive) -> `Achievement Wall`.
- **Logic**: Success patterns are recorded in `USER_PROFILE` and displayed in `USER_CONTEXT` to reinforce excellence.

### 🧬 5. The Meta-Evolution Loop (Self-Correction)
- **Mechanism**: `/evolve-system` (The Architect).
- **Logic**: Analyzes `AGENT_SCORECARD` win rates.
    - **Clinical Trial**: Automatically runs `Task()` to verify agent defects.
    - **Proposal**: Suggests modifying `.claude/` source code (Prompt/Hook).

### 👁️ 6. The Perception Loop (Environment)
- **Mechanism**: `/bootstrap-tools`.
- **Logic**: Scans environment (npm, pip, cargo) -> Recommends Tools (rg, sg) -> Installs -> Broadcasts capabilities to all Agents via `SYSTEM_CAPABILITIES.json`.

---

## 4. Key Features & Tools

### Human Console
- **`/bootstrap-tools`**: Auto-detect and install high-performance CLI tools.
- **`/system-status`**: (Via `statusline`) Real-time dashboard in terminal: `[Model 🟢] 💾Plan:READY 🛡️✅ 💊Pain 🎯OKR:Fix...`.
- **`/report`**: Executive summary by the `Reporter` agent (tailored to user expertise).
- **`/feedback`**: Standardized bug reporting, auto-delivered to source repo.

### Engineering Standards
- **Throttling**: Concurrency limit (2-3 tasks) to prevent resource exhaustion.
- **Entropy Audit**: `Auditor` checks for minimalism and necessity (Occam's Razor).
- **Native Tasks**: Integration with Claude Code Tasks (`CLAUDE_CODE_TASK_LIST_ID`) for parallel collaboration.

---

## 5. Development Protocols

### Contributing
1.  **Modify Source**: Edit files in `D:\Code\principles`.
2.  **Sync**: Run `bash install.sh /path/to/target --force`.
3.  **Verify**: Check `statusline` and run `/admin diagnose` in target.

### Data Contracts
- **`docs/schemas/*.json`**: All inter-agent data exchange (verdicts, profiles) must validate against these schemas.

### Critical Paths
- **`hooks/hook_runner.py`**: Do not break the `statusline` or `pre_write_gate` logic.
- **`install.sh`**: Ensure `smart_copy` logic preserves user data while updating system logic.