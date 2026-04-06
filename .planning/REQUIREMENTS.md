# Requirements: v1.3 Workflow Skill Internal Usability

**Defined:** 2026-04-06  
**Core Value:** make `ai-sprint-orchestrator` usable as a packaged internal skill before introducing the next work-unit architecture layer.

## v1.3 Requirements

### Skill Stability

- [ ] **STAB-01**: package-local self-check passes in the packaged skill entrypoint
- [ ] **STAB-02**: `workflow-validation-minimal` runs through the packaged skill entrypoint and produces a structured halt or decision
- [ ] **STAB-03**: `workflow-validation-minimal-verify` runs through the packaged skill entrypoint and produces a structured halt or decision
- [ ] **STAB-04**: failure classification is persisted to both `latest-summary.md` and `scorecard.json`
- [ ] **STAB-05**: validation failures are explicitly classified as `workflow bug`, `agent behavior issue`, `environment issue`, or `sample-spec issue`

### Complex Task Readiness

- [ ] **TASK-01**: package-local complex bugfix template exists and loads
- [ ] **TASK-02**: package-local complex feature template exists and loads
- [ ] **TASK-03**: complex specs require a minimum task contract: `Goal`, `In scope`, `Out of scope`, `Validation commands`, `Expected artifacts`
- [ ] **TASK-04**: unfilled template specs are rejected before sprint start
- [ ] **TASK-05**: reviewer prompts explicitly judge behavioral value and unverified risks, not only report structure

### Continuation Discipline

- [ ] **FLOW-01**: stage carry-forward prefers `checkpoint-summary.md` over full prior decision text
- [ ] **FLOW-02**: complex specs can declare execution scope limits for files, checks, and deliverables
- [ ] **FLOW-03**: producer prompt requires a scoped execution declaration before edits
- [ ] **FLOW-04**: validation and complex task flows classify-and-stop on product-side or sample-side gaps

### Documentation

- [ ] **DOC-01**: `SKILL.md` reflects internal smoke standards and complex task entry rules
- [ ] **DOC-02**: `REFERENCE.md` documents failure classification, minimum task contract, execution scope limits, checkpoint summary, and next architecture direction
- [ ] **DOC-03**: `EXAMPLES.md` shows validation, failure classification, complex templates, and continuation via checkpoint summary

## Stop Boundaries

If a validation run or complex task attempt hits one of the following, classify it and stop instead of expanding scope:

| Category | Allowed action | Stop action |
|----------|----------------|-------------|
| workflow bug | fix packaged workflow plumbing or source orchestrator plumbing | do not expand into product closure |
| agent behavior issue | adjust agent profile, fallback, or prompt discipline | do not special-case behavior in product code |
| environment issue | classify and require operator intervention | do not auto-repair the environment |
| sample-spec issue | classify and stop the run | do not edit `packages/openclaw-plugin` or `D:/Code/openclaw` |

## Out of Scope

| Feature | Reason |
|---------|--------|
| `packages/openclaw-plugin` fixes | known sample-side gaps; not part of workflow-skill internalization |
| `D:/Code/openclaw` changes | outside this repo |
| dashboard / stageGraph / self-optimizing sprint / multi-task parallelism | future work, not v1.3 |
| full work-unit/tasklet engine | next milestone, not this round |
| orchestrator redesign | v1.3 is internal usability hardening, not a rewrite |

## Traceability

| Requirement group | Phase | Status |
|-------------------|-------|--------|
| STAB-01 to STAB-05 | Phase 1 | In progress |
| TASK-01 to TASK-05 | Phase 2 | In progress |
| FLOW-01 to FLOW-04 | Phase 3 | In progress |
| DOC-01 to DOC-03 | Cross-cutting | In progress |

---
*Last updated: 2026-04-06*
