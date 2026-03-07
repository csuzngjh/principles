# Principles Disciple

> **Evolutionary Programming Agent Framework**
> *Beyond algorithms—we are coding cognition. Join the collective to distill human wisdom into an OS for artificial minds.*
> Inspired by Ray Dalio's *Principles*.

[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-5865F2)](https://code.claude.com)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Native%20Plugin-FF6B35)](https://github.com/nicepkg/openclaw)

[English](README.md) | [中文](README_ZH.md)

> [!WARNING]
> **Early Experimental Status**
> This is currently a personal experimental project in its very early stages. It explores radical concepts in AI cognition and self-evolution. Expect bugs, rough edges, and frequent breaking changes. We highly encourage you to test it, break it, and join us in improving it together!

Principles Disciple is a **cross-platform evolutionary agent framework** that supports both **Claude Code** and **OpenClaw**. It transforms your AI assistant into a digital lifeform capable of **self-defense, self-reflection, and self-evolution**. Through Gatekeeping, Profiling, OKRs, and Pain signals, it prevents the AI from blindly executing harmful prompts and learns from every failure.

### Supported Platforms

| Platform | Installation | Features |
|---|---|---|
| **Claude Code** | `install.sh` scaffold | Driven by Rules + Hooks (Shell) |
| **OpenClaw** | Native Plugin (`packages/openclaw-plugin`) | Leverages Plugin SDK full-lifecycle hooks |

---

## 🚀 Quick Start

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | ≥ 18 | Required for OpenClaw plugin |
| **Python 3** | ≥ 3.8 | Required for Claude Code hooks |
| **Bash** | any | macOS/Linux native; Windows via **Git Bash** or **WSL** |

### Supported Platforms

| Platform | Claude Code (`install.sh`) | OpenClaw (Plugin) |
|---|---|---|
| **macOS** | ✅ Native | ✅ Native |
| **Linux** | ✅ Native | ✅ Native |
| **Windows (WSL)** | ✅ Recommended | ✅ Native |
| **Windows (Git Bash)** | ✅ Works | ✅ Native |
| **Windows (PowerShell)** | ❌ Use WSL/Git Bash | ✅ Native |

> [!TIP]
> **Windows users**: `install.sh` is a Bash script. Run it in **Git Bash** (bundled with [Git for Windows](https://git-scm.com/download/win)) or **WSL**. The OpenClaw plugin is pure Node.js and works everywhere.

### Method A: Claude Code

```bash
# 1. Install to target project
bash install.sh /path/to/your/project

# 2. Initialize core files (inside Claude Code)
/admin init
```
*`install.sh` merges smartly: it keeps your existing custom rules, and system updates are saved as `*.update` files.*

### Method B: OpenClaw

```bash
# 1. Build the plugin
cd packages/openclaw-plugin
npm install && npm run build

# 2. Register the plugin in ~/.openclaw/openclaw.json
# Add to the "plugins" section:
# { "load": { "paths": ["/absolute/path/to/packages/openclaw-plugin"] } }
```
> Once enabled, the plugin automatically takes over: Prompt injection, Gatekeeper interception, Pain signals, Context compression protection, and Thinking OS cognitive injection.

> [!NOTE]
> **Memory integration**: To let OpenClaw's search engine index `docs/` (where PLAN, OKR, and Principles live), add to `~/.openclaw/openclaw.json`:
> ```json
> { "agents": { "defaults": { "memorySearch": { "extraPaths": ["docs"] } } } }
> ```

> [!TIP]
> **One-command install**: If OpenClaw is already installed, simply run:
> ```bash
> bash install.sh /path/to/your/project
> ```
> The script auto-detects OpenClaw, builds the plugin, and injects both `plugins.load.paths` and `memorySearch.extraPaths` into `~/.openclaw/openclaw.json`.

### Universal: Set Strategy (Recommended)
```bash
/init-strategy
```

---

## 💡 Core Features Guide

### 🛡️ The Gatekeeper
You don't need to do anything. The system automatically blocks unauthorized modifications to **high-risk directories** (e.g., `src/db/`).
* **What to do when blocked?**
  - The AI will automatically prompt you to draft a plan first.
  - Simply agree to let it run `/evolve-task`.

### 🧠 Reflection Loop (Pain Loop)
When a task stagnates or throws too many errors, the system triggers a **Red Alert** before context compression.
* **What to do when you see `🛑 URGENT`?**
  - Run `/reflection-log`. The AI will automatically review and generate new principles to prevent the same mistake.

### 🧬 Meta-Evolution
The system has the ability to "rewrite its own code," but is strictly caged.
* **`/evolve-system`**: Starts the "Digital Architect." It analyzes Agent win rates and error logs, and if it finds the system inefficient, it will propose changing Prompts or Hook logic.
  - *Note*: All modifications MUST be explicitly approved by you.

### 🎯 Strategy Management (OKR)
Make the AI move towards your long-term goals instead of just fixing bugs.
* **`/init-strategy`**: Deep interview to establish vision and strategy.
* **`/manage-okr`**: Automatically interviews sub-agents to negotiate and set specific Key Results.

### 📊 Executive Reporting
Reject cognitive overload; let the "Secretary" summarize for you.
* **`/report`**: Get a customized progress report anytime based on your profile (Beginner/Expert).
* **Auto-Reporting**: When a task ends, the secretary automatically steps in to summarize.

### 🎮 Human Console
When the AI veers off track, you are the pilot with the highest authority.
* **`/bootstrap-tools`**: **[Highly Recommended]** Automatically scans the tech stack and searches the web for the latest CLI artifacts (e.g., `ripgrep`, `ast-grep`) to arm your agent team.
* **`/pain "Stop trying"`**: Manually trigger a pain signal to make the AI pause and reflect.
* **`/profile "Frontend: Expert"`**: Tell the AI you are an expert to reduce verbosity and increase adherence.
* **`/inject-rule "No Python"`**: Immediately inject a temporary rule.
* **`/admin repair`**: System files corrupted? One-click repair.

### ⚡ Parallel Mode
Leverage Claude Code's `Tasks` feature to "play two roles."

1. **Set Task ID**:
   ```bash
   export CLAUDE_CODE_TASK_LIST_ID=my-feature
   ```
2. **Open Main Window**: Run `claude`, responsible for writing code.
3. **Open Sub Window**: Set the same ID and run `claude`, responsible for Review or writing tests.
4. **Effect**: Both windows share the task status and sync in real-time!

---

### 🧬 Thinking OS — **NEW**

> *Cognition determines thinking, thinking determines behavior, behavior determines outcomes.*

Thinking OS is the system's **meta-cognitive layer** -- it doesn't tell the agent "what to do", but rather "how to think". Through 9 highly-compressed mental models (~450 tokens), it implants a fundamental cognitive framework into the agent with an extremely low context cost.

#### 📖 9 Core Mental Models

| ID | Name | Core Philosophy |
|---|---|---|
| T-01 | Map Before Territory | Build a mental map before modifying |
| T-02 | Constraints as Lighthouses | Actively search for constraints as navigation signals |
| T-03 | Evidence Over Intuition | Gather evidence first when uncertain |
| T-04 | Reversibility Governs Speed | Reversible -> fast; Irreversible -> slow & confirm |
| T-05 | Via Negativa | Eliminate disasters first, then pursue optimum |
| T-06 | Occam's Razor | Simplest solution first |
| T-07 | Minimum Viable Change | Make minimal changes to reduce blast radius |
| T-08 | Pain as Signal | Errors/stucks are signals for correction |
| T-09 | Divide and Conquer | Complex tasks must be broken down |

#### 🎛️ Governance Commands

```bash
# View usage frequencies of mental models
/thinking-os status

# Propose a new mental model (enters candidate pool, requires human approval)
/thinking-os propose "Description of the new model"

# Audit model freshness (discover ignored or over-triggered models)
/thinking-os audit
```

#### 📁 Related Files
- `docs/THINKING_OS.md` — Active mental models (Loaded automatically per turn)
- `docs/THINKING_OS_CANDIDATES.md` — Candidate pool (Agents can propose, Humans approve)
- `docs/THINKING_OS_ARCHIVE.md` — Archived/Eliminated models

#### ⚡ Technical Highlights
- **Provider Caching**: Thinking OS is injected via OpenClaw's `prependSystemContext`. After the first turn, it's cached by the Provider, costing **nearly zero tokens** for subsequent turns.
- **Usage Tracking**: The system tracks how often each model is used (bilingual EN/CN signal detection) and stores data in `.thinking_os_usage.json`.
- **Sub-agent Propagation**: All sub-agents spawned by the main Agent inherit the same mental models.

---

### 🔌 OpenClaw Plugin Architecture

For OpenClaw users, this framework is deeply integrated via the native Plugin SDK, providing:

#### Lifecycle Hooks

| Hook | Function |
|---|---|
| `before_prompt_build` | Injects Thinking OS (`prependSystemContext`, cacheable) + Pain Signals + OKR Focus |
| `before_tool_call` | Gatekeeper: checks Plan + Audit verification before high-risk path writes |
| `after_tool_call` | Pain Detection: automatically scores and writes `.pain_flag` on tool failures |
| `llm_output` | Cognitive Tracking: detects if the AI follows Thinking OS models + pain text analysis |
| `before_compaction` | Compression Guard: automatically checkpoints key states before context compression |
| `before_reset` | Reset Guard: saves current progress before Session clearance |
| `subagent_spawning` | Cognitive Propagation: ensures sub-agents inherit Thinking OS |
| `subagent_ended` | Failure Tracking: generates pain signals when sub-agents end abnormally |

#### Background Services

* **Evolution Worker** (`EvolutionWorkerService`): A persistent background service that scans `.pain_flag` every 90s, queues high-score pain signals into `evolution_queue.json`, and dispatches diagnostic commands to the main agent during the next heartbeat via `evolution_directive.json`.

#### Slash Command Reference

| Command | Description |
|---|---|
| `/init-strategy` | Initialize OKR strategy |
| `/manage-okr` | Manage project OKR |
| `/evolve-task <desc>` | Trigger evolution task (Delegate to diagnostician) |
| `/bootstrap-tools` | Scan and upgrade environment tools |
| `/research-tools <query>` | Search the web for cutting-edge CLI tools |
| `/thinking-os [status\|propose\|audit]` | Govern the Thinking OS |

---

## 🔍 Troubleshooting & Feedback

### How do I know if the system is working?
Run the health check command:
```bash
/system-status
```
It displays the Hook runtime status, error rate, and current risk path configurations.

### FAQ
* **Q: Why does the AI refuse to modify files?**
  * A: Check `risk_paths` in `docs/PROFILE.json`. Risk paths require a `docs/PLAN.md` first.
* **Q: The AI seems dumb and won't follow my instructions?**
  * A: Check `docs/USER_CONTEXT.md`. The system might have labeled you as a "Beginner". Run `/profile "Domain: Expert"` to correct it.

### Reporting Bugs
If you encounter plugin errors (e.g., Hook crashes), please check the system logs:
```bash
cat docs/SYSTEM.log
```
Submit the log contents to the developers.

---

> *"Pain + Reflection = Progress"*
