---
name: pd-pain-signal
description: Register an anchored behavior deviation (Pain) from the current conversation. Use when the Owner explicitly asks to record a concrete behavior problem and you can name the anchor. The anchored write goes through the PD MCP tool pd_submit_pain; never submit in the background and never invent an anchor.
---

# PD Pain Signal

Pain = a concrete behavior deviation relative to a named anchor. Three elements must hold together:

1. **Anchor** — an Owner expectation, an established principle, or an in-force Agent Instruction / Skill requirement.
2. **Concrete behavior** — what you actually did or failed to do.
3. **Significant deviation** — a describable gap against that anchor.

No proven impact, no repetition and no prior Owner correction are NOT reasons to withhold a submission. They only help the Owner decide attention priority.

## Entry 1 — native host entries (Owner-initiated, not yours)

These are handled by the host itself. Report the real receipt if you can see one; never simulate the event or register the same message a second time.

| host | Owner entry |
|---|---|
| Codex | an Owner message beginning exactly with `PD记录痛苦：<Owner 原文>` (full-width colon, 1–500 characters) |
| OpenClaw | the Owner command `/pd-pain <description>` |

## Entry 2 — anchored submission: MCP tool `pd_submit_pain`

Check your tool list first.

- If `pd_submit_pain` is available, call it with the four possible arguments below.
- If it is not in your tool list, the anchored write capability is NOT enabled in this deployment. Stop: do not call a look-alike tool, do not compose a CLI write with guessed lineage, do not claim a submission happened. Tell the Owner the capability is unavailable.

| argument | required | contract |
|---|---|---|
| `reason` | yes | 1–2000 characters, organized as the six parts below |
| `anchorType` | yes | `owner_expectation` / `established_principle` / `agent_instruction` |
| `anchorRef` | yes | 1–300 characters, format depends on anchor type |
| `painType` | no | `principle_deviation` / `tool_failure` / `subagent_error` / `user_frustration` |

The schema is strict. `score`, `severity`, `priority`, `sessionId`, `approved`, file paths and metadata are rejected before anything is written.

### Codex legacy live-turn path

Codex still has `pd pain explicit --statement "<Owner 原文>" --workspace "<workspace>" --json` while the turn is live (no ids; 1–500 characters). It carries **no anchor fields**, so it registers a plain Owner statement and does NOT satisfy the anchored contract above. Use it only when the Owner explicitly asks for that legacy entry and `pd_submit_pain` is unavailable; never present it as an anchored Pain.

## Anchors

Pick exactly one type. `anchorRef` must let another reader find the requirement.

### `owner_expectation`

The Owner stated it — in this conversation, in an Owner document, or in an approved decision. `anchorRef` names where, e.g. `本次对话 14:02 Owner: "..."` or `docs/xxx.md §2`.

- Never submit an Owner expectation you can only recall. If there is no citable location, ask the Owner or do not submit.

### `established_principle`

`anchorRef` MUST be `<principleId>@<version>` (e.g. `P-42@1`). Get both from `pd principle list`; never guess or infer the version.

The server verifies existence, version and status:

- `active` or `probation` → usable as the basis of a deviation.
  `probation` returns an `anchor_probation` warning: the deviation is valid, the principle is still being validated.
- `candidate`, `archived`, `deprecated` → not usable as a basis; background only.

The server checks existence/version/status only. **Scope applicability and priority conflicts are not machine-checkable here.** If you cannot establish that the principle applies to this situation, say "适用性待确认" in `reason` instead of presenting it as settled.

### `agent_instruction`

`anchorRef` MUST be `<path>#<section>` and MUST NOT contain spaces, e.g. `AGENTS.md#verification`. It must point at a requirement in force for the current host (AGENTS.md, PRINCIPLES.md, SKILL.md, tool guide).

### No anchor

If you cannot classify the anchor into one of the three types, do not submit. Clarify with the Owner first.

## `reason` — six parts, in this order

1. **Anchor** — quote or name it (principle id@version, instruction path#section, Owner statement + location).
2. **Anchor source and citation grade** — `verbatim` / `paraphrase` / `recollection` / `inference`. Do not upgrade the grade. A `recollection` or `inference` alone is not enough: confirm the wording with the Owner first.
3. **Observed behavior** — specific actions, order, skipped steps, overreach. Not "the quality was poor".
4. **Deviation** — the gap against the anchor: not done / done backwards / done but bypassed.
5. **Why worth recording** (auxiliary) — helps the Owner prioritize. It is NOT an admission condition and must never be used to reject an otherwise valid Pain.
6. **Context** — where and when it happened, bounded.

Never hide a conflicting anchor. Never inflate the deviation to make it easier to accept. Never turn part 5 into a threshold.

## Authorization — one submission only

Before calling the tool, state to the Owner:

1. the anchor and where it comes from;
2. the concrete behavior you observed;
3. the deviation between them;
4. optionally, why it may matter.

Then obtain the Owner's explicit consent **in the current conversation**.

- No reply, an ambiguous answer, or a bare "whatever" is NOT authorization.
- If the Owner edits the content, re-confirm the final version before submitting.
- The authorization covers this one submission only. Never reuse it for another Pain, another session, or a retry with changed content.
- Background, scheduled, hook-driven and unattended runs MUST NOT submit on their own.

## Severity and `painType`

- Never send a score or severity. The tool has no such parameter, and the system records an omitted severity as **moderate**. You cannot self-elevate; if you think the case is severe, say so inside `reason` for the Owner to judge.
- Omit `painType` unless you can classify it with confidence. The default is `principle_deviation`.
- Never backfill `user_frustration` (or any other type) to make a submission look more urgent.

## Reading the receipt

The tool returns one JSON receipt (`pd.pain-submit-receipt.v1`):

```
status, painId, taskId, workspaceDir, diagnosis, anchor, provenance, warnings, error, nextAction
```

| status | meaning | what you do |
|---|---|---|
| `submitted` | the pain and its diagnosis task were written | report `painId` / `taskId`. `diagnosis.status` is `pending`: diagnosis has NOT run |
| `refused` | nothing was written (for `task_duplicate`, an equivalent task already existed) | report `error.code` + `nextAction`; do not retry blindly |
| `failed` | the write failed; this is the only status with `isError: true` | report `error.code` / `error.message` / `nextAction`; a task may or may not exist |
| `submit_unconfirmed` | the write began and its outcome is unknown (deadline or exception) | never resubmit; run `pd task show <taskId>` and reconcile first |

`refused` codes you may see: `invalid_input`, `anchor_invalid`, `anchor_unverifiable` (ledger unreadable), `anchor_not_found` (unknown id/version or empty ledger), `anchor_not_currently_valid`, `task_duplicate`, `ingress_*`.

Degraded transports:

- `minimal` — the receipt was reduced to `status / painId / taskId / workspaceDir / diagnosis`.
- `untransportable` — a plain-text statement, or an `isError: true` envelope. An unknown outcome is always reported as UNKNOWN, never as "nothing was written".

Report only the identifiers and status the receipt actually returned. Registration is not diagnosis, not candidate admission, not approval, not activation.

To inspect the downstream chain, use `pd task show <taskId>`; to open the Owner Console, use `pd-review`.

## Never

- Submit without an explicit Owner request and consent in the current message.
- Submit from a background, scheduled, hook or unattended run.
- Invent an anchor, a principle id@version, an Instructions path, or an Owner quote.
- Send score, severity, priority, session ids or approval tokens.
- Bypass an unavailable `pd_submit_pain` with a CLI write using guessed lineage, a local switch, or a host matcher.
- Resubmit after `submit_unconfirmed` without reconciling via `pd task show <taskId>`.
- Write `.state/.pain_flag` or call legacy `write_pain_flag`.
- Approve, activate or modify a principle.
