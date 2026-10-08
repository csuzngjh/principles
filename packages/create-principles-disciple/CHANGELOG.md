# create-principles-disciple

## 1.144.21

### Patch Changes

- d5732f8: PD v2 Phase 1 Evidence Foundation (ADR-0027): normalized intervention evidence ledger.
  
  - core: intervention evidence contract + deterministic normalizer (rc-1..rc-5 trust boundary, anti-forgery cross-field rules), append-only SQLite ledger tables inside the existing state.db (idempotent same-source replay, reported source conflicts, immutable records, activation occurrence snapshots), busyTimeoutMs connection option, and the four-query audit read contract.
  - host-runtime: shared intervention evidence ingress — the single validated entry every host source uses; never throws, never waits on locks (busyTimeoutMs 0), degrades with structured reason + nextAction.
  - openclaw-plugin (principles-disciple): evidence wiring on both legacy and shared routes — prompt delivery attempts (submitted/attempted, host consumption never claimed), enforcement chains on gate block/auto-correct (runtime_loaded delivery, runtime_verified application with explicit proof boundary, episode, effect), agent_claimed self-report mirroring; gated by the existing principle_receipt_ledger flag.
  - codex-adapter: evidence adapter on the shared ingress — UserPromptSubmit delivery attempts after the durable event-log line, deny chains recorded only after successful stdout encoding; honest capability matrix (self_report Unsupported, enforcement Unknown per PRI-780).
  - create-principles-disciple (ships pd-console): four read-only evidence-audit queries under /api/v1/receipts/evidence-audit plus the authenticated Owner outcome input POST /api/v1/evidence/outcomes (closed body contract, server-derived actor), and an evidence-audit section on the principle detail page.
  
  No effectiveness scoring, ranking, or automatic governance action anywhere (Phase 1 records facts only).
- 0b981bb: 提示词容量与生效反馈修复（PD_PROMPT_CAPACITY_V1，阶段 A/B1/B2/C）：
  
  - core：`listEntryLine` 列表行格式单一权威；prompt 版本替换——dispatcher `supersedeActivationId` 通道 + state store 单事务 `replacePromptActivation`（新激活+不可变 supersede 决策+旧版停用，故障回滚不留双活）；`detectPromptReplacementTarget` / `buildOwnerRevisionArtifact`（复用真实 Scribe 内容合同）；Scribe prompt v5 正文最短充分要求。
  - host-runtime：宿主事实绑定的有效注入路由解析（声明∪pain_events，Codex 恒共享、OpenClaw 按 flag、未知不猜测）；投影合同扩展（unit/计费范围/超长透传/诊断截断标记）；单一 `checkPromptArtifactDeliverability` 写入前预检；激活级注入状态读取；注入事件诚实读模型（无日志=unknown 非零）。
  - pd-cli：`pd activation approve --target-host` + prompt 写入前容量门（拒绝零写入、单一 JSON、结构化 nextAction）。
  - console（随 create-principles-disciple 发布）：审批预检门与 422 拒绝、未确认宿主横幅与请求级目标宿主、激活页注入状态与「修改为可注入版本」入口、替换事务 UX。

## 1.144.20

### Patch Changes

- 64c3111: PRI-947: the Owner approval second step now appears where the Owner is looking. Clicking 批准 on a principle detail page expanded the confirmation panel as the last node of the whole page, below the fold and with no scroll/focus/toast, so the click looked dead; the panel now renders inside the decision region that owns the action buttons, and a Playwright regression test asserts the panel lands in that region and that the first click performs no write. Ships the pd-console fix inside the installer package (pd-console is private).

## 1.144.19

### Patch Changes

- ac46818: PRI-945 — uninstall deletion gates now detect the filesystem entry itself
  (lstat), not its resolved target (existsSync). A dangling symlink/junction
  under `~/.pd` (releases/, staging/, backups/, a dangling active.json) or the
  shared runtime dir, or the plugin extension junction, was previously silently
  skipped — existsSync follows the link to a missing target and returns false —
  so uninstall reported success while stranding the broken link on disk. Each
  removal gate now reclaims the leftover entry, and the remover (fs.rm with
  recursive+force) unlinks it without ever following or deleting the target. The
  CLI `--check` status still reports a dangling link as "missing" (preserved on
  purpose), so only the actual teardown reclaims it.

## 1.144.18

### Patch Changes

- ce5cfc7: PRI-944 — an update or install no longer aborts because `openclaw gateway stop`
  was slow. The gateway stop was decided by the exit code of a 15s `cmd.exe /c`
  wrapper: when the wrapper timed out while the service manager was still closing
  the gateway, the installer concluded "refused to stop" and refused the whole
  run before touching anything — on the reported host that voided a signed-channel
  update at the `verified` stage. `stopOpenClawGateway` now decides by the EFFECT:
  after a failed stop it waits (bounded, 30s, 1s polls) until the observed gateway
  port has no listener and the observed PID has exited, and only then lets the run
  proceed. A refusal is classified so the operator instruction matches reality:
  `gateway_still_running` (verified still listening — stop it by hand),
  `stop_confirmation_timeout` (port cleared, process lingering — wait and retry),
  `verification_unavailable` (nothing observable — refused, never assumed). The
  start leg is deliberately unchanged: its failure is a notification, and a cold
  start measures in minutes.

## 1.144.17

### Patch Changes

- a5d069b: Uninstall no longer tells the user to "manually delete" the personal data it
  just promised to preserve. The post-uninstall hint (.principles/.state, MD
  files) previously read like a cleanup instruction for the same retained
  governance directories, risking accidental deletion of data meant to survive a
  reinstall. The hint now states the files are intentionally preserved and need
  no manual action (PRI-893).
- 3a26f30: PRI-894 + PRI-895 — uninstall reclaims ~/.pd update residue on full shared-runtime teardown. When the last host is uninstalled, `uninstall` now removes staging/, releases/ and backups/ (a GB-scale disk leak) and a dangling active.json that still pointed at a deleted release, after the runtime directory itself is gone and before install.json is removed. Deletion is provably bounded to those three update directories plus the pointer (never a glob of ~/.pd/), so transactions/, logs/, trust/, channels/ and bootstrap/ are left untouched. A corrupt active.json is preserved with an observable note; a partial (single-host) uninstall preserves all residue; and install.json is kept when reclaim fails so a re-run retries instead of stranding the residue.

## 1.144.16

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

## 1.144.15

### Patch Changes

- 7d1daef: PRI-926: update history reconciliation now tells the truth. The ReleaseManager journals `preUpdateProductVersion` on the planned transition (from the active record), reconciliation derives `fromVersion` from it (absence stays `unknown`), only journals in the ReleaseManager update domain synthesize Owner-facing rows (wrongly-projected install-domain rows are dropped), timestamps come from the journal's first line instead of the scan moment, and synthesized ids are deterministic (`reconciled-<transactionId>`) so cap-evicted rows cannot resurrect as duplicates. Ships the pd-console reconciliation fix inside the installer package (pd-console is private).

## 1.144.14

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

## 1.144.13

### Patch Changes

- 5c763b2: chore(deps): bump fs-extra 11.4.0 -> 11.4.1（installer 运行时依赖，随 create-principles-disciple tarball 一起分发，故声明 cpd patch）。
- df9e555: PRI-917 v0.3.3 (OD-PRI917-05): Reuse Review Gate — automatic candidate intake now consults the semantic reuse evaluation capability before creating a Principle.
  
  A `reuse` recommendation parks the candidate (`refused/reuse_pending_owner`): no Principle is written, no evidence is appended, the candidate stays pending for the Owner, and the bridge emits an observable `reuse_gate_triggered` event plus a `reuse_review_required` outcome pointing at `pd candidate review --decide reuse|create`. `create`/`uncertain` recommendations and every evaluation failure degrade to normal creation (learning never blocks). `reuseEvaluation.enabled=false` restores the exact pre-v0.3.3 behavior.
  
  Also fixes the R5 "two-heads-block" defect: `pd candidate review --decide reuse` no longer lets the PRI-442 admission pre-check reject low-confidence candidates — a reuse verdict creates nothing, so the ledger-quality gate does not apply (the `--decide create` pre-check is unchanged).
  
  PR review fixes (4×P2, PRI-938): the bridge cache key now folds in the reuse-gate switch so a long-lived host picks up `reuseEvaluation.enabled` toggles in both directions (T11 rollback without a restart); mixed batches and replays keep parked candidates visible (`reuse_review_required` degraded outcome, Codex worker `reuseReviewRequiredCandidateIds`, OpenClaw `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` log gated on the park disposition); `pd diagnose` / `pd pain-retry` render parked candidates with review guidance and exclude them from `internalize` next-action lists.
  
  Follow-up review fixes: evaluation profile and timeout changes invalidate the cached reuse hook. Replay verifies the original diagnosis admission and performs a read-only reuse check before reporting a parked candidate, preserving failed-intake and gate-disabled behavior without additional persisted state.
  
  Owner-approved configuration hardening: constructing CandidateIntakeService with both reuseRecommendation and reuseDecision now fails explicitly before either callback or any candidate mutation, instead of silently prioritizing the decision channel.

## 1.144.12

### Patch Changes

- 349b747: chore(deps): bump @fontsource/jetbrains-mono 5.2.8 -> 5.3.0 (pd-console，随 installer 分发)。
- 9fc1a31: chore(deps-dev): bump @types/node 26.6.1 -> 26.6.2 in create-principles-disciple.
- a438282: chore(deps): bump @principles/install-layout 0.2.4 -> 0.2.7 in create-principles-disciple（同步 cpd package-lock）。
- 47fad14: chore(deps-dev): bump vitest 5.0.1 -> 5.0.2 in create-principles-disciple.

## 1.144.11

### Patch Changes

- 25e8562: The Console's update page no longer reports "Request timeout" on a slow
  metadata host. `GET /api/update/check` refreshes the signed channel over the
  network — TUF metadata, the channel document and the release metadata, several
  sequential requests to the release metadata host — and it was running under the
  generic 10-second request budget. Measured against GitHub Pages from a CN
  network, the same request completes in ~1.2s most of the time and in ~12.5s
  about one run in five, so the page failed intermittently while the installation
  itself was healthy and already up to date.
  
  The check route now has its own 30-second budget, overridable with
  `PD_UPDATE_CHECK_TIMEOUT_MS` (milliseconds) exactly like the existing
  `PD_UPDATE_APPLY_FULL_TIMEOUT_MS` knob for slow disks and networks. A refused
  value falls back to the default with one observable log line. The check stays
  read-only: a timeout never leaves a partial update behind.
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

## 1.144.10

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

## 1.144.9

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

## 1.144.8

### Patch Changes

- e1fda67: The update chain now refuses a non-HTTPS release-asset URL outright, re-checks
  HTTPS on every redirect hop it follows (a carrier can no longer downgrade the
  delivery to plaintext with a 302), and publishes verified asset bytes to their
  canonical staging name only through a private, exclusively-created candidate
  plus an atomic rename, so a plaintext carrier can no longer poison every
  delivery and an unverified file can never be reachable under the name the
  installer deploys from (PRI-927).

## 1.144.7

### Patch Changes

- 1f4faf2: Update apply now survives a transient release-asset download failure (bounded
  retry with backoff) and recycles the transaction's staging directory when the
  journal reaches a terminal state, so failed and successful updates no longer
  leave ~1.3GB per attempt on the customer's disk (PRI-924).

## 1.144.6

### Patch Changes

- 12a5139: PRI-922: retire the previous.json ghost slot. The update-chain layout no longer
  declares a second pointer, recoverUnfinishedTransaction takes only the journal
  plus the active record, and the console recovery endpoint (bundled via this
  package) never reads previous.json. Production install/upgrade/rollback/repair
  behavior is unchanged for normal installation layouts, where the file has had
  no writer since 2026-08-26 and therefore never exists; on a machine with a
  leftover or hand-crafted previous.json, recovery decisions now deliberately
  ignore it (a fabricated record could previously sway them — closed by
  regression tests proving previous.json is not a recovery input).

## 1.144.5

### Patch Changes

- 4726620: feat(installer): PRI-912 canonical junction reconciliation for plugin @principles/core copies
  
  After all components deploy and before the journal 'staged' transition, the
  installer replaces a materialized <plugin>/node_modules/@principles/core
  copy with a junction (Windows) / relative symlink (Unix) to the runtime root
  core — only when the package identity, the plugin manifest's declared file:
  dependency resolving to the canonical core, and the full content digest all
  match. Gate failures skip with a structured reason; a failed conversion
  restores the copy; idempotent across repairs.

## 1.144.4

### Patch Changes

- 176a9a2: build: prune unused better-sqlite3 platform binaries from release assets
  
  Self-contained release assets now keep only the better-sqlite3 prebuild for
  the asset's own platform+arch (linux: musl detected from the build machine,
  which is also the target since cross-builds are refused). Foreign-platform
  `.node` files are removed from every materialized copy after staging and
  before `_release/manifest.json` is generated, so the signed manifest always
  describes the pruned tree. Measured saving on a real win32-x64 build:
  104,349,056 B (99.5 MiB) across 7 copies per platform asset; installer
  dependency resolution, package topology and runtime behavior are unchanged.

## 1.144.3

### Patch Changes

- 4ced615: OPT-002 (runtime-v2 barrel narrowing): the plugin's satellite bundles no longer pull the LLM SDK graph. Six shared plugin modules switched their VALUE imports from the `@principles/core/runtime-v2` barrel to the eight narrow leaf subpaths (type-only barrel imports unchanged; exported names unchanged), and `@principles/core` exports gained those additive subpaths (`./runtime-v2/store/workspace-leak-guard`, `./runtime-v2/feedback/redact-sensitive`, `./runtime-v2/types/event-types`, `./runtime-v2/trajectory-schema`, `./runtime-v2/internalization/{rule-host-input-builder,rule-context-v2,behavior-example-pack,tool-semantic-registry}`). governance-audit.js drops 2,783,013 → 70,786 bytes (−97.5%) and rulehost-evidence.js 2,826,401 → 60,244 bytes (−97.9%); bundle.js is byte-identical (4,151,557) — the main package keeps its LLM runtime through its own direct barrel import. `runtime-v2/index.ts` and all existing exports are untouched. A build-level satellite purity guard (`scripts/build/check-satellite-purity.mjs`, wired into `esbuild.config.js`) now fails any plugin bundle build that reintroduces pi-ai / pi-agent-core / anthropic / openai / genai / undici inputs into the satellite outputs, so the invariant no longer rests on discipline alone.

## 1.144.2

### Patch Changes

- fc1c9de: OPT-001 (artifact-size audit P1): releases now ship the production console web bundle. The pd-console `build` script (used by every official path — installer bundling, release-metadata, publish action, reproducibility, CI smokes) runs the UI step as `build:ui:production` (esbuild minify, no inline sourcemap): app.js drops from 8.6 MiB to 1.1 MiB, shrinking the installer payload by ~7.6 MiB. The bundler script additionally fails loud if a dev-mode app.js (sourceMappingURL marker) ever reaches the payload again. Local dev and console e2e keep using `build:ui` (dev) unchanged.
- c7453ea: PR #1844 follow-up: the Governance Focus prompt-injection forecast and the PRI-890 approve-time budget check now read `buildLivePromptInjectionProjection` (host-runtime), which follows the SAME injection route the agent uses — with `abstraction_layer_v1` off (the live default) the forecast replays the plugin's PromptActivationReader → trimToBudget chain instead of always rendering with the shared-path directive wrapper. Previously a saturated 2000-char budget was over-forecast (~3/11 principles "injected" vs the real 9/11), so the Focus page badge and approve warnings overstated budget pressure. Principle selection, FIFO ordering, injection behavior and the budget algorithm are unchanged; parity and boundary regression tests pin the projection to the live path.
- 38b86f6: PRI-889: Governance Focus now renders the existing PendingReviewCard (Wave 7 component with approve/reject/revise actions) for pending approval groups, giving Owners their first clickable activation-approval path in the browser. When grouped approvals data is available, activation_approval entries skip the legacy OwnerDecisionCard (its only affordance was a dead CTA); when unavailable, all entries keep rendering so decisions never silently disappear. The card honors the PRI-787 governance-readiness lock with a visible reason.
- 5fc33bd: PRI-890: approve now recomputes the production prompt injection projection (same FIFO + 2000-char budget logic the prompt hook uses) and surfaces a non-fatal warning when the freshly approved prompt-channel activation lands outside the budget — previously the approval silently never reached agent behavior when the budget was saturated (PRI-768 v6-02). Non-budget exclusions (artifact resolution failures) are reported with their own reason code, and the Governance Focus approve flow shows the warning toast so the Owner sees it at decision time.
- 84c7074: PRI-892: fixed the silent no-op of `npx create-principles-disciple` on Windows. Node resolves the main module through symlinks/junctions while `process.argv[1]` keeps the unresolved link path handed over by npm/npx `.bin` shims, so the raw `pathToFileURL(argv[1]) === import.meta.url` entry guard never matched and the CLI exited 0 with zero output (install / repair-update-chain / uninstall all dead). The guard now canonicalizes argv[1] with `realpathSync` before comparing (fail-safe: an unreadable entry is simply not the main module), keeps the cli-7 import-safety semantics (importing the module still never parses argv), and adds an rc-9 observable fallback: when the entry path unambiguously names this package's `dist/index.js` but canonicalization still misses, the CLI warns on stderr instead of saying nothing. The identical guard in the Codex `pd-hook` entry is fixed the same way (linked installs previously skipped `main()` silently). Regression tests spawn the built CLI and hook through a junction path and assert real output (red before the fix: empty stdout, exit 0).
- edaae75: Fix PRI-898: the global `pd` command is no longer gated on the npm-distributed payload mode, and the Windows shim set now reaches every shell.
  
  - Decoupling: self-contained release-asset installs (the recommended channel) now write the global `pd` shim into the PATH-managed npm global bin dir, so the host agent finds `pd` without manual PATH edits.
  - Windows coverage: in addition to `pd.cmd` (cmd) and `pd.ps1` (PowerShell), the installer writes an extensionless `pd` sh shim — Git Bash/MSYS does not apply PATHEXT, so a bare `pd` only resolves to that exact-named file. Without it a Git Bash host got command-not-found even with the `.cmd` on PATH.
  - Shim path quoting: the sh forwarding shim embeds its target path in POSIX single quotes, so an install directory containing spaces, `$`, backticks or an apostrophe resolves literally instead of being expanded or breaking out of the quote (the previous double-quote form only escaped `"`).
  
  Foreign-`pd` protection, rollback bookkeeping, the uninstaller scan (now also cleaning the extensionless `pd` on Windows), and the `PD_SKIP_GLOBAL_SHIM` smoke gate are unchanged; the pd-cli upgrade / dependency-resolution payload-mode gates stay where they belong.
- edbbcd9: RAH-3 (PRI-907): complete the release-artifact content boundary. @principles/install-layout and principles-disciple (openclaw-plugin) production builds now exclude compiled tests (tsconfig.build.json; plugin build:types declaration emit filtered too) with the same fail-loud dist hygiene assertion as RAH-1. The installer bundle script (create-principles-disciple) filters compiled test artifacts out of every payload copy AND asserts zero test artifacts across all payload components after materialization — test code can no longer reach user machines even if a future package forgets its build-boundary guard. A repo-level scan (check:workspace-artifacts, wired into verify:merge) backstops all workspace dist trees.
- 8b7b775: Security audit run-1 remediation (findings verified against eabbde6d, applied on ccc69252):
  
  - **RuleCode enforcement is now content-bound** (audit HIGH `rulecode-approval-content-unbound`): the production gate and the OpenClaw plugin RuleHost re-verify the current `pi_artifacts` row against the `activation_decisions.artifact_digest` recorded at Owner promotion time before compiling it. A workspace-local rewrite of `content_json` (or lineage fields) is now skipped with a structured `artifact_content_tampered` warning instead of silently executing unapproved code. Rows without a recorded decision (legacy activations) keep their prior behavior. Adds `mapPiArtifactRow`/`PiArtifactRow` exports (the single `pi_artifacts` row→snapshot mapping) so enforcement reproduces the promotion-time digest byte-for-byte.
  - **Replay evaluate is hard-bounded** (audit MEDIUM `rulecode.replay.in-process-evaluate-no-hard-timeout`): pre-activation replay runs each evaluate call through a precompiled vm script with a 2000ms hard timeout — a looping LLM-authored candidate now fails its replay case instead of hanging the console server, evaluator worker, or CLI process.
  - **Governance-store unavailability leaves a durable trace** (audit MEDIUM `gate-failopen-allow-on-state-corruption`): when `state.db` is missing or unreadable, the gate/plugin record a best-effort marker under `~/.pd/enforcement-health/` (outside the agent-writable workspace), and the console governance read model distinguishes "state.db deleted after initialization — enforcement degraded (fail-open)" from a never-initialized workspace.
  - **Console refuses unauthenticated non-loopback binds** (audit MEDIUM `pd-console-noauth-nonloopback-bind`): the loopback-only invariant now keys on the effective authentication state (token-less default included), not just the explicit `--no-auth` flag.
  - **Plugin honors an explicit conversation-access opt-out** (audit LOW `openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out`): the auto-fix repairs only an absent `allowConversationAccess` flag; an explicit `false` (the documented turn-off) is preserved and surfaced as an honored Owner opt-out instead of being silently rewritten on every gateway start.
- Updated dependencies [edbbcd9]
  - @principles/install-layout@0.2.7

## 1.144.1

### Patch Changes

- 0d39045: chore(deps-dev): bump @types/node 26.5.1 -> 26.6.1 in create-principles-disciple.
- 6b05c87: chore(deps): bump @radix-ui/react-slot 1.3.0 -> 1.3.3 (pd-console, ships inside installer).
- 78a3564: chore(deps): bump js-yaml 5.4.1 -> 5.4.2 in create-principles-disciple (runtime dependency).
- 3587170: chore(deps): bump @radix-ui/react-dialog 1.1.15 -> 1.1.23 (pd-console, ships inside installer).
- 7f5558b: chore(deps-dev): bump vitest 5.0.0 -> 5.0.1 in create-principles-disciple.
- 76ed7d0: chore(deps): bump react/react-dom/@types to 19.3.0 (pd-console, ships inside installer). 单独 bump react-dom 会使 react<->react-dom 版本错配导致 Console 白屏（e2e useMemo of null），故本 PR 配对升级 react 与 @types/react.

## 1.144.0

### Minor Changes

- 8424d60: Baseline-cutover accounting for the unpublished source delta between the registry baseline (1.143.3, published from fb397452) and current main: the update-chain rework landed by PR #1768 (bootstrap executor, transaction journal, release-manager authority, dual-ABI payload application, embedded product identity stamp, public exports) plus the pd-console payload changes it ships (owner-decision UI and console surface updates). The version alignment to 1.143.3 is a starting point, not a claim this content shipped.

### Patch Changes

- 40de641: Owner-facing console fixes carried by PR #1789 (focus CTA deep-links), which merged after the Changesets cutover and was not yet in release accounting. The pd-console payload bundled by the installer now: deep-links owner-decision and grouped-approval CTAs to the specific Principle record instead of the generic review list (activation_approval inbox items carry a resolved `principleId`; on resolution failure they fall back to the prior un-deep-linked behavior, rc-9); re-applies the ledger-validation contract that was silently dropped when the shared artifact→principleId resolver was extracted (ERR-142); and escapes externally-supplied values interpolated into CSS deep-link selectors to close a selector-injection path (ERR-143). Installer bundle content is new, so the installer needs a release.

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
