---
'create-principles-disciple': patch
---

WorkBuddy installer: probe every fixed drive's standard Program Files directories when resolving the WorkBuddy engine CLI (G1, 2026-10-15). A Desktop install outside the SystemDrive's Program Files (e.g. `D:\Program Files\WorkBuddy`) previously resolved to "engine not found" — `install` skipped its engine verification and `detect` reported an absent engine on a real installation, and the real-engine isolation test silently skipped on such machines. Env overrides (`PD_WORKBUDDY_ENGINE` / `WB_ENGINE`) keep priority; Linux/CI behavior is unchanged (drive scan is win32-only).
