---
title: Getting Started
description: Install Principles Disciple and turn repeated corrections into Owner-approved behavior principles.
---

# Getting Started

## 30 Seconds: What PD Does

Your AI agent keeps making the same mistakes? PD captures those mistakes, finds the pattern, and lets you turn them into **reviewed, reversible rules** — so the agent doesn't repeat them.

```
Agent repeats a mistake → PD spots the pattern → You review → Agent improves
```

You're always in control. Nothing activates without your approval.

## Installation

**Prerequisites**: Node.js ≥ 18 | OpenClaw CLI installed

### 1. Install

```bash
npx create-principles-disciple --yes
openclaw gateway --force
```

### 2. Verify

```bash
pd runtime canary --workspace "<your-workspace-path>"
```

See `healthy`? You're good.

### 3. Open the Console

```bash
pd console open --workspace "<your-workspace-path>"
```

This opens the local review console in your browser. If port 3100 is busy, PD picks the next available local port.

The console is loopback-only. It binds to your own machine, not the public network.

### 4. Let It Run

Use your AI agent as usual. When it makes repeated mistakes, PD will:

1. **Capture** the pain signal automatically
2. **Diagnose** whether it's a one-off or a pattern
3. **Propose** a principle candidate

> **Prerequisite**: Steps 2–3 require a configured LLM runtime profile (provider, API key env, model). If you skipped this during install, run `pd console open --workspace "<path>"` to configure it now. Without a runtime profile, pain signals are still captured but diagnosis won't run automatically.

You'll see the proposal in the console. Choose one of three actions:

| Action | What Happens | When to Use |
|--------|-------------|-------------|
| **Prompt** | Soft reminder injected into agent context | Default choice — low risk |
| **RuleHost** | Hard rule that blocks violating actions | When soft reminders aren't enough |
| **Defer** | Skip and archive | When it's not worth acting on |

### 5. Roll Back If Needed

Changed your mind? Undo anytime:

```
/pd-rollback-impl <id>
```

### Manual CLI Flow (Advanced)

If the automatic flow doesn't trigger (e.g., runtime profile not yet configured, or you used `pd pain record` in async mode), you can drive the full pipeline manually:

```bash
# 1. Record a pain signal (returns a painId).
#    Bind a session recorded in this workspace (--session) so diagnosis
#    carries real trajectory evidence; without it the record is an unbound
#    Owner report with no evidence and candidates will likely be gated.
pd pain record --reason "Agent forgot to confirm scope before cross-module edit" --workspace "<path>" --session "<session-id>"

# 2. Run diagnosis (skip if step 1 used --wait and succeeded)
pd diagnose run --task-id <taskId> --runtime pi-ai --workspace "<path>"

# 3. List candidate principles produced by diagnosis
pd candidate list --task-id <taskId> --workspace "<path>"

# 4. Intake a candidate into the activation pipeline
pd candidate intake --candidate-id <id> --workspace "<path>"

# 5. Approve activation
pd activation approve --approval-id <id> --workspace "<path>"

# 6. Verify activated principles
pd activation list --workspace "<path>"
```

**One-shot alternative** (code_tool_hook channel, runs the full dreamer→philosopher→scribe→artificer loop):

```bash
pd runtime internalization run-rulehost --pain-id <id> --confirm --workspace "<path>"
```

## Report a Problem

Seed users should not need to collect logs manually. In the console, use **Report Problem** to create a local feedback draft with a privacy preview.

PD does **not** automatically upload prompts, chat logs, files, environment variables, or tokens. You review the draft first, then copy it into email or GitHub if you choose.

## That's It

PD is now watching for repeated mistakes and waiting for your review. No configuration needed — it just works.

---

**Stuck?**

- AI won't edit files? → Check if a RuleHost rule is blocking the operation
- Console won't open? → `pd console open --workspace "<your-workspace-path>" --json`
- Check health anytime → `pd runtime canary --workspace "<your-workspace-path>" --json`

**Want more?** → [User Guide](/docs/user-guide) | [Development Guide](/docs/development)
