# Phase 9: Pain Record CLI - Context

**Gathered:** 2026-04-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 9 delivers the `pd pain record` CLI command. Phase 8 SDK foundation (CLI-FOUNDATION-01~04) is complete — Phase 9 consumes those primitives to build a standalone CLI that records pain signals without depending on OpenClaw's tool registration mechanism.

**Requirements from ROADMAP.md:**
- PAIN-RECORD-01: `pd pain record` command records pain signal to flag file
</domain>

<decisions>
## Implementation Decisions

### CLI Package Location
- **D-01:** `packages/pd-cli/` — new package, not inside openclaw-plugin
- Rationale: CLI is a standalone entry point, decoupled from plugin runtime

### Command Signature
- **D-02:** `pd pain record --reason <text> [--score N] [--source manual]`
- Rationale: minimal surface area, reason is required, score/source optional

### SDK Usage
- **D-03:** Use `recordPainSignal` from `@principles/core` (Phase 8 CLI-FOUNDATION-02)
- Use `resolvePainFlagPath` for path display feedback
- Rationale: Phase 8 SDK is the foundation, not reimplementing pain recording logic

### Workspace Resolution
- **D-04:** Use `WorkspaceResolver` interface (Phase 8 CLI-FOUNDATION-01)
- Concrete impl in openclaw-plugin, CLI gets interface only
- Rationale: Decoupled from plugin internals

### Package Tooling
- **D-05:** TypeScript + ESM, tsx for bin entry
- Rationale: Consistent with existing packages/principles-core patterns
</decisions>

<specifics>
## Specific Ideas

1. `packages/pd-cli/src/index.ts` — Commander.js setup, `pd pain record` subcommand
2. `packages/pd-cli/src/commands/pain-record.ts` — record command implementation
3. `packages/pd-cli/src/resolve-workspace.ts` — WorkspaceResolver concrete impl (placeholder: cwd)
4. `packages/pd-cli/package.json` — name: `@principles/pd-cli`, bin: `pd`
5. `packages/pd-cli/tsconfig.json` — ESM, strict, declaration
6. Export pain recording output feedback showing flag path and signal summary

</specifics>

<deferred>
## Deferred Ideas

- Interactive mode (prompt for reason if not provided) → Phase 9 is non-interactive only
- Config file for default workspace dir → handled by WorkspaceResolver impl in openclaw-plugin
</deferred>
