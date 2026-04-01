# Stage Brief

- Task: Fix empathy observer production failure
- Stage: investigate
- Round: 1

## Goals
- Identify the most likely root cause chain for missing user_empathy persistence.
- Confirm whether observer prompt contamination is occurring on latest code.
- Confirm whether timeout/error/fallback paths can leave data unpersisted.

## Required Hypotheses
- prompt_contamination_from_prompt_ts
- wait_for_run_timeout_or_error_causes_non_persistence
- subagent_ended_fallback_is_not_reliable_enough
- workspace_dir_or_wrong_workspace_write
- lock_or_ttl_path_causes_observer_inactivity_or_data_loss

## Carry Forward

- None.

## Constraints
- Use PD-only changes; do not modify OpenClaw.
- Focus on the empathy observer production failure and subagent lifecycle reliability.
- Keep code quality high and avoid unnecessary architectural expansion in the first fix.

## Exit Criteria
- Both reviewers return VERDICT: APPROVE
- No unresolved blocker remains in reviewer outputs
- Producer report must contain sections: SUMMARY, EVIDENCE, KEY_EVENTS, HYPOTHESIS_MATRIX, CHECKS
- Reviewer reports must contain sections: VERDICT, BLOCKERS, FINDINGS, HYPOTHESIS_MATRIX, NEXT_FOCUS, CHECKS

