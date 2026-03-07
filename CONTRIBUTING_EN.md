# Contributing

[English](CONTRIBUTING_EN.md) | [中文](CONTRIBUTING.md)

Thank you for your interest in the **Principles Disciple** framework! This is an open-source project dedicated to guiding AI agent evolution through "meta-cognition" and "pain reflexes."

We highly welcome community contributions. You can participate by submitting bug reports, improving code, or **most importantly—proposing new Mental Models for the Thinking OS**.

## 🧠 Core Contribution: Proposing Mental Models

The most valuable co-creative aspect of this project lies in the mental model library within `THINKING_OS.md`. If, during your heavy use of Claude Code or OpenClaw, you have summarized highly effective "human-AI collaboration methodologies" or "meta-feedback mechanisms" that prevent AI failures, please propose them to us.

### Proposal Criteria

Any mental model entering `THINKING_OS_CANDIDATES.md` (and eventually promoted to `THINKING_OS.md`) MUST meet these strict conditions:

1. **Generality**: It cannot be a specific rule for a specific language (e.g., "Don't use Python 2") or library. It must be a fundamental way of thinking (e.g., "Via Negativa", "Minimum Viable Change").
2. **Observable Signals**: It must leave detectable traces in the conversation, either through user prompts or AI text generation patterns (matchable by Regex).
3. **Minimal Token Cost**: One sentence to explain the philosophy, one sentence to explain the disaster it avoids. The entire description must be highly compressed.

### How to Submit a New Model

1. Test your model in your project via `/thinking-os propose "Model Name: Core philosophy and disaster prevention baseline"`.
2. Collect screenshots or logs demonstrating how it successfully prevented an AI mistake.
3. Fork this repository.
4. Add your proposal to the `docs/THINKING_OS_CANDIDATES.md` file.
5. Create a Pull Request, detailing in the PR description:
   * What core pain point does this model solve?
   * What are its observable Regex signals?
   * Does it overlap with the existing 9 base models?

## 💻 Code & Architecture Contributions

If you want to contribute code to the framework itself (Hooks, Gatekeeper logic, Memory Scanners, etc.):

1. **Environment Setup**:
   * If modifying the OpenClaw plugin: Navigate to `packages/openclaw-plugin` and run `npm install`.
2. **Formatting & Testing**:
   * Run `npm run build` and `npm run test` to ensure no build errors or regressions.
3. **Commit Standards**:
   * Our commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification (e.g., `feat:`, `fix:`, `docs:`).
   * In Pull Requests, please provide the context and reasoning behind modifications as clearly as possible.

## 🐛 Bug Reports

Before submitting an Issue, please:
1. Search the repository to check if a similar Issue already exists.
2. If applicable, attach excerpts from `docs/SYSTEM.log`.
3. Specify whether your runtime environment is native Claude Code config or the OpenClaw SDK plugin.

Every PR and issue is another cycle of "evolution" for the system. Thank you for walking this path with us!
