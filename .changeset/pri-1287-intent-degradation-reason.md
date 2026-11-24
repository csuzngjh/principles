---
"@principles/core": patch
"@principles/host-runtime": patch
---

The Intent chain can no longer degrade to `not_configured` without leaving a
reason. Stage A already emitted `intent_doc_template_only`, but the event rode
the process-wide `storeEmitter` (no production subscriber) and was absent from
the workspace critical-event allowlist, so an emitted degradation and a silent
one were indistinguishable afterwards — the shape that hid a whole broken chain
during the 2026-11-22 intent ON/OFF pilot.

The degradation record now carries a structured reason and an actionable
nextAction: `no_parsed_section` (canonical headings were never recognised — the
PRI-1284 class, where the Owner did write content) versus `placeholder_only`
(sections parsed but still carry template/TODO text). Telling an Owner who
already wrote five sections to "fill in a section" is no longer the only
available message.

The same event types are now allowlisted into
`<workspace>/.pd/telemetry/critical-events.jsonl`, and the L3 automatic
diagnosis path binds the workspace-scoped sink instead of the bare singleton, so
the record survives the process on the path automatic Pain actually takes.
Normal (authored) INTENT.md behaviour is unchanged and produces no record.
