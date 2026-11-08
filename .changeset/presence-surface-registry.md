---
"@principles/core": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

Classify `hook:llm_input_presence` as a default-on core surface. The PRI-1150 presence observation was registered through `guardHook` without a registry entry, so the guard installed a no-op and the observation never ran (PRI-1152 B2). Workspace resolution, the session-access requirement, the fact-only event shape and every resource bound are unchanged.
