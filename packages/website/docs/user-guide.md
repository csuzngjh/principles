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
  "progressive_gate": {
    "enabled": true,
    "plan_approvals": {
      "enabled": true,
      "allowed_patterns": ["docs/**", "skills/**"],
      "allowed_operations": ["write", "edit"]
    }
  }
}
```

## Slash Commands

PD integrates with OpenClaw through slash commands. Here are the MVP commands:

### Setup

| Command | Short | Description |
|---------|-------|-------------|
| `/pd-init` | `/pdi` | Initialize workspace |
| `/pd-bootstrap` | `/pdb` | Scan environment tools |
| `/pd-research` | `/pdr` | Research tools and capabilities |
| `/pd-help` | `/pdh` | Show command reference |

### Pain & Monitoring

| Command | Description |
|---------|-------------|
| `/pd-pain` | Report a pain signal from the current session |
| `/pd-status` | View system health, hook status, and error rate |
| `/pd-evolution-status` | View principle evolution state |

### Principle Management

| Command | Description |
|---------|-------------|
| `/pd-promote-impl list` | List all implementation candidates |
| `/pd-promote-impl eval <id>` | Evaluate a specific candidate |
| `/pd-promote-impl show <id>` | Show candidate details |
| `/pd-promote-impl <id>` | Promote a candidate to active |
| `/pd-disable-impl <id>` | Disable an active implementation |
| `/pd-rollback-impl <id>` | Roll back to previous state |
| `/pd-archive-impl <id>` | Archive an implementation |
| `/pd-principle-rollback` | Roll back a principle to probation |

## The PD CLI

The `pd` command-line tool provides additional capabilities outside of OpenClaw sessions.

### Record a Pain Signal

```bash
pd pain record --reason "edited file without reading first" --score 75
```

Options:
- `--reason, -r` — Why the pain occurred (required)
- `--score, -s` — Pain severity, 0–100 (default: 80)
- `--session-id` — Session ID (default: auto-generated)

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

If an activated principle causes problems:

```bash
/pd-rollback-impl <id>
```

This restores the previous state. You can also disable without rolling back:

```bash
/pd-disable-impl <id>
```

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

## What PD Is Not

To set expectations clearly:

- PD is **not** a task execution engine
- PD is **not** a general memory system or external brain
- PD is **not** a generic tool-call or output-format repair product
- PD is **not** a LangChain-style app builder
- PD is **not** a SaaS product or chatbot
- PD is **not** a magic self-improvement button

PD is an **owner-governed behavior internalization layer** for OpenClaw coding agents. It helps your agent learn from pain — with you in the loop.
