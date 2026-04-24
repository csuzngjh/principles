# Phase m6-03: DiagnosticianPromptBuilder + Workspace Boundary - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** m6-03-DiagnosticianPromptBuilder-Workspace
**Areas discussed:** Prompt message structure, extra system prompt, workspace control, local/gateway mode

---

## Gray Areas Identified (pending discussion)

| Area | Options | Status |
|------|---------|--------|
| Prompt message structure | Raw DiagnosticianContextPayload vs transformed prompt object | Pending |
| Extra system prompt | None vs system instructions only vs full system prompt | Pending |
| Workspace control mechanism | cwd only vs cwd+env vars vs cwd+env+agent config | Pending |
| Local/Gateway mode selection | CLI flag vs env var vs config file | Pending |

**Discussion pending:** User to select which areas to deep-dive.

---

## Prompt Message Structure

| Option | Description | Selected |
|--------|-------------|----------|
| Transformed prompt object | Transform DiagnosticianContextPayload into a structured PromptInput with explicit fields (contextHash, taskId, etc.) | ✓ |
| Raw DiagnosticianContextPayload | Pass the raw DiagnosticianContextPayload directly as the --message JSON | |
| Structured wrapper | A single combined JSON structure wrapping the context + meta | |

**User's choice:** Transformed prompt object (recommended)

**Notes:** User selected the transformed approach — PromptInput object with explicit top-level fields (taskId, contextHash, diagnosisTarget, conversationWindow, sourceRefs) plus nested context field.

---

## Extra System Prompt

| Option | Description | Selected |
|--------|-------------|----------|
| None | DiagnosticianPromptBuilder only outputs JSON; system prompt is controlled by openclaw agent profile/config | ✓ |
| System instructions only | PD sends extra system prompt content that openclaw injects as additional instructions | |
| Full system prompt | PD sends full system prompt (replacing agent default) | |

**User's choice:** None (recommended)

**Notes:** System prompt is controlled by OpenClaw agent profile/configuration. PD does not inject extra system prompt content. HG-3 satisfied by explicit `--local` flag on the CLI side.

---

## Workspace Control Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| cwd + env + agent config | PD adapter passes cwd to CliProcessRunner. Environment variables (OPENCLAW_PROFILE, etc.) derived from config. Agent config settings applied. | ✓ |
| cwd only | PD adapter passes cwd to CliProcessRunner. No env var control. Simplest. | |
| cwd + env vars | PD adapter passes cwd + environment variables (OPENCLAW_PROFILE, OPENCLAW_CONTAINER_HINT) | |

**User's choice:** cwd + env + agent config (recommended)

**Notes:** Three-layer control allows PD to explicitly hand off to OpenClaw's workspace without sharing state.

---

## Local/Gateway Mode Selection

| Option | Description | Selected |
|--------|-------------|----------|
| Config/constructor injection | PD runtime adapter receives runtime mode as constructor/config injection. Clear, testable, explicit. | ✓ |
| CLI flag (--local) | CLI flag passed to openclaw agent (--local or absent) | |
| Env var | OPENCLAW_GATEWAY_MODE env var read at runtime | |

**User's choice:** Config/constructor injection (recommended)

**Notes:** When 'local': adapter passes `--local` flag to `openclaw agent`. When 'gateway': adapter omits `--local`. No silent fallback — explicit configuration required.

---

## Decisions Locked

- **DPB-06:** `DiagnosticianPromptBuilder.buildPrompt()` outputs `PromptInput` object with explicit top-level fields + nested context
- **DPB-07:** No `extraSystemPrompt` field — system prompt controlled by OpenClaw agent config
- **DPB-08:** Workspace controlled via cwd + env vars + agent config (three-layer)
- **DPB-09:** Runtime mode ('local' | 'gateway') injected via constructor/config — explicit, no silent fallback

## Next

Ready for `/gsd-plan-phase m6-03`.