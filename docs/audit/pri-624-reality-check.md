# PRI-624 Implementation Reality Check (Slice C)

Date: 2026-08-31. Base: `origin/main` @ `2392a80a` (#1458 Slice B merged). All
statements below verified against production code at that commit.

## A. Companion current capability

- Electron app; main `packages/pd-companion/src/main/main.ts`. Supervises exactly
  ONE child: the Console server via `spawn(node, [pdCliEntry, console open --json
  --no-browser --no-auth])`. Timers: 30s approvals poll + 6h update check.
- **No workspace discovery.** Single optional `workspaceOverride` in companion
  state (`src/lib/state-store.ts`). No workspace registry anywhere.
- Install manifest authority: `~/.pd/install.json`, schema in
  `packages/install-layout/src/index.ts` — `{ layoutVersion: 1, mode, hosts[] }`.
  It does **not** list workspaces. Writer: installer
  (`create-principles-disciple/src/installer.ts` `writeInstallManifest`).
- Lifecycle primitives: `ConsoleSupervisor` (single-child state machine with
  restart backoff), `killSpawnedTree`, tray/menu. No multi-child supervisor.
- Companion deps: only `@principles/install-layout`. better-sqlite3 ABI vs
  Electron is why it spawns **system node** (`src/lib/locate.ts`) — the worker
  must therefore also run as a system-node child, not in Electron main.

## B. Existing internalization consumer (OpenClaw)

- `openclaw-plugin/src/service/internalization-auto-consumer-service.ts`
  `runConsumerCycle`: flag gate → config → runtime config →
  `createRuntimeStateHandle` → `InternalizationOrchestrator(dryRun:true)` →
  queue read model → `computeConsumerDecision` → `wakeOnce` loop → adapter
  (pi-ai / L2 / openclaw-cli) → runner switch (dreamer…rollout_reviewer) →
  `runner.run` (lease acquired INSIDE runner via `DefaultLeaseManager`,
  `<workspace>/.pd/state.db`, single SQLite tx, cross-process safe) →
  `commitNextTaskProposal` → finally: recovery sweep + reconciliation budget.
- Eligible kinds: `DEFAULT_CONSUMER_RUNNER_KINDS=['dreamer']`,
  `FULL_CHAIN=[dreamer…rollout_reviewer]`. **`diagnostician` is NOT a peer
  RunnerKind** — the split pipeline stages are `diag_rootcause|distiller|router`
  under parent task kind `'diagnostician'`; consumer dispatch fail-loud skips
  them (EP-03 comment in the service).
- Diagnostician execution truth: `PainToPrincipleService.recordPain` —
  `asyncMode:true` → `bridge.submitPainSignal` (pending task only, what Slice B
  admission uses); sync mode → `bridge.onPainDetected` → ensure + reset + `runner.run`
  + `onDiagnosisComplete` (public: persistence, admission eval, intake, **dreamer
  seed** — the downstream entry).
- Gap: `onPainDetected` **resets attemptCount to 0** on re-trigger — correct for
  new pain events, wrong for a worker retry loop. Slice B submitted tasks via
  `submitPainSignal`; the counterpart "execute the submitted task later, budget
  preserved" does not exist yet → new `PainSignalBridge.executePendingDiagnosis`
  (core, additive).
- Host-neutral kernel already in `@principles/core/runtime-v2` (orchestrator,
  lease, runners, adapters, guards incl. `canRetryNow` backoff gate). Host glue
  (adapter+runner construction ~250 lines) exists in **two copies**: plugin
  service + `pd-cli runtime-internalization-run-once`. A third copy is
  forbidden → extract shared `runInternalizationConsumerCycle` into
  `@principles/host-runtime` (governance wiring moves too; its imports are
  already all core + a structural logger).

## C. Slice B recovery seam (host-runtime)

`governance-signal-admission.ts`: `ensureGovernanceContinuation` (L945, marker
self-contained), `reconcileGovernanceContinuation` (L1013, limit clamped 1..200
default 50, marker-driven scan Cases A/B/C, stale tails counted not retried),
`ensureGovernanceDiagnosticianTask` (L812, deterministic
`createDiagnosticianTaskId(painId)`), promotion via pending tails. trajectory.db
(`{ws}/.state/trajectory.db`) ↔ state.db (`{ws}/.pd/state.db`) bridged by the
deterministic task id + marker link; no shared tx (by design, SPEC §13).
CLI `pd codex reconcile` exists. Companion worker must call these seams, not
re-implement them.

## D. Ingestion catch-up

- Hook-driven only: `ingestCodexConversation(payload, kind)` requires a live
  payload with `transcript_path`; `ingestTranscriptDelta` resumes from the
  durable checkpoint (`governance_transcript_checkpoints`, PK
  `(host_kind, rollout_identity)`, 1 MiB bounded batch). `pd codex ingest` CLI
  does not exist.
- `rolloutIdentity` = uuid in the filename `rollout-<ts>-<uuid>.jsonl`; the
  checkpoint stores the uuid, not the path (SPEC scenario 9 forbids raw paths in
  DB). Catch-up therefore resolves the file by **exact-uuid targeted lookup**
  under `<CODEX_HOME>/sessions` (previously-authenticated rollouts only — not a
  session scan/guess), then re-validates via `validateCodexTranscriptPath`
  (containment + post-open identity revalidation) before reading.
- Missing: checkpoint list API, catch-up entry point, worker orchestration.
  Quarantine CLI = Slice D (SPEC §15 markers say "once available (Slice D)").

## E. Feature flags (SSoT: `principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts`)

- `host.codex` core, default **on**; `codex_conversation_ingestion` quiet,
  default **off**; `internalization_auto_consumer` quiet, default **on**.
- Workspace-scoped overrides in `{ws}/.pd/config.yaml` `features:`; loader
  `loadPdConfigForPlugin` / `computeFeatureFlagsFromConfig` (host-runtime/core).
- Zero-transcript-read when ingestion off is structural (gate precedes I/O) and
  proven by a port-spy test — the same contract must cover the catch-up/worker
  path, including the sessions-dir lookup (it is also FS I/O).

## Scope guards

- PRI-632 (Stage2/GFI/keyword learner) untouched: no Codex signal classifier,
  no GFI store, no model policy in this PR.
- No new task store / retry queue / scheduler DB; no LLM in hooks; Owner
  approval gates untouched; `internalization_auto_consumer` stays one flag with
  two consumers.
