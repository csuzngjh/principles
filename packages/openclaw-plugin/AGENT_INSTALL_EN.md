# Principles Disciple - Agent Installation Guide

> **Installation Guide for AI Agents** - Read carefully and follow the steps

---

## 🚨 High-Risk Files Warning

**The following files contain user-accumulated data and must NEVER be deleted or overwritten:**

### User Accumulated Files (Highest Priority)

| File | Content | Risk |
|------|---------|------|
| `.principles/PRINCIPLES.md` | User's accumulated principles and lessons | 🔴 **Delete = Lose all experience** |
| `.principles/PROFILE.json` | User configuration and preferences | 🔴 Delete = Reset all settings |
| `AGENTS.md` | Agent identity and memory | 🔴 Delete = Lose identity cognition |
| `SOUL.md` | Agent core personality | 🔴 Delete = Lose personality |
| `USER.md` | User preferences and context | 🟡 Delete = Lose user preferences |
| `PLAN.md` | Current work plan | 🟡 Delete = Lose work context |
| `MEMORY.md` | Long-term memory | 🔴 Delete = Lose long-term memory |

### State Files (Do Not Delete)

| Directory | Content | Risk |
|-----------|---------|------|
| `.state/` | Runtime state, trust score, evolution points | 🔴 Delete = Reset all progress |
| `.state/evolution_points.json` | Evolution points record | 🔴 Delete = Points reset to zero |
| `.state/AGENT_SCORECARD.json` | Trust score record | 🔴 Delete = Trust score reset |

### Files Safe to Update/Overwrite

| File | Description |
|------|-------------|
| `BOOT.md` | Boot template, can be updated |
| `HEARTBEAT.md` | Heartbeat template, can be updated |
| `IDENTITY.md` | Identity template, can be updated |
| `.principles/THINKING_OS.md` | Thinking models, merge new models after update |
| `.principles/models/*.md` | Thinking model library, can add new models |

### Safe Operation Principles

```
1. When updating: Always use smart mode (default), generates .update files
2. Before deleting: Confirm file is not a user accumulated file
3. Before overwriting: Backup original file first
4. When merging: Preserve all user customizations
```

---

## Quick Check: First Install vs Update

```
Check if ~/clawd/.principles/PRINCIPLES.md exists:
├── Does not exist → First Install (skip to [First Install] section)
└── Exists → Update (skip to [Update] section)
```

---

## First Install

### Step 1: Run Installation Command

```bash
npx create-principles-disciple --non-interactive --lang en --workspace ~/clawd
```

### Step 2: Restart OpenClaw Gateway

```bash
openclaw gateway --force
```

### Step 3: Verify Installation

```bash
openclaw plugins list | grep -A 2 "Principles"
```

You should see `Principles` showing as `loaded`.

### Step 4: Initialize Project

Run in your project directory:

```
/init-strategy
```

---

## Update

### ⚠️ Important Notice

**Updates generate .update files, they will NOT directly overwrite your files!**

### Step 1: Run Update Command

```bash
npx create-principles-disciple --non-interactive --lang en --workspace ~/clawd
```

### Step 2: Check Update Content

```bash
# View changelog
cat ~/clawd/docs/CHANGELOG.md | head -100

# List all .update files
find ~/clawd -name "*.update" -type f
```

### Step 3: Merge Updates

**You must manually merge .update files into original files!**

```
For each .update file:
1. Read original file content
2. Read .update file content
3. Compare differences, merge valuable updates into original file
4. Delete .update file
```

Example workflow:
```
1. Found AGENTS.md.update
2. diff AGENTS.md AGENTS.md.update
3. Identify new sections or modifications
4. Merge needed updates into AGENTS.md
5. rm AGENTS.md.update
```

### Step 4: Restart OpenClaw Gateway

```bash
openclaw gateway --force
```

---

## FAQ

### Q: Error "Cannot find module 'micromatch'"

Install dependencies manually:
```bash
cd ~/.openclaw/extensions/principles-disciple
npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48
```

### Q: How to check current version?

```bash
cat ~/.openclaw/extensions/principles-disciple/package.json | grep version
```

### Q: How to view all updates?

```bash
cat ~/clawd/docs/CHANGELOG.md
```

---

## Version Info

Current document version: 1.6.0

Update this version number when updating this document.
