# Requirements: Principles — v1.14 Evolution Worker Decomposition & Contract Hardening

**Defined:** 2026-04-11
**Core Value:** AI agents improve their own behavior through a structured evolution loop. pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## v1.14 Requirements

### Decomposition

- [ ] **DECOMP-01**: Queue persistence, V2 migration, file locking, and purge logic extracted into dedicated `EvolutionQueueStore` module
- [ ] **DECOMP-02**: Pain flag detection and parsing extracted into dedicated `PainFlagDetector` module
- [ ] **DECOMP-03**: Task dispatch and execution logic (pain_diagnosis + sleep_reflection) extracted into dedicated `EvolutionTaskDispatcher` module
- [ ] **DECOMP-04**: Workflow watchdog, expiry cleanup, and manager lifecycle extracted into dedicated `WorkflowOrchestrator` module
- [ ] **DECOMP-05**: Context extraction, fallback snapshot building, and session filtering extracted into `TaskContextBuilder` module
- [ ] **DECOMP-06**: `evolution-worker.ts` reduced to service lifecycle orchestration only (start/stop/runCycle), delegating to extracted modules

### Contract Hardening

- [ ] **CONTRACT-01**: Queue items validated against schema before write — corrupt or malformed items rejected with explicit error
- [ ] **CONTRACT-02**: Queue items validated after read — migration or corruption detected before processing
- [ ] **CONTRACT-03**: Each extracted module has input validation at entry points following v1.13 contract pattern (factory/validator with structured result)
- [ ] **CONTRACT-04**: All 16 silent fallback points audited and classified as fail-fast (boundary entry) or fail-visible (pipeline middle)
- [ ] **CONTRACT-05**: Fail-visible points emit structured skip/drop events consumable by downstream diagnostics
- [ ] **CONTRACT-06**: Lock management centralized in EvolutionQueueStore — no external lock acquisition for queue operations

### Integration

- [ ] **INTEG-01**: All existing tests pass after decomposition without modification to test expectations (behavior preserved)
- [ ] **INTEG-02**: Worker service public API unchanged — external callers (hooks, commands, HTTP routes) unaffected
- [ ] **INTEG-03**: Nocturnal pipeline end-to-end flow (pain -> queue -> nocturnal -> replay) runs correctly through refactored modules
- [ ] **INTEG-04**: Worker service startup/shutdown lifecycle preserved — no new hanging resources or leaked locks

## v2 Requirements

Deferred to future milestones.

### Replay Engine Contracts

- **REPLAY-01**: Replay engine sample loading validates input format before evaluation
- **REPLAY-02**: Replay evaluation failures emit structured skip events instead of silent catch
- **REPLAY-03**: `_buildRuleHostInput()` output validated against expected schema

### Supporting Module Contracts

- **SUPPORT-01**: Trajectory extraction returns validated results or explicit failure (never partial data)
- **SUPPORT-02**: Dictionary/rule pattern matching validates rule structure at load time
- **SUPPORT-03**: Event log validates event structure before recording

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replay engine contract hardening | Deferred to next milestone — worker decomposition must stabilize first |
| Dictionary/rule matching contracts | Lower priority supporting module — not on production critical path |
| Trajectory extraction contracts | Lower priority — nocturnal snapshot contract already validates downstream |
| Event log contracts | Diagnostic only — not on production critical path |
| Config validation | Config changes are rare and manual — not worth contract investment yet |
| New UI/dashboard work | Production loop stability takes priority |
| Thinking Models page | Deferred until production loop is fully trustworthy |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DECOMP-01 | Phase 24 | Pending |
| DECOMP-02 | Phase 25 | Pending |
| DECOMP-03 | Phase 26 | Pending |
| DECOMP-04 | Phase 27 | Pending |
| DECOMP-05 | Phase 28 | Pending |
| DECOMP-06 | Phase 28 | Pending |
| CONTRACT-01 | Phase 24 | Pending |
| CONTRACT-02 | Phase 24 | Pending |
| CONTRACT-03 | Phase 28 | Pending |
| CONTRACT-04 | Phase 28 | Pending |
| CONTRACT-05 | Phase 28 | Pending |
| CONTRACT-06 | Phase 24 | Pending |
| INTEG-01 | Phase 29 | Pending |
| INTEG-02 | Phase 29 | Pending |
| INTEG-03 | Phase 29 | Pending |
| INTEG-04 | Phase 29 | Pending |

**Coverage:**
- v1.14 requirements: 16 total
- Mapped to phases: 16
- Unmapped: 0

---
*Requirements defined: 2026-04-11*
*Last updated: 2026-04-11 after roadmap creation*
