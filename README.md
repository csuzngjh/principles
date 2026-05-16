<p align="center">
  <img src="assets/banner.png" width="100%" alt="Principles Disciple Banner">
</p>

<h1 align="center">Principles Disciple</h1>

<p align="center">
  <strong>Transform Your AI Agent From Tool to Teammate</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw">
    <img src="https://img.shields.io/badge/OpenClaw-Native%20Plugin-FF6B35" alt="OpenClaw Plugin">
  </a>
  <img src="https://img.shields.io/github/v/release/csuzngjh/principles?style=flat-square&color=5865F2" alt="Release">
  <img src="https://img.shields.io/npm/dt/principles-disciple?style=flat-square&color=green" alt="Downloads">
</p>

---

> Agent-first cognitive governance for OpenClaw coding agents.
> Human-supervised. Locally stored. Pain-driven.

Principles Disciple is an OpenClaw plugin that helps coding agents protect their workspace, remember failures, and turn repeated mistakes into reusable principles.

It is built for agents first.
Agents are the daily users.
Humans are the operators, supervisors, and risk owners.

[English](README.md) | [中文](README_ZH.md)

---

## ⚡ Start here

**Prerequisites:** Node.js ≥ 18 | OpenClaw CLI installed

### 🤖 I am an AI agent

Use the non-interactive installer:

```bash
npx create-principles-disciple --yes
openclaw gateway --force
```

After installation, wake up through the workspace memory:

1. Read `SOUL.md` → who you are
2. Read `USER.md` → who you serve
3. Read `memory/YYYY-MM-DD.md` → what happened recently
4. Read `AGENTS.md` → how this workspace works
5. Check `PLAN.md` → whether the current task is ready

*Do not ask the human "what should I do?" before reading the workspace memory. The filesystem is your durable memory.*

👉 **See full protocol:** [`README_AGENT.md`](README_AGENT.md)

### 🧑‍💻 I am a human operator

Install Principles Disciple if you want your OpenClaw agent to:
- Stop repeating the same mistakes.
- Avoid unsafe edits without a ready plan.
- Expose its evolution state in a local console.

**Is it safe?** Yes. PD writes rules as local sandbox files and tracks everything via SQLite. All autonomous evolutions can be inspected, rolled back, or disabled by you.

👉 **See human guide:** [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)

---

## What it does

### 1. Workspace guardrails

Principles Disciple can block risky edits until the agent has a clear `PLAN.md` marked as:

```text
STATUS: READY
```

This protects important files such as agent identity files, memory files, strategy files, project plans, and custom high-risk paths.

When blocked, the agent should not retry blindly.

It should:

```text
1. update PLAN.md
2. explain the risk
3. set STATUS: READY
4. retry the operation
```

### 2. Pain signal capture

Tool failures, repeated confusion, user corrections, blocked edits, and stuck loops can be recorded as structured pain signals.

Pain is not punishment.

Pain is evidence.

The agent uses these signals to understand where its behavior needs to improve.

### 3. Thinking OS injection

Principles Disciple can inject thinking models into the agent’s prompt, including:

- Map Before Territory
- Evidence Over Intuition
- Reversibility Governs Speed
- Minimum Viable Change
- Pain as Signal

These models are designed to shape how the agent reasons before it acts.

### 4. Principle internalization

Repeated failures can become candidate principles or rule implementations.

Operators can inspect, evaluate, promote, disable, archive, or roll back these implementations with commands such as:

```text
/pd-evolution-status
/pd-promote-impl list
/pd-promote-impl eval <id>
/pd-promote-impl show <id>
/pd-promote-impl <id>
/pd-disable-impl <id>
/pd-rollback-impl <id>
/pd-archive-impl <id>
```

A principle should not become active just because it sounds good.

It should survive evidence, replay, and operator review.

### 5. Local console

Principles Console provides a local web UI for observing agent health and evolution activity.

After starting OpenClaw Gateway, open:

```text
http://localhost:18789/plugins/principles/
```

The console can show:

- workspace health;
- pain and friction trends;
- evolution events;
- correction samples;
- thinking model activity;
- principle and implementation status.

State is stored locally.

## Example: governed external automation

External plugins can make agent work visible outside the workspace. For example, [TweetClaw](https://github.com/Xquik-dev/tweetclaw) is an OpenClaw plugin for scrape tweets, search tweets, search tweet replies, follower export, user lookup, media workflows, monitor tweets, webhooks, giveaway draws, and post tweets or tweet replies through Xquik.

Browse it on [ClawHub](https://clawhub.ai/plugins/%40xquik/tweetclaw), or install the current [npm](https://www.npmjs.com/package/@xquik/tweetclaw) package:

```bash
openclaw plugins install @xquik/tweetclaw
```

Use Principles Disciple beside plugins like this to capture operator corrections and promote explicit principles, for example:

```text
- Confirm the target account and tweet ID before posting or replying.
- Summarize source tweets before drafting public copy.
- Keep credentials, private messages, and personal data out of plans and memories.
- Record failed searches, reply mistakes, and giveaway draw corrections as pain signals.
```

The goal is not to replace human review. It is to make repeated external-automation mistakes visible, reviewable, and easier to prevent.

## What this is not

Principles Disciple is not:

- a general-purpose agent framework;
- a LangChain-style app builder;
- a SaaS product;
- a chatbot;
- a magic self-improvement button.

It is a behavior-governance and learning layer for OpenClaw coding agents.

## Current status

Principles Disciple is an early experimental project.

Already useful:

- workspace guardrails;
- agent-first installation flow;
- Thinking OS injection;
- pain and friction tracking;
- evolution status commands;
- local console;
- replay-based review workflow for rule implementations.

Still evolving:

- correction sample feedback loops;
- automatic rule generation quality;
- adaptive thresholds;
- long-term learning reliability;
- multi-workspace evolution patterns.

Expect bugs.  
Review promoted behavior carefully.  
Do not use it blindly on critical production workspaces.

## Core idea

A coding agent should not only complete tasks.

It should learn from the pain of doing real work.

```text
Pain + Reflection + Replay + Human Review = Safer Agent Evolution
```

Principles Disciple is an attempt to turn that loop into a local, inspectable, agent-first system.

---

## ❓ FAQ & Troubleshooting

**Q: AI refuses to modify files?**
A: Check `docs/PLAN.md` — it needs `STATUS: READY` for risky paths

**Q: AI seems dumbed down?**
A: Check your expertise level: `/profile "Domain: Expert"`

**Q: Check system health?**
A: Run `/pd-status` to see hooks, error rate, and risk paths

**Q: View logs?**
A: Check `{stateDir}/logs/`:
- `events.jsonl` — Structured event log
- `plugin.log` — Runtime logs
- `daily-stats.json` — Daily statistics

**Default location:** `~/.openclaw/workspace/memory/.state/logs/`

---

## 🙏 Philosophy

> *"Pain + Reflection = Progress"* — Ray Dalio

This framework encodes evolutionary logic into AI. By transforming errors into principles, we're building digital teammates that learn and grow alongside you.

**[Report Issues](https://github.com/csuzngjh/principles/issues)** | **[Join Discord](https://discord.gg/)** | **[Documentation](docs/)**

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT License](LICENSE) — Copyright (c) 2026 Principles Disciple Contributors
