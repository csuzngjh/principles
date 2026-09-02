---
title: Slash Commands Reference
description: Complete reference for all Principles Disciple slash commands, including usage, parameters, examples, and workflows.
---

# Slash Commands Reference

PD interacts with you through OpenClaw slash commands. This document lists all available commands with plain-language usage instructions.

::: tip Reading Guide
New here? Start with the [User Guide](./user-guide) to understand PD's core concepts, then come back here to look up specific commands.
:::

## Quick Reference Table

All commands start with `/pd-` (short aliases start with `/pd` + a single letter). They never conflict with OpenClaw's built-in commands.

| Command | Short | Category | One-line Purpose |
|---------|-------|----------|------------------|
| [`/pd-init`](#pd-init) | `/pdi` | Setup | Initialize workspace, establish project focus |
| [`/pd-bootstrap`](#pd-bootstrap) | `/pdb` | Setup | Scan local toolchain (rg/sg/fd, etc.) |
| [`/pd-research`](#pd-research) | `/pdr` | Setup | Ask Agent to research tool upgrades |
| [`/pd-help`](#pd-help) | `/pdh` | Setup | List commands in-session |
| [`/pd-status`](#pd-status) | — | Monitoring | View GFI friction index and mental mode |
| [`/pd-pain`](#pd-pain) | — | Monitoring | Manually report a pain signal |
| [`/pd-evolution-status`](#pd-evolution-status) | — | Monitoring | View principle evolution loop status |
| [`/pd-context`](#pd-context) | — | Config | Control context injection (Thinking OS / project focus) |
| [`/pd-focus`](#pd-focus) | — | Config | Manage CURRENT_FOCUS.md (compress/rollback) |
| [`/pd-rollback`](#pd-rollback) | — | Rollback | Rollback a misjudged empathy event penalty |
| [`/pd-principle-rollback`](#pd-principle-rollback) | — | Rollback | Rollback a principle and blacklist it |
| [`/pd-export`](#pd-export) | — | Data | Export analytics or correction samples |
| [`/pd-samples`](#pd-samples) | — | Data | View and review correction samples |

::: warning About Implementation Lifecycle Commands
`/pd-promote-impl`, `/pd-disable-impl`, `/pd-archive-impl`, and `/pd-rollback-impl` have their replay-generation path retired in PRI-230 and are now in a semi-deprecated state. For the new implementation promotion workflow, use the `pd candidate internalize` and `pd runtime activation promote` CLI commands instead. This page no longer documents those four commands.
:::

---

## Setup Commands

### `/pd-init`

**Short**:`/pdi`

Initializes a new workspace. The command itself only outputs guidance text — the actual initialization is done by the Agent following that guidance: it interviews you to establish your project's strategic focus.

**Usage**

```
/pd-init
```

**What Happens**

1. The command tells the Agent to read existing context in the `OKR/` directory
2. The Agent interviews you: What's the project vision? What are the top 1-3 priorities right now?
3. The Agent generates `CURRENT_FOCUS.md` (current focus) and `USER_CONTEXT.md` (user preferences)

**When to Use**

- The first time you use PD in a new workspace
- When project direction shifts significantly and you need to realign

::: tip
`/pd-init` does not directly generate `PRINCIPLES.md` or `THINKING_OS.md` — those files are created automatically by PD's background services when first needed.
:::

---

### `/pd-bootstrap`

**Short**:`/pdb`

Scans your local environment to detect which development tools are installed (rg, sg, fd, qmd, ast-grep, shellcheck) and writes the result to `.state/SYSTEM_CAPABILITIES.json`.

**Usage**

```
/pd-bootstrap
```

**Example Output**

```
🔍 Environment perception complete.
**Detected tools:** `rg`, `fd`, `ast-grep`
**Platform:** darwin
Capabilities saved to `.state/SYSTEM_CAPABILITIES.json`.
```

**When to Use**

- The first time you use PD after installation
- After installing a new tool (e.g., you just installed ast-grep) and want PD to be aware of it

---

### `/pd-research`

**Short**:`/pdr`

Asks the Agent to use web search to research the latest tools in a category and output a "Tool Upgrade Proposal". Text-only output, no side effects.

**Usage**

```
/pd-research [category]
```

**Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `category` | No | Tool category to research; defaults to "modern high-performance CLI tools for coding and architecture" |

**Examples**

```
/pd-research
/pd-research fast code search tools
```

**When to Use**

- When you want to learn about the latest tools in a category (code search, doc generation, etc.)
- When `/pd-bootstrap` shows a missing tool and you want alternatives

---

### `/pd-help`

**Short**:`/pdh`

Quickly view all PD commands in-session. Since OpenClaw's `/help` does not automatically list plugin commands, PD provides its own help command.

**Usage**

```
/pd-help
```

::: tip
Can't remember the commands? Just type `/pdh` to see a quick reference table of all commands.
:::

---

## Monitoring Commands

### `/pd-status`

View PD's system health. This is one of the commands you'll use most often.

**Usage**

```
/pd-status [subcommand]
```

**Subcommands**

| Subcommand | Description |
|------------|-------------|
| (none) | Show GFI friction index, mental mode, pain dictionary stats |
| `empathy [--today\|--week\|--session]` | View empathy event stats (default: today) |
| `reset` | Reset the current session's GFI to zero |
| `data` | View trajectory database stats (turns, tool calls, pain events, etc.) |

**Example Output (default)**

```
📊 Principles Disciple - System Health Monitor
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💊 Current Friction (GFI): [██████░░░░░░░░░] 35/100
🧠 Current Mental Mode: 🤝 CONCILIATORY
   ↳ Diagnosis: High Friction 🟡

🧠 Evolution Dictionary: 12 active rules
   ↳ Successfully blocked 47 invalid operations
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**What is GFI?**

GFI (Global Friction Index) is the current session's "fatigue index". Every time the Agent makes a mistake, gets corrected, or gets blocked, GFI accumulates. The higher the GFI, the more likely the Agent enters "conciliatory mode" — it becomes more cautious, slower, and more apologetic.

- `0-20`: Healthy 🟢
- `21-50`: Minor Issues 🟢
- `51-80`: High Friction 🟡 (consider whether the context is messy)
- `81-100`: Critical 🔴 (consider `/pd-status reset` or starting a new session)

::: tip When to use `reset`
When the Agent has accumulated too much "emotional baggage" and becomes overly cautious or apologetic, `/pd-status reset` clears the GFI so the Agent can start fresh. This doesn't "delete memory" — it only resets the friction accumulation.
:::

---

### `/pd-pain`

Manually report a pain signal to PD. PD usually detects pain automatically (tool failures, user corrections, etc.), but sometimes you want to explicitly record an issue — use this command.

**Usage**

```
/pd-pain <description of the issue>
```

**Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `description` | Yes | Describe the issue in natural language |

**Example**

```
/pd-pain Agent edited the file without reading it first, overwriting existing logic
```

**Example Output**

```
✅ Pain recorded (context-bound)

📋 Pain ID: manual_1751500000000_a1b2c3d4
📝 Reason: Agent edited the file without reading it first, overwriting existing logic
🔗 Provenance: host_context_bound
📌 Session: sess_xxx
📎 Evidence: N trajectory evidence entries
```

When the session's trajectory has no usable evidence yet, the command says so
explicitly instead of claiming a context-bound success — candidates may then
be gated by the admission threshold until evidence exists.

**Difference from Automatic Detection**

- Automatic detection: PD's hook judges whether something is pain after a tool call (tool failure, blocked, etc.)
- `/pd-pain`: You actively record a "soft" issue (e.g., the Agent's judgment direction was wrong, but no error occurred)

::: warning
`/pd-pain` must be used inside an OpenClaw chat session — it depends on the current session's context (context-bound provenance). In a non-session environment it will report "Session ID not available".
:::

---

### `/pd-evolution-status`

View the full state of the principle evolution loop: control plane (GFI/gate), evolution plane (queue/tasks), principle stats, workflow funnel.

**Usage**

```
/pd-evolution-status
```

**Output Contents**

- **Control Plane**: Current GFI, GFI sources, recent gate blocks/bypasses
- **Evolution**: Evolution queue status (pending/in_progress/completed), current evolution task
- **Principles**: Principle stats (candidate/probation/active/archived counts)
- **Workflow Funnel**: Pass rates at each workflow stage

**When to Use**

- When you want to know how many principle candidates are waiting for review
- When you want to confirm that evolution tasks are progressing normally
- When troubleshooting "why isn't my principle being activated"

---

## Configuration Commands

### `/pd-context`

Control what context PD injects into the Agent. This is the main entry point for adjusting PD's "presence".

**Usage**

```
/pd-context [subcommand]
```

**Subcommands**

| Subcommand | Description |
|------------|-------------|
| `status` | View current injection status (default) |
| `thinking on\|off` | Toggle Thinking OS injection |
| `focus full\|summary\|off` | Set project context mode |
| `minimal` | Preset: core principles only (quietest) |
| `standard` | Preset: core principles, no Thinking OS |
| `full` | Preset: core principles + Thinking OS + project context (fullest) |
| `help` | Show help |

**Examples**

```
/pd-context status
/pd-context thinking on
/pd-context focus summary
/pd-context full
```

**Preset Differences**

| Preset | Core Principles | Thinking OS | Project Context | Best For |
|--------|-----------------|-------------|-----------------|----------|
| `minimal` | ✅ | ❌ | ❌ | Minimal interference, let Agent work freely |
| `standard` | ✅ | ❌ | ❌ | Daily use (same as minimal) |
| `full` | ✅ | ✅ | ✅ (summary) | Complex tasks, Agent needs full picture |

::: tip Core principles are always injected
Regardless of preset, **core principles (always-on) are always injected** and cannot be disabled. What's configurable is only the "enhancement layers" like Thinking OS and project context.
:::

**Where is the config stored?**

Configuration is written to `.pd/config.yaml` (the ADR-0016 unified config file) and takes effect on the next turn.

---

### `/pd-focus`

Manage the `CURRENT_FOCUS.md` file — this file records the current project focus, current tasks, and next steps. As work progresses, this file grows longer; `/pd-focus` helps you compress and roll it back.

**Usage**

```
/pd-focus [subcommand]
```

**Subcommands**

| Subcommand | Short | Description |
|------------|-------|-------------|
| `status` | — | View current status and historical versions |
| `history` | `hist` | List historical versions |
| `compress` | `cp` | Manually compress (archive milestones, clean completed items) |
| `rollback <n>` | `rb <n>` | Rollback to a specified historical version |
| `help` | — | Show help |

**Examples**

```
/pd-focus status
/pd-focus compress
/pd-focus rollback 3
```

**When to Use `compress`**

- When `CURRENT_FOCUS.md` exceeds 40 lines
- When you've completed a milestone and want to clear completed items while keeping unfinished ones
- When you want to archive milestones to the `memory/` diary

::: tip Auto-compression
PD also auto-compresses `CURRENT_FOCUS.md` in the background. `/pd-focus compress` is a manual trigger for when you want to clean up immediately.
:::

---

## Rollback Commands

PD's core promise is "reversibility". These commands let you undo PD's decisions.

### `/pd-rollback`

Rollback the penalty from an empathy event. When PD misjudges a "user frustration" and GFI rises incorrectly, use this command to undo it.

**Usage**

```
/pd-rollback <event-id>
/pd-rollback last
```

**Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `event-id` | Yes | The event ID to rollback (or use `last` for the most recent) |

**Examples**

```
/pd-rollback last
/pd-rollback evt_20260701_001
```

**`last` vs `<event-id>`**

- `last`: Rollback the most recent empathy event in the current session (most common)
- `<event-id>`: Rollback a specific event (get the ID from `/pd-status empathy` output)

**What Happens After Rollback**

1. The event's penalty score is subtracted from GFI
2. The event is marked as "rolled back"
3. The Agent's friction level decreases accordingly

::: warning
`/pd-rollback` must be used in a chat session (depends on sessionId). It rolls back "empathy penalty", not "principles" — to rollback a principle, use `/pd-principle-rollback`.
:::

---

### `/pd-principle-rollback`

Rollback a principle and add its pattern to the blacklist (preventing it from being re-proposed).

**Usage**

```
/pd-principle-rollback <principle-id> [reason]
```

**Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `principle-id` | Yes | Principle ID (e.g., `P_001`, from `/pd-evolution-status` or `PRINCIPLES.md`) |
| `reason` | No | Reason for rollback (default: "manual rollback") |

**Examples**

```
/pd-principle-rollback P_003
/pd-principle-rollback P_003 This principle is too strict and blocks normal development
```

**Difference from `/pd-rollback`**

| Command | Rollback Target | Effect |
|---------|-----------------|--------|
| `/pd-rollback` | One empathy event | GFI decreases, principles unaffected |
| `/pd-principle-rollback` | One principle | Principle deactivated + pattern blacklisted, prevents re-proposal |

---

## Data Commands

### `/pd-export`

Export PD's collected data for analysis or backup.

**Usage**

```
/pd-export analytics
/pd-export corrections [--redacted]
```

**Subcommands**

| Subcommand | Description |
|------------|-------------|
| `analytics` | Export analytics snapshot (aggregated stats) |
| `corrections [--redacted]` | Export correction samples (approved ones) |

**What is `--redacted`?**

The `--redacted` flag applies redaction (removes sensitive info), suitable for sharing or reporting. Without it, raw data is exported.

**Examples**

```
/pd-export analytics
/pd-export corrections --redacted
```

**Example Output**

```
Exported correction samples to .state/exports/corrections_20260701.json (mode=redacted, count=15).
```

---

### `/pd-samples`

View and review correction samples. Correction samples are "training data" extracted by PD from the Agent's mistakes.

**Usage**

```
/pd-samples
/pd-samples review approve <sample-id> [note]
/pd-samples review reject <sample-id> [note]
```

**Subcommands**

| Subcommand | Description |
|------------|-------------|
| (none) | List all pending samples |
| `review approve <id> [note]` | Approve a sample |
| `review reject <id> [note]` | Reject a sample |

**Examples**

```
/pd-samples
/pd-samples review approve s_001 good quality
/pd-samples review reject s_002 this isn't actually an error
```

**What `reject` Triggers**

Rejecting a sample isn't just "not approved" — it triggers a `correction_rejected` pain event, causing PD to re-diagnose. This is PD's "reverse learning" mechanism: when you reject a wrong correction sample, PD learns that its judgment was off.

::: tip Review Workflow
1. `/pd-samples` to see the pending list
2. Decide `approve` or `reject` based on sample quality
3. Approved samples enter training data; rejected samples trigger re-diagnosis
:::

---

## Common Workflows

### Workflow 1: First-time PD Setup

```
1. /pdi              # Initialize workspace, establish project focus
2. /pdb              # Scan local tools
3. /pd-status        # Confirm PD is running normally
4. /pd-context full  # Enable full context (optional, for complex projects)
```

### Workflow 2: Correcting Agent Mistakes

```
1. /pd-pain Agent edited without reading the file first, overwrote my code
2. /pd-status        # Check if GFI rose
3. (Wait for PD background diagnosis, or use /pd-evolution-status to view queue)
```

### Workflow 3: Agent is Over-fatigued

When the Agent keeps apologizing and is overly cautious:

```
1. /pd-status        # Check GFI, confirm it's too high
2. /pd-status reset  # Clear GFI
3. (Continue working, Agent returns to efficient mode)
```

### Workflow 4: Rollback a Misjudgment

PD misjudged a "user frustration" and GFI rose incorrectly:

```
1. /pd-status empathy --session  # View current session's empathy events
2. /pd-rollback last             # Rollback the most recent misjudgment
3. /pd-status                    # Confirm GFI has decreased
```

### Workflow 5: Review Correction Samples

```
1. /pd-samples                    # View pending samples
2. /pd-samples review approve s_001  # Approve good samples
3. /pd-samples review reject s_002   # Reject wrong samples (triggers re-diagnosis)
4. /pd-export corrections --redacted  # Export redacted data (optional)
```

### Workflow 6: Principle Governance

```
1. /pd-evolution-status           # See what candidate principles exist
2. (Review principle candidates in the console)
3. /pd-principle-rollback P_003   # Rollback an inappropriate activated principle
```

---

## FAQ

### Command not responding?

- Confirm PD plugin is installed: if `/pd-help` responds, the plugin loaded successfully
- Confirm you're in a workspace: PD commands need workspace context
- Check logs: `~/.openclaw/workspace/memory/logs/SYSTEM_*.log`

### `/pd-pain` says "Session ID not available"?

`/pd-pain` must be used inside an OpenClaw chat session, not from the CLI or a non-session environment.

### Output is in English, how do I switch to Chinese?

Edit your workspace's `.pd/config.yaml` and set `language: zh`. Or set it in the plugin config.

### GFI won't go down?

- Use `/pd-status reset` to clear the current session's GFI
- Check if there are persistent tool failures triggering pain (fix the root cause)
- Consider `/clear` to start a new session

### How do I view all activated principles?

- Run `/pd-evolution-status` for stats
- Read `~/.openclaw/workspace/.principles/PRINCIPLES.md` directly

---

## Related Documentation

- [User Guide](./user-guide) — PD core concepts and workflows
- [Getting Started](./getting-started) — Installation and first-time setup
- [Development Guide](./development) — The `pd` CLI tool for out-of-session use
