# 💓 Heartbeat Checklist: Principles Disciple

During every heartbeat, self-check the following items to maintain the system's evolutionary vitality:

## 1. Pain & Evolution Check
- [ ] **Check `.pain_flag`**: Are there unprocessed pain signals? If so, evaluate if an immediate `/reflection` or `/evolve-task` is required.
- [ ] **Check `EVOLUTION_QUEUE.json`**: Are there pending asynchronous evolution tasks?
- [ ] **Check `ISSUE_LOG.md`**: Are there any unresolved high-priority issues?

## 2. Strategic Alignment
- [ ] **Compare with `CURRENT_FOCUS.md`**: Did the actions in the last hour deviate from the current strategic priorities?
- [ ] **Weekly Governance Status**: Consult `docs/okr/WEEK_STATE.json` to ensure the status is `EXECUTING`. If `INTERRUPTED`, prioritize recovery.

## 3. System Health
- [ ] **Toolchain**: Check `docs/SYSTEM_CAPABILITIES.json` to ensure core tools (e.g., `rg`, `sg`) are available.
- [ ] **Doc Sync**: Ensure `PLAN.md` status matches actual progress.
- [ ] **Entropy Check (Grooming)**: Run `ls -F` on the project root. If you detect stray temporary files, test scripts, or improperly named documents, immediately invoke the `workspace-grooming` skill to organize the environment.

---
*If there are no issues, strictly reply with `HEARTBEAT_OK` to save tokens.*
