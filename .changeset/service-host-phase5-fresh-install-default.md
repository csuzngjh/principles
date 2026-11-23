---
"@principles/install-layout": minor
"@principles/pd-cli": minor
"create-principles-disciple": minor
---

Service Host Phase 5 — the PD-owned Service Host is the fresh-install default
background lifecycle owner.

- install-layout: new `provision_fresh_install` ownership transition
  (legacy_owned with NO record → service_host_owned in one CAS write,
  generation 1). It refuses without `freshInstall=true` and refuses any
  workspace that already carries an ownership record, so upgrades keep using
  the quiescing `begin_handover` sequence. Service-Host-only manifests
  (`hosts: []` + declared workspaces) are now valid; an empty manifest with
  neither stays structural damage.
- create-principles-disciple: `--host` has no default (no silent OpenClaw);
  `none` installs no host adapter. Fresh installs default to registering AND
  enabling the user-level OS scheduler, then provision the new workspace into
  Service Host ownership (active-release no-consume readiness → CAS → first
  real managed cycle → `<pdHome>/service/install-provisioning.json` evidence).
  `--yes` accepts the recommended default, `--json`/`--non-interactive`
  without consent reports `consent_required` instead of creating a trigger,
  `--no-service-host` opts out, and upgrades keep refresh-if-registered.
- pd-cli: `pd service run-once --trigger installer` records the fresh-install
  first cycle; `pd service status` exposes `hostBindingState`
  (`bound` / `waiting_for_host_binding`) so a Service-Host-only workspace is
  truthful instead of implying a worker that does not exist.
