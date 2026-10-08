# @principles/codex-adapter

## 0.5.0

### Minor Changes

- d5732f8: PD v2 Phase 1 Evidence Foundation (ADR-0027): normalized intervention evidence ledger.
  
  - core: intervention evidence contract + deterministic normalizer (rc-1..rc-5 trust boundary, anti-forgery cross-field rules), append-only SQLite ledger tables inside the existing state.db (idempotent same-source replay, reported source conflicts, immutable records, activation occurrence snapshots), busyTimeoutMs connection option, and the four-query audit read contract.
  - host-runtime: shared intervention evidence ingress — the single validated entry every host source uses; never throws, never waits on locks (busyTimeoutMs 0), degrades with structured reason + nextAction.
  - openclaw-plugin (principles-disciple): evidence wiring on both legacy and shared routes — prompt delivery attempts (submitted/attempted, host consumption never claimed), enforcement chains on gate block/auto-correct (runtime_loaded delivery, runtime_verified application with explicit proof boundary, episode, effect), agent_claimed self-report mirroring; gated by the existing principle_receipt_ledger flag.
  - codex-adapter: evidence adapter on the shared ingress — UserPromptSubmit delivery attempts after the durable event-log line, deny chains recorded only after successful stdout encoding; honest capability matrix (self_report Unsupported, enforcement Unknown per PRI-780).
  - create-principles-disciple (ships pd-console): four read-only evidence-audit queries under /api/v1/receipts/evidence-audit plus the authenticated Owner outcome input POST /api/v1/evidence/outcomes (closed body contract, server-derived actor), and an evidence-audit section on the principle detail page.
  
  No effectiveness scoring, ranking, or automatic governance action anywhere (Phase 1 records facts only).

### Patch Changes

- Updated dependencies [d5732f8]
- Updated dependencies [0b981bb]
  - @principles/core@1.290.0
  - @principles/host-runtime@0.8.0

## 0.4.8

### Patch Changes

- cee2304: Use the Codex user governance workspace across projects while resolving tool paths from the active project. Register Marketplace setup with the existing canonical installation so Companion can discover its Codex worker.
- df9e555: PRI-917 v0.3.3 (OD-PRI917-05): Reuse Review Gate — automatic candidate intake now consults the semantic reuse evaluation capability before creating a Principle.
  
  A `reuse` recommendation parks the candidate (`refused/reuse_pending_owner`): no Principle is written, no evidence is appended, the candidate stays pending for the Owner, and the bridge emits an observable `reuse_gate_triggered` event plus a `reuse_review_required` outcome pointing at `pd candidate review --decide reuse|create`. `create`/`uncertain` recommendations and every evaluation failure degrade to normal creation (learning never blocks). `reuseEvaluation.enabled=false` restores the exact pre-v0.3.3 behavior.
  
  Also fixes the R5 "two-heads-block" defect: `pd candidate review --decide reuse` no longer lets the PRI-442 admission pre-check reject low-confidence candidates — a reuse verdict creates nothing, so the ledger-quality gate does not apply (the `--decide create` pre-check is unchanged).
  
  PR review fixes (4×P2, PRI-938): the bridge cache key now folds in the reuse-gate switch so a long-lived host picks up `reuseEvaluation.enabled` toggles in both directions (T11 rollback without a restart); mixed batches and replays keep parked candidates visible (`reuse_review_required` degraded outcome, Codex worker `reuseReviewRequiredCandidateIds`, OpenClaw `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` log gated on the park disposition); `pd diagnose` / `pd pain-retry` render parked candidates with review guidance and exclude them from `internalize` next-action lists.
  
  Follow-up review fixes: evaluation profile and timeout changes invalidate the cached reuse hook. Replay verifies the original diagnosis admission and performs a read-only reuse check before reporting a parked candidate, preserving failed-intake and gate-disabled behavior without additional persisted state.
  
  Owner-approved configuration hardening: constructing CandidateIntakeService with both reuseRecommendation and reuseDecision now fails explicitly before either callback or any candidate mutation, instead of silently prioritizing the decision channel.
- Updated dependencies [cee2304]
- Updated dependencies [df9e555]
  - @principles/host-runtime@0.7.13
  - @principles/core@1.289.0

## 0.4.7

### Patch Changes

- 84c7074: PRI-892: fixed the silent no-op of `npx create-principles-disciple` on Windows. Node resolves the main module through symlinks/junctions while `process.argv[1]` keeps the unresolved link path handed over by npm/npx `.bin` shims, so the raw `pathToFileURL(argv[1]) === import.meta.url` entry guard never matched and the CLI exited 0 with zero output (install / repair-update-chain / uninstall all dead). The guard now canonicalizes argv[1] with `realpathSync` before comparing (fail-safe: an unreadable entry is simply not the main module), keeps the cli-7 import-safety semantics (importing the module still never parses argv), and adds an rc-9 observable fallback: when the entry path unambiguously names this package's `dist/index.js` but canonicalization still misses, the CLI warns on stderr instead of saying nothing. The identical guard in the Codex `pd-hook` entry is fixed the same way (linked installs previously skipped `main()` silently). Regression tests spawn the built CLI and hook through a junction path and assert real output (red before the fix: empty stdout, exit 0).
- 1ac725c: PRI-892 follow-up (last open review finding of the merged PR #1833): the Codex `pd-hook` entry guard could still reproduce the silent no-op it was introduced to remove, because it compared `argv[1]` only after `realpathSync` and answered a failed lookup with `return false`. A legitimate direct invocation whose realpath lookup threw (EPERM, an antivirus-held path, an exotic mount) therefore skipped `main()` and the hook emitted nothing. The guard now decides in three layers: the raw `pathToFileURL(argv[1]) === import.meta.url` comparison runs first, so an ordinary `node dist/pd-hook.js` never depends on a filesystem lookup succeeding; realpath canonicalization still covers the npm/npx `.bin` shim and junctioned-install case; and when realpath itself throws while `argv[1]` still names this file, the guard writes a bounded rc-9 diagnostic (`reason=entry_identity_unverified … nextAction=…`) and runs `main()`, preserving the hook contract of exactly one JSON object on stdout. cli-7 import-safety is unchanged, and the installer needed no edit because its `looksLikeOwnDistEntry()` fallback already resolves without realpath. Regression tests pin all three layers by spawning the built hook through a real path, a junction path and an unresolvable path, plus the negative control that an unresolvable entry naming a different file stays silent.
- Updated dependencies [c7453ea]
- Updated dependencies [99e6a8c]
- Updated dependencies [edbbcd9]
- Updated dependencies [8b7b775]
- Updated dependencies [9d98f89]
- Updated dependencies [92074a0]
  - @principles/host-runtime@0.7.8
  - @principles/core@1.287.2
  - @principles/install-layout@0.2.7

## 0.4.6

### Patch Changes

- 8ae91f4: Re-cut of @principles/codex-adapter. The 0.4.5 tarball on npm was published by a legacy release run carrying stale internal dependency ranges (@principles/core ^1.74.1, @principles/host-runtime ^0.1.0), so an install resolving to 0.4.5 pulls inconsistent dependency copies. npm tarballs are immutable and cannot be corrected in place, so this publishes a fresh 0.4.6 from the current aligned tree (@principles/core ^1.287.0, @principles/host-runtime ^0.7.7, @principles/install-layout ^0.2.0). Version re-cut only; no source change.
- Updated dependencies [75b4ac4]
  - @principles/core@1.287.1

## 0.4.5

### Patch Changes

- 8424d60: Baseline-cutover dependency-contract fix: the @principles/host-runtime range now matches the aligned version (^0.7.7) so workspace resolution stays single-copy after version alignment (ERR-131).
- Updated dependencies [8424d60]
  - @principles/core@1.287.0
