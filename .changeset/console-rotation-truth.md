---
"@principles/host-runtime": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

The console's prompt-injection budget forecast now mirrors the production
selection policy instead of silently defaulting to the legacy FIFO prefix
(PRI-935). The forecast previously called the budget selector without its
round key, which did not make it conservative — it selected a different
policy, one that structurally excludes the newest activation from every
truncated selection. The console therefore told the Owner an approved
principle "will NOT enter agent behavior until older ones are deactivated"
while the live injection path rotates and injects it within a bounded number
of user turns, pushing Owners to deactivate healthy principles.

buildLivePromptInjectionProjection now accepts the caller's round key and
reports the policy it actually ran, the eligible count, whether production
rotates on this route, and the set of activations reachable under some round.
Reachability is a property of the policy rather than of a single round, so a
console with no session round key can still distinguish an activation that is
merely rotated out of the current window from one that is genuinely starved.
Approve now emits injection_budget_queued for the queued case — with a bounded
"within at most N consecutive user turns" statement and an explicit note that
deactivating older principles is not required — and reserves
injection_budget_excluded for real starvation, no longer asserting a FIFO
ordering the production route does not use. The pre-decision queue badge and
both locales follow the same policy, and the raw English server text is
collapsed behind a native details element so the toast no longer renders as one
mixed Chinese/English block (still preserved verbatim).

The shared host route deliberately passes no round key and continues to report
legacy_fifo_prefix_v1, so cross-host fairness remains PRI-930 and is not
claimed here. All new projection fields are optional; payloads without them
validate as before and render policy-agnostic copy.
