# Stage Brief

- Task: Subagent Helper: migrate empathy observer to workflow helper
- Stage: investigate
- Round: 1

## Goals
- Audit empathy observer's current plugin-owned path as runtime_direct only.
- Identify all currently referenced lifecycle hooks and classify each as primary, fallback, observation, or UNPROVEN.
- Document timeout/error/fallback/cleanup paths and identify where runtime availability or boot-session handling can force degrade.
- Assess OpenClaw assumptions: does runtime.subagent.run() only launch a run, or does it also guarantee registry-backed completion semantics?

## Required Hypotheses
- empathy_uses_runtime_direct_transport
- empathy_has_unverified_openclaw_hook_assumptions
- empathy_timeout_leads_to_false_completion
- empathy_cleanup_not_idempotent
- empathy_lacks_dedupe_key

## Carry Forward

- None.

## Constraints
- Use PD-only changes; do not modify D:/Code/openclaw.
- PR2 scope: empathy observer + deep-reflect ONLY. Diagnostician/Nocturnal NOT migrated in this PR.
- Helper lives in packages/openclaw-plugin/src/service/subagent-workflow/.
- Treat empathy as plugin-owned runtime_direct only. Do not mix registry_backed semantics into the main model.
- subagent_ended may be used only as fallback, observation, or UNPROVEN signal. It is NOT the primary completion contract.
- If runtime subagent availability is unproven for a surface, the design must degrade instead of forcing sidecar execution.
- All OpenClaw compatibility assumptions must be verified by reviewer_b via cross-repo source reading.

## Required Reviewer Sections
Your report MUST use exactly these section headings (markdown format):
- ## VERDICT
- ## BLOCKERS
- ## FINDINGS
- ## TRANSPORT_ASSESSMENT
- ## OPENCLAW_ASSUMPTION_REVIEW
- ## NEXT_FOCUS
- ## CHECKS
- ## DIMENSIONS
Examples of valid headings: ## VERDICT, ## BLOCKERS, ## FINDINGS, ## TRANSPORT_ASSESSMENT, ## OPENCLAW_ASSUMPTION_REVIEW, ## NEXT_FOCUS, ## CHECKS, ## DIMENSIONS
You MUST include ALL sections listed above. Omitting any section will cause the sprint to halt.

## Required Producer Sections
The producer report MUST use exactly these section headings (markdown format):
- ## SUMMARY
- ## EVIDENCE
- ## CODE_EVIDENCE
- ## KEY_EVENTS
- ## TRANSPORT_AUDIT
- ## OPENCLAW_ASSUMPTIONS
- ## CHECKS

## Scoring Dimensions
Reviewers will score this stage on a 1-5 scale across these dimensions:
- evidence_quality
- assumption_coverage
- transport_audit_completeness
Threshold: each dimension must score at least 3/5.

## Contract Template
The producer must include a CONTRACT section declaring the status of each deliverable.
Required deliverables:
- transport_audit
- lifecycle_hook_map
- openclaw_assumptions_documented
- failure_mode_inventory
- surface_sidecar_gate
Format: CONTRACT: followed by bullets like: - <description> status: DONE|PARTIAL|TODO

## Exit Criteria
- Both reviewers return VERDICT: APPROVE
- No unresolved blocker remains in reviewer outputs
- All scoring dimensions meet threshold (3/5)
- All contract deliverables reach status: DONE
- Producer report must contain sections: SUMMARY, EVIDENCE, CODE_EVIDENCE, KEY_EVENTS, TRANSPORT_AUDIT, OPENCLAW_ASSUMPTIONS, CHECKS
- Reviewer reports must contain sections: VERDICT, BLOCKERS, FINDINGS, TRANSPORT_ASSESSMENT, OPENCLAW_ASSUMPTION_REVIEW, NEXT_FOCUS, CHECKS, DIMENSIONS

