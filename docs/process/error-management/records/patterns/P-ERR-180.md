<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-180",
  "displayId": "ERR-180",
  "title": "Assertion checked the copy constant, not the rendered output: a whitespace-collapsing emitter flattened a paste-ready YAML snippet and the substring assertions still passed",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-09",
  "createdAt": "2026-10-31",
  "source": "PR 2253 code review (agent), measured on the real diagnostic() emitter"
}
-->

A user-visible instruction was rewritten to be paste-ready YAML, but every hook surface renders it through a bounding helper that normalizes the text with `replace(/\s+/g, ' ')` before emitting it. The multi-line snippet therefore arrived as `... features: host.codex: enabled: true` — one flattened line that is not YAML. The regression test added with the change asserted `toContain('codex_conversation_ingestion:')` and `toContain('enabled: true')`, both of which are TRUE of the flattened string, so the suite reported success on a surface no user could use.

Mechanism: the assertion was written against the *content* of the copy, not against the *rendered output of the same pipeline that emits it*. Any transform between the constant and the user (whitespace collapsing, length clamping, redaction, i18n substitution) can invalidate a paste-ready claim while leaving substring assertions green.

Must check: when a string is promised to be machine-consumable (pasteable YAML/JSON/command), the regression must (a) obtain it from the real emitter, not the constant, (b) assert the property the promise depends on — here, no whitespace-collapse damage and successful parse of the snippet — and (c) drive the parse with the project's real parser. A substring assertion is evidence about the source text, not about what the user receives.
