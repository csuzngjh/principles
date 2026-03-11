# Trust Engine V2 - Complete Reference

> Implemented: 2026-03-11
> Status: ✅ Active (migrated from V1)

## Architecture

Trust Engine V2 replaces the simple linear trust system (V1) with an adaptive system that supports cold starts, graceful failures, and performance-based adjustments.

## Key Differences: V1 vs V2

| Feature | V1 (trust-engine.ts) | V2 (trust-engine-v2.ts) |
|---------|---------------------|------------------------|
| Initial Trust | 50 | **59** (Stage 2) |
| Grace Failures | None | **3 free mistakes** |
| Failure Penalty | Fixed -10/-20 | **Adaptive** (-8 to -25) |
| Success Reward | Fixed +2 | **Adaptive** (+1 to +10) |
| Cold Start | No | **24h protection** |
| History | No | **Last 20 ops** |
| Streak Tracking | Basic | **Full streak bonuses** |

## Configuration

### File Location
`packages/openclaw-plugin/src/core/trust-engine-v2.ts`

### TRUST_CONFIG Structure

```typescript
{
  STAGES: {
    STAGE_1_OBSERVER: 30,
    STAGE_2_EDITOR: 60,
    STAGE_3_DEVELOPER: 80,
  },
  COLD_START: {
    INITIAL_TRUST: 59,        // Starts at Stage 2
    GRACE_FAILURES: 3,         // 3 free mistakes
    COLD_START_PERIOD: 24h,    // Protection duration
  },
  PENALTIES: {
    TOOL_FAILURE_BASE: -8,
    RISKY_FAILURE_BASE: -15,
    GATE_BYPASS_ATTEMPT: -5,
    FAILURE_STREAK_MULTIPLIER: -3,
    MAX_PENALTY: -25,          // Cap to prevent ruin
  },
  REWARDS: {
    SUCCESS_BASE: 1,
    SUBAGENT_SUCCESS: 3,
    STREAK_BONUS_THRESHOLD: 5,
    STREAK_BONUS: 5,
    RECOVERY_BOOST: 3,
    MAX_REWARD: 10,
  },
}
```

## AgentScorecard Interface

```typescript
interface AgentScorecard {
  trust_score: number;              // 0-100
  wins?: number;
  losses?: number;
  success_streak?: number;          // Consecutive successes
  failure_streak?: number;          // Consecutive failures
  first_activity_at?: string;       // ISO timestamp
  last_activity_at?: string;        // ISO timestamp
  grace_failures_remaining?: number;// Grace failures left
  recent_history?: ('success' | 'failure')[]; // Last 20 ops
}
```

## Functions

### getAgentScorecard(workspaceDir: string)
- **Returns**: AgentScorecard (creates new if not exists)
- **Initialization**: Cold start benefits applied automatically
- **Migration**: Adds missing fields to old scorecards

### recordSuccess(workspaceDir, ctx)
- **Reward Calculation**:
  - Base: +1
  - Recovery boost: +3 (after failures)
  - Streak bonus: +5 (for 5+ consecutive)
  - Capped at: +10

### recordFailure(workspaceDir, type, ctx)
- **Types**: 'tool' | 'risky' | 'bypass'
- **Penalty Calculation**:
  - Check grace failures first (no penalty if available)
  - Base penalty + streak multiplier
  - Cold start reduction (50% off)
  - Recent failure rate adjustment
  - Capped at: -25

### adjustTrustScore(workspaceDir, delta, reason, ctx)
- **Range**: Clamped to 0-100
- **Side Effect**: Records trust_change event

## Cold Start Behavior

When `getAgentScorecard()` is called for new agent:
```json
{
  "trust_score": 59,
  "wins": 0,
  "losses": 0,
  "success_streak": 0,
  "failure_streak": 0,
  "grace_failures_remaining": 3,
  "recent_history": [],
  "first_activity_at": "2026-03-11T00:00:00.000Z",
  "last_activity_at": "2026-03-11T00:00:00.000Z"
}
```

## Grace Failures

First 3 failures have **zero penalty**:
```typescript
if (graceRemaining > 0) {
  return { penalty: 0, graceUsed: true };
}
```

After grace period:
- Penalty calculated normally
- `grace_failures_remaining` decremented

## Adaptive Penalties

### Failure Streak Multiplier
```typescript
penalty = base + (failureStreak * -3)
```

Examples:
- 1st failure: -8 + 0 = -8
- 2nd failure: -8 + -3 = -11
- 3rd failure: -8 + -6 = -14

### Cold Start Reduction
During first 24h: `penalty = floor(penalty * 0.5)`

### Recent Failure Rate
Based on last 10 operations:
- 70%+ failure: penalty × 1.3
- 30%- failure: penalty × 0.7

## Adaptive Rewards

### Streak Bonus
After 5+ consecutive successes: `reward = base + 5`

### Recovery Boost
After any failure, next success gets +3 boost

### Capping
- Max reward: +10
- Max penalty: -25

## Migration Path

### From V1 to V2
1. Delete `trust-engine.ts`
2. Update all imports to `trust-engine-v2.js`
3. Update constant names:
   - `TOOL_FAILURE` → `TOOL_FAILURE_BASE`
   - `RISKY_FAILURE` → `RISKY_FAILURE_BASE`
4. Clean dist: `rm -rf dist && npm run build`
5. Delete old AGENT_SCORECARD.json (will re-init)

### What Breaks
Old AGENT_SCORECARD.json structure incompatible:
```json
// OLD (V1) - Incompatible
{
  "agents": {
    "explorer": { "score": 0, ... }
  },
  "trust_score": 0
}

// NEW (V2) - Correct
{
  "trust_score": 59,
  "wins": 0,
  "losses": 0,
  ...
}
```

## Testing

### Manual Test
```typescript
// Get scorecard (auto-initializes if new)
const scorecard = getAgentScorecard(workspaceDir);

// Should start at 59
console.log(scorecard.trust_score); // 59

// Should have 3 grace failures
console.log(scorecard.grace_failures_remaining); // 3

// Record success (should increase)
recordSuccess(workspaceDir, ctx);

// Record failure (should use grace, no penalty)
recordFailure(workspaceDir, 'tool', ctx);
// grace_failures_remaining: 2, trust_score: 59
```

## Usage in Hooks

### gate.ts
```typescript
import { getAgentScorecard, TRUST_CONFIG } from '../core/trust-engine-v2.js';

const scorecard = getAgentScorecard(ctx.workspaceDir);
const trustScore = scorecard.trust_score ?? 50;

// Determine stage
let stage = 2;
if (trustScore < TRUST_CONFIG.STAGES.STAGE_1_OBSERVER) stage = 1;
else if (trustScore < TRUST_CONFIG.STAGES.STAGE_2_EDITOR) stage = 2;
else if (trustScore < TRUST_CONFIG.STAGES.STAGE_3_DEVELOPER) stage = 3;
else stage = 4;
```

### pain.ts
```typescript
import { adjustTrustScore, TRUST_CONFIG } from '../core/trust-engine-v2.js';

const penalty = isRisk
  ? TRUST_CONFIG.PENALTIES.RISKY_FAILURE_BASE
  : TRUST_CONFIG.PENALTIES.TOOL_FAILURE_BASE;

adjustTrustScore(ctx.workspaceDir, penalty, `pain:${errorType}`, ctx);
```

## Important Notes

1. **Only trust-engine-v2.ts exists** - Old file deleted
2. **All hooks import V2** - No V1 imports remaining
3. **Automatic initialization** - New agents get cold start benefits
4. **Migration support** - Old scorecards auto-updated with missing fields
5. **Event logging** - All trust changes recorded in event-log
