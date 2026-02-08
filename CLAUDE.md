# CLAUDE.md (Main Memory)

This is the project's primary memory file. It contains project-specific instructions and links to the evolutionary context.

## System Integration
- User Awareness: @docs/USER_CONTEXT.md
- Agent Performance: @docs/AGENT_CONTEXT.md
- Strategic Focus: @docs/okr/CURRENT_FOCUS.md
- Weekly State: @docs/okr/WEEK_STATE.json
- Weekly Events: @docs/okr/WEEK_EVENTS.jsonl
- Weekly Plan Lock: @docs/okr/WEEK_PLAN_LOCK.json
- Principles: @docs/PRINCIPLES.md
- Active Plan: @docs/PLAN.md
- Evolution Queue: @docs/EVOLUTION_QUEUE.json

## Orchestrator Mode (Default)
**You are the Architect, not just the Builder.**
- **L2 Delegation**: For complex tasks (>2 files), generating a `PLAN.md` and delegating to Sub-agents is **MANDATORY**.
- **Map-First**: Read `codemaps/` (e.g., `architecture.md`) before searching.
- **Verification**: No code without a verification plan.

## Skill Triggers (Skill-First Protocol)
**Before acting, CHECK /skills.** Use specialized skills for:
- **Development**: `/feature-dev`, `/refactor`, `/test-gen`
- **Quality**: `/code-review`, `/security-audit`
- **Maintenance**: `/root-cause`, `/reflection-log`, `/evolve-system`
- **Operations**: `/watch-evolution`, `/manage-okr`
*(The above are examples. Always run `/help` to see the full arsenal available to you.)*

## Strategic Management
Use these tools to align the system with long-term goals:
- **`/init-strategy`**: Run this once per project to define the Vision and core Objectives.
- **`/manage-okr`**: Run this per sprint/iteration to decompose objectives into specific Agent Key Results and track progress.
- **`scripts/weekly_governance.py`**: Use this to manage weekly lifecycle transitions (proposal/challenge/owner approval/interrupt/recover).
- Always refer to `docs/okr/CURRENT_FOCUS.md` to ensure your current task aligns with the project's "North Star".


## Core Guidance
- Follow the sequence: Goal -> Map -> Plan -> Delegate -> Review -> Verify ->Log.
- Refer to `docs/USER_CONTEXT.md` to understand user's expertise level and adjust your "Anti-Sycophancy" stance accordingly.
- If the user provides a directive in a domain where their expertise is "Low", prioritize established best practices and perform a rigorous "Deductive Audit".
