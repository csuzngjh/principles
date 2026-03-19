# CURRENT_FOCUS

> Version: v1 | Status: EXECUTING | Updated: 2026-03-19

## Status Snapshot

| Dimension | Value |
| --- | --- |
| Current Phase | Productization foundation |
| User Goal | Turn Principles Disciple into a usable product |
| Current Output | Unified trajectory DB, exports, correction sample review flow, and merge-blocker hardening |

## Current Tasks

- [x] Build a workspace-local SQLite trajectory store with blob support and legacy import
- [x] Wire prompt/llm/pain/gate/trust/evolution signals into the unified data layer
- [x] Add `/pd-status data`, `/pd-export`, and `/pd-samples review`
- [x] Harden merge blockers around command safety, metrics accuracy, trajectory fault isolation, and install/runtime stability
- [ ] Turn SQL views into manager-facing health and principle dashboards
- [ ] Expand sample quality rules and labeling for downstream LoRA/SFT work

## Next

1. Build `/pd-health` on top of `v_daily_metrics`, `v_error_clusters`, and `v_principle_effectiveness`
2. Add richer sample review metadata and export filters for training pipelines
3. Evaluate centralized sync or warehouse export after local data quality is stable

## References

- Core data layer: `packages/openclaw-plugin/src/core/trajectory.ts`
- Commands: `packages/openclaw-plugin/src/commands/export.ts`, `packages/openclaw-plugin/src/commands/samples.ts`
- Product roadmap context: `docs/maps/` and `docs/reviews/`
