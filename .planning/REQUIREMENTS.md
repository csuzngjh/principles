# Requirements: KeywordLearningEngine

**Defined:** 2026-04-14
**Core Value:** AI agents improve their own behavior through a structured evolution loop — pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## v1 Requirements

### Foundation

- [ ] **CORR-01**: System can load seed correction keywords (15 terms from detectCorrectionCue) into a keyword store
- [ ] **CORR-02**: System matches user text against keyword store and returns match result with confidence score
- [ ] **CORR-03**: System persists keyword store to `<stateDir>/correction_keywords.json` with atomic write (temp-file-then-rename)
- [ ] **CORR-04**: System maintains in-memory cache with invalidation on disk write
- [ ] **CORR-05**: System enforces store size limit (200 terms max)

### Learning Loop

- [ ] **CORR-06**: System tracks truePositiveCount and falsePositiveCount separately from hitCount
- [ ] **CORR-07**: System triggers LLM optimization via subagent workflow every 6 hours (time-based, not turn-based)
- [ ] **CORR-08**: System throttles optimization calls (max 4 per day)
- [ ] **CORR-09**: LLM optimizer can add, update, or remove keywords based on match history and FPR
- [ ] **CORR-10**: System decays keyword weight on confirmed false positive

### Integration

- [ ] **CORR-11**: Replace detectCorrectionCue() in prompt.ts with CorrectionCueLearner.match()
- [ ] **CORR-12**: Trajectory recording includes correctionDetected flag from keyword matcher

### Testing

- [ ] **CORR-13**: Integration test: matching + optimization + persistence cycle
- [ ] **CORR-14**: Atomic write recovery test: kill process mid-save, verify recoverable

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Personalization

- **CORR-15**: Per-user keyword adaptation (different correction expressions per user)
- **CORR-16**: Cross-workspace keyword sharing with per-workspace weighting

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Fuzzy/approximate matching | Increases false positives dramatically; accept exact match with LLM typo discovery |
| Real-time FPR updates | Too noisy; batch updates via subagent instead |
| Keyword auto-removal | Premature removal risk; LLM optimizer should decide with reasoning |
| Refactor empathy-keyword-matcher.ts | Separate refactor milestone; current empathy system works |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CORR-01 | Phase 38 | Pending |
| CORR-02 | Phase 39 | Pending |
| CORR-03 | Phase 38 | Pending |
| CORR-04 | Phase 38 | Pending |
| CORR-05 | Phase 38 | Pending |
| CORR-06 | Phase 39 | Pending |
| CORR-07 | Phase 39 | Pending |
| CORR-08 | Phase 39 | Pending |
| CORR-09 | Phase 40 | Pending |
| CORR-10 | Phase 39 | Pending |
| CORR-11 | Phase 38 | Pending |
| CORR-12 | Phase 40 | Pending |
| CORR-13 | Phase 41 | Pending |
| CORR-14 | Phase 41 | Pending |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-14*
*Last updated: 2026-04-14 after roadmap creation*
