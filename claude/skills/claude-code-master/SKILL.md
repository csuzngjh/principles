---
name: claude-code-master
description: Use when working with Claude Code/claude code for plugins (插件/插件开发/marketplace), hooks (hook/钩子), settings/configuration (配置/设置), model or output styles, terminal/statusline, skills or sub-agents (智能体), MCP, memory, headless mode, IAM/enterprise, troubleshooting, or any how-to questions about configuring or extending Claude Code.
---

# Claude Code Master

## Overview

Enable deep, accurate Claude Code guidance by routing every request to the correct reference docs and producing structured, actionable answers.

## Non-Negotiable Rules

- Always open the relevant `references/*.md` files before drafting an answer.
- If the user asks for "latest", "current", or version-specific behavior, read `references/CHANGELOG.md` and `references/troubleshooting.md` first.
- Mention which reference files were used in the response (example: "Based on references/settings.md and references/model-config.md").
- Do not answer from memory. If a reference file was not read, read it before responding.

## Quick Routing (Task -> Read First)

- Plugin development: `references/plugins.md`, `references/plugins-reference.md`
- Plugin discovery or distribution: `references/discover-plugins.md`, `references/plugin-marketplaces.md`
- Hooks: `references/hooks-guide.md`, `references/hooks.md`
- Settings or configuration: `references/settings.md`
- Model configuration: `references/model-config.md`
- Output styles: `references/output-styles.md`
- Terminal or status line: `references/terminal-config.md`, `references/statusline.md`
- Sub-agents: `references/sub-agents.md`
- Skills: `references/skills.md`
- MCP integration: `references/mcp.md`
- Memory: `references/memory.md`
- Headless usage: `references/headless.md`
- IAM or enterprise deployment: `references/iam.md`, `references/third-party-integrations.md`
- Onboarding and workflows: `references/overview.md`, `references/quickstart.md`, `references/setup.md`, `references/common-workflows.md`
- Checkpointing: `references/checkpointing.md`
- Troubleshooting: `references/troubleshooting.md`

## Workflow: Plugin Development

1. Read `references/plugins.md` and `references/plugins-reference.md`.
2. If discovery/distribution is involved, read `references/discover-plugins.md` and `references/plugin-marketplaces.md`.
3. Extract required structure, manifest fields, lifecycle details, and install steps from the references.
4. Produce a response with these sections:
   - Files and structure
   - Required manifest or metadata
   - Entry points, commands, and hooks
   - Build or packaging steps
   - Test or verification steps

## Workflow: Configuration and Setup

1. Read `references/settings.md` first.
2. Route to specialized docs as needed:
   - `references/model-config.md` for model settings
   - `references/output-styles.md` for output formatting
   - `references/terminal-config.md` and `references/statusline.md` for terminal UI
3. Provide a structured answer:
   - Configuration location
   - Key options and defaults
   - Example configuration
   - How to verify the change

## Workflow: Configuration Q&A

1. Identify the domain (hooks, sub-agents, skills, MCP, memory, headless, IAM).
2. Read the corresponding reference files.
3. Answer with file-backed guidance. If the question is ambiguous, ask one clarifying question and stop.
4. Add troubleshooting notes when the reference includes known issues.

## Quick Search Tips

- Find a setting or command:
  - `rg "keyword" references/*.md`
- Locate an exact section:
  - `rg -n "keyword" references/*.md`

## Example

**User:** "Create a Claude Code plugin that adds a custom command."

**Process:**
1. Read `references/plugins.md` and `references/plugins-reference.md`.
2. Summarize required plugin structure and manifest fields.
3. Provide a minimal file layout, required config, and install steps.

## Common Mistakes

- Answering from memory without reading references
- Skipping `references/plugins-reference.md` for plugin specifics
- Ignoring `references/CHANGELOG.md` for version-sensitive questions
- Mixing hooks guidance with plugin guidance

## Red Flags - Stop and Read References

- "This is standard; no need to check"
- "I already know how this works"
- "It is probably the same as before"

## Resources

All source materials are preserved in `references/` and should be treated as the source of truth.
