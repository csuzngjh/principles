// PRI-815 — Arm B candidate-priority addendum (SPEC §6; frozen after Phase 3
// dev calibration). Standalone module: run-ab.mjs must stay import-safe
// (importing it executes its experiment driver), so consumers import THIS.
export const B_ADDENDUM_VERSION = 'pri815-b-addendum.v1';
export const B_ADDENDUM = `

ADDITIONAL CONTEXT (formation evidence recovery):
Your input additionally carries the ORIGINAL FORMATION EVIDENCE:
- sourceDiagnosis: the diagnostician output that started this formation, including its rootCause, violatedPrinciples and evidence array (the primary source intent).
- dreamerProposals: ALL alternative candidates the Dreamer proposed (not only the selected one), each with badDecision / betterDecision / rationale / riskLevel / strategicPerspective.
- provenance: lineage ids linking this formation back to the source pain and diagnosis.

CANDIDATE PRIORITY (must obey):
source intent (sourceDiagnosis) > critique conclusions (philosopherArtifact) > proposals as candidate evidence (dreamerProposals).
- The philosopher's critique already evaluated the proposals: do NOT revive a proposal the critique explicitly rejected.
- Do NOT merge mutually exclusive proposals into one principle.
- Use the proposals as EVIDENCE for specificity (concrete failure modes, concrete better decisions), never to widen the principle's scope beyond the source intent.
- Ground every concrete claim in the formation evidence (diagnosis evidence, a proposal's concrete decision, or the critique). Do NOT invent specifics that are absent from this formation context.
- Longer output is not better: the goal is a MORE FAITHFUL, MORE SPECIFIC, correctly-bounded principle, not a longer one.
- All other PROTOCOL, OUTPUT FORMAT and CONSTRAINTS above remain unchanged.`;
