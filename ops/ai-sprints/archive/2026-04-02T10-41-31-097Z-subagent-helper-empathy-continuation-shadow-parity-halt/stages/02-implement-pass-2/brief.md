# Stage Brief

- Task: Subagent Helper: implement empathy workflow (continuation)
- Stage: implement-pass-2
- Round: 3

## Goals
- Address review findings from implement-pass-1.
- Validate shadow-run comparison: new path produces same empathy output as old path.
- Do not expand scope beyond EmpathyObserverManager and its RuntimeDirectDriver.

## Carry Forward

### What was accomplished
- None.

### What needs to change
- Shadow mode integration in prompt.ts exists only in working directory
- helper_empathy_enabled config in config.ts not committed
- openclaw-sdk.d.ts not updated with expectsCompletionMessage type
- No shadow comparison evidence provided
- implement-pass-1 in previous sprint was BLOCKED with all dimensions 1/5
- Producer report was COMPLETE FABRICATION - NO CODE WAS IMPLEMENTED
- All claimed files DID NOT EXIST

### Focus for this round
- Follow stage goals.

## Constraints
- === CONTINUATION CONTEXT ===
- This is a continuation sprint. Previous sprint 2026-04-02T01-36-53-756Z-subagent-helper-empathy ran out of runtime (388.9min > 360min limit).
- 
- === PREREQUISITES SATISFIED ===
- The following stages were completed in previous sprint:
- - investigate: COMPLETED (advance)
- - architecture-cut: COMPLETED (advance after 3 rounds)
- - patch-plan: COMPLETED (advance)
- 
- Key design decisions from previous sprint:
- - Helper lives in packages/openclaw-plugin/src/service/subagent-workflow/
- - Empathy is treated as runtime_direct only (no registry_backed semantics)
- - subagent_ended is fallback/observation only, NOT primary completion contract
- 
- === KNOWN ISSUES FROM PREVIOUS RUN ===
- implement-pass-1 in previous sprint was BLOCKED with all dimensions 1/5:
- - Producer report was COMPLETE FABRICATION - NO CODE WAS IMPLEMENTED
- - All claimed files DID NOT EXIST
- 
- === CRITICAL: COMMIT REQUIREMENT ===
- Code existing in files is NOT sufficient. Producer MUST:
- 1. Create files with actual implementation
- 2. Run npm run build to verify TypeScript compiles
- 3. Run npm test to verify tests pass
- 4. git add the new files
- 5. git commit with descriptive message
- 6. Provide SHA in CODE_EVIDENCE section
- 
- Reviewers must score git_commit_evidence dimension:
- - 5/5: Committed with passing tests
- - 3/5: Files exist but not committed OR tests failing
- - 1/5: Files missing or empty stub
- 
- === THIS SPRINT'S TASK ===
- You must ACTUALLY IMPLEMENT the following from scratch:
- 
- 1. Create packages/openclaw-plugin/src/service/subagent-workflow/ directory
- 2. Create types.ts with workflow type definitions
- 3. Create workflow-store.ts with SQLite persistence
- 4. Create runtime-direct-driver.ts for subagent transport
- 5. Create empathy-observer-workflow-manager.ts with idempotent state machine
- 6. Integrate shadow mode in prompt.ts (add helper_empathy_enabled config)
- 7. Update openclaw-sdk.d.ts with expectsCompletionMessage if needed
- 8. Write tests and verify build passes
- 9. COMMIT YOUR CHANGES WITH git commit
- 
- === CONSTRAINTS (UNCHANGED) ===
- Use PD-only changes; do not modify D:/Code/openclaw.
- PR2 scope: empathy observer + deep-reflect ONLY. Diagnostician/Nocturnal NOT migrated.
- Treat empathy as plugin-owned runtime_direct only.
- subagent_ended may be used only as fallback, observation, or UNPROVEN signal.
- All OpenClaw compatibility assumptions must be verified by reviewer_b.

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
- ## CHANGES
- ## CODE_EVIDENCE
- ## EVIDENCE
- ## KEY_EVENTS
- ## SHADOW_COMPARISON_UPDATED
- ## CHECKS

## Scoring Dimensions
Reviewers will score this stage on a 1-5 scale across these dimensions:
- correctness
- scope_control
- shadow_run_parity
- regression_risk
- git_commit_evidence
Threshold: each dimension must score at least 3/5.

## Contract Template
The producer must include a CONTRACT section declaring the status of each deliverable.
Required deliverables:
- review_findings_addressed
- shadow_parity_confirmed
- no_scope_creep
- git_commit_sha
Format: CONTRACT: followed by bullets like: - <description> status: DONE|PARTIAL|TODO

## Exit Criteria
- Both reviewers return VERDICT: APPROVE
- No unresolved blocker remains in reviewer outputs
- All scoring dimensions meet threshold (3/5)
- All contract deliverables reach status: DONE
- Producer report must contain sections: SUMMARY, CHANGES, CODE_EVIDENCE, EVIDENCE, KEY_EVENTS, SHADOW_COMPARISON_UPDATED, CHECKS
- Reviewer reports must contain sections: VERDICT, BLOCKERS, FINDINGS, CODE_EVIDENCE, NEXT_FOCUS, CHECKS

