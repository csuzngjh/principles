<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-018",
  "displayId": "ERR-018",
  "title": "repairAttempts records stale initialValidationErrors instead of per-attempt currentErrors",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-05",
  "createdAt": "2026-05-21",
  "source": "PRI-200 / PR #665"
}
-->

**Recurrence**: Yes - same class as ERR-015 where loop state was not refreshed per iteration. 2026-08-29 PRI-621: the repair prompt itself starved the loop of state — it carried only a top-level schema summary, leaving nested enums/minItems invisible, so the repair LLM guessed enum/shape values and failed all attempts on live artificer chains. Fixed: formatRepairPrompt carries the complete serialized schema (REPAIR_PROMPT_VERSION v2). 2026-09-12 PR #1635 review: an async 401 handler invalidated the SHARED session token unconditionally — a late tokenless-probe 401 raced the login form's restore and erased the just-restored token. Beyond loops: any handler invalidating shared mutable state must compare its request-time snapshot against the current value and skip when a newer writer intervened (snapshot-equality guard + unit tests; rc-7).
