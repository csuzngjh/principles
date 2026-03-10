# Track Specification: Progressive Gatekeeper (Full Specification)

## 1. Overview
Implement the full Progressive Gatekeeper logic as designed in `deep-design-gatekeeper.md`. This system will shift the current binary gate mechanism to a dynamic, 4-stage progressive unlock system driven by a computational "Trust Engine" and "Risk Calculator". The goal is to reduce cognitive load for small, safe modifications while maintaining strict safeguards (like requiring a `PLAN.md`) for high-risk, large-scale refactors.

## 2. Functional Requirements
- **Trust Engine**: Calculate a persistent `trust_score` (0-100) based on successful tool calls, failures, and Generalized Friction Index (GFI). The score must be stored at the workspace level in `docs/AGENT_SCORECARD.json`.
- **4-Stage Progressive Unlocks**:
  - **Stage 1 (Observer)**: Can only read/diagnose. No writes to `risk_paths`.
  - **Stage 2 (Editor)**: Can make small changes (< 10 lines). No `risk_paths`.
  - **Stage 3 (Developer)**: Can make medium changes (< 100 lines). Can modify `risk_paths` if `PLAN.md` is READY.
  - **Stage 4 (Architect)**: Full freedom.
- **Risk Calculator**: Analyze file edits during `before_tool_call` to compute modification risk based on file path importance and line count modification scale.
- **Agent Awareness**: 
  - Inject the agent's current stage and trust score into the system prompt context.
  - Create a custom Slash Command (e.g., `/trust` or `/gate-status`) to explicitly query current trust status and stage requirements.

## 3. Non-Functional Requirements
- **Performance**: Risk calculation and trust engine updates must be highly optimized so as not to introduce noticeable latency in the `before_tool_call` hook.
- **Backward Compatibility**: Must gracefully fall back to the existing binary logic if progressive features are disabled in `PROFILE.json`.

## 4. Acceptance Criteria
- [ ] A trust score is successfully initialized and persists in `docs/AGENT_SCORECARD.json`.
- [ ] Tool failures correctly decrement the trust score, and successes increment it.
- [ ] The gate successfully blocks large writes for Stage 2 agents while allowing small writes.
- [ ] The system prompt correctly reflects the current trust score and stage.
- [ ] A slash command successfully outputs the detailed trust and stage metrics.

## 5. Out of Scope
- Implementing the "Temporary Ticket System" (Emergency/Fast-track tickets) from the design document. This will be deferred to a future track.
- Extremely complex graph-based dependency analysis for risk calculation; risk calculation will rely primarily on line counts and path strings.
