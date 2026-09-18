<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-013",
  "displayId": "ERR-013",
  "title": "`in` operator OR direct indexing on a plain object leaks inherited Object.prototype members (`__proto__`, `constructor`, `toString`)",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-01",
  "createdAt": "2026-05-21",
  "source": "PRI-201 / PR #663 (Codex review, variant A); PRI-480 / PR #1089 (CodeRabbit review, variant B)",
  "undatedRecurrences": [
    "Earlier recurrences (PR#702-#810): variant A — `computeEffectiveFlags()` lacked dangerous-key rejection; Scribe/Evaluator/Artificer validators used direct property access. See git history."
  ]
}
-->

**Recurrence**: Yes — same class as ERR-001/ERR-005/ERR-007 where runtime semantics bypass validation intent.
