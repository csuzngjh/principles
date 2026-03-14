# 💓 HEARTBEAT.md - Minimal Heartbeat

Run essential checks on each heartbeat. **Don't just reply `HEARTBEAT_OK`.**

---

## 🩹 Pain & Evolution Check

- [ ] `.state/.pain_flag` — unprocessed pain signals?
- [ ] `.state/evolution_queue.json` — pending evolution tasks?
- [ ] `memory/logs/SYSTEM.log` — unresolved high-priority issues?

**Action**: If signals exist, run `/reflection` or `/evolve-task`.

---

## ⏰ Stay Silent (HEARTBEAT_OK) When:

- Late night (23:00-08:00) unless urgent
- Human is busy / nothing new / < 30 min since last check / all normal

## 🚨 Reach Out When:

- Pain signal needs handling / important discovery / evolution action needed

---

*Reply `HEARTBEAT_OK` if no issues and no action needed.*
