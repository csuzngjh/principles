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
