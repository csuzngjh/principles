---
"@principles/codex-adapter": patch
"@principles/host-runtime": patch
---

Advance the Marketplace runtime pin to the already-published npm versions that carry the Phase 1 intervention-evidence face: codex-adapter 0.5.1 (codex-evidence-recorder), host-runtime 0.8.1 (intervention-evidence-ingress), core 1.291.1. Verified by `npm run check:runtime-pin` (packaged capability probe S1–S5 PASS against npm-installed bytes) plus tarball content inspection of all three evidence modules. The previous pin (0.4.7 / 0.7.11 / 1.287.6) predates the Phase 1 evidence recorder, so officially installed Codex hosts had no intervention-evidence surface (acceptance 2026-10-10 §7.2 G-Codex-1).
