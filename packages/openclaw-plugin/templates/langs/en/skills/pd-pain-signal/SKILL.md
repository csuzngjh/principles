---
name: pd-pain-signal
description: Manually trigger a Principles Disciple Runtime V2 pain diagnosis. Use this when the user reports the agent is stuck, looping, unresponsive, or asks to record/trigger a pain signal. In an OpenClaw session, direct the Owner to the /pd-pain command (it binds the real session automatically). From outside a session, use `pd pain record --session <id>`. Never write `.state/.pain_flag` and never use legacy write_pain_flag tooling.
disable-model-invocation: false
---

# Pain Signal (Runtime V2)

Session evidence is what makes a pain diagnosable. A pain recorded without a
session carries no trajectory evidence, its candidates score below the
admission threshold (0.5) and are gated as `needs_evidence` — the Owner's
report is stored, but nothing is internalized.

## In an OpenClaw session (preferred)

Ask the Owner to run the host command in the conversation where the pain
occurred:

```text
/pd-pain <describe the issue>
```

`/pd-pain` receives the authenticated current session from OpenClaw and
submits the session's trajectory evidence automatically. You cannot obtain a
trusted session ID yourself (none is injected into tool executions); never
guess, scan, or pick the "latest" session.

## Outside a session (CLI)

Bind an explicitly known session id recorded in this workspace:

```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --session "<session-id>" --json
```

- `--session <id>` is validated against the workspace trajectory: a missing
  session fails with `session_not_found` before anything is written.
- Recording without `--session` is allowed as an unbound Owner report, but it
  attaches no evidence and its candidates will likely be gated
  (`needs_evidence`) by the admission gate — the CLI output says so explicitly.

## Forbidden

- Do not write `.state/.pain_flag` directly.
- Do not use `write_file`, shell redirection, `Set-Content`, `Out-File`, `node -e`, or any other file-writing method to create `.state/.pain_flag`.
- Do not use `write_pain_flag`. That was a legacy path.
- Do not guess, scan for, or infer a session ID. Use `/pd-pain` or an id the Owner provides.

## Verify

Use:
```bash
pd runtime probe --runtime pi-ai --workspace "<workspace>" --json
pd candidate list --workspace "<workspace>" --json
pd runtime flow show --workspace "<workspace>" --json
```

Success requires admitted candidates, not merely generated ones: check
`admissionResults` for `admitted` decisions and non-empty `ledgerEntryIds`.
Candidates reported as `needs_evidence` or `deferred` were NOT internalized —
if all candidates are gated, re-record with `/pd-pain` or `--session` so the
diagnosis carries real trajectory evidence.
