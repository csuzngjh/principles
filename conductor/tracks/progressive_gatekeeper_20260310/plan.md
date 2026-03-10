# Implementation Plan: Progressive Gatekeeper

## Phase 1: Core Storage & Utility Functions
- [x] Task: Create or update `docs/AGENT_SCORECARD.json` initialization logic to ensure `trust_score` exists with a default of 50. [fe506a3]
- [x] Task: Create `src/core/trust-engine.ts` with basic calculate, increment, and decrement logic for `trust_score`. [fe506a3]
- [x] Task: Create `src/core/risk-calculator.ts` to compute risk (LOW, MEDIUM, HIGH, CRITICAL) based on file path (`isRisky`) and estimated modification size. [fe506a3]
- [x] Task: Write tests for `trust-engine.ts` and `risk-calculator.ts`. [fe506a3]
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Core Storage & Utility Functions' (Protocol in workflow.md)

## Phase 2: Hook Integration (Pain & Subagent)
- [ ] Task: Modify `src/hooks/pain.ts` to decrement `trust_score` (e.g., -10) when a critical failure occurs.
- [ ] Task: Modify `src/hooks/subagent.ts` to increment `trust_score` (e.g., +2) upon successful subagent completion (`outcome === 'ok'`).
- [ ] Task: Add test coverage for trust score adjustments in `pain.test.ts` and `subagent.test.ts`.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Hook Integration (Pain & Subagent)' (Protocol in workflow.md)

## Phase 3: Progressive Gatekeeper Implementation
- [ ] Task: Refactor `src/hooks/gate.ts` to read `trust_score` and enforce the 4-stage progressive logic: Stage 1 (<30), Stage 2 (30-60), Stage 3 (60-80), Stage 4 (>80).
- [ ] Task: Implement risk constraints in `gate.ts`: Block Stage 2 for `risk_paths` and large files, enforce `PLAN.md` for Stage 3 `risk_paths`, allow all for Stage 4.
- [ ] Task: Add backward compatibility: if `progressive_gate.enabled` is false in profile, fall back to current gate logic.
- [ ] Task: Update unit tests in `gate.test.ts` to cover the new progressive logic and trust stages.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Progressive Gatekeeper Implementation' (Protocol in workflow.md)

## Phase 4: Agent UI and Commands
- [ ] Task: Modify `src/hooks/prompt.ts` to dynamically inject `[CURRENT TRUST SCORE: X/100 (Stage Y)]` into the system context.
- [ ] Task: Write tests to ensure `prompt.ts` correctly extracts and formats the trust score.
- [ ] Task: Create a new custom Slash Command (`src/commands/trust.ts` or add to `admin.ts`) that prints the current trust score, stage, and next promotion requirements.
- [ ] Task: Update tests for the new command.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Agent UI and Commands' (Protocol in workflow.md)
