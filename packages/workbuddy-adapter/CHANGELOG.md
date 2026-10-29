# @principles/workbuddy-adapter

## 0.2.15

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
- Updated dependencies [5349930]
  - @principles/core@1.297.5
  - @principles/host-runtime@0.14.2

## 0.2.14

### Patch Changes

- eaaa2e9: WorkBuddy plugin hook wrapper now arms a self-deadline strictly below the hooks.json host timeout and kills a hung adapter child itself, degrading non-blocking (exit 1 + bounded stderr, P02) instead of leaving the outcome to the host's undefined hook-timeout semantics. Rationale (2026-10-28 incident follow-up): the adapter entry's own fail-open exits can never run when the host kills the wrapper mid-flight, so the "UserPromptSubmit failure never blocks" guarantee was unenforceable on the timeout path. Budgets: UserPromptSubmit 12s under a narrowed 15s host timeout (prompt loss is the costliest channel), every other event 25s under the unchanged 30s; a guard test locks every wrapper budget below its hooks.json timeout, and a real-process test proves the kill/degrade path end-to-end (EP-04). Bumps the WorkBuddy plugin manifest 0.2.0 → 0.2.1 (bump-on-content-change convention, #2108) and records the timeout-path semantics in SPEC §4.4.
- Updated dependencies [07242b7]
- Updated dependencies [53a285f]
  - @principles/core@1.297.4
  - @principles/host-runtime@0.14.1

## 0.2.13

### Patch Changes

- cd773b5: Codex explicit pain statement: fix evidence-promotion ordering.
  
  - Run the live observation ingestion BEFORE the explicit registration in
    pd-hook, so the FIRST `PD记录痛苦：` submission of a rollout promotes its
    evidence window instead of degrading with rollout_not_found /
    trigger_not_found (the trigger observation used to be written only by the
    ingestion pass that ran after the registration).
  - Promote evidence BEFORE enqueuing the Diagnostician task, closing the
    window where a fast worker could start the first diagnosis before the
    available evidence window was promoted.
  - With codex_conversation_ingestion disabled, skip promotion and disclose
    `conversation_ingestion_disabled` in the receipt (no transcript read, no
    session observation, no misleading missing-substrate reason).
  - Reconciliation now requires the current ingestion consent explicitly:
    flag-off recovers tasks and links without reading or promoting old session
    observations; enabled reconciliation promotes before making tasks runnable.
  - ensureGovernanceDiagnosticianTask: a concurrent ensure racing on the same
    deterministic task id now converges on the existing task instead of
    reporting task_submit_failed:UNIQUE while the task actually exists.
- Updated dependencies [44a9d3d]
- Updated dependencies [cd773b5]
  - @principles/core@1.297.3
  - @principles/host-runtime@0.14.0

## 0.2.12

### Patch Changes

- 4fefb36: Codex explicit pain statement: fix evidence-promotion ordering.
  
  - Run the live observation ingestion BEFORE the explicit registration in
    pd-hook, so the FIRST `PD记录痛苦：` submission of a rollout promotes its
    evidence window instead of degrading with rollout_not_found /
    trigger_not_found (the trigger observation used to be written only by the
    ingestion pass that ran after the registration).
  - Promote evidence BEFORE enqueuing the Diagnostician task, closing the
    window where a fast worker could start the first diagnosis before the
    available evidence window was promoted.
  - With codex_conversation_ingestion disabled, skip promotion and disclose
    `conversation_ingestion_disabled` in the receipt (no transcript read, no
    session observation, no misleading missing-substrate reason).
  - Reconciliation now requires the current ingestion consent explicitly:
    flag-off recovers tasks and links without reading or promoting old session
    observations; enabled reconciliation promotes before making tasks runnable.
  - ensureGovernanceDiagnosticianTask: a concurrent ensure racing on the same
    deterministic task id now converges on the existing task instead of
    reporting task_submit_failed:UNIQUE while the task actually exists.
- Updated dependencies [4fefb36]
  - @principles/host-runtime@0.13.5

## 0.2.11

### Patch Changes

- 1b13597: SPEC-PD-PAIN-RECALL-CLI-001: new read-only `pd pain recall` command — recalls the historical pains a principle verifiably derives from, so a host Agent can check a principle's origin, trigger boundary, or current-situation fit on demand. Only two authoritative association edges are honored (`reuseEvidence[].painId`; `derivedFromPainIds` resolved through its production contract as candidate ids via `tasks.input_ref`), results dedup by real pain id while keeping every evidence ref, `--context` re-ranks deterministically without any model/network call, and per-source availability separates `not_recorded` from `unreadable` (`source_missing`/`source_unreadable` never masquerade as `no_matches`). All three hosts' `pd-cli-operator` skills (Codex plugin, OpenClaw en/zh templates, WorkBuddy adapter) now document when to call it, how to read the JSON contract, and the diagnosis-is-not-owner-statement rule.

## 0.2.10

### Patch Changes

- Updated dependencies [0f2d1fb]
  - @principles/core@1.296.0
  - @principles/host-runtime@0.13.0

## 0.2.9

### Patch Changes

- 6881b6c: Bump the Codex plugin manifest 0.1.1 → 0.2.0 and the WorkBuddy plugin manifest 0.1.0 → 0.2.0. The unified four-skill set (#2106) changed both plugins' shipped content without moving their manifest versions; Codex cache updates key on that version, so users re-running `codex plugin add` could be served the already-installed 0.1.1 payload and never receive the new skills. The WorkBuddy same-version refresh path is content-safe, but a versioned cache dir makes the upgrade observable. Includes a cross-version WorkBuddy upgrade regression (new cache dir + registration repoint + governance data preserved) and parameterizes the delivery tests off the shipped manifest version.

## 0.2.8

### Patch Changes

- 5c383e5: Unify PD host skills around four consistent capabilities, clarify Owner governance and evidence boundaries, and align the published skill bundles and Codex recovery guidance.
  
  Review-round additions: `pd run list/show` gain an optional `--workspace` (governance-workspace reads independent of cwd); Codex skills route every shipped script through `pd-locate.cjs --exec` — one authoritative locator that resolves the plugin root once, fails loud on marketplace ambiguity or a missing script instead of silently falling back to an older version; WorkBuddy near-miss explicit-statement prefixes get an actionable format notice; `pd-review` startup text no longer presents CLI approval as an agent fallback.

## 0.2.7

### Patch Changes

- 222d9e0: Connect WorkBuddy live keyword Pain detection to the shared learned correction vocabulary (AUDIT-P3-01, 2026-10-21 remediation; SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001 v0.2): assessWorkbuddyLiveKeyword accepts an optional UnifiedKeywordStore and admitTrustedWorkbuddyLiveCorrection plus the adapter pre-filter now resolve the same shared live store (seed + learned, mtime-cached, seed-only degradation) instead of the four-term P0 projection, so earned-high terms accumulated on other hosts take effect in WorkBuddy. Only high-precision correction terms can trigger automatic Pain (existing gates unchanged: startsWith prefilter, native UserPromptSubmit validation, explicit Owner-statement prefix reservation, both default-OFF flags, no LLM, no transcript reads). Adds direct host-runtime unit tests for the admission boundary (previously adapter-indirect only, AUDIT-P3-04).
- Updated dependencies [765d5c4]
- Updated dependencies [222d9e0]
  - @principles/core@1.295.2
  - @principles/host-runtime@0.12.1

## 0.2.6

### Patch Changes

- Updated dependencies [48df168]
  - @principles/host-runtime@0.12.0

## 0.2.5

### Patch Changes

- d3796e4: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.
  
  - Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match (host-declared provider) → legacy fixed 2000-char fallback with a bounded machine-readable reason code — provider-less name-only matches NEVER confirm (v0.2 trust amendment: a unanimous name cannot prove the deployment is not a custom endpoint). Budget formula `min(16000, max(1250, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens). The 1250 floor is MEASURED (shared route full render of one minimum viable principle = 849/1204 chars with self-report off/on — lower floors re-create the audited 32K zero-injection defect); the 16000 cap is the Owner target upper bound (1M windows map to 15625).
  - Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 1250..16000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 16000 max tier; cross-host aggregation is monotone — only ALL-hosts overflow brands an entry oversized everywhere); injection events carry budget provenance INCLUDING the bounded `budgetFallbackReason` code.
  - Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
  - Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.
- Updated dependencies [d3796e4]
  - @principles/core@1.295.0
  - @principles/host-runtime@0.11.0

## 0.2.4

### Patch Changes

- bf5aed3: Introduce an opt-in WorkBuddy native current-user keyword Pain path using the shared high-precision detector, canonical Pain admission and Diagnostician task continuation. Expose effective keyword detection status; leave the feature off by default and preserve Codex ingestion consent boundaries.
- Updated dependencies [bf5aed3]
  - @principles/core@1.294.1
  - @principles/host-runtime@0.10.4

## 0.2.3

### Patch Changes

- b02ebb5: Deliver WorkBuddy pain recording, status, Owner review and disable skills through the plugin package, marketplace and versioned cache. Reject incomplete payloads and unsafe manifest versions before registration, refresh old hook-only caches even at the same manifest version while preserving native registry scopes and older cache versions, confine cache replacement to the PD plugin version directory, and delegate disable to the existing official installer API.
- b02ebb5: Connect WorkBuddy current-user explicit Owner pain submissions to existing governance admission and diagnostic task creation. Preserve native session/turn identity, unverified Owner evidence, bounded input rejection and model-visible receipts; retain Codex prefix behavior through the shared parser.
- Updated dependencies [b02ebb5]
  - @principles/core@1.293.4
  - @principles/host-runtime@0.10.2

## 0.2.2

### Patch Changes

- Updated dependencies [fec1306]
- Updated dependencies [574954a]
- Updated dependencies [06152af]
  - @principles/install-layout@0.4.0
  - @principles/core@1.293.0
  - @principles/host-runtime@0.10.0

## 0.2.1

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/core@1.292.1
  - @principles/host-runtime@0.9.1
  - @principles/install-layout@0.3.1

## 0.2.0

### Minor Changes

- 5e794be: New package: the WorkBuddy host adapter (third ADR-0020 host) — decoder/encoder, hook entry with the probed fail-closed contract, tool semantics, evidence recorder, plugin skeleton, governance worker cycle.

### Patch Changes

- Updated dependencies [6e60d84]
- Updated dependencies [0f94f8c]
- Updated dependencies [4ba83b7]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
  - @principles/core@1.292.0
  - @principles/host-runtime@0.9.0
  - @principles/install-layout@0.3.0
