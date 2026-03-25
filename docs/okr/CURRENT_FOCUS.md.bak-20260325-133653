# CURRENT_FOCUS

> Version: v1 | Status: EXECUTING | Updated: 2026-03-20

## Status Snapshot

| Dimension | Value |
| --- | --- |
| Current Phase | Principles Console P2 delivery |
| User Goal | Turn Principles Disciple into a usable product |
| Current Output | Plugin-owned React SPA at `/plugins/principles/`, gateway route hosting, Thinking Model event persistence, overview/samples/thinking APIs, and validated build-test coverage |

## Current Tasks

- [x] Build a workspace-local SQLite trajectory store with blob support and legacy import
- [x] Wire prompt/llm/pain/gate/trust/evolution signals into the unified data layer
- [x] Add `/pd-status data`, `/pd-export`, and `/pd-samples review`
- [x] Harden merge blockers around command safety, metrics accuracy, trajectory fault isolation, and install/runtime stability
- [x] Adopt low-risk architecture review improvements: busy timeout, extra indexes, legacy import coverage, safe blob maintenance
- [x] Document the no-upstream-change OpenClaw UI strategy and Thinking OS productization plan
- [x] Turn SQL views into manager-facing health and principle dashboards through the plugin-owned web console
- [x] Remove blocking evolution-task UX by deferring user-turn diagnostics and adding async subagent execution
- [x] Clarify pd_run_worker as an internal worker tool and steer peer/session orchestration back to sessions_* tools
- [x] Harden pd_run_worker background compatibility so legacy async prompts still work while new guidance uses runInBackground
- [x] Fix legacy evolution queue bookkeeping so duplicate task ids cannot keep the latest in-progress pain stuck forever
- [x] Harden pain candidate promotion by defaulting legacy candidates to pending, reducing fingerprint collisions, and filtering obvious noise
- [ ] Expand sample quality rules and labeling for downstream LoRA/SFT work
- [ ] Harden P2 console UX with richer filters, review notes, and operational empty/error states

## Next

1. Add richer sample review metadata, filters, and bulk actions for training pipelines
2. Expand Thinking Model analysis with stronger scenario tags and clearer outcome framing
3. Verify the next production `.state` snapshot shows cleaner candidate promotion and fewer observer/no-reply noise samples

## References

- Core data layer: `packages/openclaw-plugin/src/core/trajectory.ts`
- Commands: `packages/openclaw-plugin/src/commands/export.ts`, `packages/openclaw-plugin/src/commands/samples.ts`
- Product roadmap context: `docs/maps/` and `docs/reviews/`
