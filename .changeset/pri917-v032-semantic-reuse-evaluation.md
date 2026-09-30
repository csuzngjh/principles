---
'@principles/core': minor
'@principles/pd-cli': minor
---

PRI-917 v0.3.2 — Semantic Reuse Evaluation Capability (five-layer merge train).

principles-core: reuse-evaluation-output contract (closed field set +
cross-field rules), ReuseEvaluationRunner (proposal-only, PDRuntimeAdapter +
structured-output-repair), reuseEvaluation config section, profile-id
runtime resolution, reuse_evaluation_recommended/unavailable telemetry
events.

pd-cli: pd candidate review shows the semantic evaluation (advisory — the
Owner decides; observable degrade to lexical-only), and reuse_selected
intake outcomes report the resolution instead of a refused-write error.

Governance boundary unchanged: the capability only RECOMMENDS; the Owner's
verdict is recorded exclusively in Principle.reuseEvidence[]. No new
database, decision storage, relationship entity, capability registry, or
agent registration.
