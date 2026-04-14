# Summary 32-02

- Replay reports now emit `evidenceSummary`
- Empty replay evidence produces `needs-review` plus an explicit blocker
- Promotion gate now emits top-level `evidenceSummary` with `shadow`/`eval-proxy`/`mixed`
- Rollout evaluation output now shows evidence mode and shadow sample count
- Added regression tests for empty replay and eval-proxy promotion cases
