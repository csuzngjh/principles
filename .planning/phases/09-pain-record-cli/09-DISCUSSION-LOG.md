# Phase 9: Pain Record CLI - Discussion Log

> **Audit trail only.** Decisions captured in CONTEXT.md.

**Date:** 2026-04-20
**Phase:** 09-pain-record-cli

---

## Area 1: CLI Package Location

| Option | Description | Selected |
|--------|-------------|----------|
| packages/pd-cli/ | New standalone package, decoupled from openclaw-plugin | ✓ |
| packages/openclaw-plugin/src/cli/ | Inside plugin package | |
| packages/create-principles-disciple/ | Inside installer package | |

**Notes:** Standalone package keeps CLI entry point separate from plugin runtime. Clean dependency direction: CLI → @principles/core (not CLI → openclaw-plugin).

---

## Area 2: Command Interface

| Option | Description | Selected |
|--------|-------------|----------|
| `pd pain record --reason X` | Subcommand pattern: pd <domain> <action> | ✓ |
| `pd record --reason X` | Flat command: pd <action> | |
| Interactive prompt | Prompt for reason if not provided | Deferred |

**Notes:** Subcommand pattern (`pd pain record`) scales to multiple subcommands (samples, evolution, health). Interactive mode deferred to future phase.

---

## Area 3: WorkspaceResolver Implementation

| Option | Description | Selected |
|--------|-------------|----------|
| Placeholder: cwd only | Simple process.cwd() for Phase 9 | ✓ |
| Full impl with config/env | Full resolution with config file + env vars | Deferred to openclaw-plugin |

**Notes:** Phase 9 uses placeholder. Full WorkspaceResolver concrete implementation will be in openclaw-plugin extension. CLI only depends on the interface.
