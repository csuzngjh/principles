---
"@principles/pd-cli": minor
"@principles/codex-adapter": minor
"@principles/workbuddy-adapter": minor
---

PD Service Host Phase 2 (PRI-1280, SPEC-PD-SERVICE-HOST-001 §11 Phase 2 +
Gate 0 准入边界 / ADR-0020 §11.6): `pd service run-once --shadow --workspace
<dir> [--host codex|workbuddy] [--timeout-ms <n>] [--json]` — an explicit,
manual, bounded REAL Worker Cycle per explicitly-selected legacy-owned
workspace, default-off and never scheduled. The unified Worker Adapter
contract (TD §2.3: `pd.worker-adapter.v1` — hostKind / adapterVersion /
supports(binding evidence only: validated claim or host-tool declaration,
never feature flags / cwd / env) / executeOnce / cycleOutcome / reason /
nextAction / lastProgressAt / health) wraps the EXISTING
`pd codex|workbuddy worker --once --json --workspace` entries of the
active-release install as bounded subprocesses (SIGTERM→grace→SIGKILL
ladder, per-workspace isolation, AbortSignal cancellation; task recovery
stays with the existing Lease TTL / Recovery Sweep). Worker child env is
BUILT from an allowlist (TD §5.2): identity/host-root pointers
(PD_EXPERIMENT_ROOT, PD_WORKSPACE_DIR, OPENCLAW_*, PD_COMPANION_WORKER_IPC,
HOME/USERPROFILE, CODEX_HOME/WORKBUDDY_CONFIG_DIR) are dropped or pinned
from the trusted install identity, `PD_INVOCATION_SOURCE=service_host` is
set, credentials ride the existing getEnvVar chain via a name-pattern
allowlist (values never logged). `lastProgressAt` reflects real persisted
progress only (task status transitions diffed read-only pre/post cycle;
empty cycles keep the previous value — never a completion timestamp);
unreadable evidence degrades (rc-9). Status stays
`pd.service-run-status.v1`, extended additively with a `shadow` section
(per-workspace admission + execution records; `dryRun:false`). Shadow
refuses non-legacy `backgroundExecutions` owners, never modifies the owner
marker, registers no OS scheduler, and keeps Companion supervision /
OpenClaw AutoConsumer untouched. Phase 1 `--dry-run` is unchanged; the two
modes are mutually exclusive (default-off refused without either).

codex-adapter (minor): `lastCycleDriver` gains the `service_host` identity
(three-way companion/service_host/manual, TD §5.2) so `pd codex worker
--status` stall attribution names the shadow driver instead of misreporting
`manual`.

workbuddy-adapter (minor): NEW cycle-level liveness record
(`.state/workbuddy-worker-liveness.json`, same shape and atomic-write
discipline as Codex): cycle start/stage deadlines/completion/duration/mode/
degradation reason plus the same three-way `lastCycleDriver` — FR-10 health
was previously undecidable for WorkBuddy. Known parity gap recorded (NOT
fixed here): the local pending-first candidate pick can starve retry_wait
under sustained pressure; Codex/WorkBuddy parity stays partial until the
core fair-share selector is adopted (follow-up on PRI-1280).

Package extraction decision (task §11): the Service Host stays INSIDE
pd-cli (`src/services/service-host/`) — extraction into a separate
workspace package would re-enter the ERR-196 release-asset risk class
(bundle staging, staged manifest rewrite, REQUIRED_COMPONENTS, packaged
smoke, release-locks regeneration) that cannot be fully exercised outside
the release pipeline, and Phase 2 adds no consumer that needs the split.

Review round (2026-11-21, 13 findings, all verified real and fixed):
shadow host roots resolve from the trusted home ONLY
(`canonicalHostRootsOnly` — forged OPENCLAW_*/CODEX_HOME/
WORKBUDDY_CONFIG_DIR overrides can no longer steer discovery nor the
child env pins; ignored inputs recorded rc-9); host-tool declarations
are VALIDATED via the existing `loadHostToolDeclarations` authority
before they count as binding evidence; worker stderr/reason strings are
sanitized (path redaction → `<path>`, control chars stripped) before
persistence; credential NAMES from the workspace's effective `apiKeyEnv`
join the child env allowlist so custom-named env credentials keep
working; Codex catch-up progress counts only ACTUAL persisted rows
(`inserted>0`, not re-checked sessions) and downstream evidence requires
`runStatus==='succeeded'`; a cross-run progress projection
(`service/shadow-progress.json`) keeps `lastProgressAt` across A→B→A and
dry-run interleaving; degraded cycles with confirmed task-state changes
now record the evidenced progress timestamp; `--timeout-ms` is validated
as a full integer BEFORE any real cycle (no more `5m`→1s clamps or
`five`→silent default); both workers settle the liveness record on early
returns (no stale mid-stage `runningStage` after a pause/degradation);
the coordinator passes its invocation id to the Worker
(`PD_INVOCATION_ID`, TD §5.2) and both workers record it in liveness for
correlation; the concurrency acceptance proves executability first and
asserts at-most-once claims exactly.
