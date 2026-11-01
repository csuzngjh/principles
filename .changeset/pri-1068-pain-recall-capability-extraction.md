---
'@principles/core': minor
'@principles/pd-cli': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

Extract the pain-recall service into @principles/core as the Pain Recall Read Model and add the od-a-v1 Capability Facade (PRI-1068, SPEC-PD-AGENT-CAPABILITY-API-001 v0.5, MCP Gate 3). The `recallPains()` service moves from `pd-cli/src/services/pain-recall.ts` to the dedicated `@principles/core/runtime-v2/pain-recall` subpath byte-identically (CLI golden equivalence proven against pre-migration outputs; the strict read-only WAL snapshot matrix migrates with it). The new `@principles/core/runtime-v2/pain-recall-capability` subpath exposes `recallPrinciplePainsCapability` — a protocol-independent `pd.capability.v1` envelope under the frozen od-a-v1 disclosure profile (construction-is-whitelist projection, per-call leaf-path self-check, fail-closed input validation, limit ∈ [1,10]) — as the sole future entry point for the Gate 4 MCP Adapter. The plugin and installer ship core bytes, so they release in the same cohort (PRI-1065 precedent). Gate 4 (MCP server, 32 KiB budget, 10 s deadline) is explicitly not included.
