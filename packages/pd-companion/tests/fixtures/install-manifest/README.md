# install-manifest fixtures

## production-copy-20261016.json

READ-ONLY regression sample: a byte-faithful copy of the production
`~/.pd/install.json` as it existed on 2026-10-16, when PD Companion 0.1.2
(bundling `@principles/install-layout` 0.1.0) rejected it as
`install_manifest_malformed` because `hosts` contained the then-new
`workbuddy` entry. That rejection cascaded into
`console_runtime_not_installed` on a healthy canonical install and mass
`removed_from_manifest` worker stops.

Never modify this file to make a test pass — it is the shape real installs
have. If the manifest CONTRACT changes, add a NEW fixture describing the new
shape and keep this one green (or, for a true layoutVersion bump, move this
file's assertions into an explicitly versioned suite).
