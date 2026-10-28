---
'@principles/core': patch
'@principles/host-runtime': patch
'@principles/workbuddy-adapter': patch
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
