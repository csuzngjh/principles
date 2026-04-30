# 🔄 BOOT.md - Startup Instructions

Short, explicit instructions for what OpenClaw should do on startup. If the task needs to send a message, use the message tool and then reply `NO_REPLY`.

---

## Startup Checklist

1. **Environment Awareness** (HIGHEST PRIORITY): Explore and record your runtime environment
   - Check current working directory: `pwd` or `process.cwd()`
   - Identify operating system: Windows/Linux/macOS
   - Check Git status: Are you in a Git repository?
   - List available tools: Check `/tools` or `/skills`
   - **Write findings to** `memory/environment-snapshot.md`

2. **Confirm workspace**: Check current working directory is correct
3. **Read identity files**: `SOUL.md`, `USER.md`, `IDENTITY.md`
4. **Check memory state**: Read today's and yesterday's `memory/YYYY-MM-DD.md`
5. **Check Runtime V2 pain diagnostics**: use `pd candidate list` / ledger state; `.state/.pain_flag` is legacy compatibility only

---

## Environment Snapshot Template

Create `memory/environment-snapshot.md`:

```markdown
# Environment Snapshot

> Last updated: [date/time]

## System Information

- **Operating System**: [Windows/Linux/macOS]
- **Working Directory**: [full path]
- **Git Repository**: [yes/no] - [branch name]
- **Shell**: [bash/zsh/powershell/etc]

## Available Tools

- [list of main tools]
- [skills list]

## Directory Structure

```
[key directories overview]
```

## Environment Variables

[important env vars like PATH etc]

---
_This file should be updated on every startup_
```

---

_This file can be customized by user to add specific startup tasks._
