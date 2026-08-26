# Anonymous Product Telemetry v1.0 — Feasibility Review (Phase 0, PRI-596)

- **Date**: 2026-08-26
- **HEAD verified**: `a67073f2` (branch `fix/mimosa-command-injection-hardening`, 4 commits ahead of `origin/main` @ `22ae2f43`; the 4 delta commits are PRI-569 work owned by another task and do not touch any seam verified below)
- **Working tree**: no tracked modifications; only unrelated untracked files from other tasks
- **Verdict**: **READY WITH CHANGES**

Repository facts below override SPEC assumptions where they conflict. Each conflict is recorded with *original assumption → repository fact → final decision*.

---

## 1. Host Architecture (verified)

PD supports two hosts over one shared host contract (`packages/principles-core/src/host/host-adapter.ts:33-46,158-193`):

- **OpenClaw** (in-process): `packages/openclaw-plugin/src/index.ts` `register(api)` registers hooks (`before_prompt_build` :332, `before_tool_call` :434, …) and services. Per-workspace one-time init runs inside `before_prompt_build`, guarded by in-memory `startedWorkspaces` Set (:59-60, :350-407). The gateway process is long-lived.
- **Codex** (subprocess): `packages/codex-adapter/src/pd-hook.ts` `processHookInvocation` — stdin JSON in, bounded stdout/exit out. `session_start` performs a health probe only (:56-59); all other events dispatch through `createProductionHostRuntime().dispatch(event)`. **The hook process is short-lived: it must answer and exit.**
- **Shared runtime**: `packages/host-runtime` (`createProductionHostRuntime`) — opens the same per-workspace `<workspace>/.pd/state.db` for both hosts (`production-rulehost-gate.ts:167`).
- **Installation layout**: `packages/install-layout` — canonical `~/.pd/install.json` + `~/.pd/runtime/*`; legacy = `~/.openclaw/extensions/principles-disciple`; `mode: 'canonical' | 'legacy' | 'missing'`. **Legacy installs exist in the wild (verified on the live machine: legacy, no `~/.pd`).**
- Dependency direction (verified from package.json): `codex-adapter`, `pd-cli`, `pd-console` depend on `@principles/host-runtime`; `openclaw-plugin` imports `@principles/host-runtime` directly (`src/host-runtime/openclaw-host-runtime.ts:1`, esbuild-bundled into dist). `host-runtime` depends only on core. **→ host-runtime is the single package reachable from every host and console; it is the correct home for host-neutral telemetry I/O.**

## 2. What fact honestly represents "PD initialized"

- **Uniform durable fact (both hosts)**: `{workspace}/.pd/state.db` exists **and** its `schema_version` table is populated (`sqlite-connection.ts:59-65,205-210,641-651`). The installer already uses state.db existence as its own "workspace has PD state" predicate (`create-principles-disciple/src/installer.ts:1779-1786`); `pd runtime init` creates it (`pd-cli/src/commands/runtime-init.ts:82-86`).
- Host-binding initialization is host-specific (Codex `~/.pd/codex/pd-hooks.marker` + `~/.codex/hooks.json`; OpenClaw `~/.openclaw/plugins/installs.json` + extension dir). There is **no** uniform host-binding fact; `~/.pd/install.json` `hosts[]` is the closest machine-level record.
- **Decision**: `initialized` = state.db present with populated `schema_version` (workspace-scope fact). A single OpenClaw hook firing is NOT treated as universal initialization.

## 3. Telemetry Unit

> **⚠ Review correction (2026-08-26, PR #1419 review remediation)**
>
> - **Original decision**: Telemetry Unit = the PD installation; snapshot describes "the telemetry unit's active workspace"; maintainer wording "participating installations".
> - **Why invalid**: the milestone facts come from ONE workspace (whichever triggers first), while dedup/retry/lock state was machine-global — so on a multi-workspace installation, the FIRST workspace to succeed froze the day's result for everyone (`already_succeeded_today`), and "installation-level" milestone reach was actually first-workspace-wins sampling. Justification 4 ("typical installations have one primary workspace") cannot support the statistical contract.
> - **Final decision**: measurement unit = **the workspace**. Consent/secret stay machine-scope; daily ID, dedup, retry, attempt caps, and the export lock are workspace-scoped via a local opaque `workspaceScopeId = HMAC(secret, canonical workspace path)` (never uploaded). Maintainer wording: "participating workspaces" / "daily-workspace observations". See ADR-0021 §2.0.

**Telemetry Unit = the PD installation** — the `~/.pd` home boundary (home-dir root that holds `install.json`, and for legacy installs is created on first telemetry enable). All maintainer-facing wording says **"participating installations"** (never "users").

Justification (verified):
1. It is the only durable boundary shared by both hosts across all workspaces.
2. Consent is a machine/user-scope decision (one consent, not one nag per workspace).
3. Feature flags are per-workspace (`{workspace}/.pd/config.yaml`, ADR-0016) — a workspace-keyed unit would overcount flag-gated state; the release feature flag is read for the **resolved workspace** and ANDed with machine-scope consent.
4. The daily snapshot is derived from the **resolved workspace's** durable facts (typical installations have one primary workspace). Documented as: *snapshot describes the telemetry unit's active workspace*. *(Superseded by the review correction above: point 4's "typical single workspace" assumption does not hold as a measurement contract.)*

## 4. Authority Matrix (verified durable sources)

| Milestone | Authority source | Exists-check semantics |
|---|---|---|
| `initialized` | `<ws>/.pd/state.db` + `schema_version` table | DB exists AND `SELECT version FROM schema_version` returns ≥1 row |
| `painObserved` | trajectory.db table `pain_events` (`openclaw-plugin/src/core/trajectory.ts:221-234`) | `SELECT EXISTS(SELECT 1 FROM pain_events)` — every row is an admitted, canonical-deduped pain; failed pains live in `dead_letter_pains` (state.db) and are excluded |
| `principleObserved` | Principle tree ledger `<ws>/.state/principle_training_state.json` (`principles-core/src/principle-tree-ledger.ts`), fallback `principle_candidates` (state.db) | ledger `principles` map non-empty (any status) OR `EXISTS(principle_candidates)` |
| `activationObserved` | state.db table `activations` (`sqlite-connection.ts:439-450`) | `EXISTS(SELECT 1 FROM activations)` — the row IS the durable activation fact (`activated_at NOT NULL`) |
| `presenceReceiptObserved` | state.db `principle_applications` `level='presence'` (`sqlite-connection.ts:458-485`) | `EXISTS(... WHERE level='presence')`; rows are 90-day-window observed evidence (PRI-590 semantics) |
| `effectReceiptObserved` | state.db `principle_applications` `level='effect'` (`rule_blocked`/`auto_correct_applied`/`self_reported`) | `EXISTS(... WHERE level='effect')` |

Honesty constraints adopted from PRI-590 (`receipt-coverage.ts`): counts are observed evidence within the retained window, never complete history. Booleans are conservative: **missing/unreadable/disabled source renders `false` (never overclaims), documented in the schema inventory.** presence ≠ effect ≠ durable improvement (dashboard wording locked to "Effect receipt observed").

Self-report receipts: v1 aggregates `level='effect'` without self-report breakdown (SPEC §32 recommended behavior).

## 5. Existing Telemetry Infrastructure — NOT reused as transport

- `TelemetryEvent` (`principles-core/src/telemetry-event.ts`) = in-process evolution-pipeline event schema (~200 types), consumed only by `storeEmitter` (Node EventEmitter, no persistence, no network).
- `EventLog` (`openclaw-plugin/src/core/event-log.ts`) = workspace-local JSONL + daily stats, 7-day retention, redaction pipeline.
- **Zero remote telemetry exists anywhere.** No `event emitted → HTTP request` pattern will be created. Product telemetry is a *derived daily snapshot*, not an event stream (SPEC §20 confirmed).
- Reused assets: outbound-HTTP client shape modeled on `pd-console/src/server/feedback/ingest-adapter.ts` (AbortController timeout, injectable `fetchFn`, structured `{ok,status,reason,nextAction}`); rate-limit + strict-validation pattern from `website/functions/_lib/relay-core.ts`.

## 6. Consent / Control State Seam

- **No existing privacy/consent surface** (only `feedback:` config section for the opt-in feedback channel).
- **Decision**: Telemetry Control State = `~/.pd/product-telemetry.json` (single JSON file beside `install.json`): `consent: unset|granted|denied`, `consentVersion`, `telemetrySecret` (hex, `crypto.randomBytes(32)`), `lastAttemptedAt`, `lastSucceededAt`, `lastFailureCode`, `nextRetryAt`, `schemaVersion`. Atomic write; never enters Principle/Pain/receipt/governance stores. Reset deletes secret + control fields (preserves explicit `denied` when the user chose it).
- **SPEC conflict #1 (ADR-0016)**: ADR-0016 §5 Non-Goals states "No analytics or telemetry upload." → *Original assumption: telemetry can be added as config surface. Repository fact: ADR forbids it.* **Decision: a new ADR (Anonymous Product Telemetry v1) supersedes that clause for the opt-in anonymous telemetry channel only.**
- **Consent UX**: v1 consent is CLI-only (`pd telemetry enable --confirm`). No prompts, no nags, no UI interruption (stronger than SPEC §10's example dialog, which PD has no surface for). Console settings toggle can follow later.

## 7. Feature Flag

- Registry: `principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts` `DEFAULT_FEATURE_FLAGS` (~45 flags; quiet = default off). New flag: **`anonymous_product_telemetry`** — `category: quiet`, `enabled: false`, `since: 2026-08-26`.
- Double-sync obligations (verified): add to installer template `generateConfigYamlContent` (`create-principles-disciple/src/mvp-config.ts`) + keep `installer-config-parity.test.ts` green + idempotent config migration for existing installs (pattern: `migrateHostRuntimeFlagsInConfigYaml`).
- Flag (release availability) and consent (user permission) are independent AND-ed gates (SPEC §38).

## 8. CLI Seam

- Commander; commands in `packages/pd-cli/src/commands/`, registered in `src/index.ts`; `withWorkspaceAndJson` adds `--workspace/--json`; `emitResult` prints exactly one JSON object; failures carry `reason`+`nextAction` and set `process.exitCode = 1`.
- New: `pd telemetry status | enable | disable | preview | reset` (subcommand group). State-changing commands default `--dry-run`, require `--confirm` (cli-4). `preview` prints the exact outbound payload + `Preview only. Nothing was sent.` `status` never prints the secret. Tests: flag-wiring (real `registerX` helper, `freshProgram()`) + behavior (JSON purity, no-secret, tmp workspace) per EP-04 exemplar `mvp-smoke.test.ts`.

## 9. Production Eligibility (suppression matrix)

Signals verified to exist in the repository:

```
canExport =
    flag anonymous_product_telemetry ON (resolved workspace)
&&  consent === 'granted' (~/.pd/product-telemetry.json)
&&  env kill switch NOT set            — PD_TELEMETRY_DISABLED ('1'|'true', matches PD_SKIP_* convention)
&&  !process.env.CI
&&  !process.env.VITEST                (vitest sets VITEST=truthy in workers)
&&  PD_E2E_MODE !== '1'
&&  workspace.environment ∉ {test, demo, development}   (PRI-587 in-band classification; absent = unknown → allowed)
&&  install layout mode ∈ {canonical, legacy}           (mode 'missing' = nothing installed)
&&  executing host-runtime module NOT inside a PD monorepo checkout
```

Repo-checkout detection = module-location fact (walk up from the telemetry module's own directory looking for a sibling `packages/principles-core` + `packages/host-runtime` marker) — a build-layout fact, not a user-path heuristic (EP/`PD_E2E_MODE` philosophy: explicit markers over path heuristics).

## 10. Cloudflare Architecture (verified)

- Existing: **Cloudflare Pages project `principles-website`** (VitePress site) with Pages Functions `functions/api/feedback/*`, KV namespace `FEEDBACK_KV`, secrets via `wrangler pages secret put`, deploy on push to main via `.github/workflows/deploy-website.yml` (runbook `docs/process/DEPLOY_WEBSITE.md`).
- **D1 is NOT used anywhere yet**; local wrangler is OAuth-authenticated (account verified; `d1 list` authorized).
- **Decision (cheapest correct, no new Worker/project)**: new Pages Function `functions/api/product-telemetry/snapshot.ts` + dependency-injected `_lib/telemetry-collector-core.ts` (same vitest-tested pattern as `relay-core.ts`), new `[[d1_databases]]` binding, SQL migrations under `packages/website/migrations/`, KV rate limiting (`FEEDBACK_KV`, distinct key prefix). Endpoint path follows the existing unversioned convention: `POST /api/product-telemetry/snapshot`.
- Retention: Pages Functions have **no cron triggers** (repository fact) → 90-day retention enforced as a bounded `DELETE` sweep on each successful write (self-maintaining, volume is tiny). Documented in the maintainer runbook.

## 11. SPEC Conflicts and Implementation Adjustments

| # | Original assumption | Repository fact | Final decision |
|---|---|---|---|
| 1 | Telemetry config surface fits ADR-0016 | ADR-0016 §5 forbids telemetry upload | New ADR supersedes the clause for the opt-in anonymous channel |
| 2 | Consent prompt UI (SPEC §10 example) | No consent-prompt surface exists in plugin/hosts | CLI-only explicit consent; zero prompts/nags |
| 3 | All hosts export during normal activity | Codex hook is a short-lived subprocess; a pending fetch would stall hook exit (blocking risk) | Export triggers: (a) OpenClaw plugin one-time workspace init (long-lived gateway), (b) pd-console server startup. Codex hook does NOT trigger — Codex installations export via console/Companion activity; documented limitation |
| 4 | hostKind = triggering host | Trigger process ≠ host binding | hostKind derived from `~/.pd/install.json` `hosts[]` (`['openclaw']`→openclaw, `['codex']`→codex, else `other`; legacy extension-dir installs → openclaw) |
| 5 | Reliability = allowlisted error-family enum | House error contract is `reason`+`nextAction` pairs (PDErrorCategory), designed for local diagnostics, not export | v1 exports a single coarse boolean `reliability.initializationFailed` (schema-init warnings / unreadable schema_version); no enums, no messages |
| 6 | `/api/v1/product-telemetry/snapshot` | Existing endpoints unversioned (`/api/feedback`) | `/api/product-telemetry/snapshot` (schemaVersion inside payload) |
| 7 | Telemetry unit scope open (installation preferred) | `~/.pd` installation boundary exists but legacy installs lack it | Unit = installation; consent file created on enable for legacy installs; eligibility accepts canonical AND legacy modes |
| 8 | 90-day server retention via scheduled job | Pages Functions have no cron | Retention = bounded DELETE sweep on successful writes |

## 12. Code Placement (minimal surface)

| Concern | Location |
|---|---|
| Snapshot contract (TypeBox), daily-ID derivation (HMAC), privacy field guard, pure snapshot builder over injected reader ports | `packages/principles-core/src/runtime-v2/product-telemetry/` (pure, no I/O) |
| Consent store, SQLite milestone readers, eligibility, HTTPS exporter (injectable fetchFn), orchestrating service | `packages/host-runtime/src/product-telemetry/` (host-neutral I/O; reachable from all hosts + console) |
| CLI control plane | `packages/pd-cli/src/commands/telemetry.ts` |
| Export trigger (a) | `openclaw-plugin/src/index.ts` one-time workspace init (bundled host-runtime import precedent at `src/host-runtime/openclaw-host-runtime.ts:1`) |
| Export trigger (b) | `pd-console/src/server/index.ts` startup |
| Collector + D1 + maintainer view | `packages/website/functions/` + `migrations/` + `wrangler.toml` |
| Flag registration | `feature-flag-contract.ts` + installer template + parity test + migration |

## 13. Risks

1. **Local wrangler token scope** — whoami shows limited scope readout; `d1 list` works. If `d1 create` / `pages deploy` are unauthorized, Phase 4 real deployment is blocked on owner-run commands (minimal unblock condition documented). Mitigation: attempt early; CI deploys on merge regardless.
2. **Codex-only, console-less installations never export** (short-lived processes only) — accepted v1 limitation, documented; milestones from such installs are invisible to telemetry (measurement bias already inherent to opt-in).
3. **Boolean conservatism** — disabled/missing sources render `false` (undercount, never overclaim); documented in schema inventory.
4. **Legacy installs** — no `~/.pd` until first enable; hostKind falls back to `openclaw` when only the legacy extension dir exists.
5. **Version drift** across the 5 npm packages (1.74–1.218 observed) — `pdVersion` resolves the installed `principles-disciple` (product) version via install-layout paths, injected by callers.

## 14. Phase Gate Answers (mvp-q-*)

- **mvp-q-1-what-if-skip**: ClawHub downloads remain indistinguishable from real usage; release health invisible (SPEC §76).
- **mvp-q-2-how-observed**: `pd telemetry status/preview` locally; protected maintainer signals view remotely.
- **mvp-q-3-how-disabled**: four independent paths — feature flag (default off), `pd telemetry disable`, `PD_TELEMETRY_DISABLED=1`, collector/rollback (remove endpoint or D1). No PR-revert required.
- **mvp-q-4-emotional-value**: preserves 信任/掌控/安心 — explicit consent, exact payload preview, one-command disable/reset, zero content collection, zero prompts (reduces 不信任感/失控感; SPEC §79).
