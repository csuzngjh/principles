---
name: pd-pain-signal
description: Use when the Owner explicitly asks to record an agent behavior problem, register a pain signal, or trace whether feedback entered the diagnostic pipeline. Automatic pain detection remains the responsibility of existing hooks, host entrypoints, and Runtime.
disable-model-invocation: false
---

# PD Pain Signal

## Purpose

Send the Owner's real behavior feedback through the existing PD pain-registration and diagnosis pipeline while preserving the original statement, source, and available session evidence. This skill does not reimplement detection, deduplication, admission, or diagnosis.

## Steps

1. **Check whether it was already recorded.** The current message may already have been handled by a hook or host entrypoint. If a real receipt exists, reuse its pain/task IDs. Do not submit a duplicate. If registration is not observable, do not claim success or blindly retry.
2. **Preserve the Owner's words.** Use only a statement the Owner explicitly provided. Do not add a technical root cause, score, or tool-failure fact. Quoted text, tool output, and model paraphrases must not be presented as a new Owner submission.
3. **Use the trusted host entrypoint.**
   - In the OpenClaw session where the issue occurred, when the Owner explicitly requests registration, use the host command `/pd-pain <issue description>`. OpenClaw binds the authenticated current session.
   - Outside the session, use the CLI only with a known, validated session: `pd pain record --reason "<reason>" --workspace "<workspace>" --session "<session-id>" --json`.
4. **Do not guess session IDs.** Never scan the database, pick the "latest" session, or substitute another host's ID. If the required session identity is missing, stop that CLI path and explain why.
5. **Verify the receipt.** Report registration only when the actual receipt confirms it. Without a receipt, say registration is unconfirmed.

## Evidence and success criteria

- A real pain ID proves only that registration returned a receipt, not that diagnosis completed.
- Generated candidates are not necessarily admitted.
- Check the actual `admissionResults` / `candidateOutcomes` for an `admitted` decision and its non-empty `ledgerEntryIds`. A non-empty `candidateIds` alone is not success.
- Report `needs_evidence`, `deferred`, and explicit admission rejection honestly. Never bypass the admission gate or fabricate trajectory evidence to increase confidence.
- The Owner's statement, host trajectory, model diagnosis, admission result, Owner approval, and activation state are distinct evidence types.

## Failure handling

- Registration failure: preserve the real error and the host-provided next action.
- Duplicate risk: check existing receipts and idempotency first.
- Missing or untrusted session: stop; never guess.
- CLI/hook unavailable: ask `pd-cli-operator` to inspect status; route installation repair to `pd-control`.
- If the Owner wants to inspect resulting candidates, use `pd-review` to open the Console; do not re-register the same feedback.

## Never

- Write `.state/.pain_flag` or call legacy `write_pain_flag`.
- Fabricate the Owner's words, session ID, turn ID, or tool failure.
- Re-submit an event whose registration is confirmed.
- Modify the pain database, candidate ledger, or admission state directly.
- Approve, activate, or edit a principle.
