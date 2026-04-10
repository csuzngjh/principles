# Roadmap: Principles Disciple

## Milestones

- [x] **v1.9.3** - Remaining lint stabilization (shipped 2026-04-09)
- [x] **v1.12** - Nocturnal Production Stabilization (Phases 16-18, shipped 2026-04-10)
- [ ] **v1.13** - Boundary Contract Hardening (Phases 19-21, started 2026-04-11)
- [ ] **v1.10** - Thinking Models page optimization (deferred)

## Phases

### v1.13 Boundary Contract Hardening

**Milestone:** v1.13  
**Goal:** Remove the implicit-assumption and silent-fallback failure mode from the nocturnal production path.  
**Phases:** 3  
**Coverage:** 11 requirements mapped

- [ ] **Phase 19: Unified Workspace Resolution Contract** - replace ad-hoc workspace resolution with one fail-fast service across hooks, commands, workers, and HTTP routes (BC-01, BC-02, BC-03)
- [ ] **Phase 20: Critical Data Schema Validation** - centralize parsing and validation for `.pain_flag`, snapshot ingress, and related state-file reads (SCHEMA-01, SCHEMA-02, SCHEMA-03)
- [ ] **Phase 21: Runtime Contract and End-to-End Hardening** - remove constructor-name capability guessing, bound session selection by time, and lock the main path with contract tests (RT-01, RT-02, RT-03, E2E-01, E2E-02, E2E-03)

### Phase 19: Unified Workspace Resolution Contract

**Goal:** every production path uses one trusted workspace resolution entry and stops on failure instead of falling back to HOME.

**Depends on:** v1.12 shipped state

**Requirements:** BC-01, BC-02, BC-03

**UAT:**
- No hook, command, worker, or HTTP route writes `.state` based on `api.resolvePath('.')`
- Wrong or missing workspace context produces explicit failure, not guessed writes
- `/pd-reflect` uses the active workspace, not a hardcoded agent/workspace target

### Phase 20: Critical Data Schema Validation

**Goal:** critical state files and snapshot ingress are parsed through shared validators instead of scattered manual readers.

**Depends on:** Phase 19

**Requirements:** SCHEMA-01, SCHEMA-02, SCHEMA-03

**UAT:**
- `.pain_flag` parse logic is centralized and required fields are validated
- Invalid snapshot or state-file payloads fail explicitly and are logged structurally
- Worker paths no longer continue with empty/default objects that look valid

### Phase 21: Runtime Contract and End-to-End Hardening

**Goal:** background runtime checks and the nocturnal main path are backed by explicit contracts and pipeline-level tests.

**Depends on:** Phase 20

**Requirements:** RT-01, RT-02, RT-03, E2E-01, E2E-02, E2E-03

**UAT:**
- Background runtime availability is not inferred from `constructor.name`
- Failure states distinguish runtime unavailability from downstream workflow failure
- Pain -> queue -> nocturnal flow and command/hook writes are covered by end-to-end contract tests
- Candidate session selection cannot pull sessions from after the triggering pain/task time

### Deferred: v1.10 Thinking Models Page Optimization

This milestone is intentionally paused. It should not resume until the production nocturnal path is trustworthy.

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 03 | v1.9.3 | 1/1 | Complete | 2026-04-09 |
| 16 | v1.12 | 2/2 | Complete | 2026-04-10 |
| 17 | v1.12 | 1/1 | Complete | 2026-04-10 |
| 18 | v1.12 | 1/1 | Complete | 2026-04-10 |
| 19-21 | v1.13 | 0/3 | Planned | - |

*Last updated: 2026-04-11 after v1.13 milestone started*
