---
"@principles/install-layout": minor
"@principles/host-runtime": minor
"principles-disciple": minor
"@principles/pd-cli": minor
"create-principles-disciple": minor
---

PD Service Host Phase 4 (PRI-1282, SPEC-PD-SERVICE-HOST-001 §11 Phase 4 /
§8.4 / §4): OpenClaw decoupling — the standalone OpenClaw worker, the
Gateway ownership gate + quiesce protocol, and the §8.4 CAS transition
primitive (phase attribution corrected: Phase 4 lands the minimal
reusable primitive, Phase 5 reuses it for Codex/WorkBuddy).

@principles/install-layout (minor) — the §8.4 state-machine WRITE half the
schema deferred: `transitionWorkspaceBackgroundExecution` (six legal
transitions: begin/abort/complete_handover, begin/complete/abort_rollback)
under a cross-process directory lock (O_EXCL + owner metadata + TTL
quarantine reclaim) with in-lock monotonic-generation fencing,
operationId idempotency (same-op replay no-op, foreign-op
`operation_in_progress`), atomic rename landing, unknown top-level field
preservation, and legacy single-key migration in the same write;
`readWorkspaceBackgroundOwnership` — the single fail-closed read
projection shared by the Gateway gate, the openclaw worker gate and the
handover/rollback commands; `withInstallManifestWriteLock` for whole-file
writers (ERR-168).

principles-disciple (minor) — new `./openclaw-worker` subpath export: the
bounded OpenClaw workspace worker cycle reusing the SHARED consumer cycle
+ diagnostician with the SAME OpenClaw host facts the Gateway injects
(catalog/semantics/hostKinds pinned by a runtime parity test; the only
intentional difference is attribution `service-host-worker`), worker
liveness evidence (`.state/openclaw-worker-liveness.json`, codex pattern),
PD_INVOCATION_SOURCE/PD_INVOCATION_ID attribution, declaration
refresh+validation, the §8.4 ownership gate (only `service_host_owned` is
consumable; unreadable marker fails closed — manual invocation can never
double-consume a Gateway-owned workspace) and the no-consume readiness
self-check. Gateway InternalizationAutoConsumerService: §8.4 marker gate
at service-start, per-tick AND post-cycle (a handover opened mid-cycle is
observed the moment the cycle ends); quiesce protocol with the persisted
`pd.gateway-quiesce.v1` acknowledgment (bound to operationId+generation,
bounded in-flight wait, honest `in_flight_timeout`); the parked timer slot
degrades into a slow ownership watch that re-arms consumption when the
marker returns to legacy_owned — rollback needs no Gateway restart.

@principles/host-runtime (minor) — `collectWorkspaceCredentialEnvNames`:
one collector for the credential env NAMES a workspace's runtime profiles
reference (Service Host allowlist since Phase 2; OpenClaw worker readiness
now) — names only, values never pass through.

@principles/pd-cli (minor) — `pd openclaw worker --once|--readiness
--json --workspace <dir>` (lazy plugin-subpath import; NO continuous mode
— the OS scheduler owns triggering); `pd service handover|rollback` §8.4
orchestration (openclaw binding verification → atomic begin_handover with
workspace registration → active-release readiness probe → gateway
quiesce-ack wait bound to operationId+generation → single CAS flip →
first real worker cycle → write-once operationId-keyed evidence; verify-
only crash continuation; `--abort`/`--resume`); managed dispatch host set
adds openclaw (`MANAGED_WORKER_HOST_KINDS`) while Phase 2 shadow stays
codex|workbuddy (`--shadow --host openclaw` still refused); managed
status record `hostKind` widens additively (still `pd.service-run-status.v1`).

create-principles-disciple (minor) — install.json writers join the
ownership CAS lock discipline (ERR-168): the installer's
`writeInstallManifest` and the update side's `writeInstallConfig` /
`mergeIntoInstallJson` run their read-modify-save under the same physical
lock as the §8.4 transition primitive, failing loud instead of silently
clobbering `backgroundExecutions` records. Against an older registry-
resolved @principles/install-layout (the pre-cohort release window) the
lock export is feature-detected and the pre-PR unlocked write behavior is
kept for that window only.

Adaptive timer decision: V1 fixed 120s OS period (no persisted Gateway
counters, no timer service) — quantified comparison and disclosed
semantic changes in
`docs/reports/PD_SERVICE_HOST_PHASE4_SCHEDULING_COMPARISON.md` (normal and
sparse loads comparable; burst drain ~2x slower, bounded; zero lost
tasks; failure-backoff ladder semantics disclosed). manifest
`workspaceBindings` is NOT implemented — host-binding authority stays
with the existing dual sources (manifest + validated claims); handover
registers the workspace through the existing atomic merge path.
