---
"@principles/pd-cli": minor
"@principles/install-layout": patch
---

PD Service Host Phase 1 (PRI-1279, SPEC-PD-SERVICE-HOST-001 §11 Phase 1 /
ADR-0020 §11.6): new `pd service run-once --dry-run [--json]` coordinator with
the read-only Service Host pipeline — install identity (production-forced with
PD_EXPERIMENT_ROOT stripping, recorded), two-source workspace discovery over
the canonical install manifest and validated per-host claims
(`collectHostWorkspaceClaims` / `findForeignWorkspaceOwner` reused), realpath
identity dedupe, read-only `backgroundExecutions` owner projection, the
install-level single-instance run lock (wx-create + body-verified stale
takeover + ownership-checked release, immediate `already_running` semantics),
and the versioned operational status file under
`<pdHome>/service/run-once-status.json`. Phase 1 starts no Worker and changes
no consumer ownership; a run without `--dry-run` refuses
(`dry_run_required_phase1`).

Placement note (TD §2.1 deviation): the coordinator lives inside pd-cli
(`src/services/service-host/`) instead of a separate `@principles/service-host`
package — a new pd-cli workspace dependency would enter the self-contained
release asset (ERR-196 class) and require payload-component staging, staged
manifest rewrites and release-lock regeneration that cannot be fully exercised
outside the release pipeline. Extraction into a dedicated package remains a
Phase 2 (PRI-1280) decision with its own release-onboarding work.

install-layout (patch): re-export `resolveRealUserHome` — the shared home
precedence authority — so the coordinator reuses the single identity
resolution instead of re-deriving it; add the authoritative Active Release
record parser (`active-release.ts`: `ACTIVE_RELEASE_SCHEMA_VERSION`,
`ActiveReleaseRecord`, `ActiveReleaseVerdict`, `parseActiveReleaseRecord`,
`readActiveReleaseRecord`, `activeReleaseRecordPath`) — the single schema
owner now shared by the installer's transaction journal and the service-host
coordinator (P1 defect fix: strict validation replaces lenient any-object
parsing).
