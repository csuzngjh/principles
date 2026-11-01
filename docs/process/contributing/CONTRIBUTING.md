# Contributing

[English](CONTRIBUTING.md) | [中文](CONTRIBUTING_ZH.md)

Thank you for your interest in the **Principles Disciple** framework! This is an open-source project dedicated to guiding AI agent evolution through "meta-cognition" and "pain reflexes."

We highly welcome community contributions. You can participate by submitting bug reports, improving code, or **most importantly—proposing new Mental Models for the Thinking OS**.

## 🧠 Core Contribution: Proposing Mental Models

The most valuable co-creative aspect of this project lies in the mental model library within `THINKING_OS.md`. If, during your heavy use of OpenClaw, you have summarized highly effective "human-AI collaboration methodologies" or "meta-feedback mechanisms" that prevent AI failures, please propose them to us.

### Proposal Criteria

Any mental model promoted to `THINKING_OS.md` MUST meet these strict conditions:

1. **Generality**: It cannot be a specific rule for a specific language (e.g., "Don't use Python 2") or library. It must be a fundamental way of thinking (e.g., "Via Negativa", "Minimum Viable Change").
2. **Observable Trigger**: It must have a clear, concise trigger description so the Agent knows when to apply it.
3. **Minimal Token Cost**: One sentence to explain the philosophy, one sentence to explain the disaster it avoids. The entire description must be highly compressed.

### How to Submit a New Model

1. Test your model in your project by enabling Thinking OS guidance (`/pd-context thinking on`) and observing whether it prevents AI mistakes.
2. Collect screenshots or logs demonstrating how it successfully prevented an AI mistake.
3. Fork this repository.
4. Add your proposal to the Thinking OS template — `packages/openclaw-plugin/templates/langs/<lang>/principles/THINKING_OS.md`. The workspace copy `templates/workspace/.principles/THINKING_OS.md` must stay aligned with it; a drift test enforces this.
5. Create a Pull Request, detailing in the PR description:
   * What core pain point does this model solve?
   * What are its observable triggers?
   * Does it overlap with the existing base models?

## 💻 Code & Architecture Contributions

If you want to contribute code to the framework itself (Hooks, Gatekeeper logic, Memory Scanners, etc.):

1. **Environment Setup**:
   * If modifying the OpenClaw plugin: Navigate to `packages/openclaw-plugin` and run `npm install`.
2. **Formatting & Testing**:
   * Run `npm run build` and `npm run test` to ensure no build errors or regressions.
3. **Commit Standards**:
   * Our commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification (e.g., `feat:`, `fix:`, `docs:`).
   * In Pull Requests, please provide the context and reasoning behind modifications as clearly as possible.

## 📁 Repository root: committed dot-paths vs local state

Dot-directories at the root mix two very different things — repository content
and machine-local state. Read this before adding or deleting anything there:

| Path | What it is | In git |
| --- | --- | --- |
| `.agents/plugins/marketplace.json` | Codex marketplace manifest: a delivery input read by `pd-locate.cjs` / `pd-status.cjs` and asserted in `codex-plugin-bundle.test.ts`. The local Codex marketplace source points at this checkout, so it must stay at exactly this path. | yes |
| `.changeset/`, `.github/` | Release intent and CI configuration. | yes |
| `.claude/`, `.zcode/`, `.agents/skills/` | Local host tooling and per-machine agent skills. | no — ignored |
| `.principles/`, `.state/` | PD workspace runtime state, written by the running system and rebuildable from `packages/openclaw-plugin/templates/workspace/`. | no — ignored |

A file under an ignored path must never be tracked. When one is, that is a
repository bug: remove it in a PR with `git rm`, do not keep it alive by hand.

## 🐛 Bug Reports

Before submitting an Issue, please:
1. Search the repository to check if a similar Issue already exists.
2. If applicable, attach excerpts from `docs/SYSTEM.log`.
3. Specify your runtime environment details (OpenClaw version, plugin version, etc.).

Every PR and issue is another cycle of "evolution" for the system. Thank you for walking this path with us!
