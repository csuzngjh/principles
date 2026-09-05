# Verification Context — PD Pipeline Verification Campaign v1.0

> Protocol: PD Verification & Pipeline Investigation Protocol v1.0 (Owner-issued 2026-09-05)
> Principle 1: this file is created BEFORE any npm install / test run in this campaign.

```yaml
verification:

  campaign: pipeline-health-audit-2026-09
  purpose: >
    Prove or disprove, with real evidence, that the PD core value loop
    (real error -> pain capture -> diagnosis -> principle -> rule ->
    evaluation -> owner decision -> activation -> future behavior change)
    actually works end to end on current main; produce Evidence Packages,
    not narrative reports.

  mode:
    - primary: current_capability        # Mode A — pipeline health on latest origin/main
    - per_finding: fix_validation        # Mode B — any fix gets Before/After, one problem one PR
    - regression: regression_validation  # Mode C — historical capabilities vs current main

  source:
    repository: D:\Code\principles (primary checkout, read-only control plane per git-3)
    worktree: D:\Code\principles-adhoc-20260905-pipeline-verification-protocol
    branch: ai/adhoc-20260905-pipeline-verification-protocol
    base: origin/main
    commit_sha: c45c829a39e0e21a95a2564b7baba6753c0ccde9   # Merge PR #1518 (PRI-686 workspace resolver alignment)

  install:
    clean_install: PENDING_BOOTSTRAP     # setup-worktree.mjs: fresh npm install + full build in this worktree
    package_versions:                    # from manifests at c45c829a3
      monorepo: 1.76.1
      openclaw-plugin(principles-disciple): 1.76.1
      pd-cli: 1.74.1
      host-runtime: UNKNOWN_at_write_time
      create-principles-disciple: UNKNOWN_at_write_time
    published_npm: UNKNOWN_at_write_time # to be checked via npm view at P0 audit time

  runtime:
    host: OpenClaw 2026.8.x (live install on this machine — exact version to be verified at experiment time)
    plugin: principles-disciple 1.76.1 expected (live installed version to be verified)
    cli: pd 1.74.1 expected (live installed version to be verified)
    live_workspace: per pd-live-workspace-layout memory — to be re-verified before live reads

  model:
    provider: UNKNOWN                    # live PD pipeline LLM config — read from live workspace at experiment time
    model: UNKNOWN
    thinking_mode: UNKNOWN

  flags: UNKNOWN                         # read from live feature-flag SSoT at experiment time; do not guess

  lab:
    scenario: TBD                        # pipeline-closure-lab / PRI-653 evolution-lab assets exist; pick per experiment
    fixture_version: TBD
    prior_lab_data: pd-labs/pri653-e1 (per memory, round 2/3 artifacts exist)

environment_findings:                     # git-4: observed, NOT touched, NOT cleaned
  primary_checkout_anomaly:
    observed: >
      Primary checkout D:\Code\principles sits on branch fix/pri-634-adversarial-replay-override
      (upstream deleted) with an UNRESOLVED merge conflict
      (packages/pd-cli/src/commands/runtime-internalization-run-once.ts, both-modified),
      4 staged foreign package.json edits, and its ROOT package.json OVERWRITTEN in the
      working tree by a different package's manifest (@principles/pd-companion 0.1.2) —
      breaking all `npm run` scripts there.
    classification: environment-issue / concurrent-session interference (matches pd-worktree-external-branch-switching memory)
    action_taken: none — treated as someone else's work; primary used read-only
    owner_action_needed: true             # decontamination decision belongs to Owner

audit_priorities:                         # per protocol Principle 7
  P0: release_distribution                # fresh user -> install -> run; if broken, fix first
  P1: PRI-683_timeout_hierarchy           # provider/adapter/runtime/task timeout chain; record timeout_source; prior evidence: 300s inner cap = activation bottleneck (pri653 round 2)
  P1: automatic_pain_detection            # sessions>100 but automatic pain=0 — verify cause, do NOT just enable
  P1: rule_production_reachability       # pain exists but rule artifact=0 — output Rule Reachability Report
  P1: owner_decision_pipeline             # needs_human_review -> Owner Inbox -> decision -> activation must be visible
  P2: rule_semantic_lineage               # Why created / What prevented / Evidence / Validation — report gaps first, no premature refactor

discipline:
  states_allowed: [PASS, FAIL, BLOCKED, UNKNOWN, NOT_REACHED, INCONCLUSIVE]
  evidence_package_required: true         # manifest.json + evidence-index.json + pipeline-trace.json + metrics.json + report.md + raw-evidence/
  no_guessing: missing lineage is marked UNKNOWN / missing_evidence, never reconstructed
  one_problem_one_pr: true
  linear_update_required: true
```

## Change log

- 2026-09-05 — created before any install/test in this campaign. Bootstrap of this worktree starts after this file is committed to the campaign workspace.
- 2026-09-05 — worktree bootstrapped (npm install + build OK; pd-cli built separately — root build chain does not include it; `pd --version` reports `1.76.1 (000000000000)` = known version-authority split, unchanged). Baseline survey done; results below.

## Baseline survey results (Mode A pre-checks, 2026-09-05)

### Reused prior evidence (P2 Survey Before Acting)

**PD Pipeline Health Audit v1** (`docs/pipeline-health-analysis/pd-pipeline-health-audit-v1.md`, merged via PR #1519 at de3d85dc1) — a read-only audit with 3 live experiments, dated today, is the direct predecessor of this campaign. Its verdict: **PARTIAL**. This campaign's job is NOT to redo it, but to (a) verify its P0/P1 findings still hold on the newest main+3 PRs and npm state, and (b) drive fixes under this protocol. Key inherited findings:

| ID | Finding (from audit v1) | Audit verdict | This campaign's re-check |
|---|---|---|---|
| P0 | Distribution broken: npx fresh install fails (`self_contained_asset_identity_invalid`); Release assets = 0; tarball missing `codex-adapter/` | CONFIRMED (3 channels tested) | **RE-CONFIRMED below** |
| P1 | PRI-683 pi-ai ~300s inner timeout cap = sole activation blocker (repair rounds 16/16 dead) | CONFIRMED (lab R2) | unchanged (no new PR touches it) |
| P1 | Automatic pain detection zero output on live (196 sessions, 10/10 pains manual, `abstraction_layer_v1` flag OFF) | CONFIRMED (live SQL) | unchanged |
| P1 | Rule production double-unreachable: N-1 host-declaration writer unwired (evaluator CLI gate always rejects) + N-2 121 artifacts → 0 rules | CONFIRMED (expA + live) | unchanged |
| P1 | N-3 Owner inbox doesn't list needs_human_review tasks (PRI-629 family) | CONFIRMED (expA) | unchanged |
| P2 | Rule semantic lineage evaporates pain→injection (11 loss points) | CONFIRMED | unchanged |

### P0 re-verification (npm/GitHub state at 2026-09-05, ~16:00 local)

- npm latest: `principles-disciple@1.230.0`, `create-principles-disciple@1.132.2` (unchanged since audit).
- GitHub Release v1.230.0 (latest): **0 assets**. v1.229.0/v1.228.3 also 0.
- Tarball `create-principles-disciple-1.132.2.tgz` (4209 files): **no `_release/asset.json`** anywhere; top-level dirs = console/core/dist/host-runtime/install-layout/pd-cli/plugin — **no `codex-adapter/`**.
- Open PRs: **none** (no fix in flight).
- → **P0 distribution breakage still holds verbatim.** A fresh user running `npx create-principles-disciple` today still fails.

### Environment findings

- Linear CLI unavailable in this session (no LINEAR_TOKEN env): Linear re-registration of breakpoints = **BLOCKED** (manual/owner action).
- Primary checkout contamination unchanged (see environment_findings above).

## Investigation results (P1 items, 2026-09-05 — read-only, live DB + code evidence)

### A. Automatic pain detection zero output — ROOT CAUSE CONFIRMED (design scope, not detector failure)

- Live trajectory: 1297 tool calls, **117 real failures** (9% failure rate; exec=58, process=21, gateway=9, write=3, read=6, others).
- Admission scope `WRITE_TOOLS = [write, edit, apply_patch, write_file, edit_file, replace]` (after-tool-call-helpers.ts:401) — **114/117 (97%) of failures fall OUTSIDE scope** (exec/process/gateway are not write tools).
- System logs (memory/logs/SYSTEM_*.log): every out-of-scope failure has a matching `PAIN_ADMISSION_SKIPPED/not_a_write_tool_failure` entry — counts reconcile exactly with trajectory failures (44 on 09-02, 14 on 09-03, 24 on 09-04, 16 on 09-05). **The detector works; the admission scope excludes where real failures happen.**
- The 3 in-scope write failures (all 09-02, exit_code=0, business-layer rejections "Tool write not found"/"Memory flush writes are restricted") produced no admission decision logs — borderline cases: classifyToolCallOutcome needs `event.error || exitCode!==0`; these have exit 0 and the classifier-relevant `error` field shape is inconclusive from trajectory alone.
- Shared path (`abstraction_layer_v1`) is flag-OFF on live; audit confirms the legacy path is what runs.
- **Verdict: mechanism healthy, scope mismatched to reality.** Widening admission (e.g. exec failures) is a PRODUCT decision with noise tradeoffs (exec failures include Agent-self-correcting retries) — escalated to Owner, NOT auto-implemented.

### B1. N-1 host-declaration writer — RESOLVED IN MAIN (live symptom belongs to install/upgrade session's CP-5)

- Wiring commit 9f43a88c8 (PRI-634-F R2, 09-04 14:00 +0800) — in v1.230.0 tag AND byte-identical in shipped npm 1.230.0 bundle (`host-tool-semantics` string present).
- Live `~/.openclaw/extensions/principles-disciple` bundle (09-03, 30MB) contains NO wiring — gateway loads this stale copy (install-upgrade session's CP-5: `/apply-full` never refreshes extensions). Symptom owner: install/upgrade session; **do not double-fix here**.

### B2. N-2 zero rule artifacts — MECHANISM WORKING AS DESIGNED (adversarial gate correctly blocking; real gap = RuleCode generation quality)

- Design: artificer ALWAYS produces `principle` artifacts (artificer-runner.ts:939 — intent); rule artifacts are assembled by EVALUATOR after approval (evaluator-runner.ts:2705-2720, `artifactKind: 'rule'`).
- Assembly gate: `adversarialResult.passed === true` (evaluator-runner.ts:1306).
- Live + expA evidence: both succeeded evaluators approved semantically (score 0.88) but deterministic adversarial replay FAILED 2 cases (`v2-path-boundary`, `v2-combination` — expected block, got allow) → gate correctly refused rule assembly → 0 rule artifacts.
- ExpA's NHR rollout task + live's 2 NHR rollout tasks then hit `rollout_activation_candidate_unresolved` because `resolveActivationCandidate` finds no `rule`/validated artifact in lineage (code_tool_hook channel requires kind='rule').
- **Verdict: pipeline safety working; upstream LLM RuleCode quality is the bottleneck — PRI-634 mainline scope, not this campaign.**

### C. N-3 Owner inbox invisible NHR — CONFIRMED BUG (producer/consumer contradiction), small fix surface

- Live: 2 NHR rollout_reviewer tasks since 09-01, `humanReviewContext.reasonCode = 'rollout_activation_candidate_unresolved'`, full context present (sourceRunId/sourceArtifactId/hash/revisionEpoch).
- Classification: `DECISION_CAPABLE_HUMAN_REVIEW_REASONS` = {evaluator_repair_budget_exhausted, rollout_revision_budget_exhausted} (owner-review.ts:58-61) — this reasonCode NOT in set → `classifyHumanReviewAttention` returns recovery → console `deriveTaskDecisionItem` returns null (OwnerDecisionConsoleModel.ts:157-158: not eligible AND no evidence blockers → **silently dropped from inbox**).
- Producer intent contradicts consumer classification: rollout-reviewer-runner.ts:701-705 comment says "rejectionDetail 透传给 Owner —— Owner 需要看到缺口字段才能判断"; markNeedsHumanReviewOrThrow was built to carry detail to the Owner.
- **Fix direction (recommended)**: make decision-capable set include `rollout_activation_candidate_unresolved` (Owner CAN meaningfully act: revise_once → reopens scribe/artificer chain; reject_current → archive), OR at minimum surface recovery-attention NHR tasks as read-only inbox rows so they're visible. Producer-side detail (rejectionDetail) already flows into humanReviewContext for new tasks.

### Cross-cutting finding: stale extensions copy (delegated)

- My independent verification matched install-upgrade session's CP-5 (E-018/019/020): `~/.openclaw/extensions/` bundle (09-03) != canonical 1.230.0 bundle; canonical == npm tarball byte-identical. All plugin-side fixes merged 09-04+ (PRI-667 evaluator fix, N-1 declaration writer, PRI-655) have NEVER run on live. This multiplies every other pipeline symptom observed on live.
