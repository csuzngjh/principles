<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-095",
  "displayId": "ERR-095",
  "title": "Additive envelope/`contentJson` merge uses a key that collides with an existing output-schema field — silently overwrites the legitimate field",
  "status": "active",
  "category": "Process & Workflow",
  "ep": "EP-07",
  "createdAt": "2026-08-02",
  "source": "PR #1273 (CodeRabbit review + self-review)",
  "trailerLines": [
    "  - 2026-09-08 PRI-700 / PR #1551 review round (CodeRabbit P1 + CI failure): `handleValidationError` persisted `output_failure_details`, then wrote `lastValidatorErrors` via a SECOND `updateTask` whose diagnosticJson base was re-parsed from the `ctx.task.diagnosticJson` snapshot taken BEFORE the first write — the second write replaced the whole column and silently erased `output_failure_details`. CI caught it as \"updateTask called 2 times, expected 1\". Fixed by generalizing `persistOutputFailureDetails` with an `extraTopLevelKeys` param so both keys land in ONE read-modify-write. Broaden — additive is not safe at the WRITE level either: keys appended to the same persisted record within one flow must coalesce into a single read-modify-write; a second RMW built from a pre-first-write in-memory snapshot is a lost update."
  ]
}
-->

**Recurrence**: 2026-08-27 / PR #1421 (PRI-606, self-review during implementation): `validatePdConfig` reconstructed the validated `PdConfig` field-by-field and never extracted the `principles` section — `principles.outputLanguage` (canonical language SSOT since PRI-336) was silently dropped between raw YAML and `effective.config` for every `loadPdConfigForPlugin` consumer. The SSOT only *appeared* to work because pd-cli (`config-reader.ts`) and pd-console (`pd-config-store.ts`) re-read the raw YAML in parallel shadow paths. Fixed by extracting/validating `principles` (strict `outputLanguage` via `isValidOutputLanguage`) into the returned config; regression guard `pd-config-principles.test.ts`; prompt.ts now reads the language through this canonical path.
