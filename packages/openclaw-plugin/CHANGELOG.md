# principles-disciple

## 2.2.8

### Patch Changes

- 7d30045: Signals: bound the cost of correction detection instead of paying it on every message.
  
  - **Zero-match discovery is now budgeted.** Replaying live user turns showed that
    ~90% (93.5% in an earlier window, 90.9% in the most recent one) match no keyword
    at all, and every one of those used to start a Stage2 "discover a new
    correction phrase" call. `SignalCollectorConfig` gained
    `discoveryRateLimitPerHour` (default 6/hour, `0` = unlimited as before). Only
    zero-match discovery is limited — ambiguous hits are confirmations and stay
    unmetered — and the skipped calls are surfaced as `stage2DiscoverySkipped` in
    signal health, so the degradation is observable in `pd config doctor` rather
    than silent. Measured end-to-end through the production host with real messages:
    12 messages started 12 calls before, 6 after.
  - **Stage2 calls are bounded.** The classifier now resolves with
    `outputPathStrategy: 'json_mode_first'` and `maxRepairAttempts: 1`. On the same
    5 real messages the two strategies both needed one HTTP request, but
    `json_mode_first` finished in 11.5s total (max 3.5s) against 36.2s (max 23.9s),
    and it does not depend on the provider supporting tool calls.
  - **The observer stops re-running on unchanged input.** The periodic cycle skips
    when no user turn arrived since the last successful cycle (measured: 4ms versus
    14.1s for a real dispatch), and its payload now carries at most 40 messages
    truncated to 400 chars instead of every excerpt from 10 sessions (live measure:
    31.9KB → 23.5KB).
  - **One file lock per turn instead of two.** `recordUserTurn` /
    `recordAssistantTurn` used to take the trajectory write lock twice (session
    upsert, then the turn insert). Measured on real SQLite: 8.69ms → 4.47ms per
    turn over 300 writes, byte-identical rows, on the `before_prompt_build` path.

## 2.2.7

### Patch Changes

- 5349930: RuleCode host promotion loop (SPEC-RULECODE-HOST-PROMOTION-001 v0.1, A→B→C):
  
  - Host resolution: replace the "anything not Codex is OpenClaw" fork with an
    explicit openclaw/codex/workbuddy/unknown/multi-host routing. The OpenClaw
    historical default now applies ONLY to workspaces with no non-OpenClaw
    declaration or evidence — a WorkBuddy-only workspace can no longer inherit
    the OpenClaw capability claim (H02), and durable non-OpenClaw evidence
    whose declaration is missing fails closed for every known host, not just
    Codex.
  - Per-host capability contracts: Codex (`codex-v2@1`) and WorkBuddy
    (`workbuddy-v1@1`) contracts join the existing OpenClaw authority, with
    tool aliases taken from each host's real, evidence-locked vocabulary. The
    promotion shape validator binds to the resolver's contract version — a
    wrong-host contract fails `runtime_compatibility` instead of passing.
  - Shadow attribution (B3): `rulehost_evaluated` events carry `hostKind`;
    promotion shadow summaries count only the resolved promotion host's
    samples. Another host's samples and pre-attribution legacy rows count
    toward no host's threshold (H05). OpenClaw plugin rows are stamped too.
  - WorkBuddy V2 rule context: a provider over WorkBuddy's OWN trajectory
    (same-session tool_calls rows) replaces the blanket "no provider"
    boundary. WorkBuddy supplies no designGate fact (no attestation entry
    point exists there) and unavailable history degrades through the shared
    suspension contract with precise reasons. The V2 qualification gate now
    applies symmetrically: a Codex-stamped artifact never auto-executes on
    WorkBuddy and vice versa (SPEC §11.3/H13). pd-console rides inside the
    create-principles-disciple artifact.
  
    Review fixes (round 2, findings 1-3):
    - R1: `emergency_controls` no longer passes on contract shape + flag
      alone. A core-owned recovery-control registry (verified against the
      real pd CLI registrations and the Console emergency-pause route by
      cross-package contract tests) gates every probe; the fabricated
      `pd status` / `pd activation emergency-pause` commands were removed
      (they never existed), the global pause is honestly declared through
      its real Console surface, OpenClaw probes use the real `exec` tool,
      and a rule combination that blocks the recovery probes fails the
      check.
    - R2: tool_calls rows now carry producer host attribution
      (`host_kind`, stamped by every writer; legacy rows stay NULL and are
      never backfilled). The WorkBuddy provider consumes ONLY rows proven
      to be WorkBuddy's — a colliding Codex session can no longer lend its
      reads to a WorkBuddy read-before-write rule (precise
      unavailable reasons instead). The WorkBuddy PostToolUse channel
      contract classifies string responses as completed successes (the
      failure channel is a separate registration).
    - R3: `rulehost_unhealthy` events pass the same host-attribution
      filter as every other shadow event — a foreign host's anomaly can no
      longer fail (or gate) the target host's readiness.
  
    Review fixes (round 3, findings 1-2):
    - R3/P1: readiness now separates four evidence layers. Composition
      verification executes through the production boundary (every rule of
      candidate+live compiled by the production hardened evaluator, merged by
      the gate's mergeDecisions — a requireApproval escalation fails too);
      console-channel controls carry NO rule probe (their path never passes
      the gate; isolated tests prove the real pause route changes gate
      behavior); emergency_controls additionally requires per-evaluation
      TARGET-ENVIRONMENT reachability evidence — the CLI readiness spawns the
      real `pd activation list --json` subprocess against the target
      workspace (the expected activation must appear in its listing), the
      console proves the pause substrate readable. Absent/failed/mismatched
      evidence fails with `recovery_reachability_unverified`; nothing is
      cached, so no install inherits another's "verified" state.
    - R3/P2: host attribution now runs through DEDUP and FACT UPGRADE. All
      tool_calls dedup/upgrade queries (recordVerifiedToolOutcomes, the live
      PostToolUse path, governance admission) are host-scoped for known
      hosts: a colliding row from another host is a different record (no
      swallowing), a legacy NULL row is never implicitly claimed (a new
      attributed row lands beside it), same-host re-delivery stays
      idempotent, and unknown→final upgrades only same-host rows.
  
    Review fixes (round 4, findings 1-2):
    - R4/P1: recovery reachability is PER-CAPABILITY. The evidence type gains
      a capabilities matrix; emergency_controls requires every registry
      capability (pd_status, rulecode_deactivate, rulecode_global_pause,
      owner_review_access) to carry its own current, channel-matched,
      workspace-matched entry — missing, duplicate, unknown, channel-mismatched
      or failed entries fail closed with stable reason codes. The shared
      host-runtime probe module executes the REAL pd CLI subprocesses: the
      status listing (pd_status) and a new non-destructive
      `pd activation deactivate --dry-run` validation path (rulecode_deactivate
      — real parsing, workspace binding, and target resolution, returning
      BEFORE any governance audit write or store mutation). Console readiness
      assembles its own evidence: the same CLI subprocess probes, a
      transaction-rollback write probe for the pause substrate (table asserted
      unchanged after rollback), and a route-served signal for owner_review
      (real authenticated Console HTTP entry observed in the same evaluation).
      CLI-process promotion honestly reports console-channel entries as NOT
      verified and refuses (fail closed); commit-failure semantics stay
      covered at the service level.
    - R4/P2: real-SQLite dedup coverage extended beyond one helper: the
      production pain-evidence handler (both dedup routes), the governance
      admission entry (both dedup queries), and the Codex ingestion chain each
      get cross-host collision, legacy-NULL, same-host idempotency, and
      terminal-protection regressions against real production entries.
  
  Round 5: verify recovery controls under actionable V2 facts and history,
  normalize probe paths in linear time, and compile RuleCode separately from
  its fixed VM JSON bridge without weakening sandbox limits.

## 2.2.6

### Patch Changes

- 5ad3954: Fix the OpenClaw PD plugin payload so a real `agent exec` round no longer times out at workspace-plugin publication. The shipped plugin component is now the self-contained `dist/bundle.js` plus its single native dependency (`better-sqlite3`): the historical `file:./core` rewrite and the inlined-dependency list are gone from `plugin/package.json`, so an install carries 322 files / 33 MB instead of 16,425 files / 126 MB (and OpenClaw's per-round plugin-source capture drops from ~19,167 files / 153 MB per build to 321 files / 33 MB). Also: the bootstrap executor is now delivered from the payload's own `release-manager` component instead of the executing package — during an update the executor used to re-deploy its own stale code, so `installs.json` regenerated by pre-PRI-1021 code could never converge; `release-locks/plugin` is regenerated for the lean manifest, and the plugin package's own manifest no longer lists `@principles/core` as a runtime dependency (it is bundled at build time). PRI-1037 S9.

## 2.2.5

### Patch Changes

- 07242b7: Legacy principle-injection removal: Runtime V2 activations become the only
  prompt injection authority.
  
  - Plugin: delete the unconditional `<evolution_principles>` block, the
    plugin-local selector shim (`core/principle-injection.ts`), inline
    probation injection (1000-char sub-budget and its session bookkeeping),
    cross-block dedup plumbing (`excludePrincipleIds`, `crossBlockDuplicateIds`,
    `all_deduped_against_legacy`), and probation feedback attribution
    (`handleProbationFeedback` / `recordProbationFeedback`). `prompt.ts` reads
    activations via `readActivatedPrinciples` only.
  - Core: delete `prompt-builder/principle-selection.ts`
    (`selectPrinciplesForInjection`, `formatPrinciple`,
    `DEFAULT_PRINCIPLE_BUDGET`, `InjectablePrinciple`,
    `PrincipleSelectionResult`, `PromptInjectionPart`) and the
    `evolution_principles` step in `truncateInjectionToBudget`.
  - Host runtime: drop the now-unused exclusion input and diagnostic fields from
    `buildActivePrinciplePromptContext`.
  - Event schema: `legacySelectedCount` / `legacyTotalChars` /
    `legacyTruncated` / `crossBlockDuplicateIds` stay optional for reading
    historical events; the plugin no longer emits them, so `pd principles stats`
    reports legacy counters only for turns recorded before this change.
  
  `<core_principles>` (static T-01..T-10 axioms) and Runtime V2
  `<directive>` injection are unchanged.
  
  Behaviour difference to know about before upgrading: a principle that lived
  ONLY in the legacy reducer (active/probation, no Runtime V2 activation) used to
  reach the prompt through the deleted block and no longer does. On the Owner's
  machine that set is empty — 0 of the 847 scanned prompt events ever carried a
  non-zero `legacySelectedCount`, so no turn ever showed a legacy-only principle.
  That census proves "no legacy-only injection happened here", not "every
  workspace is empty": if another workspace still holds active principles with no
  V2 activation, review them with `pd principles stats` and activate them through
  the Owner path before upgrading.
  
  Legacy probation therefore ends with this change: with no probation block there
  is no per-tool feedback attribution, so `recordProbationFeedback` (the only
  path that could promote probation → active at `PROBATION_SUCCESS_THRESHOLD`) is
  deleted too. Existing probation entries keep expiring
  (`probation_expired`) instead of graduating; promotion is Owner-driven through
  Runtime V2 activations.
- 53a285f: Legacy pruning-review chain removal (follow-up to the legacy principle-injection
  removal): the pruning audit log, its injection mask and the operator commands
  that wrote it are deleted, together with the dead legacy subtree reader.
  
  `pd-cli` takes a minor bump rather than a patch because two operator-visible
  subcommands disappear from the CLI surface. `pd runtime pruning report`,
  `explain` and `orphans` keep their contract; `pd runtime pruning review` and
  `pd runtime pruning rollback` are removed, so any script or habit that calls
  them must stop (they wrote a log that nothing reads any more, which made
  `archive-candidate` look like a governance decision that changed nothing).
  
  - Core: delete `runtime-v2/pruning-review-log.ts` (`appendPruningReview`,
    `listPruningReviews`, `PruningReviewDecision`, `PruningReviewRecord`,
    `AppendPruningReviewInput`) and `runtime-v2/pruning-mask.ts`
    (`buildMaskedPrincipleSet`, `getCachedMaskedPrincipleSet`,
    `clearPruningMaskCache`) and their barrel exports. `PruningReadModel` and
    `removeOrphanReferencesFromLedger` stay.
  - pd-cli: `pd runtime pruning` keeps `report`, `explain` and `orphans`; the
    `review` and `rollback` subcommands are gone (`rollback` existed only to
    un-mask a principle for the legacy injection block).
  - Plugin: delete `WorkspaceContext.getActivePrincipleSubtrees()`, which no
    production path called, and the Story A "masked legacy overlap" scenario that
    pinned the mask contract. Retire the `sync-plugin` npm entry point of the
    deactivated dev install chain (the refusing `scripts/sync-plugin.mjs` stub and
    its guard test stay).
  
  Nothing reads the historical `<workspace>/.state/pruning_reviews.jsonl` any more;
  existing files are left untouched and are now inert data.
  
  Prompt injection, pruning health reporting, orphan cleanup and the console
  health panel are unchanged: the mask only ever filtered the `<evolution_principles>`
  block that the previous step removed, so on this installation it had no effect
  left to lose.
- Updated dependencies [07242b7]
- Updated dependencies [53a285f]
  - @principles/core@1.297.4

## 2.2.4

### Patch Changes

- 7f1afe2: Legacy cleanup batch 1: remove retired code that had zero production consumers.
  
  - Gate A (`PainDiagnosticGate`) finally retired end to end: the core
    `runtime-v2/pain-gate` policy, its 14-name barrel surface, and the archived
    plugin adapter are deleted. Gate B (`TriggerController` + `evidence-triage`)
    remains the only admission authority.
  - Delete two orphan plugin core modules with zero production importers:
    `workflow-funnel-loader.ts` (stale duplicate of the core loader) and
    `thinking-os-parser.ts` (only two tests imported it; its pure parser moved
    to a test helper).
  - Delete the `@principles/host-runtime` pain-ingress re-export shim; its one
    production consumer now imports the core semantic authority directly, and
    the SPEC §8.2 matrix test moved next to that authority.
  - Reduce the deactivated legacy dev install scripts (`scripts/install.mjs`,
    `packages/openclaw-plugin/scripts/sync-plugin.mjs`) to their PRI-868
    refusal guard, deleting the unreachable installer bodies and their
    test-only helper libraries.
  
  No runtime behavior change: every removed module was unreachable or
  test-only after PRI-454 and PRI-868.
- Updated dependencies [7f1afe2]
  - @principles/core@1.297.2

## 2.2.3

### Patch Changes

- 004acb4: Unify the RuleCode textual-basis anchoring check (continuous verbatim span) across the scribe success boundary and the artificer intent preflight, feed scribe validator rejections back into the next model attempt with cross-epoch freshness, and add one bounded authenticated source-correction recovery per rule candidate that CAS-reopens the original needs_human_review artificer on the new scribe epoch. Leases now count attempts per revision epoch while run ordinals stay globally sequential, so reopened epochs actually receive their original maxAttempts. The bundled Console (ships inside create-principles-disciple) gains an authenticated source-correct-once entry whose receipt binds the Owner actor, binding revision, artifact digest and stop reason. Owner review R6: bash-command risk classification is unified across the host gate, the OpenClaw enrichment and golden-trace replay (git mutations and arbitrary code execution count as mutating); approval-gate rules must keep read-only investigation allowed under not_approved, verified by a system-generated counterfactual; the scribe success boundary rejects undeclared approval dependencies.
- Updated dependencies [004acb4]
- Updated dependencies [c7d3f29]
  - @principles/core@1.297.1

## 2.2.2

### Patch Changes

- e1d6ffc: PRI-1023: retire the `openclaw-cli` sub-agent runtime backend (ADR-0029). pi-ai is now the only backend PD executes internal agents on; OpenClaw stays supported as a *host*, never as a delegated CLI agent session. Legacy `type: openclaw` profiles still parse, redact and list, but they are read-only: readiness always answers `needs_setup` with a pi-ai next action, `createAdapterConfigFromProfile` fails loud instead of producing an adapter, the console no longer offers, creates or updates the retired type (existing profiles stay listed and labelled retired, editable only by deleting and recreating them as pi-ai), and the `--openclaw-local` / `--openclaw-gateway` / `--agent` CLI flags are gone in favour of `reason: 'retired_runtime_kind'` refusals. Rollback is source-level: revert this PR.
- Updated dependencies [e1d6ffc]
  - @principles/core@1.297.0

## 2.2.1

### Patch Changes

- 1b13597: SPEC-PD-PAIN-RECALL-CLI-001: new read-only `pd pain recall` command — recalls the historical pains a principle verifiably derives from, so a host Agent can check a principle's origin, trigger boundary, or current-situation fit on demand. Only two authoritative association edges are honored (`reuseEvidence[].painId`; `derivedFromPainIds` resolved through its production contract as candidate ids via `tasks.input_ref`), results dedup by real pain id while keeping every evidence ref, `--context` re-ranks deterministically without any model/network call, and per-source availability separates `not_recorded` from `unreadable` (`source_missing`/`source_unreadable` never masquerade as `no_matches`). All three hosts' `pd-cli-operator` skills (Codex plugin, OpenClaw en/zh templates, WorkBuddy adapter) now document when to call it, how to read the JSON contract, and the diagnosis-is-not-owner-statement rule.

## 2.2.0

### Minor Changes

- 0f2d1fb: PRI-1020: Owner-declared context windows (SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001). A new optional `promptBudget` section in `.pd/config.yaml` lets the Owner declare a model's real context window (`declaredContextWindowTokens` + optional per-host `hosts` overrides). It is tier 0 of the injection budget chain — outranking host-reported windows and the model catalog — and scales the budget with the same formula as #2093 (262144 tokens → 4096 chars, cap 16000). This unblocks Codex/WorkBuddy hosts whose adapters carry no window facts and whose custom model ids can never match the installed catalog (previously locked at the 2000-char fallback forever). Console surfaces forecast under the declared basis when no fresh runtime observation exists; a fresh observation still wins. Delete the section to roll back to the previous behavior. Config validation fails loud on malformed values (policy plausibility bounds, closed host set, unknown keys).

### Patch Changes

- Updated dependencies [0f2d1fb]
  - @principles/core@1.296.0

## 2.1.12

### Patch Changes

- 5c383e5: Unify PD host skills around four consistent capabilities, clarify Owner governance and evidence boundaries, and align the published skill bundles and Codex recovery guidance.
  
  Review-round additions: `pd run list/show` gain an optional `--workspace` (governance-workspace reads independent of cwd); Codex skills route every shipped script through `pd-locate.cjs --exec` — one authoritative locator that resolves the plugin root once, fails loud on marketplace ambiguity or a missing script instead of silently falling back to an older version; WorkBuddy near-miss explicit-statement prefixes get an actionable format notice; `pd-review` startup text no longer presents CLI approval as an agent fallback.

## 2.1.11

### Patch Changes

- 765d5c4: Decouple the signal_confirmations batch consumer from the correction_observer flag (AUDIT-P2-04, 2026-10-21 remediation): the periodic cycle now starts when signal_collector is enabled (default on) even with correction_observer off (default), so persisted pending confirmations are consumed instead of remaining invisible permanent-pending records. Keyword optimization remains exclusively gated by correction_observer and is never silently enabled. Batch skips due to an unavailable classifier are now counted (stage2BatchSkipped) and pd config doctor classifies backlog-plus-skip as degraded with an actionable next action.
- d00ea5c: Signal detection sync-path and observability hardening (AUDIT-P2-01/P2-02, 2026-10-21 remediation): defer all health-counter file writes off the before_prompt_build synchronous call stack (degraded/zero-hit paths previously did a synchronous read-modify-write per message); add stage2Invocations and stage2BatchSkipped counters with backward-compatible signal-health parsing and pd config doctor display; add sync-path regression tests and a repeatable detectSync performance baseline. SQLite queue records stay synchronous by design.
- Updated dependencies [765d5c4]
  - @principles/core@1.295.2

## 2.1.10

### Patch Changes

- d3796e4: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.
  
  - Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match (host-declared provider) → legacy fixed 2000-char fallback with a bounded machine-readable reason code — provider-less name-only matches NEVER confirm (v0.2 trust amendment: a unanimous name cannot prove the deployment is not a custom endpoint). Budget formula `min(16000, max(1250, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens). The 1250 floor is MEASURED (shared route full render of one minimum viable principle = 849/1204 chars with self-report off/on — lower floors re-create the audited 32K zero-injection defect); the 16000 cap is the Owner target upper bound (1M windows map to 15625).
  - Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 1250..16000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 16000 max tier; cross-host aggregation is monotone — only ALL-hosts overflow brands an entry oversized everywhere); injection events carry budget provenance INCLUDING the bounded `budgetFallbackReason` code.
  - Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
  - Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.
- Updated dependencies [d3796e4]
  - @principles/core@1.295.0

## 2.1.9

### Patch Changes

- 0dc0431: chore(deps): bump @sinclair/typebox 0.34.49 -> 0.34.52（#2087）。typebox 是 core / plugin / console 的运行时 dependency，console 随 installer 分发，故 core、plugin 与 installer 各声明 patch。
- Updated dependencies [0dc0431]
  - @principles/core@1.294.2

## 2.1.8

### Patch Changes

- d91b9e0: PRI-1011: an LLM run whose output budget the provider rejects now recovers instead of burning all retries on the same rejected value.
  
  - core: `completeWithRetry` recognises the "requested max_tokens exceeds the maximum output tokens" signature (resolved error responses and thrown errors alike) and halves the budget for the next attempt of that same run — a profile that was never rejected keeps sending exactly what it sends today. A profile that relies on pi-ai native defaulting gets an explicit number for the retry, because resending `undefined` would resend the value the provider just rejected.
  - The ladder stops at a 4096 floor: below that a structured answer is routinely cut off, so further halving would trade a provider rejection for a silent truncation. At the floor the run still fails loud as `execution_failed` with the provider evidence intact.
  - Each step emits an observable `llm_max_tokens_downshift` event (from/to, provider, model, attempt, provider evidence), so the Owner can see what was tried rather than only that something failed.
  - Rate limits, timeouts and unrelated 4xx keep their existing classification and trigger no downshift.
  
  This release train patches `@principles/core`; the correction observer and the other internal agents call it through the bundled `principles-disciple` plugin, and the installer bundles the plugin, so both must be declared in the same plan (release-intent rule N-5/C4). No plugin or installer code changes.
- Updated dependencies [1eb5293]
- Updated dependencies [d91b9e0]
  - @principles/core@1.293.3

## 2.1.7

### Patch Changes

- 807fcab: 修正纠正词库到顶后学习通道冻结的根因：满 200 词时按证据淘汰最没用的学习词（seed/user 永不被淘汰），不再抛错；UPDATE/REMOVE 与 ADD 共用同一条词身份规则，未命中只记一次可读跳过；拒绝把动作词当 term 入库；学习不再删除 Owner 播种词；每次词库变更进 SYSTEM 日志。Stage2 回写不再用判词覆盖命中词，观察员据此拿到真实的 REMOVE 证据。
- Updated dependencies [807fcab]
  - @principles/core@1.293.1

## 2.1.6

### Patch Changes

- 06152af: Connect Codex Owner-labelled behavior evidence to the shared internalization preflight. Reuse one validated assembler across OpenClaw, Codex and evidence attach/resume; read trajectory data without creating or migrating it and preserve host-specific semantics. Missing labels reach Owner review without model calls or attempts; missing/corrupt sources remain observable source faults.
- Updated dependencies [574954a]
  - @principles/core@1.293.0

## 2.1.5

### Patch Changes

- eaf52c4: PRI-982 (SPEC-PD-IAER-001 FR-02/FR-04/§4.2): consumer-side evidence preflight + authoritative channel routing for Artificer. The shared consumer cycle resolves the target channel from `pi_metadata.channel` (seed-time bridge authority): only `code_tool_hook` tasks enter ArtificerL2, prompt-channel tasks keep their legal non-L2 pipeline, unresolvable channels refuse to guess. `code_tool_hook` tasks pass a new `preflightArtificerOwnerEvidence` gate BEFORE any runner construction: no Owner selection or an invalid one atomically transitions the task to `needs_human_review` (CAS via `updateTaskIfDiagnosticJsonUnchanged`, humanReviewContext with the stable FR-04 reasonCode + nextAction) with zero LLM calls, zero run records and no attemptCount consumption; a missing host `behaviorEvidence` port degrades observably and leaves the task pending (SPEC §6.2). New optional PITaskMetadata field `ownerEvidenceSelection` (single shape authority shared with the readiness gate; bad values fail the whole metadata closed). The OpenClaw auto-consumer wires the production `BehaviorExamplePackAssembler` through the port (same assembly contract as run-rulehost). ArtificerRunner/prompt builder become channel-aware so the evidence contract no longer kills prompt-channel tasks, while injected packs keep full v2 echo protection on every channel. New telemetry events `artificer_evidence_readiness_checked` / `artificer_blocked_on_owner_evidence` (the latter persisted via the workspace critical-events allowlist).
- eaf52c4: PRI-983 (SPEC-PD-IAER-001 FR-03/FR-06/FR-07): Owner evidence attach and controlled resume. New `pd runtime internalization evidence list|attach|resume` command group (all default dry-run, `--confirm` mutates): list surfaces Artificer tasks blocked on evidence (needs_human_review + stable FR-04 reasonCode) with pain linkage, missing fields and next actions; attach assembles through the production BehaviorExamplePackAssembler and persists the Owner selection into `pi_metadata.ownerEvidenceSelection` via the narrow diagnosticJson CAS with new provenance fields (revision, contentDigest, ownerOperation, attachedAt — ABSENT=legacy, single shape authority shared with the readiness gate); the task stays needs_human_review (attach never unblocks). resume re-assembles, verifies the stored sha256 contentDigest (mismatch → `owner_behavior_examples_stale`; cross-session → `owner_behavior_examples_scope_mismatch` via a new typed, structural scope-error classification in the plugin assembler — no message sniffing) and performs the atomic authority reset through the single recovery authority `ownerRetryNeedsHumanReviewTask`, which gains an optional CAS precondition (expected diagnosticJson + expected status) so at most one concurrent resume wins (T06); the attempt-budget reset is explicit, digest-verified and audited with previousAttemptCount in the existing `.state/recovery_actions.jsonl` append-only log. FR-07: the run-rulehost BEP gate and its confirm-time assembly now derive refusal reasons from the same shared Evidence Readiness judgment (`assessEvidenceReadiness`) the consumer preflight uses — identical inputs produce identical stable reason codes on both production entries, with no V1 fallback and unchanged command parameters. New telemetry events `artificer_owner_evidence_attached` / `artificer_owner_evidence_resumed` (bounded payloads, no raw trajectories).
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
- Updated dependencies [eaf52c4]
  - @principles/core@1.292.2

## 2.1.4

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/core@1.292.1

## 2.1.3

### Patch Changes

- 6e677f8: fix(release): 把 openclaw-plugin 的 `@principles/core` 依赖范围对齐到一个**已发布**版本。
  
  ## 问题
  
  `packages/openclaw-plugin/package.json` 声明 `"@principles/core": "^1.291.6"`，
  但 **1.291.6 从未发布到 npm**（registry 上 `@principles/core` 的 latest 仍是 1.291.5）。
  
  该范围由上一个 Version PR（#2015）的 changesets「Updated dependencies」机制自动写入，
  而那次发布从未执行，范围就此悬空。一旦某个 Version PR 把 core 继续 bump（例如 1.291.7），
  `^1.291.6` 的下界就不再等于 workspace 版本，`decidePending()` 判为 `broken`，
  `packages/openclaw-plugin/tests/package/published-host-runtime-bundle.test.ts`
  （以及 `test:host-runtime-parity`）随即抛错：
  
  ```
  @principles/core@^1.291.6 resolves to nothing on the registry and is not a
  changesets-materialized version of this workspace (1.291.7) — a genuinely
  unresolvable publish range.
  ```
  
  ## 修法
  
  把范围改为 `^1.291.5`——registry 上真实存在的版本，于是 `decidePending()` 走
  `published` 分支：套件**真实运行**（而非因 pending 窗口被跳过），实际完成
  `npm pack` → 隔离安装 → import bundle 的完整发布契约验证。
  
  这不是降低需求：`^1.291.6` 本就是 changeset 自动生成的，不代表 plugin 的真实最低
  core 版本。合并后 changesets 会在下一个 Version PR 中把该范围自动对齐到 core 的新版本。
  
  ## 附带影响
  
  `package-lock.json` 同步更新。
  
  > 注：1.291.6 / 2.1.2 这两个已 materialize 但未发布的版本仍悬在发布流程上，
  > 需要单独补发布或由 release train 处理——不在本 changeset 范围内。
- Updated dependencies [6e60d84]
- Updated dependencies [0f94f8c]
- Updated dependencies [4ba83b7]
- Updated dependencies [5e794be]
  - @principles/core@1.292.0

## 2.1.2

### Patch Changes

- 69fa3f3: chore(deps): bump js-yaml 5.4.1 -> 5.4.3（#2011）。js-yaml 是 core / host-runtime / plugin / pd-cli / console 的运行时 dependency，console 随 installer 分发，故这 4 个可发布包与 installer 各声明 patch。
- Updated dependencies [69fa3f3]
  - @principles/core@1.291.6

## 2.1.1

### Patch Changes

- 6317a63: Keep unresolved content references unresolved across evidence replays (Phase 1 closeout review P2-2). The evidence producers treated the STORED contentRef as an opaque truthy object when rebuilding an observation for a replayed source event: an already-stored `revision_reference_unresolved` reference (no payloadDigest — e.g. an activation whose artifact is missing) was re-emitted as `resolution: 'resolved'` without a digest. The normalizer rejects `resolved`-without-digest before the store's idempotent dedup branch runs, so replaying the SAME source event failed with `observation_contentRef_resolved_requires_payloadDigest` instead of landing as an idempotent duplicate — "record count unchanged" was the result of rejection, not idempotency (the real 2026-10-11 replay probe hit exactly this). Resolution is now upgraded to `resolved` only when a payloadDigest is actually present; digest-carrying (resolved) replays keep their digest and dedup as before. Fixed at all four producer sites (Codex prompt delivery + Codex deny chain, OpenClaw prompt delivery + gate enforcement chain); validator, oracle, and store semantics unchanged. `create-principles-disciple` rides along because the installer bundles the plugin. Regression tests drive the real recorder → ingress → store boundary on both hosts: unresolved first-record + replay lands as `duplicateCount: 1` with the original resolution preserved, and a new ingress boundary test pins digest-less-batch replay as an idempotent duplicate plus same-key-different-content as a reported conflict.

## 2.1.0

### Minor Changes

- d5732f8: PD v2 Phase 1 Evidence Foundation (ADR-0027): normalized intervention evidence ledger.
  
  - core: intervention evidence contract + deterministic normalizer (rc-1..rc-5 trust boundary, anti-forgery cross-field rules), append-only SQLite ledger tables inside the existing state.db (idempotent same-source replay, reported source conflicts, immutable records, activation occurrence snapshots), busyTimeoutMs connection option, and the four-query audit read contract.
  - host-runtime: shared intervention evidence ingress — the single validated entry every host source uses; never throws, never waits on locks (busyTimeoutMs 0), degrades with structured reason + nextAction.
  - openclaw-plugin (principles-disciple): evidence wiring on both legacy and shared routes — prompt delivery attempts (submitted/attempted, host consumption never claimed), enforcement chains on gate block/auto-correct (runtime_loaded delivery, runtime_verified application with explicit proof boundary, episode, effect), agent_claimed self-report mirroring; gated by the existing principle_receipt_ledger flag.
  - codex-adapter: evidence adapter on the shared ingress — UserPromptSubmit delivery attempts after the durable event-log line, deny chains recorded only after successful stdout encoding; honest capability matrix (self_report Unsupported, enforcement Unknown per PRI-780).
  - create-principles-disciple (ships pd-console): four read-only evidence-audit queries under /api/v1/receipts/evidence-audit plus the authenticated Owner outcome input POST /api/v1/evidence/outcomes (closed body contract, server-derived actor), and an evidence-audit section on the principle detail page.
  
  No effectiveness scoring, ranking, or automatic governance action anywhere (Phase 1 records facts only).

### Patch Changes

- 0b981bb: OpenClaw 提示词构建事件记录实际宿主与独立事件身份；旧日志缺少来源时保持未知，避免同 run 跨宿主或多次构建被合并。
- Updated dependencies [d5732f8]
- Updated dependencies [0b981bb]
  - @principles/core@1.290.0

## 2.0.10

### Patch Changes

- 34ba089: Console approval cards no longer render the internal `unlinked:<artifactId>`
  machine id as the card title on the second path that still produced it
  (PRI-941). PRI-940 closed the case where the pinned draft artifact has left the
  artifact store; an artifact row that still exists can degrade the same way — its
  content yields no extractable description and its lineage resolves to nothing,
  so the grouping key becomes `unlinked:<artifactId>` while `artifactUnavailable`
  stays unset, and that machine id was used as the Owner-visible title. The UI
  title rule now refuses any title shaped like the synthesized grouping key, and a
  card whose title actually degraded states both reasons ("lineage cannot be
  resolved to a principle, and no readable title could be extracted from its
  stored content") instead of going blank without explanation — a candidate that
  does have a readable title gets no warning. `artifactUnavailable` keeps its
  original meaning: the PRI-940 wire contract still asserts that an existing
  artifact carries no such flag. Approve/edit/reject behavior, the `unlinked:`
  grouping key and the ledger itself are unchanged.
- c66c956: Two "view the full evidence chain" links in the console now open a page instead
  of a blank screen (PRI-942). Both pointed at `/evidence`, a route that has never
  been registered: the console's inner route table has no wildcard fallback, so the
  sidebar stayed put while `<main>` rendered nothing — the link looked like a
  failure of the evidence chain rather than a dead address. They now point at
  `/pain`, the only page in the product that actually fetches and renders the
  evidence chain, and it needs no id, so it cannot 404 and never puts a machine
  identifier in the URL. A new static guard in the navigation test walks every
  in-app link the console UI writes with a visible path: literal `to` targets in
  all their quote forms, plus the static part of a target that only becomes dynamic
  after an interpolation marker. Each must resolve against the route table App.tsx
  already publishes, so the next dead link fails CI instead of showing up as an
  empty panel. Landing is not anchored to the individual candidate yet (it opens
  the top of the chain list); per-candidate anchoring is tracked separately.

## 2.0.9

### Patch Changes

- 71c8c93: Console approval cards no longer render the internal `unlinked:<artifactId>`
  machine id as the card title when the pinned draft artifact has left the
  artifact store (PRI-940). Real case: a pending approval pinned to a scribe
  revision that a later run superseded showed `unlinked:pi-art-scribe-…` as the
  card title, and the Owner could not tell what the card was about. The grouped
  model now reports `artifactUnavailable` for such cards; the UI replaces the
  machine id with the localized untitled copy and shows a visible note
  explaining that the draft original is gone (likely superseded), that
  rejecting is a safe choice, and where the raw artifact ID remains reachable
  (the edit section's current-artifact field). Approve/edit/reject behavior
  and the `unlinked:` grouping key are unchanged.

## 2.0.8

### Patch Changes

- df9e555: PRI-917 v0.3.3 (OD-PRI917-05): Reuse Review Gate — automatic candidate intake now consults the semantic reuse evaluation capability before creating a Principle.
  
  A `reuse` recommendation parks the candidate (`refused/reuse_pending_owner`): no Principle is written, no evidence is appended, the candidate stays pending for the Owner, and the bridge emits an observable `reuse_gate_triggered` event plus a `reuse_review_required` outcome pointing at `pd candidate review --decide reuse|create`. `create`/`uncertain` recommendations and every evaluation failure degrade to normal creation (learning never blocks). `reuseEvaluation.enabled=false` restores the exact pre-v0.3.3 behavior.
  
  Also fixes the R5 "two-heads-block" defect: `pd candidate review --decide reuse` no longer lets the PRI-442 admission pre-check reject low-confidence candidates — a reuse verdict creates nothing, so the ledger-quality gate does not apply (the `--decide create` pre-check is unchanged).
  
  PR review fixes (4×P2, PRI-938): the bridge cache key now folds in the reuse-gate switch so a long-lived host picks up `reuseEvaluation.enabled` toggles in both directions (T11 rollback without a restart); mixed batches and replays keep parked candidates visible (`reuse_review_required` degraded outcome, Codex worker `reuseReviewRequiredCandidateIds`, OpenClaw `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` log gated on the park disposition); `pd diagnose` / `pd pain-retry` render parked candidates with review guidance and exclude them from `internalize` next-action lists.
  
  Follow-up review fixes: evaluation profile and timeout changes invalidate the cached reuse hook. Replay verifies the original diagnosis admission and performs a read-only reuse check before reporting a parked candidate, preserving failed-intake and gate-disabled behavior without additional persisted state.
  
  Owner-approved configuration hardening: constructing CandidateIntakeService with both reuseRecommendation and reuseDecision now fails explicitly before either callback or any candidate mutation, instead of silently prioritizing the decision channel.
- Updated dependencies [df9e555]
  - @principles/core@1.289.0

## 2.0.7

### Patch Changes

- 7421049: The console's prompt-injection budget forecast now mirrors the production
  selection policy instead of silently defaulting to the legacy FIFO prefix
  (PRI-935). The forecast previously called the budget selector without its
  round key, which did not make it conservative — it selected a different
  policy, one that structurally excludes the newest activation from every
  truncated selection. The console therefore told the Owner an approved
  principle "will NOT enter agent behavior until older ones are deactivated"
  while the live injection path rotates and injects it within a bounded number
  of user turns, pushing Owners to deactivate healthy principles.
  
  buildLivePromptInjectionProjection now accepts the caller's round key and
  reports the policy it actually ran, the eligible count, whether production
  rotates on this route, and the set of activations reachable under some round.
  Reachability is a property of the policy rather than of a single round, so a
  console with no session round key can still distinguish an activation that is
  merely rotated out of the current window from one that is genuinely starved.
  Approve now emits injection_budget_queued for the queued case — with a bounded
  "within at most N consecutive user turns" statement and an explicit note that
  deactivating older principles is not required — and reserves
  injection_budget_excluded for real starvation, no longer asserting a FIFO
  ordering the production route does not use. The pre-decision queue badge and
  both locales follow the same policy, and the raw English server text is
  collapsed behind a native details element so the toast no longer renders as one
  mixed Chinese/English block (still preserved verbatim).
  
  The shared host route deliberately passes no round key and continues to report
  legacy_fifo_prefix_v1, so cross-host fairness remains PRI-930 and is not
  claimed here. All new projection fields are optional; payloads without them
  validate as before and render policy-agnostic copy.
- Updated dependencies [b50ec74]
  - @principles/core@1.287.7

## 2.0.6

### Patch Changes

- 276efe4: A workspace pointer that does not name one fixed directory is no longer
  resolved. A value that lost its separators in transit —
  `"D:.openclawworkspace"` for `D:\.openclaw\workspace` — used to be handed to
  `path.resolve()`, which turned it into a plausible absolute path that depends
  on the process working directory; a root-relative value such as `\workspace`
  was anchored to whichever drive the caller was on. The same config could then
  send governance state (`.pd/state.db`, `.state/trajectory.db`) to a different
  directory depending on which process read it, with no warning.
  
  The plugin now skips such a candidate, continues with the next declared source
  (env > config > default is unchanged), and logs the refusal together with the
  source it fell back to. The installer refuses such a workspace before any side
  effect, rather than only when writing the config pointer. Values that carry
  their own drive, or a UNC share, are unaffected (PRI-931).

## 2.0.5

### Patch Changes

- 50ed22e: Prompt principle injection now rotates deterministically under the fixed
  2000-char budget instead of always packing the oldest prefix, so a live,
  eligible, individually-fitting principle can no longer be permanently starved
  by its position (PRI-904). The rotation round is the session-local user-turn
  ordinal already persisted in the trajectory database — an existing fact, read
  through the registered trajectory-store seam — so consecutive rounds advance
  by exactly one and N rounds cover all N eligible positions: a bounded
  opportunity window with no new persisted scheduling state, no randomness and
  no clock. Non-fitting entries no longer terminate the scan; oversized entries
  are reported separately; the injection event carries selectionPolicy,
  eligibleCount, rotationStartIndex, the round ordinal that produced the
  selection, and schema-bounded dropped/oversized activation id lists (max 16)
  so truncation is explainable and traceable. The legacy FIFO prefix behavior
  remains the rollback baseline whenever no round ordinal is available.
- Updated dependencies [50ed22e]
  - @principles/core@1.287.6

## 2.0.4

### Patch Changes

- 4ced615: OPT-002 (runtime-v2 barrel narrowing): the plugin's satellite bundles no longer pull the LLM SDK graph. Six shared plugin modules switched their VALUE imports from the `@principles/core/runtime-v2` barrel to the eight narrow leaf subpaths (type-only barrel imports unchanged; exported names unchanged), and `@principles/core` exports gained those additive subpaths (`./runtime-v2/store/workspace-leak-guard`, `./runtime-v2/feedback/redact-sensitive`, `./runtime-v2/types/event-types`, `./runtime-v2/trajectory-schema`, `./runtime-v2/internalization/{rule-host-input-builder,rule-context-v2,behavior-example-pack,tool-semantic-registry}`). governance-audit.js drops 2,783,013 → 70,786 bytes (−97.5%) and rulehost-evidence.js 2,826,401 → 60,244 bytes (−97.9%); bundle.js is byte-identical (4,151,557) — the main package keeps its LLM runtime through its own direct barrel import. `runtime-v2/index.ts` and all existing exports are untouched. A build-level satellite purity guard (`scripts/build/check-satellite-purity.mjs`, wired into `esbuild.config.js`) now fails any plugin bundle build that reintroduces pi-ai / pi-agent-core / anthropic / openai / genai / undici inputs into the satellite outputs, so the invariant no longer rests on discipline alone.
- Updated dependencies [4ced615]
- Updated dependencies [de38d90]
  - @principles/core@1.287.3

## 2.0.3

### Patch Changes

- df43600: PRI-899: effect receipts now carry the activation that produced them, so behavior evidence JOINs back to its activation. The `principle_applications.activation_id` column, the optional `recordPrincipleApplication` input and the presence-path propagation all already existed — every EFFECT write point simply passed nothing, leaving 93/93 effect rows NULL and `JOIN activations` at 0. The legacy hook path now passes `report.liveDecisionActivationId` for `rule_blocked` and `auto_correct_applied` (that value was already in scope and already consumed by the `rulehost_evaluated` event); the shared-gate deny path recovers the same fact from the `metadata.evaluations` live entry and threads it through `accountSharedDeny`; and the prompt-channel `self_reported` row resolves the reported principle to the activation carried alongside it, reusing the single pairing derivation that already fed the presence receipt. Unattributable decisions — no winner, shadow-only, or absent metadata — still write an UNLINKED receipt exactly as before, so lineage is never fabricated and shadow activation ids are never promoted to live.
  
  PRI-900: adds an experiment-level Behavior Signature declaration (`docs/experiments/pri-836/behavior-signature.json`) that reuses a principle artifact's `IntentContractV1` verbatim for Target Behavior / Forbidden Pattern / Evidence Source / Expected New Behavior, and adds only the three fields the acceptance spec marks as new: eligible opportunity, previous behavior (B0 failure pattern, frequency and observed evidence), and before/after observation windows split by `created_at` rather than session (exposed sessions are long-lived and would mix before/after). A repo-wide guard validates every such declaration with the real `isValidIntentContractV1` and rejects declarations that fork their own copies of the contract fields. No new table, runtime, Behavior Engine or storage — the declaration is one JSON file per experiment, and behaviour adjudication stays with the Owner (`adjudication.status = not_evaluated`).
- edbbcd9: RAH-3 (PRI-907): complete the release-artifact content boundary. @principles/install-layout and principles-disciple (openclaw-plugin) production builds now exclude compiled tests (tsconfig.build.json; plugin build:types declaration emit filtered too) with the same fail-loud dist hygiene assertion as RAH-1. The installer bundle script (create-principles-disciple) filters compiled test artifacts out of every payload copy AND asserts zero test artifacts across all payload components after materialization — test code can no longer reach user machines even if a future package forgets its build-boundary guard. A repo-level scan (check:workspace-artifacts, wired into verify:merge) backstops all workspace dist trees.
- 8b7b775: Security audit run-1 remediation (findings verified against eabbde6d, applied on ccc69252):
  
  - **RuleCode enforcement is now content-bound** (audit HIGH `rulecode-approval-content-unbound`): the production gate and the OpenClaw plugin RuleHost re-verify the current `pi_artifacts` row against the `activation_decisions.artifact_digest` recorded at Owner promotion time before compiling it. A workspace-local rewrite of `content_json` (or lineage fields) is now skipped with a structured `artifact_content_tampered` warning instead of silently executing unapproved code. Rows without a recorded decision (legacy activations) keep their prior behavior. Adds `mapPiArtifactRow`/`PiArtifactRow` exports (the single `pi_artifacts` row→snapshot mapping) so enforcement reproduces the promotion-time digest byte-for-byte.
  - **Replay evaluate is hard-bounded** (audit MEDIUM `rulecode.replay.in-process-evaluate-no-hard-timeout`): pre-activation replay runs each evaluate call through a precompiled vm script with a 2000ms hard timeout — a looping LLM-authored candidate now fails its replay case instead of hanging the console server, evaluator worker, or CLI process.
  - **Governance-store unavailability leaves a durable trace** (audit MEDIUM `gate-failopen-allow-on-state-corruption`): when `state.db` is missing or unreadable, the gate/plugin record a best-effort marker under `~/.pd/enforcement-health/` (outside the agent-writable workspace), and the console governance read model distinguishes "state.db deleted after initialization — enforcement degraded (fail-open)" from a never-initialized workspace.
  - **Console refuses unauthenticated non-loopback binds** (audit MEDIUM `pd-console-noauth-nonloopback-bind`): the loopback-only invariant now keys on the effective authentication state (token-less default included), not just the explicit `--no-auth` flag.
  - **Plugin honors an explicit conversation-access opt-out** (audit LOW `openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out`): the auto-fix repairs only an absent `allowConversationAccess` flag; an explicit `false` (the documented turn-off) is preserved and surfaced as an honored Owner opt-out instead of being silently rewritten on every gateway start.
- Updated dependencies [99e6a8c]
- Updated dependencies [8b7b775]
- Updated dependencies [9d98f89]
- Updated dependencies [92074a0]
  - @principles/core@1.287.2

## 2.0.2

### Patch Changes

- 8424d60: Baseline-cutover accounting for the unpublished source delta between the registry baseline (2.0.1, published from fb397452) and current main: pain/llm hook refinements and the plugin sync script update carried after the 2026-09-19 release train. The version alignment to 2.0.1 is a starting point, not a claim this content shipped.
- Updated dependencies [8424d60]
  - @principles/core@1.287.0

## 1.10.0

### Minor Changes

- 650ae5a: ## v1.9.1: WebUI Data Source Fixes

  ### Phase 16-20 Complete

  - **Phase 16**: Data Source Tracing - mapped all 4 WebUI pages to API endpoints
  - **Phase 17**: Overview Page Fix - fixed `/api/central/overview`, `/api/overview`, `/api/overview/health`
  - **Phase 18**: Loop/Samples + Feedback Fix - fixed `/api/samples`, `/api/feedback/*` data sources
  - **Phase 19**: Gate Monitor Frontend - fixed `/api/gate/stats`, `/api/gate/blocks` types
  - **Phase 20**: E2E Validation - 19 regression tests added for all API endpoints

  ### Bug Fixes

  - Fixed `evolution-worker.ts` missing `runtimeAdapter` parameter
  - Fixed `nocturnal-train.ts` mode field type annotation
  - Fixed `sync-version.sh` to include `create-principles-disciple` package

  ### Infrastructure

  - Added `@changesets/cli` for monorepo version management
  - Added `data-endpoints-regression.test.ts` with 19 tests
