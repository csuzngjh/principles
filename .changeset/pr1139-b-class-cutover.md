---
"@principles/core": major
"@principles/host-runtime": minor
"principles-disciple": minor
"create-principles-disciple": minor
---

refactor(core,host-runtime,pd-console): PRI-1139 B-class canonical contract write-side cutover (PRI-1104 PR-6)

- **core (major)**: the output-schema registry keys become version-neutral
  canonical keys (13 refs drop their `-v1/-v2` suffix); the pre-cutover
  spellings still resolve through the PRI-1104 alias table. The public
  barrel loses the retired zero-consumer helpers `schemaRef()`,
  `RUNTIME_SCHEMA_VERSION`, `SchemaVersionRefSchema` and
  `RuntimeSchemaVersionSchema`, replaced by the single
  `RUNTIME_CONTRACT_SCHEMA_VERSION = 'current'` token (plus the legacy
  `'1'` token and a dual-read union schema). Governance/approval/owner-
  decision contracts now accept both `'current'` and legacy `'1'`
  schemaVersion values; the approval review guard accepts both
  `approval-review` and legacy `approval-review-v1`.
- **host-runtime (minor)**: the prompt budget policy id switches from
  `model_aware_v2` to `model_aware` (formula unchanged; both event
  spellings remain readable and revert-safe); the Stage-2 classifier
  requests the canonical `signal-classification-output` ref.
- **principles-disciple / create-principles-disciple (minor)**: the
  console client calls canonical `/api` paths (server keeps the
  deprecated `/api/v1` alias — external integrations unaffected);
  TrajectoryDatabase no longer reads the schema_version epoch (single
  DDL-owner writer only).
