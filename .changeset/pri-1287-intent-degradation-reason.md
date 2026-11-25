---
"@principles/core": patch
"@principles/host-runtime": patch
"@principles/codex-adapter": patch
"@principles/workbuddy-adapter": patch
"principles-disciple": patch
"create-principles-disciple": patch
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


Review follow-ups in the same bounded contract: mixed localized/canonical
headings now tell the Owner that only recognised sections are template-only and
point them at the supported headings; a fresh-read truncation that hides an
authored answer behind earlier TODO material is reported as a truncation
recovery problem rather than as a document with no answer; missing-file recovery
guidance now includes the CLI's required `--confirm` write acknowledgement; and
the Codex/WorkBuddy worker Stage A entry points bind the same durable critical
telemetry sink as the L3 automatic path.

The recovery text keeps the workspace path separate from the copyable POSIX
command instead of emitting a shell-quoted path that can be expanded
incorrectly, and truncation analysis remains internal: degradation telemetry
never carries the untruncated INTENT.md section bodies it inspects.

