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

- [x] **Phase 19: Unified Workspace Resolution Contract** - replace ad-hoc workspace resolution with one fail-fast service across hooks, commands, workers, and HTTP routes (BC-01, BC-02, BC-03)
- [x] **Phase 20: Critical Data Schema Validation** - centralize parsing and validation for `.pain_flag`, snapshot ingress, and related state-file reads (SCHEMA-01, SCHEMA-02, SCHEMA-03)
- [x] **Phase 21: Runtime Contract and End-to-End Hardening** - remove constructor-name capability guessing, bound session selection by time, and lock the main path with contract tests (RT-01, RT-02, RT-03, E2E-01, E2E-02, E2E-03)
- [x] **Phase 22: BC-02 Residual Fallback Cleanup** - remove remaining `api.resolvePath('.')` fallbacks from secondary tool files (BC-02) (completed 2026-04-11)
- [ ] **Phase 23: v1.13 Phase Verification Completion** - generate VERIFICATION.md and SUMMARY.md for phases 19-21 (BC-01, BC-02, BC-03, SCHEMA-01, SCHEMA-02, SCHEMA-03, RT-01, RT-02, RT-03, E2E-01, E2E-02, E2E-03)

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

### Phase 22: BC-02 Residual Fallback Cleanup

**Goal:** eliminate the last two `api.resolvePath('.')` fallbacks in secondary tool files so BC-02 is fully satisfied.

**Depends on:** Phase 21

**Requirements:** BC-02

**Plans:** 1/1 plans complete

Plans:
- [x] 22-01-PLAN.md — Remove resolvePath fallback from deep-reflect.ts and critique-prompt.ts

**UAT:**
- `rg "api\.resolvePath" packages/openclaw-plugin/src` returns zero matches
- Both `deep-reflect.ts` and `critique-prompt.ts` use the shared workspace contract or fail explicitly

### Phase 23: v1.13 Phase Verification Completion

**Goal:** generate formal VERIFICATION.md and SUMMARY.md artifacts for phases 19-21 so all 11 milestone requirements move from "orphaned" to "satisfied."

**Depends on:** Phase 22

**Requirements:** BC-01, BC-02, BC-03, SCHEMA-01, SCHEMA-02, SCHEMA-03, RT-01, RT-02, RT-03, E2E-01, E2E-02, E2E-03

**UAT:**
- `.planning/phases/19-*/*-VERIFICATION.md` exists with `status: passed`
- `.planning/phases/20-*/*-VERIFICATION.md` exists with `status: passed`
- `.planning/phases/21-*/*-VERIFICATION.md` exists with `status: passed`
- All phase SUMMARY.md files contain `requirements-completed` frontmatter listing assigned REQ-IDs

### Deferred: v1.10 Thinking Models Page Optimization

This milestone is intentionally paused. It should not resume until the production nocturnal path is trustworthy.

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 03 | v1.9.3 | 1/1 | Complete | 2026-04-09 |
| 16 | v1.12 | 2/2 | Complete | 2026-04-10 |
| 17 | v1.12 | 1/1 | Complete | 2026-04-10 |
| 18 | v1.12 | 1/1 | Complete | 2026-04-10 |
| 19 | v1.13 | 2/2 | Local execution complete | 2026-04-11 |
| 20 | v1.13 | 2/2 | Local execution complete | 2026-04-11 |
| 21 | v1.13 | 1/1 | Local execution complete | 2026-04-11 |
| 22 | v1.13 | 1/1 | Complete    | 2026-04-11 |
| 23 | v1.13 | 0/1 | Gap closure (verification) | — |

*Last updated: 2026-04-11 after gap closure planning*
