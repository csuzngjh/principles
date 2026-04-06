# [1.8.2](https://github.com/csuzngjh/principles/compare/v1.8.1...v1.8.2) (2026-04-06)

### Features

* **orchestrator:** merge gate — autonomous sprints no longer halt when PR branch is not on remote; branch absence now sets `mergePending: true` so sprints complete cleanly and the operator pushes later ([ed5a6eb](https://github.com/csuzngjh/principles/commit/ed5a6eb))
* **orchestrator:** report schema validation — `validateReportSections()` checks reviewer reports for required headings (VERDICT, FINDINGS, BLOCKERS, NEXT_FOCUS, CHECKS) before the decision engine; violations produce explicit blocker listings ([787ed1c](https://github.com/csuzngjh/principles/commit/787ed1c))
* **orchestrator:** producer prompt hardened — numbered checklist + self-check instruction + template delimiters in task-specs.mjs prevent agents from omitting required sections ([787ed1c](https://github.com/csuzngjh/principles/commit/787ed1c))
* **orchestrator:** dynamic timeout scaling + protectedArtifacts false positive fix ([ed5a6eb](https://github.com/csuzngjh/principles/commit/ed5a6eb))
* **orchestrator:** contract parser fixes + SIGHUP immunity ([9050cfb](https://github.com/csuzngjh/principles/commit/9050cfb))
* **pain/principle pipeline:** pain→principle pipeline fixes from v1.2-v1.3 boundary ([f696b45](https://github.com/csuzngjh/principles/commit/f696b45))
* **pain/principle pipeline:** improved pain event detection, task queuing, workflow resource cleanup and robust disposal ([f696b45](https://github.com/csuzngjh/principles/commit/f696b45))
* **pain/principle pipeline:** trajectory FTS5 index backfill for existing pain_events ([f696b45](https://github.com/csuzngjh/principles/commit/f696b45))
* **empathy/deep-reflect:** unified subagent-workflow helper migrating empathy + deep-reflect into a single cohesive workflow manager ([e85d7c8](https://github.com/csuzngjh/principles/commit/e85d7c8))
* **empathy:** keyword-based empathy detection replacing per-turn subagent sampling; hybrid keyword + subagent mode ([e85d7c8](https://github.com/csuzngjh/principles/commit/e85d7c8))
* **empathy:** surface degrade checks and sessionId format fixes ([18eb5bc](https://github.com/csuzngjh/principles/commit/18eb5bc))
* **workflow:** add outputQuality and nextRunRecommendation fields + contract enforcement improvements ([7187a63](https://github.com/csuzngjh/principles/commit/7187a63))
* **plugin sync:** enhanced dependency verification, workspace dir resolution priority, native dependency handling, and improved lock file management ([787ed1c](https://github.com/csuzngjh/principles/commit/787ed1c))

### Bug Fixes

* **orchestrator:** fix merge gate fetch failure path — do not mark completed when fetch fails for reasons other than missing remote ref ([9050cfb](https://github.com/csuzngjh/principles/commit/9050cfb))
* **deep-reflect:** fix sessionId format and add surface degrade checks ([18eb5bc](https://github.com/csuzngjh/principles/commit/18eb5bc))
* **ui:** resolve critical syntax error and i18n all hardcoded Chinese strings ([8da1623](https://github.com/csuzngjh/principles/commit/8da1623))
* **ui:** fix untranslated i18n template strings and missing useI18n hooks ([7ecc15e](https://github.com/csuzngjh/principles/commit/7ecc15e))
* **ui:** timeline-marker overflow, GroupedBarChart responsiveness, back button navigation, StatusBadge and EmptyState components ([1195626](https://github.com/csuzngjh/principles/commit/1195626), [a5f7a42](https://github.com/csuzngjh/principles/commit/a5f7a42), [d73d9ec](https://github.com/csuzngjh/principles/commit/d73d9ec))
* **security:** update security gate whitelist patterns ([8e84872](https://github.com/csuzngjh/principles/commit/8e84872))

### Code Refactoring

* **technical debt:** comprehensive God file refactoring — split gate.ts into 6 sub-modules (thinking-checkpoint, bash-risk, progressive-trust-gate, edit-verification, gfi-gate, gate-block-helper) ([7afeaab](https://github.com/csuzngjh/principles/commit/7afeaab))
* **technical debt:** remove unused parseAgentSessionKey and deduplicate JSDoc ([c667059](https://github.com/csuzngjh/principles/commit/c667059))
* **empathy:** migrate from pd_run_worker to sessions_spawn for subagent spawning ([e85d7c8](https://github.com/csuzngjh/principles/commit/e85d7c8))

### Documentation

* **planning:** milestone v1.2/v1.4/v1.5 planning — ROADMAP, MILESTONES, STATE, 1.0-ROADMAP, phases 06-10 research docs ([d44ad53](https://github.com/csuzngjh/principles/commit/d44ad53), [7b4f55a](https://github.com/csuzngjh/principles/commit/7b4f55a), [37fdc9b](https://github.com/csuzngjh/principles/commit/37fdc9b))
* **docs:** workflow v1 cloud handoff guide, PR2 runtime boundary checklist, empathy sprint specs ([421dc69](https://github.com/csuzngjh/principles/commit/421dc69), [fc21dde](https://github.com/csuzngjh/principles/commit/fc21dde))


# [1.7.6](https://github.com/csuzngjh/principles/compare/v1.7.5...v1.7.6) (2026-03-26)

### Features

* **phase-3:** control plane cleanup — gate.ts modular split into 6 sub-modules (thinking-checkpoint, bash-risk, progressive-trust-gate, edit-verification, gfi-gate, gate-block-helper) ([52e476e](https://github.com/csuzngjh/principles/commit/52e476e))
* **phase-3:** legacy queue status filtering (resolved/blocked/failed/cancelled/paused) + Trust input validation + timeout-only outcome filtering ([52e476e](https://github.com/csuzngjh/principles/commit/52e476e))

### Bug Fixes

* **gate:** fix bash-risk.ts command substitution handling ([52e476e](https://github.com/csuzngjh/principles/commit/52e476e))
* docs: fix chapter numbering in sleep-mode-reflection-system.md ([52e476e](https://github.com/csuzngjh/principles/commit/52e476e))
* fix: LockUnavailableError message dynamic resource naming ([52e476e](https://github.com/csuzngjh/principles/commit/52e476e))

# [1.7.5](https://github.com/csuzngjh/principles/compare/v1.7.4...v1.7.5) (2026-03-25)


### Bug Fixes

* address CodeRabbit review comments - use isSubagentAvailable() for runtime detection ([1870928](https://github.com/csuzngjh/principles/commit/1870928))
* fix central-db to handle missing thinking_model_events table in older workspaces ([adec0a8](https://github.com/csuzngjh/principles/commit/adec0a8))
* improve UI KPI cards and accessibility ([968400e](https://github.com/csuzngjh/principles/commit/968400e))
* restore subagent-probe.ts for empathy observer module ([ff6f384](https://github.com/csuzngjh/principles/commit/ff6f384))


### Features

* **ui:** redesign Principles Console with warm natural design system ([b290de6](https://github.com/csuzngjh/principles/commit/b290de6))
* **ui:** add central database aggregating all workspaces ([e9d3e64](https://github.com/csuzngjh/principles/commit/e9d3e64))
* **ui:** add workspace configuration panel ([9a467e3](https://github.com/csuzngjh/principles/commit/9a467e3))
* **ui:** add custom workspace form to WorkspaceConfig ([15dbad6](https://github.com/csuzngjh/principles/commit/15dbad6))
* **focus:** add auto-compression with milestone archiving ([06992f2](https://github.com/csuzngjh/principles/commit/06992f2))
* **focus:** add format validation and template recovery ([31f5325](https://github.com/csuzngjh/principles/commit/31f5325))


### Code Refactoring

* migrate from pd_run_worker to sessions_spawn for subagent spawning ([d1ea4f6](https://github.com/csuzngjh/principles/commit/d1ea4f6))
* remove compiled artifacts from git tracking ([6076388](https://github.com/csuzngjh/principles/commit/6076388))
* simplify focus validation to only check critical issues ([ef7e53a](https://github.com/csuzngjh/principles/commit/ef7e53a))
* improve auto-compression with config and rate limiting ([eed54e6](https://github.com/csuzngjh/principles/commit/eed54e6))



# [1.7.0](https://github.com/csuzngjh/principles/compare/v1.6.0...v1.7.0) (2026-03-19)


### Bug Fixes

* 修复插件安装器的依赖问题 ([f7e1eb4](https://github.com/csuzngjh/principles/commit/f7e1eb43cb7ec9c80679807ab81fd3b62022f254))
* correct OpenClaw Gateway default port from 3000 to 18789 ([#80](https://github.com/csuzngjh/principles/issues/80)) ([3585670](https://github.com/csuzngjh/principles/commit/3585670358a60aa7190b66991877000ecddc8dad))
* resolve 7 security vulnerabilities ([#79](https://github.com/csuzngjh/principles/issues/79)) ([739d761](https://github.com/csuzngjh/principles/commit/739d7619306fbe93858d3f853094ffeb63090f79)), closes [#69](https://github.com/csuzngjh/principles/issues/69) [#69](https://github.com/csuzngjh/principles/issues/69) [#69](https://github.com/csuzngjh/principles/issues/69)


### Features

* 添加智能体安装指引和更新摘要机制 ([063d5e1](https://github.com/csuzngjh/principles/commit/063d5e121f3a4b4bdac6f733f3b72978a5b4b8e7))
* add Principles Console P2 and clarify internal worker routing ([#78](https://github.com/csuzngjh/principles/issues/78)) ([e9b3bf4](https://github.com/csuzngjh/principles/commit/e9b3bf4041fbeb52c89f56ca28cb6b1bdf5ab24c))
* add trajectory data platform ([#76](https://github.com/csuzngjh/principles/issues/76)) ([4bba1ce](https://github.com/csuzngjh/principles/commit/4bba1ce9b8ceb12e88663fb92ac50e56946f26f5))
* **installer:** 自动检测首次安装 vs 更新 ([40f3edf](https://github.com/csuzngjh/principles/commit/40f3edf256b35247082943fa2eca5ca25d27396b))
