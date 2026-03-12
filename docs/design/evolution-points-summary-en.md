# Evolution Points System - Design Summary (English)

> **Original Design**: `docs/design/evolution-points-system.md` (Chinese)
> **Translator**: Planner Agent
> **Version**: v1.0
> **Date**: 2026-03-12

---

## Overview

The Evolution Points System (进化积分系统) is a comprehensive technical solution designed to replace the current Trust Engine V2.1 with a **growth-oriented gamification layer**.

### Core Philosophy: Growth Over Punishment

**Current Problems (Trust Engine V2.1)**:
- Asymmetric scoring (10 successes needed to recover from 1 failure)
- Penalty mechanism discourages agent evolution
- Failures are stigmatized rather than treated as learning opportunities

**Evolution Points System**:
- ✅ Starts at 0 points, can only increase (no deductions)
- ✅ Failures record lessons without point deductions
- ✅ Success after same-task failure = double reward
- ✅ Consecutive failures trigger "learning mode" instead of punishment
- ✅ Uses **unlock mechanisms** instead of **restriction mechanisms**

---

## Comparison: Trust Engine vs. Evolution Points

| Dimension | Trust Engine V2.1 | Evolution Points V3.0 |
|-----------|-------------------|-----------------------|
| **Initial Score** | 85 points (high start, fast degradation) | 0 points (zero start, only increases) |
| **Failure Handling** | Deduct points (-2 to -20) | Record lesson, no deduction |
| **Recovery** | Difficult (10:1 recovery ratio) | Easy (1:1 recovery ratio) |
| **Permission Mode** | Restrict (low score = blocked) | Unlock (high score = access) |
| **Core Incentive** | Avoid failure (fear-driven) | Pursue growth (growth-driven) |
| **Failure Learning** | Punitive | Educational |

---

## Dual-Track Strategy

**Phase 1** (Parallel Run): Evolution Points and Trust Engine run concurrently without interference
**Phase 2** (Gradual Migration): New features use Evolution Points, old features keep Trust Engine
**Phase 3** (Complete Replacement): Deprecate Trust Engine, fully adopt Evolution Points

---

## Key TypeScript Interfaces

### EvolutionEvent

```typescript
interface EvolutionEvent {
    id: string;
    timestamp: string;
    type: 'success' | 'failure' | 'lesson' | 'learning_mode';
    taskType: 'constructive' | 'exploratory' | 'risk_path' | 'subagent';
    toolName?: string;
    filePath?: string;
    reason?: string;
    pointsDelta: number;          // Always >= 0
    isDoubleReward: boolean;
    learningModeTriggered?: {
        taskId: string;
        consecutiveFailures: number;
    };
    context?: {
        sessionId?: string;
        subagentId?: string;
    };
}
```

### EvolutionScorecard

```typescript
interface EvolutionScorecard {
    version: string;
    totalPoints: number;          // Total accumulated points (>=0)
    currentLevel: number;          // Current level
    lessonCount: number;           // Number of lessons learned
    doubleRewardCount: number;     // Number of double rewards
    history: EvolutionEvent[];      // Event history (max 1000)
    statistics: {
        totalEvents: number;
        successEvents: number;
        failureEvents: number;
        lessonEvents: number;
    };
}
```

### Level Definition

```typescript
interface LevelDefinition {
    level: number;
    name: string;
    pointsRequired: number;
    permissions: string[];        // Unlocked permissions
    capabilities: string[];        // Additional capabilities
}
```

---

## Point Reward Rules

### Success Rewards

| Task Type | Base Points | Double Reward | Notes |
|-----------|-------------|---------------|-------|
| Constructive Success | +10 | +20 | File edits, code generation |
| Exploratory Success | +2 | +4 | Tool exploration, discovery |
| Risk Path Success | +15 | +30 | Operations on sensitive paths |
| Subagent Success | +5 | +10 | Successful subagent task |

### Failure Lessons

| Failure Type | Points | Condition |
|--------------|--------|-----------|
| First Lesson | +5 | First failure of task type |
| Repeated Lesson | +2 | Subsequent failures (capped) |
| Consecutive Failure | +0 | Triggers learning mode |

### Learning Mode Rewards

| Condition | Reward |
|-----------|--------|
| Exit learning mode (1 success) | +30 |
| Exit learning mode (2 successes) | +20 |
| Exit learning mode (3+ successes) | +10 |

---

## Level Thresholds and Permissions

| Level | Name | Points Required | Unlocked Permissions |
|-------|------|-----------------|---------------------|
| 0 | Observer | 0 | Read-only, basic tools |
| 1 | Apprentice | 100 | File write (non-risk paths) |
| 2 | Contributor | 500 | Task execution, plan management |
| 3 | Specialist | 2,000 | Minor edits on risk paths |
| 4 | Expert | 10,000 | Full file operations |
| 5 | Architect | 50,000 | Bypass gates for routine tasks |
| 6 | Evolutionary | 250,000 | Full autonomy, self-direction |

---

## Technical Architecture

### Components

1. **EvolutionEngine** (`src/service/evolution-engine.ts`)
   - Core point calculation and awarding
   - Event history management
   - Level progression logic

2. **LessonTracker** (`src/service/lesson-tracker.ts`)
   - Tracks failure patterns
   - Detects learning opportunities
   - Triggers learning mode

3. **UnlockGate** (`src/core/unlock-gate.ts`)
   - Replaces TrustEngine gate
   - Checks level-based permissions
   - Allows/routines based on points

4. **EventStorage** (`src/storage/evolution-storage.ts`)
   - Persists evolution events to `.state/EVOLUTION_SCORECARD.json`
   - Manages history rotation
   - Ensures data integrity

### Data Flow

```
Action Completion
    ↓
EvolutionEngine.recordEvent()
    ↓
Calculate points (base + potential double reward)
    ↓
Update scorecard (total points, level)
    ↓
Check level up → Trigger UnlockGate permission update
    ↓
Persist to storage
```

---

## Anti-Farming Mechanisms

### Task Diversity Limit

- Maximum 70% of points from same task type
- Encourages diverse activities
- Prevents repetitive task farming

### Success Rate Cap

- Maximum 98% success rate for point rewards
- Prevents gaming with trivial easy tasks
- Encourages tackling real challenges

### Cooldown System

- Same tool on same file: 1 hour cooldown
- Same task type: 30 minute cooldown
- Prevents rapid point accumulation

---

## Integration Points

### Hook Integration

```typescript
// In hook.ts (post-action)
if (action.success) {
    await evolutionEngine.recordSuccess(action);
} else {
    await evolutionEngine.recordFailure(action);
}
```

### Gate Integration

```typescript
// In gate.ts (permission check)
if (unlockGate.isAllowed(action)) {
    return ALLOW;
} else {
    return DENY;
}
```

### UI Integration

```typescript
// Status bar display
const levelInfo = evolutionEngine.getCurrentLevel();
showStatus(`Level ${levelInfo.level}: ${levelInfo.name} (${scorecard.totalPoints} EP)`);
```

---

## Migration Strategy

### Phase 1: Parallel Run (2 weeks)
- Both Trust Engine and Evolution Points active
- Trust Engine remains authoritative
- Evolution Points runs in parallel (read-only)
- Validate data consistency

### Phase 2: Gradual Migration (4 weeks)
- New features use Evolution Points
- Old features keep Trust Engine
- Gradual cutover of gates
- Monitor user feedback

### Phase 3: Complete Replacement (2 weeks)
- Deprecate Trust Engine
- Evolution Points becomes authoritative
- Remove old code paths
- Full cleanup

---

## Testing Strategy

### Unit Tests
- Point calculation accuracy
- Event history management
- Level progression logic
- Cooldown enforcement

### Integration Tests
- Hook integration
- Gate integration
- Storage persistence
- Data consistency

### E2E Tests
- Complete agent lifecycle
- Permission changes on level up
- Learning mode triggering
- Anti-farming enforcement

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Point inflation | High | Medium | Anti-farming mechanisms, cooldowns |
| Performance overhead | Medium | High | Async processing, batch operations |
| Data corruption | Low | High | Atomic writes, validation |
| User confusion | Medium | Medium | Clear UI, gradual rollout |
| Gaming the system | High | Medium | Task diversity, success rate cap |

---

## Success Metrics

### Quantitative
- Average level after 30 days: ≥2 (Apprentice)
- Lesson learning rate: ≥60% (failures converted to lessons)
- User satisfaction: ≥4.0/5.0
- Performance overhead: <5ms per action

### Qualitative
- Failures seen as learning opportunities
- Users feel encouraged rather than punished
- Growth mindset adoption

---

## Open Questions

1. **Migration Timeline**: How fast should we migrate?
2. **Backward Compatibility**: Keep Trust Engine for legacy features?
3. **UI Design**: How to display level/points to users?
4. **Point Tuning**: Are base values appropriate?
5. **Level Permissions**: Are current thresholds correct?

---

## References

- Original Design: `docs/design/evolution-points-system.md` (Chinese, 2464 lines)
- Implementation Roadmap: `docs/plans/evolution-points-roadmap.md`
- Audit Report: `docs/audits/evolution-points-audit.md`
- Trust Engine V2.1: `packages/openclaw-plugin/src/core/trust-engine.ts`

---

**End of Design Summary**
