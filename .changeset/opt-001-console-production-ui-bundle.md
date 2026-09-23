---
'create-principles-disciple': patch
---

OPT-001 (artifact-size audit P1): releases now ship the production console web bundle. The pd-console `build` script (used by every official path — installer bundling, release-metadata, publish action, reproducibility, CI smokes) runs the UI step as `build:ui:production` (esbuild minify, no inline sourcemap): app.js drops from 8.6 MiB to 1.1 MiB, shrinking the installer payload by ~7.6 MiB. The bundler script additionally fails loud if a dev-mode app.js (sourceMappingURL marker) ever reaches the payload again. Local dev and console e2e keep using `build:ui` (dev) unchanged.
