---
'@principles/core': patch
'@principles/pd-cli': patch
---

PRI-917 v0.3.2 review fixes (PR #1902 review findings, 2 P1 + 4 P2).

principles-core: the missing-profile warning in the effective config now
judges the RESOLVED enabled value (legacy configs without the
reuseEvaluation section no longer silently skip it); isValidReuseEvaluation
Output delegates to the full trust boundary (closed field set + cross-field
rules) instead of the bare open-field-set schema check.

pd-cli: a source=default OpenClaw profile resolves in delegated mode in the
runtime-adapter-resolver (identical semantics to
pain-signal-runtime-factory's validateRuntimeConfig) — the semantic reuse
evaluation capability now actually RUNS under the default configuration
instead of permanently degrading to unavailable; the evaluation timeout
falls back to the resolved profile's own timeoutMs; a hallucinated
selectedPrincipleId is downgraded to unavailable
(selected_principle_not_in_shortlist) instead of being shown as an
executable recommendation; the production-validation E2E creates its
workspace under os.tmpdir().
