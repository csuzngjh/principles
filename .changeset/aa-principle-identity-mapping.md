---
"principles-disciple": patch
"create-principles-disciple": patch
"@principles/host-runtime": patch
---

feat(openclaw-plugin,host-runtime): revision-resilient adaptive delivery mapping via current principle identity (PRI-1140)

The `adaptiveActivation` mapping may now name a `principleId` instead of a pinned `(artifactId, activationId)`. On a delivery-signal round the provider resolves it to the at-most-one currently authorized prompt activation (`resolveCurrentAuthorizedActivationByPrincipleId`, read-only), so an Owner prompt revision no longer silently kills the intervention until the plugin config is edited by hand. The principle path packs additively (`additiveOnly`): it never squeezes out content the native assembly already holds — such a placement keeps the native assembly and records `would_displace_native_assembly`. The pinned mapping and the controlled-admission path are unchanged; a config without `principleId` behaves byte-identically.
