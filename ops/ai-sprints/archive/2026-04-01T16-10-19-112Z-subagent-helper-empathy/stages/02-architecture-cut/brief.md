# Stage Brief

- Task: Subagent Helper: migrate empathy observer to workflow helper
- Stage: architecture-cut
- Round: 2

## Goals
- Decide: migrate empathy to helper (runtime_direct transport) or keep existing?
- Define the EmpathyObserverManager interface: startWorkflow(), finalizeOnce(), etc.
- Document OpenClaw compatibility assumptions and cross-repo verification results.
- global_reviewer must explicitly answer: Is migration architecturally sound? Are assumptions verified?

## Carry Forward

### What was accomplished
- architecture_decision
- openclaw_cross_repo_verification
- helper_interface_draft
- shadow_run_plan

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
- ## OPENCLAW_COMPATIBILITY_REVIEW
- ## ARCHITECTURE_ASSESSMENT
- ## NEXT_FOCUS
- ## CHECKS
Examples of valid headings: ## VERDICT, ## BLOCKERS, ## FINDINGS, ## TRANSPORT_ASSESSMENT, ## OPENCLAW_ASSUMPTION_REVIEW, ## NEXT_FOCUS, ## CHECKS, ## DIMENSIONS
You MUST include ALL sections listed above. Omitting any section will cause the sprint to halt.

## Required Producer Sections
The producer report MUST use exactly these section headings (markdown format):
- ## SUMMARY
- ## ARCHITECTURE_DECISION
- ## OPENCLAW_ASSUMPTIONS_VERIFIED
- ## INTERFACE_DESIGN
- ## TRADE_OFFS
- ## CHECKS

## Scoring Dimensions
Reviewers will score this stage on a 1-5 scale across these dimensions:
- decision_quality
- openclaw_verification_completeness
- interface_soundness
- extensibility
Threshold: each dimension must score at least 3/5.

## Contract Template
The producer must include a CONTRACT section declaring the status of each deliverable.
Required deliverables:
- architecture_decision
- openclaw_cross_repo_verification
- helper_interface_draft
- shadow_run_plan
Format: CONTRACT: followed by bullets like: - <description> status: DONE|PARTIAL|TODO

## Exit Criteria
- reviewer_a returns VERDICT: APPROVE
- reviewer_b returns VERDICT: APPROVE
- global_reviewer returns VERDICT: APPROVE
- No unresolved blocker remains in any reviewer output
- All scoring dimensions meet threshold (3/5)
- All contract deliverables reach status: DONE
- Producer report must contain sections: SUMMARY, ARCHITECTURE_DECISION, OPENCLAW_ASSUMPTIONS_VERIFIED, INTERFACE_DESIGN, TRADE_OFFS, CHECKS
- Reviewer reports must contain sections: VERDICT, BLOCKERS, FINDINGS, OPENCLAW_COMPATIBILITY_REVIEW, ARCHITECTURE_ASSESSMENT, NEXT_FOCUS, CHECKS
- Global reviewer must answer macro questions: Q1, Q2, Q3, Q4, Q5

