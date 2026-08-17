# Principles Disciple

**Stop correcting the same AI behavior across sessions.**

Principles Disciple (PD) is a native OpenClaw plugin that captures the moments
where you correct your agent, turns repeated corrections into reviewable
principle proposals, and — only after you approve them — lets those principles
influence how the agent behaves in future sessions.

**Owner-controlled · Observable · Reversible**

## The problem

Every session starts from zero. You correct the agent — "confirm scope before
cross-module edits", "don't touch generated files", "ask before deleting" —
it complies, the session ends, and the next session makes the same mistake.
Your corrections vanish; you pay for them again and again.

## A typical moment

**Without PD**

> You tell the agent: *"Before changing multiple modules, confirm the scope
> first."* It complies. A few sessions later, you are correcting it again.

**With PD**

```text
Repeated behavioral evidence (the same correction, again)
        ↓
A behavioral pattern becomes reviewable
        ↓
PD proposes a principle
        ↓
You review the evidence, adjust the wording, approve it
        ↓
The principle can influence future sessions — injected into the agent's
context, or enforced through tool hooks
        ↓
The agent proactively presents a change scope and verification plan
```

If a principle later causes side effects, roll it back with one command.

PD does not promise that N corrections automatically produce a principle, and
it never applies anything without you. It makes your repeated judgment
**durable** instead of disposable.

## How PD works

1. **You correct the agent** — or PD captures behavioral evidence through
   OpenClaw hooks (tool failures, risky edits, blocked operations).
2. **Evidence is recorded locally** as part of the agent's behavior history.
3. **Recurring patterns become reviewable** — you can inspect the raw
   evidence before deciding anything.
4. **PD proposes a principle** describing the behavior change.
5. **You review, edit, approve, or reject.** Nothing activates without owner
   approval.
6. **Approved principles can influence future behavior** — via context
   injection (`prompt`) or hook-based enforcement (`code_tool_hook` /
   RuleHost). You choose the channel; some corrections can also be deferred
   or archived instead of activated.
7. **Everything is reversible** — activated principles can be disabled or
   rolled back, with the evidence trail intact.

## You stay in control

- **No autonomous value decisions.** PD only internalizes behavior you have
  reviewed and approved.
- **Local-first.** Evidence, principles, and decision logs live in your local
  workspace (files + SQLite). No cloud service required.
- **Reversible by design.** `/pd-principle-rollback` rolls a principle back
  and blacklists its pattern; implementation changes can be disabled or
  archived.
- **Observable.** `/pd-status`, `/pd-samples`, and `/pd-export` show what PD
  knows, what it proposed, and what you decided.

## More than memory

Memory helps preserve *what happened*. PD focuses on turning behavioral
evidence and owner feedback into explicit, reviewable guidance for *how the
agent should behave next time*. PD does keep local records — but remembering
history is the input; governing future behavior is the point. Every step of
that governance stays reviewable and reversible.

## Installation

### Recommended — install from ClawHub

```bash
openclaw plugins install clawhub:principles-disciple
```

Then restart your OpenClaw gateway so the plugin loads.

### Manual / npm installation

```bash
npm install principles-disciple
```

Requires OpenClaw `>=2026.4.4` as a peer dependency.

## Quick start

1. Run `/pd-init` to initialize the PD workspace files.
2. Work with your agent as usual — correct it as usual.
3. Run `/pd-samples` to see captured correction samples and review them
   (`review approve|reject <sample-id>`).
4. Run `/pd-context` to control what gets injected into agent context.
5. Run `/pd-status` for a single view of the system state.

## Commands

All commands support **short aliases** for easier input:

| Short | Full Command | Description |
|-------|--------------|-------------|
| `/pdi` | `/pd-init` | Initialize workspace (generate PRINCIPLES.md, THINKING_OS.md, etc.) |
| `/pdb` | `/pd-bootstrap` | Scan environment tools and suggest upgrades |
| `/pdr` | `/pd-research` | Research tool upgrade solutions |
| `/pdt` | `/pd-thinking` | Manage Thinking OS [status\|propose\|audit] (off by default) |
| `/pdh` | `/pd-help` | Show all commands and usage guide |

| Command | Description |
|---------|-------------|
| `/pd-status` | View system status (GFI, Pain dictionary) |
| `/pd-pain` | Report pain from the current OpenClaw session |
| `/pd-samples` | List or review correction samples (`review approve\|reject <sample-id> [note]`) |
| `/pd-context` | Control context injection [status\|thinking\|reflection\|focus\|preset] |
| `/pd-focus` | Manage CURRENT_FOCUS.md [status\|history\|compress\|rollback] |
| `/pd-evolution-status` | Show evolution loop status (candidate/probation/active) |
| `/pd-principle-rollback` | Roll back a principle and blacklist its pattern |
| `/pd-rollback` | Roll back an empathy event penalty (`<event-id>\|last`) |
| `/pd-export` | Export data [analytics\|corrections --redacted] |
| `/pd-workflow-debug` | Debug workflow state and events |

Advanced implementation lifecycle commands (`/pd-promote-impl`,
`/pd-disable-impl`, `/pd-archive-impl`, `/pd-rollback-impl`) are semi-deprecated
and kept for compatibility.

### Configuration

The plugin accepts the following configuration options:

| Option | Default | Description |
|--------|---------|-------------|
| `language` | `zh` | Interaction language (`en` or `zh`) |
| `auditLevel` | `medium` | Security guardrail level (`low`, `medium`, `high`) |
| `riskPaths` | `[]` | High-risk directories requiring explicit authorization |

## Advanced concepts

- **Pain** — PD's technical name for incoming behavior evidence: a user
  correction, tool failure, or blocked risky operation.
- **Trajectory** — the locally recorded stream of agent behavior and events.
- **Reflection** — generating principle proposals from evidence; output is
  always owner-reviewed.
- **Evolution loop** — the candidate → probation → active lifecycle of
  behavioral implementations (see `/pd-evolution-status`).
- **RuleHost / `code_tool_hook`** — hook-based enforcement channel for
  approved principles.
- **Context injection** — feeding approved principles into the agent's
  context (see `/pd-context`).
- **Thinking OS** — optional thinking-model management, off by default
  (`/pd-thinking`, enable via `/pd-context thinking on`).

For the full architecture, runtime adapters (OpenClaw, Codex), and product
boundary, see the project documentation linked below.

## Part of the principles monorepo

See the root [README.md](https://github.com/csuzngjh/principles#readme) for
the full project overview, and
[PRODUCT_IDENTITY.md](https://github.com/csuzngjh/principles/blob/main/docs/product/PRODUCT_IDENTITY.md)
for the canonical product definition.

## License

MIT License - [LICENSE](https://github.com/csuzngjh/principles/blob/main/LICENSE)
