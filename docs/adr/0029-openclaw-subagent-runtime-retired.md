# ADR-0029: OpenClaw Sub-Agent Runtime Backend Retired — pi-ai Is the Only Internal-Agent Runtime

> **Status**: Accepted — Owner decision 2026-10-23
> **Date**: 2026-10-23
> **Decider**: Owner
> **Decision basis**: Owner directive that PD's internal agents all run on pi-ai, so that PD's architecture stays simple and stable; `codex + PD(pi-ai)` must work with no OpenClaw installed, and an OpenClaw install is `openclaw + PD(pi-ai)` — never host runtime + host multi-agent mode.
> **Supersedes**: ADR-0016 §2.3 (the `openclaw` Runtime Profile type) as a forward-looking selection; ADR-0016 §2.4's OpenClaw binding example
> **Related**: [ADR-0012](0012-runtime-v2-standalone-scheduling-and-legacy-retirement.md), [ADR-0016](0016-pd-owned-user-config.md), [ADR-0020](0020-codex-cli-host-adapter.md), [ADR-0023](0023-pd-installation-architecture-decisions.md), [ADR-0025](0025-agent-role-instructions-to-systemprompt.md)
> **Tracked by**: PRI-1023

## 1. Context

PD had two backends for running its own internal agents (diagnostician, dreamer,
scribe, artificer, evaluator, signal collector, …):

- `pi-ai` — PD calls the model provider directly;
- `openclaw-cli` — PD spawns the host CLI (`openclaw agent --agent <id>`) and pushes
  PD's prompt into a host-owned agent session.

The second backend is an artifact of the period when OpenClaw was the only host PD
supported. It has now produced three concrete costs:

1. **Two authorities for one job.** The same internal agent could be run two ways, so
   "how does PD run its own agents?" no longer has one answer.
2. **An unfixable capability asymmetry.** `OpenClawCliRuntimeAdapter` cannot honour
   `StartRunInput.maxTokens` (the host CLI owns the model call), so every output-budget
   feature has a branch that can never be completed.
3. **Host coupling inside `@principles/core`.** The backend needed a `child_process`
   seam in core (`cli-process-runner`), registered as `cli-runtime-adapter` in
   `packages/principles-core/io-seam-registry.json`.

The pi-ai side already covers everything the retired backend did, and more.

## 2. Decision

1. **`pi-ai` is the only runtime backend for PD internal agents.** No PD code path may
   construct, select, or seed a runtime profile that routes an internal agent through a
   host CLI agent session.
2. **`openclaw` becomes read-only legacy**, in two distinct places, and it stays
   *parseable* in both:
   - the `openclaw` Runtime Profile **type** in `.pd/config.yaml` — still accepted on
     read, still redacted, never offered for selection, never written by PD, and any
     agent still bound to it resolves to `needs_setup` with a structured reason and a
     next action;
   - the historical `runtime_kind` **enum members** (`'openclaw'`, `'openclaw-cli'`,
     `'openclaw-history'`) in the run-record schema — retained so existing SQLite rows
     remain readable. **No data migration.** Deleting a member would make persisted
     history fail closed against a schema that no longer recognizes it.
3. **OpenClaw's status as a *host* is unchanged** by this ADR. See §3.
4. `pd runtime probe` no longer validates a host CLI agent session. Host reachability is
   reported as such, and the probe's guidance points at `pi-ai` for internal agents.

## 3. Boundary — the two "OpenClaw" concepts are not one thing

This ADR retires the **sub-agent runtime backend**. It does not retire the **host**.

| Concept | Carried by | Status after this ADR |
| --- | --- | --- |
| OpenClaw as **host** | `HostTarget='openclaw'`, `OpenClawHostInstaller`, the plugin shell, `~/.openclaw/**`, console `targetHost` / `hostKind`, gateway start/stop operations | **Retained** — PD continues to support OpenClaw as a host |
| OpenClaw as **sub-agent backend** | `RuntimeKind 'openclaw-cli'`, `OpenClawCliRuntimeAdapter`, profile `type: 'openclaw'`, `openclawMode`, `--openclaw-local` / `--openclaw-gateway` | **Retired** by this ADR |

Read-only legacy surfaces that belong to the **host/evidence** side and are explicitly
NOT in scope:

- `pd legacy import openclaw` (imports `runtime_kind='openclaw-history'` traces);
- `openclaw_context_bound` evidence-source alias;
- any `~/.openclaw/**` path handling (AGENTS.md §1.1: host-owned paths; PD code must not
  write there).

## 4. Migration and compatibility contract

| Requirement | Contract |
| --- | --- |
| Existing user config must not break | A config that still contains `type: 'openclaw'` **validates successfully** and emits an observable retirement warning. Rejecting it would brick installed workspaces. |
| No new openclaw facts | `getDefaultPdConfig()`, the effective-config layer, and the installer seed only `pi-ai` profiles. |
| Degradation is observable | An internal agent bound to a retired profile reports `needs_setup` with `reason` + `nextAction` (`rc-9`), never a silent fallback onto another profile's LLM (the factory is fail-closed). |
| Historical rows stay readable | `RuntimeKindSchema` keeps the legacy members; readers of persisted `runtime_kind` keep validating fail-closed against that schema. |
| Owner still sees their own config | The console keeps listing a legacy `openclaw` profile, labelled retired; it is removed from the *type picker*, not from the *list*. |

## 5. Known consequence the Owner accepted

On a pure OpenClaw host where the user never configured a provider, internal agents used
to be reported as ready because the `openclaw` profile delegated readiness to the host.
After this change that same workspace reports `needs_setup` until the user sets one pi-ai
profile.

That is the real price of this decision, and it is the correct direction: PD's internal
agents now have one runtime whose model, budget, and provider credential location are
owned by PD's own config, and the degraded state is stated out loud with a next action
instead of being hidden behind a host delegation.

## 6. Complexity Delta

Net negative. Removed: one `child_process` seam from `@principles/core`
(`cli-runtime-adapter`, including its derived ESLint exemption), one CLI-session runtime
branch in four selection paths, two installer-facing CLI flags, and one default-profile
seed. No new source of truth, no new persisted state, no new subsystem, no new public
abstraction, no feature flag, no new cross-package dependency, no new external capability.

## 7. Rollback

No flag and no data migration, so rollback is source-level: revert the retirement commit
restores the backend, and revert the default/seed commit restores `openclaw` as a
selectable default. Because this ADR, the code, and the enum-retention assertions land in
one PR, no rollback leaves intent and implementation divergent.

## 8. Out of scope (follow-ups, not part of this decision)

1. Ops runbook for host-side residue under `~/.openclaw/agents/` (PD-authored role
   directories from the retired mode). Host-owned paths — never a PD code change.
2. Mechanized prevention of PD writes into `~/.openclaw` interior paths (PRI-1021
   follow-up).
3. Final removal of the `'openclaw'` / `'openclaw-history'` enum members — requires a
   data-lifecycle decision about existing run rows first.
