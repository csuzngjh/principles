<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-161",
  "displayId": "ERR-161",
  "title": "Retry loop re-sent a provider-rejected request parameter unchanged — a deterministic parameter rejection was classified as transient, so all N attempts failed identically",
  "status": "active",
  "category": null,
  "ep": "EP-05",
  "createdAt": "2026-10-17",
  "source": "PRI-1011: installed OpenClaw workspace, correctionObserver 400 max_tokens rejections recurring 2026-10-16; fixed on branch ai/PRI-1011-maxtokens-downshift"
}
-->

The CorrectionObserver (and every other internal agent bound to the `pi-ai.amd-ds-vision` runtime profile) failed on the Owner's machine for days with `400 The requested max_tokens (32000) exceeds the maximum output tokens allowed for model ...`. Nothing recovered it, and the retry loop contributed to the blindness: `completeWithRetry` classifies a resolved provider error as either `rate_limit` or `execution_failed`, and `execution_failed` is by definition *transient*, so every retry resent the byte-identical request — same `max_tokens`, same prompt, same 400 — burning all attempts and ending in the same failure. The provider had answered a **parameter** question ("that budget is not allowed here") and PD re-asked it as a **transport** question ("maybe the network was busy"). The class: a retry loop that re-sends a request the callee deterministically rejected is not a retry, it is the same failed call N times, and its only observable output is an exhausted-attempts error that reads like instability. This is the mirror image of ERR-144: there a bounded-wait timeout was *reported* as a deterministic data error; here a deterministic parameter rejection was *acted on* as a transient one. Fix discipline (PRI-1011): recognise the rejection signature narrowly (`max[_ ]?tokens ... exceed` / `exceeds the maximum output tokens`), keep the existing error category — the classification is a downstream contract, the *request* is what must change — and mutate the rejected parameter for the next attempt with a bounded ladder that stops at a floor chosen so a smaller budget cannot trade the rejection for a silent truncation. When the profile relies on the callee's own defaulting, the ladder must materialise that default into a concrete number, otherwise "send nothing" resends exactly the rejected value. Each step emits its own telemetry event, so the Owner sees what was tried instead of only that it failed. Detection signal: any retry loop whose error branches choose only between "wait" and "give up" has no way to express "change the request", so a deterministic rejection is indistinguishable from instability — before adding a new error class, check whether the loop can act on the difference. Related: ERR-144 (misreported transient/deterministic boundary), ERR-157 (repeated structured-output rejection blamed on the model before the request side was audited).
