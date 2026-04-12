# PR #245 Merge-Gate Checklist

## 1. Must Fix Before Merging PR #245

- Fix the pain flag path mismatch so `PainFlagDetector` reads the canonical PD state location rather than a handwritten alternative path.
- Remove stale queue snapshot overwrite risk in `EvolutionTaskDispatcher`; long-running dispatch work must not end with writing an old in-memory queue snapshot back to disk.
- Make `sleep_reflection` dedup atomic so concurrent workers cannot both observe "no task exists" and enqueue duplicates.
- Remove any runtime/model/provider fallback that depends on machine-specific or unverified assumptions.
- Remove any export or dataset behavior that fabricates evidence-backed facts such as pain, failures, or violations when the source metadata does not support that claim.
- Re-verify that any `/pd-reflect` workspace resolution fix adopted from `PR #243` is stacked onto the `PR #245` line instead of creating a second merge target.

## 2. Safe To Defer Into v1.15 Hardening

- Full runtime adapter refactoring once the baseline merge blockers are gone
- Broader invariant emission and machine-checkable health surfaces
- Truth-contract cleanup beyond the production export/dataset path
- Additional replay-engine contract work not required for the immediate stacked baseline
- Broader test harness cleanup for the pre-existing fake-timer limitation documented in Phase 29

## 3. Explicit Non-Goals For The Baseline PR

- Do not merge all of `PR #243` wholesale.
- Do not reopen broad nocturnal architecture redesign while closing baseline blockers.
- Do not expand `PR #245` with unrelated cleanup, naming churn, or opportunistic refactors.
- Do not use diagnostics or logging as a substitute for explicit contracts.

## 4. Exit Condition

`PR #245` becomes a merge candidate only when:

- all items in Section 1 are closed
- no new merge-blocking regression is introduced while fixing them
- the stacked baseline still matches the v1.14 structural intent
