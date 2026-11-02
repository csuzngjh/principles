---
'create-principles-disciple': patch
---

G2 release payload trim (SPEC-PD-RELEASE-FOOTPRINT-001): the bundled console payload no longer ships `console/dist/ui` (the tsc image of the UI sources — the browser runs the prebuilt dist/web bundle and the server imports nothing from it; consumer audit 2026-11-02), and the `release-manager` runtime component now ships only the transitive module closure of its real consumers (console update seam, deployed bootstrap executor, install-time authority probe) instead of a full second copy of the installer CLI dist. npm tarball −2.3 MiB unpacked / −305 files; self-contained asset payload −3.2 MiB / −430 files. The keep-set is computed from the compiled dist imports (scripts/release-manager-payload.mjs, shared with a guard test) so new runtime imports are tracked automatically; the npm CLI package still ships its complete dist.
