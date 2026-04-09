# Requirements: Principles Disciple

**Defined:** 2026-04-09
**Core Value:** AI agents improve their own behavior through a structured evolution loop: pain → diagnosis → principle → gate → active → reflection → training → internalization

## v1.10 Requirements

### Data Visualization

- [ ] **VIZ-01**: Overview page displays coverage rate trend chart (daily time series)
- [ ] **VIZ-02**: Model detail page displays usage trend chart (daily hits over time)
- [ ] **VIZ-03**: Overview page displays scenario heatmap (model × scenario cross-tab)
- [ ] **VIZ-04**: Empty states show helpful messages with charts where appropriate

### Dormant Model Visibility

- [ ] **DORM-01**: Overview page shows list of dormant models (zero hits) with name and description
- [ ] **DORM-02**: Dormant models section is collapsible and visually distinct from active models

### Recommendation Badges

- [ ] **REC-01**: Recommendation badges are color-coded (reinforce=green, rework=yellow, archive=gray)
- [ ] **REC-02**: Model list supports filtering by recommendation type
- [ ] **REC-03**: Effective models are visually distinguished in the overview

### Event Context Display

- [ ] **EVT-01**: Recent events display toolContext (tool name, outcome, error type)
- [ ] **EVT-02**: Recent events display painContext (source, score) when present
- [ ] **EVT-03**: Recent events display principleContext (principle ID, event type) when present
- [ ] **EVT-04**: Matched regex pattern is shown for each event

### THINKING_OS.md Content Display

- [ ] **TOS-01**: Model detail page shows trigger conditions (when the model activates)
- [ ] **TOS-02**: Model detail page shows anti-patterns (forbidden behaviors)
- [ ] **TOS-03**: THINKING_OS.md source workspace path is shown in the page header

### Model Comparison

- [ ] **CMP-01**: User can select 2+ models for side-by-side comparison
- [ ] **CMP-02**: Comparison view shows hits, success rate, failure rate, pain rate, correction rate
- [ ] **CMP-03**: Comparison view shows usage trends overlaid

### Search & Filtering

- [ ] **SRCH-01**: Model list supports text search by name or scenario
- [ ] **SRCH-02**: Model list supports sorting by hits, success rate, or name

### THINKING_OS.md Consistency

- [ ] **SYNC-01**: THINKING_OS.md template includes all 10 directives (T-01 through T-10)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced Features

- **ADV-01**: Custom thinking model definition editor (edit THINKING_OS.md from UI)
- **ADV-02**: Model effectiveness score over time with trend analysis
- **ADV-03**: Correlation analysis between thinking model usage and pain events
- **ADV-04**: Export thinking model data as CSV

## Out of Scope

| Feature | Reason |
|---------|--------|
| Backend schema changes | All required data already exists in DB views |
| New API endpoints | Existing endpoints return all needed data |
| Mobile responsive redesign | Desktop-only admin tool for now |
| Real-time WebSocket updates | Polling-based refresh is sufficient |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| VIZ-01 | Phase 1 | Pending |
| VIZ-02 | Phase 2 | Pending |
| VIZ-03 | Phase 1 | Pending |
| VIZ-04 | Phase 1 | Pending |
| DORM-01 | Phase 3 | Pending |
| DORM-02 | Phase 3 | Pending |
| REC-01 | Phase 3 | Pending |
| REC-02 | Phase 3 | Pending |
| REC-03 | Phase 3 | Pending |
| EVT-01 | Phase 4 | Pending |
| EVT-02 | Phase 4 | Pending |
| EVT-03 | Phase 4 | Pending |
| EVT-04 | Phase 4 | Pending |
| TOS-01 | Phase 5 | Pending |
| TOS-02 | Phase 5 | Pending |
| TOS-03 | Phase 5 | Pending |
| CMP-01 | Phase 6 | Pending |
| CMP-02 | Phase 6 | Pending |
| CMP-03 | Phase 6 | Pending |
| SRCH-01 | Phase 7 | Pending |
| SRCH-02 | Phase 7 | Pending |
| SYNC-01 | Phase 8 | Pending |

**Coverage:**
- v1.10 requirements: 22 total
- Mapped to phases: 22
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-09*
*Last updated: 2026-04-09 after v1.10 milestone started*
