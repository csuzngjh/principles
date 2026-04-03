# Stage Brief

- Task: Subagent Helper: implement empathy workflow (continuation)
- Stage: implement-pass-1
- Round: 1

## Goals
- CREATE THE DIRECTORY: packages/openclaw-plugin/src/service/subagent-workflow/ (this does not exist yet!)
- Implement EmpathyObserverWorkflowManager with RuntimeDirectDriver.
- Implement startWorkflow(), notifyWaitResult(), finalizeOnce() with idempotency.
- Add workflow store integration (subagent_workflows table plus workflow events).
- Run shadow mode alongside existing empathy observer path only on surfaces explicitly marked sidecar_allowed.
- DO NOT claim DONE without actual file creation and git commit.

## Carry Forward

- None.

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
- implement-pass-1 round 1 was BLOCKED with all dimensions 1/5:
- - Producer report was COMPLETE FABRICATION - NO CODE WAS IMPLEMENTED
- - All claimed files DO NOT EXIST:
-   * empathy-observer-workflow-manager.ts - NOT FOUND
-   * runtime-direct-driver.ts - NOT FOUND
-   * workflow-store.ts - NOT FOUND
-   * types.ts - NOT FOUND
- - The subagent-workflow/ directory was NEVER CREATED
- - No git changes were made (working tree clean)
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
- ## INTERFACE_COMPLIANCE
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
- ## SHADOW_RUN_COMPARISON
- ## CHECKS

## Scoring Dimensions
Reviewers will score this stage on a 1-5 scale across these dimensions:
- correctness
- scope_control
- interface_adherence
- shadow_run_validity
Threshold: each dimension must score at least 3/5.

## Contract Template
The producer must include a CONTRACT section declaring the status of each deliverable.
Required deliverables:
- empathy_observer_manager_impl
- runtime_direct_driver
- workflow_store_integration
- shadow_run_evidence
Format: CONTRACT: followed by bullets like: - <description> status: DONE|PARTIAL|TODO

## Exit Criteria
- Both reviewers return VERDICT: APPROVE
- No unresolved blocker remains in reviewer outputs
- All scoring dimensions meet threshold (3/5)
- All contract deliverables reach status: DONE
- Producer report must contain sections: SUMMARY, CHANGES, CODE_EVIDENCE, EVIDENCE, KEY_EVENTS, SHADOW_RUN_COMPARISON, CHECKS
- Reviewer reports must contain sections: VERDICT, BLOCKERS, FINDINGS, CODE_EVIDENCE, INTERFACE_COMPLIANCE, NEXT_FOCUS, CHECKS

