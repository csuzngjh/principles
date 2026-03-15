# Migration Guide: Trust Engine → Evolution Points

> **Upgrade your agent from penalty-driven to growth-driven.**

This guide helps you migrate from the old Trust Engine system to the new Evolution Points (EP) system v2.0.

---

## 🔄 Overview

### What's Changing?

| Aspect | Trust Engine (Old) | Evolution Points (New) |
|--------|-------------------|------------------------|
| **Philosophy** | Penalty-driven (punish mistakes) | Growth-driven (reward progress) |
| **Scoring** | Trust score (0-100, can decrease) | Points (0-1000+, only increase) |
| **Tiers** | Observer → Editor → Developer (3 stages) | Seed → Forest (5 stages) |
| **Failure** | Reduces trust score | Records lessons, no penalty |
| **Motivation** | Avoid mistakes | Improve capabilities |

### Migration Strategy

The migration is **conservative** and **non-destructive**:

1. ✅ Old files are **archived** (not deleted)
2. ✅ Trust scores are **converted** to EP tiers and points
3. ✅ Existing capabilities are **preserved**
4. ✅ Agent starts at **50% of tier requirement** (room to grow)

---

## 📋 Prerequisites

Before migrating, ensure:

- [ ] OpenClaw Gateway is **stopped**
- [ ] You have **backup** of `.principles/` directory
- [ ] Node.js ≥ 18 installed
- [ ] Read the [Evolution Points User Guide](./EVOLUTION_POINTS_GUIDE.md)

### Backup Your Workspace

```bash
# Create a timestamped backup
tar -czf principles-backup-$(date +%Y%m%d-%H%M%S).tar.gz .principles/ .state/

echo "✅ Backup created successfully"
```

---

## 🚀 Step-by-Step Migration

### Step 1: Stop OpenClaw Gateway

```bash
openclaw gateway stop
```

### Step 2: Run Migration Script

The migration script is located at `scripts/migrate-to-evolution-points.ts`.

```bash
cd /path/to/your/workspace
npx ts-node scripts/migrate-to-evolution-points.ts
```

Or specify workspace path:

```bash
npx ts-node scripts/migrate-to-evolution-points.ts /path/to/workspace
```

### Step 3: Verify Migration

Check the generated files:

```bash
# Check new Evolution Scorecard
cat .state/EVOLUTION_SCORECARD.json

# Verify PROFILE.json has evolution enabled
cat .principles/PROFILE.json | grep -A 5 evolution

# Check archived old files
ls -la .principles/archive/trust-engine/
```

### Step 4: Restart OpenClaw Gateway

```bash
openclaw gateway --force
```

### Step 5: Test the System

Ask your agent to perform a simple task and verify:

1. Agent accepts the task (not blocked by Gate)
2. Check points increased:

```bash
cat .state/EVOLUTION_SCORECARD.json | grep totalPoints
```

3. Check recent events:

```bash
cat memory/logs/SYSTEM.log | tail -20
```

---

## 📊 Migration Logic

### Trust Score → Tier Mapping

The migration uses a **conservative** approach:

| Trust Score | Migrated Tier | EP Points | Rationale |
|-------------|---------------|-----------|-----------|
| 95-100 | Sapling (Tier 3) | 100 (50% of 200) | High trust → Capable agent |
| 80-94 | Sprout (Tier 2) | 25 (50% of 50) | Medium trust → Growing agent |
| 60-79 | Seed (Tier 1) | 0 (50% of 0) | Low trust → Starting fresh |
| <60 | Seed (Tier 1) | 0 | Very low trust → Reset |

**Why 50%?**
- Agents start slightly below the tier threshold
- Encourages continued growth
- Prevents instant stagnation at a tier

### Pain Events → Failure History

The migration estimates failures from `pain_settings.json`:

```json
"stats": {
  "totalFailures": 12,  // Estimated from pain scores
  "totalSuccesses": 36, // Assumed 75% success rate
  "consecutiveSuccesses": 0,
  "consecutiveFailures": 0
}
```

### Successes Estimation

Assumes a **3:1 success-to-failure ratio** based on trust score:

```javascript
estimatedSuccesses = Math.floor(totalFailures * 3);
```

This is a rough estimate; the system will quickly adjust based on actual performance.

---

## 📁 What Gets Created/Modified?

### Created Files

| File | Purpose |
|------|---------|
| `.state/EVOLUTION_SCORECARD.json` | New EP scorecard |
| `.principles/archive/trust-engine/pain_settings-{timestamp}.json` | Archived old config |

### Modified Files

| File | Changes |
|------|---------|
| `.principles/PROFILE.json` | Adds `evolution.enabled: true` |

### Preserved Files

| File | Status |
|------|--------|
| `.principles/pain_settings.json` | Archived (not deleted) |
| `.state/TRUST_SCORECARD.json` | Preserved for rollback |

---

## 🔙 Rollback (If Needed)

If you need to rollback to Trust Engine:

### Option 1: Quick Rollback

```bash
# Restore archived pain_settings.json
cp .principles/archive/trust-engine/pain_settings-*.json .principles/pain_settings.json

# Disable Evolution Points in PROFILE.json
# Edit .principles/PROFILE.json and set "evolution.enabled": false

# Remove Evolution Scorecard
rm .state/EVOLUTION_SCORECARD.json

# Restart Gateway
openclaw gateway --force
```

### Option 2: Full Backup Restore

```bash
# Stop Gateway
openclaw gateway stop

# Extract backup
tar -xzf principles-backup-YYYYMMDD-HHMMSS.tar.gz

# Restart Gateway
openclaw gateway --force
```

---

## ⚠️ Common Issues

### Issue: Migration Script Fails

**Error:** `Cannot find module 'typescript'` or similar

**Solution:**
```bash
# Install typescript
npm install -g typescript ts-node

# Try migration again
npx ts-node scripts/migrate-to-evolution-points.ts
```

### Issue: Gateway Won't Start After Migration

**Error:** Gateway fails to start with EP errors

**Solution:**
```bash
# Check Gateway logs
openclaw gateway status

# Verify EP configuration
cat .principles/PROFILE.json | grep -A 10 evolution

# If corrupted, rollback (see above)
```

### Issue: Agent Loses Capabilities

**Symptom:** Agent can't do things it could before

**Possible Causes:**
1. Trust score was low → Migrated to Seed tier
2. Tier permissions are stricter

**Solution:**
```bash
# Check current tier
cat .state/EVOLUTION_SCORECARD.json | grep currentTier

# Agent needs to earn points to unlock capabilities
# See EVOLUTION_POINTS_GUIDE.md for tips
```

### Issue: Points Don't Increase

**Symptom:** Agent completes tasks but points stay at 0

**Solution:**
```bash
# Check if EP is enabled
cat .principles/PROFILE.json | grep "enabled"

# Check file permissions
ls -la .state/EVOLUTION_SCORECARD.json

# If read-only, fix permissions
chmod 644 .state/EVOLUTION_SCORECARD.json
```

---

## ✅ Post-Migration Checklist

After migration, verify:

- [ ] Gateway starts successfully
- [ ] Agent can perform basic tasks (read files)
- [ ] Points increase after successful tasks
- [ ] Tier promotions work (if points reach threshold)
- [ ] Old files are archived (not lost)
- [ ] Backup is safely stored

---

## 🎉 What's Next?

Congratulations! You've upgraded to the growth-driven system.

### Recommended Actions

1. **Monitor the first few days** - Check points progression
2. **Adjust configuration** - Fine-tune cooldown, event limits
3. **Document observations** - Record agent behavior changes
4. **Provide feedback** - Report issues to the community

### Learn More

- [Evolution Points User Guide](./EVOLUTION_POINTS_GUIDE.md) - How to use the system
- [Advanced Configuration](./ADVANCED_EVOLUTION_CONFIG.md) - Fine-tuning parameters
- [GitHub Issues](https://github.com/csuzngjh/principles/issues) - Report bugs

---

*Last updated: 2026-03-14*
*Version: 2.0*
