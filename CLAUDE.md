# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🧠 Memory System (Critical - Read First!)

**Location**: `/home/csuzngjh/.claude/projects/-home-csuzngjh/code-principles/memory/`

**⚠️ IMPORTANT: Always review memory at the start of new conversations!**

### Memory Files

1. **INDEX.md** - Navigation and quick reference for all memory files
2. **MEMORY.md** - Main project memory (issues, solutions, architecture)
3. **trust-system.md** - Complete Trust Engine V2 reference
4. **installation-guide.md** - Installation procedures and troubleshooting

### How to Access Memory

```bash
# Read the index first
cat /home/csuzngjh/.claude/projects/-home-csuzngjh-code-principles/memory/INDEX.md

# Read main memory for project context
cat /home/csuzngjh/.claude/projects/-home-csuzngjh-code-principles/memory/MEMORY.md

# Read trust system details when working with trust-related code
cat /home/csuzngjh/.claude/projects/-home-csuzngjh-code-principles/memory/trust-system.md
```

### What's Stored in Memory

- **Trust System Migration (2026-03-11)**: Root cause analysis, solution, v1.4.3 release
- **V1 vs V2 Differences**: Cold start, grace failures, adaptive penalties/rewards
- **Installation Process**: 6-step script, verification, common issues
- **Key Paths**: Plugin locations, workspace structure, state files
- **Development Workflow**: Build, test, release procedures
- **Common Issues**: 5 known problems with solutions

### When to Update Memory

Update memory files when:
- Resolving critical issues
- Making major architectural decisions
- Discovering new patterns/conventions
- Documenting new workflows
- After version releases

### Memory System Rules

- ✅ Memory files are for Claude Code use only
- ✅ Stored in `.claude/projects/` (not in git repository)
- ✅ Update regularly to preserve context
- ❌ Never commit memory files to GitHub
- ❌ Don't duplicate memory in project directory

## Project Overview

**Principles Disciple** is an evolutionary agent framework that transforms AI assistants from simple task-executors into self-evolving digital lifeforms. It consists of:

1. **OpenClaw Plugin** (`packages/openclaw-plugin/`) - Native TypeScript plugin for OpenClaw gateway
2. **Conductor Framework** (`conductor/`) - Project management with tracks, phases, and TDD workflow
3. **Claude Skills** (`claude/skills/`) - High-level capabilities for Claude Code
4. **Installation Scripts** - Shell scripts for deploying the framework

## Core Development Commands

### Plugin Development (TypeScript)

```bash
# Navigate to plugin directory
cd packages/openclaw-plugin

# Install dependencies
npm install

# Build TypeScript to JavaScript
npm run build

# Bundle for distribution (optional)
npm run build:bundle
npm run build:production  # minified bundle

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Type checking
npx tsc --noEmit
```

### Project-Level Commands

```bash
# Root level - release management
npm run release              # Create a new release via semantic-release
npm run release:dry-run      # Preview release changes
npm version:patch            # Bump plugin patch version
npm version:minor            # Bump plugin minor version
npm version:major            # Bump plugin major version

# Installation
bash install-openclaw.sh --lang en    # Install OpenClaw plugin
bash install-openclaw.sh --force       # Force overwrite existing files
```

### Running Single Tests

```bash
cd packages/openclaw-plugin
npx vitest run <test-file-path>
# Example: npx vitest run tests/utils/hashing.test.ts
```

## High-Level Architecture

### OpenClaw Plugin Architecture

The plugin (`packages/openclaw-plugin/src/`) implements a **Lifecycle Hook System** with the following components:

**Core Hooks:**
- `before_prompt_build` - Injects Thinking OS, pain signals, and OKR focus into prompts
- `before_tool_call` - **Gatekeeper**: Checks PLAN.md readiness and validates risk paths
- `after_tool_call` - **Pain Detection**: Scores failures and writes `.pain_flag`
- `llm_output` - **Cognitive Tracking**: Detects if AI follows Thinking OS models
- `before_compaction` / `before_reset` - **State Checkpointing**: Saves progress before context loss
- `subagent_spawning` - **Cognitive Propagation**: Ensures sub-agents inherit Thinking OS
- `subagent_ended` - **Failure Tracking**: Generates pain signals on sub-agent failure

**Background Services:**
- `EvolutionWorkerService` - Scans `.pain_flag` every 90s, queues high-score signals into `evolution_queue.json`, and dispatches diagnostic commands

**Key Modules:**
- `src/hooks/` - Hook implementations (gate, pain, prompt, lifecycle, llm, subagent)
- `src/commands/` - Slash command handlers (strategy, evolver, capabilities, thinking-os, pain, trust)
- `src/tools/` - Custom tools (deep-reflect for cognitive analysis)
- `src/core/` - Core utilities (init, system-logger)
- `src/service/` - Background services
- `src/utils/` - Shared utilities (hashing, io, nlp, plugin-logger)

### The Trust Engine (Progressive Gatekeeper)

The plugin implements a **4-stage trust system** that progressively adjusts modification permissions:

| Stage | Name | Permissions | Description |
|-------|------|-------------|-------------|
| Stage 0 | Cold Start | Read-only | No writes allowed to `risk_paths` |
| Stage 1 | Restricted | PLAN whitelist | Can modify files listed in `PLAN.md` only |
| Stage 2 | Conditional | Audit verified | Requires audit verification for high-risk paths |
| Stage 3 | Trusted | Full access | Can modify any file (except core system files) |

Trust score is calculated from:
- Historical win/loss ratio (from `AGENT_SCORECARD.json`)
- Task complexity scores
- Recent error patterns
- Manual user overrides via `/trust` command

### Thinking OS

A meta-cognitive layer injected via `prependSystemContext` (cached by provider after first turn). Contains 9 mental models (T-01 through T-09):

- **T-01**: Map Before Territory
- **T-02**: Constraints as Lighthouses
- **T-03**: Evidence Over Intuition
- **T-04**: Reversibility Governs Speed
- **T-05**: Via Negativa
- **T-06**: Occam's Razor
- **T-07**: Minimum Viable Change
- **T-08**: Pain as Signal
- **T-09**: Divide and Conquer

Usage tracking stored in `.thinking_os_usage.json`. Managed via `/thinking-os` command.

### Directory Structure Conventions

**Workspace State** (typically `~/.openclaw/workspace/` or custom `stateDir`):
- `docs/` - Long-term memory (symlinked or copied from project templates)
  - `PROFILE.json` - User expertise, risk_paths, trust config
  - `PLAN.md` - Implementation plan (must be STATUS: READY for gated modifications)
  - `PRINCIPLES.md` - Evolution-generated principles
  - `THINKING_OS.md` - Active mental models
  - `okr/` - Objective tracking
- `memory/` - Short-term episodic memory
- `.state/` - Plugin state directory
  - `logs/` - Event logs (`events.jsonl`, `daily-stats.json`, `plugin.log`)
  - `.pain_flag` - Pain signal markers
  - `evolution_queue.json` - Queued evolution tasks

### Conductor Framework

Located in `conductor/`, provides structured project management:

- `tracks/` - Feature tracks with metadata and phase-based implementation plans
- `workflow.md` - TDD workflow with strict task lifecycle
- `product.md` - Product vision and core features
- `tech-stack.md` - Technology stack decisions

Conductor enforces:
1. Test-Driven Development (Red → Green → Refactor)
2. Phase checkpointing with git notes
3. Documentation before implementation
4. 80% code coverage minimum

## Key Files and Their Purposes

### Plugin Configuration
- `packages/openclaw-plugin/openclaw.plugin.json` - Plugin manifest
- `packages/openclaw-plugin/tsconfig.json` - TypeScript configuration
- `packages/openclaw-plugin/vitest.config.ts` - Test configuration

### Template Files (copied to workspace on install)
- `packages/openclaw-plugin/templates/workspace/docs/` - Default documentation templates
- `packages/openclaw-plugin/templates/` - Other template assets

### Installation
- `install-openclaw.sh` - Plugin installer (smart/force modes)
- `uninstall-openclaw.sh` - Plugin uninstaller

## Slash Commands

Available after plugin installation:
- `/init-strategy` - Initialize OKR strategy
- `/manage-okr` - Manage project OKRs and focus areas
- `/evolve-task <desc>` - Trigger evolver for deep code repair
- `/bootstrap-tools` - Scan and upgrade environment tools
- `/research-tools <query>` - Research CLI tools online
- `/thinking-os [status|propose|audit]` - Manage Thinking OS
- `/pd-status [pain|gfi]` - View Digital Nerve System status
- `/trust` - View agent trust scorecard and permissions

## Testing Strategy

Tests are located in `packages/openclaw-plugin/tests/` mirroring the `src/` structure:
- `tests/commands/` - Command handler tests
- `tests/core/` - Core utility tests
- `tests/hooks/` - Hook implementation tests
- `tests/service/` - Background service tests
- `tests/tools/` - Custom tool tests
- `tests/utils/` - Utility function tests

Run all tests: `npm test` (from plugin directory)
Run with coverage: `npm test -- --coverage`

## Build Process

1. **TypeScript compilation**: `tsc` compiles `src/` to `dist/`
2. **Bundling (optional)**: `esbuild` creates `dist/bundle.js` with tree-shaking
3. **Distribution**: Package includes `dist/`, `templates/`, and `openclaw.plugin.json`

## Important Notes

### Path Resolution (v1.5.2+)

The plugin now uses a centralized `PathResolver` module for all path operations:

- **Configuration Priority**: Environment variables > Config file > OpenClaw defaults
- **Config File**: `~/.openclaw/principles-disciple.json`
- **Environment Variables**: `PD_WORKSPACE_DIR`, `PD_STATE_DIR`, `DEBUG`
- **Auto-normalization**: Paths with `/memory`, `/docs`, `/workspace` suffixes are automatically normalized
- **Backward Compatible**: Falls back to `ctx.workspaceDir` from hook context

See `src/core/path-resolver.ts` for implementation.

- **Multi-language**: Supports English (`en`) and Chinese (`zh`) - configured via plugin config or install script
- **Backward Compatibility**: Installation script uses "smart merge" by default - existing user files get `.update` suffix instead of being overwritten
- **Cold Start**: New installations start at Trust Stage 0 (Cold Start) with restricted permissions until trust is established
