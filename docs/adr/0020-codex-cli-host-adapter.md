# ADR-0020: Codex CLI Host Adapter and Multi-Platform Host Abstraction Layer

> **Status**: Accepted
> **Date**: 2026-08-11
> **Decider**: Owner
> **Context**: MVP-First (ADR-0014), Codex CLI adapter scoping (PRI-278~282, PRI-521, PRI-522)
> **Supersedes**: None (refines ADR-0014 §2.3 activation channels)
> **Related SPEC**: [`docs/architecture/CODEX_CLI_ADAPTER_SPEC.md`](../architecture/CODEX_CLI_ADAPTER_SPEC.md) v4.1
> **Amended**: 2026-08-13 — PRI-523 owner-approved MVP exception; see §10
> **Active reading rule**: Where §10 conflicts with earlier text, §10 controls. In particular, §§2.2-2.4, Alternative E, the "OpenClaw stays unchanged" consequence in §5, the old scope statement in §7, and the OpenClaw/shared-runtime items in §8 are retained only as 2026-08-11 decision history, not current implementation instructions.

## 1. Context

PD currently runs only on OpenClaw. Owners want Codex CLI support so that PD's three MVP-Core activation paths (`prompt`, `code_tool_hook`, `defer_archive`) work when the host is Codex rather than OpenClaw. Future hosts (Claude Code, OpenCode, Pi) are anticipated.

Without a host abstraction, each new host would fork the hook registration, installer, and uninstaller code. The existing `packages/openclaw-plugin/` and `packages/create-principles-disciple/` are tightly coupled to OpenClaw: paths like `getOpenClawDir()`, `getPluginExtDir()`, `updateOpenClawConfig()`, and `cleanupOpenClawConfig()` are OpenClaw-specific.

The SPEC v4.1 verification pass (third external review, 2026-08-11) confirmed three severe Codex semantics errors in v4 (E1: `continue: false` does not terminate session; E2: `permissionDecision: "ask"` unconditionally generates `invalid_reason`; E3: invalid output is fail-OPEN not fail-closed). These corrections directly shape the adapter's codec contract.

## 2. Decision

### 2.1 New package: `packages/codex-adapter/`

Create a new monorepo package `@principles/codex-adapter` at `packages/codex-adapter/`. **Do NOT mix codex-adapter code into `packages/openclaw-plugin/`** — the two hosts have different extension models (OpenClaw: in-process JS hooks via `api.on()`; Codex: out-of-process stdin/stdout JSON via `pd-hook.js`).

Package contents (to be implemented in PRI-280):
```
packages/codex-adapter/
├── src/
│   ├── host-adapter.ts          # CodexHooksHostAdapter impl
│   ├── pd-hook.ts               # Single entry script + event router
│   ├── codec/
│   │   ├── input-decoder.ts     # stdin snake_case → HostEvent (rc-1, rc-2)
│   │   └── output-encoder.ts    # HostEventResult → stdout camelCase JSON
│   └── index.ts
├── package.json
├── tsconfig.json
└── tests/
```

The package depends on `@principles/core` for the `HostAdapter` interface and shared types. It does NOT depend on `packages/openclaw-plugin/`.

### 2.2 `HostAdapter` interface in `@principles/core` (historical; superseded by §10)

Define a pure-types `HostAdapter` interface in `packages/principles-core/src/host/host-adapter.ts` (no I/O — pure logic boundary per ADR-0005). Only `CodexHooksHostAdapter` implements it in MVP. An `OpenClawHostAdapter` implementation is **deferred to Post-MVP** — OpenClaw keeps its direct `api.on()` registration unchanged, eliminating the largest regression risk on the only production-stable activation path.

### 2.3 Multi-host installer/uninstaller abstraction (historical installation facts; superseded by §10)

**Problem**: `packages/create-principles-disciple/src/installer.ts` and `uninstaller.ts` are hardcoded to OpenClaw:
- `getOpenClawDir()`, `getPluginExtDir()` assume OpenClaw's `~/.openclaw/extensions/` layout
- `updateOpenClawConfig()` writes to `~/.openclaw/openclaw.json`
- `cleanupOpenClawConfig()` only cleans OpenClaw entries
- `checkBuiltPlugin()` validates `openclaw.plugin.json`

**Decision**: Introduce a `HostInstaller` abstraction with per-host implementations:

```typescript
// packages/create-principles-disciple/src/host-installer.ts (new)
export type HostTarget = 'openclaw' | 'codex';

export interface HostInstaller {
  readonly target: HostTarget;
  /** Pre-install validation: host binary available? host config dir accessible? */
  validateHost(): Promise<{ ok: boolean; reason?: string; nextAction?: string }>;
  /** Install host-specific artifacts (plugin bundle, hooks.json, etc.) */
  installArtifacts(pluginDir: string, workspaceDir: string): Promise<HostInstallResult>;
  /** Update host-specific config (e.g., openclaw.json, ~/.codex/hooks.json) */
  updateHostConfig(): Promise<{ ok: boolean; reason?: string }>;
  /** Uninstall host-specific artifacts + clean config */
  uninstall(): Promise<{ removedDirs: string[]; removedFiles: string[]; cleanedConfigs: string[] }>;
  /** Post-install health check (e.g., `codex --version`, `openclaw doctor`) */
  healthCheck(): Promise<{ ok: boolean; reason?: string; nextAction?: string }>;
}
```

Each host gets a concrete implementation:
- `OpenClawHostInstaller` (refactor existing `installer.ts` OpenClaw-specific logic into this class)
- `CodexHostInstaller` (new, implements PRI-281 installer acceptance criteria)

**Installer flow** (multi-host aware):
1. Detect which hosts are present (`detectHosts()`): scan for `~/.openclaw/`, `~/.codex/`, PATH for `codex`/`openclaw` binaries.
2. Prompt owner: "Install PD for: (1) OpenClaw (2) Codex CLI (3) Both".
3. For each selected host, invoke the corresponding `HostInstaller.installArtifacts()` + `updateHostConfig()`.
4. Common steps (bundled @principles/core, pd-cli, pd-console, templates, config.yaml) run once, shared across hosts.

**Uninstaller flow** (multi-host aware):
1. Detect which hosts have PD artifacts installed.
2. For each host, invoke the corresponding `HostInstaller.uninstall()`.
3. Common artifacts (pd-cli, pd-console, @principles/core) are removed last, only after all host-specific artifacts are gone.

**CodexHostInstaller specifics** (per SPEC §5.7):
- **Path A (plugin bundle, preferred)**: install to `~/.codex/plugins/cache/principles-disciple/` with `plugin.json` (containing `$schema` field per `AGENT_PLUGIN_SCHEMA_URI`) + `hooks/hooks.json`.
- **Path B (global hooks.json, fallback)**: merge PD hook entries into `~/.codex/hooks.json` using a sidecar marker file `~/.codex/.pd-hooks.marker` for precise uninstall.
- **Trust detection**: check `[features].hooks = true` in Codex config; print guidance "Open Codex and run `/hooks` to trust PD hooks" if untrusted.
- **Re-trust on upgrade**: PD version change → content hash changes → owner must re-trust. Print guidance.
- **Uninstall**: for Path A, remove plugin bundle dir; for Path B, parse `~/.codex/hooks.json`, remove PD entries (identified by sidecar marker), preserve user's other hooks.

**OpenClawHostInstaller** (existing logic, refactored):
- Existing `updateOpenClawConfig()` becomes `OpenClawHostInstaller.updateHostConfig()`
- Existing `cleanupOpenClawConfig()` becomes `OpenClawHostInstaller.uninstall()` config cleanup
- Zero behavior change — pure refactor to fit the `HostInstaller` interface

### 2.4 Feature flag: `host.codex` (historical flag contract; superseded by §10.5)

Register `host.codex` in `DEFAULT_FEATURE_FLAGS`:
- `category: 'quiet'` (per ADR-0014 §2.5; unsolicited new code defaults to MVP-Quiet)
- `enabled: false` (default off — Codex adapter ships dark until PRI-282 E2E validation passes)
- `since: '2026-08-11'`
- Flag-off = `pd-hook.js` outputs `{}` + exit 0 + SystemLogger records skip reason (rc-9: non-silent)

The `abstraction_layer_v1` flag is **NOT registered** in MVP — OpenClaw shadow-mode refactor is deferred per ADR-0014. When Post-MVP restarts the OpenClaw refactor, `abstraction_layer_v1` will be registered at that time.

### 2.5 Hook surface (per SPEC v4.1)

- **Single entry** `pd-hook.js` + internal event router (reduces cold start vs. 4 separate scripts)
- **Single matcher group** `matcher: "Bash|apply_patch"` for PreToolUse (aliases `Write`/`Edit` work in ALL matcher-aware events per `apply_patch.rs:459-463` + `dispatcher.rs:432-475`)
- **Hardcoded output**: `continue: true`, `suppressOutput: false` — never use `permissionDecision: "ask"` (unconditionally generates `invalid_reason` per `output_parser.rs:445-447`)
- **`deny_unknown_fields` compliance**: stdout JSON must NOT contain any field outside Codex schema (29 occurrences in `schema.rs`)
- **fail-OPEN risk**: invalid output → `invalid_reason` → `should_block = false` → tool PROCEEDS (per `pre_tool_use.rs:235-240`). Mitigation: codec whitelist test + JSON Schema fixture contract test (gate-critical)
- **Deferred hooks**: PermissionRequest, Compact, SubagentStop, Stop, SessionEnd (not needed for MVP-Core activation paths)

### 2.6 PRI-279 (Outbound CodexCliRuntimeAdapter) deferred to Post-MVP

The three MVP-Core activation paths (`prompt`, `code_tool_hook`, `defer_archive`) are all **inbound** (Codex calls PD hooks). Outbound internalization (PD driving Codex to run diagnostician/dreamer/evaluator) already has OpenClaw/pi-ai runners. PRI-279 does not pass `mvp-q-1-what-if-skip` (skipping it for 30 days, no one notices). Tracked in `docs/plans/post-mvp-conditional-roadmap.md`.

### 2.7 PRI-521 (long-running service replacement) deferred to Post-MVP

Depends on PRI-279. MVP Codex path uses inbound hooks only; long-running services (CorrectionObserverService, InternalizationAutoConsumerService, DiagnosticBatchService, TrajectoryService) continue running on OpenClaw. When PRI-279 restarts, PRI-521 restarts in lockstep.

### 2.8 PRI-522 (19 slash commands migration to pd-cli) is MVP-required

Codex has no OpenClaw slash-command equivalent. Owner operates PD via `pd-cli` when host is Codex. The 19 OpenClaw slash commands (`/pd-status`, `/pd-pain`, `/pd-principles`, etc.) must have `pd-cli` equivalents. Title previously said "16" — corrected to **19** after v4.1 source re-verification.

## 3. Alternatives Considered

### A. Fork OpenClaw code for Codex
**Rejected**: DRY violation. Each new host = N copies of registration/installer/uninstaller logic. The `HostAdapter` + `HostInstaller` abstractions eliminate this.

### B. Make Codex an MCP server
**Rejected**: Changes PD's role from passive observer (host calls PD hooks) to active tool (PD exposes MCP tools the host must invoke). Breaks the inbound-only MVP-Core activation model.

### C. Wait for a "simpler" hook API
**Rejected**: Current Codex hook API is sufficient for all three MVP-Core activation paths. No gap exists.

### D. Mix codex-adapter into `packages/openclaw-plugin/`
**Rejected**: The two hosts have fundamentally different extension models (in-process JS vs. out-of-process stdin/stdout JSON). Mixing them creates a god-package and makes it impossible to ship OpenClaw without Codex (or vice versa). Separate packages allow independent versioning and testing.

### E. Refactor OpenClaw to use `HostAdapter` in MVP (shadow mode)
**Historical outcome (2026-08-11; superseded by §10)**: This was rejected for MVP at the time. PRI-523's explicit Owner exception now authorizes the narrower shared-runtime cutover and defines its required flag/rollback contract in §10.5.

### F. Single global installer that auto-detects host
**Rejected as default behavior**: Owner must explicitly choose which hosts to install PD for. Auto-detection is used only to **suggest** defaults in the prompt ("Detected Codex CLI at ~/.codex/. Install for Codex? (Y/n)"). Silent dual-install without consent violates the confirm-first principle.

## 4. MVP Three Questions

### 4.1 PRI-278 (this ADR): `mvp-q-1-what-if-skip`
**What happens if we DON'T do this?** Without ADR-0020, the Codex adapter work (PRI-280/281/282/522) has no architectural foundation. Engineers would improvise ad-hoc solutions, likely mixing codex code into `openclaw-plugin/`. This will be raised within 30 days when PRI-280 starts.

### 4.2 `mvp-q-2-how-observed`
**How is it observed?** ADR-0020 is a documentation deliverable. Observation = (a) the ADR file exists at `docs/adr/0020-codex-cli-host-adapter.md` with Status: Accepted; (b) `host.codex` flag appears in `feature-flag-contract.ts` `DEFAULT_FEATURE_FLAGS`; (c) `feature-flag-contract.test.ts` passes (asserting the flag is registered with correct category/enabled/since).

### 4.3 `mvp-q-3-how-disabled`
**How is it disabled?** The ADR itself cannot be "disabled" — it is a record of a decision. The `host.codex` feature flag defaults to `true` (flipped to MVP-Core on 2026-08-12 after PRI-282 E2E validation passed). Roll back = set `host.codex.enabled: false` in `.pd/config.yaml`. When disabled, `pd-hook.js` short-circuits to `{}` + exit 0 and SystemLogger records the skip (rc-9).

### 4.4 `mvp-q-4-emotional-value`
**What emotional value does it deliver?** This ADR reduces **失控感** (loss of control): the owner sees a clear architectural plan before any code is written, rather than discovering ad-hoc choices during review. It creates **沉淀感** (accumulation): the SPEC v4.1 + ADR-0020 pair is institutional memory that survives across sessions and engineers. The multi-host installer design reduces **疲惫感** (fatigue): one `create-principles-disciple` invocation handles both OpenClaw and Codex, rather than two separate installers with divergent UX.

## 5. Consequences

### Positive
- New host = one `HostAdapter` impl + one `HostInstaller` impl + registration + tests. Business logic shared via `@principles/core`.
- OpenClaw path stays unchanged in MVP — zero regression risk on production-stable path. **Historical 2026-08-11 consequence; superseded by the gated cutover in §10.2/§10.5.**
- Codex has **equivalent gate coverage** to OpenClaw for function tools (Bash, apply_patch, MCP tools all trigger PreToolUse per `dispatcher.rs:61-63`).
- Multi-host installer/uninstaller makes PD a first-class dual-host citizen without coupling the two hosts' code.
- `packages/codex-adapter/` is independently versionable, testable, and can be published as a separate npm package if needed.

### Negative
- One more package in the monorepo (`packages/codex-adapter/`) — adds build/lint/test surface.
- The `HostInstaller` abstraction in `create-principles-disciple` is introduced before the second concrete implementation (`CodexHostInstaller`) is complete — slight interface risk. Mitigated by PRI-281 acceptance criteria exercising the interface end-to-end.
- Owners who install for both hosts must trust PD hooks in Codex AND register PD in OpenClaw — two consent steps, not one. This is unavoidable (different hosts have different trust models).

### Neutral
- `HostAdapter` interface in `@principles/core` has only one implementation in MVP. This is intentional — the interface exists to make the abstraction boundary explicit, not to be immediately polyglot.

## 6. Risk Analysis (per SPEC §7)

The most material risk is **codec fail-OPEN** (Critical): if PD's `pd-hook.js` outputs invalid JSON (e.g., `permissionDecision: "ask"`, extra fields, `continue: false`), Codex generates `invalid_reason`, does NOT set `should_block = true`, and the tool proceeds — PD's gate is silently bypassed. Mitigations (gate-critical, must pass before `host.codex.enabled = true`):
1. Codec whitelist test: assert `permissionDecision ∈ {undefined, "allow", "deny"}` (never `"ask"`)
2. No extra fields in stdout JSON (respect `deny_unknown_fields`)
3. JSON Schema fixture contract test (using Codex-generated fixtures)
4. PRI-282 E2E verification on pinned Codex version `>= 0.124.0`

See SPEC §7 for the full risk table including `suppressOutput` unimplemented, `async: true` efficacy uncertainty, and hook trust friction.

## 7. Compliance

- **ADR-0014 (historical 2026-08-11 assessment; superseded by §10)**: Feature flag `host.codex` registered as `quiet`, default off. No MVP-Core expansion. PRI-279 + PRI-521 deferred per §2.4-§2.6.
- **ADR-0005 (Core vs Plugin boundary)**: `HostAdapter` interface (pure types) in `@principles/core`; `CodexHooksHostAdapter` (I/O) in `packages/codex-adapter/`.
- **rc-1 to rc-9**: codec treats stdin as `unknown`, uses type guards (no `as`), fails loud on missing fields, validates array elements, uses `Object.hasOwn`, maintains lineage consistency, distinguishes loop states, uses bounded serialization, emits reasons on all degradation paths.
- **cli-1 to cli-7**: `pd health --host codex` (PRI-522) follows strict JSON, exit-stops, flag-wiring, dry-run/confirm mutex, failure-no-mutation, output-next-action, test-wiring.
- **Error Handbook**: No new ERR entry needed for this ADR (documentation-only deliverable). PRI-280 implementation will reference ERR-001 (treat-as-unknown), ERR-005 (as-bypass), ERR-009 (fail-loud-missing), ERR-015/018/019 (loop state freshness) per the Runtime Contract Rules.

## 8. Post-MVP Debt (historical 2026-08-11 classification; OpenClaw/shared-runtime items superseded by §10)

Tracked in [`docs/plans/post-mvp-conditional-roadmap.md`](../plans/post-mvp-conditional-roadmap.md):
- **OpenClawHostAdapter refactor (historical)**: the old external-signal restart condition is superseded only for PRI-523's narrow shared-runtime cutover; §10 is the active scope.
- **`abstraction_layer_v1` flag (historical placeholder)**: §10.5 now requires its registration and defines exact off/on behavior; this bullet is not an instruction to wait for Post-MVP.
- **PRI-279 (CodexCliRuntimeAdapter)**: outbound internalization on Codex. Restart condition: owner feedback requires diagnostician/dreamer/evaluator running on Codex directly.
- **PRI-521 (long-running service replacement)**: 4 services migrated to Codex-compatible trigger model. Restarts with PRI-279.

## 9. References

- [ADR-0014](0014-mvp-first-strategy-and-product-pivot.md) — MVP-First strategy
- [ADR-0005](0005-nocturnal-internalization-merger.md) — Core vs Plugin boundary (frozen legacy)
- [`CODEX_CLI_ADAPTER_SPEC.md`](../architecture/CODEX_CLI_ADAPTER_SPEC.md) v4.1 — full technical specification
- [PRI-278](https://linear.app/principles-disciple/issue/PRI-278) — ADR + hook surface mapping
- [PRI-279](https://linear.app/principles-disciple/issue/PRI-279) — CodexCliRuntimeAdapter (deferred)
- [PRI-280](https://linear.app/principles-disciple/issue/PRI-280) — hook scripts + codecs
- [PRI-281](https://linear.app/principles-disciple/issue/PRI-281) — installer integration
- [PRI-282](https://linear.app/principles-disciple/issue/PRI-282) — E2E validation
- [PRI-521](https://linear.app/principles-disciple/issue/PRI-521) — long-running service replacement (deferred)
- [PRI-522](https://linear.app/principles-disciple/issue/PRI-522) — 19 slash commands migration to pd-cli
- `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts` — `DEFAULT_FEATURE_FLAGS`
- `packages/create-principles-disciple/src/installer.ts` — existing OpenClaw-only installer
- `packages/create-principles-disciple/src/uninstaller.ts` — existing OpenClaw-only uninstaller

---

## 10. Amendment (2026-08-13): Owner Exception — Shared Host Runtime and Codex Desktop Plugin

> **Status of amendment**: Accepted (explicit maintainer-approved `mvp-exception`)
> **Authority**: [PRI-523](https://linear.app/principles-disciple/issue/PRI-523), Owner decision recorded 2026-08-12/13: "revise ADR, then share runtime"
> **Supersedes within this ADR**: §2.2's Codex-only implementation, §2.3's cache/global-hooks installation preference, §2.4's `host.codex` category/default and instruction not to register `abstraction_layer_v1`, Alternative E's MVP rejection, §5's statement that OpenClaw stays unchanged, §7's "No MVP-Core expansion", and the OpenClaw/shared-runtime items in §8. Those historical passages are retained as decision history and are not active implementation instructions after this amendment.

### 10.1 Why this is an exception, not satisfaction of the old restart conditions

The external-signal restart conditions previously attached to `OpenClawHostAdapter` were not met. The Owner explicitly approved a narrow exception after the implemented Codex package proved to be only a codec/install skeleton: its `invokeBusinessLogic()` currently always allows, while the working OpenClaw plugin already owns the I/O orchestration required by the same three user-visible paths. Keeping two orchestration implementations would make the new host appear installed without delivering PD behavior.

This amendment authorizes only the minimum reuse required to make the already-approved Codex host real. It does not reopen general multi-host architecture work.

### 10.2 Decision: shared I/O orchestration with thin host adapters

Create `@principles/host-runtime` as a shared **I/O orchestration** package. It may compose the existing pure domain APIs from `@principles/core`, workspace persistence, feature flags, logging, and the three approved host-triggered behavior paths. It does not move I/O into `packages/principles-core/src/`.

Both host packages become thin protocol adapters:

- `packages/openclaw-plugin/` translates OpenClaw hook payloads/results and calls `@principles/host-runtime`.
- `packages/codex-adapter/` validates/encodes Codex hook JSON and calls the same runtime.
- Host-specific installation, trust, protocol codecs, and result shapes remain in their host packages; business orchestration is not copied between them.

The exception exposes exactly three MVP-Core behavior paths:

1. **Prompt injection** — provide Owner-approved active principles to the host prompt context.
2. **Before-tool RuleHost enforcement** — evaluate a tool call and return the host-specific allow/deny result.
3. **After-tool pain/evidence capture** — record owner-relevant behavioral evidence and its lineage in the authoritative workspace.

This is a host-surface refactor of existing MVP-Core behavior, not a fourth activation channel. `defer_archive` remains an owner-reviewed activation outcome in the domain, but it does not require a separate host hook path.

### 10.3 Explicitly still deferred

This exception does not authorize:

- outbound host runtimes that make PD drive Codex or another agent;
- long-running service replacement (PRI-521), schedulers, background daemons, or cross-session continuation;
- general memory, tool repair/retry, autonomous value decisions, or task execution;
- advanced Skill/MCP parity for ChatGPT Web/Mobile or other hosts;
- public-directory publication until OpenAI documents a submission type that accepts lifecycle-hook plugins.

### 10.4 Supported Codex distribution facts

For the pinned implementation baseline, Codex 0.147 supports plugin-bundled hooks from the default `hooks/hooks.json` path or a manifest-declared hooks path. Hook commands may resolve packaged code with `PLUGIN_ROOT` and plugin-private data with `PLUGIN_DATA`; hooks remain subject to the Codex hook-trust flow.

The first supported distribution channels are:

1. **Repository/personal Marketplace testing** — install the plugin from its repository source into Codex and validate it in Codex CLI/Desktop.
2. **Workspace publication** — after that testing passes, a Workspace admin publishes the local plugin to selected Workspace roles. This is organization-internal distribution, not the universal OpenAI public directory.

Both routes require Workspace-scoped use in Codex CLI/Desktop after the Owner reviews and trusts the hooks.

Do not document `~/.codex/plugins/cache/...` as an installation target or direct mutation of `~/.codex/hooks.json` as the preferred plugin path. Those are obsolete implementation assumptions from §2.3. The bundled default is `hooks/hooks.json` unless the manifest declares another path.

OpenAI's current public submission documentation lists Skills and MCP servers, but does not confirm lifecycle-hook plugins as a public-directory submission type. Repository Marketplace distribution is supported now; public-directory submission remains gated and must not be advertised as available.

`PLUGIN_DATA` is plugin-private auxiliary storage, not the authority for PD principles, evidence, or feature flags. Per [`DATA_ARCHITECTURE.md`](../architecture/DATA_ARCHITECTURE.md), the current Workspace has two authoritative physical stores that both hosts must share: `{workspace}/.pd/config.yaml` plus `{workspace}/.pd/state.db` for configuration and Runtime V2 SQLite state, and `{workspace}/.state/principle_training_state.json` for the Principle Tree ledger. Existing `.state/` runtime/host artifacts, including trajectory and session evidence, remain Workspace-scoped rather than moving into `PLUGIN_DATA`. `PLUGIN_ROOT` identifies packaged code/assets.

### 10.5 Observable acceptance and rollback

Acceptance is exact and Owner-visible: after installing PRI-523 from the repository Marketplace into a Workspace and trusting its hooks, (a) a prompt receives the same active-principle context as OpenClaw, (b) a known RuleHost fixture denies the same before-tool call in both hosts, and (c) a completed tool call creates pain/evidence with Codex source lineage in that same Workspace; host-runtime contract tests and one OpenClaw/Codex parity E2E must prove all three.

Rollback is also exact: setting `host.codex.enabled: false` in the Workspace `.pd/config.yaml` makes every Codex hook return the host's neutral allow/empty result, records the structured skip reason, and leaves OpenClaw plus both Workspace authority paths unchanged.

This amendment changes the active flag contract unambiguously:

- `host.codex` remains the existing MVP-Core kill switch, currently default-on after PRI-282 validation; §2.4's historical `quiet`/default-off instruction is superseded. PRI-523 does not create a second Codex flag.
- `abstraction_layer_v1` is now required for the OpenClaw cutover: register it as `category: core`, `enabled: false`, `since: '2026-08-13'`. `false` routes OpenClaw through its legacy orchestration; `true` routes OpenClaw through `@principles/host-runtime`. It may be enabled only after the parity acceptance in this section passes, and setting it back to `false` is the no-migration rollback.

Neither flag contract counts as implemented until the production `.pd/config.yaml` loader and tests exercise it. The legacy OpenClaw route must not be removed in PRI-523.

### 10.6 Emotional-value review

This exception reduces **失控感** and **不信任感**: installation alone is no longer mistaken for working governance, hook trust is explicit, and the three behavior paths have observable parity evidence. It creates **掌控感** and **安心感** because the Owner keeps approval authority, one Workspace remains the source of truth, and `host.codex` provides an immediate, non-destructive kill switch. Sharing the runtime also reduces **疲惫感** by preventing the same correction from drifting across host-specific implementations, without adding new dashboards or attention noise.

### 10.7 Error-pattern guard

- **ERR-002 / EP-03**: flag-off and degraded hook paths must record a reason; neutral output must never become silent success.
- **ERR-040 / EP-06**: repository Marketplace contents and `hooks/hooks.json` are the distributable source of truth; tests must exercise the installed bundle, not only source files.
- **ERR-012 / EP-10**: implementation must compare against the current branch/base and keep the refactor diff free of stale or unrelated host changes.

Runtime-contract rules `rc-1` through `rc-9` apply to the future codec/runtime implementation. CLI rules `cli-1` through `cli-7` are N/A to this documentation amendment and become applicable only if PRI-523 changes operator commands.

### 10.8 References

- [PRI-523](https://linear.app/principles-disciple/issue/PRI-523) — authoritative MVP exception and acceptance contract
- [`CHATGPT_PLUGIN_MARKETPLACE_SPEC.draft.md`](../architecture/CHATGPT_PLUGIN_MARKETPLACE_SPEC.draft.md) — distribution draft, still gated for public submission
- [`post-mvp-conditional-roadmap.md`](../plans/post-mvp-conditional-roadmap.md) — exception/hold split
