---
title: User Guide
description: Complete reference for Principles Disciple's MVP features, commands, and workflows.
---

# User Guide

This guide covers everything you need to use Principles Disciple (PD) effectively. PD is an owner-governed behavior internalization system for AI agents — it helps your agent learn from repeated mistakes and turn those lessons into reviewed, reversible principles.

## How PD Works

PD follows a simple loop:

```
Agent makes mistakes (Pain)
       ↓
PD diagnoses the pattern (Diagnosis)
       ↓
PD proposes a principle (Candidate)
       ↓
You review and decide (Review)
       ↓
PD activates the principle (Activation)
       ↓
Agent behaves better next time (Observation)
```

You are always in control. No principle becomes active without your review.

## What PD Is Not

To set expectations clearly:

- PD is **not** a task execution engine
- PD is **not** a general memory system or external brain
- PD is **not** a generic tool-call or output-format repair product
- PD is **not** a LangChain-style app builder
- PD is **not** a SaaS product or chatbot
- PD is **not** a magic self-improvement button

PD is an **owner-governed behavior internalization layer** for OpenClaw coding agents. It helps your agent learn from pain — with you in the loop.

## Core Concepts

### Pain Signal

A **pain signal** is structured evidence that something went wrong. It's not punishment — it's data. Pain signals come from:

- Tool failures (e.g., a command that keeps failing)
- User corrections (e.g., "don't do it that way")
- Blocked edits (e.g., workspace guardrails intercepted a risky change)
- Risky near-misses (e.g., almost overwrote an important file)

### Principle

A **principle** is a soft, highly abstract guideline. It answers "Why should the agent behave differently?" and "What direction should it follow?"

Principles go through a lifecycle:

| Status | Meaning |
|--------|---------|
| `candidate` | Newly proposed, not yet reviewed |
| `probation` | Under trial / shadow mode |
| `active` | Officially in effect |
| `archived` | Kept for history, not active |

### Rule

A **rule** is a hard, testable contract derived from a principle. It answers "When does this apply?" and "How should the agent respond?"

### Implementation

An **implementation** is the concrete code or prompt that carries out a rule. This is what actually changes agent behavior.

### Activation Channels

When you approve a principle, you choose how it takes effect:

| Channel | Strength | What Happens | Needs Your Approval? |
|---------|----------|-------------|---------------------|
| **Prompt** | Soft | A reminder is injected into the agent's context | No (automatic) |
| **RuleHost** | Hard | A code hook blocks or warns on violating actions | Yes (required) |
| **Defer / Archive** | None | The candidate is deliberately skipped | No (automatic) |

The general strategy: **start soft, escalate if needed.**

## Workspace Guardrails

PD uses RuleHost — an owner-governed, dynamic rule system — to enforce behavioral principles. When an owner-approved principle blocks a tool call, the agent receives guidance on how to proceed.

### How It Works

RuleHost evaluates each mutating tool call against activated rules:

- If a rule matches and blocks → the agent receives an explanation and guidance
- If no rule blocks → the operation proceeds normally
- Rules are activated through the MVP channels: prompt injection, code_tool_hook, and defer_archive

### Planning Guidance

For complex tasks, agents are encouraged to describe their plan and get owner confirmation before making large changes. This is a behavioral suggestion, not a built-in gate. If the owner wants to enforce "plan before action" as a hard rule, they can activate a RuleHost rule through the standard internalization pipeline.

### Configuring Risk Paths

Edit your workspace's `docs/PROFILE.json`:

```json
{
  "risk_paths": ["SOUL.md", "USER.md", "AGENTS.md", "docs/plans/**"]
}
```

`risk_paths` feeds risk classification used by evidence triage and pain scoring. Blocking behavior itself comes only from the RuleHost rules you approved.

## Slash Commands

PD integrates with OpenClaw through slash commands. All commands start with `/pd-` (with short aliases like `/pdi`, `/pdb`, etc.) and never conflict with OpenClaw's built-in commands.

Here's a quick overview of the most-used commands:

| Command | Short | Purpose |
|---------|-------|---------|
| `/pd-init` | `/pdi` | Initialize workspace |
| `/pd-status` | — | View GFI friction index and system health |
| `/pd-pain` | — | Report a pain signal from the current session |
| `/pd-evolution-status` | — | View principle evolution state |
| `/pd-rollback` | — | Rollback a misjudged empathy event penalty |
| `/pd-principle-rollback` | — | Rollback a principle and blacklist it |
| `/pd-context` | — | Control context injection (Thinking OS / project focus) |
| `/pd-help` | `/pdh` | Show command reference in-session |

::: tip Full Reference
For the complete list of commands with detailed parameters, examples, and common workflows, see the [Slash Commands Reference](./slash-commands).
:::

::: warning About Implementation Lifecycle Commands
`/pd-promote-impl`, `/pd-disable-impl`, `/pd-archive-impl`, and `/pd-rollback-impl` have their replay-generation path retired in PRI-230 and are now in a semi-deprecated state. For the new implementation promotion workflow, use the `pd candidate internalize` and `pd runtime activation promote` CLI commands instead.
:::

### Principle Management (CLI)

The `pd` CLI provides the modern principle lifecycle commands:

| Command | Description |
|---------|-------------|
| `pd candidate list` | List principle candidates |
| `pd candidate intake --candidate-id <id>` | Intake a candidate |
| `pd activation approve --approval-id <id>` | Approve a candidate for activation |
| `pd activation list` | List active principles |

## The PD CLI

The `pd` command-line tool provides additional capabilities outside of OpenClaw sessions.

### Record a Pain Signal

```bash
pd pain record --reason "edited file without reading first" --score 75 --session "<session-id>"
```

Options:
- `--reason, -r` — Why the pain occurred (required)
- `--score, -s` — Pain severity, 0–100 (default: 80)
- `--session` — Session ID recorded in this workspace's trajectory; validated
  up front (a missing session fails with `session_not_found` before anything
  is written). Binding a session attaches real trajectory evidence; without
  it the record is an unbound Owner report with no evidence, and candidates
  will likely be gated by the admission threshold.

### Health Check (Canary)

```bash
pd runtime canary --workspace "<path>" --json
```

The canary runs 7 checks and reports one of three statuses:

| Status | Meaning |
|--------|---------|
| `healthy` | All checks pass |
| `degraded` | Non-critical issues found (orphan candidates, queue blockers) |
| `error` | Schema failure or exception — investigate before proceeding |

### Start the Console

```bash
pd console open --workspace "<path>"
```

Opens the local web UI in your browser. The launcher reuses an existing healthy console or starts one on `127.0.0.1:3100`; if the port is busy, it tries the next local port.

::: warning
The console is loopback-only. It is not accessible from other machines, and `pd console open` refuses non-loopback hosts.
:::

## The Review Console

The local console is your primary window into PD's activity.

### What You Can See

- **Pain trends** — How often is the agent encountering problems?
- **Principle candidates** — What new principles have been proposed?
- **Active principles** — What's currently guiding or constraining the agent?
- **Approval queue** — What's waiting for your decision?
- **Evolution events** — Timeline of all principle lifecycle changes
- **Feedback drafts** — Privacy-preserving local reports you can review before sending

### Reviewing a Principle Candidate

1. Open the console
2. Navigate to the **Principles** page
3. Select a candidate to review
4. Read the pain evidence and proposed principle text
5. Choose an activation channel:
   - **Prompt** — Soft guidance, good for first attempts
   - **RuleHost** — Hard enforcement, use when soft guidance isn't enough
   - **Defer / Archive** — Skip this candidate for now

### Rolling Back

If an activated principle causes problems, you can rollback empathy event penalties or principles directly:

```bash
/pd-rollback last             # Rollback the most recent empathy event penalty
/pd-principle-rollback P_003  # Rollback a principle and blacklist it
```

For implementation lifecycle rollback (`/pd-rollback-impl`), note that the replay-generation path was retired in PRI-230. Use the `pd candidate internalize` CLI workflow for new implementations. See [Slash Commands Reference](./slash-commands) for details.

### Reporting a Problem

Use **Report Problem** in the console when PD behaves unexpectedly. The report is saved as a local draft under the workspace, shows a privacy preview, and can be copied as Markdown, email-ready text, or a GitHub issue draft.

PD does not automatically upload raw prompts, raw chats, trajectory files, file contents, environment variables, or tokens.

## Configuration

### Workspace Configuration

PD needs to know where your agent's workspace is. This is usually set during installation, but you can configure it manually.

**Option 1: Configuration file** (recommended)

Create `~/.openclaw/principles-disciple.json`:

```json
{
  "workspace": "/path/to/your/workspace",
  "state": "/path/to/your/workspace/.state",
  "debug": false
}
```

**Option 2: Environment variables**

```bash
export PD_WORKSPACE_DIR=/path/to/your/workspace
export PD_STATE_DIR=/path/to/your/workspace/.state
```

**Configuration priority** (highest to lowest):

1. Environment variables (`PD_WORKSPACE_DIR`, `PD_STATE_DIR`)
2. Configuration file (`~/.openclaw/principles-disciple.json`)
3. OpenClaw environment (`OPENCLAW_WORKSPACE`)
4. Default (`~/.openclaw/workspace`)

### Plugin Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `language` | `zh` | Interaction language (`en` or `zh`) |
| `auditLevel` | `medium` | Security guardrail level (`low`, `medium`, `high`) |
| `riskPaths` | `[]` | High-risk directories requiring explicit authorization |

## Troubleshooting

### Plugin fails to load

**Error**: `Cannot find module 'micromatch'`

**Fix**:
```bash
cd ~/.openclaw/extensions/principles-disciple
npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48
```

### Plugin shows old version after update

**Fix**:
```bash
rm -rf ~/.openclaw/extensions/principles-disciple
cd /path/to/principles
./packages/openclaw-plugin/scripts/install.sh
```

### Configuration errors

**Error**: `Invalid config: plugin not found: principles-disciple`

**Fix**:
```bash
openclaw doctor --fix
./packages/openclaw-plugin/scripts/install.sh
```

### Where to find logs

Default location: `~/.openclaw/workspace/memory/.state/logs/`

| File | Contents |
|------|----------|
| `events.jsonl` | Structured event log (tool calls, pain signals, gate blocks, evolution tasks) |
| `plugin.log` | Runtime plugin logs |
| `daily-stats.json` | Daily statistics summary |
