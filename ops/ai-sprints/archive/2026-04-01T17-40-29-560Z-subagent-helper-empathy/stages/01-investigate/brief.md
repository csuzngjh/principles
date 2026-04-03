# Stage Brief

- Task: Subagent Helper: migrate empathy observer to workflow helper
- Stage: investigate
- Round: 3

## Goals
- Audit empathy observer's current subagent transport: runtime_direct vs registry_backed.
- Identify all lifecycle hooks (subagent_spawned, subagent_ended, etc.) currently used.
- Document current timeout/error/fallback/cleanup paths and their failure modes.
- Assess OpenClaw assumptions: does runtime.subagent.run() guarantee subagent_ended hook?

## Required Hypotheses
- empathy_uses_runtime_direct_transport
- empathy_has_unverified_openclaw_hook_assumptions
- empathy_timeout_leads_to_false_completion
- empathy_cleanup_not_idempotent
- empathy_lacks_dedupe_key

## Carry Forward

### What was accomplished
- transport_audit
- lifecycle_hook_map
- openclaw_assumptions_documented
- failure_mode_inventory

### What needs to change
- No blockers from previous round.

### Focus for this round
- Follow stage goals.

## Constraints
- Use PD-only changes; do not modify D:/Code/openclaw.
- PR2 scope: empathy observer + deep-reflect ONLY. Diagnostician/Nocturnal NOT migrated in this PR.
- Helper lives in packages/openclaw-plugin/src/service/subagent-workflow/.
- Keep code quality high and avoid unnecessary architectural expansion.
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
Format: CONTRACT: followed by bullets like: - <description> status: DONE|PARTIAL|TODO

## Exit Criteria
- Both reviewers return VERDICT: APPROVE
- No unresolved blocker remains in reviewer outputs
- All scoring dimensions meet threshold (3/5)
- All contract deliverables reach status: DONE
- Producer report must contain sections: SUMMARY, EVIDENCE, CODE_EVIDENCE, KEY_EVENTS, TRANSPORT_AUDIT, OPENCLAW_ASSUMPTIONS, CHECKS
- Reviewer reports must contain sections: VERDICT, BLOCKERS, FINDINGS, TRANSPORT_ASSESSMENT, OPENCLAW_ASSUMPTION_REVIEW, NEXT_FOCUS, CHECKS, DIMENSIONS

