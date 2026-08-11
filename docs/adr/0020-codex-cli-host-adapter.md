# ADR-0020: Codex CLI Host Adapter and Multi-Platform Host Abstraction Layer

> **Status**: Accepted
> **Date**: 2026-08-11
> **Decider**: Owner
> **Context**: MVP-First (ADR-0014), Codex CLI adapter scoping (PRI-278~282, PRI-521, PRI-522)
> **Supersedes**: None (refines ADR-0014 §2.3 activation channels)
> **Related SPEC**: [`docs/architecture/CODEX_CLI_ADAPTER_SPEC.md`](../architecture/CODEX_CLI_ADAPTER_SPEC.md) v4.1

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

### 2.2 `HostAdapter` interface in `@principles/core`

Define a pure-types `HostAdapter` interface in `packages/principles-core/src/host/host-adapter.ts` (no I/O — pure logic boundary per ADR-0005). Only `CodexHooksHostAdapter` implements it in MVP. An `OpenClawHostAdapter` implementation is **deferred to Post-MVP** — OpenClaw keeps its direct `api.on()` registration unchanged, eliminating the largest regression risk on the only production-stable activation path.

### 2.3 Multi-host installer/uninstaller abstraction

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

### 2.4 Feature flag: `host.codex`

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
**Rejected for MVP**: Eliminating regression risk on the only production-stable activation path is more valuable than DRY purity. OpenClaw refactor is tracked in `docs/plans/post-mvp-conditional-roadmap.md` with explicit restart conditions.

### F. Single global installer that auto-detects host
**Rejected as default behavior**: Owner must explicitly choose which hosts to install PD for. Auto-detection is used only to **suggest** defaults in the prompt ("Detected Codex CLI at ~/.codex/. Install for Codex? (Y/n)"). Silent dual-install without consent violates the confirm-first principle.

## 4. MVP Three Questions

### 4.1 PRI-278 (this ADR): `mvp-q-1-what-if-skip`
**What happens if we DON'T do this?** Without ADR-0020, the Codex adapter work (PRI-280/281/282/522) has no architectural foundation. Engineers would improvise ad-hoc solutions, likely mixing codex code into `openclaw-plugin/`. This will be raised within 30 days when PRI-280 starts.

### 4.2 `mvp-q-2-how-observed`
**How is it observed?** ADR-0020 is a documentation deliverable. Observation = (a) the ADR file exists at `docs/adr/0020-codex-cli-host-adapter.md` with Status: Accepted; (b) `host.codex` flag appears in `feature-flag-contract.ts` `DEFAULT_FEATURE_FLAGS`; (c) `feature-flag-contract.test.ts` passes (asserting the flag is registered with correct category/enabled/since).

### 4.3 `mvp-q-3-how-disabled`
**How is it disabled?** The ADR itself cannot be "disabled" — it is a record of a decision. The `host.codex` feature flag it registers defaults to `false`. Codex adapter behavior is dark until PRI-282 flips the flag to `true`. Roll back = set `host.codex.enabled: false` in `.pd/config.yaml`.

### 4.4 `mvp-q-4-emotional-value`
**What emotional value does it deliver?** This ADR reduces **失控感** (loss of control): the owner sees a clear architectural plan before any code is written, rather than discovering ad-hoc choices during review. It creates **沉淀感** (accumulation): the SPEC v4.1 + ADR-0020 pair is institutional memory that survives across sessions and engineers. The multi-host installer design reduces **疲惫感** (fatigue): one `create-principles-disciple` invocation handles both OpenClaw and Codex, rather than two separate installers with divergent UX.

## 5. Consequences

### Positive
- New host = one `HostAdapter` impl + one `HostInstaller` impl + registration + tests. Business logic shared via `@principles/core`.
- OpenClaw path stays unchanged in MVP — zero regression risk on production-stable path.
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

- **ADR-0014**: Feature flag `host.codex` registered as `quiet`, default off. No MVP-Core expansion. PRI-279 + PRI-521 deferred per §2.4-§2.6.
- **ADR-0005 (Core vs Plugin boundary)**: `HostAdapter` interface (pure types) in `@principles/core`; `CodexHooksHostAdapter` (I/O) in `packages/codex-adapter/`.
- **rc-1 to rc-9**: codec treats stdin as `unknown`, uses type guards (no `as`), fails loud on missing fields, validates array elements, uses `Object.hasOwn`, maintains lineage consistency, distinguishes loop states, uses bounded serialization, emits reasons on all degradation paths.
- **cli-1 to cli-7**: `pd health --host codex` (PRI-522) follows strict JSON, exit-stops, flag-wiring, dry-run/confirm mutex, failure-no-mutation, output-next-action, test-wiring.
- **Error Handbook**: No new ERR entry needed for this ADR (documentation-only deliverable). PRI-280 implementation will reference ERR-001 (treat-as-unknown), ERR-005 (as-bypass), ERR-009 (fail-loud-missing), ERR-015/018/019 (loop state freshness) per the Runtime Contract Rules.

## 8. Post-MVP Debt

Tracked in [`docs/plans/post-mvp-conditional-roadmap.md`](../plans/post-mvp-conditional-roadmap.md):
- **OpenClawHostAdapter refactor**: OpenClaw's direct `api.on()` registration migrates to `HostAdapter` interface. Restart condition: MVP ships + 30 days stable + owner signals second-host value realized.
- **`abstraction_layer_v1` flag**: registered when OpenClaw refactor starts.
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
