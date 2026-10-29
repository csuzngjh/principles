---
'@principles/core': patch
'@principles/host-runtime': patch
'@principles/workbuddy-adapter': patch
'@principles/codex-adapter': patch
'@principles/pd-cli': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

RuleCode host promotion loop (SPEC-RULECODE-HOST-PROMOTION-001 v0.1, A→B→C):

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
