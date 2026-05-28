---
title: Development Guide
description: Contribute to Principles Disciple — architecture, coding conventions, and workflow.
---

# Development Guide

Want to contribute to Principles Disciple? This guide covers the architecture, coding conventions, and development workflow you need to know.

## Project Structure

```
principles/
├── packages/
│   ├── principles-core/     # Pure domain logic, state machines
│   ├── openclaw-plugin/     # OpenClaw hooks and event formatting
│   ├── pd-cli/              # Command-line tool
│   ├── create-principles-disciple/  # Installer
│   └── website/             # Documentation site (VitePress)
├── docs/
│   ├── architecture/        # Architecture decision records & models
│   └── adr/                 # Architecture Decision Records
├── PRODUCT_IDENTITY.md      # Canonical product boundary
└── CONTRIBUTING.md          # Contribution guidelines
```

## Architecture Overview

PD follows a strict layered architecture with three tiers:

### Core Layer (`@principles/core`)

**Location**: `packages/principles-core/`

This is the pure domain logic layer. It contains:
- State machines for Principle, Rule, and Implementation lifecycles
- The internalization pipeline (4 active MVP runners: Dreamer, Scribe, Artificer, Bridge)
- The activation pipeline (3 MVP channels: prompt, code_tool_hook, defer_archive)
- Pain signal processing and diagnosis
- Read models and evolution store

**Hard rule**: This layer MUST NOT import from `openclaw-plugin`, `pd-cli`, or any host layer. It depends only on its own contracts and types.

### Host Layer (`openclaw-plugin`)

**Location**: `packages/openclaw-plugin/`

This is the integration layer. It contains:
- OpenClaw hooks that intercept agent operations
- Event payload extraction and delegation to core
- RuleHost code execution
- Slash command handlers

**Hard rule**: This layer MUST NOT contain complex business logic or diagnosis algorithms. It extracts event payloads and delegates to `@principles/core`.

### CLI Layer (`pd-cli`)

**Location**: `packages/pd-cli/`

The command-line interface for operators. It provides:
- Pain signal recording
- Runtime health checks (canary)
- Internalization queue inspection
- Console server

## Core Domain Model

PD's knowledge evolves through a fixed three-layer structure:

```
Principle  →  Rule  →  Implementation
(Why/What)    (When/Where/How)   (Concrete executable)
```

### Principle

A highly abstract, cross-scenario guideline. It explains *why* the agent should behave differently.

- **Type hierarchy**: Core Principle → Domain Principle → Scenario Principle
- **Lifecycle**: `candidate → probation → active → archived → deprecated`
- **Key rule**: Never assign status directly. Use `taskStateMachine.transition(task, 'succeed')`.

### Rule

A hard, testable contract derived from a Principle. It specifies *when* and *how* the agent should respond.

- Must answer: Which Principle? What scenario? What problem? How to test?
- **Enforcement types**: `block | warn | log | requireApproval | propose_correction`

### Implementation

The concrete code or prompt that carries out a Rule.

- **MVP types**: `code` (RuleHost hook), `prompt` (context injection)
- **Future types**: `skill`, `lora`, `test` (not active in MVP)
- **Lifecycle**: `candidate → active → disabled → archived`
- Same Rule can have multiple Implementation candidates, but only one `active` at a time

## Activation Channels (MVP)

Three channels are currently active in the MVP:

| Channel | Level | Carrier | Approval Required |
|---------|-------|---------|-------------------|
| `prompt` | L1 (soft) | System prompt injection | No |
| `defer_archive` | n/a | Ledger state change | No |
| `code_tool_hook` | L2 (hard) | RuleHost JS code | Yes |

Two additional channels exist in the architecture but are **not active** in the MVP:
- `skill` (L1.5) — stretch goal, not yet implemented
- `model_training` (L3) — retired, feature flag set to `gone`

## Development Workflow

### Branch Naming

| Type | Format | Example |
|------|--------|---------|
| Feature | `feature/<name>` | `feature/evolution-points` |
| Fix | `fix/<issue-id>-<name>` | `fix/18-trust-engine` |
| Docs | `docs/<name>` | `docs/readme-update` |

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

### PR Requirements

- All PRs must have at least 1 reviewer
- CI tests must pass
- Lint checks must pass (`npm run lint` in `packages/openclaw-plugin/`)

### Decision Matrix

| Decision | Made By |
|----------|---------|
| Code implementation | AI contributors |
| Test verification | AI contributors |
| PR merge | Human maintainer |
| Strategic direction | Human maintainer |

## Coding Conventions

### No Direct State Assignment

```typescript
// ❌ Wrong
task.status = 'succeeded'

// ✅ Correct
taskStateMachine.transition(task, 'succeed')
```

### Contract Centralization

All core entity schemas are defined centrally. Import them, don't redefine:

```typescript
// ❌ Wrong — ad-hoc interface
interface TemporaryTask { ... }

// ✅ Correct — import from contracts
import { type PDTask, PDTaskSchema } from '../contracts/task-schema'
```

### Respect Layer Boundaries

```typescript
// ❌ Wrong — core importing from host
import { something } from 'openclaw-plugin'

// ✅ Correct — core importing from its own contracts
import { something } from '../contracts/...'
```

### Lint Rules

- `no-empty`: error
- `no-console`: warn
- `complexity`: max 10
- `@typescript-eslint/no-explicit-any`: warn
- `@typescript-eslint/no-unused-vars`: warn (underscore-prefixed params excluded)

Run before committing:
```bash
cd packages/openclaw-plugin && npm run lint
```

## MVP Three Questions

Every new issue must answer these before implementation:

1. **What happens if we don't do this?** — Will someone still care in 30 days? If you can't answer, the issue is rejected.
2. **How do we observe it?** — How does the user verify it works? UI? CLI? Logs? No observability = rejected.
3. **How do we turn it off?** — Feature flag? PR revert? If only revert, the flag must come with the PR.

## Key Architecture Documents

Before making architectural changes, read these:

| Document | Purpose |
|----------|---------|
| `docs/architecture/DOMAIN_MODEL.md` | Core ontology — Principle, Rule, Implementation |
| `docs/architecture/PD_SYSTEM_ARCHITECTURE.md` | System architecture overview |
| `docs/architecture/ACTIVATION_CHANNELS.md` | 5-channel activation design |
| `docs/architecture/INTERNALIZATION_PIPELINE.md` | Internalization pipeline design |
| `docs/architecture/SECURITY_ARCHITECTURE.md` | Security model |
| `PRODUCT_IDENTITY.md` | Canonical product boundary and MVP contract |
| `docs/adr/0014-mvp-first-strategy-and-product-pivot.md` | MVP strategy and scope |

## Reporting Issues

When reporting bugs, include:

- **Problem**: What happened
- **Steps to reproduce**: 1, 2, 3...
- **Expected behavior**: What should have happened
- **Actual behavior**: What actually happened
- **Environment**: Node.js version, OS, OpenClaw version

Issue tracker: [github.com/csuzngjh/principles/issues](https://github.com/csuzngjh/principles/issues)
