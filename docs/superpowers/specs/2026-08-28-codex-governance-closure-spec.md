# Codex Governance Closure SPEC

- **Status:** Draft / implementation blocked — rev 2 applies review-round-1 contract fixes (G2 split into G2A + R1, canonical pain identity compatibility contract, consumer-flag authority contract, promotion-tail durability, rate-limit compatibility rule)
- **Date:** 2026-08-28
- **Extends:** `docs/architecture/CODEX_CLI_ADAPTER_SPEC.md`
- **Architecture authority:** ADR-0020, including the 2026-08-13 amendment
- **Product authority:** `docs/product/PRODUCT_IDENTITY.md`
- **Required before implementation:** explicit Owner MVP exception, ADR/roadmap amendment, and a passing Slice 0 Codex contract probe

## 1. Decision

Subject to the authorization gates in §3, complete the Codex integration
for the same Owner-governed loop already owned by PD:

```text
visible Codex behavior
→ bounded governance observation
→ existing signal detection and pain admission
→ canonical PD pain and diagnosis task
→ evidence-grounded Principle candidate
→ Owner decision
→ reversible activation in a later Codex turn
→ observable later behavior
```

The decision is intentionally narrower than “mirror Codex sessions.” PD keeps a
short operational observation buffer and promotes only the window linked to an
admitted pain into retained governance evidence. Codex remains authoritative for
the host conversation; PD remains authoritative for governance facts.

The Codex adapter stays a thin protocol adapter. A single host-runtime module
hides validation-independent ingestion behavior behind one semantic interface.
The existing PD runtime continues to own pain, task, candidate, Owner-decision,
activation, and recovery state.

This SPEC does not authorize a Codex-specific evidence database, a second
Principle lifecycle, an outbound Codex runtime, or general session memory.

## 2. Verified current state

The current production path supports:

- active-Principle prompt injection;
- RuleHost before-tool enforcement;
- synchronous Marketplace `PostToolUse` evidence capture;
- a default-on `host.codex` kill switch and neutral fail-open behavior.

It does not currently support the requested governance closure:

- `transcript_path` is validated and discarded;
- Codex user and assistant turns are not written to `trajectory.db`;
- all production Codex tests use `transcript_path: null`;
- `SessionEnd` is declared but not registered or decoded;
- Codex tool pain writes `runtime_task_id = null` and does not call
  `PainToPrincipleService`;
- OpenClaw's `SignalCollectorHost.detectSync` path has no Codex equivalent;
- the existing OpenClaw auto-consumer does not lease `diagnostician` tasks;
- Companion supervises Console only and is not a Workspace diagnosis worker;
- the legacy global installer still writes an async `PostToolUse` entry that the
  currently pinned Codex version may skip.

Therefore “PD can be loaded by Codex” is true, while “PD can learn from a Codex
conversation” is false in the current implementation.

## 3. Authorization and go/no-go gates

No production implementation issue may be created from later sections until every
pre-implementation gate (G0, G1, G2A) is GO. Read-only contract-probe and
decision-record work is allowed. A failed gate changes this SPEC; it is not an
implementation detail.

Gates are split by what they can honestly verify: G0, G1, and G2A are
decision-and-evidence gates that precede implementation; R1 is a rollout gate
verified against the implemented system. No pre-implementation gate requires
production implementation to exist before implementation is authorized.

### G0 — Owner MVP exception

ADR-0020 §10.3 and the post-MVP roadmap still hold long-running service
replacement and cross-session continuation. The Owner must explicitly approve:

- Codex conversation ingestion as an MVP exception;
- one new Companion-owned Workspace diagnosis worker;
- the bounded data policy in §11;
- the new quiet rollout flag in §17.

Completion criterion: ADR-0020 is amended, the roadmap entry is Active, and the
approval identifies this SPEC revision. Until then this file is design evidence
only.

### G1 — Codex host contract probe

Slice 0 must prove against official source and an on-device installed fixture:

1. the exact event emitted after each completed assistant turn;
2. whether `Stop`, `SessionEnd`, or another released event is the reliable event;
3. that `transcript_path` is non-null and the referenced record is flushed before
   the selected hook runs;
4. the stable identity fields for root session, rollout/transcript, fork/subagent,
   turn, message, and tool call;
5. hook timeout, stdout schema, unknown-field behavior, and concurrent invocation
   behavior;
6. transcript rotation, compaction, restart, fork, subagent, and archive behavior;
7. canonical session roots for default and configured Codex homes on Windows,
   macOS, and Linux.

Completion criterion: checked fixtures from the minimum and current supported
Codex versions make every statement above executable. The selected turn-complete
event and minimum version are recorded in the ADR amendment. If no released
event provides a flushed transcript tail, the design is NO-GO; scanning unrelated
home-directory sessions is not an accepted fallback.

### G2A — Data policy approval

The Owner must approve an explicit opt-in disclosure covering visible user and
assistant content, the limits in §11, local storage, promotion, recovery, disable,
archive, and deletion behavior.

Completion criterion: the disclosure text and the data-policy decisions above are
Owner-approved and the approval identifies this SPEC revision. This gate is
decision-only — like Slice 0, it freezes policy and disclosure text; it does not
require the implemented setup experience to exist.

### R1 — Consent UX verification (rollout gate)

R1 is verified against the implemented system and never blocks Slice 0. It must
be GO before any release that allows ingestion to be enabled through setup, and
before the §17 default-on decision. Required evidence, on the installed setup
path:

1. setup presents the G2A-approved disclosure before ingestion can be enabled;
2. declining leaves `codex_conversation_ingestion` off and all existing
   prompt/RuleHost/tool governance working unchanged;
3. declining never opens or reads the transcript;
4. upgrade never enables ingestion and never bypasses consent implicitly.

Completion criterion: executable BDD/E2E scenarios prove all four behaviors and
are recorded against this SPEC revision.

## 4. Goals

1. Persist bounded, visible Codex observations with correct session, rollout,
   agent, turn, message, and tool lineage.
2. Route Codex user corrections and tool failures through the existing signal
   detection and pain-admission semantics.
3. Create or recover exactly one Diagnostician task for one canonical pain.
4. Supply a retained, privacy-bounded conversation window to diagnosis.
5. Preserve one Workspace-scoped authority for evidence and governance facts.
6. Make missing, stale, partial, malformed, or backlogged evidence visible.
7. Preserve prompt and RuleHost protection when ingestion or automatic diagnosis
   is unavailable.
8. Prove the Owner loop in a real installed Codex session.

## 5. Non-goals

- General Codex memory, session replay, search, export, or chat analytics.
- Importing historical sessions not observed through an enabled Workspace hook.
- Retaining every visible turn indefinitely.
- Capturing hidden reasoning, reasoning summaries, chain-of-thought, secrets,
  system/developer prompts, approval tokens, or environment snapshots.
- Replacing Codex's transcript as host-conversation authority.
- Running general tasks, retries, repair, or orchestration for Codex.
- Running PD internal agents through Codex.
- Making autonomous Principle approval decisions.
- Codex Cloud or remote transcript acquisition.
- A Codex-only UI, evidence schema, Principle lifecycle, or activation channel.
- Making statistical claims that PD caused behavior change.
- Moving OpenClaw's optional LLM deep-judgment signal path into a hook subprocess.
  MVP parity covers the existing synchronous high-precision correction rules and
  existing tool-pain admission. A durable ambiguous-signal classifier requires a
  separate approved SPEC.

## 6. Domain language and authority

### Host Transcript

The Codex-owned append-oriented record. It is authoritative for content Codex
persisted, but PD does not own its format, retention, or completeness.

### Rollout Identity

The identity of one physical Codex transcript/rollout. It is distinct from the
root session ID: forks and subagents may share root lineage while writing separate
transcripts whose ordinals restart.

### Governance Observation

A validated projection of one visible `user_turn`, `assistant_turn`, or
`tool_call`. It contains only the facts in §7 and is never a raw transcript row.

### Operational Observation

A Governance Observation retained temporarily so signal detection and nearby
context can work. It is not automatically durable governance evidence.

### Promoted Evidence

The bounded observation window linked to a canonical admitted pain. Promotion,
not collection, makes a turn eligible for governance retention and diagnosis.

### Transcript Record Key

The physical import identity:

```text
host kind + rollout identity + validated record ID or ordinal
```

It prevents replaying one transcript row but does not identify the same logical
event delivered by both a live hook and the transcript.

### Logical Observation Key

The semantic identity used for upsert and cross-source deduplication:

- user: host + rollout + turn + `user`;
- assistant: host + rollout + turn + assistant item ID, or verified final-item
  ordinal when Codex provides no item ID;
- tool: host + rollout + `tool_use_id`.

Root session ID alone and transcript ordinal alone are forbidden dedup keys.

### Authority model

| Fact                                    | Authority                                  |
| --------------------------------------- | ------------------------------------------ |
| Raw Codex conversation                  | Codex transcript                           |
| Temporary and promoted observations     | `.state/trajectory.db`                     |
| Transcript progress and degradation     | ingestion state in `trajectory.db`         |
| Canonical pain and Diagnostician task   | `.pd/state.db` through existing PD runtime |
| Principle lifecycle and Owner decisions | existing PD governance stores              |
| Codex and ingestion enablement          | `.pd/config.yaml`                          |
| Worker lease/task state                 | existing Runtime V2 task store             |

An ingestion checkpoint is a derived operational cursor. It must never become a
second authority for session content, pain, tasks, or Owner decisions.

## 7. The host-observation module

The real variation axis is host decoding: OpenClaw emits live semantic events;
Codex emits subprocess payloads plus a transcript. Both need the same persistence,
deduplication, promotion, and pain-admission behavior. Therefore the seam lives at
one cross-package interface owned by `@principles/host-runtime`:

```text
ingestGovernanceObservations(batch) → result
```

The batch contains invocation context plus a bounded array. Every observation has:

```text
schemaVersion
hostKind
rootSessionId
rolloutIdentity
agentIdentity? / parentRolloutIdentity?
hostTurnId
kind: user_turn | assistant_turn | tool_call
logicalObservationKey
transcriptRecordKey?
toolUseId? / assistantItemId?
visibleText? / sanitizedToolFacts?
observedAt
source: live_hook | transcript
completeness: complete | partial
```

The result contains:

```text
inserted / enriched / duplicate / promoted counts
checkpoint committed or unchanged
admitted canonical pain IDs and task IDs
lag and completeness
bounded warnings, stable reasons, and nextAction
```

The module hides SQLite schema, transactions, live-to-transcript correlation,
retention, promotion, signal routing, and crash reconciliation. Callers do not
coordinate those steps. Tests exercise the same interface used by production.

Module ownership:

| Module                      | Responsibility                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@principles/codex-adapter` | Validate hook payload, authenticate/canonicalize transcript path, decode verified Codex JSONL, normalize observations.                                                                      |
| `@principles/host-runtime`  | Own the host-observation module, trajectory migration, sanitization, upsert, checkpoint, retention/promotion, synchronous signal detection, pain submission, and reconciliation entrypoint. |
| `@principles/core`          | Existing pure signal rules, admission policy, canonical pain/task lifecycle, context assembly, diagnosis, and governance policy.                                                            |
| `pd-cli`                    | Strict health, audited quarantine, catch-up, and manual diagnosis recovery commands.                                                                                                        |
| `pd-companion`              | After G0 only, own one Workspace worker that catches up ingestion and leases Diagnostician tasks.                                                                                           |
| OpenClaw adapter            | Continue supplying live observations; migrate to the shared interface only where parity tests prove no behavior loss.                                                                       |

No transcript or SQLite I/O is added to `principles-core`. A new core I/O seam
requires separate review and registration in `io-seam-registry.json`.

## 8. Hook and lifecycle contract

`TURN_COMPLETE` below means the one released Codex event selected by G1. The
implementation must not register both `Stop` and `SessionEnd` speculatively.

| Codex event                                     | Required PD behavior                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`                                  | Validate Workspace/path authority, recover checkpoint, process a bounded pending delta, report health.                                                                                                                    |
| `UserPromptSubmit`                              | When rollout identity is authenticated, upsert the visible user turn and run synchronous correction detection once; process the preceding assistant delta; inject active Principles regardless of ingestion availability. |
| `PreToolUse`                                    | Run existing RuleHost enforcement with no transcript dependency.                                                                                                                                                          |
| `PostToolUse`                                   | Upsert the live tool observation by `tool_use_id`, run existing tool-pain admission, process a bounded delta.                                                                                                             |
| `TURN_COMPLETE`                                 | Process transcript batches until EOF or the measured hook deadline; prove the completed assistant turn or report explicit lag.                                                                                            |
| `SessionEnd` when distinct from `TURN_COMPLETE` | Mark lifecycle closed and enqueue/advertise remaining catch-up; it is not assumed to contain the final flushed turn.                                                                                                      |

Latency-sensitive hooks process at most 256 records and 1 MiB. `TURN_COMPLETE`
may loop over multiple batches but stops at the measured deadline minus a 250 ms
stdout safety margin. A checkpoint advances only in the transaction that commits
its decoded observations. Remaining work is visible lag and is handled by the
Companion worker or the explicit catch-up command.

A Codex installation without the Companion worker remains safe and usable for
prompt/tool governance. It is reported as `manual_action_required`, and neither
setup nor health may call it an automatic governance closure.

## 9. Transcript and path contract

1. Treat every record and nested payload as `unknown` until validated.
2. Accept only G1 fixture-backed envelopes and visible-content variants.
3. Map visible Owner text, visible final assistant text, and verified tool facts.
4. Exclude hidden/system/internal content before persistence and logging.
5. Preserve physical order and semantic lineage separately.
6. Skip unknown optional records with bounded structured warnings.
7. Stop on a malformed required envelope without advancing its checkpoint.
8. Distinguish an incomplete final line from a permanently invalid committed
   record; only the former is retried silently after file growth.
9. Never persist an absolute transcript path. Durable sourceRefs contain host,
   rollout, turn, item/tool, and record identities only.

Path authorization uses the transcript path supplied by the authenticated hook
plus the G1-verified Codex home resolver. The adapter opens the canonical file,
checks canonical containment, reads from that same handle, rechecks the post-read
byte bound, and rejects traversal, junction/symlink escape, replacement, or a
non-regular file. Hard-coded `~/.codex/sessions` containment is insufficient when
Codex uses a configured home.

Null or unauthenticated transcript paths preserve the already-supported direct
tool evidence and produce `transcript_unavailable`. They do not persist a new user
conversation row using root session ID as a substitute for rollout identity, and
they never fabricate a complete conversation.

## 10. Identity, idempotency, and concurrency

The schema uses a surrogate session/rollout row ID. `(host_kind,
rollout_identity)` is unique; `root_session_id` is lineage, not the primary key.
This prevents collisions between OpenClaw/Codex and between Codex forks.

Source precedence is fixed:

- user: `UserPromptSubmit` creates the row; transcript delivery enriches it with
  record identity and verified ordering;
- tool: live `PostToolUse` creates the row; transcript delivery enriches or
  no-ops by `tool_use_id`;
- assistant: the verified transcript is the only content source.

Upsert uses the Logical Observation Key. Transcript Record Key has a separate
unique constraint. A content mismatch for one logical key is a lineage conflict:
keep the first committed content, mark the observation partial, stop checkpoint
advance at the conflicting record, and require audited recovery. Never overwrite
silently.

Concurrent fresh hook subprocesses use SQLite transactions and uniqueness/CAS,
not process memory. Replayed hooks, batches, process restarts, forks, and
crash-before-task-link must create no duplicate turn, tool call, pain, or task.
Canonical pain ID remains the diagnosis-task dedup authority and is deterministic,
never a random trace ID.

### Canonical pain identity compatibility contract

Canonical pain identity has exactly one authority: the existing production pain
canonicalization — the content-derived canonical ID in
`production-pain-evidence.ts`, deduplicated through the unique
`pain_events.canonical_pain_id` index — together with the admission path that
owns correction-pain creation in the PD runtime. The host-observation layer
contributes a normalized admission input to that authority; it never derives a
second, parallel pain identity. This clause deliberately replaces the current
correction-path practice of minting `correction_<traceId>` random IDs
(`signal-collector-host.ts` `routeStrong`): a trace ID may survive as a
non-identity correlation field, but never as dedup identity.

Observation identity and pain identity are different keys with a mapping, never
equated:

- the Logical Observation Key (§6) deduplicates transcript/live observations and
  carries lineage;
- the canonical pain ID deduplicates admission and diagnosis tasks;
- detection and admission run exactly once per logical observation (§12), so a
  transcript replay of an already-admitted live event is an observation-level
  no-op and cannot mint a second pain.

When admission runs for an event that was never admitted live (for example, the
legacy async hook was skipped), the host-observation module must feed the same
normalized fields the live path would have produced (workspace, session, turn,
tool, source, params, result, error, exit code) into the existing derivation, so
the resulting canonical pain equals what the live path would have produced for
the same tool call. §19 requires a compatibility test proving that a legacy live
`PostToolUse` pain plus a transcript replay of the same tool call produce exactly
one canonical pain and one pending Diagnostician task.

## 11. Bounded data and promotion policy

Conversation ingestion is explicit opt-in and uses a hybrid policy:

- keep at most the latest 32 visible user/assistant turns per rollout as
  operational observations;
- expire unpromoted observation content after 7 days, whichever bound is reached
  first;
- on admitted pain, promote at most the 12 preceding visible turns, the triggering
  turn/tool observation, and the next completed assistant turn;
- promoted evidence remains governed by the existing pain-evidence lifecycle;
- source identity, checkpoint, counts, degradation, and tombstone facts may
  remain after unpromoted content expires, but they contain no message text;
- no UI or CLI offers session replay, full-text search, or bulk transcript export.

The promotion window cannot complete atomically at admission: the "next completed
assistant turn" does not exist yet when a pain is admitted. Admission therefore
records a durable pending promotion tail (pain ID, rollout identity, trigger
turn/item identity) in the same transaction that promotes the preceding window.
The next completed assistant turn for that rollout satisfies and clears the
pending tail. Crash, restart, and the reconciliation pass (§13) must complete or
explicitly report a stale pending tail; a silently dropped tail is a defect,
because diagnosis reads promoted evidence only (§14).

Pruning runs on bounded ingestion/catch-up maintenance, not on the prompt or
before-tool critical decision. It never deletes Owner decisions or the governance
assets protected by `DATA_CLEANUP_GUIDELINES.md`. Any command that removes
promoted evidence requires backup, default dry-run, explicit confirmation, row
accounting, and archive-first behavior.

Disabling ingestion stops future transcript reads immediately. Existing
operational content ages out normally; promoted evidence remains until an
authorized governance cleanup. Uninstall does not silently delete either class.

## 12. Signal detection and pain admission

Persisting a conversation is not governance closure. Every newly inserted live
user turn passes exactly once through the existing synchronous high-precision
correction detector after agent-to-agent traffic is excluded. The detector and
admission semantics are extracted from the OpenClaw-only wrapper into the
host-observation module; OpenClaw and Codex use the same keyword store, rule
version, score, admission gate, and provenance semantics. Rate limiting follows
the compatibility rule below rather than an unconditional shared authority.

Required outcomes:

- high-confidence Owner correction → deterministic canonical pain;
- admitted tool failure → deterministic canonical pain;
- weak or ambiguous input → retained only as bounded operational evidence unless
  another existing admission rule reaches threshold;
- no signal → no pain and no diagnosis task;
- duplicate delivery → no repeated detection or rate-limit consumption.

Codex admission correctness must not depend on process-local fire-and-forget work
or an in-memory rate-limit bucket: every Codex hook is a fresh subprocess, so
process-local state is dead on entry (ADR-0020). Correctness therefore must not
depend on process-local rate limiting. The correction detector's STRONG
per-session rate-limit bucket is persisted transactionally in `trajectory.db`
for Codex admission, keyed by Workspace, root session, rule version, and time
window. Cross-host rate-limit convergence is required only for rules whose
admission semantics depend on a shared quota; it is not, by itself, a Slice B
requirement. OpenClaw's existing in-memory correction rate limit and the
tool-pain cooldown keep their current behavior — including the Codex cooldown
inactivity ADR-0020 explicitly accepted with canonical pain idempotency as the
guard. This SPEC does not reverse ADR-0020's persistence rejection for the
tool-pain cooldown; a future shared-quota authority, if evidence requires one,
is a separate ADR amendment recorded at G0.

Admission and the durable submission of a pending Diagnostician task are awaited
before the hook returns; LLM diagnosis itself is never awaited. Failure leaves an
observable retryable pain/dead-letter state.

The new provenance value is `host_context_bound` plus `hostKind`. Legacy
`openclaw_context_bound` remains readable and is normalized on read. This is an
additive compatibility migration, not a destructive rewrite.

## 13. Pain continuation and worker ownership

For each admitted pain:

1. promote the bounded evidence window;
2. call `PainToPrincipleService` in async mode with the canonical pain ID;
3. create or recover exactly one pending Diagnostician task;
4. persist the task ID back to the pain projection;
5. return from the hook without executing an LLM.

Because trajectory and Runtime V2 use separate SQLite stores, the operation
cannot be one transaction. The host-observation module exposes one idempotent
reconciliation pass for admitted pains lacking a task link and for promotion
windows lacking their completed tail (§11). The Companion worker and CLI call
that same pass; neither implements its own reconciliation logic.

Automatic mode adds one real background responsibility. After G0, Companion is
the unique lifecycle Owner:

- it discovers opted-in Workspaces from the canonical install manifest;
- it starts at most one worker per canonical Workspace path;
- the worker acquires the existing Runtime V2 lease before running a task;
- it first catches up transcript lag, then reconciles pain-to-task links and
  pending promotion tails, then leases `diagnostician`; downstream validated
  candidates continue through the existing full-chain consumer semantics;
- expired leases use the existing recovery sweep;
- provider outage produces existing retry/needs-attention state;
- Companion exit, Workspace removal, ingestion disable, or consumer pause stops
  new leases without mutating evidence or Owner decisions;
- multi-Workspace state is keyed by canonical Workspace path, never a module-level
  singleton value.

`internalization_auto_consumer` is elevated from an OpenClaw service switch to
the Workspace internalization execution authority: one flag ID, one definition in
the existing feature-flag contract, two consumers. With the flag false, the
OpenClaw auto-consumer stops leasing (unchanged existing behavior) and the
Companion worker stops leasing `diagnostician` and downstream runner tasks. The
pause is an execution pause, not an evidence freeze: transcript catch-up (gated
by `codex_conversation_ingestion`, not by this flag) and the idempotent
reconciliation pass continue, because they create no new LLM execution, and
manual CLI diagnosis and `run-once` remain allowed as explicit Owner actions.
The three controls form a documented ladder, not interchangeable toggles:
`codex_conversation_ingestion = false` stops transcript reads;
`internalization_auto_consumer = false` stops automatic task execution;
`host.codex = false` stops all Codex PD host behavior.

The current OpenClaw auto-consumer cannot simply be relabeled: it excludes
`diagnostician` and has an OpenClaw lifecycle interface. Implementation may
extract its runner construction and recovery logic, but the Companion worker is a
new module and must be verified as such.

Manual mode remains supported through existing task/diagnosis commands plus new
bounded `pd codex ingest catch-up`. Health must give the exact next command. It is
recovery, not evidence that automatic mode works.

## 14. Diagnosis context

`SqliteContextAssembler` receives the existing host-neutral trajectory reader.
When Runtime V2 history is empty and a valid rollout/session hint exists, it
assembles a chronological `conversationWindow` only from promoted observations.

The diagnosis target contains host kind, root session, rollout, agent/parent
lineage when verified, turn/item identity, transcript completeness, evidence
sourceRefs, and explicit ambiguity notes for gaps or truncation. Evidence limits
and sanitization remain shared. Insufficient evidence produces `needs_evidence`;
automatic collection does not justify higher confidence.

## 15. Health, recovery, and Owner experience

`pd health --host codex` and the existing Console health surface show:

- adapter/runtime version and G1 contract-fixture version;
- Workspace initialization, hook trust/registration, and both flag states;
- consent state without displaying captured text;
- last hook, successful ingestion, selected completion event, and checkpoint;
- per-rollout completeness and lag records/bytes;
- operational/promoted counts and next expiry time;
- bounded recent degradation reasons and next actions;
- admitted pain without task-link count;
- Diagnostician pending/leased/retry/needs-attention counts;
- Companion worker mode: `ready`, `manual_action_required`, `paused`, or
  `degraded`.

`ready` is true only when the current installed contract fixture matches, hooks
are trusted, ingestion is enabled/consented, no open rollout exceeds one
turn-complete event of lag, no unreconciled admitted pain is older than 60 seconds,
and the Companion worker holds or can acquire the Workspace lease. Unknown is not
reported as healthy.

Pain and candidate views identify Codex as evidence host and show safe lineage,
completeness, and omissions. They do not expose raw paths or offer transcript
replay. No new dashboard or notification stream is required.

Recovery commands:

- `pd codex ingest catch-up --workspace <path> [--json]` performs bounded
  non-destructive catch-up;
- `pd codex ingest quarantine --workspace <path> --rollout <id> --record <id>`
  defaults to dry-run and requires `--confirm` to skip a permanently invalid row;
- quarantine records digest, reason, operator, timestamp, and gap; it never edits
  the Codex transcript;
- `--json` emits exactly one documented object and failed validation mutates
  nothing.

## 16. Failure, security, and privacy rules

| Failure                       | Required behavior                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Transcript null/missing       | Keep direct evidence; mark unavailable; continue prompt/gate paths.               |
| Unauthorized/replaced path    | Refuse read; structured security reason; neutral host output.                     |
| Incomplete tail               | Keep checkpoint; retry after growth; do not call it corrupt.                      |
| Permanent malformed record    | Stop at record; expose quarantine command; preserve later data as lag.            |
| Logical-key content conflict  | Preserve first content; mark partial; stop and require audited recovery.          |
| SQLite busy/unavailable       | No checkpoint advance or partial-success claim.                                   |
| Duplicate/concurrent delivery | Transactional idempotent no-op or enrichment.                                     |
| Worker unavailable            | Keep task pending; report manual next action.                                     |
| Provider outage               | Existing retry/needs-attention policy; preserve lineage.                          |
| Ingestion flag off            | No transcript reads/new conversation writes; prompt/tool governance stays active. |

All external values obey `rc-1` through `rc-9`. Bounds apply after decoding and
sanitization as well as before reads. Unknown values in diagnostics use bounded
safe serialization. Hook stdout remains exact Codex JSON; diagnostics go to
stderr and PD observability stores.

Product telemetry stays coarse and contains no consent state, session/rollout/
turn/tool identifiers, paths, checkpoints, message text, or content digests. No
network export is added.

## 17. Flags, rollout, and distribution

`host.codex` remains the total Codex-host kill switch. Add one canonical quiet
flag to the current feature-flag registry:

```yaml
features:
  codex_conversation_ingestion:
    category: quiet
    enabled: false
    since: 2026-08-28
```

Flag-off means no transcript open/read, no new Codex user/assistant observation,
and no Codex conversation-signal detection. Existing prompt injection, RuleHost,
and current tool evidence remain byte-for-byte compatible.

Promotion to default-on requires G0, G1, G2A, and R1, all acceptance criteria, installed-bundle
tests, real-session E2E, one release of opt-in dogfood with no privacy/lineage P1,
and an explicit Owner decision. Retirement is considered after one further stable
default-on release; the decision is recorded rather than inferred from time.

The existing `internalization_auto_consumer` pause remains the execution rollback
under the consumer contract in §13;
no Codex-specific consumer flag is added. Rollback order is ingestion flag,
consumer pause, then `host.codex` only if all Codex governance must stop.

Distribution decision:

- Marketplace plugin is the only supported new Codex installation path;
- the legacy global-hook installer becomes migration/uninstall-only and must stop
  writing new Codex hook registrations;
- setup detects legacy async `PostToolUse`, explains that evidence may be missing,
  and offers explicit migration to the Marketplace plugin;
- setup verifies Node, installed runtime, Workspace, trust, consent, and worker
  mode;
- upgrade preserves identities/checkpoints and never reimports committed rows;
- uninstall removes PD-owned registrations/runtime only and preserves evidence.

## 18. BDD and acceptance contract

Add an Owner-readable Codex governance feature. Scenarios exercise real hook
registration/dispatch and include:

1. existing Principle injection and RuleHost denial remain unchanged;
2. a real non-null transcript produces one user and one assistant observation;
3. live user/tool plus transcript replay enriches rather than duplicates;
4. two forks sharing a root session remain separate and correctly linked;
5. a high-confidence Owner correction creates one canonical pain and one pending
   Diagnostician task;
6. ordinary non-signal conversation creates no pain;
7. tool failure uses the same admission and task-dedup authority; live and
   transcript delivery of one tool call resolves to one canonical pain (§10);
8. the selected `TURN_COMPLETE` path captures the final assistant turn or exposes
   lag that the worker catches up within 60 seconds;
9. hidden/system content and raw paths are absent from DB, logs, stdout, and
   telemetry;
10. malformed, incomplete-tail, conflict, quarantine, and restart behavior follows
    §§9–10 and §15;
11. unpromoted content ages out while promoted evidence and Owner decisions remain;
12. worker/provider recovery advances one task without duplicate candidates;
13. diagnosis yields an evidence-linked candidate or explicit `needs_evidence`;
14. Owner approval affects a later Codex prompt or RuleHost decision;
15. flag-off, consumer pause, uninstall, and legacy migration are reversible;
16. OpenClaw and Codex share a Workspace without evidence contamination;
17. setup consent follows R1: the disclosure is presented, declining leaves all
    governance intact, and declining causes no transcript read.

The work is complete only when:

- G0, G1, and G2A are GO, and R1 is GO before rollout;
- the correction-to-pain scenario proves the real production detector, not a
  pre-seeded admitted pain;
- the final-turn scenario proves the selected real host event;
- duplicate tests cover live/transcript, restart, concurrency, fork, and subagent;
- automatic mode proves Companion ownership; manual mode is not substituted;
- installed Marketplace bundle works from a path containing spaces;
- minimum/current Codex fixtures, privacy negatives, migrations, package consumer
  tests, and real Codex E2E are green with no skipped scenario;
- `npm run verify:merge` is green.

## 19. Verification matrix

| Risk                   | Required evidence                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Host contract drift    | Official-source pin plus minimum/current on-device fixtures and a fail-loud mismatch test.                   |
| Parser/path trust      | Property/adversarial tests, symlink/junction/replacement cases, configured Codex home, post-read size check. |
| Identity               | Fork/subagent/root-session fixtures and logical-vs-physical key mismatch tests.                              |
| Idempotency            | Repeated live hook, transcript, batch, concurrent subprocess, restart, crash-before-link, crash-before-promotion-tail, and live+transcript same-canonical-pain tests.        |
| Data boundary          | 32-turn/7-day pruning, promotion window, tombstone, disable, archive, and protected-asset negatives.         |
| Signal closure         | Real correction and non-signal controls through production detection/admission.                              |
| Worker lifecycle       | Singleton/lease, multi-Workspace, crash, pause, uninstall, provider recovery, and Companion absence.         |
| Cross-package contract | Codex adapter, host-runtime, core, CLI, Companion, Console, and OpenClaw consumer tests.                     |
| Owner journey          | Real correction → pain → diagnosis → candidate → approval → later activation E2E.                            |
| Distribution           | Clean packed Marketplace install; legacy async-hook migration; paths with spaces.                            |

Every regression test includes a negative control proving it fails when the
claimed production mechanism is removed or bypassed.

## 20. Delivery slices

### Slice 0 — Decision evidence

- complete G0, G1, and G2A (decision-only: policy approval plus the frozen
  disclosure text; R1 is verified later against the implementation);
- run the Codex contract probe;
- select and record `TURN_COMPLETE`, supported versions, identities, roots, and
  time budgets;
- freeze real fixtures and the disclosure text.

Completion: every gate is GO. No production implementation precedes this slice.

### Slice A — Observation interface and storage

- one host-observation interface;
- decoder/path validation and real fixtures;
- additive rollout/observation/checkpoint schema;
- live/transcript identity and upsert;
- bounded opt-in storage, promotion primitives, health, and flag-off behavior.

Completion: a real session yields private, correctly linked, deduplicated rows;
no claim of pain or diagnosis closure is made.

### Slice B — Signal and task submission

- extract synchronous detector/admission semantics from the OpenClaw wrapper;
- wire user corrections and tool pains through the shared module;
- promote evidence and submit `PainToPrincipleService` async tasks;
- reconcile crash-before-link and expose CLI recovery.

Completion: a real correction, not a seeded pain, creates exactly one pending
Diagnostician task with promoted evidence.

### Slice C — Companion worker

- add the Companion-owned per-Workspace worker;
- catch up transcript lag and run reconciliation;
- lease/run Diagnostician, then reuse existing downstream consumer logic;
- prove leases, multi-Workspace isolation, pause, crash, and manual fallback.

Completion: an admitted pain reaches a terminal diagnosis state without an LLM
running in a hook. This slice is the point automatic closure becomes truthful.

### Slice D — Owner loop and rollout

- extend existing evidence/health/review surfaces;
- implement setup consent UX and produce passing R1 evidence before rollout;
- run BDD and installed real Codex E2E;
- retire new legacy hook registrations and verify migration;
- make an explicit default-on or remain-opt-in decision.

Completion: Owner approval changes later Codex behavior and remains reversible.

Each slice is independently reviewable and may not claim a later slice's outcome.

## 21. Complexity Delta

```text
New durable source of truth: NO
New persisted schema/state: YES
New subsystem/service/background process: YES
New public abstraction/interface: YES
New runtime feature flag: YES
New cross-package dependency: YES
New host/platform-specific behavior: YES
New external/network capability: NO
```

### Persisted state — YES

Existing tables cannot represent rollout-vs-root lineage, logical/physical
identity, checkpoint health, retention class, promotion, or quarantine. Additive
state hides those invariants inside the host-observation module. A smaller
session-ID-only extension fails fork and live/transcript dedup. Verify migrations,
round trips, pruning, crash recovery, and older OpenClaw rows. Rollback stops new
writes while keeping rows readable; removal requires a later compatible migration.

### Background module — YES

No current Codex process can safely run pending Diagnostician tasks, and the
OpenClaw auto-consumer explicitly excludes them. The Companion-owned worker hides
catch-up, reconciliation, leases, and recovery behind one lifecycle. Running LLMs
inside hooks or claiming manual CLI as automation is insufficient. Verify all
worker lifecycle cases in §19. Pause/uninstall stops leasing; reverting the module
leaves task/evidence state recoverable through CLI.

### Public cross-package interface — YES

Codex and OpenClaw are two real adapters for one semantic ingestion seam. Without
the interface, sanitization, dedup, promotion, and admission would be duplicated.
Its single operation and result hide the implementation and are the production
test surface. It is removable only by returning each host to separate behavior,
which is the rejected duplication. Companion must consume the host-runtime
reconciliation/worker interface, which is a new cross-package dependency. Slice A
must enumerate the full package graph and prove the chosen direction introduces
no cycle. Reverting automatic mode removes that dependency while preserving the
CLI recovery path.

### Runtime flag — YES

Transcript reading has a privacy and rollback risk independent of existing
prompt/tool governance. One quiet flag is the smallest independent kill switch.
Flag-off and migration tests verify zero transcript reads. Retirement follows the
explicit lifecycle in §17 and never deletes evidence.

### Host-specific behavior — YES

Only the Codex adapter knows its event names, transcript schema, roots, and rollout
identity. Keeping those rules in the adapter prevents core/host-runtime drift.
Fixtures and installed E2E verify them. Disabling the ingestion flag removes the
behavior without affecting other hosts.

## 22. MVP and emotional-value gates

### `mvp-q-1-what-if-skip`

Codex can enforce existing Principles but repeated Codex corrections remain
trapped in host transcripts. Owners must repeat themselves and PD cannot complete
its advertised loop for Codex.

### `mvp-q-2-how-observed`

The Owner sees a correction linked to one pain, one diagnosis task, a bounded
evidence window, transcript/worker health, and a reviewable candidate; an approved
Principle then affects a comparable later Codex interaction.

### `mvp-q-3-how-disabled`

Disable ingestion, pause the existing consumer authority, or disable `host.codex`.
Each step is observable and preserves prior governance facts. Operational content
ages out under §11.

### `mvp-q-4-emotional-value`

The feature reduces repeated-correction fatigue, uncertainty, and loss of control.
It creates sedimentation, clarity, and control by showing a short evidence chain,
honest gaps, and reversible decisions. Explicit opt-in and bounded promotion avoid
turning that reassurance into surveillance anxiety or an Owner-facing log stream.

## 23. Engineering gates and decision closure

- Runtime contract `rc-1` through `rc-9` applies to payloads, transcript JSON,
  paths, SQLite rows, serialization, checkpoints, and degraded output.
- CLI contract `cli-1` through `cli-7` applies to health, catch-up, quarantine,
  migration, and worker recovery.
- BDD applies because this changes an MVP-Core Owner journey and operator contract.
- Error-pattern routing: EP-01, EP-02, EP-03, EP-04, EP-06, EP-07, EP-08, EP-09,
  and EP-12. Detailed ERR entries are selected only when implementation evidence
  makes them materially relevant.
- Cross-package changes enumerate all consumers and test through production seams.
- Any destructive cleanup follows `DATA_CLEANUP_GUIDELINES.md` and preserves
  Owner governance assets.

After G0 approval:

1. amend ADR-0020 §10.3 and the public/private post-MVP roadmap, and record the
   §12 rate-limit compatibility decision (OpenClaw cooldowns unchanged; persisted
   STRONG bucket for Codex admission) so the ADR's persistence rejection is not
   silently drifted;
2. add the Owner-readable BDD feature before changing observable behavior;
3. update architecture navigation, Codex operator docs, and privacy disclosure;
4. update private governance/product guidance without copying private content into
   the public repository;
5. create a separate implementation plan and independently grabbable issues.

Until G0, G1, and G2A are GO, this SPEC does not authorize MVP-Core expansion, transcript
collection, schema mutation, or background-runtime changes.
