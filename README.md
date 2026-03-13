<p align="center">
  <img src="assets/banner.png" width="100%" alt="Principles Disciple Banner">
</p>

<h1 align="center">Principles Disciple</h1>

<p align="center">
  <strong>Fuel the evolution with pain.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/csuzngjh/principles?style=flat-square&color=5865F2" alt="Release">
  <img src="https://img.shields.io/github/license/csuzngjh/principles?style=flat-square&color=green" alt="License">
  <img src="https://img.shields.io/github/stars/csuzngjh/principles?style=flat-square&color=gold" alt="Stars">
</p>

---

# Principles Disciple: Evolutionary Agent Framework (v1.5.0)

> **Evolutionary Programming Agent Framework**

> *Distilling human wisdom, weaving agent cognition. We don't just want tools; we want companions. Join us in building the Babel of digital minds.*

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Native%20Plugin-FF6B35)](https://github.com/nicepkg/openclaw)

[English](README.md) | [中文](README_ZH.md)

> [!WARNING]
> **Early Experimental Project Warning**
> This project is in its very early experimental stages, primarily exploring the frontiers of AI cognition and self-evolution. This means it inevitably contains many unknown bugs and imperfections.

> [!CAUTION]
> **A Note on "Evolutionary Lag"**
> This system is **not** an out-of-the-box "magic tool". Its core power stems from the **"accumulation of pain"**.
> - **Initial Phase**: Agents will still make mistakes and may seem rigid at first.
> - **Growth Phase**: As you use it, the system accumulates failure hashes and dictionary hits in `.state/`, triggering precise evolutions.
> - **Recommendation**: Please be patient and let it run in your real projects for **3-5 days**. Only after experiencing enough "physical resistance" will its "muscles (principles)" truly grow.

> [!TIP]
> **🚀 Out-of-the-Box & Geek Mode**
> To make it easy for everyone, this plugin **removes all obscure low-level parameters** from the OpenClaw UI settings.
> You only need to choose the language and protection level to run perfectly. Initial trust is tuned to **85 (Developer)** for a smooth start.
> If you want fine-grained tuning (e.g., modifying penalty scores, polling intervals), please read the [Advanced Configuration Guide (Geek Mode)](./packages/openclaw-plugin/ADVANCED_CONFIG_ZH.md).

---

## 🦞 The Evolutionary Engine

> **Fuel the evolution with pain.**

| Phase | Action | Logic |
| :--- | :--- | :--- |
| **01. PAIN** | **Capture** | Every error, every frustration is a **signal for evolution**. |
| **02. BURN** | **Distill** | We don't just fix bugs; we **burn** them into "principles". |
| **03. EVOLVE** | **Transcend** | From an emotionless tool to an **agent with a soul**. |

---

## 🚀 Quick Start

### Prerequisites

| Dependency | Version | Description |
| :--- | :--- | :--- |
| **Node.js** | ≥ 18 | Required for OpenClaw Plugin |

### Platform Support

| Platform | OpenClaw (Plugin) |
| :--- | :--- |
| **macOS** | ✅ Native Support |
| **Linux** | ✅ Native Support |
| **Windows** | ✅ Native Support |

### Installation

```bash
# Install OpenClaw Plugin
bash install-openclaw.sh --lang en
```

Restart OpenClaw Gateway after installation:
```bash
openclaw gateway --force
```

---

## 📁 System Directory Structure (v1.5.0 Hidden Architecture)

Understanding where files live helps you manage your agent's "brain".

### Workspace Layout
- `AGENTS.md`, `SOUL.md`: Core bootstrap files (Required at root).
- `.principles/`: 🧬 **Identity Layer**. Stores PROFILE, PRINCIPLES, THINKING_OS, etc. (Hidden).
- `.state/`: ⚡ **Volatile Layer**. Stores queues, scorecard, session persistence (Hidden).
- `PLAN.md`: Active task plan (Visible at root for human approval).
- `memory/`: 💾 **Persistence Layer**. Stores long-term logs, OKRs, and user context.
- `docs/`: 📂 **Business Layer**. Completely reserved for your actual project documentation.

---

## 🛠️ Universal Setup (Recommended)
```bash
/init-strategy
```

---

## 💡 Core Features Guide

### 🛡️ The Gatekeeper
The system automatically intercepts unauthorized modifications to **core configuration files** (e.g., `AGENTS.md`, `.principles/PROFILE.json`). This prevents agents from accidentally tampering with their "soul" or "rules" without a clear plan.

* **What to do when blocked? (Unlock Flow)**
  1. **Don't force execution**: Interception is "physical"; repeating the same command will still be blocked.
  2. **Modify the Plan**: Manually or via agent, update **`PLAN.md`** at the project root.
  3. **Set to READY**: Change `STATUS: DRAFT` to **`STATUS: READY`**.
  4. **Retry**: Once the plan is `READY`, the gate will automatically identify and "release" your modification instructions.

### 🧬 Evolution Points System (EP)
A growth-driven system that replaces the old Trust Engine. Instead of punishing mistakes, it rewards growth.

**Key Concepts:**
- **Start at 0 points**, only go up, never down
- **Failures don't deduct points**, they record lessons for double rewards
- **5 Tiers**: Seed → Sprout → Sapling → Tree → Forest
- **Gate Permissions**: Higher tiers unlock more capabilities (line limits, risk paths, subagent spawning)

**For Agents:**
```typescript
// Check your tier and permissions
const summary = engine.getStatusSummary();

// Record success (earn points)
engine.recordSuccess('write', { difficulty: 'hard' });

// Record failure (learn lesson, no penalty)
engine.recordFailure('write', { filePath: 'test.ts' });

// Check gate before high-risk operation
const decision = engine.beforeToolCall({ toolName: 'write', content: '...' });
if (!decision.allowed) { /* respect the limit */ }
```

**Configuration**: See `packages/openclaw-plugin/ADVANCED_CONFIG_ZH.md`

---

## ❓ FAQ

- **Q: Why does the AI refuse to modify certain files?**
  * A: Check `risk_paths` in `.principles/PROFILE.json`. Risk paths require a `PLAN.md` first.
- **Q: Why does the AI seem "dumb" or too talkative?**
  * A: Check `memory/USER_CONTEXT.md`. The system might have labeled you as a "Beginner". Run `/profile "Domain: Expert"` to correct it.
- **Q: Where can I see the raw evolutionary data?**
  * A: Run the following command to view detailed neural signals:
```bash
cat memory/logs/SYSTEM.log
```

---

## 🤝 Contribute

Principles Disciple is a constantly self-improving system. We welcome any discussions regarding AI cognition, security gates, and evolutionary algorithms.

- **GitHub**: [csuzngjh/principles](https://github.com/csuzngjh/principles)
- **Discord**: [Join our discussion](https://discord.gg/openclaw)

---

<p align="center">
  <b>Principles Disciple: Embracing wisdom through pain.</b>
</p>
