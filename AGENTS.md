# AGENTS.md — OpenAI Codex CLI Instructions

## Mandatory Pre-Task Reading

Before starting ANY coding task on this project, you MUST read `docs/ERROR_EXPERIENCE_HANDBOOK.md`. This file records real errors caught in code reviews. Reading it prevents you from repeating mistakes.

If a code review catches your error, record it in the handbook and tag the Linear issue with `lesson-learned`.

## Project Overview

**Principles Disciple** — evolutionary agent framework (Node.js/TypeScript monorepo, pnpm).

## Critical Rules

1. **Core vs Plugin boundary**: `packages/principles-core/` = pure logic only (no I/O, no fs, no DB, no network). `packages/openclaw-plugin/` = I/O boundary. New pure logic → core. New I/O → plugin.
2. **FROZEN LEGACY (ADR-0005)**: Do NOT modify `nocturnal-trinity.ts`, `nocturnal-arbiter.ts`, or `nocturnal-service.ts`.
3. **Architecture regression tests**: `packages/principles-core/tests/architecture-regression.test.ts` — never skip or delete.
4. **ADR compliance**: `docs/adr/` — code contradicting an ADR is a bug.
5. **No `any`**: Use `unknown` for truly unknown types. Strict TypeScript mode.
6. **No AI merge**: Never use `gh pr merge` or auto-merge PRs. User must merge manually.
7. **Conventional commits**: `feat()`, `fix()`, `docs()`, `refactor()`, `test()`, `chore()`.

## Build & Test

```bash
cd packages/principles-core && npm run build && npm run test
cd packages/openclaw-plugin && npm run build && npm run test
npm run lint
```

## Linear Workflow

1. Read the issue (including comments) BEFORE writing code
2. Update status to In Progress when you begin
3. Comment your plan on the issue
4. Update status to In Review when done
5. Leave a summary comment

## Error Recording

When a code review catches your error, use the `record-error` skill to record it. The skill handles: Linear comment → tag `lesson-learned` → edit handbook → update stats → commit & PR.

## Key Files

- `docs/ERROR_EXPERIENCE_HANDBOOK.md` — Error experience handbook (READ FIRST)
- `docs/ARCHITECTURE.md` — Full system architecture
- `docs/adr/` — Architecture Decision Records
- `CLAUDE.md` — Full project guidance (also applies to you)
