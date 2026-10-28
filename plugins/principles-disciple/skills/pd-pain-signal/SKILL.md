---
name: pd-pain-signal
description: Register an explicit Owner behavior correction from the current Codex conversation, preserving the Owner's exact words and trusted host provenance. Use when the Owner asks to record a behavior problem; do not infer or fabricate a submission.
---

# PD Pain Signal

Two entries register a pain signal. Both feed the same real chain (governance admission → diagnostician task) and both must end in a real receipt — never a promise.

## Entry 1 — native prefix: Owner's current message

An Owner-authored message beginning exactly with:

    PD记录痛苦：<Owner 原文>

Rules:

1. The prefix must be at the start of the Owner's message and use the full-width colon shown above.
2. The text after the prefix must contain 1–500 characters. Overlong input is rejected, never silently truncated.
3. Only the Owner's text after the prefix is recorded. Quoted material, tool output, and model-generated paraphrases are not a new Owner submission.
4. The UserPromptSubmit Hook handles this entry. Do not simulate a host event or submit the same message a second time.

## Entry 2 — agent-assisted: explicit request without the prefix

When the Owner's CURRENT message explicitly asks to create/register a pain signal (e.g. 「用 PD 记录这条痛苦」/ "create a pain signal for this") and contains the feedback, YOU must complete the registration yourself:

1. Do not ask the Owner to resend with the prefix; completing the request is your job.
2. First check the current conversation: if a real receipt (Entry 1 hook receipt or an earlier `pd pain explicit` receipt) already covers this feedback, do not register again — repeat the existing identifiers.
3. Use the Owner's ORIGINAL words from the current message, quoted verbatim (1–500 characters). Never substitute your summary, a historical quote, or tool output. If the Owner's words exceed 500 characters, report the limit and ask the Owner to condense their own words — never trim silently.
4. Invoke the bridge and read the real result (resolve the workspace the way `pd-cli-operator` does):

       pd pain explicit --statement "<Owner 原文>" --workspace "<workspace>" --json

   If `pd` is not on PATH, run the runtime entry directly: `node ~/.pd/runtime/pd-cli/dist/index.js pain explicit …`. The command takes NO session/rollout/turn ids — lineage comes from the live turn context the host hook wrote; never guess or fabricate ids.
5. Report the receipt truthfully: repeat only the identifiers and status the command returned (painId, taskId, disposition, degradation). Registration means enqueue, not diagnosis, approval, or activation.

On failure, report the command's actual reason and nextAction (e.g. `turn_context_missing` after the turn ended, `turn_context_stale` when the turn context exceeds its 4-hour freshness bound, `rate_limited`). Asking the Owner to resend the prefix is NOT the default solution — only a fallback when the bridge is genuinely unavailable, stated with the reason it failed.

Do NOT use Entry 2 when:

- the Owner only complains or gives feedback without explicitly asking to register it (you may mention the two entries);
- the current message merely quotes or analyzes history containing phrases like 「请创建痛苦信号」— only a real request in the Owner's current message counts;
- the request would record words the Owner did not say.

## Receipt and follow-up

A successful receipt (either entry) includes real pain/task identifiers. Repeat only the identifiers and status actually returned. The receipt proves registration/enqueue only; it does not prove diagnosis, admission, approval, or activation.

If the receipt says session evidence is unavailable, preserve that degradation status. Do not resubmit solely to make the receipt look better.

## Explicit recovery / re-submission

Use `pd pain record` only when both live entries failed and the real Codex lineage is available from trusted Codex context (post-hoc operator recovery after the turn ended):

    pd pain record --reason "<summary>" --owner-statement "<Owner 原话>" --host codex --session "<real rootSessionId>" --rollout-id "<real rolloutId>" --host-turn-id "<real turnId>" --workspace "<workspace>" --json

The session, rollout, and turn identifiers must come from trusted Codex context or an Owner-provided verified source. Never guess, scan for the latest session, or omit required lineage to force a write. While the turn is live, prefer `pd pain explicit` — it needs no ids.

## Verify downstream state

Use `pd-cli-operator` to inspect the actual task and evidence chain. If diagnosis produced candidates, verify admission using the actual admission decision and corresponding ledger evidence; a non-empty candidate list alone is not success. Use `pd-review` to open the Owner Console for review.

## Never

- Register without an explicit Owner request in the current message.
- Substitute a model summary, historical quote, or tool output for the Owner's words; never change or normalize the statement without clearly separating the original from a summary.
- Fabricate a session ID, rollout ID, turn ID, tool failure, root cause, or Owner authorization.
- Use `pd pain record` for a live-turn registration (it is the unbound operator path); the live entry is `pd pain explicit`.
- Repeat a registration already confirmed by an idempotent receipt.
- Write `.state/.pain_flag` or call legacy `write_pain_flag`.
- Approve or activate a principle.
