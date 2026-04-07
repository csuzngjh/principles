<p align="center">
  <img src="assets/banner.png" width="100%" alt="Principles Disciple Banner">
</p>

<h1 align="center">Principles Disciple</h1>

<p align="center">
  <strong>Transform Your AI Agent From Tool to Teammate</strong>
</p>

<p align="center">
  <a href="https://github.com/nicepkg/openclaw">
    <img src="https://img.shields.io/badge/OpenClaw-Native%20Plugin-FF6B35" alt="OpenClaw Plugin">
  </a>
  <img src="https://img.shields.io/github/v/release/csuzngjh/principles?style=flat-square&color=5865F2" alt="Release">
  <img src="https://img.shields.io/npm/dt/principles-disciple?style=flat-square&color=green" alt="Downloads">
</p>

---

**Principles Disciple** is an evolutionary agent framework that turns AI assistants from simple task-executors into self-improving teammates.

**For Humans:** Your AI learns from mistakes, accumulates wisdom, and gets better with every task.
**For Agents:** Stop repeating the same errors. Grow stronger through real-world experience.

[English](README.md) | [中文](README_ZH.md)

> [!NOTE]
> **How It Works**
> 1. **Capture Pain** — Every error becomes a data point
> 2. **Extract Principles** — System distills failures into reusable wisdom
> 3. **Apply & Grow** — Agent uses new principles to avoid repeating mistakes
>
> Growth takes 3-5 days of real-world use. Be patient — like muscle, wisdom builds through resistance.

---

## 🚀 Quick Start

**Requires:** Node.js ≥ 18 | Works on macOS, Linux, Windows

```bash
# Install (one command)
npx create-principles-disciple

# Restart OpenClaw Gateway
openclaw gateway --force

# Initialize your project's strategy
/init-strategy
```

> [!TIP]
> **For AI Agents:** See [Agent Installation Guide](packages/openclaw-plugin/AGENT_INSTALL_EN.md) for step-by-step instructions on first install and updates.

---

**For AI Agents (Non-interactive):**
```bash
# One-line install with defaults
npx create-principles-disciple --yes

# With custom options
npx create-principles-disciple \
  --yes \
  --lang en \
  --workspace /path/to/workspace \
  --features evolution,trust,pain,reflection
```

**What You Get:**
- 🧠 **Thinking OS** — 10 mental models injected into your agent
- 🛡️ **Guardrails** — Automatic protection for critical files
- 📊 **Evolution Points** — Gamified growth system
- 🎯 **OKR Management** — Align AI with your long-term goals

---

## 💡 What It Does For You

### 🛡️ **Auto-Guardrails**
Prevents accidental damage to critical files. The agent needs a `PLAN.md` (set to `STATUS: READY`) before modifying protected paths.

**When blocked:** Update your plan → Set status to `READY` → Retry

### 🧠 **Thinking OS**
10 mental models (T-01 through T-10) injected into every conversation:
- **T-01**: Map Before Territory
- **T-03**: Evidence Over Intuition
- **T-04**: Reversibility Governs Speed
- **T-07**: Minimum Viable Change
- **T-08**: Pain as Signal
- [+ 5 more models]

**Usage:** `/thinking-os status` | `/thinking-os propose "new model"`

### 📈 **Evolution Points (EP)**
Gamified growth system. Start at 0 points, unlock capabilities as you succeed:

| Level | Points | Unlocks |
|-------|--------|---------|
| Seed | 0 | Basic ops, 20-line limit |
| Sprout | 50 | 2 files, 50 lines |
| Sapling | 200 | Sub-agents, 200 lines |
| Tree | 500 | Risk paths, 500 lines |
| Forest | 1000 | Unlimited access |

**Key Feature:** Success after failure = 2x reward (1-hour cooldown)

### 🎯 **OKR Alignment**
Make your AI work toward long-term goals, not just quick fixes:
- `/init-strategy` — Define your vision and strategy
- `/manage-okr` — Set and track Key Results
- `/report` — Get executive summaries

### 🔧 **Human Controls**
Stay in the driver's seat:
- `/bootstrap-tools` — Upgrade your CLI toolkit automatically
- `/pain "description"` — Manually flag issues for reflection
- `/profile "Domain: Expert"` — Adjust AI behavior to your level
- `/inject-rule "temporary rule"` — Add course corrections

---

## 🖥️ Principles Console (Web UI)

> *Visual dashboard for monitoring and managing your AI agent.*

Principles Console is a built-in web interface that provides graphical system monitoring and management.

### Access

```bash
# After starting OpenClaw Gateway, open in browser:
http://localhost:18789/plugins/principles/
```

### Features

| Page | What It Shows |
|------|---------------|
| **Overview** | Workspace health, daily trends, regression alerts, thinking model coverage |
| **Evolution** | Evolution task tracking: pain → principle generation timeline |
| **Samples** | Correction sample queue: view, filter, approve/reject samples |
| **Thinking Models** | Usage stats: trigger frequency, scenario analysis, health audit |

### Multi-Workspace Support

Principles Console aggregates data from **all agent workspaces** into a central database:

- **10 workspaces** supported out of the box (builder, diagnostician, explorer, hr, main, pm, repair, research, resource-scout, verification)
- **Workspace Configuration** — Enable/disable workspaces, control sync settings
- **Custom Workspaces** — Add arbitrary workspace paths for monitoring

### Use Cases

- **Visual Monitoring** — See AI health and evolution at a glance
- **Batch Review** — Process multiple user correction samples at once
- **Trend Analysis** — Track tool calls, failure rates, corrections over 7 days
- **Thinking Traces** — Understand which mental models your AI is using
- **Evolution Tracking** — Watch the full pipeline from pain detection to principle generation

### Architecture

```
Browser ←→ OpenClaw Gateway ←→ Plugin HTTP Routes ←→ Central Database
                                                      ↓
                              ┌───────────────────────┴───────────────────────┐
                              ↓                                               ↓
                        SQLite (workspace-1)                            SQLite (workspace-N)
```

- **Self-Contained** — No separate deployment needed
- **Local Data** — All data stored in local SQLite, never leaves your machine
- **Central Aggregation** — Unified view across multiple workspaces
- **Real-time** — Fresh data on every page refresh

---

## 🔬 Deep Reflection

Before complex tasks, the agent automatically analyzes:
- Blind spots and missing information
- Potential risks and failure modes
- Alternative approaches with trade-offs

Uses T-01 through T-10 mental models for structured thinking.

**Configure in** `{stateDir}/pain_settings.json`:
```json
{
  "deep_reflection": {
    "enabled": true,
    "mode": "auto",
    "default_model": "T-01",
    "default_depth": 2
  }
}
```

---

## 🗺️ Roadmap

| Phase | Status | Focus |
|-------|--------|-------|
| **Cognitive Depth** | ✅ Done | Thinking OS, Deep Reflection |
| **Growth System** | ✅ Done | Evolution Points, Gamification |
| **Meta-Learning** | 🔜 Next | Agent learns *how to learn* |
| **Co-Evolution** | 📋 Planned | Human + AI grow together |
| **Emotional System** | 💡 Vision | Beyond logic — genuine partnership |

---

## 🔌 Under the Hood

**Lifecycle Hooks:**
- `before_prompt_build` — Injects Thinking OS, OKR focus, pain signals
- `before_tool_call` — Gatekeeper checks plan before risky writes
- `after_tool_call` — Auto-detects failures, writes pain flags
- `subagent_spawning` — Ensures sub-agents inherit mental models
- `before_compaction` — Checkpoints state before context loss

**Background Services:**
- Evolution Worker — Scans pain signals every 90s, queues evolution tasks

**All Slash Commands:**
```
/init-strategy  /manage-okr     /bootstrap-tools  /research-tools
/thinking-os    /evolve-task    /pd-daily         /pd-status
/pd-samples     /pd-export      /pd-rollback      /pd-help
/pain           /profile        /inject-rule      /admin
```

**Documentation:** [Full Command Reference](docs/COMMANDS.md) | [Architecture Guide](docs/ARCHITECTURE.md)

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
