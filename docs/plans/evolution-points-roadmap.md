# Evolution Points System - Implementation Roadmap

> **Version**: 1.0.0
> **Status**: Ready
> **Created**: 2026-03-12
> **Project**: Principles Disciple v1.6.0
> **Target Release**: v2.0.0 (Major Feature)

---

## 📋 Executive Summary

This roadmap outlines the implementation of the **Evolution Points (EP) System**—a gamification layer that rewards positive agent behaviors to complement the existing penalty-based pain detection system. The implementation will span **6 phases over 8 weeks**, delivering a balanced carrot-and-stick approach to agent self-improvement.

### Key Objectives

- **5+ PR Deliverables**: Each phase produces independently reviewable code
- **Incremental Value**: Core functionality usable after Phase 2
- **Test Coverage**: ≥70% for all new components
- **Backward Compatibility**: Zero breaking changes to existing systems
- **Parallel Execution**: Non-dependent tasks can run concurrently

---

## 🎯 Milestones

### M1: Core Foundation (Week 2)
**Acceptance Criteria**:
- [x] Points can be added/deducted via API
- [x] EP balance persists to `.state/EVOLUTION_POINTS.json`
- [x] Basic rule engine with cooldowns functional
- [x] Unit test coverage ≥80% for core operations
- [x] PR-1 merged and reviewed

**PR**: `feat/ep-core-foundation` (2 files, ~400 LOC)

---

### M2: Reward Detection (Week 3)
**Acceptance Criteria**:
- [x] `RewardDetectionService` detects task completions
- [x] Hooks automatically reward successful actions
- [x] Basic achievement unlocking works
- [x] End-to-end test: action → reward → EP balance update
- [x] PR-2 merged and reviewed

**PR**: `feat/ep-reward-detection` (3 files, ~600 LOC)

---

### M3: Leveling System (Week 4)
**Acceptance Criteria**:
- [x] Levels calculate correctly based on EP balance
- [x] Level-up events trigger notifications
- [x] Titles assigned correctly (Novice → Apprentice → Practitioner...)
- [x] Streak tracking functional with bonuses
- [x] PR-3 merged and reviewed

**PR**: `feat/ep-leveling-system` (2 files, ~350 LOC)

---

### M4: UI Integration (Week 5)
**Acceptance Criteria**:
- [x] Status bar displays current level and EP balance
- [x] Achievement toast notifications appear
- [x] Progress bar visualizes progress to next level
- [x] Stats panel shows detailed EP history
- [x] PR-4 merged and reviewed

**PR**: `feat/ep-ui-integration` (4 files, ~800 LOC)

---

### M5: Advanced Features (Week 6-7)
**Acceptance Criteria**:
- [x] Daily decay mechanism active (5% daily)
- [x] Hidden achievements unlockable
- [x] Advanced analytics dashboard
- [x] Configurable decay rates via PROFILE.json
- [x] PR-5 merged and reviewed

**PR**: `feat/ep-advanced-features` (3 files, ~550 LOC)

---

### M6: Testing & Polish (Week 8)
**Acceptance Criteria**:
- [x] Integration test suite complete (≥15 scenarios)
- [x] E2E tests cover full EP workflow
- [x] Documentation updated (User Guide + API Reference)
- [x] Performance benchmarks met (<5ms overhead per action)
- [x] PR-6 merged and reviewed

**PR**: `test/ep-testing-suite` (8 files, ~700 LOC + docs)

---

### M7: Launch & Monitor (Week 9)
**Acceptance Criteria**:
- [x] Feature flag in PROFILE.json (`evolution_points.enabled`)
- [x] Telemetry collection for EP system health
- [x] User feedback channel established
- [x] Rollback plan documented and tested
- [x] PR-7 merged (configuration + monitoring)

**PR**: `feat/ep-launch-config` (2 files, ~200 LOC + docs)

---

## 📊 Work Breakdown Structure (WBS)

### Phase 1: Core Foundation (Week 1-2)

#### EP-1.1: Points Engine Service
**Effort**: 2 days | **Agent**: Implementer | **Dependencies**: None

**Tasks**:
- [ ] Create `EvolutionPoints.ts` class with add/deduct/getBalance methods
- [ ] Implement cooldown tracking with in-memory cache
- [ ] Add persistence layer for `.state/EVOLUTION_POINTS.json`
- [ ] Implement history tracking (last 1000 events)
- [ ] Add error handling for corrupted state files

**Deliverable**: `packages/openclaw-plugin/src/service/evolution-points.ts`

---

#### EP-1.2: Rule Engine
**Effort**: 1 day | **Agent**: Implementer | **Dependencies**: EP-1.1

**Tasks**:
- [ ] Define `EvolutionPointRule` interface
- [ ] Implement rule registry with point values and cooldowns
- [ ] Create rule executor with condition evaluation
- [ ] Add rule conflict resolution (multiple rules match)
- [ ] Implement rule configuration loading from PROFILE.json

**Deliverable**: `packages/openclaw-plugin/src/core/ep-rule-engine.ts`

---

#### EP-1.3: Unit Tests
**Effort**: 1.5 days | **Agent**: Implementer | **Dependencies**: EP-1.1, EP-1.2

**Tasks**:
- [ ] Test add/deduct operations (5 test cases)
- [ ] Test cooldown enforcement (3 test cases)
- [ ] Test persistence and recovery (3 test cases)
- [ ] Test history tracking (2 test cases)
- [ ] Test corrupted state recovery (2 test cases)

**Deliverable**: `packages/openclaw-plugin/tests/service/evolution-points.test.ts`

---

#### EP-1.4: Integration Testing
**Effort**: 0.5 days | **Agent**: Implementer | **Dependencies**: EP-1.3

**Tasks**:
- [ ] Setup test workspace with EP state
- [ ] Verify EP file created on first run
- [ ] Verify state survives agent restart
- [ ] Cleanup test artifacts

**Deliverable**: `tests/feature-testing/ep-core-integration.test.ts`

---

### Phase 2: Reward Detection (Week 3)

#### EP-2.1: Reward Detection Service
**Effort**: 2 days | **Agent**: Implementer | **Dependencies**: EP-1.2

**Tasks**:
- [ ] Create `RewardDetectionService` class
- [ ] Implement `detectTaskCompletion()` method
- [ ] Implement `detectLearningEvent()` method
- [ ] Implement `detectQualityMetric()` method
- [ ] Implement `detectUserFeedback()` method

**Deliverable**: `packages/openclaw-plugin/src/service/reward-detection.ts`

---

#### EP-2.2: Hook Integration
**Effort**: 1.5 days | **Agent**: Implementer | **Dependencies**: EP-2.1

**Tasks**:
- [ ] Modify `hook.ts` to call reward detection on action completion
- [ ] Add EP reward to action result metadata
- [ ] Ensure non-blocking (async reward processing)
- [ ] Add EP logging to event log

**Deliverable**: `packages/openclaw-plugin/src/hook.ts` (modified)

---

#### EP-2.3: Basic Achievement System
**Effort**: 1 day | **Agent**: Implementer | **Dependencies**: EP-1.1

**Tasks**:
- [ ] Create achievement definition interface
- [ ] Implement achievement registry
- [ ] Create achievement unlock logic
- [ ] Implement achievement storage in EP state
- [ ] Add basic achievements (First Steps, Task Master)

**Deliverable**: `packages/openclaw-plugin/src/core/ep-achievements.ts`

---

#### EP-2.4: E2E Reward Workflow Test
**Effort**: 0.5 days | **Agent**: Implementer | **Dependencies**: EP-2.2

**Tasks**:
- [ ] Create test scenario: successful edit → reward → EP balance update
- [ ] Verify achievement unlocks
- [ ] Verify history recorded
- [ ] Verify cooldown enforced

**Deliverable**: `tests/feature-testing/ep-reward-e2e.test.ts`

---

### Phase 3: Leveling System (Week 4)

#### EP-3.1: Level Calculation
**Effort**: 1.5 days | **Agent**: Implementer | **Dependencies**: EP-1.1

**Tasks**:
- [ ] Implement level threshold calculation
- [ ] Create level-up detection logic
- [ ] Implement title assignment (Novice → Apprentice...)
- [ ] Add level to EP state
- [ ] Create level configuration (thresholds, titles)

**Deliverable**: `packages/openclaw-plugin/src/core/ep-leveling.ts`

---

#### EP-3.2: Streak Tracking
**Effort**: 1 day | **Agent**: Implementer | **Dependencies**: EP-3.1

**Tasks**:
- [ ] Implement daily activity detection
- [ ] Track streak counter
- [ ] Calculate streak bonuses (+2 EP/day)
- [ ] Handle streak breaks (reset to 0)
- [ ] Add streak to EP state

**Deliverable**: Modified `packages/openclaw-plugin/src/service/evolution-points.ts`

---

#### EP-3.3: Notification System
**Effort**: 0.5 days | **Agent**: Implementer | **Dependencies**: EP-3.1

**Tasks**:
- [ ] Create level-up event type
- [ ] Emit notification on level change
- [ ] Add notification to event log
- [ ] Format notification message

**Deliverable**: `packages/openclaw-plugin/src/core/ep-notifications.ts`

---

#### EP-3.4: Level System Tests
**Effort**: 1 day | **Agent**: Implementer | **Dependencies**: EP-3.2

**Tasks**:
- [ ] Test level calculation (5 test cases)
- [ ] Test level-up triggers (3 test cases)
- [ ] Test streak tracking (4 test cases)
- [ ] Test title assignment (3 test cases)
- [ ] Test streak bonus calculation (2 test cases)

**Deliverable**: `packages/openclaw-plugin/tests/core/ep-leveling.test.ts`

---

### Phase 4: UI Integration (Week 5)

#### EP-4.1: Status Bar Component
**Effort**: 1.5 days | **Agent**: Implementer | **Dependencies**: EP-3.1

**Tasks**:
- [ ] Create status bar item for level/EP display
- [ ] Format EP balance (e.g., "L3: 1,250 EP")
- [ ] Update on EP balance change
- [ ] Add tooltip with level info
- [ ] Style to match existing UI

**Deliverable**: `packages/openclaw-plugin/src/ui/ep-statusbar.ts`

---

#### EP-4.2: Achievement Toast
**Effort**: 1 day | **Agent**: Implementer | **Dependencies**: EP-2.3

**Tasks**:
- [ ] Create toast notification component
- [ ] Display achievement name and icon
- [ ] Auto-dismiss after 5 seconds
- [ ] Animation on appearance
- [ ] Dismiss on click

**Deliverable**: `packages/openclaw-plugin/src/ui/ep-toast.ts`

---

#### EP-4.3: Progress Visualization
**Effort**: 1 day | **Agent**: Implementer | **Dependencies**: EP-3.1

**Tasks**:
- [ ] Create progress bar component
- [ ] Calculate progress to next level
- [ ] Display current/next level titles
- [ ] Animate progress changes
- [ ] Add progress percentage

**Deliverable**: `packages/openclaw-plugin/src/ui/ep-progress.ts`

---

#### EP-4.4: Stats Panel
**Effort**: 1.5 days | **Agent**: Implementer | **Dependencies**: EP-1.1

**Tasks**:
- [ ] Create stats panel view
- [ ] Display EP history table
- [ ] Show achievements list
- [ ] Display streak info
- [ ] Add filter/sort options

**Deliverable**: `packages/openclaw-plugin/src/ui/ep-stats-panel.ts`

---

### Phase 5: Advanced Features (Week 6-7)

#### EP-5.1: Daily Decay System
**Effort**: 1.5 days | **Agent**: Implementer | **Dependencies**: EP-1.1

**Tasks**:
- [ ] Implement daily decay logic (-5% of balance)
- [ ] Add decay floor (-1 EP min, 0 EP floor)
- [ ] Implement decay pausing for active users
- [ ] Add lastActive timestamp tracking
- [ ] Schedule daily decay via EvolutionWorker

**Deliverable**: Modified `packages/openclaw-plugin/src/service/evolution-points.ts`

---

#### EP-5.2: Hidden Achievements
**Effort**: 1 day | **Agent**: Implementer | **Dependencies**: EP-2.3

**Tasks**:
- [ ] Define hidden achievement conditions
- [ ] Implement stealth detection (no notifications)
- [ ] Store hidden achievements separately
- [ ] Add reveal mechanism (when unlocked)
- [ ] Create 3-5 hidden achievements

**Deliverable**: Modified `packages/openclaw-plugin/src/core/ep-achievements.ts`

---

#### EP-5.3: Advanced Analytics
**Effort**: 2 days | **Agent**: Implementer | **Dependencies**: EP-1.1

**Tasks**:
- [ ] Create analytics aggregation service
- [ ] Calculate EP earned per day/week/month
- [ ] Calculate average earning rate
- [ ] Calculate achievement completion rate
- [ ] Generate charts/visualizations

**Deliverable**: `packages/openclaw-plugin/src/core/ep-analytics.ts`

---

#### EP-5.4: Configurable Decay
**Effort**: 0.5 days | **Agent**: Implementer | **Dependencies**: EP-5.1

**Tasks**:
- [ ] Add decay settings to PROFILE.json schema
- [ ] Implement configuration loading
- [ ] Allow decay rate customization
- [ ] Add decay toggle (enable/disable)
- [ ] Update documentation

**Deliverable**: Modified PROFILE.json schema + docs

---

### Phase 6: Testing & Polish (Week 8)

#### EP-6.1: Integration Test Suite
**Effort**: 2 days | **Agent**: Implementer | **Dependencies**: All prior phases

**Tasks**:
- [ ] Create 15+ integration test scenarios
- [ ] Test full EP workflow (action → reward → level up)
- [ ] Test decay mechanism
- [ ] Test achievement unlocking
- [ ] Test configuration changes

**Deliverable**: `tests/integration/ep-full-suite.test.ts`

---

#### EP-6.2: E2E Tests
**Effort**: 1.5 days | **Agent**: Implementer | **Dependencies**: EP-6.1

**Tasks**:
- [ ] Test agent bootstrapping with EP
- [ ] Test EP persistence across restarts
- [ ] Test UI component rendering
- [ ] Test notification display
- [ ] Test stats panel functionality

**Deliverable**: `tests/e2e/ep-ui-e2e.test.ts`

---

#### EP-6.3: Performance Benchmarking
**Effort**: 1 day | **Agent**: Implementer | **Dependencies**: EP-6.1

**Tasks**:
- [ ] Benchmark EP add/deduct operations (<1ms)
- [ ] Benchmark cooldown checks (<0.5ms)
- [ ] Benchmark reward detection (<5ms total overhead)
- [ ] Identify bottlenecks and optimize
- [ ] Create performance baseline report

**Deliverable**: `tests/performance/ep-benchmarks.test.ts`

---

#### EP-6.4: Documentation
**Effort**: 1.5 days | **Agent**: Implementer | **Dependencies**: All features complete

**Tasks**:
- [ ] Update USER_GUIDE.md with EP section
- [ ] Create API reference for EP service
- [ ] Add configuration examples to ADVANCED_CONFIG.md
- [ ] Create troubleshooting guide
- [ ] Add EP system to README features

**Deliverable**: `docs/user-guide/evolution-points.md` + updated docs

---

### Phase 7: Launch & Monitor (Week 9)

#### EP-7.1: Feature Flag
**Effort**: 0.5 days | **Agent**: Implementer | **Dependencies**: EP-6.4

**Tasks**:
- [ ] Add `evolution_points.enabled` to PROFILE.json
- [ ] Implement feature flag check in all EP code
- [ ] Ensure graceful degradation when disabled
- [ ] Add startup logging for EP status

**Deliverable**: Modified `packages/openclaw-plugin/src/core/init.ts`

---

#### EP-7.2: Telemetry Collection
**Effort**: 1 day | **Agent**: Implementer | **Dependencies**: EP-7.1

**Tasks**:
- [ ] Define EP telemetry events
- [ ] Implement anonymized EP data collection
- [ ] Add opt-in/opt-out mechanism
- [ ] Create health check metrics
- [ ] Add dashboard queries

**Deliverable**: `packages/openclaw-plugin/src/core/ep-telemetry.ts`

---

#### EP-7.3: Rollback Plan
**Effort**: 0.5 days | **Agent**: Implementer | **Dependencies**: EP-7.1

**Tasks**:
- [ ] Document rollback procedure
- [ ] Create EP state cleanup script
- [ ] Test rollback in staging environment
- [ ] Create rollback checklist

**Deliverable**: `docs/operations/ep-rollback-plan.md`

---

#### EP-7.4: Launch Preparation
**Effort**: 1 day | **Agent**: Implementer | **Dependencies**: EP-7.2

**Tasks**:
- [ ] Create launch announcement
- [ ] Prepare changelog entry
- [ ] Update version to v2.0.0
- [ ] Prepare release notes
- [ ] Schedule launch window

**Deliverable**: Release notes + announcement

---

## 🚀 PR Splitting Strategy

Each PR is designed to be **independently reviewable** and **mergeable without blocking**:

### PR-1: Core Foundation (`feat/ep-core-foundation`)
**Files**: 2 new files
**LOC**: ~400
**Review Time**: ~45 minutes
**Risk**: Low (isolated service)

```
packages/openclaw-plugin/src/service/evolution-points.ts    (NEW)
packages/openclaw-plugin/tests/service/evolution-points.test.ts   (NEW)
```

---

### PR-2: Reward Detection (`feat/ep-reward-detection`)
**Files**: 3 files (2 new, 1 modified)
**LOC**: ~600
**Review Time**: ~60 minutes
**Risk**: Medium (hook integration)

```
packages/openclaw-plugin/src/service/reward-detection.ts    (NEW)
packages/openclaw-plugin/src/core/ep-achievements.ts         (NEW)
packages/openclaw-plugin/src/hook.ts                          (MODIFIED)
```

---

### PR-3: Leveling System (`feat/ep-leveling-system`)
**Files**: 2 files (1 new, 1 modified)
**LOC**: ~350
**Review Time**: ~45 minutes
**Risk**: Low (isolated logic)

```
packages/openclaw-plugin/src/core/ep-leveling.ts             (NEW)
packages/openclaw-plugin/src/service/evolution-points.ts    (MODIFIED)
```

---

### PR-4: UI Integration (`feat/ep-ui-integration`)
**Files**: 4 new files
**LOC**: ~800
**Review Time**: ~75 minutes
**Risk**: Medium (UI changes)

```
packages/openclaw-plugin/src/ui/ep-statusbar.ts              (NEW)
packages/openclaw-plugin/src/ui/ep-toast.ts                   (NEW)
packages/openclaw-plugin/src/ui/ep-progress.ts                (NEW)
packages/openclaw-plugin/src/ui/ep-stats-panel.ts             (NEW)
```

---

### PR-5: Advanced Features (`feat/ep-advanced-features`)
**Files**: 3 files (1 new, 2 modified)
**LOC**: ~550
**Review Time**: ~60 minutes
**Risk**: Medium (logic changes)

```
packages/openclaw-plugin/src/core/ep-analytics.ts            (NEW)
packages/openclaw-plugin/src/core/ep-achievements.ts         (MODIFIED)
packages/openclaw-plugin/src/service/evolution-points.ts    (MODIFIED)
```

---

### PR-6: Testing & Polish (`test/ep-testing-suite`)
**Files**: 8 files (6 new, 2 modified)
**LOC**: ~700
**Review Time**: ~90 minutes
**Risk**: Low (tests only)

```
tests/integration/ep-full-suite.test.ts                      (NEW)
tests/e2e/ep-ui-e2e.test.ts                                   (NEW)
tests/performance/ep-benchmarks.test.ts                       (NEW)
packages/openclaw-plugin/tests/core/ep-leveling.test.ts       (NEW)
docs/user-guide/evolution-points.md                          (NEW)
USER_GUIDE.md                                                 (MODIFIED)
ADVANCED_CONFIG.md                                            (MODIFIED)
```

---

### PR-7: Launch & Monitor (`feat/ep-launch-config`)
**Files**: 2 files (1 new, 1 modified)
**LOC**: ~200
**Review Time**: ~30 minutes
**Risk**: Low (configuration)

```
packages/openclaw-plugin/src/core/ep-telemetry.ts            (NEW)
packages/openclaw-plugin/src/core/init.ts                     (MODIFIED)
docs/operations/ep-rollback-plan.md                          (NEW)
CHANGELOG.md                                                  (MODIFIED)
```

---

## ⚠️ Risk Matrix

| Risk | Likelihood | Impact | Severity | Mitigation Strategy |
|------|------------|--------|----------|-------------------|
| **PR Rejection** | Medium | Medium | ⚠️ Moderate | Early drafts with implementer, clear commit messages, incremental reviews |
| **Performance Overhead** | Low | High | ⚠️ Moderate | Async processing, benchmarks, configurable sampling rate |
| **User Confusion** | Medium | Medium | ⚠️ Moderate | Clear documentation, feature flag default to disabled, gradual rollout |
| **Gaming the System** | Medium | Medium | ⚠️ Moderate | Cooldowns, quality thresholds, diminishing returns, hidden metrics |
| **Data Corruption** | Low | High | ⚠️ Moderate | Atomic writes, validation, recovery procedures, backup before migration |
| **UI Clutter** | Medium | Low | 🟢 Low | Minimal UI by default, opt-in rich UI, clean status bar |
| **Feature Bloat** | Medium | Medium | ⚠️ Moderate | Phase 7+ features optional, keep core simple, user feedback loop |
| **Migration Failures** | Low | High | ⚠️ Moderate | Test in staging, rollback plan, backward compatible data format |

### Risk Response Plans

#### R1: PR Rejection Response
**Trigger**: PR rejected with major feedback
**Response**:
1. Implementer reviews feedback within 24 hours
2. Schedule follow-up meeting if clarification needed
3. Create revision plan with clear acceptance criteria
4. Re-submit with detailed response to feedback
5. If rejected 2x, escalate to diagnostician for root cause analysis

#### R2: Performance Overhead Response
**Trigger**: Benchmarks show >10ms overhead per action
**Response**:
1. Profile to identify bottlenecks
2. Move reward detection to async queue
3. Reduce logging frequency
4. Implement sampling (track 10% of actions in prod)
5. Consider feature flag to disable in performance-critical workflows

#### R3: User Confusion Response
**Trigger**: User feedback or telemetry shows confusion
**Response**:
1. Add in-app tooltips and help text
2. Create tutorial/walkthrough
3. Update FAQ with common questions
4. Simplify UI (hide advanced features by default)
5. Consider resetting EP balance if too complex

#### R4: Gaming the System Response
**Trigger**: Anomaly detection shows suspicious EP farming
**Response**:
1. Add validation for rapid low-value actions
2. Implement rate limiting per rule
3. Add CAPTCHA for suspicious patterns
4. Manual review for high-value achievements
5. Ban repeat offenders from EP system

#### R5: Data Corruption Response
**Trigger**: EP state file corrupted or unreadable
**Response**:
1. Detect corruption on startup (JSON parse error)
2. Restore from backup (.backup files in `.state/`)
3. If no backup, reset to default (0 EP, level 1)
4. Log error and notify user
5. Investigate root cause (concurrent write, disk error)

#### R6: Migration Failures Response
**Trigger**: Version upgrade causes data incompatibility
**Response**:
1. Add migration scripts in `packages/openclaw-plugin/src/core/ep-migration.ts`
2. Test migration with sample data sets
3. Provide backup before migration
4. Support rollback to previous version
5. Document breaking changes

---

## 🔄 Parallel vs Serial Tasks

### Parallel Opportunities (Can Run Concurrently)

1. **Week 2**: EP-1.3 (Tests) || EP-1.4 (Integration)
2. **Week 3**: EP-2.3 (Achievements) || EP-2.4 (E2E Test)
3. **Week 4**: EP-3.3 (Notifications) || EP-3.4 (Tests)
4. **Week 5**: EP-4.1 (Status Bar) || EP-4.2 (Toast) || EP-4.3 (Progress)
5. **Week 6**: EP-5.2 (Hidden Achievements) || EP-5.4 (Config)
6. **Week 8**: EP-6.2 (E2E) || EP-6.3 (Benchmarks) || EP-6.4 (Docs)

### Serial Requirements (Must Run Sequentially)

1. **EP-1.1** (Points Engine) → All later phases depend on this
2. **EP-1.2** (Rule Engine) → EP-2.1 (Reward Detection) depends on rules
3. **EP-2.1** (Reward Detection) → EP-2.2 (Hook Integration)
4. **EP-3.1** (Level Calculation) → EP-3.2 (Streak)
5. **EP-4.4** (Stats Panel) → Depends on all data structures complete
6. **EP-6.1** (Integration Suite) → All features must be implemented first
7. **EP-7.1** (Feature Flag) → Can only be done after all features complete

---

## 📅 Gantt Chart (Timeline)

```
Week 1-2: Core Foundation
  ├─ EP-1.1: Points Engine (Days 1-4)
  ├─ EP-1.2: Rule Engine (Days 5-6)
  ├─ EP-1.3: Unit Tests (Days 7-8)
  └─ EP-1.4: Integration Tests (Day 9)
  → PR-1: Submit Day 10

Week 3: Reward Detection
  ├─ EP-2.1: Reward Detection Service (Days 1-4)
  ├─ EP-2.2: Hook Integration (Days 5-6)
  ├─ EP-2.3: Basic Achievements (Day 7)
  └─ EP-2.4: E2E Reward Workflow Test (Day 8)
  → PR-2: Submit Day 10

Week 4: Leveling System
  ├─ EP-3.1: Level Calculation (Days 1-3)
  ├─ EP-3.2: Streak Tracking (Days 4-5)
  ├─ EP-3.3: Notification System (Day 6)
  └─ EP-3.4: Level System Tests (Days 7-8)
  → PR-3: Submit Day 10

Week 5: UI Integration
  ├─ EP-4.1: Status Bar Component (Days 1-3)
  ├─ EP-4.2: Achievement Toast (Days 4-5)
  ├─ EP-4.3: Progress Visualization (Days 6-7)
  └─ EP-4.4: Stats Panel (Days 8-9)
  → PR-4: Submit Day 10

Week 6-7: Advanced Features
  ├─ EP-5.1: Daily Decay System (Days 1-4)
  ├─ EP-5.2: Hidden Achievements (Days 5-6)
  ├─ EP-5.3: Advanced Analytics (Days 7-10)
  └─ EP-5.4: Configurable Decay (Day 11)
  → PR-5: Submit Day 12

Week 8: Testing & Polish
  ├─ EP-6.1: Integration Test Suite (Days 1-4)
  ├─ EP-6.2: E2E Tests (Days 5-6)
  ├─ EP-6.3: Performance Benchmarking (Day 7)
  └─ EP-6.4: Documentation (Days 8-9)
  → PR-6: Submit Day 10

Week 9: Launch & Monitor
  ├─ EP-7.1: Feature Flag (Day 1)
  ├─ EP-7.2: Telemetry Collection (Days 2-3)
  ├─ EP-7.3: Rollback Plan (Day 4)
  └─ EP-7.4: Launch Preparation (Days 5-6)
  → PR-7: Submit Day 7
```

---

## 📊 Success Metrics

### Development Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **PR Count** | 7 PRs merged | Count merged PRs |
| **Code Coverage** | ≥70% | `vitest --coverage` |
| **Test Pass Rate** | 100% | All tests passing |
| **Performance Overhead** | <5ms/action | Benchmark suite |
| **Breaking Changes** | 0 | Backward compatibility check |

### Product Metrics (Post-Launch)

| Metric | Target | Measurement | Timeline |
|--------|--------|-------------|----------|
| **Adoption Rate** | ≥60% workspaces | Telemetry: `ep_enabled` | Week 1 |
| **Active Engagement** | ≥40% weekly active | Telemetry: `ep_action_last_7d` | Week 2 |
| **Avg Level** | ≥2 (Apprentice) | Telemetry: `ep_level_avg` | Week 4 |
| **Achievement Unlock Rate** | ≥3 per user | Telemetry: `ep_achievements_avg` | Week 4 |
| **User Retention** | ≥70% 30-day retention | Telemetry: `ep_retention_30d` | Week 8 |

### Quality Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Bug Count (P0/P1)** | 0 | GitHub issues labeled `ep-system` |
| **User Complaints** | <5% | Support tickets mentioning EP |
| **Performance Regressions** | 0 | Benchmark comparison |
| **Documentation Completeness** | 100% | All documented sections filled |

---

## 🎯 Agent Assignment Matrix

| Phase | Explorer | Diagnostician | Implementer | Resource Scout |
|-------|----------|---------------|-------------|----------------|
| **Phase 1** | ✅ Review existing pain/evolution code | ❌ Not needed | ✅ Build core foundation | ❌ Not needed |
| **Phase 2** | ❌ Not needed | ❌ Not needed | ✅ Build reward detection | ❌ Not needed |
| **Phase 3** | ❌ Not needed | ❌ Not needed | ✅ Build leveling system | ❌ Not needed |
| **Phase 4** | ❌ Not needed | ❌ Not needed | ✅ Build UI components | ❌ Not needed |
| **Phase 5** | ❌ Not needed | ✅ Analyze gaming patterns | ✅ Build advanced features | ❌ Not needed |
| **Phase 6** | ❌ Not needed | ❌ Not needed | ✅ Build test suite | ❌ Not needed |
| **Phase 7** | ❌ Not needed | ❌ Not needed | ✅ Launch config | ❌ Not needed |

---

## 🚨 Rollback Plan

### Triggers for Rollback

1. **Critical Bug**: P0/P1 bug affecting core functionality
2. **Performance Regression**: >20% performance degradation
3. **Data Loss**: EP data corruption or loss
4. **User Rebellion**: >30% negative feedback or opt-out
5. **Security Issue**: Vulnerability in EP system

### Rollback Steps

1. **Disable Feature Flag**
   ```json
   {
     "evolution_points": {
       "enabled": false
     }
   }
   ```
   Restart gateway to take effect.

2. **Backup EP State**
   ```bash
   cp .state/EVOLUTION_POINTS.json .state/EVOLUTION_POINTS.json.backup
   ```

3. **Revert to Previous Version**
   ```bash
   git checkout v1.5.3
   npm install
   npm run build
   openclaw gateway restart
   ```

4. **Verify Core Functionality**
   - Test basic file operations
   - Verify pain detection still works
   - Check trust score updates

5. **Investigate Root Cause**
   - Review error logs
   - Analyze telemetry data
   - Document findings

6. **Report to Stakeholders**
   - Update GitHub issue
   - Notify user via announcement
   - Provide timeline for fix

---

## 📚 References

### Design Documents
- [Evolution Points System Design](../design/evolution-points-system.md)
- [Principles Disciple Architecture](../architecture/system-overview.md)
- [Pain Detection System](../../../packages/openclaw-plugin/src/core/pain.ts)

### Code References
- Trust Engine: `packages/openclaw-plugin/src/core/trust-engine.ts`
- Evolution Worker: `packages/openclaw-plugin/src/service/evolution-worker.ts`
- Hook Integration: `packages/openclaw-plugin/src/hook.ts`

### External References
- Gamification Best Practices: https://www.nngroup.com/articles/gamification-ux/
- Progress Principle: Teresa Amabile's research on small wins
- Self-Determination Theory: Deci & Ryan on intrinsic motivation

---

## 📝 Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-12 | 1.0.0 | Initial roadmap creation |

---

**End of Implementation Roadmap**
