---
name: pd-pain-signal
description: Register an explicit Owner behavior correction from the current Codex conversation, preserving the Owner's exact words and trusted host provenance. Use when the Owner asks to record a behavior problem; do not infer or fabricate a submission.
---

# PD Pain Signal

## Normal entry: Owner's current message

The supported Codex entry is an Owner-authored message beginning exactly with:

    PD记录痛苦：<Owner 原文>

Rules:

1. The prefix must be at the start of the Owner's message and use the full-width colon shown above.
2. The text after the prefix must contain 1–500 characters. Overlong input is rejected, never silently truncated.
3. Only the Owner's text after the prefix is recorded. Quoted material, tool output, and model-generated paraphrases are not a new Owner submission.
4. The UserPromptSubmit Hook is the normal path. Do not simulate a host event or submit the same message a second time.

If the Owner asks to record feedback but the current message does not contain the prefix, provide the exact message format and ask the Owner to submit it. Do not impersonate the Owner by emitting the prefix yourself.

## Receipt and follow-up

A successful hook receipt includes real pain/task identifiers. Repeat only the identifiers and status actually returned. The receipt proves registration/enqueue only; it does not prove diagnosis, admission, approval, or activation.

If the receipt says session evidence is unavailable, preserve that degradation status. Do not resubmit solely to make the receipt look better.

## Explicit recovery / re-submission

Use the CLI only when the normal host path failed and the real Codex lineage is available:

    pd pain record --reason "<summary>" --owner-statement "<Owner 原话>" --host codex --session "<real rootSessionId>" --rollout-id "<real rolloutId>" --host-turn-id "<real turnId>" --workspace "<workspace>" --json

The session, rollout, and turn identifiers must come from trusted Codex context or an Owner-provided verified source. Never guess, scan for the latest session, or omit required lineage to force a write.

## Verify downstream state

Use `pd-cli-operator` to inspect the actual task and evidence chain. If diagnosis produced candidates, verify admission using the actual admission decision and corresponding ledger evidence; a non-empty candidate list alone is not success. Use `pd-review` to open the Owner Console for review.

## Never

- Change or normalize the Owner's statement without clearly separating the original from a summary.
- Fabricate a session ID, rollout ID, turn ID, tool failure, root cause, or Owner authorization.
- Repeat a registration already confirmed by an idempotent receipt.
- Write `.state/.pain_flag` or call legacy `write_pain_flag`.
- Approve or activate a principle.
