# 💓 HEARTBEAT.md - Heartbeat Checklist (Minimal)

On each heartbeat, run these core checks. **Don't just reply `HEARTBEAT_OK` every time — use heartbeats productively.**

> **Note**: Grooming, Strategic Alignment, and System Health checks have moved to Cron jobs. See BOOTSTRAP.md for installation guide.

---

## 🩹 Pain & Evolution Check

- [ ] **`.state/.pain_flag`** — Any unprocessed pain signals?
- [ ] **`.state/evolution_queue.json`** — Any pending evolution tasks?
- [ ] **`memory/logs/SYSTEM.log`** — Any unresolved high-priority issues?

**Action**: If signals found, run `/reflection` or `/evolve-task`.

---

## 📋 CURRENT_FOCUS.md Maintenance (Every 3 heartbeats)

- [ ] **Check file size**: target < 50 lines
- [ ] **If > 50 lines**: compress completed milestones to `MEMORY.md`
- [ ] **Verify content**: no outdated dates or completed tasks
- [ ] **Keep only**: current phase, active tasks, next steps

---

## 🧠 Memory Maintenance (Anti-Forgetfulness Core)

> **Why in heartbeat?** LLMs have severe memory issues. Heartbeat has main session context and can sense current work.

### Every heartbeat:

- [ ] **Review today's notes** `memory/YYYY-MM-DD.md` — What did we learn today? What decisions were made?
- [ ] **Check key memory** `MEMORY.md` — Anything needs updating?

### When memory files accumulate:

- [ ] **Distill essence**: Extract important content from daily notes to `MEMORY.md`
- [ ] **Clean outdated info**: Remove no-longer-relevant content from `MEMORY.md`

**Principles**:
- Daily files are raw notes; `MEMORY.md` is curated wisdom
- **Don't let important decisions and lessons be forgotten**
- If user shares preferences or important info, record immediately

---

## ⏰ Stay Silent (HEARTBEAT_OK):

- Late night (23:00-08:00) unless urgent / User busy / Nothing new / < 30 min / Normal

---

## 🚨 Reach Out:

- Pain needs handling / Important discovery / Evolution task pending / Memory needs update

---

*If no issues and no action needed, reply `HEARTBEAT_OK` to save tokens.*