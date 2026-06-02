# Getting Started with Principles Disciple

> **What is PD in 10 seconds?** Your AI assistant makes the same mistakes? PD spots the pattern, shows it to you, and lets you fix it — so the AI stops repeating it. You're in control the whole time.

---

## What PD Is

Principles Disciple (PD) gives you a simple loop:

```
Your AI makes a mistake → PD spots the pattern → You review → Your AI improves
```

Every step is **owned by you**. Nothing activates without your approval. Everything is **reversible** — if a change doesn't work, you can undo it.

The thing PD changes is your AI's **behavior pattern** — not a single command error, not what it remembers, but *how it acts*. The kind of thing you'd tell a friend: "Please check before you delete." PD makes that happen across sessions, so the AI acts right without being told again.

## What PD Is NOT

| Not this | Why |
|----------|-----|
| A task executor | PD doesn't do your work. It shapes *how* your AI does work. |
| A memory system | PD doesn't help the AI remember facts. That's your AI's own job. |
| An autonomous "fix itself" machine | PD proposes, **you approve**. No silent robot overlords. |
| A statistics dashboard | PD is about *observable behavior change*, not charts. |
| A penalty system | PD doesn't punish mistakes. It learns from patterns. |

PD is a **governance layer** for your AI's behavior. That's all. That's enough.

---

## Quick Install (Windows/Mac/Linux)

### Prerequisites

You need two things already installed:

1. **Node.js** ≥ 18 (get it from [nodejs.org](https://nodejs.org))
2. **OpenClaw CLI** — the environment your AI agent runs in

Verify:
```bash
node --version
openclaw --version
```

### One-Command Install

```bash
npx create-principles-disciple --yes
openclaw gateway --force
```

This takes about 2 minutes. It installs three things:

- **The PD Plugin** — runs inside your AI agent and watches for patterns
- **The `pd` CLI** — lets you check status, run checks, manage principles
- **The PD Console** — a web interface where you review and approve principle proposals

### Verify It Worked

```bash
pd runtime canary --workspace "<your-workspace-path>"
```

If you see `healthy`, you're good. The console starts at **http://127.0.0.1:3100** (run `pd console --workspace "<your-workspace-path>"` to open it).

---

## Console, CLI, Plugin — What's What

### PD Plugin (runs inside OpenClaw)

This is the core. It's installed into your OpenClaw extensions directory. Every time you use your AI agent, the plugin is active:

- ❤️ **Watching** for behavior patterns (not recording everything you do — just behavioral signals)
- 🔍 **Diagnosing** whether a pattern is a one-off or worth your attention
- 📨 **Proposing** principles for your review

You don't interact with the plugin directly. It's the engine.

### PD CLI (`pd` command)

Command-line tool for checking status and managing your PD installation:

```bash
pd runtime canary    # Is everything healthy?
pd status            # What's the current state?
pd activation list   # What principles are active?
```

### PD Console (Web UI)

A browser-based interface where you:
- Review principle proposals
- Approve or reject them
- See what's active and what's been archived
- Submit feedback

Open it: `pd console --workspace "<your-workspace-path>"` → http://127.0.0.1:3100

---

## How to Submit Feedback

PD takes your privacy seriously. Feedback is designed to be **local-first**:

1. **Open the Console**: run `pd console --workspace "<your-workspace-path>"`
2. **Go to Feedback**: click the feedback entry point in the interface
3. **Fill in what happened**: type, title, description
4. **Review the privacy preview**: PD shows you exactly what gets included
5. **Save a local draft** (optional): stored in `<workspace>/.pd/feedback/drafts/`
6. **Copy or submit manually**: PD never sends anything automatically

### Privacy Guarantee

| Included | NOT Included |
|----------|-------------|
| Plugin version, OS info | Raw chat text |
| Feature flag states | Your file contents |
| Bounded diagnostic summary | Full stack traces |
| What you typed | Environment variables, tokens, API keys |

You always see what's being shared before anything leaves your machine.

**[To report an issue on GitHub](https://github.com/csuzngjh/principles/issues/new)** — copy the Markdown from your local draft and paste it into the issue. That's the recommended path.

---

## How to Roll Back an Active Principle

Changed your mind? No problem.

### Via CLI

```bash
# See what's active
pd activation list

# Disable one
pd activation disable <id> --reason "Changed my mind"

# Or roll back to the previous version
pd rollback-impl <id> --reason "Behavior regression"
```

### Via Console

1. Open the Console (http://127.0.0.1:3100)
2. Go to the Principles or Approvals page
3. Find the active principle
4. Click "Disable" or "Rollback"

**What happens**: The principle stops applying immediately. The AI agent goes back to its prior behavior. The principle stays in your history — you can re-enable it later if you want.

---

## What Happens After Installation

Just use your AI agent normally. PD is passive by default — it needs to observe patterns before it proposes anything.

When it does find a pattern:

1. PD captures the **pain signal** (behavioral evidence)
2. It **diagnoses** whether it's a pattern worth your attention
3. It **proposes** a principle in the Console
4. You review and pick one of three actions:

| Action | What happens | When to use |
|--------|-------------|-------------|
| **Prompt** | Soft reminder added to AI's context | Default choice — low risk |
| **RuleHost** | Hard block on violating actions | When soft reminders aren't enough |
| **Defer** | Skip, archive it for later | When the pattern isn't worth acting on |

---

## Troubleshooting

### "Plugin won't load"

```bash
cd ~/.openclaw/extensions/principles-disciple
npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48
openclaw gateway --force
```

### "Can't find `pd` command"

The `pd` CLI is installed to `~/.openclaw/bin/`. Add this to your PATH:

```bash
export PATH="$HOME/.openclaw/bin:$PATH"
```

Or use the full path: `~/.openclaw/bin/pd`

### "AI won't edit files"

Check if a RuleHost rule is blocking the operation:
```bash
pd activation list
```

### Check health anytime

```bash
pd status
```

---

## Next Steps

- **[User Guide](./USER_GUIDE.md)** — daily commands and workflows
- **[Configuration](./configuration/CONFIGURATION.md)** — environment variables and settings
- **[Value Proposition](./VALUE_PROPOSITION.md)** — the deeper vision
- **[Product Identity](./PRODUCT_IDENTITY.md)** — what PD does and doesn't do
- **[GitHub Issues](https://github.com/csuzngjh/principles/issues)** — report bugs, request features
