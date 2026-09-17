<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-110",
  "displayId": "ERR-110",
  "title": "Published security disclosure contradicts shipped code — a network-capable subsystem landed without updating the README that explicitly denied it",
  "status": "active",
  "category": "Documentation & Spec Drift",
  "ep": "EP-06",
  "createdAt": "2026-08-28",
  "source": "owner-directed task 2026-08-28 (no Linear issue); ClawHub audit 2026-08-26, plugin v1.222.4; remediation PR #1430"
}
-->

**Recurrence**: 2026-08-28 PR #1430 self-review — the first root README remediation described telemetry as the only outbound path and still omitted Owner-configured LLM provider calls. Fixed the English and Chinese disclosures and strengthened the disclosure contract test to require the provider-network path explicitly.
