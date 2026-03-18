# CURRENT_FOCUS

> Version: v1 | Status: EXECUTING | Updated: 2026-03-18

## Status Snapshot

| Dimension | Value |
| --- | --- |
| Current Phase | Production rollout preparation for the internal team |
| User Goal | Turn Principles Disciple into a usable product |
| Current Output | Shared governance layer + runtime integration assets + all standing-role operating prompts + production rollout guide + cloud handoff checklist |

## Current Tasks

- [x] Produce a non-technical panorama of the framework's philosophy, architecture, and product value
- [x] Map OpenClaw's peer-agent vs subagent model into a product-usable team architecture
- [x] Lock the first product defaults: team skeleton first, semi-autonomous boundary
- [x] Turn the multi-agent architecture into concrete role files, workflows, and skills
- [x] Separate shipped user templates from the internal Principles operating team
- [x] Map the internal team design onto OpenClaw heartbeat / cron / messaging primitives
- [x] Produce a reusable prompt for agents to create their own OpenClaw cron jobs
- [x] Produce an operating prompt for `main` to run meetings and route team work safely
- [x] Produce operating prompts for `pm`, `resource-scout`, and `verification`
- [x] Produce an operating prompt for `repair`
- [x] Convert high-frequency governance workflows into shared skills and slim role heartbeat files
- [x] Slim the top-level `AGENTS.md` files so startup context stays small and role-first
- [x] Remove repo-relative `../shared/...` assumptions from role files and switch to local `./.team/...` runtime paths
- [x] Re-check the internal team design against real OpenClaw runtime constraints: heartbeat fallback, agent-to-agent allowlist, cron concurrency, and per-workspace path layout
- [x] Switch the deployment model to global managed skills plus per-workspace shared governance
- [x] Produce a step-by-step production rollout guide for a non-technical operator
- [x] Produce a cloud handoff checklist so a server-side AI coding assistant can verify, patch, and complete deployment
- [ ] Identify the biggest gaps between philosophy and implementation inside the shipped templates
- [ ] Turn meeting, patrol, triage, repair, and verification into live scheduled flows

## Next

1. Let the cloud AI assistant apply the handoff checklist against the real `~/.openclaw` deployment
2. Complete smoke tests for all 5 roles and verify peer messaging prerequisites
3. Create the first real cron jobs with staggered schedules and verify one end-to-end internal flow

## References

- Main doc: `docs/maps/principles-disciple-panorama-zh.md`
- Supporting doc: `docs/maps/openclaw-multi-agent-team-architecture-zh.md`
- New doc: `docs/maps/template-layer-boundaries-zh.md`
- Runtime doc: `docs/teams/openclaw-runtime-integration-plan-zh.md`
