# 💓 HEARTBEAT.md - Heartbeat Checklist

On each heartbeat, run these checks to maintain system vitality. **Don't just reply `HEARTBEAT_OK` every time — use heartbeats productively.**

---

## 🔄 Heartbeat State Tracking

Record check timestamps in `memory/heartbeat-state.json`:

```json
{
  "lastChecks": {
    "pain": 1703275200,
    "strategy": 1703260800,
    "memory": 1703250000,
    "grooming": null
  }
}
```

Update the timestamp after each check to avoid redundant checks.

---

## 1. 🩹 Pain & Evolution Check

- [ ] **Check `.state/.pain_flag`**: Any unprocessed pain signals?
- [ ] **Check `.state/evolution_queue.json`**: Any pending async evolution tasks?
- [ ] **Check `memory/logs/SYSTEM.log`**: Any unresolved high-priority issues?

**Action**: If unprocessed pain signals exist, evaluate whether to immediately run `/reflection` or `/evolve-task`.

---

## 2. 🎯 Strategic Alignment

- [ ] **Compare against `memory/okr/CURRENT_FOCUS.md`**: Have recent operations drifted from strategic focus?
- [ ] **Weekly governance state**: Check `memory/okr/WEEK_STATE.json`, ensure current state is `EXECUTING`

**Action**: If state is `INTERRUPTED`, prioritize recovery.

---

## 3. 🧠 Memory Maintenance

Every few days (or when memory files accumulate):

- [ ] **Review recent `memory/YYYY-MM-DD.md`**: Identify content worth preserving long-term
- [ ] **Update `MEMORY.md`**: Distill learnings, important decisions, lessons
- [ ] **Clean outdated info**: Remove no-longer-relevant content from `MEMORY.md`

**Principle**: Daily files are raw notes; `MEMORY.md` is curated wisdom.

---

## 4. 🧹 Grooming Check

⚠️ **Safety First**: Use two-phase deletion strategy to avoid accidentally deleting important files

- [ ] **Phase 1 - Move to Trash** (execute immediately):
  ```bash
  # Create trash directories
  mkdir -p .trash/{tmp,cache,logs,editor}

  # Recursively move files to trash (don't delete!)
  find /tmp -type f -mtime +7 -exec mv -t .trash/tmp/ {} +
  find . -type d -name ".cache" -exec find {} -type f -mtime +7 -exec mv -t .trash/cache/ {} +
  find . \( -name "*.swp" -o -name "*~" -o -name ".DS_Store" \) -exec mv -t .trash/editor/ {} +
  ```

- [ ] **Phase 2 - Empty Trash** (delay 7 days):
  ```bash
  # Only delete files in trash that are older than 7 days
  find .trash/ -type f -mtime +7 -delete
  find .trash/ -type d -empty -delete
  ```

- [ ] **Run `ls -F` on project root**
- [ ] **Identify non-standard files**: Scattered temp files, test scripts, poorly named docs

**Action**: If chaos found, invoke `pd-grooming` skill for cleanup.

**⚠️ Strictly Forbidden**:
- ❌ Using `rm -rf` to delete workspace files
- ❌ Using `find ... -delete` to directly delete
- ❌ Skipping trash and deleting directly

---

## 5. 🛠️ System Health

- [ ] **Check `.state/SYSTEM_CAPABILITIES.json`**: Are core tools (`rg`, `node`, `python`) available?
- [ ] **Doc sync**: Ensure `PLAN.md` state matches actual progress

---

## ⏰ When to Stay Silent (HEARTBEAT_OK)

- Late night (23:00-08:00) unless urgent
- Human is clearly busy
- Nothing new since last check
- Last check was < 30 minutes ago
- All checks are normal

---

## 🚨 When to Reach Out

- Important pain signal needs handling
- Strategic drift needs user confirmation
- Project environment needs cleaning
- Significant discovery or progress

---

*If no issues and no action needed, reply `HEARTBEAT_OK` to save tokens.*