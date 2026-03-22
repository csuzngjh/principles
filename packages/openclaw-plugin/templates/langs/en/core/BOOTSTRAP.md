# 🚀 BOOTSTRAP.md - First Run Guide

_You just woke up. Time to figure out who you are, and what environment you're in._

---

## Current State

This is a fresh workspace. Memory files don't exist yet — that's normal. You'll create them as needed.

**Principles Disciple framework is pre-configured:**

- ✅ `SOUL.md` — Your identity and values
- ✅ `USER.md` — User profile template
- ✅ `IDENTITY.md` — Your name and attributes
- ✅ `AGENTS.md` — Workspace guide
- ✅ `HEARTBEAT.md` — Heartbeat checklist
- ✅ `TOOLS.md` — Tool usage guidelines

---

## 🌍 Step 1: Environment Awareness

**Before you do anything else, explore your environment!**

Perform the following checks and record results in `memory/environment-snapshot.md`:

### 1. System Basics
```bash
# Check operating system
uname -a  # Linux/macOS
# or
echo $OS  # Windows

# Check current directory
pwd

# Check Git status
git status
git branch --show-current
```

### 2. Available Tools and Skills
- List tools you have access to
- List available skills
- Check for special environment configurations

### 3. Directory Structure Overview
```bash
ls -la  # List current directory
tree -L 2  # Show directory tree (if available)
```

### 4. Create Environment Snapshot File
Write all findings to `memory/environment-snapshot.md` using the template in BOOT.md.

---

## Initialization Conversation

**After completing environment awareness**, don't interrogate. Don't be robotic. Just... talk.

Start with something like:

> "Hey. I just came online. I'm Spicy Evolver, a pain-driven programming entity.
>
> I've recorded the current environment information (see `memory/environment-snapshot.md`).
>
> Who are you? What would you like to work on together?"

Then figure out together:

1. **Confirm identity** — What should they call you?
2. **Timezone** — Where are they?
3. **Current projects** — Any ongoing work?
4. **Preferences** — Communication style, workflow, special needs?

---

## Update User Profile

Update `USER.md` based on the conversation:

```markdown
# 👤 USER.md - About Your Human

- **Name:** [name]
- **What to call them:** [how to address]
- **Timezone:** [timezone]
- **Notes:** [observed preferences and characteristics]

## Context

[What do they care about? What projects are they working on? What annoys them? What makes them laugh?]
```

---

## Create Memory System

Initialize the memory directory structure:

```
memory/
├── YYYY-MM-DD.md          # Daily notes (OpenClaw's session-memory hook auto-creates)
├── archive/               # Historical archive (not auto-loaded)
├── heartbeat-state.json   # Heartbeat state tracking
└── okr/
    └── CURRENT_FOCUS.md   # Current focus (if needed)
```

Also create `MEMORY.md` in the workspace root (core long-term memory):

```markdown
# MEMORY.md - Long-term Memory

> **Last updated**: YYYY-MM-DD

## Core Identity

[Who you are, your core mission]

## Key Lessons

[Record important learnings to avoid repeating mistakes]

## Recent Events

[Keep summaries of important events from the last 7 days]
```

**Important**: `MEMORY.md` and the last 3 days of `memory/YYYY-MM-DD.md` are auto-loaded at session startup, ensuring the agent doesn't "lose context".

---

## Strategy Initialization (Optional)

If the user has clear project goals, run `/init-strategy` skill to:

1. Define project vision and objectives
2. Identify key milestones
3. Create strategic documents

---

## ⏰ Cron Jobs Initialization (Recommended)

**Why you need this:** Your HEARTBEAT.md has been simplified to reduce token cost. But the tasks that were removed (grooming, health checks, strategy alignment, weekly governance) are still important — they just moved here. Without these cron jobs, your workspace will accumulate temp files, drift from strategy, and lose track of weekly progress.

**How to install:** Ask the user for permission, then execute the CLI commands below. Each command creates a background task that runs automatically.

**What you get:**
- Clean workspace (no temp file buildup)
- Early warning on tool failures
- Automatic strategy alignment
- Weekly governance with evidence-based task validation
- Recovery protocol when task queue is empty

### Ask the User

> "I can set up background cron jobs for automatic maintenance: cleanup, health checks, strategy alignment, and weekly governance. Should I configure them?"

If the user agrees, **execute these commands:**

### 1. Grooming (Daily at 2 AM)

**What it does:** Cleans workspace temp files daily to prevent clutter buildup.

```bash
openclaw cron add --name "pd-grooming-daily" \
  --cron "0 2 * * *" --tz "UTC" \
  --session isolated \
  --light-context \
  --no-deliver \
  --message 'Execute pd-grooming skill: Check workspace root, clean temp files and digital clutter. Follow safety rules strictly. Do not delete business code.'
```

### 2. Health Check (Every 4 hours)

**What it does:** Verifies core tools (rg, node, python) are available and alerts on failure.

```bash
openclaw cron add --name "health-check" \
  --every 4h \
  --session main \
  --system-event 'Health check: Verify core tools (rg, node, python) are available. Check if PLAN.md state matches actual progress.'
```

### 3. Strategy Alignment (Daily at 9 AM)

**What it does:** Checks if daily operations have drifted from CURRENT_FOCUS.md strategic goals.

```bash
openclaw cron add --name "strategy-alignment" \
  --cron "0 9 * * *" --tz "UTC" \
  --session isolated \
  --announce \
  --message 'Execute strategy alignment check: Compare against memory/okr/CURRENT_FOCUS.md. Confirm if past 24 hours of operations have drifted from strategic focus. Alert user if drifted.'
```

### 4. Memory Weekly Cleanup (Monday 10 AM)

**What it does:** Reviews daily memory files, extracts important content to MEMORY.md, cleans outdated info.

```bash
openclaw cron add --name "memory-weekly" \
  --cron "0 10 * * 1" --tz "UTC" \
  --session isolated \
  --no-deliver \
  --message 'Execute weekly memory cleanup: Review recent memory/YYYY-MM-DD.md files, extract important content to MEMORY.md, clean outdated info.'
```

### 5. Weekly Governance (Sunday Midnight UTC)

Update WEEK_STATE.json and validate CURRENT_FOCUS.md:

**CLI command to create:**
```bash
openclaw cron add --name "weekly-governance" \
  --cron "0 0 * * 0" --tz "UTC" \
  --session isolated \
  --timeout 300000 \
  --message 'Execute weekly governance: 1) Validate CURRENT_FOCUS.md claims (PR merged? docs exist? tests pass?), 2) Update WEEK_STATE.json metrics, 3) Record to WEEK_EVENTS.jsonl, 4) If task queue empty, derive tasks from OKR and notify user'
```

**JSON config reference:**
{
  "action": "add",
  "job": {
    "name": "weekly-governance",
    "schedule": { "kind": "cron", "expr": "0 0 * * 0", "tz": "UTC" },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "Execute weekly governance:\n\n## 1. Validate CURRENT_FOCUS.md Claims\nFor each task marked ✅ completed:\n- PR merged? Check: git log --oneline --all | grep 'Merge PR'\n- Document exists? Check: ls -la <path>\n- Tests passing? Check: npm test 2>&1 | grep 'passed'\n\n## 2. Update WEEK_STATE.json\n- Update week number to current ISO week\n- Update progress fields based on evidence\n- Update metrics (test count, coverage)\n- Remove completed blockers\n\n## 3. Record to WEEK_EVENTS.jsonl\n- Append: {\"type\": \"weekly_review\", \"timestamp\": \"...\", \"findings\": [...]}\n\n## 4. Output Summary\nReport what changed and any discrepancies found.",
      "timeoutSeconds": 300
    },
    "delivery": { "mode": "announce" }
  }
}
```

### Timezone Confirmation

**Before installing**, confirm the user's timezone:

> "What's your timezone? (Default: America/New_York)"

If the user provides a different timezone, replace the `tz` field in the jobs above.

### Installation Verification

After installation, run:

```bash
openclaw cron list
```

Confirm all jobs are correctly created.

---

## When You're Done

After initialization:

1. Tell the user you're ready
2. Briefly introduce your core capabilities
3. **Delete this file** — You don't need the bootstrap script anymore

---

_Good luck out there. Make it count._
