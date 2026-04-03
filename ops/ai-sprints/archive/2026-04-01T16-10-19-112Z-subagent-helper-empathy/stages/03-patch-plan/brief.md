# Stage Brief

- Task: Subagent Helper: migrate empathy observer to workflow helper
- Stage: patch-plan
- Round: 1

## Goals
- Design EmpathyObserverManager spec with workflowType, transport, timeout, ttl, parseResult, persistResult.
- Plan shadow-run period: old and new transport coexist, dedupeKey prevents dual finalize.
- Define cleanup strategy: completed_with_cleanup_error vs cleanup_pending states.
- Define empathy-check.json output format for empathy persistence validation.

## Carry Forward

- None.

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
- ## CODE_EVIDENCE
- ## INTERFACE_ASSESSMENT
- ## NEXT_FOCUS
- ## CHECKS
Examples of valid headings: ## VERDICT, ## BLOCKERS, ## FINDINGS, ## TRANSPORT_ASSESSMENT, ## OPENCLAW_ASSUMPTION_REVIEW, ## NEXT_FOCUS, ## CHECKS, ## DIMENSIONS
You MUST include ALL sections listed above. Omitting any section will cause the sprint to halt.

## Required Producer Sections
The producer report MUST use exactly these section headings (markdown format):
- ## SUMMARY
- ## CHANGES
- ## CODE_EVIDENCE
- ## EVIDENCE
- ## INTERFACE_SPEC
- ## SHADOW_RUN_PLAN
- ## CHECKS

## Scoring Dimensions
Reviewers will score this stage on a 1-5 scale across these dimensions:
- plan_completeness
- interface_soundness
- shadow_run_safety
- rollback_defined
Threshold: each dimension must score at least 3/5.

## Contract Template
The producer must include a CONTRACT section declaring the status of each deliverable.
Required deliverables:
- empathy_observer_spec
- workflow_spec
- shadow_run_plan
- rollback_steps
Format: CONTRACT: followed by bullets like: - <description> status: DONE|PARTIAL|TODO

## Exit Criteria
- Both reviewers return VERDICT: APPROVE
- No unresolved blocker remains in reviewer outputs
- All scoring dimensions meet threshold (3/5)
- All contract deliverables reach status: DONE
- Producer report must contain sections: SUMMARY, CHANGES, CODE_EVIDENCE, EVIDENCE, INTERFACE_SPEC, SHADOW_RUN_PLAN, CHECKS
- Reviewer reports must contain sections: VERDICT, BLOCKERS, FINDINGS, CODE_EVIDENCE, INTERFACE_ASSESSMENT, NEXT_FOCUS, CHECKS

