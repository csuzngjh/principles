# Requirements: Principles Disciple - v1.9.3 Lint 修复

**Defined:** 2026-04-09
**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## v1.9.3 Requirements

### Lint Error Resolution

- [ ] **LINT-11**: Execute eslint-disable suppression for remaining ~700 errors across 57 files
- [ ] **LINT-12**: Mechanical fix for prefer-destructuring errors (~50 errors)
- [ ] **LINT-13**: Verify CI lint step passes with 0 errors
- [ ] **LINT-14**: Update SUPPRESSION-LEDGER.md with all suppressions and reasons

### Deferred from v1.9.2

- [ ] **LINT-09**: Inline helpers extraction (complex refactoring, future phase)
- [ ] **LINT-10**: Complexity rules (deferred to v2)

## Out of Scope

| Feature | Reason |
|---------|--------|
| LINT-09 inline helpers | 需要架构级重构，延期到未来阶段 |
| LINT-10 complexity rules | 项目约定，延期到 v2 |
| 新功能开发 | 本次仅关注 lint 修复 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| LINT-11 | 03 | Pending |
| LINT-12 | 03 | Pending |
| LINT-13 | 03 | Pending |
| LINT-14 | 03 | Pending |

**Coverage:**
- v1.9.3 requirements: 4 total
- Mapped to phases: 4 (100%)
- Unmapped: 0

---
*Requirements defined: 2026-04-09*
*Last updated: 2026-04-09 after v1.9.3 milestone initialized*
