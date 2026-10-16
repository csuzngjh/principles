# @principles/codex-adapter

## 0.5.6

### Patch Changes

- 06152af: Connect Codex Owner-labelled behavior evidence to the shared internalization preflight. Reuse one validated assembler across OpenClaw, Codex and evidence attach/resume; read trajectory data without creating or migrating it and preserve host-specific semantics. Missing labels reach Owner review without model calls or attempts; missing/corrupt sources remain observable source faults.
- Updated dependencies [fec1306]
- Updated dependencies [574954a]
- Updated dependencies [06152af]
  - @principles/install-layout@0.4.0
  - @principles/core@1.293.0
  - @principles/host-runtime@0.10.0

## 0.5.5

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/core@1.292.1
  - @principles/host-runtime@0.9.1
  - @principles/install-layout@0.3.1

## 0.5.4

### Patch Changes

- 5e794be: WorkBuddy remediation: pass through the existing toolUseId into tool-failure admission candidates (optional, default-off behavior unchanged) so per-call identity survives the admission boundary.
- 6e60d84: SPEC-CODEX-PAIN-CLOSURE-001: Codex 痛苦反馈闭环修复。
  
  - CR-01（PRI-960）：工具执行结果三值契约（success/failure/unknown）——缺失退出码不再伪造为 0，snake_case/camelCase 退出码全位置读取；tool_calls 增补 tool_use_id 连接列；consent 门控的 transcript 事实路径把文本型 live 观测升级为宿主核实的最终结果。
  - CR-02/CR-03（PRI-958/959）：明确 Owner 陈述（--owner-statement / PD记录痛苦：前缀，≤500 字拒绝不截断）仅满足空输入证据准入条件；候选行新增 admission_json——不可变评估历史 + 当前指针 + 独立处理进度域；CLI intake 写入许可以持久化完整门禁为准（部分检查仅作快速预拒）。
  - CR-05：诊断成功后的准入/收编/seed 断点由 worker 有界续接（不重跑诊断 LLM，最多 3 次自动尝试，终态可读）。
  - CR-06：pd pain retry 支持 --owner-statement/--dry-run/--confirm 的授权恢复语义。
  - CR-07：Codex 用户消息 `PD记录痛苦：<反馈>` 前缀入口（UserPromptSubmit Hook，登记→任务→回执，无 LLM，幂等）；插件交付 pd-record-pain skill。
  - CR-08：worker 周期活性事实持久化（readiness ≠ liveness）；pd codex worker --status 与 Companion 分开报告活性。
- 54d1380: PRI-953 (R1 F1/F2): extend the verified Codex ingestion envelope to 0.162.1 and make stale installs / unverified CLI versions visible.
  
  - codex-adapter: `CODEX_INGESTION_VERIFIED_VERSION` 0.150.1 → 0.162.1, backed by an on-device contract probe against real codex-cli 0.162.1 (125/125 captured hook payloads decode; 8/8 real rollout transcripts ingest with only designed unknown-record-type skips) and sanitized G1 fixtures (`hook-payloads/v0.162.1/`, `transcripts/v0.162.1-tool-final-turn.jsonl`) with end-to-end ingestion + replay-idempotency tests.
  - pd-cli: `pd health --host codex` now reports the runtime actually installed for hooks (PLUGIN_DATA) vs the marketplace-cache pin (`install.staleInstall` + blocker when it diverges with ingestion enabled), the canonical `~/.pd/runtime` adapter version, and the Codex CLI version observed in the newest rollout (`install.latestObservedCliVersion` + `cliStatus`); an unverified CLI with ingestion enabled is a §15 ready blocker with a nextAction — version or install incompatibility is no longer silent.
- Updated dependencies [6e60d84]
- Updated dependencies [0f94f8c]
- Updated dependencies [4ba83b7]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
  - @principles/core@1.292.0
  - @principles/host-runtime@0.9.0
  - @principles/install-layout@0.3.0

## 0.5.3

### Patch Changes

- 6317a63: Keep unresolved content references unresolved across evidence replays (Phase 1 closeout review P2-2). The evidence producers treated the STORED contentRef as an opaque truthy object when rebuilding an observation for a replayed source event: an already-stored `revision_reference_unresolved` reference (no payloadDigest — e.g. an activation whose artifact is missing) was re-emitted as `resolution: 'resolved'` without a digest. The normalizer rejects `resolved`-without-digest before the store's idempotent dedup branch runs, so replaying the SAME source event failed with `observation_contentRef_resolved_requires_payloadDigest` instead of landing as an idempotent duplicate — "record count unchanged" was the result of rejection, not idempotency (the real 2026-10-11 replay probe hit exactly this). Resolution is now upgraded to `resolved` only when a payloadDigest is actually present; digest-carrying (resolved) replays keep their digest and dedup as before. Fixed at all four producer sites (Codex prompt delivery + Codex deny chain, OpenClaw prompt delivery + gate enforcement chain); validator, oracle, and store semantics unchanged. `create-principles-disciple` rides along because the installer bundles the plugin. Regression tests drive the real recorder → ingress → store boundary on both hosts: unresolved first-record + replay lands as `duplicateCount: 1` with the original resolution preserved, and a new ingress boundary test pins digest-less-batch replay as an idempotent duplicate plus same-key-different-content as a reported conflict.

## 0.5.2

### Patch Changes

- 4b84634: Advance the Marketplace runtime pin to the already-published npm versions that carry the Phase 1 intervention-evidence face: codex-adapter 0.5.1 (codex-evidence-recorder), host-runtime 0.8.1 (intervention-evidence-ingress), core 1.291.2 (published by the 2026-10-11T03:51Z release train, carries the #1982 evaluator template-pairing fix). Verified by `npm run check:runtime-pin` (packaged capability probe S1–S5 PASS against npm-installed bytes) plus tarball content inspection of all three evidence modules (re-run against 1.291.2 after the train published it). The previous pin (0.4.7 / 0.7.11 / 1.287.6) predates the Phase 1 evidence recorder, so officially installed Codex hosts had no intervention-evidence surface (acceptance 2026-10-10 §7.2 G-Codex-1).
- Updated dependencies [4b84634]
- Updated dependencies [4b84634]
- Updated dependencies [4b84634]
  - @principles/core@1.291.3
  - @principles/host-runtime@0.8.2

## 0.5.1

### Patch Changes

- c20aef0: PRI-943: the pd-hook process boundary is now fail-open by construction, not by convention. The hook promises Codex `exitCode 0` (unconditional) plus exactly one JSON object on stdout whenever stdout stays writable, but three terminal paths could still abort the process with exit 1: the write-out tail (`stderr` loop, `stdout` JSON, `process.exitCode`) sat outside `main()`'s try, EPIPE from a host that closed the pipe arrives as an **async `'error'` event** no try/catch can reach (node then dies with "Unhandled 'error' event"), and `void main()` had no rejection handler. Each is now belted on its own — per-write guards, a guarded stdout serialization that falls back to `{}` (`hook_stdout_serialize_failed`, rc-8), persistent `'error'` listeners armed only on the entry path, and a last-resort entry `catch` that still emits `{}` when nothing reached stdout (best effort: if stdout itself is the failed stream, the object may not survive the dead pipe) — with a single bounded `hook_stream_failed` / `hook_fatal` diagnostic on stderr, never in the machine channel.

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
