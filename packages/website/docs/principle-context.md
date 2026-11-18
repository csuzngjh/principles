# Principle Context

Principle Context is a lightweight, optional, **read-only** long-term background you maintain so PD can pick principles that fit your actual work. Its physical file is `memory/okr/CURRENT_FOCUS.md` in your PD workspace — the whole file is the context; PD never writes, compresses or reformats it.

## What PD does with it

- PD **reads** the file (at most once per adaptive selection) only when you have explicitly authorized sending it (see below).
- The normalized content travels inside the Adaptive Decisions request to your configured `adaptiveActivation.endpoint` — it never enters the host system prompt, logs, telemetry or any local persistent store.
- A missing, oversized or unreadable file simply means the selection runs without context; nothing else changes.

## Configuration

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `adaptiveActivation.sendPrincipleContext` | boolean | `false` | Explicit egress consent for the Principle Context |

```yaml
adaptiveActivation:
  endpoint: https://your-decisions-endpoint/v1/score
  model: your-decision-model
  apiKeyEnv: YOUR_DECISION_API_KEY
  sendPrincipleContext: true   # default false; only set true deliberately
```

Setting the key to `false` (or removing it) keeps the context strictly local: PD performs **zero** file reads and sends nothing on the next round. Turning it off does not disable Adaptive activation itself.

## Data-transfer disclosure (please read before enabling)

1. **Default: nothing leaves your machine.** The context is not sent to any external provider unless you explicitly set `sendPrincipleContext: true` (and the host's adaptive activation flag is on).
2. **Explicit consent required.** Only setting the key to `true` authorizes egress.
3. **What is sent.** The provider receives the normalized context text (≤ 4,000 UTF-16 code units) inside the Decisions request's `state` field.
4. **No local persistence of the body.** PD does not write the context text to logs, telemetry, traces, journals, job/result payloads or error reports.
5. **PD cannot vouch for the provider.** PD does not promise the external provider refrains from recording request content.
6. **Provider policy governs.** How the endpoint operator processes, retains and uses the data is determined by their terms of service; do not assume the data never leaves your machine once enabled.
7. **Revocation timing.** Switching back to `false` (or disabling the host's adaptive flag) stops all *subsequent* requests — it cannot recall requests already sent or in flight.

## Host-specific visibility

- **OpenClaw**: the context is per-agent (each agent workspace has its own file).
- **Codex**: the context follows your user-level or project-level PD workspace resolution.
- **WorkBuddy**: the PD workspace is a **user-level shared governance workspace** — the same Principle Context is visible across all your projects, not per-project.
