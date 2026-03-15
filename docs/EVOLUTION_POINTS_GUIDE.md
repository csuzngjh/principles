# Evolution Points System - User Guide

> **Growth-driven, not penalty-driven.**

The Evolution Points (EP) system is a positive reinforcement mechanism that rewards agents for learning and growing, replacing the old penalty-based Trust Engine. Agents earn points by completing tasks, learning from failures, and demonstrating improved capabilities.

---

## 🌱 Core Philosophy

### What's Different?

| Feature | Trust Engine (Old) | Evolution Points (New) |
|---------|-------------------|------------------------|
| **Philosophy** | Penalty-driven | **Growth-driven** |
| **Points** | Can decrease | **Only increase** |
| **Failure** | Penalizes | **Records lessons** |
| **Progress** | Trust score (0-100) | **5-tier growth path** |
| **Motivation** | Avoid mistakes | **Improve capabilities** |

### The 5-Stage Growth Path

| Tier | Name | Required Points | Capabilities | Example Tasks |
|:-----|:-----|:----------------|:-------------|:--------------|
| **1** | Seed | 0 | Read-only + Basic documentation (20 lines max) | Reading files, searching code |
| **2** | Sprout | 50 | Single file editing (50 lines max) | Fixing typos, small bug fixes |
| **3** | Sapling | 200 | Multi-file + Tests + Subagent spawning | Feature implementation, test writing |
| **4** | Tree | 500 | Refactoring + Risk path access | Large refactors, architecture changes |
| **5** | Forest | 1000 | Full autonomy (unlimited) | Complex system design, independent work |

---

## ⭐ How Points Work

### Point Rules

#### 1. **Start at 0, Only Increase**
- All agents start at 0 points (Seed tier)
- Points **never decrease** - failures are recorded as lessons, not penalties
- Focus is on growth, not perfection

#### 2. **Task Difficulty Rewards**

| Difficulty | Base Points | Description | Examples |
|------------|-------------|-------------|----------|
| **Trivial** | 1 | Simple tasks | Read files, search, status queries |
| **Normal** | 3 | Routine tasks | Single file edits, test writing |
| **Hard** | 8 | Complex tasks | Multi-file refactors, architecture changes |

#### 3. **Double Reward Mechanism**
- When an agent fails at a task type, then succeeds on the same type → **2x points**
- **Cooldown**: 1 hour between double rewards (prevents grinding)
- Encourages learning from mistakes

#### 4. **Anti-Grind Protection**
High-tier agents earn fewer points for low-tier tasks:

- **Tree (Tier 4)** doing Trivial tasks: 10% of points
- **Tree (Tier 4)** doing Normal tasks: 50% of points
- **Forest (Tier 5)** doing Trivial tasks: 10% of points
- **Forest (Tier 5)** doing Normal tasks: 50% of points

This encourages agents to work at their capability level.

---

## 📊 Monitoring Progress

### Check Your Current Status

```bash
cat .state/EVOLUTION_SCORECARD.json
```

### Key Fields Explained

```json
{
  "version": "2.0",
  "agentId": "your-agent-id",

  "totalPoints": 150,        // Historical total (for tier calculation)
  "availablePoints": 150,   // Usable points (for capability spending)

  "currentTier": 2,         // Current tier (1=Seed, 2=Sprout, etc.)

  "stats": {
    "totalSuccesses": 47,    // Total successful tasks
    "totalFailures": 8,      // Total failures (lessons learned)
    "doubleRewardsEarned": 3 // How many double rewards earned
  },

  "lastUpdated": "2026-03-14T00:00:00.000Z"
}
```

### Tier Progression Examples

```
0 points   → Seed  (Tier 1)
50 points   → Sprout (Tier 2)
200 points  → Sapling (Tier 3)
500 points  → Tree (Tier 4)
1000 points → Forest (Tier 5)
```

---

## ⚙️ Configuration

### Enable Evolution Points

In `.principles/PROFILE.json`:

```json
{
  "evolution": {
    "enabled": true,
    "doubleRewardCooldownMs": 3600000,
    "maxRecentEvents": 50
  }
}
```

### Configuration Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the EP system |
| `doubleRewardCooldownMs` | number | `3600000` | Double reward cooldown (1 hour in ms) |
| `maxRecentEvents` | number | `50` | Number of recent events to keep in memory |

### Example: Fast-Track for Development

```json
{
  "evolution": {
    "enabled": true,
    "doubleRewardCooldownMs": 1800000,  // 30 minutes
    "maxRecentEvents": 100
  }
}
```

---

## 🔧 Advanced Topics

### Task Difficulty Assignment

The system automatically determines task difficulty based on:

- **Tool type**: Read operations are Trivial, Write operations are Normal/Hard
- **File count**: Single file = Normal, Multiple files = Hard
- **Line count**: Small edits (<50 lines) = Normal, Large edits (>100 lines) = Hard
- **Risk path**: Risk path operations are always Hard

### Permissions by Tier

| Tier | Max Lines per Write | Max Files | Risk Path | Subagent Spawn |
|------|---------------------|-----------|-----------|----------------|
| Seed | 20 | 1 | ❌ | ❌ |
| Sprout | 50 | 2 | ❌ | ❌ |
| Sapling | 200 | 5 | ❌ | ✅ |
| Tree | 500 | 10 | ✅ | ✅ |
| Forest | Unlimited | Unlimited | ✅ | ✅ |

### Double Reward Mechanics

**Trigger Conditions:**
1. Agent fails at a task (recorded in `recentFailureHashes`)
2. Agent succeeds at the same task type (same `taskHash`)
3. At least 1 hour has passed since last double reward

**Task Hash Calculation:**
```
taskHash = SHA256(toolName + filePath + contentHash)
```

This ensures that the same task (same file, same tool) triggers double reward.

---

## 🐛 Troubleshooting

### Q: Agent is stuck at Seed tier

**Symptoms:** Agent always at 0 points, refuses to do anything

**Possible Causes:**
1. EP system not enabled → Check `.principles/PROFILE.json`
2. No successful tasks recorded → Check `.state/EVOLUTION_SCORECARD.json`
3. Gate blocking all operations → Check logs for gate rejections

**Solutions:**
```bash
# Check if EP is enabled
cat .principles/PROFILE.json | grep evolution

# Check scorecard
cat .state/EVOLUTION_SCORECARD.json

# View recent events
cat memory/logs/SYSTEM.log | grep evolution
```

### Q: Points not increasing

**Symptoms:** Agent completes tasks but points stay the same

**Possible Causes:**
1. Anti-grind protection active → Agent is Tier 4/5 doing trivial tasks
2. Write permission issue → Scorecard file not writable
3. EP engine not running → Check OpenClaw Gateway logs

**Solutions:**
```bash
# Check file permissions
ls -la .state/EVOLUTION_SCORECARD.json

# Verify agent tier
cat .state/EVOLUTION_SCORECARD.json | grep currentTier

# Check Gateway logs
openclaw gateway status
```

### Q: Double reward not triggering

**Symptoms:** Agent succeeds after failure but doesn't get 2x points

**Possible Causes:**
1. Still in cooldown (less than 1 hour)
2. Task hash changed (different file or tool)
3. Failure hash expired (older than retention period)

**Solutions:**
```bash
# Check last double reward time
cat .state/EVOLUTION_SCORECARD.json | grep lastDoubleRewardTime

# Check cooldown setting
cat .principles/PROFILE.json | grep doubleRewardCooldownMs

# Wait for cooldown to expire
```

---

## 🚀 Tips for Fast Growth

1. **Start with small tasks**: Fix typos, update documentation (Trivial tasks)
2. **Learn from failures**: Each failure = potential 2x reward later
3. **Write tests**: Tests count as Normal tasks, good for reaching Sprout
4. **Avoid grinding**: Do tasks at your tier level for maximum points
5. **Use subagents**: Sapling+ can spawn subagents for parallel work

---

## 📚 Related Documentation

- [Migration Guide](./MIGRATION_GUIDE.md) - Migrating from Trust Engine
- [Advanced Configuration](./ADVANCED_EVOLUTION_CONFIG.md) - Fine-tuning the system
- [README](../README.md) - Project overview

---

*Last updated: 2026-03-14*
*Version: 2.0*
