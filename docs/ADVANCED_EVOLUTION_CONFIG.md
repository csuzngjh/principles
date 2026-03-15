# Advanced Evolution Points Configuration

> **Fine-tune the Evolution Points system for your specific use case.**

This guide explains all configuration options, tuning strategies, and advanced customization for the Evolution Points (EP) system v2.0.

---

## 📁 Configuration Location

All EP configuration is stored in `.principles/PROFILE.json`:

```json
{
  "evolution": {
    "enabled": true,
    "doubleRewardCooldownMs": 3600000,
    "maxRecentEvents": 50,
    "difficultyPenalty": {
      "tier4Trivial": 0.1,
      "tier4Normal": 0.5,
      "tier5Trivial": 0.1,
      "tier5Normal": 0.5
    }
  }
}
```

---

## ⚙️ Core Configuration Options

### 1. Enable/Disable System

```json
{
  "evolution": {
    "enabled": true  // true or false
  }
}
```

**Values:**
- `true`: EP system is active (default)
- `false`: EP system is disabled (reverts to no restrictions)

**When to Disable:**
- Testing/debugging
- Full manual control
- Temporary disabling during upgrades

**Note:** Disabling does **not** delete data; points are preserved.

---

### 2. Double Reward Cooldown

```json
{
  "evolution": {
    "doubleRewardCooldownMs": 3600000  // milliseconds
  }
}
```

**Purpose:** Controls how long an agent must wait before earning another double reward (2x points for learning from failure).

**Conversion:**

| Milliseconds | Time |
|--------------|------|
| `300000` | 5 minutes |
| `1800000` | 30 minutes |
| `3600000` | 1 hour (default) |
| `7200000` | 2 hours |
| `86400000` | 24 hours |

**Recommended Settings:**

| Use Case | Value | Rationale |
|----------|-------|-----------|
| **Development** | `1800000` (30 min) | Faster feedback, more iterations |
| **Production** | `3600000` (1 hour) | Balanced, prevents grinding |
| **Strict** | `7200000` (2 hours) | Discourages repeated failures |
| **Relaxed** | `300000` (5 min) | Fast learning, high reward potential |

---

### 3. Max Recent Events

```json
{
  "evolution": {
    "maxRecentEvents": 50  // number of events
  }
}
```

**Purpose:** Limits the number of recent events stored in memory to prevent file bloat.

**How It Works:**
- Events beyond this limit are **archived** into statistics
- Only the count is kept, not full event details
- Archived events still contribute to `totalPoints` and `stats`

**Recommended Settings:**

| Use Case | Value | Memory Impact | Rationale |
|----------|-------|---------------|-----------|
| **Minimal** | `20` | ~5 KB | Low memory, minimal history |
| **Default** | `50` | ~12 KB | Balanced |
| **Verbose** | `100` | ~24 KB | Detailed debugging history |
| **Research** | `200` | ~48 KB | Full event trace for analysis |

**Event Size Estimation:**
~240 bytes per event (JSON compressed).

---

## 🎯 Difficulty Penalty (Anti-Grind)

Prevents high-tier agents from "farming" low-tier tasks.

```json
{
  "evolution": {
    "difficultyPenalty": {
      "tier4Trivial": 0.1,   // Tree doing trivial tasks = 10% points
      "tier4Normal": 0.5,    // Tree doing normal tasks = 50% points
      "tier5Trivial": 0.1,   // Forest doing trivial tasks = 10% points
      "tier5Normal": 0.5     // Forest doing normal tasks = 50% points
    }
  }
}
```

**Point Formula:**
```
finalPoints = basePoints × penaltyCoefficient
```

**Example:**
- Tree agent (Tier 4) does trivial task (1 point)
- Final points = 1 × 0.1 = 0.1 points (rounded to 0)

**Recommended Settings:**

| Strategy | Tier 4 Trivial | Tier 4 Normal | Tier 5 Trivial | Tier 5 Normal |
|----------|----------------|---------------|----------------|---------------|
| **Strict** (default) | `0.1` | `0.5` | `0.1` | `0.5` |
| **Lenient** | `0.5` | `0.8` | `0.5` | `0.8` |
| **Permissive** | `1.0` | `1.0` | `1.0` | `1.0` |
| **Disabled** | `1.0` | `1.0` | `1.0` | `1.0` |

---

## 🎨 Tuning Strategies

### Strategy 1: Fast-Track Development

**Goal:** Rapid iteration, quick feedback loop

```json
{
  "evolution": {
    "enabled": true,
    "doubleRewardCooldownMs": 1800000,  // 30 minutes
    "maxRecentEvents": 100,
    "difficultyPenalty": {
      "tier4Trivial": 0.3,
      "tier4Normal": 0.8,
      "tier5Trivial": 0.3,
      "tier5Normal": 0.8
    }
  }
}
```

**Why It Works:**
- Shorter cooldown → More double rewards
- More events → Better debugging
- Lenient penalties → More flexibility

---

### Strategy 2: Production Stability

**Goal:** Prevent chaos, encourage growth at appropriate pace

```json
{
  "evolution": {
    "enabled": true,
    "doubleRewardCooldownMs": 7200000,  // 2 hours
    "maxRecentEvents": 50,
    "difficultyPenalty": {
      "tier4Trivial": 0.1,
      "tier4Normal": 0.5,
      "tier5Trivial": 0.1,
      "tier5Normal": 0.5
    }
  }
}
```

**Why It Works:**
- Longer cooldown → Less incentive to fail
- Fewer events → Lower memory usage
- Strict penalties → Discourages farming

---

### Strategy 3: Learning Environment

**Goal:** Maximize learning from failures

```json
{
  "evolution": {
    "enabled": true,
    "doubleRewardCooldownMs": 3600000,  // 1 hour
    "maxRecentEvents": 200,
    "difficultyPenalty": {
      "tier4Trivial": 0.2,
      "tier4Normal": 0.6,
      "tier5Trivial": 0.2,
      "tier5Normal": 0.6
    }
  }
}
```

**Why It Works:**
- Moderate cooldown → Balanced learning
- Many events → Detailed failure tracking
- Moderate penalties → Some farming allowed but not abused

---

### Strategy 4: Research/Testing

**Goal:** Full event trace for analysis

```json
{
  "evolution": {
    "enabled": true,
    "doubleRewardCooldownMs": 60000,  // 1 minute (for testing)
    "maxRecentEvents": 500,
    "difficultyPenalty": {
      "tier4Trivial": 1.0,
      "tier4Normal": 1.0,
      "tier5Trivial": 1.0,
      "tier5Normal": 1.0
    }
  }
}
```

**Why It Works:**
- Very short cooldown → Frequent double rewards (for testing)
- Many events → Complete history
- No penalties → No farming restrictions

⚠️ **Warning:** Do not use in production - encourages gaming.

---

## 🔍 Monitoring and Debugging

### Check Current Configuration

```bash
cat .principles/PROFILE.json | jq '.evolution'
```

### Monitor Point Accumulation

```bash
# Watch points in real-time
watch -n 5 'cat .state/EVOLUTION_SCORECARD.json | jq "{tier: .currentTier, points: .totalPoints, successes: .stats.totalSuccesses, failures: .stats.totalFailures}"'
```

### Check Event History

```bash
# View recent events
cat .state/EVOLUTION_SCORECARD.json | jq '.recentEvents[-10:]'

# Count events by type
cat .state/EVOLUTION_SCORECARD.json | jq '.recentEvents | group_by(.type) | map({type: .[0].type, count: length})'
```

### Analyze Growth Rate

```bash
# Points per hour (last 24 hours)
python3 << 'EOF'
import json
from datetime import datetime, timedelta

with open('.state/EVOLUTION_SCORECARD.json') as f:
    data = json.load(f)

events = data['recentEvents']
now = datetime.now()
one_day_ago = now - timedelta(days=1)

recent_events = [e for e in events if datetime.fromisoformat(e['timestamp']) > one_day_ago]
total_points = sum(e['pointsAwarded'] for e in recent_events)

print(f"Points in last 24h: {total_points}")
print(f"Average per hour: {total_points / 24:.2f}")
EOF
```

---

## ⚠️ Common Pitfalls

### 1. Cooldown Too Short

**Problem:** Agent intentionally fails to farm double rewards

**Solution:** Increase `doubleRewardCooldownMs` to ≥ 1 hour

---

### 2. No Penalties for High Tiers

**Problem:** Tier 5 agent does trivial tasks indefinitely

**Solution:** Enable `difficultyPenalty` (don't set to 1.0)

---

### 3. Max Events Too High

**Problem:** `EVOLUTION_SCORECARD.json` grows to several MB

**Solution:** Reduce `maxRecentEvents` to ≤ 100

---

### 4. System Disabled

**Problem:** Agent has no restrictions but points still accumulate

**Solution:** Points accumulate silently; re-enable system to apply restrictions

---

## 🛠️ Advanced Customization

### Custom Difficulty Penalties

You can add custom penalties based on your needs:

```json
{
  "evolution": {
    "difficultyPenalty": {
      "tier3Trivial": 0.5,  // Sapling doing trivial tasks
      "tier4Trivial": 0.1,
      "tier4Normal": 0.5,
      "tier5Trivial": 0.1,
      "tier5Normal": 0.5
    }
  }
}
```

**Note:** The system will use any penalty that matches `tier{N}{Difficulty}` pattern.

### Custom Base Points

Modify base points in source code (`packages/openclaw-plugin/src/core/evolution-types.ts`):

```typescript
export const TASK_DIFFICULTY_CONFIG: Record<TaskDifficulty, TaskDifficultyConfig> = {
  trivial: { basePoints: 2,  description: '...' },  // Changed from 1
  normal:  { basePoints: 5,  description: '...' },  // Changed from 3
  hard:    { basePoints: 10, description: '...' },  // Changed from 8
};
```

⚠️ **Warning:** Requires rebuilding the plugin.

---

## 📊 Performance Impact

### Memory Usage

| Configuration | Events Stored | Memory |
|---------------|---------------|--------|
| Minimal (`maxRecentEvents: 20`) | 20 | ~5 KB |
| Default (`maxRecentEvents: 50`) | 50 | ~12 KB |
| Verbose (`maxRecentEvents: 100`) | 100 | ~24 KB |
| Research (`maxRecentEvents: 200`) | 200 | ~48 KB |

### Disk Usage

- `EVOLUTION_SCORECARD.json`: ~15 KB (typical)
- Archived events: Minimal (only counts stored)
- Growth rate: ~1 KB per 50 events

**Conclusion:** Negligible disk usage.

### CPU Impact

- Event processing: < 1ms per event
- Tier promotion check: < 1ms
- Gate check: < 1ms

**Conclusion:** No noticeable performance impact.

---

## 🔄 Configuration Reload

Most configuration changes **do not require restart**:

- Changes to `doubleRewardCooldownMs`: Applied immediately
- Changes to `maxRecentEvents`: Applied on next event write
- Changes to `difficultyPenalty`: Applied immediately

However, for safety, we recommend:

```bash
# Reload OpenClaw Gateway
openclaw gateway restart
```

---

## 📚 Related Documentation

- [Evolution Points User Guide](./EVOLUTION_POINTS_GUIDE.md) - How to use the system
- [Migration Guide](./MIGRATION_GUIDE.md) - Upgrading from Trust Engine
- [Source Code](../packages/openclaw-plugin/src/core/evolution-types.ts) - Type definitions

---

*Last updated: 2026-03-14*
*Version: 2.0*
