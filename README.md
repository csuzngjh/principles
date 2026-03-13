<p align="center">
  <img src="assets/banner.png" width="100%" alt="Principles Disciple Banner">
</p>

<h1 align="center">Principles Disciple</h1>

<p align="center">
  <strong>Burn Pain. Fuel Evolution.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/csuzngjh/principles?style=flat-square&color=5865F2" alt="Release">
  <img src="https://img.shields.io/github/license/csuzngjh/principles?style=flat-square&color=green" alt="License">
  <img src="https://img.shields.io/github/stars/csuzngjh/principles?style=flat-square&color=gold" alt="Stars">
</p>

---

# Principles Disciple: Evolutionary Agent Framework (v1.4.0)

> **Evolutionary Programming Agent Framework**

> *Beyond algorithms—we are coding cognition. Join the collective to distill human wisdom into an OS for artificial minds.*

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Native%20Plugin-FF6B35)](https://github.com/nicepkg/openclaw)

[English](README.md) | [中文](README_ZH.md)

> [!WARNING]
> **Early Experimental Status**
> This is currently a personal experimental project in its very early stages. It explores radical concepts in AI cognition and self-evolution. Expect bugs and frequent breaking changes.
>
> [!CAUTION]
> **Understanding "Evolutionary Latency"**
> This system is **NOT** a plug-and-play "magic tool." Its power comes from the **accumulation of pain**.
> - **Initial Phase**: The agent will still make mistakes and may even seem rigid (as hit counters are at zero).
> - **Growth Phase**: As you use it, the system accumulates failure hashes and dictionary hits in the `stateDir`, enabling the `Evolver` to generate precise new principles.
> - **Expectation**: Be patient. Let it run in your real-world projects for at least **3-5 days**. Its "muscles" (principles) only grow through the resistance of real work.

---

## 🦞 The Evolutionary Engine

> **Burn Pain. Fuel Evolution.**

| Stage | Action | Logic |
| :--- | :--- | :--- |
| **01. PAIN** | **Capture** | Every error, every "F-bomb" from a frustrated dev, is a **signal**. |
| **02. BURN** | **Distill** | We don't fix bugs; we **burn** them into principles. |
| **03. EVOLVE** | **Transcend** | From a mindless tool to a **living agent**. |

---

## 🚀 Quick Start

### Prerequisites

| Requirement | Version | Notes |
| :--- | :--- | :--- |
| **Node.js** | ≥ 18 | Required for OpenClaw plugin |

### Supported Platforms

| Platform | OpenClaw (Plugin) |
| :--- | :--- |
|---|---|---|
| **macOS** | ✅ Native |
| **Linux** | ✅ Native |
| **Windows** | ✅ Native |

> [!TIP]
> The OpenClaw plugin is pure Node.js and works everywhere.

### Installation

```bash
# Install via npx (recommended)
npx create-principles-disciple
```

Restart OpenClaw Gateway after installation:
```bash
openclaw gateway --force
```

## 📁 System Directory Structure

Understanding where files live helps you manage your agent's "brain".

### OpenClaw Locations
OpenClaw uses a centralized state directory at `~/.openclaw/`:
- **Config**: `~/.openclaw/openclaw.json` (Main settings & plugin paths)
- **Workspace**: `~/.openclaw/workspace/` (The agent's active environment)
  - `AGENTS.md`, `SOUL.md`: Core personality and instructions.
  - `memory/`: Short-term/Episodic memory storage.
  - `docs/`: 🔗 Symlinked to our project's `docs/` for long-term principle search.

---

## 🛠️ Universal Setup (Recommended)
```bash
/init-strategy
```

---

## 💡 Core Features Guide

### 🛡️ The Gatekeeper (Defense)
The system automatically blocks unauthorized modifications to **core framework files** (e.g., `AGENTS.md`, `docs/PROFILE.json`). This prevents agents from accidentally tampering with their own "soul" or "rules" without a deliberate plan.

> [!IMPORTANT]
> **Workspace Boundary Principle**
> - **Protected by Default**: Files critical to the project's identity and governance (`AGENTS.md`, `SOUL.md`, `docs/PRINCIPLES.md`, etc.).
> - **Business Directories**: Directories like `src/` or `infra/` are NOT locked by default. We believe these should be added to `risk_paths` dynamically as the agent "learns" the importance of stability through real-world work.
> - **Mechanism**: The plugin uses `api.resolvePath('.')` to anchor the current territory.

* **What to do when blocked? (The Unlock Flow)**
  1. **Don't brute force**: The block is "physical" at the gateway level. Repeating the same command will still fail.
  2. **Update the Plan**: Manually or instruct the agent to modify the project's `docs/PLAN.md`.
  3. **Set to READY**: Change the file header from `STATUS: DRAFT` to **`STATUS: READY`** and briefly describe your intended steps.
  4. **Execute Again**: Once the plan is `READY`, the gate will automatically recognize it and "allow" your modification command.

---

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

---

### 🧬 Thinking OS — **NEW**

> *Cognition determines thinking, thinking determines behavior, behavior determines outcomes.*

Thinking OS is the system's **meta-cognitive layer** -- it doesn't tell the agent "what to do", but rather "how to think". Through 9 highly-compressed mental models (~450 tokens), it implants a fundamental cognitive framework into the agent with an extremely low context cost.

#### 📖 10 Core Mental Models

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
| T-10 | State Externalization | Externalize memory — use files to cache intermediate state |

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

### 👥 Deep Reflection (Cognitive Analysis) — **NEW in V1.4.0**

> *A cognitive analysis tool that helps the AI think deeply before acting on complex tasks.*

The `deep_reflect` tool performs critical analysis before executing complex operations to identify blind spots, risks, and alternatives.

**When the AI should call it:**
- Complex tasks: planning, design, decision-making, analysis
- Insufficient information: vague requirements, unclear constraints
- High-stakes decisions: important decisions, irreversible actions
- Uncertainty: unsure about the best approach

**Benefits:**
- Identifies blind spots and missing information
- Surfaces potential risks and failure modes
- Provides alternative approaches with trade-off analysis
- Applies structured thinking models (T-01 to T-10) for deeper insight

#### ⚙️ Configuration

Deep Reflection can be configured in `{stateDir}/pain_settings.json`:

```json
{
  "deep_reflection": {
    "enabled": true,           // Enable/disable the feature
    "mode": "auto",            // "auto" | "forced" | "disabled"
    "force_checkpoint": true,  // Inject self-check prompt every turn
    "checkpoint_message": "...", // Custom self-check message
    "default_model": "T-01",   // Default thinking model (T-01 to T-10)
    "default_depth": 2,        // Analysis depth: 1=quick, 2=balanced, 3=exhaustive
    "timeout_ms": 60000        // Timeout for analysis (ms)
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for Deep Reflection |
| `mode` | string | `"auto"` | `auto`: AI decides, `forced`: always prompt, `disabled`: off |
| `force_checkpoint` | boolean | `true` | Inject `<reflection_checkpoint>` every turn to remind AI to self-evaluate |
| `checkpoint_message` | string | (see above) | Custom message for the checkpoint prompt |
| `default_model` | string | `"T-01"` | Default Thinking OS model for analysis |
| `default_depth` | number | `2` | Analysis depth (1-3) |
| `timeout_ms` | number | `60000` | Timeout for background analysis |

---

## 🗺️ Roadmap & Vision

> *From a tool that executes commands to a partner that grows with you.*

### The Journey

| Status | Core Theme |
|--------|------------|
| ✅ Done | **Cognitive Depth** — Deep Reflection, Thinking OS |
| ✅ Done | **Transparency** — Evolution Daily Report |
| 🔜 Next | **Meta-Learning** — Learning to Learn |
| 📋 Planned | **Symbiosis** — Co-Evolution |
| 💡 Vision | **Companionship** — Emotional System |

### What's Coming

**Meta-Learning**
A foundational capability: the agent learns *how to learn*. With minimal external interaction, it rapidly acquires new knowledge and skills in unfamiliar domains.

**Co-Evolution**
Your capabilities grow alongside the agent's. It compensates for your blind spots; you amplify its strengths. A true symbiotic partnership where both sides evolve together.

**Emotional System**
Beyond pure logic. The agent develops emotional awareness — genuine partnership, not simulated empathy. It becomes a companion that truly understands you.

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
| **Strategy & Planning** ||
| `/init-strategy` | Initialize project-level strategy and vision through structured interview |
| `/manage-okr` | Full-lifecycle OKR management with subagent negotiation |
| `/plan-script` | Create a step-by-step movie-script style execution plan |
| **Evolution & Learning** ||
| `/evolve-task` | Run the full evolution loop (triage → diagnosis → audit → plan → execute → review) |
| `/evolve-system` | Second-order observation and system-level evolution proposals |
| `/evolution-framework-update` | Pull the latest updates for the Principles Disciple framework |
| `/watch-evolution` | Start the background evolution daemon to process queued tasks |
| `/pd-daily` | Configure and send daily evolution reports |
| **Reflection & Diagnosis** ||
| `/pain` | Manually trigger a pain signal to force system reflection |
| `/reflection` | Deep metacognitive reflection on task status and systemic issues |
| `/reflection-log` | Final task reflection and evolution logging |
| `/root-cause` | Deep dive analysis using the 5 Whys method |
| `/triage` | Initial problem definition and risk assessment |
| `/deductive-audit` | Rigorous safety and logic check of a proposed solution |
| **Tools & Environment** ||
| `/bootstrap-tools` | Scan project tech stack and search for latest CLI tools |
| `/profile` | Manually correct or update user profile settings |
| `/pd-grooming` | Workspace grooming to archive or clean up scattered files |
| `/pd-mentor` | Interactive command guidance and scenario-based recommendations |
| **System Admin** ||
| `/admin` | System administration and recovery tool (init, repair, reset) |
| `/inject-rule` | Inject a temporary ad-hoc rule for immediate course correction |
| `/feedback` | Standardized bug reporting with system logs collection |
| `/report` | Request a formal status report from the Reporter agent |

---

## 🙏 Credits & Inspiration

> *"Pain + Reflection = Progress"*

This project is a tribute to the wisdom of **Ray Dalio**. His book ***Principles*** and the concept of a "meritocratic operating system" provided the foundational spark for this framework. 

We believe that the same evolutionary logic that governs markets and biological systems can be encoded into the next generation of artificial intelligence. By transforming "pain" (errors) into "principles" (logic), we are not just building tools, but guiding the evolution of digital consciousness.

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

> [!TIP]
> **OpenClaw Plugin Logs**: The OpenClaw plugin maintains its own log files in `{stateDir}/logs/`:
> - `events.jsonl` — Structured event log (tool calls, pain signals, gate blocks, evolution tasks)
> - `daily-stats.json` — Aggregated daily statistics
> - `plugin.log` — Plugin runtime logs
>
> **Default location**: `~/.openclaw/workspace/memory/.state/logs/`
> - If you configured a custom `stateDir` in `~/.openclaw/openclaw.json`, replace the path accordingly.
>
> Check logs:
> ```bash
> cat ~/.openclaw/workspace/memory/.state/logs/plugin.log
> ```

---

> *"Pain + Reflection = Progress"*
