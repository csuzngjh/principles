# Stage Brief

- Task: Subagent Helper: verify empathy workflow implementation
- Stage: verify
- Round: 2

## Goals
- Verify empathy persistence via workflow store queries.
- Confirm merge gate: local SHA == remote/feat/subagent-helper-empathy SHA.
- global_reviewer must confirm: OpenClaw assumptions verified? Business flow closed? Architecture improved? Degrade boundaries explicit?
- Confirm no regression in other subagent modules.

## Carry Forward

### What was accomplished
- None.

### What needs to change
- No blockers from previous round.

### Focus for this round
- Follow stage goals.

## Constraints
- === VERIFY-ONLY SPRINT ===
- This sprint ONLY runs the verify stage.
- 
- Previous sprint 2026-04-02T10-41-31-097Z-subagent-helper-empathy-continuation was halted due to
- inappropriate shadow_run_parity requirement. Code implementation exists and is committed.
- 
- === IMPLEMENTATION STATUS ===
- The following files should exist in packages/openclaw-plugin/src/service/subagent-workflow/:
- - types.ts: Workflow type definitions
- - workflow-store.ts: SQLite persistence
- - runtime-direct-driver.ts: Subagent transport
- - empathy-observer-workflow-manager.ts: Idempotent state machine
- - index.ts: Module exports
- 
- Integration changes in:
- - prompt.ts: helper_empathy_enabled config
- - config.ts: helper_empathy_enabled field
- - openclaw-sdk.d.ts: expectsCompletionMessage type
- 
- === VERIFICATION GOALS ===
- 1. Confirm all expected files exist and have content
- 2. Run npm run build - must pass
- 3. Run npm test - empathy workflow tests must pass
- 4. Verify workflow store creates tables correctly
- 5. Check state machine transitions are valid
- 6. Confirm fallback/degrade behavior is explicit
- 
- === NO SHADOW PARITY ===
- This sprint does NOT require shadow_run_parity verification.
- PR2 introduces NEW runtime_direct boundary - no legacy path exists for comparison.
- Focus on: new path self-evidence, closure, observability.
- 
- === CRITICAL: WHAT TO VERIFY ===
- Producer should:
- 1. List all files in subagent-workflow/ directory
- 2. Show git log for recent commits on this branch
- 3. Run npm run build and capture output
- 4. Run npm test and capture output (focus on empathy tests)
- 5. Provide WORKFLOW_TRACE showing state transitions
- 6. Confirm degrade_on_unavailable_surface behavior
- 
- Reviewers should verify:
- - Code exists and is committed
- - Build passes
- - Tests pass
- - No obvious bugs or regressions
- - Architecture is sound

## Required Reviewer Sections
Your report MUST use exactly these section headings (markdown format):
- ## VERDICT
- ## BLOCKERS
- ## FINDINGS
- ## CODE_EVIDENCE
- ## NEXT_FOCUS
- ## CHECKS
Examples of valid headings: ## VERDICT, ## BLOCKERS, ## FINDINGS, ## TRANSPORT_ASSESSMENT, ## OPENCLAW_ASSUMPTION_REVIEW, ## NEXT_FOCUS, ## CHECKS, ## DIMENSIONS
You MUST include ALL sections listed above. Omitting any section will cause the sprint to halt.

## Required Producer Sections
The producer report MUST use exactly these section headings (markdown format):
- ## SUMMARY
- ## EVIDENCE
- ## CODE_EVIDENCE
- ## EMPATHY_CHECK
- ## FINAL_WORKFLOW_VERIFICATION
- ## CHECKS

## Scoring Dimensions
Reviewers will score this stage on a 1-5 scale across these dimensions:
- verification_thoroughness
- gap_analysis
- production_readiness
- architecture_improvement
- git_commit_evidence
Threshold: each dimension must score at least 3/5.

## Contract Template
The producer must include a CONTRACT section declaring the status of each deliverable.
Required deliverables:
- empathy_persistence_verified
- openclaw_assumptions_final_review
- deployment_checklist
- global_reviewer_final_assessment
- git_commit_sha
Format: CONTRACT: followed by bullets like: - <description> status: DONE|PARTIAL|TODO

## Exit Criteria
- reviewer_a returns VERDICT: APPROVE
- reviewer_b returns VERDICT: APPROVE
- global_reviewer returns VERDICT: APPROVE
- No unresolved blocker remains in any reviewer output
- All scoring dimensions meet threshold (3/5)
- All contract deliverables reach status: DONE
- Producer report must contain sections: SUMMARY, EVIDENCE, CODE_EVIDENCE, EMPATHY_CHECK, FINAL_WORKFLOW_VERIFICATION, CHECKS
- Reviewer reports must contain sections: VERDICT, BLOCKERS, FINDINGS, CODE_EVIDENCE, NEXT_FOCUS, CHECKS
- Global reviewer must answer macro questions: Q1, Q2, Q3, Q4, Q5

