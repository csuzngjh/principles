# Bloat Analysis Report

**Generated**: 2026-04-07
**Target**: /home/csuzngjh/code/principles

---

## Critical (Action Required)

### 1. `evolution-worker.ts` — 1,785 lines — GOD FILE
- Single file handles: pain detection, evolution queue, sleep reflection, detection funnel, rule promotion, worker lifecycle
- 22 imports (highest non-index file)
- **Action**: Split into `pain-detector.ts`, `queue-manager.ts`, `sleep-reflection-handler.ts`, `rule-promotion.ts`

### 2. `trajectory.ts` — 1,673 lines — GOD FILE
- Central SQLite wrapper managing 12+ record types (sessions, tool_calls, pain_events, principle_events, evolution_tasks, trust_changes)
- **Action**: Split by domain into `session-store.ts`, `event-store.ts`, `evolution-store.ts`

### 3. `index.ts` — **38 imports** — EXCESSIVE COUPLING
- Highest import count in codebase
- Imports from every module — classic god file anti-pattern
- **Action**: Extract facades per domain (pain-facade.ts, evolution-facade.ts)

### 4. `focus-history.ts` — 1,458 lines, 15+ `extract*` functions
- Violates Single Responsibility: working memory + history versioning + artifact extraction
- **Action**: Move `extract*` functions to `utils/` and split by purpose

### 5. 49 `normalize*` Functions Scattered Across Codebase
- Detected via grep: `function normalize` and `const normalize` patterns
- `normalizeTaskId`, `normalizeStatus`, `normalizeTimestamp` (phase3-input-filter.ts)
- `normalizePainCandidateText`, `normalizePainDedupKey` (evolution-worker.ts)
- `normalizePath`, `normalizeRiskPath` (utils/io.ts)
- **Action**: Consolidate into `utils/normalize.ts`

### 6. 28 `extract*` Functions Scattered Across Codebase
- Detected via grep: `function extract` and `const extract` patterns
- `focus-history.ts` alone has 10+ extract functions
- `extractCommonPhrases`, `extractCommonSubstring` (utils/nlp.ts)
- `extractEvolutionTaskId` (evolution-worker.ts)
- **Action**: Create `utils/extract.ts` shared module

---

## Warning (Review)

### 7. `node_modules` — 237M
- Notable fat packages: `lucide-react` (30M), `@typescript-eslint/*` (~6M combined), `vitest` (2.1M), `react-router` (4.1M), `@testing-library/dom` (2.3M)
- Dev dependencies may be bundled in production
- **Action**: Verify bundling excludes dev deps, run `npm prune`

### 8. `ops/ai-sprints/` — 50MB, 91 subdirectories, no cleanup policy
- Sprint worktree directories accumulating
- **Action**: Add cron job to clean dirs older than 7 days, or add to gitignore

### 9. Build artifacts not gitignored
- `packages/openclaw-plugin/dist/` — 2.5M
- `packages/openclaw-plugin/coverage/` — 3.4M
- `packages/openclaw-plugin/*.tgz` — 348KB
- **Action**: Add to `.gitignore`

### 10. Documentation bloat
- `docs/design/team-orchestration-system-v3.md` — 172KB (DRAFT, not implemented)
- `docs/archive/` — large accumulation of design docs and evidence files
- **Action**: Archive or remove stale drafts

---

## Observations (Low Priority)

### 11. Dead Code Check: `empathy-observer-workflow-manager`
- **Result**: No files reference this module
- **Assessment**: Likely dead code candidate for removal

### 12. `shadow-observation-registry` — ACTIVE
- Used in 4 files:
  - `core/detection-funnel.ts`
  - `core/detection-service.ts`
  - `service/subagent-workflow/index.ts`
  - `service/evolution-worker.ts`
  - `hooks/subagent.ts`
- Not dead code

### 13. `detection-funnel` — ACTIVE
- Used in 5 files:
  - `commands/nocturnal-rollout.ts`
  - `core/shadow-observation-registry.ts`
  - `core/promotion-gate.ts`
  - `index.ts`
- Not dead code

### 14. Nocturnal Trinity — ~6,000 lines across 12+ files
- Core purpose: training data generation pipeline (Dreamer→Philosopher→Scribe)
- Not core to "pain→evolution→principle" signal chain
- **Assessment**: Research/experimental feature, could be optional plugin

---

## Summary Stats

### Largest TypeScript Files (by line count)

| Lines | File |
|-------|------|
| 1,785 | `service/evolution-worker.ts` |
| 1,673 | `core/trajectory.ts` |
| 1,458 | `core/focus-history.ts` |
| 1,384 | `core/nocturnal-trinity.ts` |
| 1,075 | `core/nocturnal-compliance.ts` |
| 1,015 | `service/nocturnal-service.ts` |
| 1,002 | `commands/nocturnal-train.ts` |
| 920 | `hooks/prompt.ts` |
| 888 | `service/control-ui-query-service.ts` |
| 856 | `service/subagent-workflow/nocturnal-workflow-manager.ts` |

### Largest Documentation Files

| Size | File |
|------|------|
| 172KB | `docs/design/team-orchestration-system-v3.md` |
| 168KB | `docs/archive/design/sleep-mode-reflection-system.md` |
| 76KB | `docs/archive/design/evolution-points-system.md` |
| 44KB | `docs/archive/evidence/trust-system-full-analysis.md` |
| 36KB | `docs/reviews/architecture-review.md` |
| 32KB | `docs/archive/issue-pd-run-worker-subagent-unavailable.md` |
| 32KB | `docs/archive/fixes/ISSUE-19-fix-proposal.md` |
| 32KB | `docs/archive/evidence/evolution-worker-analysis.md` |
| 28KB | `docs/maps/developer-file-index.md` |
| 28KB | `docs/archive/plans/evolution-points-roadmap.md` |

### Build & Storage

| Metric | Value |
|--------|-------|
| `node_modules` (openclaw-plugin) | 237M |
| `ops/ai-sprints/` | 50MB, 91 subdirs |
| `dist/` | 2.5M |
| `coverage/` | 3.4M |
| `*.tgz` | 348KB |
| Total TypeScript | 45,398 lines |

### Import Coupling Top Offenders

| Imports | File |
|---------|------|
| 38 | `index.ts` |
| 22 | `service/evolution-worker.ts` |
| 13 | `hooks/pain.ts` |
| 13 | `hooks/gate.ts` |
| 12 | `service/nocturnal-service.ts` |
| 12 | `hooks/prompt.ts` |
| 11 | `service/subagent-workflow/nocturnal-workflow-manager.ts` |
| 11 | `commands/nocturnal-train.ts` |

### Duplicate Code Count

| Pattern | Count |
|---------|-------|
| `normalize*` functions | 49 |
| `extract*` functions | 28 |

---

## Recommended Cleanup Order

1. **Immediate**: Add `dist/`, `coverage/`, `*.tgz` to `.gitignore`
2. **Immediate**: Investigate `empathy-observer-workflow-manager` for removal (no references found)
3. **Short-term**: Consolidate `normalize*` functions into `utils/normalize.ts`
4. **Short-term**: Consolidate `extract*` functions into `utils/extract.ts`
5. **Short-term**: Add `ops/ai-sprints` cleanup policy
6. **Medium-term**: Split `evolution-worker.ts` (1,785 lines → 4+ files)
7. **Medium-term**: Split `trajectory.ts` (1,673 lines → 3 store files)
8. **Medium-term**: Extract `index.ts` facades (38 imports → domain groups)
9. **Long-term**: Consider moving Nocturnal to optional plugin
