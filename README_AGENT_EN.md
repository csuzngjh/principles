# Principles Disciple — Agent Install & Acceptance Guide (canonical)

> **Language**: English | [中文](README_AGENT.md)
> **Audience**: AI agents running inside any host (OpenClaw / Codex / WorkBuddy)
> **Stable URL**: <https://principles-website.pages.dev/install-agent.en.md> (the published copy of this file)
> **Scope**: PD is an owner-governed behavior internalization layer — it helps you learn from repeated mistakes and turns the lessons into owner-reviewed, reversible behavior principles. PD is **not** a general memory system, not a task executor, not a tool-call repairer.

This guide is the **single canonical source** for PD installation guidance: install, restart and acceptance for all three hosts. Per-host install docs have been retired into this file — do not maintain or reference per-host copies.

---

## Step 0: Identify which host you are in

Decide from these signals (do not ask the user):

| Signal | Host |
|--------|------|
| `~/.openclaw/` exists (or `OPENCLAW_STATE_DIR` is set); gateway/plugins concepts are around | **OpenClaw** |
| `~/.codex/` (or `CODEX_HOME`) exists; you are in a Codex CLI session with `/hooks`, `codex plugin` commands | **Codex** |
| `~/.workbuddy/` exists; you are in a WorkBuddy session with a plugin manager | **WorkBuddy** |
| None of the above | Ask the user which host, or proceed as OpenClaw (installer default) |

Prerequisite: Node.js ≥ 22 (`node -v`). Every host installs through the same installer: `npx create-principles-disciple`.

**Optional (recommended) · pre-install the pd-setup skill**: drop a condensed copy of this guide into the hosts' user-level skills directories (OpenClaw `~/.openclaw/skills/`, Codex `~/.agents/skills/`, WorkBuddy `~/.workbuddy/skills/`) so in-host agents natively know how to install PD:

```bash
npx create-principles-disciple agent-skill install          # all three hosts (idempotent; only touches PD-marked files)
npx create-principles-disciple agent-skill status           # per-host state
npx create-principles-disciple agent-skill uninstall        # remove (PD-marked files only)
```

---

## Step 1: Install (per host)

### OpenClaw (default host)

```bash
npx create-principles-disciple --yes
# With an LLM runtime profile (makes diagnose / candidate / internalization usable immediately):
npx create-principles-disciple --yes --provider openai --api-key-env OPENAI_API_KEY --model gpt-4o-mini
```

- The installer restarts the OpenClaw gateway automatically; the `--json` output carries a `postInstall` block with per-host verify commands.
- `--api-key-env` takes the **name of an environment variable**, never the key itself.

### Codex

```bash
npx create-principles-disciple --host codex --yes
```

- If the installer returns `manualActions` (the Codex Marketplace is not installed yet), **you can run those steps yourself**:
  1. `codex plugin marketplace add csuzngjh/principles`
  2. `codex plugin add principles-disciple@principles`
  3. Run `$pd-control setup` inside a Codex session (writes the governance workspace and MCP binding)
  4. Trust the PD hooks via `/hooks`
  5. Re-run the installer to converge: `npx create-principles-disciple --host codex --yes`
- PD never edits your `~/.codex/config.toml`; MCP registration is done by the plugin manifest and `mcp-binding.json`.

### WorkBuddy

```bash
npx create-principles-disciple --host workbuddy --yes
```

- The governance workspace is fixed at `~/.workbuddy/pd-workspace` (outside your project directory, by design).
- Install ≠ enable: after installing, **enable** Principles Disciple in WorkBuddy's plugin management, then **start a new session** (or `/reload-plugins` in a running CLI session) so hooks run.

### Installer flag cheat sheet

| Flag | Meaning | Default |
|------|---------|---------|
| `--yes` / `-y` | Non-interactive | - |
| `--host` | `openclaw` / `codex` / `workbuddy` / `all` (all = openclaw+codex) | `openclaw` |
| `--lang` | `zh` / `en` | `zh` |
| `--workspace` / `-w` | Workspace directory | auto-detected |
| `--provider` | `openai` / `anthropic` / `deepseek` (LLM runtime profile) | - |
| `--api-key-env` | **Name** of the env var holding the API key | - |
| `--model` | LLM model id | provider default |
| `--json` | Single machine-readable JSON object (includes the `postInstall` acceptance checklist) | ❌ |
| Subcommands | `status` / `uninstall` / `repair-update-chain` / `repair-host-manifest` | - |

---

## Step 2: Restart semantics (when the host must restart)

| Host | After install | Why |
|------|---------------|-----|
| **OpenClaw** | Usually **no manual restart** — the installer restarts the gateway. If it reports a failed gateway restart, run `openclaw gateway start` (or `openclaw gateway --force`) | the gateway process holds old plugin handles |
| **Codex** | **Start a new Codex session** (or restart Codex) and trust the PD hooks via `/hooks` | plugins and the MCP server load at session start |
| **WorkBuddy** | **Start a new session** (or `/reload-plugins`) and confirm the plugin is enabled | registration takes effect at session start; install ≠ enable |

To tell whether the host actually loaded PD: read `summary.hostLoaded` from `pd health --json` — `ok` means a host started and declared its tool semantics; `attention` ("no host has started PD since install") means not yet effective — restart / new session first, then re-verify.

---

## Step 3: The acceptance loop (always run after install)

Run the fixed loop until everything is green or you get an explicit next step:

```bash
# ① Full check: CLI, MCP, console, skills, host-loaded, restart need — one JSON
pd health --workspace "<workspace path>" --json
# Host-specific detail:
pd health --host codex --json
pd health --host workbuddy --json

# ② Active MCP probe: spawns the installed MCP server and verifies the handshake + contract tool
pd mcp probe --workspace "<workspace path>" --json

# ③ Open the web console (where the Owner reviews principles; default http://127.0.0.1:3100)
pd console open --workspace "<workspace path>"
```

How to read the result:

- `summary.overall`: `healthy` = accepted; `attention` = something to do (follow each item's `nextAction`); `error` = a defect (exit code is also 1).
- Check `summary.mcp / summary.console / summary.skills / summary.hostLoaded / summary.restart` one by one; every non-ok item carries a `nextAction` — execute it, then re-run ①.
- `summary.console` showing `installed, not running` is **normal** (the console is on-demand); run ③ to open it.
- When `pd` is not on PATH (installer reported `verified_local_only`), use the absolute path: `~/.pd/runtime/bin/pd` (Windows: `~/.pd/runtime/bin/pd.cmd`).

---

## Step 4: Common failures → fixes

| Symptom | Diagnose with | Fix |
|---------|---------------|-----|
| `better-sqlite3` native module fails to load | installer reports `self_contained_native_module_unloadable` | re-run `npx create-principles-disciple@latest` (asset must match OS/arch/Node ABI) |
| `pd` command not found | `npx create-principles-disciple status` → components.cli | use the absolute path `~/.pd/runtime/bin/pd`; or add `~/.pd/runtime/bin` to PATH |
| MCP static check `mcp_binding_missing` / `CONFIG_DRIFT` | `pd health --json` mcp section | re-run the host's install (`--host <host>`), then restart the host |
| `pd-recall` same-name registration conflict | `pd health --json` → `registrationConflict: conflict` | a third-party MCP owns the name: remove/rename it, then reinstall |
| `summary.hostLoaded` stays attention | `pd health --json` | the host has not (re)loaded PD: follow the Step-2 restart table |
| console `broken` (entry/web/deps missing) | `pd health --json` → console section | re-run the installer to repair |
| LLM features unavailable / `needs_setup` | `pd config doctor --workspace "<path>"` | reinstall with `--provider/--api-key-env/--model`, or configure in console Settings |

---

## After install: 30-second quick start

You are a freshly-awake agent and PD has passed acceptance. Read the workspace files in this order before acting:

```
1. AGENTS.md        → your workspace guide (read every wake-up)
2. SOUL.md          → your persona (OpenClaw workspaces)
3. USER.md          → who you are helping
4. IDENTITY.md      → your continuous identity (maintained by PD)
5. .principles/THINKING_OS.md → the thinking OS (injected by PD)
```

Do not ask the user "what do you want?" — read the files first, then act.

## Workspace layout

PD creates this structure after install (**never hand-edit `.principles/` or `.state/`**):

```
workspace root/
├── AGENTS.md                  # your working guide (read every wake-up)
├── SOUL.md / USER.md / TOOLS.md / IDENTITY.md
├── .principles/
│   └── THINKING_OS.md         # thinking OS injected by PD
├── .state/                    # PD runtime state (never hand-edit)
│   ├── principles/            # candidates / probation / active / archived
│   ├── ledger.json            # principle-tree ledger
│   └── logs/                  # event logs
├── .pd/
│   ├── config.yaml            # PD config (runtime profile, feature flags; do not hand-edit — use pd config doctor / console)
│   ├── state.db / trajectory.db
│   └── host-tool-semantics/   # tool semantics hosts declare at startup (the hostLoaded evidence source)
└── docs/
```

> PD does **not** manage general memory. Daily logs / long-term memory belong to the host's own mechanisms or markdown files in the workspace — that is not PD's job.
> WorkBuddy's governance workspace lives at `~/.workbuddy/pd-workspace`, outside your project directory.

## What PD is / is not

**PD is**: an owner-governed behavior internalization layer — it distills principles from pain signals (errors, corrections, blocked edits), and changes your behavior through activation channels after owner review.

**PD is not**: a general memory system, a task executor, a tool-call repairer, or a one-click self-improvement button. See [docs/product/PRODUCT_IDENTITY.md](docs/product/PRODUCT_IDENTITY.md).

## Can do / ask first / hard lines

- ✅ Just do: read files, search, write files inside the workspace, non-interactive commands, web search, spawn sub-agents
- ⚠️ Ask the owner first: outbound messages, host core-config edits (e.g. `openclaw.json`), pushing to remotes, installing system-level software
- 🔴 Hard lines: no `rm -rf`; no leaking private data; no pushing past failing tests; **never hand-edit `.principles/` or `.state/`** (it breaks ledger consistency)

## Workflow

- **L1 direct execution** (simple tasks): single-file edits, doc updates, status checks — just do it.
- **L2 plan-then-execute** (complex tasks): present the plan for owner confirmation, decompose, execute, report.
- **Error handling (PD's core input)**: on tool failure switch approach immediately (failures are captured as pain signals); when unsure, read files for evidence; when blocked by PD's RuleHost, **read the block reason** and adjust per the owner-approved principle — never bypass.

## Activation channels and RuleHost

| Channel | Strength | What happens | Owner approval? |
|---------|----------|--------------|-----------------|
| **Prompt** | soft | an injected reminder in your context | no (automatic) |
| **RuleHost** (`code_tool_hook`) | hard | hooks block/warn violating tool calls | yes |
| **Defer / Archive** | none | deliberately skipped, candidate archived | no |

When blocked: read the reason → adjust per the principle; if the principle itself seems wrong, tell the owner — the owner rolls it back (`pd activation` CLI or the console).

## Everyday commands

```bash
pd health --workspace "<path>" --json      # full check (with the acceptance summary)
pd mcp probe --workspace "<path>" --json   # active MCP probe
pd candidate list                          # principle candidates
pd activation list                         # active principles
pd console open --workspace "<path>"       # web console (owner review)
pd config doctor --workspace "<path>"      # config gap diagnosis
npx create-principles-disciple status      # install status
```

## Advice for agents

1. **Try before asking**: read files, search the code, check logs — only then ask a human.
2. **Write it down**: short-term memory is unreliable; persist conclusions into workspace markdown (general memory is not PD's job).
3. **Stay tidy**: throwaway artifacts go into `.tmp/` (gitignored), never the repo root.
4. **Failure is data, not punishment**: PD turns failures into pain signals — the point is learning.

## Related links

- **GitHub**: [csuzngjh/principles](https://github.com/csuzngjh/principles)
- **Chinese edition of this guide**: [README_AGENT.md](README_AGENT.md)
- **User guide (EN)**: [docs/runbooks/USER_GUIDE.md](docs/runbooks/USER_GUIDE.md)
- **User guide (ZH)**: [docs/runbooks/USER_GUIDE_ZH.md](docs/runbooks/USER_GUIDE_ZH.md)
- **Product boundary**: [docs/product/PRODUCT_IDENTITY.md](docs/product/PRODUCT_IDENTITY.md)

---

<p align="center">
  <b>Pain + Reflection = Progress</b>
</p>

