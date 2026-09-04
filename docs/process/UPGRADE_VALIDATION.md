# PD Upgrade Validation Runbook — Host Tool Semantics & Reliability Readiness

> Audience: Owner / operator validating a PD installation after an upgrade
> (console update, plugin update, or manual reinstall).
>
> Scope: the reliability capability set introduced by PR #1495/#1497 (durable
> host tool declarations, the ONE semantic resolver, provenance-gated
> activation) and PR #1505 (evaluator runtime parity).

## Why this exists

Since the reliability closure, PD refuses to *guess* a host's tool surface.
Before any host has started in a workspace, no host tool declaration exists,
and every reliability-sensitive operation (code_tool_hook activation,
evaluator adversarial replay) **fails with a structured refusal**:

```
reason:      host_tool_declaration_missing
nextAction:  start each workspace host once (OpenClaw plugin / Codex worker)
             so it persists its tool declaration
```

This is **expected behavior on a fresh install or after a data reset**, not a
fault. The declarations are written by the hosts themselves at startup
(OpenClaw persists `.pd/host-tool-semantics/openclaw.json` when its
auto-consumer service starts — default-on flag `internalization_auto_consumer`;
the Codex worker persists `codex.json` on its first cycle). Refusing rather
than falling back to the built-in baseline is deliberate: an existence check
against baseline names is a forged proof (ERR-114).

## The 3-command validation flow

Run from any shell with `pd` on PATH (or `node <install>/pd-cli/dist/index.js`
when `pd` is broken):

```bash
# 1. Readiness snapshot (informational; never mutates anything)
pd health --workspace "<workspace>"            # text
pd health --workspace "<workspace>" --json     # machine-readable

# 2. Start the host(s) that own this workspace at least once
#    (OpenClaw gateway start / Codex worker cycle)

# 3. Re-run health — the reliability section must flip to ready
pd health --workspace "<workspace>"
```

### What each line means

| Output | Meaning |
| --- | --- |
| `reliability.registry.status: ok` | Host declaration files exist under `<workspace>/.pd/host-tool-semantics/` and validate |
| `reliability.registry.hosts: openclaw` | Which hosts have declared (multi-host workspaces list all, `+`-joined) |
| `reliability.registry.declaredTools: 12` | Total gate-reachable tool names declared across hosts |
| `reliability.resolver: ready` | The merged registry resolves (union of all hosts' declarations, order-independent) |
| `reliability.replay: ready` | The evaluator/activation deterministic replay context is constructible for this workspace — the same builder the production paths use |

When anything is missing or malformed, the section reports
`reliability.registry.status: degraded` with `reliability.reason` and
`reliability.nextAction` instead of silently degrading. `pd health` itself
stays exit-code-neutral for reliability (it is an observation, not a gate);
the **refusal authority lives in the operations themselves**:

```bash
# Expected refusal BEFORE the host has started once:
pd runtime activation dispatch --channel code_tool_hook --artifact-id <id> \
  --workspace "<workspace>" --json
# → { "decision": "refused", "reason": "host_tool_declaration_missing", ... }

# The same command after host startup proceeds into real replay validation.
```

## End-to-end smoke (after the section reports ready)

```bash
# Manual evaluator advance runs the deterministic adversarial replay to
# completion (parity with the in-host consumer cycle, PR #1505):
pd runtime internalization run-once --runner evaluator --workspace "<workspace>" --json

# A code_tool_hook activation validates against the SAME registry + replay:
pd runtime activation dispatch --channel code_tool_hook --artifact-id <id> \
  --workspace "<workspace>" --confirm --json
```

## Failure modes and remedies

| Symptom | Cause | Remedy |
| --- | --- | --- |
| `host_tool_declaration_missing` | No host has started in this workspace since install/reset | Start OpenClaw (gateway) or run the Codex worker once; re-check health |
| `host_tool_declaration_invalid (...)` | A declaration file is corrupt or conflicts (same tool name, different canonical kind across hosts) | Fix or delete the offending `.pd/host-tool-semantics/<host>.json`; the host rewrites it on next start |
| Health ready but activation still refuses | Artifact-level reasons (needs_revision, golden trace defects) — provenance is not the blocker | Inspect the refusal's `reason`/`nextAction`; they are artifact-specific |
| Plugin updated but declarations never appear | The installed plugin predates the reliability closure (its bundle cannot persist declarations — verify with the drift report in PRI-662) | Update the plugin to a closure-carrying build; do not hand-write declaration files |

## What NOT to do

- Do not hand-write or copy `.pd/host-tool-semantics/*.json` between
  workspaces — the declaration is host-authored provenance, not configuration.
- Do not disable the refusal by deleting the tool-semantic checks; the refusal
  is the reliability contract.
