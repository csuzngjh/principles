# Research Summary: PD CLI v1.22

## Stack Additions
- New dep: **commander ^14.0.3** (already in create-principles-disciple)
- Reuse: typescript, esbuild, @sinclair/typebox, js-yaml, better-sqlite3

## Feature Categories
- **Table Stakes**: pd pain record, pd samples list/review, pd health
- **Differentiators**: pd evolution tasks, pd central sync

## Watch Out For
- OpenClawPluginApi tight coupling → extract WorkspaceResolver interface first
- TrajectoryRegistry singleton → needs TrajectoryStore interface
- Hardcoded .state/.pain_flag path → PainFlagPathResolver in SDK
- atomicWriteFileSync not in SDK → export from principles-core
- Dual-write race during migration → use existing asyncLockQueues

## Architecture
- SDK-first: consume @principles/core directly
- No OpenClaw dependency for core logic
- Gradual migration: keep existing tools + add CLI
