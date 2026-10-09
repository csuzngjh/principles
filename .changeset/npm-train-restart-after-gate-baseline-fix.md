---
'create-principles-disciple': patch
---

Re-drive the npm release train so the product 2.3.0 component cohort actually ships (PRI-874).

The Version Packages PR for this cohort merged and auto-dispatched its train, but every matrix leg failed inside the real-upgrade gate with `Cannot decrement patch of version 2.1.0`: the gate's local N-1 baseline helper could only step a patch number down, and ADR-0027 had just moved the plugin to a minor landing (`2.1.0`, patch tail 0). The gate fixture therefore rejected a legitimate release input, Publish and Finalize were skipped, and nothing reached the registry — `@principles/core`, `@principles/pd-cli`, `@principles/host-runtime`, `principles-disciple` and `@principles/codex-adapter` all stayed at their previous published versions even though their new versions are already committed on main.

The fixture itself is fixed on main by `previousReleaseVersion()` (test-only, no shipped code). That fix cannot be retrofitted onto the already-dispatched cohort, because the release matrix runs the gate test from the cohort's own tree by design (G5, SPEC §17.1) and the cohort resolver only accepts a Version Packages PR merge commit. This changeset is the release intent that materializes a new cohort carrying both the committed versions and the corrected gate, so the pending component releases publish.
